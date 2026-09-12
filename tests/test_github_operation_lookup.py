from __future__ import annotations

import pytest

from forgeflow.adapters import github


class FakeResponse:
    def __init__(self, status_code: int, payload, *, json_error: bool = False) -> None:
        self.status_code = status_code
        self._payload = payload
        self._json_error = json_error

    def json(self):
        if self._json_error:
            raise ValueError("malformed json")
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
        if "/pulls/" in url:
            try:
                number = int(url.rsplit("/", 1)[-1])
            except ValueError:
                return FakeResponse(404, {})
            row = next((item for item in self.rows if item.get("number") == number), None)
            return FakeResponse(200 if row is not None else 404, row or {})
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

@pytest.mark.asyncio
@pytest.mark.parametrize("malformed_target", ["pulls", "commit"])
async def test_operation_lookup_normalizes_malformed_github_json(
    monkeypatch, malformed_target: str
) -> None:
    wanted = "ForgeFlow-Operation: implementation:p:retry:0"
    sha = "b" * 40

    class MalformedClient(FakeClient):
        async def get(self, url, *, headers=None, params=None):
            if malformed_target == "pulls" and url.endswith("/pulls"):
                return FakeResponse(200, None, json_error=True)
            if malformed_target == "commit" and "/commits/" in url:
                return FakeResponse(200, None, json_error=True)
            return await super().get(url, headers=headers, params=params)

    async def token(*args, **kwargs):
        return 1, "scoped-token"

    client = MalformedClient(
        [_row(1, sha)],
        {sha: {"commit": {"message": wanted}}},
    )
    monkeypatch.setattr(github, "_repository_token", token)
    monkeypatch.setattr(github.httpx2, "AsyncClient", lambda **kwargs: client)

    with pytest.raises(github.GitHubEvidenceError, match="PR_OPERATION_EVIDENCE_UNAVAILABLE"):
        await github.find_pull_request_for_operation(
            owner="o", repo="r", base_ref="main", operation_trailer=wanted
        )


@pytest.mark.asyncio
async def test_operation_lookup_rejects_head_force_pushed_during_lookup(monkeypatch) -> None:
    wanted = "ForgeFlow-Operation: implementation:p:retry:0"
    old_sha = "b" * 40
    new_sha = "c" * 40

    class ForcePushClient(FakeClient):
        async def get(self, url, *, headers=None, params=None):
            if "/pulls/1" in url:
                return FakeResponse(200, _row(1, new_sha))
            return await super().get(url, headers=headers, params=params)

    async def token(*args, **kwargs):
        return 1, "scoped-token"

    client = ForcePushClient(
        [_row(1, old_sha)],
        {old_sha: {"commit": {"message": wanted}}},
    )
    monkeypatch.setattr(github, "_repository_token", token)
    monkeypatch.setattr(github.httpx2, "AsyncClient", lambda **kwargs: client)

    found = await github.find_pull_request_for_operation(
        owner="o", repo="r", base_ref="main", operation_trailer=wanted
    )
    assert found is None
