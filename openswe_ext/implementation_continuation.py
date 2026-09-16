"""Durable dirty-worktree snapshots for cross-provider implementation fallback."""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import subprocess
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

_SANDBOX_RE = re.compile(r"^openswe-sbx-[0-9a-f]{12}$")
_REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
_CONTINUATION_RE = re.compile(r"^[0-9a-f]{32}$")
_SANDBOX_LABEL = "dev.open-swe.sandbox"


class ImplementationContinuationError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ImplementationContinuation:
    continuation_id: str
    source_revision: str
    path: Path


def _run_bytes(*args: str, input_data: bytes | None = None, timeout: int = 120) -> bytes:
    result = subprocess.run(
        list(args),
        input=input_data,
        capture_output=True,
        check=False,
        timeout=timeout,
        env={**os.environ, "LC_ALL": "C.UTF-8"},
    )
    if result.returncode != 0:
        raise ImplementationContinuationError("IMPLEMENTATION_CONTINUATION_COMMAND_FAILED")
    return result.stdout


def _docker_exec(sandbox_id: str, *command: str, timeout: int = 120) -> bytes:
    return _run_bytes("docker", "exec", sandbox_id, *command, timeout=timeout)


def _sandbox_metadata(sandbox_id: str) -> dict[str, Any]:
    if not _SANDBOX_RE.fullmatch(sandbox_id):
        raise ImplementationContinuationError("IMPLEMENTATION_CONTINUATION_SANDBOX_INVALID")
    raw = _run_bytes("docker", "inspect", sandbox_id, timeout=30)
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ImplementationContinuationError(
            "IMPLEMENTATION_CONTINUATION_SANDBOX_INSPECT_INVALID"
        ) from exc
    if not isinstance(payload, list) or len(payload) != 1 or not isinstance(payload[0], dict):
        raise ImplementationContinuationError("IMPLEMENTATION_CONTINUATION_SANDBOX_INSPECT_INVALID")
    labels = payload[0].get("Config", {}).get("Labels", {})
    state = payload[0].get("State", {})
    if not isinstance(labels, dict) or labels.get(_SANDBOX_LABEL) != "true":
        raise ImplementationContinuationError("IMPLEMENTATION_CONTINUATION_SANDBOX_NOT_OWNED")
    if not isinstance(state, dict) or state.get("Running") is not True:
        raise ImplementationContinuationError("IMPLEMENTATION_CONTINUATION_SANDBOX_NOT_RUNNING")
    return payload[0]


def _safe_repo_path(repo_name: str) -> str:
    if not _REPO_RE.fullmatch(repo_name) or repo_name in {".", ".."}:
        raise ImplementationContinuationError("IMPLEMENTATION_CONTINUATION_REPO_INVALID")
    return f"/workspace/{repo_name}"


def _untracked_archive(sandbox_id: str, repo_path: str) -> bytes:
    script = (
        "set -eu; cd \"$1\"; "
        "git ls-files --others --exclude-standard -z | "
        "tar --null --files-from=- -cf -"
    )
    return _docker_exec(sandbox_id, "bash", "-lc", script, "bash", repo_path, timeout=120)


def capture_openswe_continuation(
    *,
    sandbox_id: str,
    repo_name: str,
    operation_key: str,
    continuation_root: Path,
) -> ImplementationContinuation | None:
    """Capture one Open SWE dirty worktree without sharing its mutable volume."""
    _sandbox_metadata(sandbox_id)
    repo_path = _safe_repo_path(repo_name)
    status = _docker_exec(
        sandbox_id, "git", "-C", repo_path, "status", "--porcelain=v1", "-z", timeout=30
    )
    if not status:
        return None
    revision = (
        _docker_exec(sandbox_id, "git", "-C", repo_path, "rev-parse", "HEAD", timeout=30)
        .decode("ascii", errors="strict")
        .strip()
    )
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ImplementationContinuationError("IMPLEMENTATION_CONTINUATION_SOURCE_REVISION_INVALID")
    patch = _docker_exec(
        sandbox_id,
        "git",
        "-C",
        repo_path,
        "diff",
        "--binary",
        "--no-ext-diff",
        "HEAD",
        timeout=120,
    )
    untracked = _untracked_archive(sandbox_id, repo_path)
    digest = hashlib.sha256()
    for value in (sandbox_id.encode(), operation_key.encode(), revision.encode(), patch, untracked):
        digest.update(value)
        digest.update(b"\0")
    continuation_id = digest.hexdigest()[:32]

    root = continuation_root.expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = root / continuation_id
    if target.exists():
        return ImplementationContinuation(continuation_id, revision, target)

    tmp = Path(tempfile.mkdtemp(prefix=f".{continuation_id}-", dir=root))
    try:
        (tmp / "worktree.patch").write_bytes(patch)
        (tmp / "untracked.tar").write_bytes(untracked)
        metadata = {
            "version": 1,
            "continuation_id": continuation_id,
            "source_revision": revision,
            "sandbox_id": sandbox_id,
            "repo_name": repo_name,
            "operation_key": operation_key,
            "patch_sha256": hashlib.sha256(patch).hexdigest(),
            "untracked_sha256": hashlib.sha256(untracked).hexdigest(),
        }
        (tmp / "metadata.json").write_text(
            json.dumps(metadata, sort_keys=True, separators=(",", ":")), encoding="utf-8"
        )
        for path in tmp.iterdir():
            path.chmod(0o600)
        tmp.rename(target)
    except BaseException:
        import shutil

        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return ImplementationContinuation(continuation_id, revision, target)


