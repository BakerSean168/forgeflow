from dataclasses import dataclass, field

import pytest

from forgeflow.adapters.github import CiSignals, CommitEvidence, PullRequestEvidence
from forgeflow.adapters.openswe import ChildRunSnapshot, ReviewerSnapshot, ThreadSnapshot
from forgeflow.graph import build_forgeflow_graph
from forgeflow.models import RepositoryPolicy, RepositoryPreflight
from forgeflow.reconcile import reconcile_once
from forgeflow.routing import RouteDefinition
from forgeflow.state import ForgeFlowState, initial_state

PR = "https://github.com/o/r/pull/1"
BASE = "a" * 40
HEAD1 = "b" * 40
HEAD2 = "c" * 40


class SimulatedCrash(RuntimeError):
    pass


@dataclass
class FakeServices:
    actions: list[str] = field(default_factory=list)
    cron_id: str | None = None
    implementation_thread: str | None = None
    child_operations: dict[str, str] = field(default_factory=dict)
    child_status: dict[str, str] = field(default_factory=dict)
    implementation_metadata: dict = field(default_factory=dict)
    pr: PullRequestEvidence | None = None
    ci: CiSignals | None = None
    commits: dict[str, CommitEvidence] = field(default_factory=dict)
    current_review: tuple[str, str] | None = None
    review_operations: dict[str, tuple[str, str]] = field(default_factory=dict)
    review_snapshots: dict[tuple[str, str], ReviewerSnapshot] = field(default_factory=dict)
    crash_child_once: bool = False
    crash_review_once: bool = False
    crash_repair_once: bool = False
    _child_sequence: int = 0
    _review_sequence: int = 0

    preflight_status: str = "READY"
    repo_policy: RepositoryPolicy = field(
        default_factory=lambda: RepositoryPolicy(required_checks=("tests",))
    )
    selected_route: RouteDefinition = field(
        default_factory=lambda: RouteDefinition(
            "openswe-current", "IMPLEMENT", 10, "OPEN_SWE", "current-model-policy"
        )
    )
    fallback_route: RouteDefinition | None = None
    route_fallback_enabled: bool = False
    child_failure_code: dict[str, str] = field(default_factory=dict)
    child_failure_class: dict[str, str] = field(default_factory=dict)
    fallback_threads: dict[str, str] = field(default_factory=dict)

    async def preflight_repository(self, state: ForgeFlowState) -> RepositoryPreflight:
        return RepositoryPreflight(status=self.preflight_status)  # type: ignore[arg-type]

    async def ensure_reconcile_cron(self, policy_thread_id: str) -> str:
        if self.cron_id is None:
            self.actions.append("create_cron")
            self.cron_id = "cron-1"
        return self.cron_id

    async def delete_reconcile_cron(self, cron_id: str) -> None:
        if self.cron_id == cron_id:
            self.actions.append("delete_cron")
            self.cron_id = None

    def select_implementation_route(
        self, *, exclude_ids: frozenset[str] = frozenset()
    ) -> RouteDefinition | None:
        if self.selected_route.id not in exclude_ids:
            return self.selected_route
        if self.fallback_route is not None and self.fallback_route.id not in exclude_ids:
            return self.fallback_route
        return None

    def automatic_route_fallback_enabled(self) -> bool:
        return self.route_fallback_enabled

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
        assert runtime in {"OPEN_SWE", "EXTERNAL_ACP"}
        if route_id == self.selected_route.id:
            if self.implementation_thread is None:
                self.actions.append("create_implementation_thread")
                self.implementation_thread = "implementation-thread"
            return self.implementation_thread
        if self.fallback_route is None or route_id != self.fallback_route.id:
            raise AssertionError(f"unexpected route {route_id}")
        if route_id not in self.fallback_threads:
            self.actions.append(f"create_implementation_thread:{route_id}")
            self.fallback_threads[route_id] = f"implementation-thread-{route_id}"
        return self.fallback_threads[route_id]

    async def find_child_run(
        self, *, thread_id: str, operation_key: str, route_id: str, runtime: str
    ) -> str | None:
        del thread_id, route_id, runtime
        return self.child_operations.get(operation_key)

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
        del thread_id, route_id, runtime, objective, repo_owner, repo_name, base_ref, workspace_path
        return self._dispatch_child(operation_key, crash_attr="crash_child_once")

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
        del thread_id, route_id, runtime, prompt, repo_owner, repo_name, workspace_path
        return self._dispatch_child(operation_key, crash_attr="crash_repair_once")

    def _dispatch_child(self, operation_key: str, *, crash_attr: str) -> str:
        assert operation_key not in self.child_operations, "duplicate child dispatch"
        self._child_sequence += 1
        run_id = f"child-run-{self._child_sequence}"
        self.child_operations[operation_key] = run_id
        self.child_status[run_id] = "running"
        self.actions.append(f"dispatch_child:{operation_key}")
        if getattr(self, crash_attr):
            setattr(self, crash_attr, False)
            raise SimulatedCrash("crashed after child run was created")
        return run_id

    async def read_child_run(
        self, *, thread_id: str, run_id: str, route_id: str, runtime: str
    ) -> ChildRunSnapshot:
        del route_id, runtime
        return ChildRunSnapshot(
            thread_id=thread_id,
            run_id=run_id,
            status=self.child_status[run_id],
            failure_code=self.child_failure_code.get(run_id),
            failure_class=self.child_failure_class.get(run_id),
        )

    async def read_implementation_thread(
        self, thread_id: str, *, route_id: str, runtime: str
    ) -> ThreadSnapshot:
        del route_id, runtime
        return ThreadSnapshot(thread_id=thread_id, status="idle", metadata=self.implementation_metadata)

    async def fetch_pr(self, pr_url: str) -> PullRequestEvidence | None:
        return self.pr

    async def fetch_ci(self, pr: PullRequestEvidence) -> CiSignals | None:
        return self.ci

    async def fetch_head_commit(self, pr: PullRequestEvidence) -> CommitEvidence | None:
        return self.commits.get(pr.head_sha)

    def repository_policy(self, state: ForgeFlowState) -> RepositoryPolicy:
        return self.repo_policy

    async def find_current_review(
        self, *, pr_url: str, expected_head_sha: str, operation_key: str
    ) -> tuple[str, str] | None:
        pair = self.review_operations.get(operation_key)
        if pair is None:
            return None
        snapshot = self.review_snapshots.get(pair)
        if snapshot is None or snapshot.last_reviewed_sha != expected_head_sha:
            return None
        return pair

    async def trigger_review(
        self, *, pr: PullRequestEvidence, operation_key: str
    ) -> tuple[str, str]:
        self._review_sequence += 1
        pair = ("review-thread", f"review-run-{self._review_sequence}")
        self.review_operations[operation_key] = pair
        self.review_snapshots[pair] = ReviewerSnapshot(
            thread_id=pair[0], run_id=pair[1], run_status="running",
            last_reviewed_sha=pr.head_sha, findings=(),
        )
        self.actions.append(f"trigger_review:{pair[1]}")
        if self.crash_review_once:
            self.crash_review_once = False
            raise SimulatedCrash("crashed after official reviewer run was created before pointer write")
        self.current_review = pair
        return pair

    async def read_review(self, *, thread_id: str, run_id: str) -> ReviewerSnapshot:
        return self.review_snapshots[(thread_id, run_id)]


