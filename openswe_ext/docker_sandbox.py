"""A local Docker implementation of Deep Agents' SandboxBackendProtocol.

The provider deliberately owns only execution isolation. ForgeFlow policy does
not create containers, mount workspaces, or manage container lifecycle.
"""

from __future__ import annotations

import asyncio
import os
import shlex
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import PurePosixPath

from deepagents.backends.protocol import ExecuteResponse, FileDownloadResponse, FileUploadResponse
from deepagents.backends.sandbox import BaseSandbox

_LABEL = "dev.open-swe.sandbox"
_DEFAULT_IMAGE = "forgeflow/openswe-sandbox:bookworm-node24"
_DEFAULT_NETWORK = "openswe-sandbox"
_DEFAULT_TIMEOUT = 120
_DEFAULT_MAX_OUTPUT = 100_000


class DockerSandboxError(RuntimeError):
    """The local Docker sandbox could not be created or reached safely."""


@dataclass(frozen=True, slots=True)
class DockerSandboxConfig:
    image: str = _DEFAULT_IMAGE
    network: str = _DEFAULT_NETWORK
    cpus: str = "2"
    memory: str = "8g"
    pids_limit: str = "1024"
    tmpfs_size: str = "1g"

    @classmethod
    def from_env(cls) -> DockerSandboxConfig:
        return cls(
            image=os.getenv("OPEN_SWE_DOCKER_IMAGE", _DEFAULT_IMAGE),
            network=os.getenv("OPEN_SWE_DOCKER_NETWORK", _DEFAULT_NETWORK),
            cpus=os.getenv("OPEN_SWE_DOCKER_CPUS", "2"),
            memory=os.getenv("OPEN_SWE_DOCKER_MEMORY", "8g"),
            pids_limit=os.getenv("OPEN_SWE_DOCKER_PIDS_LIMIT", "1024"),
            tmpfs_size=os.getenv("OPEN_SWE_DOCKER_TMPFS_SIZE", "1g"),
        )


