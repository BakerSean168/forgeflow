import pytest

from forgeflow.adapters import github


@pytest.mark.asyncio
async def test_preflight_requires_repo_installation_to_equal_configured_installation(monkeypatch) -> None:
    calls = []
    monkeypatch.setattr(github, "github_app_configured", lambda: True)
    monkeypatch.setattr(github, "configured_github_installation_id", lambda: 111)

    async def resolve(owner, repo):
        return 222

    async def mint(**kwargs):
        calls.append(kwargs)
        return "should-not-be-called"

    monkeypatch.setattr(github, "get_github_app_installation_id_for_repo", resolve)
    monkeypatch.setattr(github, "get_github_app_installation_token", mint)
    result = await github.preflight_github_repository("o", "r")
    assert result.status == "REPO_OR_PERMISSION_UNAVAILABLE"
    assert calls == []


@pytest.mark.asyncio
async def test_pr_and_ci_tokens_are_scoped_to_configured_installation_and_repo(monkeypatch) -> None:
    monkeypatch.setattr(github, "github_app_configured", lambda: True)
    monkeypatch.setattr(github, "configured_github_installation_id", lambda: 111)

    async def resolve(owner, repo):
        assert (owner, repo) == ("o", "r")
        return 111

    token_calls = []

    async def mint(**kwargs):
        token_calls.append(kwargs)
        return "scoped-token"

    async def fetch_meta(pr_ref, *, token):
        assert token == "scoped-token"
        return {
            "html_url": "https://github.com/o/r/pull/1",
            "state": "open",
            "head": {"sha": "b" * 40, "ref": "feature"},
            "base": {"sha": "a" * 40, "ref": "main"},
        }

    async def checks(**kwargs):
        assert kwargs["token"] == "scoped-token"
        return []

    async def statuses(**kwargs):
        assert kwargs["token"] == "scoped-token"
        return []

    monkeypatch.setattr(github, "get_github_app_installation_id_for_repo", resolve)
    monkeypatch.setattr(github, "get_github_app_installation_token", mint)
    monkeypatch.setattr(github, "fetch_github_pr_metadata", fetch_meta)
    monkeypatch.setattr(github, "list_check_runs", checks)
    monkeypatch.setattr(github, "list_commit_statuses", statuses)

    pr = await github.fetch_pull_request("https://github.com/o/r/pull/1")
    assert pr is not None
    await github.fetch_ci_signals(pr)
    assert len(token_calls) == 2
    assert all(call["installation_id"] == 111 for call in token_calls)
    assert all(call["repositories"] == ["r"] for call in token_calls)
    assert token_calls[0]["permissions"] == {"contents": "read", "pull_requests": "read"}
    assert token_calls[1]["permissions"] == {"checks": "read", "statuses": "read"}
