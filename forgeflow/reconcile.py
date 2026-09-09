"""Replay-safe ForgeFlow policy reconciler.

Each invocation re-observes Open SWE/GitHub evidence and performs at most one
ForgeFlow-owned upstream action (create/adopt scheduling, child dispatch, review
dispatch, or terminal schedule cleanup). LangGraph remains the durable runtime.
"""

from collections.abc import Mapping
from copy import deepcopy
from typing import Any, Protocol

from langgraph_sdk import get_client
from langgraph_sdk.errors import NotFoundError

from forgeflow.adapters.github import (
    CiSignals,
    PullRequestEvidence,
    fetch_ci_signals,
    fetch_pull_request,
    preflight_github_repository,
)
from forgeflow.adapters.openswe import (
    ChildRunSnapshot,
    OpenSweChildRuntime,
    OpenSweReviewerRuntime,
    ReviewerSnapshot,
    ThreadSnapshot,
)
from forgeflow.evidence import (
    EvidenceViolation,
    blocking_repair_findings,
    ci_decision,
    implementation_evidence,
    review_decision,
    tracked_pull_request,
)
from forgeflow.models import RepositoryPolicy, RepositoryPreflight
from forgeflow.policy import (
    apply_ci_decision,
    apply_implementation_evidence,
    apply_review_decision,
    cancel,
    escalate,
    mark_repair_dispatched,
    mark_repair_run_terminal,
    mark_run_terminal,
    note_child_run_failure,
    note_reviewer_run_failure,
    observe_external_head,
    start_implementation,
)
from forgeflow.prompts.repair import build_ci_repair_prompt, build_review_repair_prompt
from forgeflow.state import TERMINAL_STATUSES, ForgeFlowState

_RECONCILE_CRON_KIND = "forgeflow_reconcile"
_RECONCILE_SCHEDULE = "* * * * *"
_PENDING_RUN_STATUSES = frozenset({"pending", "running"})
_FAILED_RUN_STATUSES = frozenset({"error", "timeout", "interrupted"})


class ReconcileError(RuntimeError):
    """ForgeFlow cannot safely reconcile because required identity is missing."""


class PolicyServices(Protocol):
    async def ensure_reconcile_cron(self, policy_thread_id: str) -> str: ...

    async def delete_reconcile_cron(self, cron_id: str) -> None: ...

    async def preflight_repository(self, state: ForgeFlowState) -> RepositoryPreflight: ...

    async def ensure_implementation_thread(
        self, *, policy_thread_id: str, repo_owner: str, repo_name: str, objective: str
    ) -> str: ...

    async def find_child_run(self, *, thread_id: str, operation_key: str) -> str | None: ...

    async def dispatch_implementation(
        self,
        *,
        thread_id: str,
        objective: str,
        repo_owner: str,
        repo_name: str,
        operation_key: str,
        workspace_path: str | None,
    ) -> str: ...

    async def dispatch_repair(
        self,
        *,
        thread_id: str,
        prompt: str,
        repo_owner: str,
        repo_name: str,
        operation_key: str,
        workspace_path: str | None,
    ) -> str: ...

    async def read_child_run(self, *, thread_id: str, run_id: str) -> ChildRunSnapshot: ...

    async def read_implementation_thread(self, thread_id: str) -> ThreadSnapshot: ...

    async def fetch_pr(self, pr_url: str) -> PullRequestEvidence | None: ...

    async def fetch_ci(self, pr: PullRequestEvidence) -> CiSignals | None: ...

    def repository_policy(self, state: ForgeFlowState) -> RepositoryPolicy: ...

    async def find_current_review(
        self, *, pr_url: str, expected_head_sha: str
    ) -> tuple[str, str] | None: ...

    async def trigger_review(self, pr_url: str) -> tuple[str, str]: ...

    async def read_review(self, *, thread_id: str, run_id: str) -> ReviewerSnapshot: ...


