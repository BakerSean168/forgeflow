import subprocess
from pathlib import Path

from openswe_ext.external_agent_workspace import (
    cleanup_external_workspace,
    prepare_external_workspace,
)


def _git(repo: Path, *args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=repo, text=True).strip()


def test_prepare_workspace_clones_exact_remote_base_without_copying_dirty_worktree(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    _git(source, "init", "-b", "main")
    _git(source, "config", "user.name", "test")
    _git(source, "config", "user.email", "test@example.invalid")
    (source / "a.txt").write_text("base\n", encoding="utf-8")
    _git(source, "add", "a.txt")
    _git(source, "commit", "-m", "base")
    bare = tmp_path / "remote.git"
    subprocess.check_call(["git", "clone", "--bare", str(source), str(bare)])
    _git(source, "remote", "add", "origin", str(bare))
    _git(source, "push", "-u", "origin", "main")
    expected = _git(source, "rev-parse", "HEAD")
    (source / "a.txt").write_text("dirty local\n", encoding="utf-8")

    root = tmp_path / "workspaces"
    root.mkdir()
    prepared = prepare_external_workspace(source_repo=source, base_ref="main", workspace_root=root)
    try:
        assert prepared.source_revision == expected
        assert _git(prepared.path, "rev-parse", "HEAD") == expected
        assert (prepared.path / "a.txt").read_text(encoding="utf-8") == "base\n"
    finally:
        cleanup_external_workspace(prepared.path)
    assert list(root.iterdir()) == []


def test_prepare_workspace_includes_remote_commit_when_source_local_branch_is_behind(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    _git(source, "init", "-b", "main")
    _git(source, "config", "user.name", "test")
    _git(source, "config", "user.email", "test@example.invalid")
    (source / "a.txt").write_text("base\n", encoding="utf-8")
    _git(source, "add", "a.txt")
    _git(source, "commit", "-m", "base")
    bare = tmp_path / "remote.git"
    subprocess.check_call(["git", "clone", "--bare", str(source), str(bare)])
    _git(source, "remote", "add", "origin", str(bare))
    _git(source, "push", "-u", "origin", "main")
    local_head = _git(source, "rev-parse", "HEAD")

    updater = tmp_path / "updater"
    subprocess.check_call(["git", "clone", "--quiet", str(bare), str(updater)])
    _git(updater, "config", "user.name", "test")
    _git(updater, "config", "user.email", "test@example.invalid")
    (updater / "a.txt").write_text("remote-new\n", encoding="utf-8")
    _git(updater, "add", "a.txt")
    _git(updater, "commit", "-m", "remote update")
    _git(updater, "push", "origin", "main")
    remote_head = _git(updater, "rev-parse", "HEAD")
    assert remote_head != local_head
    assert _git(source, "rev-parse", "HEAD") == local_head

    root = tmp_path / "workspaces"
    root.mkdir()
    prepared = prepare_external_workspace(source_repo=source, base_ref="main", workspace_root=root)
    try:
        assert prepared.source_revision == remote_head
        assert _git(prepared.path, "rev-parse", "HEAD") == remote_head
        assert (prepared.path / "a.txt").read_text(encoding="utf-8") == "remote-new\n"
    finally:
        cleanup_external_workspace(prepared.path)
