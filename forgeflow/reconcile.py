"""Replay-safe ForgeFlow policy reconciler.

Each invocation re-observes Open SWE/GitHub evidence and performs at most one
ForgeFlow-owned upstream action (create/adopt scheduling, child dispatch, review
dispatch, or terminal schedule cleanup). LangGraph remains the durable runtime.
"""

import asyncio
import os
from collections.abc import Mapping
from copy import deepcopy
from pathlib import Path
from typing import Any, Protocol

from langgraph_sdk import get_client
from langgraph_sdk.errors import NotFoundError

from forgeflow.adapters.github import (
    CiSignals,
    CommitEvidence,
    PullRequestEvidence,
    fetch_ci_signals,
    fetch_head_commit,
    fetch_pull_request,
    preflight_github_repository,
)
from forgeflow.adapters.openswe import (
    ChildRunSnapshot,
    OpenSweChildRuntime,
    OpenSweReviewerRuntime,
    ReviewerSnapshot,
    ReviewerSupersededError,
    ThreadSnapshot,
)
from forgeflow.attempts import AttemptLedger, AttemptLedgerError
from forgeflow.deployment import reviewer_sandbox_preflight
from forgeflow.evidence import (
    EvidenceViolation,
    blocking_repair_findings,
    ci_decision,
    implementation_evidence,
    pull_request_target_failure,
    review_decision,
    tracked_pr_target_failure,
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
    note_wait,
    observe_external_head,
    start_implementation,
)
from forgeflow.projects import load_repository_policy
from forgeflow.prompts.implementation import build_implementation_prompt, operation_trailer
from forgeflow.prompts.repair import build_ci_repair_prompt, build_review_repair_prompt
from forgeflow.routing import RouteDefinition, classify_failure_code, load_route_registry
from forgeflow.state import DEFAULT_BUDGET, TERMINAL_STATUSES, ForgeFlowState
from openswe_ext.external_agent_runtime import ExternalAgentChildRuntime

_RECONCILE_CRON_KIND = "forgeflow_reconcile"
_RECONCILE_SCHEDULE = "* * * * *"
_PENDING_RUN_STATUSES = frozenset({"pending", "running"})
_FAILED_RUN_STATUSES = frozenset({"error", "timeout", "interrupted"})
_LEGACY_IMPLEMENTATION_ROUTE_ID = "openswe-current"


class ReconcileError(RuntimeError):
    """ForgeFlow cannot safely reconcile because required identity is missing."""


class PolicyServices(Protocol):
    async def ensure_reconcile_cron(self, policy_thread_id: str) -> str: ...

    async def delete_reconcile_cron(self, cron_id: str) -> None: ...

    async def preflight_repository(self, state: ForgeFlowState) -> RepositoryPreflight: ...

    def select_implementation_route(
        self, *, exclude_ids: frozenset[str] = frozenset()
    ) -> RouteDefinition | None: ...

    def automatic_route_fallback_enabled(self) -> bool: ...

    def ensure_openswe_attempt_started(
        self,
        *,
        route_id: str,
        operation_key: str,
        source_revision: str | None = None,
    ) -> bool: ...

    def finish_openswe_attempt(
        self,
        *,
        route_id: str,
        operation_key: str,
        outcome: str,
        failure_class: str | None = None,
        failure_code: str | None = None,
        source_revision: str | None = None,
        result_revision: str | None = None,
    ) -> None: ...

    async def ensure_implementation_thread(
        self,
        *,
        policy_thread_id: str,
        route_id: str,
        runtime: str,
        repo_owner: str,
        repo_name: str,
        objective: str,
    ) -> str: ...

    async def find_child_run(
        self, *, thread_id: str, operation_key: str, route_id: str, runtime: str
    ) -> str | None: ...

    async def dispatch_implementation(
        self,
        *,
        thread_id: str,
        route_id: str,
        runtime: str,
        objective: str,
        repo_owner: str,
        repo_name: str,
        base_ref: str,
        operation_key: str,
        workspace_path: str | None,
    ) -> str: ...

    async def dispatch_repair(
        self,
        *,
        thread_id: str,
        route_id: str,
        runtime: str,
        prompt: str,
        repo_owner: str,
        repo_name: str,
        operation_key: str,
        workspace_path: str | None,
    ) -> str: ...

    async def read_child_run(
        self, *, thread_id: str, run_id: str, route_id: str, runtime: str
    ) -> ChildRunSnapshot: ...

    async def read_implementation_thread(
        self, thread_id: str, *, route_id: str, runtime: str
    ) -> ThreadSnapshot: ...

    async def fetch_pr(self, pr_url: str) -> PullRequestEvidence | None: ...

    async def fetch_ci(self, pr: PullRequestEvidence) -> CiSignals | None: ...

    async def fetch_head_commit(self, pr: PullRequestEvidence) -> CommitEvidence | None: ...

    def repository_policy(self, state: ForgeFlowState) -> RepositoryPolicy: ...

    async def find_current_review(
        self, *, pr_url: str, expected_head_sha: str, operation_key: str
    ) -> tuple[str, str] | None: ...

    async def trigger_review(
        self, *, pr: PullRequestEvidence, operation_key: str
    ) -> tuple[str, str]: ...

    async def read_review(self, *, thread_id: str, run_id: str) -> ReviewerSnapshot: ...


