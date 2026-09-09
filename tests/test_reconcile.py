from dataclasses import dataclass, field

import pytest

from forgeflow.adapters.github import CiSignals, PullRequestEvidence
from forgeflow.adapters.openswe import ChildRunSnapshot, ReviewerSnapshot, ThreadSnapshot
from forgeflow.graph import build_forgeflow_graph
from forgeflow.models import RepositoryPolicy
from forgeflow.reconcile import reconcile_once
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
    current_review: tuple[str, str] | None = None
    review_snapshots: dict[tuple[str, str], ReviewerSnapshot] = field(default_factory=dict)
    crash_child_once: bool = False
    crash_review_once: bool = False
    crash_repair_once: bool = False
    _child_sequence: int = 0
    _review_sequence: int = 0

    async def ensure_reconcile_cron(self, policy_thread_id: str) -> str:
        if self.cron_id is None:
            self.actions.append("create_cron")
            self.cron_id = "cron-1"
        return self.cron_id

    async def delete_reconcile_cron(self, cron_id: str) -> None:
        if self.cron_id == cron_id:
            self.actions.append("delete_cron")
            self.cron_id = None

    async def ensure_implementation_thread(
        self, *, policy_thread_id: str, repo_owner: str, repo_name: str, objective: str
    ) -> str:
        if self.implementation_thread is None:
            self.actions.append("create_implementation_thread")
            self.implementation_thread = "implementation-thread"
        return self.implementation_thread

    async def find_child_run(self, *, thread_id: str, operation_key: str) -> str | None:
        return self.child_operations.get(operation_key)

    async def dispatch_implementation(
        self,
        *,
        thread_id: str,
        objective: str,
        repo_owner: str,
        repo_name: str,
        operation_key: str,
    ) -> str:
        return self._dispatch_child(operation_key, crash_attr="crash_child_once")

    async def dispatch_repair(
        self,
        *,
        thread_id: str,
        prompt: str,
        repo_owner: str,
        repo_name: str,
        operation_key: str,
    ) -> str:
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

    async def read_child_run(self, *, thread_id: str, run_id: str) -> ChildRunSnapshot:
        return ChildRunSnapshot(thread_id=thread_id, run_id=run_id, status=self.child_status[run_id])

    async def read_implementation_thread(self, thread_id: str) -> ThreadSnapshot:
        return ThreadSnapshot(thread_id=thread_id, status="idle", metadata=self.implementation_metadata)

    async def fetch_pr(self, pr_url: str) -> PullRequestEvidence | None:
        return self.pr

    async def fetch_ci(self, pr: PullRequestEvidence) -> CiSignals | None:
        return self.ci

    def repository_policy(self, state: ForgeFlowState) -> RepositoryPolicy:
        return RepositoryPolicy(ci_required=True)

    async def find_current_review(
        self, *, pr_url: str, expected_head_sha: str
    ) -> tuple[str, str] | None:
        if self.current_review is None:
            return None
        snapshot = self.review_snapshots.get(self.current_review)
        if snapshot is None or snapshot.last_reviewed_sha != expected_head_sha:
            return None
        return self.current_review

    async def trigger_review(self, pr_url: str) -> tuple[str, str]:
        self._review_sequence += 1
        pair = ("review-thread", f"review-run-{self._review_sequence}")
        self.current_review = pair
        head = self.pr.head_sha if self.pr else HEAD1
        self.review_snapshots[pair] = ReviewerSnapshot(
            thread_id=pair[0],
            run_id=pair[1],
            run_status="running",
            last_reviewed_sha=head,
            findings=(),
        )
        self.actions.append(f"trigger_review:{pair[1]}")
        if self.crash_review_once:
            self.crash_review_once = False
            raise SimulatedCrash("crashed after official reviewer run was created")
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
    services = FakeServices(cron_id="cron-1", implementation_thread="implementation-thread")
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
    assert services.current_review is not None
    action_count = len(services.actions)

    recovered = await reconcile_once(state, policy_thread_id="policy-1", services=services)
    assert len(services.actions) == action_count
    assert (recovered["reviewer_thread_id"], recovered["reviewer_run_id"]) == services.current_review


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
    state = _base_state("READY")
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
async def test_new_external_head_invalidates_checkpointed_exact_head_evidence_in_graph() -> None:
    services = FakeServices(cron_id="cron-1", pr=_pr(HEAD2))
    state = _base_state("REVIEWING")
    state.update(
        pr_url=PR,
        observed_head_sha=HEAD1,
        ci_head_sha=HEAD1,
        reviewed_head_sha=HEAD1,
        reviewer_thread_id="rt",
        reviewer_run_id="rr",
        blocking_finding_ids=["f1"],
    )
    graph = build_forgeflow_graph(services=services)
    result = await graph.ainvoke(state, {"configurable": {"thread_id": "policy-1"}})
    assert result["status"] == "WAITING_FOR_CI"
    assert result["observed_head_sha"] == HEAD2
    assert result["ci_head_sha"] is None
    assert result["reviewed_head_sha"] is None
    assert result["reviewer_run_id"] is None
    assert result["blocking_finding_ids"] == []
