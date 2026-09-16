"""Pure ForgeFlow quality-policy transitions.

No network, model, filesystem, Git, database, or Open SWE calls belong here.
"""

from copy import deepcopy

from forgeflow.models import CiDecision, FindingSeverity, ImplementationEvidence, ReviewDecision
from forgeflow.state import (
    ALLOWED_SUCCESSORS,
    DEFAULT_BUDGET,
    TERMINAL_STATUSES,
    ForgeFlowState,
    PolicyBudget,
    PolicyStatus,
)

SEVERITY_MAP: dict[FindingSeverity, str] = {
    "critical": "P0",
    "high": "P1",
    "medium": "P2",
    "low": "P3",
}
BLOCKING_SEVERITIES = frozenset({"critical", "high", "medium"})


class PolicyViolation(ValueError):
    """The caller attempted a transition without required authoritative evidence."""


def start_implementation(state: ForgeFlowState) -> ForgeFlowState:
    return _transition(state, "IMPLEMENTING")


def mark_run_terminal(state: ForgeFlowState) -> ForgeFlowState:
    return _transition(state, "VERIFYING")


def apply_implementation_evidence(
    state: ForgeFlowState,
    evidence: ImplementationEvidence,
    *,
    budget: PolicyBudget = DEFAULT_BUDGET,
) -> ForgeFlowState:
    _require_status(state, "VERIFYING")
    if not evidence.progressed:
        retry_count = state.get("run_retry_count", 0) + 1
        if retry_count > budget.no_progress_retries:
            return _escalated(state, evidence.failure_code or "NO_PROGRESS_RETRY_EXHAUSTED")
        retry_target = "REPAIRING" if state.get("implementation_phase") == "REPAIR" else "IMPLEMENTING"
        result = _transition(state, retry_target)
        result["implementation_run_id"] = None
        result["implementation_operation_key"] = None
        result["run_retry_count"] = retry_count
        result["last_failure_code"] = evidence.failure_code or "NO_PROGRESS"
        return result

    if not evidence.pr_url or evidence.pr_number <= 0 or not evidence.head_sha:
        raise PolicyViolation("progress evidence requires PR URL, PR number, and head SHA")

    previous_head = state.get("observed_head_sha")
    result = _transition(state, "WAITING_FOR_CI")
    result["pr_url"] = evidence.pr_url
    result["pr_number"] = evidence.pr_number
    result["observed_head_sha"] = evidence.head_sha
    result["run_retry_count"] = 0
    result["resource_retry_count"] = 0
    result["resource_wait_count"] = 0
    result["resource_resume_status"] = None
    result["last_failure_code"] = None
    if previous_head != evidence.head_sha:
        _invalidate_exact_head_evidence(result)
    return result


def apply_ci_decision(
    state: ForgeFlowState,
    decision: CiDecision,
    *,
    budget: PolicyBudget = DEFAULT_BUDGET,
) -> ForgeFlowState:
    _require_status(state, "WAITING_FOR_CI")
    _require_current_head(state, decision.head_sha)
    if decision.status in {"PENDING", "UNRESOLVED"}:
        result = deepcopy(state)
        result["last_failure_code"] = decision.failure_code
        return result
    if decision.status == "FAIL":
        if state.get("repair_round", 0) >= budget.repair_rounds:
            return _escalated(state, decision.failure_code or "REPAIR_BUDGET_EXHAUSTED")
        result = _transition(state, "REPAIRING")
        result["implementation_run_id"] = None
        result["implementation_operation_key"] = None
        result["last_failure_code"] = decision.failure_code or "CI_FAILED"
        return result

    result = _transition(state, "REVIEWING")
    result["ci_head_sha"] = decision.head_sha
    result["last_failure_code"] = None
    return result


