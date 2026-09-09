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


_SUCCESSFUL_CHECK_CONCLUSIONS = frozenset({"success", "neutral", "skipped"})
_FAILED_CHECK_CONCLUSIONS = frozenset(
    {"failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"}
)


def ci_decision(signals, policy):
    """Normalize GitHub check runs/statuses for one exact head into a deterministic gate."""
    from forgeflow.adapters.github import CiSignals
    from forgeflow.models import CiDecision, RepositoryPolicy

    if not isinstance(signals, CiSignals):
        raise TypeError("signals must be CiSignals")
    if not isinstance(policy, RepositoryPolicy):
        raise TypeError("policy must be RepositoryPolicy")

    named_checks = {
        str(run.get("name")): ("check", run)
        for run in signals.check_runs
        if isinstance(run.get("name"), str) and run.get("name")
    }
    named_statuses = {
        str(status.get("context")): ("status", status)
        for status in signals.statuses
        if isinstance(status.get("context"), str) and status.get("context")
    }
    observed = {**named_checks, **named_statuses}

    if policy.required_checks:
        missing = [name for name in policy.required_checks if name not in observed]
        if missing:
            return CiDecision(
                head_sha=signals.head_sha,
                status="UNRESOLVED",
                failure_code="MISSING_REQUIRED_CHECK:" + ",".join(missing),
            )
        selected = [observed[name] for name in policy.required_checks]
    else:
        selected = list(observed.values())

    if not selected:
        return CiDecision(
            head_sha=signals.head_sha,
            status="UNRESOLVED" if policy.ci_required else "PASS",
            failure_code="NO_CI_SIGNALS" if policy.ci_required else None,
        )

    pending = False
    unresolved = False
    for kind, record in selected:
        if kind == "check":
            status = record.get("status")
            conclusion = record.get("conclusion")
            if status != "completed":
                pending = True
                continue
            if conclusion in _FAILED_CHECK_CONCLUSIONS:
                return CiDecision(
                    head_sha=signals.head_sha,
                    status="FAIL",
                    failure_code=f"CHECK_FAILED:{record.get('name') or 'unknown'}",
                )
            if conclusion not in _SUCCESSFUL_CHECK_CONCLUSIONS:
                unresolved = True
        else:
            state = record.get("state")
            if state == "pending":
                pending = True
            elif state in {"failure", "error"}:
                return CiDecision(
                    head_sha=signals.head_sha,
                    status="FAIL",
                    failure_code=f"STATUS_FAILED:{record.get('context') or 'unknown'}",
                )
            elif state != "success":
                unresolved = True

    if pending:
        return CiDecision(head_sha=signals.head_sha, status="PENDING")
    if unresolved:
        return CiDecision(head_sha=signals.head_sha, status="UNRESOLVED", failure_code="CI_UNRESOLVED")
    return CiDecision(head_sha=signals.head_sha, status="PASS")


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
