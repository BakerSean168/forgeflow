"""GitHub evidence helpers using Open SWE's authentication and PR primitives."""

from dataclasses import dataclass
from typing import Any

import httpx2

from forgeflow.adapters.openswe import (
    configured_github_installation_id,
    fetch_github_pr_metadata,
    get_github_app_installation_id_for_repo,
    get_github_app_installation_token,
    github_app_configured,
    list_check_runs,
    list_commit_statuses,
    parse_github_pr_url,
)
from forgeflow.models import RepositoryPreflight


@dataclass(frozen=True, slots=True)
class PullRequestEvidence:
    owner: str
    repo: str
    number: int
    url: str
    state: str
    head_sha: str
    head_ref: str
    base_sha: str
    base_ref: str


@dataclass(frozen=True, slots=True)
class CommitEvidence:
    sha: str
    message: str


@dataclass(frozen=True, slots=True)
class CiSignals:
    head_sha: str
    check_runs: tuple[dict[str, Any], ...]
    statuses: tuple[dict[str, Any], ...]


async def _repository_token(
    owner: str, repo: str, *, permissions: dict[str, str]
) -> tuple[int, str] | None:
    configured = configured_github_installation_id()
    if configured is None:
        return None
    resolved = await get_github_app_installation_id_for_repo(owner, repo)
    if resolved is None or int(resolved) != configured:
        return None
    token = await get_github_app_installation_token(
        installation_id=configured,
        repositories=[repo],
        permissions=permissions,
        log_errors=False,
    )
    return (configured, token) if token else None


async def preflight_github_repository(owner: str, repo: str) -> RepositoryPreflight:
    """Verify the dedicated Open SWE App can mint the scopes ForgeFlow gates require."""
    if not github_app_configured():
        return RepositoryPreflight(status="CONFIG_MISSING")
    scoped = await _repository_token(
        owner,
        repo,
        permissions={
            "contents": "read",
            "pull_requests": "write",
            "checks": "write",
            "statuses": "read",
        },
    )
    if scoped is None:
        return RepositoryPreflight(status="REPO_OR_PERMISSION_UNAVAILABLE")
    installation_id, _token = scoped
    return RepositoryPreflight(status="READY", installation_id=installation_id)


async def fetch_pull_request(pr_url: str) -> PullRequestEvidence | None:
    """Fetch authoritative PR identity without creating a second token store."""
    pr_ref = parse_github_pr_url(pr_url)
    if pr_ref is None:
        return None
    scoped = await _repository_token(
        pr_ref.owner, pr_ref.repo, permissions={"contents": "read", "pull_requests": "read"}
    )
    if scoped is None:
        return None
    _installation_id, token = scoped
    payload = await fetch_github_pr_metadata(pr_ref, token=token)
    if not isinstance(payload, dict):
        return None
    head = payload.get("head") if isinstance(payload.get("head"), dict) else {}
    base = payload.get("base") if isinstance(payload.get("base"), dict) else {}
    head_sha = head.get("sha")
    base_sha = base.get("sha")
    if not isinstance(head_sha, str) or not head_sha:
        return None
    if not isinstance(base_sha, str) or not base_sha:
        return None
    html_url = payload.get("html_url")
    state = payload.get("state")
    return PullRequestEvidence(
        owner=pr_ref.owner,
        repo=pr_ref.repo,
        number=pr_ref.number,
        url=html_url if isinstance(html_url, str) and html_url else pr_url,
        state=state if isinstance(state, str) else "unknown",
        head_sha=head_sha,
        head_ref=_string(head.get("ref")),
        base_sha=base_sha,
        base_ref=_string(base.get("ref")),
    )


async def fetch_head_commit(pr: PullRequestEvidence) -> CommitEvidence | None:
    scoped = await _repository_token(
        pr.owner, pr.repo, permissions={"contents": "read"}
    )
    if scoped is None:
        return None
    _installation_id, token = scoped
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    async with httpx2.AsyncClient(timeout=15) as client:
        response = await client.get(
            f"https://api.github.com/repos/{pr.owner}/{pr.repo}/commits/{pr.head_sha}",
            headers=headers,
        )
    if response.status_code != 200:
        return None
    payload = response.json()
    if not isinstance(payload, dict) or payload.get("sha") != pr.head_sha:
        return None
    commit = payload.get("commit")
    message = commit.get("message") if isinstance(commit, dict) else None
    if not isinstance(message, str):
        return None
    return CommitEvidence(sha=pr.head_sha, message=message)


async def fetch_ci_signals(pr: PullRequestEvidence) -> CiSignals | None:
    """Read checks/statuses for the exact current head via Open SWE's GitHub auth path."""
    scoped = await _repository_token(
        pr.owner, pr.repo, permissions={"checks": "read", "statuses": "read"}
    )
    if scoped is None:
        return None
    _installation_id, token = scoped
    check_runs = await list_check_runs(owner=pr.owner, repo=pr.repo, ref=pr.head_sha, token=token)
    statuses = await list_commit_statuses(owner=pr.owner, repo=pr.repo, ref=pr.head_sha, token=token)
    if check_runs is None or statuses is None:
        return None
    return CiSignals(
        head_sha=pr.head_sha,
        check_runs=tuple(check_runs),
        statuses=tuple(statuses),
    )


def _string(value: Any) -> str:
    return value if isinstance(value, str) else ""