def apply_review_decision(
    state: ForgeFlowState,
    decision: ReviewDecision,
    *,
    budget: PolicyBudget = DEFAULT_BUDGET,
) -> ForgeFlowState:
    _require_status(state, "REVIEWING")
    _require_current_head(state, decision.head_sha)
    if state.get("ci_head_sha") != decision.head_sha:
        raise PolicyViolation("review cannot pass without CI evidence for the same exact head")

    blocking = [
        finding.id
        for finding in decision.findings
        if finding.status == "open" and finding.severity in BLOCKING_SEVERITIES
    ]
    result = deepcopy(state)
    result["resource_retry_count"] = 0
    result["resource_wait_count"] = 0
    result["resource_resume_status"] = None
    result["reviewer_thread_id"] = decision.reviewer_thread_id
    result["reviewer_run_id"] = decision.reviewer_run_id
    result["reviewed_head_sha"] = decision.head_sha
    result["blocking_finding_ids"] = blocking

    if blocking:
        if state.get("repair_round", 0) >= budget.repair_rounds:
            return _escalated(result, "REPAIR_BUDGET_EXHAUSTED")
        result = _transition(result, "REPAIRING")
        result["implementation_run_id"] = None
        result["implementation_operation_key"] = None
        result["last_failure_code"] = "REVIEW_BLOCKED"
        return result

    result = _transition(result, "READY")
    result["reviewer_retry_count"] = 0
    result["reviewer_retry_pending"] = False
    result["last_failure_code"] = None
    return result


def mark_repair_dispatched(
    state: ForgeFlowState,
    *,
    budget: PolicyBudget = DEFAULT_BUDGET,
) -> ForgeFlowState:
    _require_status(state, "REPAIRING")
    next_round = state.get("repair_round", 0) + 1
    if next_round > budget.repair_rounds:
        return _escalated(state, "REPAIR_BUDGET_EXHAUSTED")
    result = deepcopy(state)
    result["repair_round"] = next_round
    return result


def mark_repair_run_terminal(state: ForgeFlowState) -> ForgeFlowState:
    return _transition(state, "VERIFYING")



def note_child_run_failure(
    state: ForgeFlowState,
    failure_code: str,
    *,
    budget: PolicyBudget = DEFAULT_BUDGET,
) -> ForgeFlowState:
    current = state.get("status", "NEW")
    if current not in {"IMPLEMENTING", "REPAIRING"}:
        raise PolicyViolation(f"child-run failure is invalid in {current}")
    retry_count = state.get("run_retry_count", 0) + 1
    if retry_count > budget.transient_run_retries:
        return _escalated(state, failure_code or "RUN_RETRY_EXHAUSTED")
    result = deepcopy(state)
    result["implementation_run_id"] = None
    result["implementation_operation_key"] = None
    result["run_retry_count"] = retry_count
    result["last_failure_code"] = failure_code
    return result


def enter_resource_wait(
    state: ForgeFlowState,
    failure_code: str,
    *,
    resume_status: str | None = None,
) -> ForgeFlowState:
    """Park a retryable resource outage without consuming engineering repair budget.

    The policy cron remains live. Each outage increases a separate resource retry
    epoch used for bounded exponential backoff and operation-key uniqueness.
    """
    current = state.get("status", "NEW")
    resolved_resume = resume_status or current
    if resolved_resume not in {"NEW", "IMPLEMENTING", "REPAIRING", "REVIEWING"}:
        raise PolicyViolation(f"resource wait cannot resume {resolved_resume}")
    if current == "ESCALATED":
        # Operator recovery is intentionally the only escape hatch from an
        # escalated resource outage. Do not broaden ALLOWED_SUCCESSORS for all
        # terminal failures.
        result = deepcopy(state)
        result["status"] = "WAITING_FOR_RESOURCE"
    else:
        result = _transition(state, "WAITING_FOR_RESOURCE")
    result["resource_resume_status"] = resolved_resume
    result["resource_retry_count"] = state.get("resource_retry_count", 0) + 1
    result["resource_wait_count"] = 0
    result["last_failure_code"] = failure_code or "RESOURCE_UNAVAILABLE"
    result["implementation_run_id"] = None
    result["implementation_operation_key"] = None
    if resolved_resume == "REVIEWING":
        result["reviewer_run_id"] = None
        result["reviewer_retry_pending"] = True
    return result


def resource_backoff_minutes(
    state: ForgeFlowState, *, budget: PolicyBudget = DEFAULT_BUDGET
) -> int:
    retries = max(1, state.get("resource_retry_count", 1))
    delay = 2 ** min(retries - 1, 5)
    return min(delay, budget.resource_backoff_cap_minutes)


