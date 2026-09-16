"""Guarded CodeBuddy implementation route using native ACP and sealed official auth."""

from __future__ import annotations

import asyncio
import fcntl
import os
import re
import subprocess
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import TextIO

from forgeflow.external_agents.acp import AcpExecutionResult
from forgeflow.external_agents.execution import (
    ExternalAgentExecutionEvidence,
    ExternalAgentExecutionRequest,
    ExternalAgentRouteGate,
    ExternalAgentRouteRejected,
)
from openswe_ext.codebuddy_auth import (
    OFFICIAL_AUTH_FILE,
    CodeBuddyAuthError,
    resolve_codebuddy_auth_dir,
)
from openswe_ext.codebuddy_failures import classify_codebuddy_response
from openswe_ext.external_agent_docker import (
    BOOTSTRAP_MOUNT,
    CONTAINER_EXECUTABLE,
    CONTAINER_HOME,
    CONTAINER_WORKSPACE,
    DEFAULT_IMAGE,
    build_bootstrap_unmount_args,
)
from openswe_ext.external_agent_execution import AcpWorkspaceExecutionAdapter

_CONTAINER_AUTH_DIR = f"{CONTAINER_HOME}/.local/share/CodeBuddyExtension/Data/Public/auth"
_CONTAINER_AUTH_FILE = f"{_CONTAINER_AUTH_DIR}/{OFFICIAL_AUTH_FILE}"
_DEFAULT_MEMORY_LIMIT = "2g"
_DEFAULT_MAX_CONCURRENCY = 1
_MEMORY_LIMIT_RE = re.compile(r"^[1-9][0-9]*[bkmg]?$", re.IGNORECASE)


def _codebuddy_stop_failure_code(result: AcpExecutionResult) -> str | None:
    if result.stop_reason != "refusal":
        return None
    candidates = [result.text]
    error_message = result.metadata.get("codebuddy.ai/errorMessage")
    if isinstance(error_message, str):
        candidates.append(error_message)
    for candidate in candidates:
        failure = classify_codebuddy_response(candidate)
        if failure is not None:
            return failure
    return None


def _container_state(container_name: str) -> tuple[bool, int | None]:
    completed = subprocess.run(
        [
            "docker",
            "inspect",
            container_name,
            "--format",
            "{{.State.Running}} {{.State.Pid}}",
        ],
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
        env={**os.environ, "LC_ALL": "C.UTF-8"},
    )
    if completed.returncode != 0:
        return False, None
    parts = completed.stdout.strip().split()
    if len(parts) != 2:
        return False, None
    running = parts[0].casefold() == "true"
    pid = int(parts[1]) if parts[1].isdigit() and int(parts[1]) > 0 else None
    return running, pid


@dataclass(slots=True)
class _CodeBuddyCapacityLease:
    handle: TextIO

    def release(self) -> None:
        fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
        self.handle.close()


def _max_concurrency(value: str | None) -> int:
    raw = (value or str(_DEFAULT_MAX_CONCURRENCY)).strip()
    if not raw.isdigit() or not 1 <= int(raw) <= 8:
        raise ExternalAgentRouteRejected("CODEBUDDY_MAX_CONCURRENCY_INVALID")
    return int(raw)


def _acquire_codebuddy_capacity(*, state_dir: Path, max_concurrency: int) -> _CodeBuddyCapacityLease:
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    state_dir.chmod(0o700)
    for slot in range(max_concurrency):
        path = state_dir / f"codebuddy-account-{slot}.lock"
        handle = path.open("a+", encoding="utf-8")
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            handle.close()
            continue
        return _CodeBuddyCapacityLease(handle)
    raise ExternalAgentRouteRejected("CODEBUDDY_CAPACITY_BUSY")


def _enabled(value: str | None) -> bool:
    return (value or "").strip().casefold() in {"1", "true", "yes", "on"}


def _projects(value: str | None) -> frozenset[str]:
    return frozenset(item.strip() for item in (value or "").split(",") if item.strip())


