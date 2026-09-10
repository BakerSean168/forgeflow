"""A local Docker implementation of Deep Agents' SandboxBackendProtocol.

The provider deliberately owns only execution isolation. ForgeFlow policy does
not create containers, mount workspaces, or manage container lifecycle.
"""

from __future__ import annotations

import asyncio
import fcntl
import json
import os
import shlex
import subprocess
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from deepagents.backends.protocol import ExecuteResponse, FileDownloadResponse, FileUploadResponse
from deepagents.backends.sandbox import BaseSandbox

_LABEL = "dev.open-swe.sandbox"
_DEFAULT_IMAGE = "forgeflow/openswe-sandbox:bookworm-node24"
_DEFAULT_NETWORK = "openswe-sandbox"
_DEFAULT_TIMEOUT = 120
_DEFAULT_MAX_OUTPUT = 100_000
_RUNTIME_ROOT = "/workspace/.open-swe-runtime"
_LAST_USED_PATH = f"{_RUNTIME_ROOT}/last-used"
_ARTIFACT_ROOT = "/workspace/.open-swe-artifacts"
_LARGE_TOOL_RESULTS_SUBPATH = ".open-swe-artifacts/large_tool_results"
_CONVERSATION_HISTORY_SUBPATH = ".open-swe-artifacts/conversation_history"


class DockerSandboxError(RuntimeError):
    """The local Docker sandbox could not be created or reached safely."""


def _lock_root() -> Path:
    runtime = os.environ.get("XDG_RUNTIME_DIR", "").strip()
    root = Path(runtime) if runtime else Path(f"/run/user/{os.getuid()}")
    return root / "open-swe-sandbox-locks"


@contextmanager
def sandbox_operation_lock(
    container_id: str, *, exclusive: bool, blocking: bool = True
) -> Iterator[bool]:
    """Coordinate provider operations and GC without serializing parallel tool calls."""
    root = _lock_root()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = root / f"{container_id}.lock"
    with path.open("a+") as handle:
        mode = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
        if not blocking:
            mode |= fcntl.LOCK_NB
        try:
            fcntl.flock(handle.fileno(), mode)
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


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

_CACHE_ROOT = "/workspace/.open-swe-cache"
_EXECUTABLE_TMPDIR = f"{_RUNTIME_ROOT}/tmp"
_XDG_RUNTIME_DIR = "/tmp/.runtime"


def _runtime_env_prelude() -> str:
    """Keep language/package caches on the persistent workspace volume.

    The sandbox HOME is intentionally a small tmpfs for isolation. Package
    managers can easily exceed it, so high-volume caches belong to the
    thread-scoped workspace volume instead.
    """
    dirs = {
        "XDG_DATA_HOME": f"{_CACHE_ROOT}/xdg-data",
        "XDG_CACHE_HOME": f"{_CACHE_ROOT}/xdg-cache",
        "COREPACK_HOME": f"{_CACHE_ROOT}/corepack",
        "npm_config_cache": f"{_CACHE_ROOT}/npm",
        "UV_CACHE_DIR": f"{_CACHE_ROOT}/uv",
        "GOCACHE": f"{_CACHE_ROOT}/go-build",
        "GOMODCACHE": f"{_CACHE_ROOT}/go-mod",
        "CARGO_HOME": f"{_CACHE_ROOT}/cargo",
        "PIP_CACHE_DIR": f"{_CACHE_ROOT}/pip",
        "TMPDIR": _EXECUTABLE_TMPDIR,
        "XDG_RUNTIME_DIR": _XDG_RUNTIME_DIR,
    }
    paths = " ".join(shlex.quote(value) for value in [*dirs.values(), _RUNTIME_ROOT])
    exports = " ".join(f"{name}={shlex.quote(value)}" for name, value in dirs.items())
    return (
        f"mkdir -p -- {paths} && touch {shlex.quote(_LAST_USED_PATH)} "
        f"&& export {exports}; "
    )


@dataclass(frozen=True, slots=True)
class GitHubSandboxCredentials:
    read_token: str
    write_token: str | None
    write_repository: str | None


