"""Disposable local workspace preparation for external-agent child runs."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path


class ExternalAgentWorkspaceError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class PreparedExternalWorkspace:
    path: Path
    source_revision: str


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["git", *args],
        cwd=repo,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        check=False,
        timeout=180,
    )
    if result.returncode != 0:
        raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_WORKSPACE_GIT_FAILED")
    return result


def prepare_external_workspace(
    *, source_repo: Path, base_ref: str, workspace_root: Path
) -> PreparedExternalWorkspace:
    source = source_repo.expanduser().resolve(strict=True)
    if not source.is_dir():
        raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_SOURCE_NOT_DIRECTORY")
    probe = subprocess.run(
        ["git", "rev-parse", "--is-inside-work-tree"],
        cwd=source,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    if probe.returncode != 0 or probe.stdout.strip() != "true":
        raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_SOURCE_NOT_GIT_REPOSITORY")
    if not base_ref.strip():
        raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_BASE_REF_EMPTY")

    _git(source, "fetch", "--quiet", "origin", base_ref)
    revision = _git(source, "rev-parse", f"origin/{base_ref}").stdout.strip()
    if len(revision) != 40:
        raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_SOURCE_REVISION_INVALID")
    origin_url = _git(source, "remote", "get-url", "origin").stdout.strip()
    if not origin_url:
        raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_ORIGIN_URL_MISSING")

    root = workspace_root.expanduser().resolve(strict=True)
    if not root.is_dir():
        raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_WORKSPACE_ROOT_INVALID")
    placeholder = Path(tempfile.mkdtemp(prefix="forgeflow-external-run-", dir=root))
    placeholder.rmdir()
    result = subprocess.run(
        ["git", "clone", "--quiet", "--no-local", "--no-checkout", origin_url, str(placeholder)],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        check=False,
        timeout=180,
    )
    if result.returncode != 0:
        shutil.rmtree(placeholder, ignore_errors=True)
        raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_WORKSPACE_CLONE_FAILED")
    try:
        _git(placeholder, "checkout", "--quiet", "--detach", revision)
    except BaseException:
        shutil.rmtree(placeholder, ignore_errors=True)
        raise
    return PreparedExternalWorkspace(path=placeholder, source_revision=revision)


def cleanup_external_workspace(
    workspace: Path | None,
    *,
    attempts: int = 6,
    retry_delay_seconds: float = 0.05,
) -> None:
    """Remove a disposable checkout despite short-lived process/filesystem races.

    External tools can still be reaping children when the ACP turn unwinds. A bounded
    retry absorbs those transient races; persistent residue is surfaced as a named
    policy failure instead of leaking a raw ``OSError`` out of the LangGraph node.
    """
    if workspace is None:
        return
    last_error: OSError | None = None
    for index in range(max(1, attempts)):
        if not workspace.exists():
            return
        try:
            shutil.rmtree(workspace, ignore_errors=False)
            return
        except FileNotFoundError:
            return
        except OSError as exc:
            last_error = exc
            if index + 1 < max(1, attempts):
                time.sleep(retry_delay_seconds * (index + 1))
    raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_WORKSPACE_CLEANUP_FAILED") from last_error


__all__ = [
    "ExternalAgentWorkspaceError",
    "PreparedExternalWorkspace",
    "cleanup_external_workspace",
    "prepare_external_workspace",
]