def _memory_limit(value: str | None) -> str:
    limit = (value or _DEFAULT_MEMORY_LIMIT).strip()
    if not _MEMORY_LIMIT_RE.fullmatch(limit):
        raise ExternalAgentRouteRejected("CODEBUDDY_MEMORY_LIMIT_INVALID")
    return limit


def _docker_environment(values: Mapping[str, str]) -> dict[str, str]:
    env = {
        "HOME": values.get("HOME", str(Path.home())),
        "PATH": values.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "LANG": values.get("LANG", "C.UTF-8"),
        "LC_ALL": values.get("LC_ALL", "C.UTF-8"),
    }
    docker_host = values.get("DOCKER_HOST", "").strip()
    if docker_host:
        env["DOCKER_HOST"] = docker_host
    return env


def build_codebuddy_docker_args(
    *,
    workspace: Path,
    executable: Path,
    auth_state_dir: Path,
    container_name: str,
    model: str,
    memory_limit: str = _DEFAULT_MEMORY_LIMIT,
    image: str = DEFAULT_IMAGE,
    internet_environment: str = "internal",
    uid: int | None = None,
    gid: int | None = None,
) -> tuple[str, ...]:
    """Return one-shot Docker arguments for a native CodeBuddy ACP process.

    The official browser-login state is mounted only at the bootstrap path. A
    temporary copy is created under the isolated HOME so CodeBuddy can load it
    during ACP initialization. ``_seal_codebuddy_bootstrap`` removes that copy
    and detaches the bootstrap mount before ForgeFlow sends the project prompt.
    """

    resolved_workspace = workspace.expanduser().resolve(strict=True)
    resolved_executable = executable.expanduser().resolve(strict=True)
    resolved_auth = auth_state_dir.expanduser().resolve(strict=True)
    if not resolved_workspace.is_dir():
        raise ExternalAgentRouteRejected("CODEBUDDY_WORKSPACE_NOT_DIRECTORY")
    if not resolved_executable.is_file() or not os.access(resolved_executable, os.X_OK):
        raise ExternalAgentRouteRejected("CODEBUDDY_BINARY_NOT_EXECUTABLE")
    if not resolved_auth.is_dir() or not (resolved_auth / OFFICIAL_AUTH_FILE).is_file():
        raise ExternalAgentRouteRejected("CODEBUDDY_OFFICIAL_AUTH_REQUIRED")
    if not container_name.strip():
        raise ExternalAgentRouteRejected("CODEBUDDY_CONTAINER_NAME_REQUIRED")
    if not model.strip():
        raise ExternalAgentRouteRejected("CODEBUDDY_MODEL_REQUIRED")
    validated_memory_limit = _memory_limit(memory_limit)

    run_uid = os.getuid() if uid is None else uid
    run_gid = os.getgid() if gid is None else gid
    bootstrap = (
        f'set -eu; d="{_CONTAINER_AUTH_DIR}"; mkdir -p "$d"; '
        f'cp "{BOOTSTRAP_MOUNT}/{OFFICIAL_AUTH_FILE}" "{_CONTAINER_AUTH_FILE}"; '
        f'chmod 600 "{_CONTAINER_AUTH_FILE}"; exec {CONTAINER_EXECUTABLE} "$@"'
    )
    return (
        "run",
        "--rm",
        "-i",
        "--name",
        container_name.strip(),
        "--label",
        "forgeflow.external-agent=true",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--pids-limit",
        "256",
        "--memory",
        validated_memory_limit,
        "--cpus",
        "2",
        "--user",
        f"{run_uid}:{run_gid}",
        "--env",
        f"HOME={CONTAINER_HOME}",
        "--env",
        "LANG=C.UTF-8",
        "--env",
        "LC_ALL=C.UTF-8",
        "--env",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "--env",
        "CODEBUDDY_IS_SANDBOX=1",
        "--env",
        "CODEBUDDY_DISABLE_AUTO_MEMORY=1",
        "--env",
        f"CODEBUDDY_INTERNET_ENVIRONMENT={internet_environment}",
        "--tmpfs",
        f"{CONTAINER_HOME}:rw,nosuid,nodev,mode=0700,uid={run_uid},gid={run_gid}",
        # CodeBuddy's native Bun build extracts shared objects to /tmp. The
        # mount stays nosuid/nodev but must permit executable mappings.
        "--tmpfs",
        "/tmp:rw,exec,nosuid,nodev,mode=1777",
        "--mount",
        f"type=bind,src={resolved_workspace},dst={CONTAINER_WORKSPACE}",
        "--mount",
        f"type=bind,src={resolved_executable},dst={CONTAINER_EXECUTABLE},readonly",
        "--mount",
        f"type=bind,src={resolved_auth},dst={BOOTSTRAP_MOUNT},readonly",
        "--workdir",
        CONTAINER_WORKSPACE,
        "--network",
        "bridge",
        image,
        "/bin/sh",
        "-c",
        bootstrap,
        "sh",
        "--acp",
        "--model",
        model.strip(),
        "--permission-mode",
        "bypassPermissions",
        "--subagent-permission-mode",
        "bypassPermissions",
        "--setting-sources",
        "user",
        "--no-session-persistence",
    )