class DefaultPolicyServices:
    """Production adapter composed entirely from LangGraph/Open SWE primitives."""

    def __init__(self, client: Any | None = None) -> None:
        self.client = client or get_client()
        self.child = OpenSweChildRuntime(self.client)
        self.reviewer = OpenSweReviewerRuntime(self.client)

    async def ensure_reconcile_cron(self, policy_thread_id: str) -> str:
        metadata = {"kind": _RECONCILE_CRON_KIND, "policy_thread_id": policy_thread_id}
        crons = await self.client.crons.search(
            thread_id=policy_thread_id,
            metadata=metadata,
            enabled=True,
            limit=20,
        )
        ids = [_cron_id(cron) for cron in crons]
        ids = [cron_id for cron_id in ids if cron_id]
        unique = list(dict.fromkeys(ids))
        if len(unique) > 1:
            raise ReconcileError(f"multiple ForgeFlow reconcile crons for {policy_thread_id}: {unique}")
        if unique:
            return unique[0]
        cron = await self.client.crons.create_for_thread(
            policy_thread_id,
            "forgeflow",
            schedule=_RECONCILE_SCHEDULE,
            input={},
            metadata=metadata,
            config={
                "configurable": {
                    "thread_id": policy_thread_id,
                    "source": "forgeflow-reconcile",
                }
            },
            multitask_strategy="reject",
        )
        cron_id = _cron_id(cron)
        if not cron_id:
            raise ReconcileError("LangGraph cron creation returned no cron_id")
        return cron_id

    async def delete_reconcile_cron(self, cron_id: str) -> None:
        try:
            await self.client.crons.delete(cron_id)
        except NotFoundError:
            return

    async def preflight_repository(self, state: ForgeFlowState) -> RepositoryPreflight:
        return await preflight_github_repository(
            _required(state, "repo_owner"), _required(state, "repo_name")
        )

    async def ensure_implementation_thread(
        self, *, policy_thread_id: str, repo_owner: str, repo_name: str, objective: str
    ) -> str:
        return await self.child.ensure_implementation_thread(
            policy_thread_id=policy_thread_id,
            repo_owner=repo_owner,
            repo_name=repo_name,
            objective=objective,
        )

    async def find_child_run(self, *, thread_id: str, operation_key: str) -> str | None:
        return await self.child.find_run_by_operation(
            thread_id=thread_id, operation_key=operation_key
        )

    async def dispatch_implementation(
        self,
        *,
        thread_id: str,
        objective: str,
        repo_owner: str,
        repo_name: str,
        operation_key: str,
        workspace_path: str | None,
    ) -> str:
        return await self.child.dispatch_implementation(
            thread_id=thread_id,
            objective=objective,
            repo_owner=repo_owner,
            repo_name=repo_name,
            operation_key=operation_key,
            workspace_path=workspace_path,
        )

    async def dispatch_repair(
        self,
        *,
        thread_id: str,
        prompt: str,
        repo_owner: str,
        repo_name: str,
        operation_key: str,
        workspace_path: str | None,
    ) -> str:
        return await self.child.dispatch_repair(
            thread_id=thread_id,
            prompt=prompt,
            repo_owner=repo_owner,
            repo_name=repo_name,
            operation_key=operation_key,
            workspace_path=workspace_path,
        )

    async def read_child_run(self, *, thread_id: str, run_id: str) -> ChildRunSnapshot:
        return await self.child.read_run(thread_id=thread_id, run_id=run_id)

    async def read_implementation_thread(self, thread_id: str) -> ThreadSnapshot:
        return await self.child.read_thread(thread_id)

    async def fetch_pr(self, pr_url: str) -> PullRequestEvidence | None:
        return await fetch_pull_request(pr_url)

    async def fetch_ci(self, pr: PullRequestEvidence) -> CiSignals | None:
        return await fetch_ci_signals(pr)

    def repository_policy(self, state: ForgeFlowState) -> RepositoryPolicy:
        # V1 defaults fail-closed on CI. Per-repository overrides are a later
        # configuration surface, not another persistence system.
        return RepositoryPolicy(ci_required=True)

    async def find_current_review(
        self, *, pr_url: str, expected_head_sha: str
    ) -> tuple[str, str] | None:
        return await self.reviewer.find_current_review(
            pr_url=pr_url, expected_head_sha=expected_head_sha
        )

    async def trigger_review(self, pr_url: str) -> tuple[str, str]:
        return await self.reviewer.trigger_review(pr_url)

    async def read_review(self, *, thread_id: str, run_id: str) -> ReviewerSnapshot:
        return await self.reviewer.read_review(thread_id=thread_id, run_id=run_id)