def _pr(head=HEAD1):
    return PullRequestEvidence(
        owner="o",
        repo="r",
        number=1,
        url=PR,
        state="open",
        head_sha=head,
        head_ref="open-swe/task",
        base_sha=BASE,
        base_ref="main",
    )


def _ci(head=HEAD1):
    return CiSignals(
        head_sha=head,
        check_runs=({"name": "tests", "status": "completed", "conclusion": "success"},),
        statuses=(),
    )


def _base_state(status="NEW") -> ForgeFlowState:
    state = initial_state(objective="do work", repo_owner="o", repo_name="r")
    state["status"] = status
    state["reconcile_cron_id"] = "cron-1"
    return state


@pytest.mark.asyncio
async def test_reconcile_bootstrap_performs_only_one_external_mutation_per_invocation() -> None:
    services = FakeServices()
    state = initial_state(objective="do work", repo_owner="o", repo_name="r")

    state = await reconcile_once(state, policy_thread_id="policy-1", services=services)
    assert services.actions == ["create_cron"]
    assert state["status"] == "NEW"

    state = await reconcile_once(state, policy_thread_id="policy-1", services=services)
    assert state["implementation_route_id"] == "openswe-current"
    assert state["implementation_runtime"] == "OPEN_SWE"
    assert services.actions == ["create_cron"]

    state = await reconcile_once(state, policy_thread_id="policy-1", services=services)
    assert services.actions[-1:] == ["create_implementation_thread"]
    assert len(services.actions) == 2

    state = await reconcile_once(state, policy_thread_id="policy-1", services=services)
    assert services.actions[-1].startswith("dispatch_child:implementation:policy-1:retry:0")
    assert len(services.actions) == 3
    assert state["status"] == "IMPLEMENTING"


