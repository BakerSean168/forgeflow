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
