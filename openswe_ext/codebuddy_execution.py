"""Guarded CodeBuddy implementation route using its native ACP server."""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path

from forgeflow.external_agents.execution import (
    ExternalAgentExecutionEvidence,
    ExternalAgentExecutionRequest,
    ExternalAgentRouteGate,
    ExternalAgentRouteRejected,
)
from openswe_ext.external_agent_docker import (
    CONTAINER_EXECUTABLE,
    CONTAINER_HOME,
    CONTAINER_WORKSPACE,
    DEFAULT_IMAGE,
)
from openswe_ext.external_agent_execution import AcpWorkspaceExecutionAdapter


def _enabled(value: str | None) -> bool:
    return (value or "").strip().casefold() in {"1", "true", "yes", "on"}


def _projects(value: str | None) -> frozenset[str]:
    return frozenset(item.strip() for item in (value or "").split(",") if item.strip())


def _read_secret(path: str | None) -> str | None:
    if not path:
        return None
    secret_path = Path(path).expanduser()
    if not secret_path.is_file():
        return None
    value = secret_path.read_text(encoding="utf-8").strip()
    return value or None


def _credential_environment(values: Mapping[str, str]) -> tuple[dict[str, str], str]:
    token = values.get("CODEBUDDY_AUTH_TOKEN", "").strip() or _read_secret(
        values.get(
            "FORGEFLOW_CODEBUDDY_AUTH_TOKEN_FILE",
            str(Path.home() / ".config/forgeflow-policy/codebuddy-auth.token"),
        )
    )
    if token:
        return {"CODEBUDDY_AUTH_TOKEN": token}, "CODEBUDDY_AUTH_TOKEN"

    api_key = values.get("CODEBUDDY_API_KEY", "").strip() or _read_secret(
        values.get(
            "FORGEFLOW_CODEBUDDY_API_KEY_FILE",
            str(Path.home() / ".config/forgeflow-policy/codebuddy-api.key"),
        )
    )
    if api_key:
        return {"CODEBUDDY_API_KEY": api_key}, "CODEBUDDY_API_KEY"
    raise ExternalAgentRouteRejected("CODEBUDDY_CREDENTIAL_REQUIRED")


def _docker_environment(values: Mapping[str, str], credential: Mapping[str, str]) -> dict[str, str]:
    env = {
        "HOME": values.get("HOME", str(Path.home())),
        "PATH": values.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "LANG": values.get("LANG", "C.UTF-8"),
        "LC_ALL": values.get("LC_ALL", "C.UTF-8"),
        **credential,
    }
    docker_host = values.get("DOCKER_HOST", "").strip()
    if docker_host:
        env["DOCKER_HOST"] = docker_host
    return env


def build_codebuddy_docker_args(
    *,
    workspace: Path,
    executable: Path,
    model: str,
    credential_name: str,
    image: str = DEFAULT_IMAGE,
    internet_environment: str = "internal",
    uid: int | None = None,
    gid: int | None = None,
) -> tuple[str, ...]:
    """Return one-shot Docker arguments for a native CodeBuddy ACP process."""

    resolved_workspace = workspace.expanduser().resolve(strict=True)
    resolved_executable = executable.expanduser().resolve(strict=True)
    if not resolved_workspace.is_dir():
        raise ExternalAgentRouteRejected("CODEBUDDY_WORKSPACE_NOT_DIRECTORY")
    if not resolved_executable.is_file() or not os.access(resolved_executable, os.X_OK):
        raise ExternalAgentRouteRejected("CODEBUDDY_BINARY_NOT_EXECUTABLE")
    if not model.strip():
        raise ExternalAgentRouteRejected("CODEBUDDY_MODEL_REQUIRED")
    if credential_name not in {"CODEBUDDY_AUTH_TOKEN", "CODEBUDDY_API_KEY"}:
        raise ExternalAgentRouteRejected("CODEBUDDY_CREDENTIAL_KIND_INVALID")

    run_uid = os.getuid() if uid is None else uid
    run_gid = os.getgid() if gid is None else gid
    return (
        "run",
        "--rm",
        "-i",
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
        "2g",
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
        "--env",
        credential_name,
        "--tmpfs",
        f"{CONTAINER_HOME}:rw,nosuid,nodev,mode=0700,uid={run_uid},gid={run_gid}",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,mode=1777",
        "--mount",
        f"type=bind,src={resolved_workspace},dst={CONTAINER_WORKSPACE}",
        "--mount",
        f"type=bind,src={resolved_executable},dst={CONTAINER_EXECUTABLE},readonly",
        "--workdir",
        CONTAINER_WORKSPACE,
        "--network",
        "bridge",
        image,
        CONTAINER_EXECUTABLE,
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

        self._model = values.get("FORGEFLOW_CODEBUDDY_MODEL", "deepseek-v4-flash").strip()
        if not self._model:
            raise ExternalAgentRouteRejected("CODEBUDDY_MODEL_REQUIRED")
        self._image = values.get(
            "FORGEFLOW_EXTERNAL_AGENT_DOCKER_IMAGE",
            "forgeflow/openswe-sandbox:bookworm-node24",
        ).strip()
        self._internet_environment = values.get(
            "FORGEFLOW_CODEBUDDY_INTERNET_ENVIRONMENT", "internal"
        ).strip()
        credential, self._credential_name = _credential_environment(values)
        self._agent_env = _docker_environment(values, credential)

    async def execute(
        self, request: ExternalAgentExecutionRequest
    ) -> ExternalAgentExecutionEvidence:
        workspace = self._gate.validate(request)
        docker_args = build_codebuddy_docker_args(
            workspace=workspace,
            executable=self._binary,
            model=self._model,
            credential_name=self._credential_name,
            image=self._image,
            internet_environment=self._internet_environment,
        )
        return await AcpWorkspaceExecutionAdapter(
            gate=self._gate,
            agent_command="docker",
            agent_args=docker_args,
            runtime_label="codebuddy",
            agent_env=self._agent_env,
            session_cwd=CONTAINER_WORKSPACE,
        ).execute(request)


__all__ = ["CodeBuddyExternalAgentExecution", "build_codebuddy_docker_args"]