@pytest.mark.asyncio
async def test_crash_after_implementation_dispatch_reuses_operation_instead_of_duplicate() -> None:
    services = FakeServices(cron_id="cron-1", implementation_thread="implementation-thread")
    services.crash_child_once = True
    state = _base_state()
    state["implementation_thread_id"] = "implementation-thread"

    with pytest.raises(SimulatedCrash):
        await reconcile_once(state, policy_thread_id="policy-1", services=services)
    assert len(services.child_operations) == 1
    action_count = len(services.actions)

    recovered = await reconcile_once(state, policy_thread_id="policy-1", services=services)
    assert len(services.actions) == action_count
    assert recovered["implementation_run_id"] == next(iter(services.child_operations.values()))
    assert recovered["status"] == "IMPLEMENTING"


@pytest.mark.asyncio
async def test_crash_after_repair_dispatch_adopts_run_and_increments_round_once() -> None:
    services = FakeServices(cron_id="cron-1", implementation_thread="implementation-thread", pr=_pr(HEAD1))
    services.crash_repair_once = True
    state = _base_state("REPAIRING")
    state.update(
        implementation_thread_id="implementation-thread",
        implementation_run_id=None,
        pr_url=PR,
        observed_head_sha=HEAD1,
        last_failure_code="CHECK_FAILED:tests",
    )

    with pytest.raises(SimulatedCrash):
        await reconcile_once(state, policy_thread_id="policy-1", services=services)
    assert len(services.child_operations) == 1
    action_count = len(services.actions)

    recovered = await reconcile_once(state, policy_thread_id="policy-1", services=services)
    assert len(services.actions) == action_count
    assert recovered["repair_round"] == 1
    assert recovered["implementation_phase"] == "REPAIR"
    assert recovered["implementation_run_id"] == next(iter(services.child_operations.values()))


@pytest.mark.asyncio
async def test_crash_after_official_review_trigger_adopts_canonical_review() -> None:
    services = FakeServices(cron_id="cron-1", pr=_pr())
    services.crash_review_once = True
    state = _base_state("REVIEWING")
    state.update(pr_url=PR, observed_head_sha=HEAD1, ci_head_sha=HEAD1)

    with pytest.raises(SimulatedCrash):
        await reconcile_once(state, policy_thread_id="policy-1", services=services)
    assert len(services.review_operations) == 1
    orphaned = next(iter(services.review_operations.values()))
    assert services.current_review is None
    action_count = len(services.actions)

    recovered = await reconcile_once(state, policy_thread_id="policy-1", services=services)
    assert len(services.actions) == action_count
    assert (recovered["reviewer_thread_id"], recovered["reviewer_run_id"]) == orphaned


@pytest.mark.asyncio
async def test_reviewer_failure_retries_canonical_review_without_reusing_failed_run() -> None:
    services = FakeServices(cron_id="cron-1", pr=_pr())
    old = ("review-thread", "review-run-old")
    services.current_review = old
    services.review_snapshots[old] = ReviewerSnapshot(
        thread_id=old[0], run_id=old[1], run_status="error", last_reviewed_sha=HEAD1, findings=()
    )
    state = _base_state("REVIEWING")
    state.update(
        pr_url=PR,
        observed_head_sha=HEAD1,
        ci_head_sha=HEAD1,
        reviewer_thread_id=old[0],
        reviewer_run_id=old[1],
    )

    failed = await reconcile_once(state, policy_thread_id="policy-1", services=services)
    assert failed["reviewer_retry_pending"] is True
    retried = await reconcile_once(failed, policy_thread_id="policy-1", services=services)
    assert retried["reviewer_run_id"] != old[1]
    assert services.actions[-1].startswith("trigger_review:")


@pytest.mark.asyncio
async def test_terminal_state_removes_reconcile_cron_on_next_reconcile() -> None:
    services = FakeServices(cron_id="cron-1")
    state = _base_state("ESCALATED")
    result = await reconcile_once(state, policy_thread_id="policy-1", services=services)
    assert result["reconcile_cron_id"] is None
    assert services.actions == ["delete_cron"]


