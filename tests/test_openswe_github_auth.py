from __future__ import annotations

import pytest

from openswe_ext import github_auth


@pytest.mark.asyncio
async def test_forgeflow_host_auth_uses_repo_scoped_read_only_app_token(monkeypatch) -> None:
    calls = []

    async def mint(**kwargs):
        calls.append(kwargs)
        return "short-lived-token", "2099-01-01T00:00:00Z"

    monkeypatch.setattr(github_auth, "get_github_app_installation_token_with_expiry", mint)
    token, expiry = await github_auth.resolve_github_token(
        {
            "configurable": {
                "source": "forgeflow",
                "repo": {"owner": "BakerSean168", "name": "digital-biome"},
            }
        },
        "thread-1",
    )
    assert token == "short-lived-token"
    assert expiry == "2099-01-01T00:00:00Z"
    assert calls == [
        {
            "repositories": ["digital-biome"],
            "permissions": {"contents": "read", "pull_requests": "read"},
            "log_errors": False,
        }
    ]


@pytest.mark.asyncio
async def test_non_forgeflow_source_delegates_to_upstream(monkeypatch) -> None:
    seen = []

    async def upstream(config, thread_id):
        seen.append((config, thread_id))
        return "upstream-token", None

    monkeypatch.setattr(github_auth, "_UPSTREAM_RESOLVE", upstream)
    config = {"configurable": {"source": "github", "repo": {"owner": "o", "name": "r"}}}
    result = await github_auth.resolve_github_token(config, "thread-upstream")
    assert result == ("upstream-token", None)
    assert seen == [(config, "thread-upstream")]


def test_graph_wrapper_installs_forgeflow_auth_before_upstream_graph_use() -> None:
    text = __import__('pathlib').Path('openswe_ext/graphs.py').read_text(encoding='utf-8')
    install = text.index('install_forgeflow_github_auth()')
    upstream = text.index('from agent.graphs.agent import')
    assert install < upstream
