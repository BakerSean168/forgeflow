"""Pure normalization of Open SWE/GitHub observations into policy evidence."""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from forgeflow.adapters.github import PullRequestEvidence
from forgeflow.models import ImplementationEvidence
from forgeflow.state import ForgeFlowState


@dataclass(frozen=True, slots=True)
class TrackedPullRequest:
    owner: str
    repo: str
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
    target_failure = pull_request_target_failure(state, authoritative_pr)
    if target_failure:
        return _no_progress(target_failure)
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
    parsed = _parse_github_pr_url(url)
    if parsed is None or parsed[2] != number:
        return None
    return TrackedPullRequest(
        owner=parsed[0],
        repo=parsed[1],
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


_SUCCESSFUL_CHECK_CONCLUSIONS = frozenset({"success", "neutral", "skipped"})
_FAILED_CHECK_CONCLUSIONS = frozenset(
    {"failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"}
)


def ci_decision(signals, policy):
    """Normalize exact-head GitHub CI without collapsing conflicting signal sources."""
    from forgeflow.adapters.github import CiSignals
    from forgeflow.models import CiDecision, RepositoryPolicy

    if not isinstance(signals, CiSignals):
        raise TypeError("signals must be CiSignals")
    if not isinstance(policy, RepositoryPolicy):
        raise TypeError("policy must be RepositoryPolicy")
    if policy.ci_required and not policy.required_checks:
        return CiDecision(
            head_sha=signals.head_sha,
            status="UNRESOLVED",
            failure_code="REQUIRED_CHECK_POLICY_MISSING",
        )
    if not policy.ci_required and not policy.required_checks:
        return CiDecision(head_sha=signals.head_sha, status="PASS")

    checks, check_error = _normalize_check_runs(signals.check_runs)
    if check_error:
        return CiDecision(head_sha=signals.head_sha, status="UNRESOLVED", failure_code=check_error)
    statuses, status_error = _normalize_statuses(signals.statuses)
    if status_error:
        return CiDecision(head_sha=signals.head_sha, status="UNRESOLVED", failure_code=status_error)

    for required in policy.required_checks:
        sources: list[tuple[str, dict[str, Any]]] = []
        if required in checks:
            sources.append(("check", checks[required]))
        if required in statuses:
            sources.append(("status", statuses[required]))
        if not sources:
            return CiDecision(
                head_sha=signals.head_sha,
                status="UNRESOLVED",
                failure_code=f"MISSING_REQUIRED_CHECK:{required}",
            )
        decision = _evaluate_required_signal(required, sources, signals.head_sha)
        if decision is not None:
            return decision
    from forgeflow.models import CiDecision

    return CiDecision(head_sha=signals.head_sha, status="PASS")


def _normalize_check_runs(
    runs: tuple[dict[str, Any], ...],
) -> tuple[dict[str, dict[str, Any]], str | None]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for run in runs:
        name = run.get("name")
        if isinstance(name, str) and name:
            grouped.setdefault(name, []).append(run)
    normalized: dict[str, dict[str, Any]] = {}
    for name, candidates in grouped.items():
        if len(candidates) == 1:
            normalized[name] = candidates[0]
            continue
        ranked = sorted(candidates, key=_check_rank, reverse=True)
        top_rank = _check_rank(ranked[0])
        tied = [item for item in ranked if _check_rank(item) == top_rank]
        signatures = {(item.get("status"), item.get("conclusion")) for item in tied}
        if top_rank == ("", -1) or len(signatures) > 1:
            return {}, f"AMBIGUOUS_CHECK_NAME:{name}"
        normalized[name] = ranked[0]
    return normalized, None


def _check_rank(check: dict[str, Any]) -> tuple[str, int]:
    timestamp = check.get("completed_at") or check.get("started_at") or check.get("created_at")
    stamp = timestamp if isinstance(timestamp, str) else ""
    raw_id = check.get("id")
    check_id = raw_id if isinstance(raw_id, int) and not isinstance(raw_id, bool) else -1
    return stamp, check_id


def _normalize_statuses(
    statuses: tuple[dict[str, Any], ...],
) -> tuple[dict[str, dict[str, Any]], str | None]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for status in statuses:
        context = status.get("context")
        if isinstance(context, str) and context:
            grouped.setdefault(context, []).append(status)
    normalized: dict[str, dict[str, Any]] = {}
    for context, candidates in grouped.items():
        if len(candidates) == 1:
            normalized[context] = candidates[0]
            continue
        ranked = sorted(candidates, key=_status_rank, reverse=True)
        top_rank = _status_rank(ranked[0])
        tied = [item for item in ranked if _status_rank(item) == top_rank]
        if top_rank == ("", -1) or len({item.get("state") for item in tied}) > 1:
            return {}, f"AMBIGUOUS_STATUS_CONTEXT:{context}"
        normalized[context] = ranked[0]
    return normalized, None


def _status_rank(status: dict[str, Any]) -> tuple[str, int]:
    timestamp = status.get("updated_at") or status.get("created_at")
    stamp = timestamp if isinstance(timestamp, str) else ""
    raw_id = status.get("id")
    status_id = raw_id if isinstance(raw_id, int) and not isinstance(raw_id, bool) else -1
    return stamp, status_id


def _evaluate_required_signal(required: str, sources, head_sha: str):
    from forgeflow.models import CiDecision

    pending = False
    unresolved = False
    for kind, record in sources:
        if kind == "check":
            status = record.get("status")
            conclusion = record.get("conclusion")
            if status != "completed":
                pending = True
            elif conclusion in _FAILED_CHECK_CONCLUSIONS:
                return CiDecision(
                    head_sha=head_sha,
                    status="FAIL",
                    failure_code=f"CHECK_FAILED:{required}",
                )
            elif conclusion not in _SUCCESSFUL_CHECK_CONCLUSIONS:
                unresolved = True
        else:
            state = record.get("state")
            if state == "pending":
                pending = True
            elif state in {"failure", "error"}:
                return CiDecision(
                    head_sha=head_sha,
                    status="FAIL",
                    failure_code=f"STATUS_FAILED:{required}",
                )
            elif state != "success":
                unresolved = True
    if pending:
        return CiDecision(head_sha=head_sha, status="PENDING")
    if unresolved:
        return CiDecision(
            head_sha=head_sha, status="UNRESOLVED", failure_code=f"CI_UNRESOLVED:{required}"
        )
    return None


class EvidenceViolation(ValueError):
    """Observed external evidence is malformed or stale for the current policy head."""


def review_decision(snapshot, *, expected_head_sha: str):
    """Normalize an official reviewer snapshot and require exact-head completion."""
    from forgeflow.adapters.openswe import ReviewerSnapshot
    from forgeflow.models import FindingSummary, ReviewDecision

    if not isinstance(snapshot, ReviewerSnapshot):
        raise TypeError("snapshot must be ReviewerSnapshot")
    if snapshot.run_status != "success":
        raise EvidenceViolation("official reviewer run is not successful")
    if not expected_head_sha or snapshot.last_reviewed_sha != expected_head_sha:
        raise EvidenceViolation("official reviewer evidence is stale for the current PR head")

    normalized = []
    for item in snapshot.findings:
        finding_id = item.get("id")
        severity = item.get("severity")
        status = item.get("status", "open")
        if not isinstance(finding_id, str) or not finding_id:
            raise EvidenceViolation("review finding has no stable id")
        if severity not in {"critical", "high", "medium", "low"}:
            raise EvidenceViolation(f"review finding {finding_id} has unknown severity")
        if status not in {"open", "resolved", "dismissed"}:
            raise EvidenceViolation(f"review finding {finding_id} has unknown status")
        normalized.append(FindingSummary(id=finding_id, severity=severity, status=status))

    return ReviewDecision(
        head_sha=expected_head_sha,
        reviewer_thread_id=snapshot.thread_id,
        reviewer_run_id=snapshot.run_id,
        findings=tuple(normalized),
    )


def blocking_repair_findings(snapshot, *, expected_head_sha: str):
    """Extract bounded repair details from a valid exact-head official review."""
    from forgeflow.adapters.openswe import ReviewerSnapshot
    from forgeflow.prompts.repair import RepairFinding

    # Reuse exact-head/run-success validation and structured id/severity/status checks.
    review_decision(snapshot, expected_head_sha=expected_head_sha)
    if not isinstance(snapshot, ReviewerSnapshot):
        raise TypeError("snapshot must be ReviewerSnapshot")
    findings = []
    for item in snapshot.findings:
        if item.get("status", "open") != "open" or item.get("severity") not in {
            "critical",
            "high",
            "medium",
        }:
            continue
        finding_id = item["id"]
        severity = item["severity"]
        findings.append(
            RepairFinding(
                id=finding_id,
                severity=severity,
                title=_bounded_string(item.get("title"), fallback="Review finding", limit=240),
                file=_bounded_string(item.get("file"), fallback="unknown", limit=500),
                start_line=_positive_int_or_none(item.get("start_line")),
                end_line=_positive_int_or_none(item.get("end_line")),
                description=_bounded_string(item.get("description"), fallback="", limit=1800),
            )
        )
    return tuple(findings)


def _bounded_string(value: Any, *, fallback: str, limit: int) -> str:
    if not isinstance(value, str):
        return fallback
    compact = " ".join(value.split())
    if not compact:
        return fallback
    return compact[:limit]


def _positive_int_or_none(value: Any) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return value
    return None


def tracked_pr_target_failure(state: ForgeFlowState, tracked: TrackedPullRequest) -> str | None:
    if tracked.owner.casefold() != str(state.get("repo_owner") or "").casefold():
        return "PR_REPOSITORY_MISMATCH"
    if tracked.repo.casefold() != str(state.get("repo_name") or "").casefold():
        return "PR_REPOSITORY_MISMATCH"
    expected_base = state.get("base_ref")
    if expected_base and tracked.base_ref and tracked.base_ref != expected_base:
        return "PR_BASE_MISMATCH"
    return None


def pull_request_target_failure(
    state: ForgeFlowState, authoritative_pr: PullRequestEvidence
) -> str | None:
    if authoritative_pr.owner.casefold() != str(state.get("repo_owner") or "").casefold():
        return "PR_REPOSITORY_MISMATCH"
    if authoritative_pr.repo.casefold() != str(state.get("repo_name") or "").casefold():
        return "PR_REPOSITORY_MISMATCH"
    expected_base = state.get("base_ref")
    if expected_base and authoritative_pr.base_ref != expected_base:
        return "PR_BASE_MISMATCH"
    return None


def _parse_github_pr_url(url: str) -> tuple[str, str, int] | None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.netloc.casefold() != "github.com":
        return None
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) != 4 or parts[2] != "pull":
        return None
    try:
        number = int(parts[3])
    except ValueError:
        return None
    if number <= 0:
        return None
    return parts[0], parts[1], number