@pytest.mark.asyncio
async def test_cancel_is_state_transition_first_then_cron_cleanup_next_run() -> None:
    services = FakeServices(cron_id="cron-1")
    state = _base_state("WAITING_FOR_CI")
    state["cancel_requested"] = True
    cancelled = await reconcile_once(state, policy_thread_id="policy-1", services=services)
    assert cancelled["status"] == "CANCELLED"
    assert services.actions == []
    cleaned = await reconcile_once(cancelled, policy_thread_id="policy-1", services=services)
    assert cleaned["reconcile_cron_id"] is None
    assert services.actions == ["delete_cron"]


@pytest.mark.asyncio
async def test_new_external_head_invalidates_checkpointed_exact_head_evidence() -> None:
    services = FakeServices(cron_id="cron-1", pr=_pr(HEAD2))
    state = _base_state("REVIEWING")
    state.update(
        pr_url=PR, observed_head_sha=HEAD1, ci_head_sha=HEAD1, reviewed_head_sha=HEAD1,
        reviewer_thread_id="rt", reviewer_run_id="rr", reviewer_retry_count=2,
        reviewer_retry_pending=True, blocking_finding_ids=["f1"],
    )
    result = await reconcile_once(state, policy_thread_id="policy-1", services=services)
    assert result["status"] == "WAITING_FOR_CI"
    assert result["observed_head_sha"] == HEAD2
    assert result["ci_head_sha"] is None
    assert result["reviewed_head_sha"] is None
    assert result["reviewer_run_id"] is None
    assert result["reviewer_retry_count"] == 0
    assert result["reviewer_retry_pending"] is False
    assert result["blocking_finding_ids"] == []


@pytest.mark.asyncio
async def test_untrusted_graph_input_cannot_inject_ready_or_evidence_fields() -> None:
    services = FakeServices()
    graph = build_forgeflow_graph(services=services)
    result = await graph.ainvoke(
        {
            "objective": "x", "repo_owner": "o", "repo_name": "r",
            "status": "READY", "observed_head_sha": HEAD1, "ci_head_sha": HEAD1,
            "reviewed_head_sha": HEAD1, "reviewer_run_id": "forged",
            "reconcile_cron_id": "forged-cron",
        },
        {"configurable": {"thread_id": "policy-raw"}},
    )
    assert result["status"] == "NEW"
    assert result.get("observed_head_sha") is None
    assert result.get("ci_head_sha") is None
    assert result.get("reviewed_head_sha") is None
    assert result.get("reviewer_run_id") is None
    assert result["reconcile_cron_id"] == "cron-1"
    assert services.actions == ["create_cron"]


@pytest.mark.asyncio
async def test_ready_remains_monitored_and_head_drift_reopens_ci_gate() -> None:
    services = FakeServices(cron_id="cron-1", pr=_pr(HEAD2))
    state = _base_state("READY")
    state.update(
        pr_url=PR, observed_head_sha=HEAD1, ci_head_sha=HEAD1, reviewed_head_sha=HEAD1,
        reviewer_thread_id="rt", reviewer_run_id="rr", blocking_finding_ids=[]
    )
    result = await reconcile_once(state, policy_thread_id="policy-1", services=services)
    assert result["status"] == "WAITING_FOR_CI"
    assert result["observed_head_sha"] == HEAD2
    assert result["ci_head_sha"] is None
    assert result["reviewed_head_sha"] is None
    assert result["reconcile_cron_id"] == "cron-1"


@pytest.mark.asyncio
async def test_ready_same_head_keeps_monitoring_cron() -> None:
    services = FakeServices(cron_id="cron-1", pr=_pr(HEAD1))
    state = _base_state("READY")
    state.update(pr_url=PR, observed_head_sha=HEAD1, ci_head_sha=HEAD1, reviewed_head_sha=HEAD1)
    result = await reconcile_once(state, policy_thread_id="policy-1", services=services)
    assert result["status"] == "READY"
    assert result["reconcile_cron_id"] == "cron-1"
    assert services.actions == []


@pytest.mark.asyncio
async def test_missing_github_app_escalates_before_child_thread_or_model_dispatch() -> None:
    services = FakeServices(cron_id="cron-1", preflight_status="CONFIG_MISSING")
    state = _base_state("NEW")
    result = await reconcile_once(state, policy_thread_id="policy-1", services=services)
    assert result["status"] == "ESCALATED"
    assert result["last_failure_code"] == "GITHUB_APP_NOT_CONFIGURED"
    assert services.actions == []
    assert services.implementation_thread is None
    assert services.child_operations == {}


