"""Git-evidence boundary for ACP-backed external coding agents."""

from __future__ import annotations

import asyncio
import hashlib
import os
import stat
import subprocess
from pathlib import Path

from forgeflow.external_agents.acp import run_acp_agent
from forgeflow.external_agents.execution import (
    ExternalAgentExecutionEvidence,
    ExternalAgentExecutionRequest,
    ExternalAgentRouteGate,
)


class ExternalAgentExecutionError(RuntimeError):
    pass


def _git(workspace: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", *args],
        cwd=workspace,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        check=check,
        timeout=30,
        env={**os.environ, "LC_ALL": "C.UTF-8"},
    )


def changed_files(workspace: Path) -> tuple[str, ...]:
    tracked = (
        _git(workspace, "diff", "--name-only", "--diff-filter=ACMRTUXB", "HEAD")
        .stdout.decode()
        .splitlines()
    )
    untracked = (
        _git(workspace, "ls-files", "--others", "--exclude-standard").stdout.decode().splitlines()
    )
    paths = [line.strip() for line in (*tracked, *untracked) if line.strip()]
    return tuple(sorted(dict.fromkeys(paths)))


def working_tree_digest(workspace: Path, paths: tuple[str, ...]) -> str:
    digest = hashlib.sha256()
    tracked_diff = _git(workspace, "diff", "--binary", "--no-ext-diff", "HEAD").stdout
    digest.update(b"tracked-diff\0")
    digest.update(tracked_diff)
    tracked = set(_git(workspace, "ls-files").stdout.decode("utf-8", errors="strict").splitlines())
    for relative in paths:
        if relative in tracked:
            continue
        path = workspace / relative
        info = path.lstat()
        digest.update(b"untracked\0")
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(stat.S_IFMT(info.st_mode)).encode())
        digest.update(b"\0")
        if path.is_symlink():
            digest.update(os.readlink(path).encode("utf-8"))
        elif path.is_file():
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
        else:
            raise ExternalAgentExecutionError("EXTERNAL_AGENT_UNTRACKED_TYPE_UNSUPPORTED")
    return digest.hexdigest()


def _test(workspace: Path, command: tuple[str, ...]) -> tuple[int, str]:
    result = subprocess.run(
        command,
        cwd=workspace,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
        timeout=900,
        text=False,
        env={
            "HOME": os.environ.get("HOME", ""),
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "LANG": os.environ.get("LANG", "C.UTF-8"),
            "LC_ALL": "C.UTF-8",
            "PYTHONDONTWRITEBYTECODE": "1",
        },
    )
    return result.returncode, hashlib.sha256(result.stdout).hexdigest()


async def _cancellation_safe_to_thread(func, /, *args, **kwargs):
    """Finish one synchronous evidence operation before propagating cancellation.

    Git, hashing, filesystem probing, and project tests are blocking operations. Running
    them on the LangGraph event loop triggers Blockbuster and, more importantly, can
    race workspace cleanup if a task is cancelled while a worker thread is still using
    the checkout.
    """
    worker = asyncio.create_task(asyncio.to_thread(func, *args, **kwargs))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        await worker
        raise


class AcpWorkspaceExecutionAdapter:
    """Execute one external-agent turn without granting it delivery credentials."""

    def __init__(
        self,
        *,
        gate: ExternalAgentRouteGate,
        agent_command: str,
        agent_args: tuple[str, ...],
        runtime_label: str,
    ) -> None:
        self._gate = gate
        self._agent_command = agent_command
        self._agent_args = agent_args
        self._runtime_label = runtime_label

    async def execute(
        self, request: ExternalAgentExecutionRequest
    ) -> ExternalAgentExecutionEvidence:
        workspace = await _cancellation_safe_to_thread(self._gate.validate, request)
        status = await _cancellation_safe_to_thread(_git, workspace, "status", "--porcelain")
        if status.stdout.strip():
            raise ExternalAgentExecutionError("EXTERNAL_AGENT_WORKSPACE_NOT_CLEAN")
        source_revision = (
            await _cancellation_safe_to_thread(_git, workspace, "rev-parse", "HEAD")
        ).stdout.decode().strip()
        branch_before = (
            await _cancellation_safe_to_thread(
                _git,
                workspace,
                "symbolic-ref",
                "--quiet",
                "--short",
                "HEAD",
                check=False,
            )
        ).stdout.decode().strip()

        prompt = (
            f"{request.objective.strip()}\n\n"
            "ForgeFlow external execution boundary:\n"
            "- Modify only files required for the objective inside the current workspace.\n"
            "- Do not create commits, switch branches, push, open pull requests, or alter remotes.\n"
            "- Do not claim CI or review success; ForgeFlow independently verifies and delivers."
        )
        result = await run_acp_agent(
            command=self._agent_command,
            args=self._agent_args,
            cwd=workspace,
            prompt=prompt,
        )
        if result.stop_reason != "end_turn":
            raise ExternalAgentExecutionError(f"EXTERNAL_AGENT_STOP_{result.stop_reason.upper()}")

        head_after = (
            await _cancellation_safe_to_thread(_git, workspace, "rev-parse", "HEAD")
        ).stdout.decode().strip()
        if head_after != source_revision:
            raise ExternalAgentExecutionError("EXTERNAL_AGENT_COMMIT_NOT_ALLOWED")
        branch_after = (
            await _cancellation_safe_to_thread(
                _git,
                workspace,
                "symbolic-ref",
                "--quiet",
                "--short",
                "HEAD",
                check=False,
            )
        ).stdout.decode().strip()
        if branch_after != branch_before:
            raise ExternalAgentExecutionError("EXTERNAL_AGENT_BRANCH_CHANGE_NOT_ALLOWED")

        paths = await _cancellation_safe_to_thread(changed_files, workspace)
        if not paths:
            raise ExternalAgentExecutionError("EXTERNAL_AGENT_NO_CHANGES")
        diff_sha256 = await _cancellation_safe_to_thread(working_tree_digest, workspace, paths)
        test_exit_code, test_output_sha256 = await _cancellation_safe_to_thread(
            _test, workspace, request.test_command
        )
        if test_exit_code != 0:
            raise ExternalAgentExecutionError(f"EXTERNAL_AGENT_TEST_FAILED:{test_exit_code}")
        post_test_paths = await _cancellation_safe_to_thread(changed_files, workspace)
        post_test_digest = await _cancellation_safe_to_thread(
            working_tree_digest, workspace, post_test_paths
        )
        if post_test_paths != paths or post_test_digest != diff_sha256:
            raise ExternalAgentExecutionError("EXTERNAL_AGENT_TEST_MUTATED_WORKSPACE")

        model = result.metadata.get("model")
        conversation = result.metadata.get("conversation_id")
        return ExternalAgentExecutionEvidence(
            runtime=self._runtime_label,
            model=model if isinstance(model, str) else None,
            source_revision=source_revision,
            changed_files=paths,
            diff_sha256=diff_sha256,
            test_command=request.test_command,
            test_exit_code=test_exit_code,
            test_output_sha256=test_output_sha256,
            acp_session_id=result.session_id,
            external_conversation_id=conversation if isinstance(conversation, str) else None,
            agent_stop_reason=result.stop_reason,
        )


__all__ = [
    "AcpWorkspaceExecutionAdapter",
    "ExternalAgentExecutionError",
    "changed_files",
    "working_tree_digest",
]