def _git_credential_script(
    *,
    read_token_path: str,
    write_token_path: str,
    write_repository: str | None,
) -> str:
    """Return a token-free Git credential helper selecting least-privilege tokens."""
    read_path = shlex.quote(read_token_path)
    write_path = shlex.quote(write_token_path)
    lines = [
        "#!/bin/sh",
        '[ "$1" = "get" ] || exit 0',
        'host=""',
        'path=""',
        "while IFS='=' read -r key value; do",
        '  case "$key" in',
        '    host) host="$value" ;;',
        '    path) path="$value" ;;',
        '  esac',
        'done',
        '[ "$host" = "github.com" ] || exit 0',
        f"token_path={read_path}",
    ]
    if write_repository:
        repo = shlex.quote(write_repository)
        repo_git = shlex.quote(f"{write_repository}.git")
        lines.extend(
            [
                f'if [ -r {write_path} ] && {{ [ "$path" = {repo} ] || [ "$path" = {repo_git} ]; }}; then',
                f"  token_path={write_path}",
                "fi",
            ]
        )
    lines.extend(
        [
            "printf 'username=x-access-token\npassword='",
            'cat -- "$token_path"',
            "printf '\n'",
        ]
    )
    return "\n".join(lines) + "\n"


def _sandbox_read_repositories(cfg: object) -> tuple[str, ...]:
    """Resolve extra read-only repos from the existing Open SWE local project manifest."""
    repo = getattr(cfg, "repo", None)
    owner = getattr(repo, "owner", None)
    name = getattr(repo, "name", None)
    if not isinstance(owner, str) or not isinstance(name, str) or not owner or not name:
        return ()
    manifest_path = os.environ.get("OPEN_SWE_LOCAL_PROJECTS_FILE", "").strip()
    if not manifest_path:
        return ()
    try:
        payload = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DockerSandboxError("failed to read Open SWE local project manifest") from exc
    if not isinstance(payload, list):
        raise DockerSandboxError("Open SWE local project manifest must be a list")
    target = f"{owner}/{name}"
    for item in payload:
        if not isinstance(item, dict) or item.get("repo") != target:
            continue
        raw = item.get("sandbox_read_repositories", [])
        if not isinstance(raw, list) or not all(isinstance(value, str) for value in raw):
            raise DockerSandboxError("sandbox_read_repositories must be a list of OWNER/REPO strings")
        result: list[str] = []
        for slug in raw:
            dep_owner, sep, dep_name = slug.strip().partition("/")
            if not sep or not dep_owner or not dep_name or "/" in dep_name:
                raise DockerSandboxError(f"invalid sandbox dependency repository: {slug!r}")
            if dep_owner != owner:
                raise DockerSandboxError("sandbox dependency repositories must share the primary owner")
            if dep_name != name and dep_name not in result:
                result.append(dep_name)
        return tuple(result)
    return ()


