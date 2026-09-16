"""Private, provenance-bound workspaces for external-agent child runs."""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import shutil
import subprocess
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from forgeflow.attempts import WorkspaceCheckpoint
from openswe_ext.external_agent_execution import changed_files, working_tree_digest


class ExternalAgentWorkspaceError(RuntimeError):
    pass


@contextmanager
def _workspace_lock(path: Path):
    lock_path = path.parent / f".{path.name}.lock"
    lock_path.touch(mode=0o600, exist_ok=True)
    with lock_path.open("r+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


@dataclass(frozen=True, slots=True)
class PreparedExternalWorkspace:
    path: Path
    source_revision: str
    source_origin: str = ""
    workspace_id: str = ""
    recovery_key: str = ""
    adopted: bool = False


def _git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["git", *args],
        cwd=repo,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        check=False,
        timeout=180,
        env={**os.environ, "LC_ALL": "C.UTF-8"},
    )
    if check and result.returncode != 0:
        raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_WORKSPACE_GIT_FAILED")
    return result


def _workspace_id(recovery_key: str) -> str:
    return hashlib.sha256(recovery_key.encode("utf-8")).hexdigest()[:32]


def _safe_relative(root: Path, path: Path) -> str:
    try:
        return path.resolve(strict=True).relative_to(root.resolve(strict=True)).as_posix()
    except ValueError as exc:
        raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_WORKSPACE_NOT_PRIVATE") from exc


def _metadata_path(root: Path, workspace_id: str) -> Path:
    return root / f".forgeflow-external-{workspace_id}.json"


def _write_metadata(root: Path, *, recovery_key: str, workspace_id: str, owner: str, repo: str,
                    base_ref: str, source_revision: str, source_origin: str) -> None:
    path = _metadata_path(root, workspace_id)
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "recovery_key": recovery_key,
                "workspace_id": workspace_id,
                "owner": owner,
                "repo": repo,
                "base_ref": base_ref,
                "source_revision": source_revision,
                "source_origin": source_origin,
            },
            sort_keys=True,
            separators=(",", ":"),
        ) + "\n",
        encoding="utf-8",
    )
    path.chmod(0o600)