class DefaultPolicyServices:
    """Production adapter composed entirely from LangGraph/Open SWE primitives."""

    def __init__(self, client: Any | None = None) -> None:
        self.client = client or get_client()
        self.child = OpenSweChildRuntime(self.client)
        self.external = ExternalAgentChildRuntime(self.client)
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
        github = await preflight_github_repository(
            _required(state, "repo_owner"), _required(state, "repo_name")
        )
        if github.status != "READY":
            return github
        sandbox = await asyncio.to_thread(reviewer_sandbox_preflight)
        if not sandbox.ready:
            return RepositoryPreflight(
                status="REVIEWER_SANDBOX_UNAVAILABLE", installation_id=github.installation_id
            )
        return github

    def select_implementation_route(
        self, *, exclude_ids: frozenset[str] = frozenset()
    ) -> RouteDefinition | None:
        path = os.environ.get("FORGEFLOW_ROUTE_CONFIG_FILE", "").strip()
        if not path:
            raise ReconcileError("FORGEFLOW_ROUTE_CONFIG_FILE is required")
        return load_route_registry(Path(path)).select("IMPLEMENT", exclude_ids=exclude_ids)

    def automatic_route_fallback_enabled(self) -> bool:
        value = os.environ.get("FORGEFLOW_AUTOMATIC_ROUTE_FALLBACK_ENABLED", "false").strip().lower()
        if value not in {"true", "false"}:
            raise ReconcileError("FORGEFLOW_AUTOMATIC_ROUTE_FALLBACK_ENABLED must be true or false")
        return value == "true"

    def ensure_openswe_attempt_started(
        self,
        *,
        route_id: str,
        operation_key: str,
        source_revision: str | None = None,
    ) -> bool:
        route = self._openswe_route(route_id)
        try:
            status = self._attempt_ledger().ensure_started(
                role=route.role,
                route_id=route.id,
                priority=route.priority,
                runtime=route.runtime,
                target=route.target,
                operation_key=operation_key,
                source_revision=source_revision,
            )
        except AttemptLedgerError as exc:
            raise ReconcileError(str(exc)) from exc
        return status.finished

    def finish_openswe_attempt(
        self,
        *,
        route_id: str,
        operation_key: str,
        outcome: str,
        failure_class: str | None = None,
        failure_code: str | None = None,
        source_revision: str | None = None,
        result_revision: str | None = None,
    ) -> None:
        self._openswe_route(route_id)
        if outcome not in {"SUCCEEDED", "FAILED", "BLOCKED"}:
            raise ReconcileError(f"invalid attempt outcome: {outcome}")
        try:
            self._attempt_ledger().finish_operation(
                route_id=route_id,
                operation_key=operation_key,
                outcome=outcome,  # type: ignore[arg-type]
                failure_class=failure_class,
                fallback_reason=failure_code,
                source_revision=source_revision,
                result_revision=result_revision,
            )
        except AttemptLedgerError as exc:
            raise ReconcileError(str(exc)) from exc

    def _attempt_ledger(self) -> AttemptLedger:
        path = os.environ.get("FORGEFLOW_ATTEMPT_LEDGER_FILE", "").strip()
        if not path:
            raise ReconcileError("FORGEFLOW_ATTEMPT_LEDGER_FILE is required")
        return AttemptLedger(Path(path))

    def _openswe_route(self, route_id: str) -> RouteDefinition:
        path = os.environ.get("FORGEFLOW_ROUTE_CONFIG_FILE", "").strip()
        if not path:
            raise ReconcileError("FORGEFLOW_ROUTE_CONFIG_FILE is required")
        try:
            route = load_route_registry(Path(path)).get(route_id)
        except KeyError as exc:
            raise ReconcileError(f"unknown implementation route: {route_id}") from exc
        if route.role != "IMPLEMENT" or route.runtime != "OPEN_SWE":
            raise ReconcileError(f"route is not an Open SWE implementation route: {route_id}")
        return route

    async def ensure_implementation_thread(
        self,
        *,
        policy_thread_id: str,
        route_id: str,
        runtime: str,
        repo_owner: str,
        repo_name: str,
        objective: str,
    ) -> str:
        if runtime == "OPEN_SWE":
            return await self.child.ensure_implementation_thread(
                policy_thread_id=policy_thread_id,
                repo_owner=repo_owner,
                repo_name=repo_name,
                objective=objective,
            )
        if runtime == "EXTERNAL_ACP":
            return await self.external.ensure_thread(
                policy_thread_id=policy_thread_id,
                route_id=route_id,
                repo_owner=repo_owner,
                repo_name=repo_name,
                objective=objective,
            )
        raise ReconcileError(f"unsupported implementation runtime: {runtime}")

    async def find_child_run(
        self, *, thread_id: str, operation_key: str, route_id: str, runtime: str
    ) -> str | None:
        if runtime == "OPEN_SWE":
            return await self.child.find_run_by_operation(
                thread_id=thread_id, operation_key=operation_key
            )
        if runtime == "EXTERNAL_ACP":
            return await self.external.find_run_by_operation(
                thread_id=thread_id, operation_key=operation_key
            )
        raise ReconcileError(f"unsupported implementation runtime: {runtime}")

    async def dispatch_implementation(
        self,
        *,
        thread_id: str,
        route_id: str,
        runtime: str,
        objective: str,
        repo_owner: str,
        repo_name: str,
        base_ref: str,
        operation_key: str,
        workspace_path: str | None,
    ) -> str:
        if runtime == "OPEN_SWE":
            return await self.child.dispatch_implementation(
                thread_id=thread_id,
                objective=objective,
                repo_owner=repo_owner,
                repo_name=repo_name,
                operation_key=operation_key,
                workspace_path=workspace_path,
            )
        if runtime == "EXTERNAL_ACP":
            return await self.external.dispatch(
                thread_id=thread_id,
                route_id=route_id,
                objective=objective,
                repo_owner=repo_owner,
                repo_name=repo_name,
                base_ref=base_ref,
                operation_key=operation_key,
                phase="IMPLEMENT",
            )
        raise ReconcileError(f"unsupported implementation runtime: {runtime}")

    async def dispatch_repair(
        self,
        *,
        thread_id: str,
        route_id: str,
        runtime: str,
        prompt: str,
        repo_owner: str,
        repo_name: str,
        operation_key: str,
        workspace_path: str | None,
    ) -> str:
        del route_id
        if runtime != "OPEN_SWE":
            raise ReconcileError("external-agent repair routing is not enabled yet")
        return await self.child.dispatch_repair(
            thread_id=thread_id,
            prompt=prompt,
            repo_owner=repo_owner,
            repo_name=repo_name,
            operation_key=operation_key,
            workspace_path=workspace_path,
        )

    async def read_child_run(
        self, *, thread_id: str, run_id: str, route_id: str, runtime: str
    ) -> ChildRunSnapshot:
        del route_id
        if runtime == "OPEN_SWE":
            return await self.child.read_run(thread_id=thread_id, run_id=run_id)
        if runtime == "EXTERNAL_ACP":
            return await self.external.read_run(thread_id=thread_id, run_id=run_id)
        raise ReconcileError(f"unsupported implementation runtime: {runtime}")

    async def read_implementation_thread(
        self, thread_id: str, *, route_id: str, runtime: str
    ) -> ThreadSnapshot:
        del route_id
        if runtime == "OPEN_SWE":
            return await self.child.read_thread(thread_id)
        if runtime == "EXTERNAL_ACP":
            return await self.external.read_thread(thread_id)
        raise ReconcileError(f"unsupported implementation runtime: {runtime}")

    async def fetch_pr(self, pr_url: str) -> PullRequestEvidence | None:
        return await fetch_pull_request(pr_url)

    async def fetch_ci(self, pr: PullRequestEvidence) -> CiSignals | None:
        return await fetch_ci_signals(pr)

    async def fetch_head_commit(self, pr: PullRequestEvidence) -> CommitEvidence | None:
        return await fetch_head_commit(pr)

    def repository_policy(self, state: ForgeFlowState) -> RepositoryPolicy:
        # V1 defaults fail-closed on CI. Per-repository overrides are a later
        # configuration surface, not another persistence system.
        return load_repository_policy(_required(state, "repo_owner"), _required(state, "repo_name"))

    async def find_current_review(
        self, *, pr_url: str, expected_head_sha: str, operation_key: str
    ) -> tuple[str, str] | None:
        return await self.reviewer.find_current_review(
            pr_url=pr_url, expected_head_sha=expected_head_sha, operation_key=operation_key
        )

    async def trigger_review(
        self, *, pr: PullRequestEvidence, operation_key: str
    ) -> tuple[str, str]:
        return await self.reviewer.trigger_review(
            owner=pr.owner, repo=pr.repo, pr_number=pr.number, pr_url=pr.url,
            head_sha=pr.head_sha, head_ref=pr.head_ref, base_sha=pr.base_sha,
            base_ref=pr.base_ref, operation_key=operation_key
        )

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
    if status == "READY":
        return await _reconcile_ready(state, services)
    raise ReconcileError(f"unsupported policy status: {status}")