def _is_forgeflow_implementation(cfg: object) -> bool:
    return getattr(cfg, "source", None) == "forgeflow" and not getattr(
        cfg, "reviewer_thread_id", None
    )


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
        self._github_read_token_path = "/tmp/openswe-github-read-token"
        self._github_write_token_path = "/tmp/openswe-github-write-token"
        self._git_credential_path = "/workspace/.open-swe-runtime/git-credential"

    @property
    def id(self) -> str:
        return self._container_id

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        if not isinstance(command, str) or not command.strip():
            return ExecuteResponse("Error: Command must be a non-empty string.", 1, False)
        effective_timeout = self._default_timeout if timeout is None else timeout
        if effective_timeout <= 0:
            raise ValueError("timeout must be positive")
        with sandbox_operation_lock(self._container_id, exclusive=False) as acquired:
            if not acquired:
                raise DockerSandboxError("sandbox operation lock was not acquired")
            _assert_owned_container(self._container_id)
            if not _container_running(self._container_id):
                _docker("container", "start", self._container_id)

            # GNU timeout creates a separate process group unless --foreground is used,
            # so descendants receive the timeout signal as well instead of leaking into
            # the persistent container after an agent command times out.
            wrapped_command = (
                _runtime_env_prelude()
                + f'if [ -r {shlex.quote(self._github_read_token_path)} ]; then '
                + f'export GH_TOKEN="$(cat {shlex.quote(self._github_read_token_path)})"; '
                + 'export GITHUB_TOKEN="$GH_TOKEN"; '
                + 'export GIT_TERMINAL_PROMPT=0; '
                + 'export GIT_CONFIG_COUNT=2; '
                + 'export GIT_CONFIG_KEY_0=credential.helper; '
                + f'export GIT_CONFIG_VALUE_0={shlex.quote(self._git_credential_path)}; '
                + 'export GIT_CONFIG_KEY_1=credential.useHttpPath; '
                + 'export GIT_CONFIG_VALUE_1=true; fi; '
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
            output = "\n".join(parts)
            truncated = len(output.encode("utf-8")) > self._max_output_bytes
            if truncated:
                output = output.encode("utf-8")[: self._max_output_bytes].decode(
                    "utf-8", errors="ignore"
                )
                output += f"\n\n... Output truncated at {self._max_output_bytes} bytes."
            if result.returncode != 0:
                detail = output.rstrip()
                output = (
                    f"{detail}\n\nExit code: {result.returncode}"
                    if detail
                    else f"Exit code: {result.returncode}"
                )
            return ExecuteResponse(output=output, exit_code=result.returncode, truncated=truncated)

    def configure_github_credentials(self, credentials: GitHubSandboxCredentials) -> None:
        """Install short-lived tokens in tmpfs and a token-free credential helper on workspace."""
        if not credentials.read_token.strip():
            raise DockerSandboxError("GitHub read token is empty")
        with sandbox_operation_lock(self._container_id, exclusive=True) as acquired:
            if not acquired:
                raise DockerSandboxError("sandbox credential lock was not acquired")
            _assert_owned_container(self._container_id)
            if not _container_running(self._container_id):
                _docker("container", "start", self._container_id)

            for path, token in (
                (self._github_read_token_path, credentials.read_token),
                (self._github_write_token_path, credentials.write_token),
            ):
                if token:
                    tmp_path = f"{path}.new"
                    result = _docker(
                        "exec",
                        "-i",
                        self._container_id,
                        "bash",
                        "-lc",
                        f"umask 077; cat > {shlex.quote(tmp_path)} && "
                        f"mv -f {shlex.quote(tmp_path)} {shlex.quote(path)}",
                        input_bytes=token.encode(),
                        timeout=15,
                        check=False,
                    )
                else:
                    result = _docker(
                        "exec",
                        self._container_id,
                        "rm",
                        "-f",
                        path,
                        timeout=15,
                        check=False,
                    )
                if result.returncode != 0:
                    raise DockerSandboxError("failed to install ephemeral GitHub credentials")

            helper = _git_credential_script(
                read_token_path=self._github_read_token_path,
                write_token_path=self._github_write_token_path,
                write_repository=credentials.write_repository,
            )
            helper_parent = str(PurePosixPath(self._git_credential_path).parent)
            helper_tmp = f"{self._git_credential_path}.new"
            result = _docker(
                "exec",
                "-i",
                self._container_id,
                "bash",
                "-lc",
                f"mkdir -p -- {shlex.quote(helper_parent)}; chmod 700 {shlex.quote(helper_parent)}; "
                f"umask 077; cat > {shlex.quote(helper_tmp)}; "
                f"chmod 700 {shlex.quote(helper_tmp)}; "
                f"mv -f {shlex.quote(helper_tmp)} {shlex.quote(self._git_credential_path)}; "
                f"touch {shlex.quote(_LAST_USED_PATH)}",
                input_bytes=helper.encode(),
                timeout=15,
                check=False,
            )
            if result.returncode != 0:
                raise DockerSandboxError("failed to install Git credential bridge")

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        responses: list[FileUploadResponse] = []
        with sandbox_operation_lock(self._container_id, exclusive=False) as acquired:
            if not acquired:
                raise DockerSandboxError("sandbox upload lock was not acquired")
            _assert_owned_container(self._container_id)
            for raw_path, content in files:
                try:
                    path = _normalize_path(raw_path)
                    parent = str(PurePosixPath(path).parent)
                    command = (
                        f"mkdir -p -- {shlex.quote(parent)} {shlex.quote(_RUNTIME_ROOT)} "
                        f"&& touch {shlex.quote(_LAST_USED_PATH)} "
                        f"&& cat > {shlex.quote(path)}"
                    )
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
        with sandbox_operation_lock(self._container_id, exclusive=False) as acquired:
            if not acquired:
                raise DockerSandboxError("sandbox download lock was not acquired")
            _assert_owned_container(self._container_id)
            for raw_path in paths:
                try:
                    path = _normalize_path(raw_path)
                    result = _docker(
                        "exec",
                        self._container_id,
                        "bash",
                        "-lc",
                        f"mkdir -p -- {shlex.quote(_RUNTIME_ROOT)} && "
                        f"touch {shlex.quote(_LAST_USED_PATH)} && "
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
    # Deep Agents persists capture-at-source output and evicted conversation
    # history at root-level virtual paths. Keep those paths writable without
    # relaxing the read-only rootfs by mounting subdirectories of the existing
    # thread-scoped workspace volume there. The directories must exist before
    # Docker accepts volume-subpath mounts.
    artifact_dirs = (
        _ARTIFACT_ROOT,
        f"{_ARTIFACT_ROOT}/large_tool_results",
        f"{_ARTIFACT_ROOT}/conversation_history",
    )
    quoted_dirs = " ".join(shlex.quote(path) for path in artifact_dirs)
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
        "bash",
        "-lc",
        f"mkdir -p -- {quoted_dirs} && "
        f"chown 1000:1000 /workspace {quoted_dirs}",
        timeout=30,
    )


def create_docker_sandbox_sync(sandbox_id: str | None = None) -> DockerSandbox:
    """Create or reconnect to one persistent local Docker sandbox."""
    config = DockerSandboxConfig.from_env()
    if sandbox_id:
        with sandbox_operation_lock(sandbox_id, exclusive=True) as acquired:
            if not acquired:
                raise DockerSandboxError("sandbox reconnect lock was not acquired")
            if not _container_exists(sandbox_id):
                from agent.sandboxes.providers.registry import SandboxGoneError

                raise SandboxGoneError(f"Docker sandbox no longer exists: {sandbox_id}")
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
            f"/tmp:rw,nosuid,nodev,noexec,size={config.tmpfs_size}",
            "--tmpfs",
            "/home/sandbox:rw,nosuid,nodev,noexec,mode=1777,size=256m",
            "--mount",
            f"type=volume,src={volume_name},dst=/workspace",
            "--mount",
            (
                f"type=volume,src={volume_name},dst=/large_tool_results,"
                f"volume-subpath={_LARGE_TOOL_RESULTS_SUBPATH}"
            ),
            "--mount",
            (
                f"type=volume,src={volume_name},dst=/conversation_history,"
                f"volume-subpath={_CONVERSATION_HISTORY_SUBPATH}"
            ),
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


async def _github_credentials_from_run_context() -> GitHubSandboxCredentials | None:
    """Mint separate read-dependency and primary-repo write tokens for this Open SWE run."""
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
    if cfg.repo is None or not cfg.repo.name or not cfg.repo.owner:
        return None

    dependencies = _sandbox_read_repositories(cfg)
    read_repositories = list(dict.fromkeys([cfg.repo.name, *dependencies]))
    read_token, _read_expiry = await get_github_app_installation_token_with_expiry(
        repositories=read_repositories,
        permissions={"contents": "read", "pull_requests": "read"},
        log_errors=False,
    )
    if not read_token:
        raise DockerSandboxError("failed to mint sandbox GitHub read token")

    write_token: str | None = None
    write_repository: str | None = None
    if _is_forgeflow_implementation(cfg):
        write_token, _write_expiry = await get_github_app_installation_token_with_expiry(
            repositories=[cfg.repo.name],
            permissions={"contents": "write", "pull_requests": "read"},
            log_errors=False,
        )
        if not write_token:
            raise DockerSandboxError("failed to mint sandbox GitHub write token")
        write_repository = f"{cfg.repo.owner}/{cfg.repo.name}"

    return GitHubSandboxCredentials(
        read_token=read_token,
        write_token=write_token,
        write_repository=write_repository,
    )


async def create_docker_sandbox(sandbox_id: str | None = None) -> DockerSandbox:
    """Open SWE factory: create/reconnect and install only ephemeral least-privilege credentials."""
    credentials = await _github_credentials_from_run_context()
    backend = await asyncio.to_thread(create_docker_sandbox_sync, sandbox_id)
    if credentials:
        await asyncio.to_thread(backend.configure_github_credentials, credentials)
    return backend


def _delete_docker_sandbox_unlocked(container_id: str) -> None:
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


def delete_docker_sandbox(container_id: str) -> None:
    """Delete one provider-owned container and its provider-owned workspace volume."""
    with sandbox_operation_lock(container_id, exclusive=True) as acquired:
        if not acquired:
            raise DockerSandboxError("sandbox delete lock was not acquired")
        _delete_docker_sandbox_unlocked(container_id)