def _read_metadata(path: Path, workspace_id: str) -> dict[str, str]:
    try:
        raw = json.loads(_metadata_path(path.parent, workspace_id).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_WORKSPACE_PROVENANCE_INVALID") from exc
    if not isinstance(raw, dict) or any(not isinstance(raw.get(key), str) for key in (
        "recovery_key", "workspace_id", "owner", "repo", "base_ref", "source_revision", "source_origin"
    )):
        raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_WORKSPACE_PROVENANCE_INVALID")
    return raw


def _validate_workspace(path: Path, checkpoint: WorkspaceCheckpoint, root: Path) -> None:
    resolved = path.resolve(strict=True)
    if resolved != root and root not in resolved.parents:
        raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_WORKSPACE_NOT_PRIVATE")
    metadata = _read_metadata(root, checkpoint.workspace_id)
    expected = {
        "recovery_key": checkpoint.recovery_key,
        "workspace_id": checkpoint.workspace_id,
        "owner": checkpoint.owner,
        "repo": checkpoint.repo,
        "base_ref": checkpoint.base_ref,
        "source_revision": checkpoint.source_revision,
        "source_origin": checkpoint.source_origin,
    }
    if any(metadata.get(key) != value for key, value in expected.items()):
        raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_WORKSPACE_PROVENANCE_MISMATCH")
    head = _git(resolved, "rev-parse", "HEAD").stdout.strip()
    if head != checkpoint.source_revision:
        raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_WORKSPACE_SOURCE_MISMATCH")
    if _git(resolved, "symbolic-ref", "--quiet", "--short", "HEAD", check=False).returncode == 0:
        raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_WORKSPACE_BRANCH_ATTACHED")
    origin = _git(resolved, "remote", "get-url", "origin").stdout.strip()
    if origin != checkpoint.source_origin:
        raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_WORKSPACE_ORIGIN_MISMATCH")
    if not _git(resolved, "status", "--porcelain").stdout.strip():
        raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_WORKSPACE_CHECKPOINT_EMPTY")
    actual_paths = changed_files(resolved)
    if actual_paths != checkpoint.changed_files:
        raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_WORKSPACE_CHECKPOINT_DIFF_MISMATCH")
    if working_tree_digest(resolved, actual_paths) != checkpoint.diff_sha256:
        raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_WORKSPACE_CHECKPOINT_DIGEST_MISMATCH")


def prepare_external_workspace(*, source_repo: Path, base_ref: str, workspace_root: Path,
                                recovery_key: str = "", owner: str = "", repo: str = "") -> PreparedExternalWorkspace:
    source = source_repo.expanduser().resolve(strict=True)
    if not source.is_dir():
        raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_SOURCE_NOT_DIRECTORY")
    if not base_ref.strip():
        raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_BASE_REF_EMPTY")
    if _git(source, "rev-parse", "--is-inside-work-tree", check=False).stdout.strip() != "true":
        raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_SOURCE_NOT_GIT_REPOSITORY")
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
    workspace_id = _workspace_id(recovery_key) if recovery_key else uuid_workspace_id()
    placeholder = root / f"forgeflow-external-{workspace_id}"
    if placeholder.exists():
        raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_WORKSPACE_ID_COLLISION")
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
        if recovery_key:
            _write_metadata(root, recovery_key=recovery_key, workspace_id=workspace_id,
                            owner=owner, repo=repo, base_ref=base_ref,
                            source_revision=revision, source_origin=origin_url)
    except BaseException:
        shutil.rmtree(placeholder, ignore_errors=True)
        raise
    return PreparedExternalWorkspace(placeholder, revision, origin_url, workspace_id, recovery_key)


def adopt_external_workspace(*, checkpoint: WorkspaceCheckpoint, workspace_root: Path) -> PreparedExternalWorkspace:
    root = workspace_root.expanduser().resolve(strict=True)
    if not checkpoint.workspace_relpath.startswith("forgeflow-external-"):
        raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_WORKSPACE_NOT_PRIVATE")
    path = (root / checkpoint.workspace_relpath).resolve(strict=True)
    if path.parent != root:
        raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_WORKSPACE_NOT_PRIVATE")
    with _workspace_lock(path):
        _validate_workspace(path, checkpoint, root)
    return PreparedExternalWorkspace(path, checkpoint.source_revision, checkpoint.source_origin,
                                     checkpoint.workspace_id, checkpoint.recovery_key, True)


def uuid_workspace_id() -> str:
    return uuid.uuid4().hex


def cleanup_external_workspace(workspace: Path | None, *, attempts: int = 6,
                               retry_delay_seconds: float = 0.05) -> None:
    if workspace is None:
        return
    last_error: OSError | None = None
    for index in range(max(1, attempts)):
        metadata = workspace.parent / f".forgeflow-external-{workspace.name.removeprefix('forgeflow-external-')}.json"
        if not workspace.exists():
            metadata.unlink(missing_ok=True)
            return
        try:
            lock_path = workspace.parent / f".{workspace.name}.lock"
            with _workspace_lock(workspace):
                shutil.rmtree(workspace, ignore_errors=False)
            metadata.unlink(missing_ok=True)
            lock_path.unlink(missing_ok=True)
            return
        except FileNotFoundError:
            return
        except OSError as exc:
            last_error = exc
            if index + 1 < max(1, attempts):
                time.sleep(retry_delay_seconds * (index + 1))
    raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_WORKSPACE_CLEANUP_FAILED") from last_error


__all__ = [
    "ExternalAgentWorkspaceError", "PreparedExternalWorkspace", "adopt_external_workspace",
    "cleanup_external_workspace", "prepare_external_workspace",
]
