from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path

import pytest

from forgeflow.adapters.external_delivery import (
    ExternalAgentDeliveryError,
    ExternalAgentPullRequestDelivery,
    GitHubExternalAgentDelivery,
    delivery_branch_name,
)
from forgeflow.external_agents.execution import (
    ExternalAgentExecutionEvidence,
    ExternalAgentExecutionRequest,
)


def _git(repo: Path, *args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=repo, text=True).strip()


def _fixture(
    tmp_path: Path,
) -> tuple[Path, ExternalAgentExecutionRequest, ExternalAgentExecutionEvidence]:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-b", "main")
    _git(repo, "config", "user.name", "test")
    _git(repo, "config", "user.email", "test@example.invalid")
    (repo / "a.txt").write_text("before\n", encoding="utf-8")
    _git(repo, "add", "a.txt")
    _git(repo, "commit", "-m", "base")
    source = _git(repo, "rev-parse", "HEAD")
    (repo / "a.txt").write_text("after\n", encoding="utf-8")
    request = ExternalAgentExecutionRequest(
        owner="o",
        repo="r",
        workspace=repo,
        objective="update a",
        operation_key="external:test:1",
        phase="IMPLEMENT",
        test_command=("true",),
    )
    evidence = ExternalAgentExecutionEvidence(
        runtime="fake",
        model=None,
        source_revision=source,
        changed_files=("a.txt",),
        diff_sha256="digest",
        test_command=("true",),
        test_exit_code=0,
        test_output_sha256="output",
        acp_session_id="session",
        external_conversation_id="conversation",
        agent_stop_reason="end_turn",
    )
    return repo, request, evidence


def test_delivery_branch_is_deterministic_and_operation_scoped() -> None:
    assert delivery_branch_name("x") == delivery_branch_name("x")
    assert delivery_branch_name("x") != delivery_branch_name("y")
    assert delivery_branch_name("x").startswith("forgeflow/external-")


def test_delivery_commits_operation_trailer_before_push(tmp_path: Path) -> None:
    repo, request, evidence = _fixture(tmp_path)
    pushed: list[tuple[str, str]] = []

    async def token_provider(owner: str, repo_name: str) -> str:
        assert (owner, repo_name) == ("o", "r")
        return "test-token"

    def push(workspace: Path, owner: str, repo_name: str, branch: str, token: str) -> None:
        assert workspace == repo
        assert (owner, repo_name, token) == ("o", "r", "test-token")
        pushed.append((branch, _git(workspace, "rev-parse", "HEAD")))

    async def pr_writer(owner, repo_name, branch, base_ref, title, body, token):
        del title, body, token
        assert (owner, repo_name, base_ref) == ("o", "r", "main")
        return ExternalAgentPullRequestDelivery(
            pr_url="https://github.com/o/r/pull/1",
            pr_number=1,
            branch=branch,
            head_sha=_git(repo, "rev-parse", "HEAD"),
            base_ref=base_ref,
        )

    delivery = GitHubExternalAgentDelivery(
        token_provider=token_provider,
        pr_writer=pr_writer,
        push=push,
    )
    result = asyncio.run(
        delivery.deliver(
            request=request,
            evidence=evidence,
            base_ref="main",
            commit_subject="test: external delivery",
            pr_title="External delivery",
            pr_body="Canary",
        )
    )

    assert result.pr_number == 1
    assert pushed and pushed[0][0] == delivery_branch_name(request.operation_key)
    message = _git(repo, "show", "-s", "--format=%B", "HEAD")
    assert "ForgeFlow-Operation: external:test:1" in message.splitlines()
    assert _git(repo, "status", "--porcelain") == ""


def test_delivery_reuses_deterministic_local_branch_at_verified_source(tmp_path: Path) -> None:
    import forgeflow.adapters.external_delivery as module

    repo, request, evidence = _fixture(tmp_path)
    branch = delivery_branch_name(request.operation_key)
    _git(repo, "branch", branch, evidence.source_revision)

    workspace, resolved_branch, head_sha = module._prepare_local_delivery(
        request, evidence, "main", "test: recovery delivery"
    )

    assert workspace == repo
    assert resolved_branch == branch
    assert head_sha != evidence.source_revision
    assert _git(repo, "branch", "--show-current") == branch
    assert "ForgeFlow-Operation: external:test:1" in _git(repo, "show", "-s", "--format=%B", "HEAD")