def _run_checked(
    command: Sequence[str], *, container_name: str | None = None
) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        list(command),
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
        env={**os.environ, "LC_ALL": "C.UTF-8"},
    )
    if completed.returncode != 0:
        if container_name is not None:
            running, _ = _container_state(container_name)
            if not running:
                raise ExternalAgentRouteRejected("CODEBUDDY_PROCESS_EXITED")
        raise ExternalAgentRouteRejected("CODEBUDDY_BOOTSTRAP_SEAL_FAILED")
    return completed


def _seal_codebuddy_bootstrap_sync(*, container_name: str, image: str) -> None:
    """Remove all filesystem-readable auth material before the project prompt."""

    running, pid = _container_state(container_name)
    if not running:
        raise ExternalAgentRouteRejected("CODEBUDDY_PROCESS_EXITED")
    if pid is None:
        raise ExternalAgentRouteRejected("CODEBUDDY_CONTAINER_PID_INVALID")
    _run_checked(
        ["docker", "exec", container_name, "rm", "-f", _CONTAINER_AUTH_FILE],
        container_name=container_name,
    )
    _run_checked(build_bootstrap_unmount_args(pid=pid, image=image))
    mountinfo = Path(f"/proc/{pid}/mountinfo").read_text(encoding="utf-8", errors="replace")
    if f" {BOOTSTRAP_MOUNT} " in mountinfo:
        raise ExternalAgentRouteRejected("CODEBUDDY_BOOTSTRAP_STILL_MOUNTED")
    _run_checked(
        ["docker", "exec", container_name, "test", "!", "-e", _CONTAINER_AUTH_FILE],
        container_name=container_name,
    )


async def _seal_codebuddy_bootstrap(*, container_name: str, image: str) -> None:
    await asyncio.to_thread(
        _seal_codebuddy_bootstrap_sync,
        container_name=container_name,
        image=image,
    )