async def reconcile_once(
    raw_state: ForgeFlowState,
    *,
    policy_thread_id: str,
    services: PolicyServices,
) -> ForgeFlowState:
    """Reconcile one bounded policy step against current external evidence."""
    state = _normalize_state(raw_state)
    if not policy_thread_id:
        raise ReconcileError("policy thread_id is required")

    if state.get("cancel_requested") and state["status"] not in TERMINAL_STATUSES:
        result = cancel(state)
        result["cancel_requested"] = False
        return result

    if state["status"] in TERMINAL_STATUSES:
        cron_id = state.get("reconcile_cron_id")
        if cron_id:
            await services.delete_reconcile_cron(cron_id)
            result = deepcopy(state)
            result["reconcile_cron_id"] = None
            return result
        return state

    if not state.get("reconcile_cron_id"):
        cron_id = await services.ensure_reconcile_cron(policy_thread_id)
        result = deepcopy(state)
        result["reconcile_cron_id"] = cron_id
        return result

    status = state["status"]
    if status == "NEW":
        return await _reconcile_new(state, policy_thread_id, services)
    if status == "IMPLEMENTING":
        return await _reconcile_implementation_run(state, policy_thread_id, services)
    if status == "VERIFYING":
        return await _reconcile_implementation_evidence(state, services)
    if status == "WAITING_FOR_CI":
        return await _reconcile_ci(state, services)
    if status == "REVIEWING":
        return await _reconcile_review(state, services)
    if status == "REPAIRING":
        return await _reconcile_repair(state, policy_thread_id, services)
    raise ReconcileError(f"unsupported policy status: {status}")


async def _reconcile_new(
    state: ForgeFlowState, policy_thread_id: str, services: PolicyServices
) -> ForgeFlowState:
    preflight = await services.preflight_repository(state)
    if preflight.status == "CONFIG_MISSING":
        return escalate(state, "GITHUB_APP_NOT_CONFIGURED")
    if preflight.status != "READY":
        result = deepcopy(state)
        result["last_failure_code"] = "GITHUB_APP_REPO_OR_PERMISSION_UNAVAILABLE"
        return result

    thread_id = state.get("implementation_thread_id")
    if not thread_id:
        thread_id = await services.ensure_implementation_thread(
            policy_thread_id=policy_thread_id,
            repo_owner=_required(state, "repo_owner"),
            repo_name=_required(state, "repo_name"),
            objective=_required(state, "objective"),
        )
        result = deepcopy(state)
        result["implementation_thread_id"] = thread_id
        return result
    return await _adopt_or_dispatch_initial(state, policy_thread_id, services)


async def _reconcile_implementation_run(
    state: ForgeFlowState, policy_thread_id: str, services: PolicyServices
) -> ForgeFlowState:
    if not state.get("implementation_run_id"):
        return await _adopt_or_dispatch_initial(state, policy_thread_id, services)
    thread_id = _required(state, "implementation_thread_id")
    run_id = _required(state, "implementation_run_id")
    snapshot = await services.read_child_run(thread_id=thread_id, run_id=run_id)
    if snapshot.status in _PENDING_RUN_STATUSES:
        return state
    if snapshot.status == "success":
        return mark_run_terminal(state)
    return note_child_run_failure(state, f"CHILD_RUN_{snapshot.status.upper()}")


async def _adopt_or_dispatch_initial(
    state: ForgeFlowState, policy_thread_id: str, services: PolicyServices
) -> ForgeFlowState:
    thread_id = _required(state, "implementation_thread_id")
    operation_key = _implementation_operation_key(policy_thread_id, state)
    run_id = await services.find_child_run(thread_id=thread_id, operation_key=operation_key)
    if run_id is None:
        run_id = await services.dispatch_implementation(
            thread_id=thread_id,
            objective=_required(state, "objective"),
            repo_owner=_required(state, "repo_owner"),
            repo_name=_required(state, "repo_name"),
            operation_key=operation_key,
            workspace_path=state.get("workspace_path"),
        )
    result = start_implementation(state) if state["status"] == "NEW" else deepcopy(state)
    result["implementation_run_id"] = run_id
    result["implementation_phase"] = "INITIAL"
    return result


