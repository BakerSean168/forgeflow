from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path
from typing import Any

import agent.middleware.workflow_push_guard as upstream
import pytest
from deepagents.backends.protocol import ExecuteResponse

from openswe_ext import workflow_push_guard as overlay


class ShellBackend:
    async def aexecute(self, command: str, **_kwargs: Any) -> ExecuteResponse:
        def run() -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                ["bash", "-lc", command],
                text=True,
                capture_output=True,
                check=False,
            )

        result = await asyncio.to_thread(run)
        output = result.stdout
        if result.stderr:
            output += result.stderr
        return ExecuteResponse(output, result.returncode, False)


def git(cwd: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(cwd), *args],
        text=True,
        capture_output=True,
        check=True,
    )
    return result.stdout.strip()


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def make_non_default_base_repo(tmp_path: Path) -> tuple[Path, str]:
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
    work = tmp_path / "work"
    subprocess.run(["git", "clone", str(remote), str(work)], check=True, capture_output=True)
    git(work, "config", "user.name", "test")
    git(work, "config", "user.email", "test@example.com")

    write(work / ".github/workflows/ci.yml", "name: main\n")
    write(work / "README.md", "main\n")
    git(work, "add", ".")
    git(work, "commit", "-m", "main")
    git(work, "branch", "-M", "main")
    git(work, "push", "-u", "origin", "main")
    subprocess.run(
        ["git", "--git-dir", str(remote), "symbolic-ref", "HEAD", "refs/heads/main"],
        check=True,
        capture_output=True,
    )
    git(work, "remote", "set-head", "origin", "-a")

    git(work, "checkout", "-b", "release/policy-v1")
    write(work / ".github/workflows/ci.yml", "name: release\n")
    git(work, "add", ".github/workflows/ci.yml")
    git(work, "commit", "-m", "release workflow")
    release_sha = git(work, "rev-parse", "HEAD")
    git(work, "push", "-u", "origin", "release/policy-v1")

    git(work, "checkout", "-b", "task")
    git(work, "branch", "--set-upstream-to", "origin/release/policy-v1", "task")
    write(work / "README.md", "task\n")
    git(work, "add", "README.md")
    git(work, "commit", "-m", "task docs")
    return work, release_sha


@pytest.mark.asyncio
async def test_non_default_base_does_not_inherit_false_workflow_approval(tmp_path: Path) -> None:
    work, _release_sha = make_non_default_base_repo(tmp_path)
    backend = ShellBackend()
    parsed = upstream.ParsedGitPush(
        repo_dir=str(work),
        remote="origin",
        local_ref="HEAD",
        remote_ref="task",
        set_upstream=True,
    )

    baseline = await overlay._UPSTREAM_CHANGE_FOR_PUSH(backend, parsed)
    assert baseline is not None
    assert baseline.files == [".github/workflows/ci.yml"]
    assert baseline.base_sha == git(work, "rev-parse", "main")

    fixed = await overlay.workflow_change_for_push(backend, parsed)
    assert fixed is None


@pytest.mark.asyncio
async def test_real_workflow_change_relative_to_tracked_base_still_requires_approval(
    tmp_path: Path,
) -> None:
    work, release_sha = make_non_default_base_repo(tmp_path)
    write(work / ".github/workflows/ci.yml", "name: task-change\n")
    git(work, "add", ".github/workflows/ci.yml")
    git(work, "commit", "-m", "task workflow")

    change = await overlay.workflow_change_for_push(
        ShellBackend(),
        upstream.ParsedGitPush(
            repo_dir=str(work),
            remote="origin",
            local_ref="HEAD",
            remote_ref="task",
            set_upstream=True,
        ),
    )
    assert change is not None
    assert change.files == [".github/workflows/ci.yml"]
    assert change.base_sha == release_sha
    assert "name: task-change" in change.diff_preview


def test_graph_wrapper_installs_workflow_guard_fix_before_upstream_graph_import() -> None:
    text = Path("openswe_ext/graphs.py").read_text(encoding="utf-8")
    install = text.index("install_workflow_push_guard_base_fix()")
    upstream_graph = text.index("from agent.graphs.agent import")
    assert install < upstream_graph