def _metadata_for(root: Path, continuation_id: str) -> tuple[Path, dict[str, Any]]:
    if not _CONTINUATION_RE.fullmatch(continuation_id):
        raise ImplementationContinuationError("IMPLEMENTATION_CONTINUATION_ID_INVALID")
    target = root.expanduser().resolve(strict=True) / continuation_id
    try:
        resolved = target.resolve(strict=True)
    except FileNotFoundError as exc:
        raise ImplementationContinuationError("IMPLEMENTATION_CONTINUATION_MISSING") from exc
    if resolved.parent != root.expanduser().resolve(strict=True):
        raise ImplementationContinuationError("IMPLEMENTATION_CONTINUATION_PATH_INVALID")
    try:
        metadata = json.loads((resolved / "metadata.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ImplementationContinuationError("IMPLEMENTATION_CONTINUATION_METADATA_INVALID") from exc
    if not isinstance(metadata, dict) or metadata.get("continuation_id") != continuation_id:
        raise ImplementationContinuationError("IMPLEMENTATION_CONTINUATION_METADATA_INVALID")
    return resolved, metadata


def _validate_archive(raw: bytes) -> None:
    try:
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
            for member in archive.getmembers():
                path = PurePosixPath(member.name)
                if path.is_absolute() or ".." in path.parts:
                    raise ImplementationContinuationError(
                        "IMPLEMENTATION_CONTINUATION_ARCHIVE_PATH_INVALID"
                    )
                if member.isdev() or member.isfifo():
                    raise ImplementationContinuationError(
                        "IMPLEMENTATION_CONTINUATION_ARCHIVE_TYPE_INVALID"
                    )
    except tarfile.TarError as exc:
        raise ImplementationContinuationError("IMPLEMENTATION_CONTINUATION_ARCHIVE_INVALID") from exc


def apply_external_continuation(
    *,
    workspace: Path,
    continuation_root: Path,
    continuation_id: str,
    expected_source_revision: str,
) -> None:
    """Apply a trusted ForgeFlow snapshot to a fresh detached external checkout."""
    target, metadata = _metadata_for(continuation_root, continuation_id)
    if metadata.get("source_revision") != expected_source_revision:
        raise ImplementationContinuationError("IMPLEMENTATION_CONTINUATION_SOURCE_MISMATCH")
    patch = (target / "worktree.patch").read_bytes()
    untracked = (target / "untracked.tar").read_bytes()
    if hashlib.sha256(patch).hexdigest() != metadata.get("patch_sha256"):
        raise ImplementationContinuationError("IMPLEMENTATION_CONTINUATION_CHECKSUM_MISMATCH")
    if hashlib.sha256(untracked).hexdigest() != metadata.get("untracked_sha256"):
        raise ImplementationContinuationError("IMPLEMENTATION_CONTINUATION_CHECKSUM_MISMATCH")
    head = _run_bytes("git", "-C", str(workspace), "rev-parse", "HEAD", timeout=30).decode().strip()
    if head != expected_source_revision:
        raise ImplementationContinuationError("IMPLEMENTATION_CONTINUATION_WORKSPACE_HEAD_MISMATCH")
    if patch:
        _run_bytes(
            "git",
            "-C",
            str(workspace),
            "apply",
            "--binary",
            "--whitespace=nowarn",
            "-",
            input_data=patch,
            timeout=120,
        )
    _validate_archive(untracked)
    if untracked:
        try:
            with tarfile.open(fileobj=io.BytesIO(untracked), mode="r:") as archive:
                archive.extractall(path=workspace, filter="data")
        except (tarfile.TarError, OSError) as exc:
            raise ImplementationContinuationError(
                "IMPLEMENTATION_CONTINUATION_ARCHIVE_APPLY_FAILED"
            ) from exc
    _run_bytes("git", "-C", str(workspace), "diff", "--check", timeout=60)


__all__ = [
    "ImplementationContinuation",
    "ImplementationContinuationError",
    "apply_external_continuation",
    "capture_openswe_continuation",
]
