"""Execution-scoped Docker isolation for complete external coding agents.

The sandbox deliberately keeps account bootstrap state separate from the writable
agent HOME. A vendor adapter may expose one bootstrap file through a symlink,
then call ``seal_bootstrap`` before sending untrusted/project prompts. Sealing
removes the bootstrap bind mount from the container mount namespace.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

DEFAULT_IMAGE = "forgeflow/openswe-sandbox:bookworm-node24"
CONTAINER_HOME = "/home/agent"
CONTAINER_WORKSPACE = "/workspace"
CONTAINER_EXECUTABLE = "/usr/local/bin/external-agent"
BOOTSTRAP_MOUNT = "/run/forgeflow-bootstrap"


class ExternalAgentDockerError(RuntimeError):
    pass


def build_container_create_args(
    *,
    name: str,
    workspace: Path,
    executable: Path,
    bootstrap_dir: Path,
    image: str = DEFAULT_IMAGE,
    uid: int | None = None,
    gid: int | None = None,
) -> list[str]:
    """Build the fail-closed Docker container contract used by external agents."""

    resolved_workspace = workspace.resolve(strict=True)
    resolved_executable = executable.resolve(strict=True)
    resolved_bootstrap = bootstrap_dir.resolve(strict=True)
    if not resolved_workspace.is_dir():
        raise ExternalAgentDockerError("EXTERNAL_AGENT_WORKSPACE_NOT_DIRECTORY")
    if not resolved_executable.is_file() or not os.access(resolved_executable, os.X_OK):
        raise ExternalAgentDockerError("EXTERNAL_AGENT_EXECUTABLE_INVALID")
    if not resolved_bootstrap.is_dir():
        raise ExternalAgentDockerError("EXTERNAL_AGENT_BOOTSTRAP_NOT_DIRECTORY")

    run_uid = os.getuid() if uid is None else uid
    run_gid = os.getgid() if gid is None else gid
    return [
        "docker",
        "create",
        "--name",
        name,
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
        "--tmpfs",
        f"{CONTAINER_HOME}:rw,nosuid,nodev,mode=0700,uid={run_uid},gid={run_gid}",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,mode=1777",
        "--mount",
        f"type=bind,src={resolved_workspace},dst={CONTAINER_WORKSPACE}",
        "--mount",
        f"type=bind,src={resolved_executable},dst={CONTAINER_EXECUTABLE},readonly",
        "--mount",
        f"type=bind,src={resolved_bootstrap},dst={BOOTSTRAP_MOUNT},readonly",
        "--workdir",
        CONTAINER_WORKSPACE,
        "--network",
        "bridge",
        "--stop-timeout",
        "5",
        "--entrypoint",
        "/usr/bin/sleep",
        image,
        "infinity",
    ]


def build_bootstrap_unmount_args(*, pid: int, image: str = DEFAULT_IMAGE) -> list[str]:
    """Build a one-shot privileged helper that can detach a mount namespace entry."""

    if pid <= 0:
        raise ExternalAgentDockerError("EXTERNAL_AGENT_CONTAINER_PID_INVALID")
    return [
        "docker",
        "run",
        "--rm",
        "--privileged",
        "--user",
        "0",
        "--pid",
        "host",
        "--network",
        "none",
        "--read-only",
        "--entrypoint",
        "/usr/bin/nsenter",
        image,
        "-t",
        str(pid),
        "-m",
        f"--root=/proc/{pid}/root",
        f"--wd=/proc/{pid}/cwd",
        "--",
        "/usr/bin/umount",
        BOOTSTRAP_MOUNT,
    ]


def _run(
    command: Sequence[str], *, input_text: str | None = None
) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        list(command),
        text=True,
        input=input_text,
        capture_output=True,
        check=False,
        timeout=30,
        env={**os.environ, "LC_ALL": "C.UTF-8"},
    )
    if completed.returncode != 0:
        detail = (
            completed.stderr.strip().splitlines()[-1:] or completed.stdout.strip().splitlines()[-1:]
        )
        suffix = f":{detail[0][:300]}" if detail else ""
        raise ExternalAgentDockerError(f"EXTERNAL_AGENT_DOCKER_COMMAND_FAILED{suffix}")
    return completed


@dataclass(slots=True)
class ExternalAgentDockerSandbox:
    workspace: Path
    executable: Path
    bootstrap_dir: Path
    image: str = DEFAULT_IMAGE
    name: str | None = None
    _started: bool = False
    _sealed: bool = False

    async def start(self) -> None:
        if self._started:
            return
        self.name = self.name or f"forgeflow-agent-{uuid.uuid4().hex[:16]}"
        args = build_container_create_args(
            name=self.name,
            workspace=self.workspace,
            executable=self.executable,
            bootstrap_dir=self.bootstrap_dir,
            image=self.image,
        )
        try:
            await asyncio.to_thread(_run, args)
            await asyncio.to_thread(_run, ["docker", "start", self.name])
            await asyncio.to_thread(self._verify_contract)
        except Exception:
            await self.close()
            raise
        self._started = True

    async def exec(self, *args: str, input_text: str | None = None) -> None:
        self._require_started()
        await asyncio.to_thread(_run, ["docker", "exec", self.name, *args], input_text=input_text)

    async def write_text(self, path: str, content: str) -> None:
        if not path.startswith(CONTAINER_HOME + "/"):
            raise ExternalAgentDockerError("EXTERNAL_AGENT_WRITE_PATH_REJECTED")
        parent = str(Path(path).parent)
        await self.exec("mkdir", "-p", parent)
        await self.exec("/bin/sh", "-c", f"umask 077; cat > {path}", input_text=content)

    async def symlink_bootstrap_file(self, *, source_name: str, destination: str) -> None:
        if "/" in source_name or not source_name:
            raise ExternalAgentDockerError("EXTERNAL_AGENT_BOOTSTRAP_NAME_INVALID")
        if not destination.startswith(CONTAINER_HOME + "/"):
            raise ExternalAgentDockerError("EXTERNAL_AGENT_BOOTSTRAP_DESTINATION_REJECTED")
        await self.exec("mkdir", "-p", str(Path(destination).parent))
        await self.exec("ln", "-s", f"{BOOTSTRAP_MOUNT}/{source_name}", destination)

    async def start_process(self, args: Sequence[str]) -> asyncio.subprocess.Process:
        self._require_started()
        if not args:
            raise ExternalAgentDockerError("EXTERNAL_AGENT_PROCESS_ARGS_EMPTY")
        return await asyncio.create_subprocess_exec(
            "docker",
            "exec",
            "-i",
            self.name,
            CONTAINER_EXECUTABLE,
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )

    async def seal_bootstrap(self) -> None:
        """Detach bootstrap auth from the running container namespace and verify it is gone."""

        self._require_started()
        if self._sealed:
            return
        inspect = await asyncio.to_thread(
            _run, ["docker", "inspect", self.name, "--format", "{{.State.Pid}}"]
        )
        raw_pid = inspect.stdout.strip()
        if not raw_pid.isdigit() or int(raw_pid) <= 0:
            raise ExternalAgentDockerError("EXTERNAL_AGENT_CONTAINER_PID_INVALID")
        pid = int(raw_pid)
        await asyncio.to_thread(_run, build_bootstrap_unmount_args(pid=pid, image=self.image))
        mountinfo = Path(f"/proc/{pid}/mountinfo").read_text(encoding="utf-8", errors="replace")
        if f" {BOOTSTRAP_MOUNT} " in mountinfo:
            raise ExternalAgentDockerError("EXTERNAL_AGENT_BOOTSTRAP_STILL_MOUNTED")
        self._sealed = True

    async def close(self) -> None:
        name = self.name
        if name:
            try:
                await asyncio.to_thread(
                    subprocess.run,
                    ["docker", "rm", "-f", name],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                    timeout=15,
                )
            except OSError, subprocess.SubprocessError:
                # Cleanup is best-effort; the original failure remains authoritative.
                pass
        self._started = False

    def _require_started(self) -> None:
        if not self._started or not self.name:
            raise ExternalAgentDockerError("EXTERNAL_AGENT_CONTAINER_NOT_STARTED")

    def _verify_contract(self) -> None:
        if not self.name:
            raise ExternalAgentDockerError("EXTERNAL_AGENT_CONTAINER_NOT_STARTED")
        payload = json.loads(_run(["docker", "inspect", self.name]).stdout)[0]
        host = payload.get("HostConfig") or {}
        if host.get("ReadonlyRootfs") is not True:
            raise ExternalAgentDockerError("EXTERNAL_AGENT_ROOTFS_NOT_READ_ONLY")
        if "ALL" not in (host.get("CapDrop") or []):
            raise ExternalAgentDockerError("EXTERNAL_AGENT_CAPABILITIES_NOT_DROPPED")
        if not any("no-new-privileges" in item for item in (host.get("SecurityOpt") or [])):
            raise ExternalAgentDockerError("EXTERNAL_AGENT_NO_NEW_PRIVILEGES_MISSING")
        mounts = {item.get("Destination"): item for item in payload.get("Mounts") or []}
        expected = {
            CONTAINER_WORKSPACE: True,
            CONTAINER_EXECUTABLE: False,
            BOOTSTRAP_MOUNT: False,
        }
        for destination, writable in expected.items():
            item = mounts.get(destination)
            if not item or bool(item.get("RW")) is not writable:
                raise ExternalAgentDockerError(
                    f"EXTERNAL_AGENT_MOUNT_CONTRACT_INVALID:{destination}"
                )
        unexpected_binds = [
            destination
            for destination, item in mounts.items()
            if item.get("Type") == "bind" and destination not in expected
        ]
        if unexpected_binds:
            raise ExternalAgentDockerError(
                f"EXTERNAL_AGENT_UNEXPECTED_BIND_MOUNTS:{unexpected_binds!r}"
            )


__all__ = [
    "BOOTSTRAP_MOUNT",
    "CONTAINER_EXECUTABLE",
    "CONTAINER_HOME",
    "CONTAINER_WORKSPACE",
    "DEFAULT_IMAGE",
    "ExternalAgentDockerError",
    "ExternalAgentDockerSandbox",
    "build_bootstrap_unmount_args",
    "build_container_create_args",
]
