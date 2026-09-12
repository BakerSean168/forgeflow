from __future__ import annotations

import pytest

from forgeflow.adapters import github


class FakeResponse:
    def __init__(self, status_code: int, payload) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class FakeClient:
    def __init__(self, rows, commits) -> None:
        self.rows = rows
        self.commits = commits
        self.calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, url, *, headers=None, params=None):
        del headers
        self.calls.append((url, params))
        if url.endswith("/pulls"):
            return FakeResponse(200, self.rows)
        sha = url.rsplit("/", 1)[-1]
        payload = self.commits.get(sha)
        return FakeResponse(200 if payload is not None else 404, payload or {})


def _row(number: int, sha: str, *, body: str = "stale body"):
    return {
        "number": number,
        "html_url": f"https://github.com/o/r/pull/{number}",
        "state": "open",
        "body": body,
        "head": {"sha": sha, "ref": f"open-swe/task-{number}"},
        "base": {"sha": "a" * 40, "ref": "main"},
    }


@pytest.mark.asyncio
async def test_operation_lookup_requires_exact_current_head_trailer(monkeypatch) -> None:
    wanted = "ForgeFlow-Operation: implementation:p:retry:0"
    good_sha = "b" * 40
    stale_sha = "c" * 40
    client = FakeClient(
        [_row(1, stale_sha, body=wanted), _row(2, good_sha)],
        {
            stale_sha: {"commit": {"message": "feat: stale"}},
            good_sha: {"commit": {"message": f"feat: current\n\n{wanted}"}},
        },
    )

    async def token(*args, **kwargs):
        return 1, "scoped-token"

    monkeypatch.setattr(github, "_repository_token", token)
    monkeypatch.setattr(github.httpx2, "AsyncClient", lambda **kwargs: client)

    found = await github.find_pull_request_for_operation(
        owner="o", repo="r", base_ref="main", operation_trailer=wanted
    )
    assert found is not None
    assert found.number == 2
    assert found.head_sha == good_sha


@pytest.mark.asyncio
async def test_operation_lookup_fails_closed_on_multiple_current_head_matches(monkeypatch) -> None:
    wanted = "ForgeFlow-Operation: implementation:p:retry:0"
    sha1 = "b" * 40
    sha2 = "c" * 40
    client = FakeClient(
        [_row(1, sha1), _row(2, sha2)],
        {
            sha1: {"commit": {"message": wanted}},
            sha2: {"commit": {"message": wanted}},
        },
    )

    async def token(*args, **kwargs):
        return 1, "scoped-token"

    monkeypatch.setattr(github, "_repository_token", token)
    monkeypatch.setattr(github.httpx2, "AsyncClient", lambda **kwargs: client)

    with pytest.raises(github.GitHubEvidenceError, match="PR_OPERATION_AMBIGUOUS"):
        await github.find_pull_request_for_operation(
            owner="o", repo="r", base_ref="main", operation_trailer=wanted
        )

@pytest.mark.asyncio
async def test_operation_lookup_reports_github_unavailable(monkeypatch) -> None:
    class UnavailableClient(FakeClient):
        async def get(self, url, *, headers=None, params=None):
            del url, headers, params
            return FakeResponse(503, {})

    async def token(*args, **kwargs):
        return 1, "scoped-token"

    monkeypatch.setattr(github, "_repository_token", token)
    monkeypatch.setattr(
        github.httpx2,
        "AsyncClient",
        lambda **kwargs: UnavailableClient([], {}),
    )

    with pytest.raises(github.GitHubEvidenceError, match="PR_OPERATION_EVIDENCE_UNAVAILABLE"):
        await github.find_pull_request_for_operation(
            owner="o",
            repo="r",
            base_ref="main",
            operation_trailer="ForgeFlow-Operation: implementation:p:retry:0",
        )