def tick_resource_wait(
    state: ForgeFlowState, *, budget: PolicyBudget = DEFAULT_BUDGET
) -> ForgeFlowState:
    _require_status(state, "WAITING_FOR_RESOURCE")
    resume = state.get("resource_resume_status")
    if resume not in {"NEW", "IMPLEMENTING", "REPAIRING", "REVIEWING"}:
        return _escalated(state, "RESOURCE_RESUME_STATUS_MISSING")
    elapsed = state.get("resource_wait_count", 0) + 1
    required = resource_backoff_minutes(state, budget=budget)
    if elapsed < required:
        result = deepcopy(state)
        result["resource_wait_count"] = elapsed
        return result
    result = deepcopy(state)
    result["status"] = resume
    result["resource_wait_count"] = 0
    result["last_failure_code"] = None
    if resume == "NEW":
        # Route exhaustion is re-probed from a clean eligibility set after the
        # backoff window; successful routes are still selected deterministically.
        result["implementation_failed_route_ids"] = []
        result["implementation_route_id"] = None
        result["implementation_runtime"] = None
        result["implementation_thread_id"] = None
    return result


def _is_legacy_codebuddy_resource_misclassification(
    state: ForgeFlowState, code: str
) -> bool:
    """Recognize only pre-rate-limit-fix CodeBuddy escalations with zero delivery evidence."""

    if code not in {
        "EXTERNAL_AGENT_STOP_REFUSAL",
        "CODEBUDDY_BOOTSTRAP_SEAL_FAILED",
        "EXTERNAL_AGENT_RESULT_MISSING",
    }:
        return False
    if (
        state.get("implementation_route_id") != "codebuddy-account-primary"
        or state.get("implementation_runtime") != "EXTERNAL_ACP"
    ):
        return False
    return not any(
        (
            state.get("workspace_path"),
            state.get("pr_url"),
            state.get("pr_number"),
            state.get("observed_head_sha"),
            state.get("ci_head_sha"),
            state.get("reviewed_head_sha"),
        )
    )


def recover_resource_escalation(state: ForgeFlowState) -> ForgeFlowState:
    """Explicitly recover only escalations known to be resource availability failures."""
    _require_status(state, "ESCALATED")
    code = state.get("last_failure_code") or ""
    legacy_codebuddy = _is_legacy_codebuddy_resource_misclassification(state, code)
    recoverable = {
        "OPENSWE_PROVIDER_UNAVAILABLE",
        "IMPLEMENTATION_ROUTE_UNAVAILABLE",
        "IMPLEMENTATION_ROUTE_EXHAUSTED",
        "REVIEWER_PROVIDER_UNAVAILABLE",
    }
    if code not in recoverable and not legacy_codebuddy:
        raise PolicyViolation(f"escalation is not resource-recoverable: {code or 'unknown'}")
    if legacy_codebuddy:
        # Before the CodeBuddy quota classifier existed, provider refusal was
        # charged to the engineering retry budget as a generic refusal/seal failure.
        # No delivery evidence exists, but deterministic child operation keys from
        # those attempts do. Resume directly at NEW while excluding this failed
        # route so reconciliation cannot re-adopt an old CodeBuddy child run.
        result = deepcopy(state)
        failed = list(
            dict.fromkeys(
                [
                    *state.get("implementation_failed_route_ids", []),
                    "codebuddy-account-primary",
                ]
            )
        )
        result["status"] = "NEW"
        result["implementation_failed_route_ids"] = failed
        result["implementation_route_id"] = None
        result["implementation_runtime"] = None
        result["implementation_thread_id"] = None
        result["implementation_run_id"] = None
        result["implementation_operation_key"] = None
        result["run_retry_count"] = 0
        result["resource_retry_count"] = state.get("resource_retry_count", 0) + 1
        result["resource_wait_count"] = 0
        result["resource_resume_status"] = None
        result["last_failure_code"] = "IMPLEMENTATION_ROUTE_EXHAUSTED"
    else:
        if code in {"IMPLEMENTATION_ROUTE_UNAVAILABLE", "IMPLEMENTATION_ROUTE_EXHAUSTED"}:
            resume = "NEW"
        elif state.get("implementation_phase") == "REPAIR":
            resume = "REPAIRING"
        elif code == "REVIEWER_PROVIDER_UNAVAILABLE":
            resume = "REVIEWING"
        else:
            resume = "IMPLEMENTING"
        result = enter_resource_wait(state, code, resume_status=resume)
    result["recover_requested"] = False
    # The escalated objective may still carry the id of a cron that has already
    # been deleted. Force normal cron discovery/recreation on the recovery run.
    result["reconcile_cron_id"] = None
    return result


