"""Durable ForgeFlow policy state: references and normalized evidence only."""

from dataclasses import dataclass
from typing import Literal, TypedDict

PolicyStatus = Literal[
    "NEW",
    "IMPLEMENTING",
    "VERIFYING",
    "WAITING_FOR_CI",
    "REVIEWING",
    "REPAIRING",
    "WAITING_FOR_RESOURCE",
    "READY",
    "ESCALATED",
    "CANCELLED",
]

ResourceResumeStatus = Literal["NEW", "IMPLEMENTING", "REPAIRING", "REVIEWING"]

TERMINAL_STATUSES: frozenset[PolicyStatus] = frozenset({"ESCALATED", "CANCELLED"})

ALLOWED_SUCCESSORS: dict[PolicyStatus, frozenset[PolicyStatus]] = {
    "NEW": frozenset({"IMPLEMENTING", "WAITING_FOR_RESOURCE", "CANCELLED", "ESCALATED"}),
    "IMPLEMENTING": frozenset(
        {"VERIFYING", "WAITING_FOR_RESOURCE", "ESCALATED", "CANCELLED"}
    ),
    "VERIFYING": frozenset(
        {"IMPLEMENTING", "REPAIRING", "WAITING_FOR_CI", "ESCALATED", "CANCELLED"}
    ),
    "WAITING_FOR_CI": frozenset(
        {"REVIEWING", "REPAIRING", "ESCALATED", "CANCELLED"}
    ),
    "REVIEWING": frozenset(
        {"WAITING_FOR_CI", "REPAIRING", "WAITING_FOR_RESOURCE", "READY", "ESCALATED", "CANCELLED"}
    ),
    "REPAIRING": frozenset(
        {"VERIFYING", "WAITING_FOR_CI", "WAITING_FOR_RESOURCE", "ESCALATED", "CANCELLED"}
    ),
    "WAITING_FOR_RESOURCE": frozenset(
        {"NEW", "IMPLEMENTING", "REPAIRING", "REVIEWING", "ESCALATED", "CANCELLED"}
    ),
    "READY": frozenset({"WAITING_FOR_CI", "CANCELLED", "ESCALATED"}),
    # ESCALATED remains terminal for automatic scheduling. A deliberate operator
    # recovery command may re-enter WAITING_FOR_RESOURCE through the dedicated
    # recovery transition in policy.py without making arbitrary escalation
    # states resumable.
    "ESCALATED": frozenset(),
    "CANCELLED": frozenset(),
}


class ForgeFlowInput(TypedDict, total=False):
    """Untrusted graph input. Lifecycle/evidence fields are deliberately excluded."""

    objective: str
    repo_owner: str
    repo_name: str
    base_ref: str
    workspace_path: str | None
    preferred_implementation_route_id: str | None
    cancel_requested: bool
    recover_requested: bool


class ForgeFlowState(TypedDict, total=False):
    objective: str
    repo_owner: str
    repo_name: str
    base_ref: str
    workspace_path: str | None
    preferred_implementation_route_id: str | None
    implementation_route_id: str
    implementation_runtime: Literal["OPEN_SWE", "EXTERNAL_ACP"]
    implementation_failed_route_ids: list[str]
    implementation_thread_id: str
    implementation_run_id: str | None
    implementation_operation_key: str | None
    implementation_phase: Literal["INITIAL", "REPAIR"]
    pr_url: str | None
    pr_number: int
    observed_head_sha: str
    ci_head_sha: str | None
    reviewer_thread_id: str | None
    reviewer_run_id: str | None
    reviewer_retry_count: int
    reviewer_retry_pending: bool
    reviewed_head_sha: str | None
    run_retry_count: int
    repair_round: int
    blocking_finding_ids: list[str]
    last_failure_code: str | None
    wait_stage: str | None
    wait_count: int
    resource_resume_status: ResourceResumeStatus | None
    resource_retry_count: int
    resource_wait_count: int
    reconcile_cron_id: str | None
    cancel_requested: bool
    recover_requested: bool
    status: PolicyStatus


@dataclass(frozen=True, slots=True)
class PolicyBudget:
    transient_run_retries: int = 2
    no_progress_retries: int = 2
    reviewer_retries: int = 2
    repair_rounds: int = 5
    external_evidence_reconciles: int = 10
    ci_pending_reconciles: int = 60
    reviewer_running_reconciles: int = 45
    resource_backoff_cap_minutes: int = 30


DEFAULT_BUDGET = PolicyBudget()


def initial_state(*, objective: str, repo_owner: str, repo_name: str, base_ref: str = "main") -> ForgeFlowState:
    return {
        "objective": objective,
        "repo_owner": repo_owner,
        "repo_name": repo_name,
        "base_ref": base_ref,
        "preferred_implementation_route_id": None,
        "run_retry_count": 0,
        "implementation_failed_route_ids": [],
        "repair_round": 0,
        "reviewer_retry_count": 0,
        "reviewer_retry_pending": False,
        "blocking_finding_ids": [],
        "last_failure_code": None,
        "wait_stage": None,
        "wait_count": 0,
        "resource_resume_status": None,
        "resource_retry_count": 0,
        "resource_wait_count": 0,
        "cancel_requested": False,
        "recover_requested": False,
        "status": "NEW",
    }
