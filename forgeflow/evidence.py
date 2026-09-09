"""Pure normalization of Open SWE/GitHub observations into policy evidence."""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from forgeflow.adapters.github import PullRequestEvidence
from forgeflow.models import ImplementationEvidence
from forgeflow.state import ForgeFlowState


@dataclass(frozen=True, slots=True)
class TrackedPullRequest:
    url: str
    number: int
    state: str
    head_ref: str
    base_ref: str


def tracked_pull_request(metadata: Mapping[str, Any]) -> TrackedPullRequest | None:
    """Read the PR reference Open SWE records on the implementation thread."""
    records = metadata.get("pull_requests")
    if isinstance(records, list):
        for record in reversed(records):
            if not isinstance(record, Mapping):
                continue
            parsed = _record_to_pr(record)
            if parsed is not None:
                return parsed
    legacy = {
        "url": metadata.get("pr_url"),
        "number": metadata.get("pr_number"),
        "state": metadata.get("pr_state"),
        "head_ref": metadata.get("branch_name"),
        "base_ref": metadata.get("base_branch"),
    }
    return _record_to_pr(legacy)


def implementation_evidence(
    state: ForgeFlowState,
    *,
    run_status: str,
    tracked_pr: TrackedPullRequest | None,
    authoritative_pr: PullRequestEvidence | None,
) -> ImplementationEvidence:
    """Prove repository progress instead of trusting a child run's terminal label."""
    if run_status != "success":
        return _no_progress("CHILD_RUN_NOT_SUCCESS")
    if tracked_pr is None:
        return _no_progress("NO_PROGRESS_NO_TRACKED_PR")
    if authoritative_pr is None:
        return _no_progress("PR_EVIDENCE_UNAVAILABLE")
    if authoritative_pr.state != "open":
        return _no_progress("PR_NOT_OPEN")
    if tracked_pr.url != authoritative_pr.url or tracked_pr.number != authoritative_pr.number:
        return _no_progress("PR_IDENTITY_MISMATCH")
    if (
        tracked_pr.head_ref
        and authoritative_pr.head_ref
        and tracked_pr.head_ref != authoritative_pr.head_ref
    ):
        return _no_progress("PR_BRANCH_MISMATCH")
    if (
        tracked_pr.base_ref
        and authoritative_pr.base_ref
        and tracked_pr.base_ref != authoritative_pr.base_ref
    ):
        return _no_progress("PR_BASE_MISMATCH")

    previous_head = state.get("observed_head_sha")
    if previous_head:
        progressed = authoritative_pr.head_sha != previous_head
        failure = None if progressed else "NO_PROGRESS_HEAD_UNCHANGED"
    else:
        progressed = authoritative_pr.head_sha != authoritative_pr.base_sha
        failure = None if progressed else "NO_PROGRESS_HEAD_EQUALS_BASE"

    return ImplementationEvidence(
        pr_url=authoritative_pr.url,
        pr_number=authoritative_pr.number,
        head_sha=authoritative_pr.head_sha,
        progressed=progressed,
        failure_code=failure,
    )


def _record_to_pr(record: Mapping[str, Any]) -> TrackedPullRequest | None:
    url = record.get("url")
    number = record.get("number")
    if not isinstance(url, str) or not url:
        return None
    if not isinstance(number, int) or isinstance(number, bool) or number <= 0:
        return None
    return TrackedPullRequest(
        url=url,
        number=number,
        state=_string(record.get("state")) or "unknown",
        head_ref=_string(record.get("head_ref")),
        base_ref=_string(record.get("base_ref")),
    )


def _no_progress(code: str) -> ImplementationEvidence:
    return ImplementationEvidence(pr_url="", pr_number=0, head_sha="", progressed=False, failure_code=code)


def _string(value: Any) -> str:
    return value if isinstance(value, str) else ""