def note_reviewer_run_failure(
    state: ForgeFlowState,
    failure_code: str,
    *,
    budget: PolicyBudget = DEFAULT_BUDGET,
) -> ForgeFlowState:
    _require_status(state, "REVIEWING")
    retry_count = state.get("reviewer_retry_count", 0) + 1
    if retry_count > budget.reviewer_retries:
        return _escalated(state, failure_code or "REVIEWER_RETRY_EXHAUSTED")
    result = deepcopy(state)
    result["reviewer_retry_count"] = retry_count
    result["reviewer_retry_pending"] = True
    result["last_failure_code"] = failure_code
    return result


def observe_external_head(state: ForgeFlowState, head_sha: str) -> ForgeFlowState:
    current = state.get("status", "NEW")
    if current not in {"WAITING_FOR_CI", "REVIEWING", "REPAIRING", "READY"}:
        raise PolicyViolation(f"external head observation is invalid in {current}")
    if not head_sha:
        raise PolicyViolation("external head SHA is required")
    if state.get("observed_head_sha") == head_sha:
        return deepcopy(state)
    result = deepcopy(state)
    if current in {"REVIEWING", "REPAIRING", "READY"}:
        result = _transition(result, "WAITING_FOR_CI")
    result["observed_head_sha"] = head_sha
    _invalidate_exact_head_evidence(result)
    result["wait_stage"] = None
    result["wait_count"] = 0
    result["last_failure_code"] = None
    return result


def note_wait(
    state: ForgeFlowState,
    stage: str,
    failure_code: str,
    *,
    limit: int,
) -> ForgeFlowState:
    if limit < 1:
        raise ValueError("wait limit must be positive")
    result = deepcopy(state)
    count = state.get("wait_count", 0) + 1 if state.get("wait_stage") == stage else 1
    if count > limit:
        return _escalated(state, f"{failure_code}_WAIT_EXHAUSTED")
    result["wait_stage"] = stage
    result["wait_count"] = count
    result["last_failure_code"] = failure_code
    return result


def clear_wait(state: ForgeFlowState) -> ForgeFlowState:
    result = deepcopy(state)
    result["wait_stage"] = None
    result["wait_count"] = 0
    return result

def cancel(state: ForgeFlowState) -> ForgeFlowState:
    if state.get("status", "NEW") in TERMINAL_STATUSES:
        return deepcopy(state)
    return _transition(state, "CANCELLED")


def escalate(state: ForgeFlowState, failure_code: str) -> ForgeFlowState:
    if state.get("status", "NEW") in TERMINAL_STATUSES:
        return deepcopy(state)
    return _escalated(state, failure_code)


def severity_to_policy(severity: FindingSeverity) -> str:
    return SEVERITY_MAP[severity]


def _transition(state: ForgeFlowState, target: PolicyStatus) -> ForgeFlowState:
    current = state.get("status", "NEW")
    if target not in ALLOWED_SUCCESSORS[current]:
        raise PolicyViolation(f"invalid policy transition: {current} -> {target}")
    result = deepcopy(state)
    result["status"] = target
    return result


def _escalated(state: ForgeFlowState, failure_code: str) -> ForgeFlowState:
    result = _transition(state, "ESCALATED")
    result["last_failure_code"] = failure_code
    return result


def _require_status(state: ForgeFlowState, expected: PolicyStatus) -> None:
    actual = state.get("status", "NEW")
    if actual != expected:
        raise PolicyViolation(f"expected {expected}, got {actual}")


def _require_current_head(state: ForgeFlowState, head_sha: str) -> None:
    if not head_sha or state.get("observed_head_sha") != head_sha:
        raise PolicyViolation("evidence is stale or missing for the current PR head")


def _invalidate_exact_head_evidence(state: ForgeFlowState) -> None:
    state["ci_head_sha"] = None
    state["reviewed_head_sha"] = None
    state["reviewer_run_id"] = None
    state["reviewer_retry_count"] = 0
    state["reviewer_retry_pending"] = False
    state["blocking_finding_ids"] = []