async def _reconcile_new(
    state: ForgeFlowState, policy_thread_id: str, services: PolicyServices
) -> ForgeFlowState:
    preflight = await services.preflight_repository(state)
    if preflight.status == "CONFIG_MISSING":
        return escalate(state, "GITHUB_APP_NOT_CONFIGURED")
    if preflight.status == "REVIEWER_SANDBOX_UNAVAILABLE":
        return escalate(state, "REVIEWER_SANDBOX_UNAVAILABLE")
    if preflight.status != "READY":
        return note_wait(
            state, "github_preflight", "GITHUB_APP_REPO_OR_PERMISSION_UNAVAILABLE",
            limit=DEFAULT_BUDGET.external_evidence_reconciles
        )

    repository_policy = services.repository_policy(state)
    if repository_policy.ci_required and not repository_policy.required_checks:
        return escalate(state, "REQUIRED_CHECK_POLICY_MISSING")

    route_id = state.get("implementation_route_id")
    runtime = state.get("implementation_runtime")
    if not route_id or not runtime:
        route = services.select_implementation_route(
            exclude_ids=frozenset(state.get("implementation_failed_route_ids", []))
        )
        if route is None:
            return escalate(state, "IMPLEMENTATION_ROUTE_UNAVAILABLE")
        result = deepcopy(state)
        result["implementation_route_id"] = route.id
        result["implementation_runtime"] = route.runtime
        return result

    thread_id = state.get("implementation_thread_id")
    if not thread_id:
        thread_id = await services.ensure_implementation_thread(
            policy_thread_id=policy_thread_id,
            route_id=route_id,
            runtime=runtime,
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
    if not state.get("implementation_thread_id"):
        thread_id = await services.ensure_implementation_thread(
            policy_thread_id=policy_thread_id,
            route_id=_required(state, "implementation_route_id"),
            runtime=_required(state, "implementation_runtime"),
            repo_owner=_required(state, "repo_owner"),
            repo_name=_required(state, "repo_name"),
            objective=_required(state, "objective"),
        )
        result = deepcopy(state)
        result["implementation_thread_id"] = thread_id
        return result
    if not state.get("implementation_run_id"):
        return await _adopt_or_dispatch_initial(state, policy_thread_id, services)
    thread_id = _required(state, "implementation_thread_id")
    run_id = _required(state, "implementation_run_id")
    snapshot = await services.read_child_run(
        thread_id=thread_id,
        run_id=run_id,
        route_id=_required(state, "implementation_route_id"),
        runtime=_required(state, "implementation_runtime"),
    )
    if snapshot.status in _PENDING_RUN_STATUSES:
        return state
    if snapshot.status == "success":
        return mark_run_terminal(state)
    failure_code = snapshot.failure_code or f"CHILD_RUN_{snapshot.status.upper()}"
    # Routing policy owns this classification. A child result may report its
    # own class for diagnostics, but it cannot authorize an ownership switch.
    failure_class = classify_failure_code(failure_code)
    _finish_openswe_attempt_for_state(
        state,
        services,
        outcome="FAILED",
        failure_code=failure_code,
        failure_class=failure_class,
    )
    if (
        failure_class == "ROUTE_AVAILABILITY"
        and services.automatic_route_fallback_enabled()
    ):
        return _fallback_implementation_route(state, services, failure_code=failure_code)
    return note_child_run_failure(state, failure_code)


def _fallback_implementation_route(
    state: ForgeFlowState, services: PolicyServices, *, failure_code: str
) -> ForgeFlowState:
    failed = list(dict.fromkeys([*state.get("implementation_failed_route_ids", []), _required(state, "implementation_route_id")]))
    route = services.select_implementation_route(exclude_ids=frozenset(failed))
    if route is None:
        return escalate(state, "IMPLEMENTATION_ROUTE_EXHAUSTED")
    result = deepcopy(state)
    result["implementation_failed_route_ids"] = failed
    result["implementation_route_id"] = route.id
    result["implementation_runtime"] = route.runtime
    result["implementation_thread_id"] = None
    result["implementation_run_id"] = None
    result["implementation_operation_key"] = None
    result["run_retry_count"] = 0
    result["last_failure_code"] = failure_code
    return result


async def _adopt_or_dispatch_initial(
    state: ForgeFlowState, policy_thread_id: str, services: PolicyServices
) -> ForgeFlowState:
    thread_id = _required(state, "implementation_thread_id")
    operation_key = _implementation_operation_key(policy_thread_id, state)
    route_id = _required(state, "implementation_route_id")
    runtime = _required(state, "implementation_runtime")
    run_id = await services.find_child_run(
        thread_id=thread_id,
        operation_key=operation_key,
        route_id=route_id,
        runtime=runtime,
    )
    attempt_finished = False
    if runtime == "OPEN_SWE":
        attempt_finished = services.ensure_openswe_attempt_started(
            route_id=route_id,
            operation_key=operation_key,
        )
    if run_id is None and attempt_finished:
        return escalate(state, "ATTEMPT_LEDGER_COMPLETED_WITHOUT_CHILD_RUN")
    if run_id is None:
        run_id = await services.dispatch_implementation(
            thread_id=thread_id,
            route_id=route_id,
            runtime=runtime,
            objective=build_implementation_prompt(
                objective=_required(state, "objective"),
                operation_key=operation_key,
                base_ref=_required(state, "base_ref"),
            ),
            repo_owner=_required(state, "repo_owner"),
            repo_name=_required(state, "repo_name"),
            base_ref=_required(state, "base_ref"),
            operation_key=operation_key,
            workspace_path=state.get("workspace_path"),
        )
    result = start_implementation(state) if state["status"] == "NEW" else deepcopy(state)
    result["implementation_run_id"] = run_id
    result["implementation_operation_key"] = operation_key
    result["implementation_phase"] = "INITIAL"
    return result


async def _reconcile_implementation_evidence(
    state: ForgeFlowState, services: PolicyServices
) -> ForgeFlowState:
    thread_id = state.get("implementation_thread_id")
    if not thread_id:
        return escalate(state, "IMPLEMENTATION_THREAD_MISSING")
    thread = await services.read_implementation_thread(
        thread_id,
        route_id=_required(state, "implementation_route_id"),
        runtime=_required(state, "implementation_runtime"),
    )
    tracked = tracked_pull_request(thread.metadata)
    if tracked is None:
        evidence = implementation_evidence(
            state,
            run_status="success",
            tracked_pr=None,
            authoritative_pr=None,
        )
        return _apply_implementation_evidence_with_attempt(state, services, evidence)

    tracked_failure = tracked_pr_target_failure(state, tracked)
    if tracked_failure:
        _finish_openswe_attempt_for_state(
            state, services, outcome="BLOCKED", failure_code=tracked_failure, failure_class="POLICY_DENIED"
        )
        return escalate(state, tracked_failure)

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
        return _apply_implementation_evidence_with_attempt(state, services, evidence)

    authoritative = await services.fetch_pr(tracked.url)
    if authoritative is None:
        result = deepcopy(state)
        result["last_failure_code"] = "PR_EVIDENCE_UNAVAILABLE"
        return result
    target_failure = pull_request_target_failure(state, authoritative)
    if target_failure:
        _finish_openswe_attempt_for_state(
            state, services, outcome="BLOCKED", failure_code=target_failure, failure_class="POLICY_DENIED"
        )
        return escalate(state, target_failure)
    commit = await services.fetch_head_commit(authoritative)
    if commit is None:
        result = deepcopy(state)
        result["last_failure_code"] = "COMMIT_EVIDENCE_UNAVAILABLE"
        return result
    operation_key = _completed_implementation_operation_key(state)
    if operation_trailer(operation_key) not in {line.strip() for line in commit.message.splitlines()}:
        missing = implementation_evidence(
            state, run_status="success", tracked_pr=None, authoritative_pr=None
        )
        missing = missing.__class__(
            pr_url="", pr_number=0, head_sha="", progressed=False,
            failure_code="HEAD_OPERATION_PROVENANCE_MISSING"
        )
        return _apply_implementation_evidence_with_attempt(state, services, missing)
    evidence = implementation_evidence(
        state,
        run_status="success",
        tracked_pr=tracked,
        authoritative_pr=authoritative,
    )
    return _apply_implementation_evidence_with_attempt(state, services, evidence)


async def _reconcile_ci(state: ForgeFlowState, services: PolicyServices) -> ForgeFlowState:
    pr_url = state.get("pr_url")
    if not pr_url:
        return escalate(state, "PR_URL_MISSING")
    pr = await services.fetch_pr(pr_url)
    if pr is None:
        result = deepcopy(state)
        result["last_failure_code"] = "PR_EVIDENCE_UNAVAILABLE"
        return result
    target_failure = pull_request_target_failure(state, pr)
    if target_failure:
        return escalate(state, target_failure)
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
    target_failure = pull_request_target_failure(state, pr)
    if target_failure:
        return escalate(state, target_failure)
    if pr.head_sha != head_sha:
        return observe_external_head(state, pr.head_sha)

    run_id = state.get("reviewer_run_id")
    retry_pending = state.get("reviewer_retry_pending", False)
    operation_key = _review_operation_key(state)
    if not run_id or retry_pending:
        try:
            existing = await services.find_current_review(
                pr_url=pr_url, expected_head_sha=head_sha, operation_key=operation_key
            )
        except ReviewerSupersededError:
            return note_reviewer_run_failure(state, "REVIEWER_RUN_SUPERSEDED")
        if existing is not None:
            result = deepcopy(state)
            result["reviewer_thread_id"], result["reviewer_run_id"] = existing
            result["reviewer_retry_pending"] = False
            result["last_failure_code"] = None
            return result
        thread_id, new_run_id = await services.trigger_review(pr=pr, operation_key=operation_key)
        result = deepcopy(state)
        result["reviewer_thread_id"] = thread_id
        result["reviewer_run_id"] = new_run_id
        result["reviewer_retry_pending"] = False
        result["last_failure_code"] = None
        return result

    reviewer_thread_id = state.get("reviewer_thread_id")
    if not reviewer_thread_id:
        return escalate(state, "REVIEWER_THREAD_MISSING")
    try:
        snapshot = await services.read_review(thread_id=reviewer_thread_id, run_id=run_id)
    except ReviewerSupersededError:
        return note_reviewer_run_failure(state, "REVIEWER_RUN_SUPERSEDED")
    if snapshot.run_status in _PENDING_RUN_STATUSES:
        return state
    if snapshot.run_status != "success":
        return note_reviewer_run_failure(state, f"REVIEWER_RUN_{snapshot.run_status.upper()}")
    try:
        decision = review_decision(snapshot, expected_head_sha=head_sha)
    except EvidenceViolation:
        return note_reviewer_run_failure(state, "REVIEWER_EVIDENCE_STALE")

    final_pr = await services.fetch_pr(pr_url)
    if final_pr is None:
        result = deepcopy(state)
        result["last_failure_code"] = "PR_EVIDENCE_UNAVAILABLE"
        return result
    target_failure = pull_request_target_failure(state, final_pr)
    if target_failure:
        return escalate(state, target_failure)
    if final_pr.head_sha != head_sha:
        return observe_external_head(state, final_pr.head_sha)
    return apply_review_decision(state, decision)


async def _reconcile_ready(state: ForgeFlowState, services: PolicyServices) -> ForgeFlowState:
    pr_url = state.get("pr_url")
    head_sha = state.get("observed_head_sha")
    if not pr_url or not head_sha:
        return escalate(state, "READY_IDENTITY_MISSING")
    pr = await services.fetch_pr(pr_url)
    if pr is None:
        result = deepcopy(state)
        result["last_failure_code"] = "PR_EVIDENCE_UNAVAILABLE"
        return result
    target_failure = pull_request_target_failure(state, pr)
    if target_failure:
        return escalate(state, target_failure)
    if pr.head_sha != head_sha:
        return observe_external_head(state, pr.head_sha)
    result = deepcopy(state)
    result["last_failure_code"] = None
    return result


async def _reconcile_repair(
    state: ForgeFlowState, policy_thread_id: str, services: PolicyServices
) -> ForgeFlowState:
    thread_id = state.get("implementation_thread_id")
    pr_url = state.get("pr_url")
    rejected_head = state.get("observed_head_sha")
    if not thread_id or not pr_url or not rejected_head:
        return escalate(state, "REPAIR_IDENTITY_MISSING")
    route_id = _required(state, "implementation_route_id")
    runtime = _required(state, "implementation_runtime")
    if runtime != "OPEN_SWE":
        return escalate(state, "EXTERNAL_AGENT_REPAIR_NOT_ENABLED")

    run_id = state.get("implementation_run_id")
    if not run_id:
        current_pr = await services.fetch_pr(pr_url)
        if current_pr is None:
            result = deepcopy(state)
            result["last_failure_code"] = "PR_EVIDENCE_UNAVAILABLE"
            return result
        target_failure = pull_request_target_failure(state, current_pr)
        if target_failure:
            return escalate(state, target_failure)
        if current_pr.head_sha != rejected_head:
            return observe_external_head(state, current_pr.head_sha)

        fresh_repair = state.get("run_retry_count", 0) == 0
        operation_key = _repair_operation_key(policy_thread_id, state, fresh=fresh_repair)
        run_id = await services.find_child_run(
            thread_id=thread_id,
            operation_key=operation_key,
            route_id=route_id,
            runtime=runtime,
        )
        attempt_finished = services.ensure_openswe_attempt_started(
            route_id=route_id,
            operation_key=operation_key,
            source_revision=rejected_head,
        )
        if run_id is None and attempt_finished:
            return escalate(state, "ATTEMPT_LEDGER_COMPLETED_WITHOUT_CHILD_RUN")
        if run_id is None:
            prompt = await _repair_prompt(state, services, operation_key=operation_key)
            run_id = await services.dispatch_repair(
                thread_id=thread_id,
                route_id=route_id,
                runtime=runtime,
                prompt=prompt,
                repo_owner=_required(state, "repo_owner"),
                repo_name=_required(state, "repo_name"),
                operation_key=operation_key,
                workspace_path=state.get("workspace_path"),
            )
        result = mark_repair_dispatched(state) if fresh_repair else deepcopy(state)
        result["implementation_run_id"] = run_id
        result["implementation_operation_key"] = operation_key
        result["implementation_phase"] = "REPAIR"
        return result

    snapshot = await services.read_child_run(
        thread_id=thread_id,
        run_id=run_id,
        route_id=route_id,
        runtime=runtime,
    )
    if snapshot.status in _PENDING_RUN_STATUSES:
        return state
    if snapshot.status == "success":
        result = mark_repair_run_terminal(state)
        result["last_failure_code"] = None
        return result
    failure_code = snapshot.failure_code or f"REPAIR_RUN_{snapshot.status.upper()}"
    _finish_openswe_attempt_for_state(
        state,
        services,
        outcome="FAILED",
        failure_code=failure_code,
        source_revision=rejected_head,
    )
    return note_child_run_failure(state, failure_code)


async def _repair_prompt(
    state: ForgeFlowState, services: PolicyServices, *, operation_key: str
) -> str:
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
            operation_key=operation_key,
        )
    return build_ci_repair_prompt(
        pr_url=pr_url,
        rejected_head_sha=rejected_head,
        failure_code=str(state.get("last_failure_code") or "CI_FAILED"),
        operation_key=operation_key,
    )