@pytest.mark.asyncio
async def test_repo_permission_preflight_blocks_without_spending_model_and_can_recover() -> None:
    services = FakeServices(cron_id="cron-1", preflight_status="REPO_OR_PERMISSION_UNAVAILABLE")
    state = _base_state("NEW")
    blocked = await reconcile_once(state, policy_thread_id="policy-1", services=services)
    assert blocked["status"] == "NEW"
    assert blocked["last_failure_code"] == "GITHUB_APP_REPO_OR_PERMISSION_UNAVAILABLE"
    assert services.actions == []
    services.preflight_status = "READY"
    recovered = await reconcile_once(blocked, policy_thread_id="policy-1", services=services)
    assert recovered["implementation_route_id"] == "openswe-current"
    assert services.actions == []
    threaded = await reconcile_once(recovered, policy_thread_id="policy-1", services=services)
    assert threaded["implementation_thread_id"] == "implementation-thread"
    assert services.actions == ["create_implementation_thread"]


@pytest.mark.asyncio
async def test_foreign_tracked_pr_is_rejected_before_github_fetch() -> None:
    services = FakeServices(cron_id="cron-1", implementation_thread="implementation-thread")
    services.implementation_metadata = {
        "pr_url": "https://github.com/other/repo/pull/7",
        "pr_number": 7, "pr_state": "open", "branch_name": "open-swe/task", "base_branch": "main"
    }
    state = _base_state("VERIFYING")
    state.update(implementation_thread_id="implementation-thread", implementation_phase="INITIAL")
    result = await reconcile_once(state, policy_thread_id="policy-1", services=services)
    assert result["status"] == "ESCALATED"
    assert result["last_failure_code"] == "PR_REPOSITORY_MISMATCH"


@pytest.mark.asyncio
async def test_review_finalization_rereads_pr_and_refuses_ready_after_head_race() -> None:
    class RacingServices(FakeServices):
        fetch_count = 0
        async def fetch_pr(self, pr_url: str):
            self.fetch_count += 1
            return _pr(HEAD1 if self.fetch_count == 1 else HEAD2)

    services = RacingServices(cron_id="cron-1")
    pair = ("review-thread", "review-run")
    services.current_review = pair
    services.review_snapshots[pair] = ReviewerSnapshot(
        thread_id=pair[0], run_id=pair[1], run_status="success", last_reviewed_sha=HEAD1, findings=()
    )
    state = _base_state("REVIEWING")
    state.update(
        pr_url=PR, observed_head_sha=HEAD1, ci_head_sha=HEAD1,
        reviewer_thread_id=pair[0], reviewer_run_id=pair[1]
    )
    result = await reconcile_once(state, policy_thread_id="policy-1", services=services)
    assert result["status"] == "WAITING_FOR_CI"
    assert result["observed_head_sha"] == HEAD2
    assert result["reviewed_head_sha"] is None


@pytest.mark.asyncio
async def test_missing_required_check_policy_escalates_before_model_dispatch() -> None:
    services = FakeServices(
        cron_id="cron-1", repo_policy=RepositoryPolicy(ci_required=True, required_checks=())
    )
    state = _base_state("NEW")
    result = await reconcile_once(state, policy_thread_id="policy-1", services=services)
    assert result["status"] == "ESCALATED"
    assert result["last_failure_code"] == "REQUIRED_CHECK_POLICY_MISSING"
    assert services.actions == []


@pytest.mark.asyncio
async def test_successful_run_with_wrong_operation_trailer_is_not_credited_as_progress() -> None:
    services = FakeServices(cron_id="cron-1", implementation_thread="implementation-thread")
    services.implementation_metadata = {
        "pr_url": PR, "pr_number": 1, "pr_state": "open",
        "branch_name": "open-swe/task", "base_branch": "main"
    }
    services.pr = _pr(HEAD1)
    services.commits[HEAD1] = CommitEvidence(sha=HEAD1, message="fix: external push")
    state = _base_state("VERIFYING")
    state.update(
        implementation_thread_id="implementation-thread", implementation_run_id="run-1",
        implementation_phase="INITIAL", implementation_operation_key="implementation:policy-1:retry:0"
    )
    result = await reconcile_once(state, policy_thread_id="policy-1", services=services)
    assert result["status"] == "IMPLEMENTING"
    assert result["last_failure_code"] == "HEAD_OPERATION_PROVENANCE_MISSING"
    assert result["run_retry_count"] == 1
    assert result["implementation_operation_key"] is None


