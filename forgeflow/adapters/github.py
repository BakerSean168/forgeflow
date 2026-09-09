"""GitHub evidence helpers using Open SWE's authentication and PR primitives."""

from dataclasses import dataclass
from typing import Any

from forgeflow.adapters.openswe import (
    fetch_github_pr_metadata,
    get_github_app_installation_token,
    list_check_runs,
    list_commit_statuses,
    parse_github_pr_url,
)


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
class CiSignals:
    head_sha: str
    check_runs: tuple[dict[str, Any], ...]
    statuses: tuple[dict[str, Any], ...]


async def fetch_pull_request(pr_url: str) -> PullRequestEvidence | None:
    """Fetch authoritative PR identity without creating a second token store."""
    pr_ref = parse_github_pr_url(pr_url)
    if pr_ref is None:
        return None
    token = await get_github_app_installation_token()
    if not token:
        return None
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


async def fetch_ci_signals(pr: PullRequestEvidence) -> CiSignals | None:
    """Read checks/statuses for the exact current head via Open SWE's GitHub auth path."""
    token = await get_github_app_installation_token()
    if not token:
        return None
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