def _docker(
    *args: str,
    input_bytes: bytes | None = None,
    timeout: int = 30,
    check: bool = True,
) -> subprocess.CompletedProcess[bytes]:
    try:
        result = subprocess.run(
            ["docker", *args],
            input=input_bytes,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise DockerSandboxError(f"docker command timed out after {timeout}s") from exc
    except OSError as exc:
        raise DockerSandboxError(f"docker command failed to start: {type(exc).__name__}") from exc
    if check and result.returncode != 0:
        stderr = result.stderr.decode("utf-8", errors="replace").strip()
        raise DockerSandboxError(f"docker command failed ({result.returncode}): {stderr[:500]}")
    return result


def _container_exists(container_id: str) -> bool:
    return _docker("container", "inspect", container_id, check=False).returncode == 0


def _container_running(container_id: str) -> bool:
    result = _docker(
        "container",
        "inspect",
        "--format",
        "{{.State.Running}}",
        container_id,
        check=False,
    )
    return result.returncode == 0 and result.stdout.strip() == b"true"


def _assert_owned_container(container_id: str) -> None:
    result = _docker(
        "container",
        "inspect",
        "--format",
        f"{{{{index .Config.Labels \"{_LABEL}\"}}}}",
        container_id,
        check=False,
    )
    if result.returncode != 0:
        raise DockerSandboxError(f"sandbox container does not exist: {container_id}")
    if result.stdout.strip() != b"true":
        raise DockerSandboxError(f"refusing non-Open-SWE container: {container_id}")


def _normalize_path(path: str) -> str:
    if not path or "\x00" in path:
        raise ValueError("invalid sandbox path")
    raw = PurePosixPath(path)
    if ".." in raw.parts:
        raise ValueError("parent traversal is not allowed in sandbox transfer paths")
    if raw.is_absolute():
        return str(raw)
    return str(PurePosixPath("/workspace") / raw)


class DockerSandbox(BaseSandbox):
    """Persistent Docker container implementing the Deep Agents sandbox contract."""

    enable_capture_offload = True

    def __init__(
        self,
        container_id: str,
        *,
        default_timeout: int = _DEFAULT_TIMEOUT,
        max_output_bytes: int = _DEFAULT_MAX_OUTPUT,
    ) -> None:
        self._container_id = container_id
        self._default_timeout = default_timeout
        self._max_output_bytes = max_output_bytes
        self._github_token_path = "/tmp/openswe-github-token"

    @property
    def id(self) -> str:
        return self._container_id

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        if not isinstance(command, str) or not command.strip():
            return ExecuteResponse("Error: Command must be a non-empty string.", 1, False)
        effective_timeout = self._default_timeout if timeout is None else timeout
        if effective_timeout <= 0:
            raise ValueError("timeout must be positive")
        _assert_owned_container(self._container_id)
        if not _container_running(self._container_id):
            _docker("container", "start", self._container_id)

        # GNU timeout creates a separate process group unless --foreground is used,
        # so descendants receive the timeout signal as well instead of leaking into
        # the persistent container after an agent command times out.
        wrapped_command = (
            f'if [ -r {shlex.quote(self._github_token_path)} ]; then '
            f'export GH_TOKEN="$(cat {shlex.quote(self._github_token_path)})"; '
            'export GITHUB_TOKEN="$GH_TOKEN"; fi; '
            + command
        )
        result = _docker(
            "exec",
            "--workdir",
            "/workspace",
            self._container_id,
            "timeout",
            "--signal=TERM",
            "--kill-after=5s",
            f"{effective_timeout}s",
            "bash",
            "-lc",
            wrapped_command,
            timeout=effective_timeout + 10,
            check=False,
        )
        stdout = result.stdout.decode("utf-8", errors="replace")
        stderr = result.stderr.decode("utf-8", errors="replace")
        parts: list[str] = []
        if stdout:
            parts.append(stdout)
        if stderr:
            parts.extend(f"[stderr] {line}" for line in stderr.rstrip().splitlines())
        output = "\n".join(parts) if parts else "<no output>"
        truncated = len(output.encode("utf-8")) > self._max_output_bytes
        if truncated:
            output = output.encode("utf-8")[: self._max_output_bytes].decode(
                "utf-8", errors="ignore"
            )
            output += f"\n\n... Output truncated at {self._max_output_bytes} bytes."
        if result.returncode != 0:
            output = f"{output.rstrip()}\n\nExit code: {result.returncode}"
        return ExecuteResponse(output=output, exit_code=result.returncode, truncated=truncated)

    def configure_github_token(self, token: str) -> None:
        """Store one short-lived repo-scoped token only in container tmpfs."""
        if not token.strip():
            return
        _assert_owned_container(self._container_id)
        if not _container_running(self._container_id):
            _docker("container", "start", self._container_id)
        result = _docker(
            "exec",
            "-i",
            self._container_id,
            "bash",
            "-lc",
            f"umask 077; cat > {shlex.quote(self._github_token_path)}",
            input_bytes=token.encode(),
            timeout=15,
            check=False,
        )
        if result.returncode != 0:
            raise DockerSandboxError("failed to install ephemeral GitHub read token")

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        responses: list[FileUploadResponse] = []
        for raw_path, content in files:
            try:
                path = _normalize_path(raw_path)
                parent = str(PurePosixPath(path).parent)
                command = f"mkdir -p -- {shlex.quote(parent)} && cat > {shlex.quote(path)}"
                result = _docker(
                    "exec",
                    "-i",
                    "--workdir",
                    "/workspace",
                    self._container_id,
                    "bash",
                    "-lc",
                    command,
                    input_bytes=content,
                    timeout=30,
                    check=False,
                )
                error = None if result.returncode == 0 else "permission_denied"
                responses.append(FileUploadResponse(path=raw_path, error=error))
            except (DockerSandboxError, ValueError) as exc:
                responses.append(FileUploadResponse(path=raw_path, error=type(exc).__name__))
        return responses

    def download_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        responses: list[FileDownloadResponse] = []
        for raw_path in paths:
            try:
                path = _normalize_path(raw_path)
                result = _docker(
                    "exec",
                    self._container_id,
                    "bash",
                    "-lc",
                    f"if [ -f {shlex.quote(path)} ]; then cat -- {shlex.quote(path)}; "
                    f"elif [ -d {shlex.quote(path)} ]; then exit 20; else exit 21; fi",
                    timeout=30,
                    check=False,
                )
                if result.returncode == 0:
                    responses.append(FileDownloadResponse(path=raw_path, content=result.stdout))
                elif result.returncode == 20:
                    responses.append(FileDownloadResponse(path=raw_path, error="is_directory"))
                elif result.returncode == 21:
                    responses.append(FileDownloadResponse(path=raw_path, error="file_not_found"))
                else:
                    responses.append(FileDownloadResponse(path=raw_path, error="permission_denied"))
            except (DockerSandboxError, ValueError) as exc:
                responses.append(FileDownloadResponse(path=raw_path, error=type(exc).__name__))
        return responses


def _prepare_workspace_volume(volume_name: str, image: str) -> None:
    _docker("volume", "create", "--label", f"{_LABEL}=true", volume_name)
    # This helper runs only provider-controlled chown before any untrusted code.
    _docker(
        "run",
        "--rm",
        "--network",
        "none",
        "--mount",
        f"type=volume,src={volume_name},dst=/workspace",
        "--user",
        "0:0",
        image,
        "chown",
        "1000:1000",
        "/workspace",
        timeout=30,
    )


def create_docker_sandbox_sync(sandbox_id: str | None = None) -> DockerSandbox:
    """Create or reconnect to one persistent local Docker sandbox."""
    config = DockerSandboxConfig.from_env()
    if sandbox_id:
        _assert_owned_container(sandbox_id)
        if not _container_running(sandbox_id):
            _docker("container", "start", sandbox_id)
        return DockerSandbox(sandbox_id)

    container_id = f"openswe-sbx-{uuid.uuid4().hex[:12]}"
    volume_name = f"{container_id}-workspace"
    _prepare_workspace_volume(volume_name, config.image)
    try:
        _docker(
            "container",
            "create",
            "--name",
            container_id,
            "--label",
            f"{_LABEL}=true",
            "--label",
            f"dev.open-swe.workspace-volume={volume_name}",
            "--init",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges:true",
            "--security-opt=apparmor=docker-default",
            "--pids-limit",
            config.pids_limit,
            "--memory",
            config.memory,
            "--cpus",
            config.cpus,
            "--network",
            config.network,
            "--tmpfs",
            f"/tmp:rw,nosuid,nodev,size={config.tmpfs_size}",
            "--tmpfs",
            "/home/sandbox:rw,nosuid,nodev,mode=1777,size=256m",
            "--mount",
            f"type=volume,src={volume_name},dst=/workspace",
            "--workdir",
            "/workspace",
            "--user",
            "1000:1000",
            "--env",
            "HOME=/home/sandbox",
            "--env",
            "XDG_CACHE_HOME=/tmp/.cache",
            config.image,
            "sleep",
            "infinity",
            timeout=30,
        )
        _docker("container", "start", container_id)
    except Exception:
        _docker("container", "rm", "-f", container_id, check=False)
        _docker("volume", "rm", "-f", volume_name, check=False)
        raise
    return DockerSandbox(container_id)


def _github_permissions_for_run(cfg: object) -> dict[str, str]:
    """Return the least GitHub permissions needed by this sandbox role.

    Only ForgeFlow implementation/repair agent runs receive repository write
    access for git push. Reviewer and every other graph stay read-only.
    Workflow write is intentionally never delegated into the sandbox.
    """
    source = getattr(cfg, "source", None)
    reviewer_thread_id = getattr(cfg, "reviewer_thread_id", None)
    if source == "forgeflow" and not reviewer_thread_id:
        return {"contents": "write", "pull_requests": "read"}
    return {"contents": "read", "pull_requests": "read"}


async def _github_token_from_run_context() -> str | None:
    """Mint a repo-scoped role-minimal token for the current Open SWE run."""
    from agent.github.app import get_github_app_installation_token_with_expiry
    from agent.run_config import RunConfig
    from langgraph.config import get_config

    try:
        raw_config = get_config()
    except RuntimeError:
        return None
    try:
        cfg = RunConfig.from_config(raw_config)
    except (AttributeError, TypeError, ValueError):
        return None
    if cfg.repo is None or not cfg.repo.name:
        return None
    token, _expires_at = await get_github_app_installation_token_with_expiry(
        repositories=[cfg.repo.name],
        permissions=_github_permissions_for_run(cfg),
        log_errors=False,
    )
    return token


async def create_docker_sandbox(sandbox_id: str | None = None) -> DockerSandbox:
    """Open SWE factory: create/reconnect and inject only ephemeral role-minimal credentials."""
    token = await _github_token_from_run_context()
    backend = await asyncio.to_thread(create_docker_sandbox_sync, sandbox_id)
    if token:
        await asyncio.to_thread(backend.configure_github_token, token)
    return backend


def delete_docker_sandbox(container_id: str) -> None:
    """Delete one provider-owned container and its provider-owned workspace volume."""
    _assert_owned_container(container_id)
    result = _docker(
        "container",
        "inspect",
        "--format",
        '{{index .Config.Labels "dev.open-swe.workspace-volume"}}',
        container_id,
    )
    volume_name = result.stdout.decode().strip()
    _docker("container", "rm", "-f", container_id)
    if volume_name:
        _docker("volume", "rm", "-f", volume_name, check=False)