async def _reconcile_implementation_evidence(
    state: ForgeFlowState, services: PolicyServices
) -> ForgeFlowState:
    thread_id = state.get("implementation_thread_id")
    if not thread_id:
        return escalate(state, "IMPLEMENTATION_THREAD_MISSING")
    thread = await services.read_implementation_thread(thread_id)
    tracked = tracked_pull_request(thread.metadata)
    if tracked is None:
        evidence = implementation_evidence(
            state,
            run_status="success",
            tracked_pr=None,
            authoritative_pr=None,
        )
        return apply_implementation_evidence(state, evidence)

    target_pr = state.get("pr_url")
    if target_pr and target_pr != tracked.url:
        evidence = implementation_evidence(
            state,
            run_status="success",
            tracked_pr=tracked,
            authoritative_pr=None,
        )
        evidence = evidence.__class__(
            pr_url="",
            pr_number=0,
            head_sha="",
            progressed=False,
            failure_code="PR_TARGET_CHANGED",
        )
        return apply_implementation_evidence(state, evidence)

    authoritative = await services.fetch_pr(tracked.url)
    if authoritative is None:
        result = deepcopy(state)
        result["last_failure_code"] = "PR_EVIDENCE_UNAVAILABLE"
        return result
    evidence = implementation_evidence(
        state,
        run_status="success",
        tracked_pr=tracked,
        authoritative_pr=authoritative,
    )
    return apply_implementation_evidence(state, evidence)


async def _reconcile_ci(state: ForgeFlowState, services: PolicyServices) -> ForgeFlowState:
    pr_url = state.get("pr_url")
    if not pr_url:
        return escalate(state, "PR_URL_MISSING")
    pr = await services.fetch_pr(pr_url)
    if pr is None:
        result = deepcopy(state)
        result["last_failure_code"] = "PR_EVIDENCE_UNAVAILABLE"
        return result
    if pr.head_sha != state.get("observed_head_sha"):
        return observe_external_head(state, pr.head_sha)
    signals = await services.fetch_ci(pr)
    if signals is None:
        result = deepcopy(state)
        result["last_failure_code"] = "CI_EVIDENCE_UNAVAILABLE"
        return result
    decision = ci_decision(signals, services.repository_policy(state))
    return apply_ci_decision(state, decision)


async def _reconcile_review(state: ForgeFlowState, services: PolicyServices) -> ForgeFlowState:
    pr_url = state.get("pr_url")
    head_sha = state.get("observed_head_sha")
    if not pr_url or not head_sha:
        return escalate(state, "REVIEW_IDENTITY_MISSING")

    pr = await services.fetch_pr(pr_url)
    if pr is None:
        result = deepcopy(state)
        result["last_failure_code"] = "PR_EVIDENCE_UNAVAILABLE"
        return result
    if pr.head_sha != head_sha:
        return observe_external_head(state, pr.head_sha)

    run_id = state.get("reviewer_run_id")
    retry_pending = state.get("reviewer_retry_pending", False)
    if not run_id or retry_pending:
        existing = await services.find_current_review(pr_url=pr_url, expected_head_sha=head_sha)
        if existing is not None and (not retry_pending or existing[1] != run_id):
            result = deepcopy(state)
            result["reviewer_thread_id"], result["reviewer_run_id"] = existing
            result["reviewer_retry_pending"] = False
            result["last_failure_code"] = None
            return result
        thread_id, new_run_id = await services.trigger_review(pr_url)
        result = deepcopy(state)
        result["reviewer_thread_id"] = thread_id
        result["reviewer_run_id"] = new_run_id
        result["reviewer_retry_pending"] = False
        result["last_failure_code"] = None
        return result

    reviewer_thread_id = state.get("reviewer_thread_id")
    if not reviewer_thread_id:
        return escalate(state, "REVIEWER_THREAD_MISSING")
    snapshot = await services.read_review(thread_id=reviewer_thread_id, run_id=run_id)
    if snapshot.run_status in _PENDING_RUN_STATUSES:
        return state
    if snapshot.run_status != "success":
        return note_reviewer_run_failure(state, f"REVIEWER_RUN_{snapshot.run_status.upper()}")
    try:
        decision = review_decision(snapshot, expected_head_sha=head_sha)
    except EvidenceViolation:
        return note_reviewer_run_failure(state, "REVIEWER_EVIDENCE_STALE")
    return apply_review_decision(state, decision)