def _apply_implementation_evidence_with_attempt(
    state: ForgeFlowState, services: PolicyServices, evidence
) -> ForgeFlowState:
    if evidence.progressed:
        _finish_openswe_attempt_for_state(
            state, services, outcome="SUCCEEDED", result_revision=evidence.head_sha
        )
    else:
        failure_code = evidence.failure_code or "NO_PROGRESS"
        _finish_openswe_attempt_for_state(
            state, services, outcome="FAILED", failure_code=failure_code
        )
    return apply_implementation_evidence(state, evidence)


def _finish_openswe_attempt_for_state(
    state: ForgeFlowState,
    services: PolicyServices,
    *,
    outcome: str,
    failure_code: str | None = None,
    failure_class: str | None = None,
    source_revision: str | None = None,
    result_revision: str | None = None,
) -> None:
    if state.get("implementation_runtime") != "OPEN_SWE":
        return
    operation_key = state.get("implementation_operation_key")
    route_id = state.get("implementation_route_id")
    if not operation_key or not route_id:
        # Pre-ledger legacy runs remain recoverable; all newly dispatched Open SWE
        # operations have stable provenance and are accounted.
        return
    resolved_class = failure_class
    if outcome != "SUCCEEDED" and resolved_class is None and failure_code:
        resolved_class = classify_failure_code(failure_code)
    resolved_source_revision = source_revision
    if resolved_source_revision is None and state.get("implementation_phase") == "REPAIR":
        resolved_source_revision = state.get("observed_head_sha")
    services.finish_openswe_attempt(
        route_id=route_id,
        operation_key=operation_key,
        outcome=outcome,
        failure_class=resolved_class,
        failure_code=failure_code,
        source_revision=resolved_source_revision,
        result_revision=result_revision,
    )


def _completed_implementation_operation_key(state: ForgeFlowState) -> str:
    operation_key = state.get("implementation_operation_key")
    if not operation_key:
        raise ReconcileError("completed implementation is missing operation provenance key")
    return operation_key

def _review_operation_key(state: ForgeFlowState) -> str:
    head_sha = state.get("observed_head_sha") or "missing-head"
    retry = state.get("reviewer_retry_count", 0)
    return f"review:{head_sha}:retry:{retry}"


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
    state.setdefault("implementation_failed_route_ids", [])
    if state.get("implementation_thread_id") and not state.get("implementation_route_id"):
        state["implementation_route_id"] = _LEGACY_IMPLEMENTATION_ROUTE_ID
        state["implementation_runtime"] = "OPEN_SWE"
    return state


def _required(state: ForgeFlowState, key: str) -> Any:
    value = state.get(key)  # type: ignore[literal-required]
    if value is None or value == "":
        raise ReconcileError(f"required policy field is missing: {key}")
    return value


def _cron_id(cron: Any) -> str | None:
    value = cron.get("cron_id") if isinstance(cron, Mapping) else getattr(cron, "cron_id", None)
    return value if isinstance(value, str) and value else None