@pytest.mark.asyncio
async def test_successful_run_with_matching_operation_trailer_advances_to_ci() -> None:
    services = FakeServices(cron_id="cron-1", implementation_thread="implementation-thread")
    services.implementation_metadata = {
        "pr_url": PR, "pr_number": 1, "pr_state": "open",
        "branch_name": "open-swe/task", "base_branch": "main"
    }
    services.pr = _pr(HEAD1)
    op = "implementation:policy-1:retry:0"
    services.commits[HEAD1] = CommitEvidence(
        sha=HEAD1, message=f"feat: implement\n\nForgeFlow-Operation: {op}"
    )
    state = _base_state("VERIFYING")
    state.update(
        implementation_thread_id="implementation-thread", implementation_run_id="run-1",
        implementation_phase="INITIAL", implementation_operation_key=op
    )
    result = await reconcile_once(state, policy_thread_id="policy-1", services=services)
    assert result["status"] == "WAITING_FOR_CI"
    assert result["observed_head_sha"] == HEAD1


@pytest.mark.asyncio
async def test_repair_is_not_dispatched_if_pr_head_drifted_since_rejection() -> None:
    services = FakeServices(cron_id="cron-1", implementation_thread="implementation-thread", pr=_pr(HEAD2))
    state = _base_state("REPAIRING")
    state.update(
        implementation_thread_id="implementation-thread", implementation_run_id=None,
        pr_url=PR, observed_head_sha=HEAD1, last_failure_code="CHECK_FAILED:tests"
    )
    result = await reconcile_once(state, policy_thread_id="policy-1", services=services)
    assert result["status"] == "WAITING_FOR_CI"
    assert result["observed_head_sha"] == HEAD2
    assert not any(action.startswith("dispatch_child:repair:") for action in services.actions)


@pytest.mark.asyncio
async def test_initial_dispatch_includes_operation_trailer_requirement() -> None:
    prompts = []

    class CaptureServices(FakeServices):
        async def dispatch_implementation(self, **kwargs):
            prompts.append(kwargs["objective"])
            return await super().dispatch_implementation(**kwargs)

    services = CaptureServices(cron_id="cron-1", implementation_thread="implementation-thread")
    state = _base_state("NEW")
    state["implementation_thread_id"] = "implementation-thread"
    result = await reconcile_once(state, policy_thread_id="policy-1", services=services)
    assert result["implementation_operation_key"] == "implementation:policy-1:retry:0"
    assert "ForgeFlow-Operation: implementation:policy-1:retry:0" in prompts[0]


@pytest.mark.asyncio
async def test_default_preflight_moves_blocking_sandbox_probe_off_event_loop(monkeypatch) -> None:
    import threading

    import forgeflow.reconcile as reconcile_module
    from forgeflow.models import RepositoryPreflight
    from forgeflow.state import initial_state

    async def github_ready(_owner: str, _repo: str) -> RepositoryPreflight:
        return RepositoryPreflight(status="READY", installation_id=1)

    caller_thread = threading.get_ident()
    sandbox_threads: list[int] = []

    def sandbox_ready():
        sandbox_threads.append(threading.get_ident())
        return type("SandboxReady", (), {"ready": True})()

    monkeypatch.setattr(reconcile_module, "preflight_github_repository", github_ready)
    monkeypatch.setattr(reconcile_module, "reviewer_sandbox_preflight", sandbox_ready)
    services = reconcile_module.DefaultPolicyServices(client=object())
    result = await services.preflight_repository(
        initial_state(objective="x", repo_owner="o", repo_name="r")
    )
    assert result.status == "READY"
    assert sandbox_threads and sandbox_threads[0] != caller_thread


@pytest.mark.asyncio
async def test_new_policy_can_select_external_runtime_without_changing_default_path() -> None:
    services = FakeServices(
        cron_id="cron-1",
        selected_route=RouteDefinition(
            "antigravity-account-primary",
            "IMPLEMENT",
            5,
            "EXTERNAL_ACP",
            "google-account",
            adapter="antigravity",
        ),
    )
    state = _base_state("NEW")
    selected = await reconcile_once(state, policy_thread_id="policy-external", services=services)
    assert selected["implementation_route_id"] == "antigravity-account-primary"
    assert selected["implementation_runtime"] == "EXTERNAL_ACP"
    assert services.actions == []

    threaded = await reconcile_once(selected, policy_thread_id="policy-external", services=services)
    assert threaded["implementation_thread_id"] == "implementation-thread"
    dispatched = await reconcile_once(threaded, policy_thread_id="policy-external", services=services)
    assert dispatched["status"] == "IMPLEMENTING"
    assert dispatched["implementation_route_id"] == "antigravity-account-primary"
    assert services.actions[-1].startswith("dispatch_child:implementation:policy-external:retry:0")