async def _reconcile_repair(
    state: ForgeFlowState, policy_thread_id: str, services: PolicyServices
) -> ForgeFlowState:
    thread_id = state.get("implementation_thread_id")
    pr_url = state.get("pr_url")
    rejected_head = state.get("observed_head_sha")
    if not thread_id or not pr_url or not rejected_head:
        return escalate(state, "REPAIR_IDENTITY_MISSING")

    run_id = state.get("implementation_run_id")
    if not run_id:
        fresh_repair = state.get("run_retry_count", 0) == 0
        operation_key = _repair_operation_key(policy_thread_id, state, fresh=fresh_repair)
        run_id = await services.find_child_run(thread_id=thread_id, operation_key=operation_key)
        if run_id is None:
            prompt = await _repair_prompt(state, services)
            run_id = await services.dispatch_repair(
                thread_id=thread_id,
                prompt=prompt,
                repo_owner=_required(state, "repo_owner"),
                repo_name=_required(state, "repo_name"),
                operation_key=operation_key,
                workspace_path=state.get("workspace_path"),
            )
        result = mark_repair_dispatched(state) if fresh_repair else deepcopy(state)
        result["implementation_run_id"] = run_id
        result["implementation_phase"] = "REPAIR"
        return result

    snapshot = await services.read_child_run(thread_id=thread_id, run_id=run_id)
    if snapshot.status in _PENDING_RUN_STATUSES:
        return state
    if snapshot.status == "success":
        result = mark_repair_run_terminal(state)
        result["last_failure_code"] = None
        return result
    return note_child_run_failure(state, f"REPAIR_RUN_{snapshot.status.upper()}")


async def _repair_prompt(state: ForgeFlowState, services: PolicyServices) -> str:
    pr_url = _required(state, "pr_url")
    rejected_head = _required(state, "observed_head_sha")
    if state.get("blocking_finding_ids"):
        reviewer_thread_id = state.get("reviewer_thread_id")
        reviewer_run_id = state.get("reviewer_run_id")
        if not reviewer_thread_id or not reviewer_run_id:
            raise ReconcileError("blocking review repair is missing reviewer identity")
        snapshot = await services.read_review(
            thread_id=reviewer_thread_id,
            run_id=reviewer_run_id,
        )
        findings = blocking_repair_findings(snapshot, expected_head_sha=rejected_head)
        if not findings:
            raise ReconcileError("blocking review state has no current repair findings")
        return build_review_repair_prompt(
            pr_url=pr_url,
            rejected_head_sha=rejected_head,
            findings=findings,
        )
    return build_ci_repair_prompt(
        pr_url=pr_url,
        rejected_head_sha=rejected_head,
        failure_code=str(state.get("last_failure_code") or "CI_FAILED"),
    )


def _implementation_operation_key(policy_thread_id: str, state: ForgeFlowState) -> str:
    return f"implementation:{policy_thread_id}:retry:{state.get('run_retry_count', 0)}"


def _repair_operation_key(
    policy_thread_id: str, state: ForgeFlowState, *, fresh: bool
) -> str:
    round_number = state.get("repair_round", 0) + (1 if fresh else 0)
    head_sha = state.get("observed_head_sha") or "missing-head"
    retry = state.get("run_retry_count", 0)
    return f"repair:{policy_thread_id}:{head_sha}:round:{round_number}:retry:{retry}"


def _normalize_state(raw: ForgeFlowState) -> ForgeFlowState:
    state = deepcopy(raw)
    state.setdefault("status", "NEW")
    state.setdefault("run_retry_count", 0)
    state.setdefault("repair_round", 0)
    state.setdefault("reviewer_retry_count", 0)
    state.setdefault("reviewer_retry_pending", False)
    state.setdefault("blocking_finding_ids", [])
    state.setdefault("last_failure_code", None)
    state.setdefault("cancel_requested", False)
    return state


def _required(state: ForgeFlowState, key: str) -> Any:
    value = state.get(key)  # type: ignore[literal-required]
    if value is None or value == "":
        raise ReconcileError(f"required policy field is missing: {key}")
    return value


def _cron_id(cron: Any) -> str | None:
    value = cron.get("cron_id") if isinstance(cron, Mapping) else getattr(cron, "cron_id", None)
    return value if isinstance(value, str) and value else None
