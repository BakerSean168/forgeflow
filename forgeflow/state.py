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
    "READY",
    "ESCALATED",
    "CANCELLED",
]

TERMINAL_STATUSES: frozenset[PolicyStatus] = frozenset({"READY", "ESCALATED", "CANCELLED"})

ALLOWED_SUCCESSORS: dict[PolicyStatus, frozenset[PolicyStatus]] = {
    "NEW": frozenset({"IMPLEMENTING", "CANCELLED", "ESCALATED"}),
    "IMPLEMENTING": frozenset({"VERIFYING", "ESCALATED", "CANCELLED"}),
    "VERIFYING": frozenset({"IMPLEMENTING", "REPAIRING", "WAITING_FOR_CI", "ESCALATED", "CANCELLED"}),
    "WAITING_FOR_CI": frozenset({"REVIEWING", "REPAIRING", "ESCALATED", "CANCELLED"}),
    "REVIEWING": frozenset({"WAITING_FOR_CI", "REPAIRING", "READY", "ESCALATED", "CANCELLED"}),
    "REPAIRING": frozenset({"VERIFYING", "ESCALATED", "CANCELLED"}),
    "READY": frozenset(),
    "ESCALATED": frozenset(),
    "CANCELLED": frozenset(),
}


class ForgeFlowState(TypedDict, total=False):
    objective: str
    repo_owner: str
    repo_name: str
    base_ref: str
    implementation_thread_id: str
    implementation_run_id: str | None
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
    reconcile_cron_id: str | None
    cancel_requested: bool
    status: PolicyStatus


@dataclass(frozen=True, slots=True)
class PolicyBudget:
    transient_run_retries: int = 2
    no_progress_retries: int = 2
    reviewer_retries: int = 2
    repair_rounds: int = 5


DEFAULT_BUDGET = PolicyBudget()


def initial_state(*, objective: str, repo_owner: str, repo_name: str, base_ref: str = "main") -> ForgeFlowState:
    return {
        "objective": objective,
        "repo_owner": repo_owner,
        "repo_name": repo_name,
        "base_ref": base_ref,
        "run_retry_count": 0,
        "repair_round": 0,
        "reviewer_retry_count": 0,
        "reviewer_retry_pending": False,
        "blocking_finding_ids": [],
        "last_failure_code": None,
        "status": "NEW",
    }