@pytest.mark.asyncio
async def test_external_runtime_repair_fails_closed_until_same_pr_repair_is_implemented() -> None:
    services = FakeServices(cron_id="cron-1", implementation_thread="implementation-thread", pr=_pr())
    state = _base_state("REPAIRING")
    state.update(
        implementation_route_id="antigravity-account-primary",
        implementation_runtime="EXTERNAL_ACP",
        implementation_thread_id="implementation-thread",
        implementation_run_id=None,
        pr_url=PR,
        observed_head_sha=HEAD1,
        last_failure_code="CHECK_FAILED:tests",
    )
    result = await reconcile_once(state, policy_thread_id="policy-external", services=services)
    assert result["status"] == "ESCALATED"
    assert result["last_failure_code"] == "EXTERNAL_AGENT_REPAIR_NOT_ENABLED"
    assert not any(action.startswith("dispatch_child:repair:") for action in services.actions)


@pytest.mark.asyncio
async def test_legacy_active_implementation_state_is_migrated_to_openswe_route() -> None:
    services = FakeServices(cron_id="cron-1", implementation_thread="implementation-thread")
    state = _base_state("IMPLEMENTING")
    state.update(implementation_thread_id="implementation-thread", implementation_run_id="run-legacy")
    services.child_status["run-legacy"] = "running"
    migrated = await reconcile_once(state, policy_thread_id="legacy-policy", services=services)
    assert migrated["implementation_route_id"] == "openswe-current"
    assert migrated["implementation_runtime"] == "OPEN_SWE"
    assert migrated["status"] == "IMPLEMENTING"


@pytest.mark.asyncio
async def test_route_availability_failure_falls_through_to_next_eligible_route() -> None:
    external = RouteDefinition(
        "antigravity-account-primary",
        "IMPLEMENT",
        5,
        "EXTERNAL_ACP",
        "google-account",
        adapter="antigravity",
    )
    openswe = RouteDefinition(
        "openswe-current", "IMPLEMENT", 10, "OPEN_SWE", "current-model-policy"
    )
    services = FakeServices(
        cron_id="cron-1",
        implementation_thread="external-thread",
        selected_route=external,
        fallback_route=openswe,
        route_fallback_enabled=True,
    )
    state = _base_state("IMPLEMENTING")
    state.update(
        implementation_route_id=external.id,
        implementation_runtime=external.runtime,
        implementation_thread_id="external-thread",
        implementation_run_id="external-run",
        implementation_operation_key="op:external",
    )
    services.child_status["external-run"] = "error"
    services.child_failure_code["external-run"] = "ANTIGRAVITY_PROCESS_EXITED"
    services.child_failure_class["external-run"] = "ROUTE_AVAILABILITY"

    fallback = await reconcile_once(state, policy_thread_id="policy-fallback", services=services)
    assert fallback["status"] == "IMPLEMENTING"
    assert fallback["implementation_failed_route_ids"] == [external.id]
    assert fallback["implementation_route_id"] == openswe.id
    assert fallback["implementation_runtime"] == "OPEN_SWE"
    assert fallback["implementation_thread_id"] is None
    assert fallback["implementation_run_id"] is None
    assert fallback["last_failure_code"] == "ANTIGRAVITY_PROCESS_EXITED"

    threaded = await reconcile_once(fallback, policy_thread_id="policy-fallback", services=services)
    assert threaded["implementation_thread_id"] == "implementation-thread-openswe-current"
    dispatched = await reconcile_once(threaded, policy_thread_id="policy-fallback", services=services)
    assert dispatched["implementation_run_id"] is not None
    assert dispatched["implementation_route_id"] == openswe.id


@pytest.mark.asyncio
async def test_task_failure_does_not_switch_routes() -> None:
    external = RouteDefinition(
        "antigravity-account-primary",
        "IMPLEMENT",
        5,
        "EXTERNAL_ACP",
        "google-account",
        adapter="antigravity",
    )
    openswe = RouteDefinition(
        "openswe-current", "IMPLEMENT", 10, "OPEN_SWE", "current-model-policy"
    )
    services = FakeServices(
        cron_id="cron-1",
        implementation_thread="external-thread",
        selected_route=external,
        fallback_route=openswe,
    )
    state = _base_state("IMPLEMENTING")
    state.update(
        implementation_route_id=external.id,
        implementation_runtime=external.runtime,
        implementation_thread_id="external-thread",
        implementation_run_id="external-run",
    )
    services.child_status["external-run"] = "error"
    services.child_failure_code["external-run"] = "EXTERNAL_AGENT_TEST_FAILED:1"
    services.child_failure_class["external-run"] = "TASK_FAILURE"
    result = await reconcile_once(state, policy_thread_id="policy-task-failure", services=services)
    assert result["implementation_route_id"] == external.id
    assert result["implementation_runtime"] == external.runtime
    assert result["implementation_run_id"] is None
    assert result["run_retry_count"] == 1
    assert result.get("implementation_failed_route_ids", []) == []


