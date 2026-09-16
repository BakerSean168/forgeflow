from __future__ import annotations

import io
import subprocess
import tarfile
from pathlib import Path

import pytest

from openswe_ext import implementation_continuation as module


def _git(repo: Path, *args: str) -> bytes:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True
    ).stdout


def _repo(tmp_path: Path) -> tuple[Path, str, bytes, bytes]:
    repo = tmp_path / "source"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "test@example.invalid")
    _git(repo, "config", "user.name", "Test")
    (repo / "tracked.txt").write_text("before\n", encoding="utf-8")
    _git(repo, "add", "tracked.txt")
    _git(repo, "commit", "-q", "-m", "base")
    revision = _git(repo, "rev-parse", "HEAD").decode().strip()
    (repo / "tracked.txt").write_text("after\n", encoding="utf-8")
    (repo / "untracked.txt").write_text("new\n", encoding="utf-8")
    patch = _git(repo, "diff", "--binary", "--no-ext-diff", "HEAD")
    archive_bytes = io.BytesIO()
    with tarfile.open(fileobj=archive_bytes, mode="w") as archive:
        archive.add(repo / "untracked.txt", arcname="untracked.txt")
    return repo, revision, patch, archive_bytes.getvalue()


def test_capture_and_apply_preserves_dirty_worktree(tmp_path, monkeypatch) -> None:
    source, revision, patch, untracked = _repo(tmp_path)
    root = tmp_path / "continuations"
    root.mkdir()
    monkeypatch.setattr(module, "_sandbox_metadata", lambda sandbox_id: {"State": {"Running": True}})

    def fake_exec(sandbox_id, *command, timeout=120):
        del sandbox_id, timeout
        if command[:4] == ("git", "-C", "/workspace/memoflow", "status"):
            return b" M tracked.txt\0?? untracked.txt\0"
        if command[:4] == ("git", "-C", "/workspace/memoflow", "rev-parse"):
            return f"{revision}\n".encode()
        if command[:4] == ("git", "-C", "/workspace/memoflow", "diff"):
            return patch
        if command[:2] == ("bash", "-lc"):
            return untracked
        raise AssertionError(command)

    monkeypatch.setattr(module, "_docker_exec", fake_exec)
    captured = module.capture_openswe_continuation(
        sandbox_id="openswe-sbx-012345abcdef",
        repo_name="memoflow",
        operation_key="implementation:policy:retry:2",
        continuation_root=root,
    )
    assert captured is not None
    assert captured.source_revision == revision

    workspace = tmp_path / "workspace"
    subprocess.run(["git", "clone", "-q", str(source), str(workspace)], check=True)
    subprocess.run(["git", "-C", str(workspace), "reset", "--hard", revision], check=True)
    subprocess.run(["git", "-C", str(workspace), "clean", "-fd"], check=True)
    module.apply_external_continuation(
        workspace=workspace,
        continuation_root=root,
        continuation_id=captured.continuation_id,
        expected_source_revision=revision,
    )
    assert (workspace / "tracked.txt").read_text(encoding="utf-8") == "after\n"
    assert (workspace / "untracked.txt").read_text(encoding="utf-8") == "new\n"
    status = _git(workspace, "status", "--short").decode()
    assert "tracked.txt" in status
    assert "untracked.txt" in status


def test_apply_rejects_source_revision_drift(tmp_path, monkeypatch) -> None:
    _, revision, patch, untracked = _repo(tmp_path)
    root = tmp_path / "continuations"
    root.mkdir()
    monkeypatch.setattr(module, "_sandbox_metadata", lambda sandbox_id: {})

    def fake_exec(sandbox_id, *command, timeout=120):
        del sandbox_id, timeout
        if command[:4] == ("git", "-C", "/workspace/memoflow", "status"):
            return b" M tracked.txt\0"
        if command[:4] == ("git", "-C", "/workspace/memoflow", "rev-parse"):
            return f"{revision}\n".encode()
        if command[:4] == ("git", "-C", "/workspace/memoflow", "diff"):
            return patch
        if command[:2] == ("bash", "-lc"):
            return untracked
        raise AssertionError(command)

    monkeypatch.setattr(module, "_docker_exec", fake_exec)
    captured = module.capture_openswe_continuation(
        sandbox_id="openswe-sbx-012345abcdef",
        repo_name="memoflow",
        operation_key="op",
        continuation_root=root,
    )
    assert captured is not None
    with pytest.raises(module.ImplementationContinuationError, match="SOURCE_MISMATCH"):
        module.apply_external_continuation(
            workspace=tmp_path,
            continuation_root=root,
            continuation_id=captured.continuation_id,
            expected_source_revision="f" * 40,
        )