def test_delivery_refuses_deterministic_branch_with_foreign_head(tmp_path: Path) -> None:
    import forgeflow.adapters.external_delivery as module

    repo, request, evidence = _fixture(tmp_path)
    branch = delivery_branch_name(request.operation_key)
    tree = _git(repo, "rev-parse", "HEAD^{tree}")
    foreign = subprocess.check_output(
        ["git", "commit-tree", tree, "-p", evidence.source_revision, "-m", "foreign"],
        cwd=repo,
        text=True,
    ).strip()
    _git(repo, "update-ref", f"refs/heads/{branch}", foreign)

    with pytest.raises(ExternalAgentDeliveryError, match="EXTERNAL_AGENT_LOCAL_BRANCH_EXISTS"):
        module._prepare_local_delivery(request, evidence, "main", "test: recovery delivery")


def test_delivery_refuses_workspace_drift(tmp_path: Path) -> None:
    repo, request, evidence = _fixture(tmp_path)
    (repo / "unexpected.txt").write_text("x\n", encoding="utf-8")
    delivery = GitHubExternalAgentDelivery()
    with pytest.raises(ExternalAgentDeliveryError, match="DELIVERY_DIFF_DRIFT"):
        asyncio.run(
            delivery.deliver(
                request=request,
                evidence=evidence,
                base_ref="main",
                commit_subject="test: x",
                pr_title="x",
                pr_body="x",
            )
        )


def test_delivery_git_transaction_runs_off_event_loop(tmp_path: Path, monkeypatch) -> None:
    import threading

    import forgeflow.adapters.external_delivery as module

    repo, request, evidence = _fixture(tmp_path)
    caller_thread = threading.get_ident()
    git_threads: list[int] = []
    original_git = module._git

    def recording_git(*args, **kwargs):
        git_threads.append(threading.get_ident())
        return original_git(*args, **kwargs)

    async def token_provider(owner: str, repo_name: str) -> str:
        del owner, repo_name
        return "test-token"

    def push(workspace: Path, owner: str, repo_name: str, branch: str, token: str) -> None:
        del workspace, owner, repo_name, branch, token

    async def pr_writer(owner, repo_name, branch, base_ref, title, body, token):
        del owner, repo_name, title, body, token
        head_sha = await asyncio.to_thread(_git, repo, "rev-parse", "HEAD")
        return ExternalAgentPullRequestDelivery(
            pr_url="https://github.com/o/r/pull/1",
            pr_number=1,
            branch=branch,
            head_sha=head_sha,
            base_ref=base_ref,
        )

    monkeypatch.setattr(module, "_git", recording_git)
    delivery = GitHubExternalAgentDelivery(
        token_provider=token_provider,
        pr_writer=pr_writer,
        push=push,
    )
    asyncio.run(
        delivery.deliver(
            request=request,
            evidence=evidence,
            base_ref="main",
            commit_subject="test: threaded delivery",
            pr_title="External delivery",
            pr_body="Canary",
        )
    )
    assert git_threads
    assert all(thread_id != caller_thread for thread_id in git_threads)


def test_delivery_cancellation_wins_over_worker_failure(tmp_path: Path, monkeypatch) -> None:
    import threading

    import forgeflow.adapters.external_delivery as module

    _, request, evidence = _fixture(tmp_path)
    entered = threading.Event()
    release = threading.Event()

    def failing_prepare(*args):
        del args
        entered.set()
        assert release.wait(timeout=5)
        raise ExternalAgentDeliveryError("EXTERNAL_AGENT_GIT_COMMAND_FAILED")

    monkeypatch.setattr(module, "_prepare_local_delivery", failing_prepare)
    delivery = GitHubExternalAgentDelivery()

    async def scenario() -> None:
        task = asyncio.create_task(
            delivery.deliver(
                request=request,
                evidence=evidence,
                base_ref="main",
                commit_subject="test: cancel delivery",
                pr_title="External delivery",
                pr_body="Canary",
            )
        )
        assert await asyncio.to_thread(entered.wait, 5)
        task.cancel()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