@pytest.mark.asyncio
async def test_child_claimed_route_availability_cannot_override_policy_classifier() -> None:
    external = RouteDefinition(
        "antigravity-account-primary",
        "IMPLEMENT",
        5,
        "EXTERNAL_ACP",
        "google-account",
        adapter="antigravity",
    )
    openswe = RouteDefinition(
        "openswe-current", "IMPLEMENT", 10, "OPEN_SWE", "current-model-policy"
    )
    services = FakeServices(
        cron_id="cron-1",
        implementation_thread="external-thread",
        selected_route=external,
        fallback_route=openswe,
        route_fallback_enabled=True,
    )
    state = _base_state("IMPLEMENTING")
    state.update(
        implementation_route_id=external.id,
        implementation_runtime=external.runtime,
        implementation_thread_id="external-thread",
        implementation_run_id="external-run",
    )
    services.child_status["external-run"] = "error"
    services.child_failure_code["external-run"] = "ANTIGRAVITY_TOOL_PERMISSION_DENIED"
    services.child_failure_class["external-run"] = "ROUTE_AVAILABILITY"

    result = await reconcile_once(
        state, policy_thread_id="policy-classifier-authority", services=services
    )

    assert result["implementation_route_id"] == external.id
    assert result["implementation_runtime"] == external.runtime
    assert result["implementation_run_id"] is None
    assert result["run_retry_count"] == 1
    assert result.get("implementation_failed_route_ids", []) == []


@pytest.mark.asyncio
async def test_route_availability_exhaustion_escalates_without_retrying_failed_route() -> None:
    external = RouteDefinition(
        "antigravity-account-primary",
        "IMPLEMENT",
        5,
        "EXTERNAL_ACP",
        "google-account",
        adapter="antigravity",
    )
    services = FakeServices(
        cron_id="cron-1",
        implementation_thread="external-thread",
        selected_route=external,
        route_fallback_enabled=True,
    )
    state = _base_state("IMPLEMENTING")
    state.update(
        implementation_route_id=external.id,
        implementation_runtime=external.runtime,
        implementation_thread_id="external-thread",
        implementation_run_id="external-run",
    )
    services.child_status["external-run"] = "error"
    services.child_failure_code["external-run"] = "ANTIGRAVITY_PROCESS_EXITED"
    services.child_failure_class["external-run"] = "ROUTE_AVAILABILITY"
    result = await reconcile_once(state, policy_thread_id="policy-exhausted", services=services)
    assert result["status"] == "ESCALATED"
    assert result["last_failure_code"] == "IMPLEMENTATION_ROUTE_EXHAUSTED"


@pytest.mark.asyncio
async def test_route_availability_does_not_fall_through_while_global_gate_is_disabled() -> None:
    external = RouteDefinition(
        "antigravity-account-primary",
        "IMPLEMENT",
        5,
        "EXTERNAL_ACP",
        "google-account",
        adapter="antigravity",
    )
    openswe = RouteDefinition(
        "openswe-current", "IMPLEMENT", 10, "OPEN_SWE", "current-model-policy"
    )
    services = FakeServices(
        cron_id="cron-1",
        implementation_thread="external-thread",
        selected_route=external,
        fallback_route=openswe,
        route_fallback_enabled=False,
    )
    state = _base_state("IMPLEMENTING")
    state.update(
        implementation_route_id=external.id,
        implementation_runtime=external.runtime,
        implementation_thread_id="external-thread",
        implementation_run_id="external-run",
    )
    services.child_status["external-run"] = "error"
    services.child_failure_code["external-run"] = "ANTIGRAVITY_PROCESS_EXITED"
    services.child_failure_class["external-run"] = "ROUTE_AVAILABILITY"
    result = await reconcile_once(state, policy_thread_id="policy-gated", services=services)
    assert result["implementation_route_id"] == external.id
    assert result["implementation_run_id"] is None
    assert result["run_retry_count"] == 1
    assert result.get("implementation_failed_route_ids", []) == []
