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


class GitHubEvidenceError(RuntimeError):
    """Authoritative GitHub evidence is contradictory or cannot be bounded safely."""


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


async def find_pull_request_for_operation(
    *,
    owner: str,
    repo: str,
    base_ref: str,
    operation_trailer: str,
) -> PullRequestEvidence | None:
    """Find one open PR whose *current head* proves the exact ForgeFlow operation.

    Open SWE records PR telemetry on the child thread as a best-effort side effect
    after GitHub delivery. ForgeFlow therefore cannot treat that metadata as the
    sole source of delivery truth. GitHub remains authoritative, and a candidate
    is accepted only when its current head commit contains ``operation_trailer``
    as a complete line and the PR head is unchanged when revalidated.
    """
    if not all(value.strip() for value in (owner, repo, base_ref, operation_trailer)):
        raise ValueError("operation PR lookup fields are required")
    scoped = await _repository_token(
        owner, repo, permissions={"contents": "read", "pull_requests": "read"}
    )
    if scoped is None:
        raise GitHubEvidenceError("PR_OPERATION_EVIDENCE_UNAVAILABLE")
    _installation_id, token = scoped
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    matches: list[PullRequestEvidence] = []
    try:
        async with httpx2.AsyncClient(timeout=15) as client:
            for page in range(1, 4):
                response = await client.get(
                    f"https://api.github.com/repos/{owner}/{repo}/pulls",
                    headers=headers,
                    params={
                        "state": "open",
                        "base": base_ref,
                        "sort": "updated",
                        "direction": "desc",
                        "per_page": 100,
                        "page": page,
                    },
                )
                if response.status_code != 200:
                    raise GitHubEvidenceError("PR_OPERATION_EVIDENCE_UNAVAILABLE")
                payload = _github_json(response)
                if not isinstance(payload, list):
                    raise GitHubEvidenceError("PR_OPERATION_EVIDENCE_UNAVAILABLE")
                for row in payload:
                    candidate = _pull_request_from_payload(owner, repo, row)
                    if candidate is None or candidate.base_ref != base_ref:
                        continue
                    commit_response = await client.get(
                        f"https://api.github.com/repos/{owner}/{repo}/commits/{candidate.head_sha}",
                        headers=headers,
                    )
                    if commit_response.status_code != 200:
                        raise GitHubEvidenceError("PR_OPERATION_EVIDENCE_UNAVAILABLE")
                    commit_payload = _github_json(commit_response)
                    commit = (
                        commit_payload.get("commit")
                        if isinstance(commit_payload, dict)
                        else None
                    )
                    message = commit.get("message") if isinstance(commit, dict) else None
                    if not isinstance(message, str):
                        raise GitHubEvidenceError("PR_OPERATION_EVIDENCE_UNAVAILABLE")
                    if operation_trailer not in {line.strip() for line in message.splitlines()}:
                        continue

                    # The list row is only a snapshot. Re-read the PR after
                    # validating the commit so a force-push during lookup cannot
                    # promote a trailer from a head that is already stale.
                    current_response = await client.get(
                        f"https://api.github.com/repos/{owner}/{repo}/pulls/{candidate.number}",
                        headers=headers,
                    )
                    if current_response.status_code != 200:
                        raise GitHubEvidenceError("PR_OPERATION_EVIDENCE_UNAVAILABLE")
                    current = _pull_request_from_payload(
                        owner, repo, _github_json(current_response)
                    )
                    if current is None:
                        raise GitHubEvidenceError("PR_OPERATION_EVIDENCE_UNAVAILABLE")
                    if (
                        current.state != "open"
                        or current.base_ref != base_ref
                        or current.head_sha != candidate.head_sha
                    ):
                        continue
                    matches.append(current)
                if len(payload) < 100:
                    break
            else:
                raise GitHubEvidenceError("PR_OPERATION_LOOKUP_LIMIT_EXCEEDED")
    except httpx2.RequestError as exc:
        raise GitHubEvidenceError("PR_OPERATION_EVIDENCE_UNAVAILABLE") from exc
    unique = {item.url: item for item in matches}
    if len(unique) > 1:
        raise GitHubEvidenceError("PR_OPERATION_AMBIGUOUS")
    return next(iter(unique.values()), None)


def _github_json(response: object) -> object:
    try:
        return response.json()  # type: ignore[attr-defined]
    except (ValueError, TypeError) as exc:
        raise GitHubEvidenceError("PR_OPERATION_EVIDENCE_UNAVAILABLE") from exc


def _pull_request_from_payload(
    owner: str, repo: str, payload: object
) -> PullRequestEvidence | None:
    if not isinstance(payload, dict):
        return None
    head = payload.get("head") if isinstance(payload.get("head"), dict) else {}
    base = payload.get("base") if isinstance(payload.get("base"), dict) else {}
    number = payload.get("number")
    head_sha = head.get("sha")
    base_sha = base.get("sha")
    html_url = payload.get("html_url")
    if not isinstance(number, int) or isinstance(number, bool) or number <= 0:
        return None
    if not isinstance(head_sha, str) or not head_sha:
        return None
    if not isinstance(base_sha, str) or not base_sha:
        return None
    if not isinstance(html_url, str) or not html_url:
        return None
    return PullRequestEvidence(
        owner=owner,
        repo=repo,
        number=number,
        url=html_url,
        state=_string(payload.get("state")) or "unknown",
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