class CodeBuddyExternalAgentExecution:
    """Execution-scoped CodeBuddy ACP route inside the ForgeFlow Docker boundary."""

    def __init__(
        self,
        *,
        env: Mapping[str, str] | None = None,
        allowed_projects: frozenset[str] | None = None,
    ) -> None:
        values = dict(os.environ if env is None else env)
        root = Path(
            values.get(
                "FORGEFLOW_EXTERNAL_AGENT_WORKSPACE_ROOT",
                str(Path.home() / ".local/share/forgeflow-policy/external-agent-workspaces"),
            )
        ).expanduser()
        self._gate = ExternalAgentRouteGate(
            enabled=_enabled(values.get("FORGEFLOW_CODEBUDDY_ACP_ENABLED")),
            allowed_projects=(
                allowed_projects
                if allowed_projects is not None
                else _projects(values.get("FORGEFLOW_CODEBUDDY_ACP_PROJECTS"))
            ),
            workspace_root=root,
        )
        outer = values.get("FORGEFLOW_EXTERNAL_AGENT_OUTER_SANDBOX", "docker").strip()
        if outer != "docker":
            raise ExternalAgentRouteRejected("CODEBUDDY_OUTER_SANDBOX_REQUIRED")

        raw_bin = values.get("FORGEFLOW_CODEBUDDY_BIN", str(Path.home() / ".local/bin/codebuddy"))
        try:
            self._binary = Path(raw_bin).expanduser().resolve(strict=True)
        except FileNotFoundError as exc:
            raise ExternalAgentRouteRejected("CODEBUDDY_BINARY_NOT_FOUND") from exc
        if not self._binary.is_file() or not os.access(self._binary, os.X_OK):
            raise ExternalAgentRouteRejected("CODEBUDDY_BINARY_NOT_EXECUTABLE")

        try:
            self._auth_state_dir = resolve_codebuddy_auth_dir(values)
        except CodeBuddyAuthError as exc:
            raise ExternalAgentRouteRejected(str(exc)) from exc
        self._model = values.get("FORGEFLOW_CODEBUDDY_MODEL", "deepseek-v4.1-flash").strip()
        if not self._model:
            raise ExternalAgentRouteRejected("CODEBUDDY_MODEL_REQUIRED")
        self._memory_limit = _memory_limit(values.get("FORGEFLOW_CODEBUDDY_MEMORY_LIMIT"))
        self._max_concurrency = _max_concurrency(values.get("FORGEFLOW_CODEBUDDY_MAX_CONCURRENCY"))
        self._capacity_state_dir = Path(
            values.get(
                "FORGEFLOW_POLICY_STATE_DIR",
                str(Path.home() / ".local/share/forgeflow-policy"),
            )
        ).expanduser()
        self._image = values.get(
            "FORGEFLOW_EXTERNAL_AGENT_DOCKER_IMAGE",
            "forgeflow/openswe-sandbox:bookworm-node24",
        ).strip()
        self._internet_environment = values.get(
            "FORGEFLOW_CODEBUDDY_INTERNET_ENVIRONMENT", "internal"
        ).strip()
        self._agent_env = _docker_environment(values)

    def _build_docker_execution(
        self, request: ExternalAgentExecutionRequest
    ) -> tuple[str, tuple[str, ...]]:
        """Resolve and validate execution paths, then build the Docker command.

        Workspace, binary, and official-auth paths are resolved with
        ``strict=True`` and the executable bit is probed. Those filesystem checks
        block, so callers must run this off the event loop.
        """

        workspace = self._gate.validate(request)
        container_name = f"forgeflow-codebuddy-{uuid.uuid4().hex[:16]}"
        docker_args = build_codebuddy_docker_args(
            workspace=workspace,
            executable=self._binary,
            auth_state_dir=self._auth_state_dir,
            container_name=container_name,
            model=self._model,
            memory_limit=self._memory_limit,
            image=self._image,
            internet_environment=self._internet_environment,
        )
        return container_name, docker_args

    async def execute(
        self, request: ExternalAgentExecutionRequest
    ) -> ExternalAgentExecutionEvidence:
        lease = await asyncio.to_thread(
            _acquire_codebuddy_capacity,
            state_dir=self._capacity_state_dir,
            max_concurrency=self._max_concurrency,
        )
        try:
            container_name, docker_args = await asyncio.to_thread(
                self._build_docker_execution, request
            )
            evidence = await AcpWorkspaceExecutionAdapter(
                gate=self._gate,
                agent_command="docker",
                agent_args=docker_args,
                runtime_label="codebuddy",
                agent_env=self._agent_env,
                session_cwd=CONTAINER_WORKSPACE,
                before_prompt=lambda: _seal_codebuddy_bootstrap(
                    container_name=container_name,
                    image=self._image,
                ),
                stop_failure_code=_codebuddy_stop_failure_code,
            ).execute(request)
            return evidence if evidence.model is not None else replace(evidence, model=self._model)
        finally:
            await asyncio.to_thread(lease.release)


__all__ = [
    "CodeBuddyExternalAgentExecution",
    "build_codebuddy_docker_args",
]
