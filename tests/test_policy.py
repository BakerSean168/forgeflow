import pytest

from forgeflow.models import CiDecision, FindingSummary, ImplementationEvidence, ReviewDecision
from forgeflow.policy import (
    PolicyViolation,
    apply_ci_decision,
    apply_implementation_evidence,
    apply_review_decision,
    cancel,
    mark_repair_dispatched,
    mark_repair_run_terminal,
    mark_run_terminal,
    severity_to_policy,
    start_implementation,
)
from forgeflow.state import ALLOWED_SUCCESSORS, PolicyBudget, initial_state

HEAD_A = "a" * 40
HEAD_B = "b" * 40
PR = "https://github.com/o/r/pull/1"


def _waiting_for_ci():
    state = initial_state(objective="x", repo_owner="o", repo_name="r")
    state = start_implementation(state)
    state = mark_run_terminal(state)
    return apply_implementation_evidence(
        state, ImplementationEvidence(pr_url=PR, pr_number=1, head_sha=HEAD_A, progressed=True)
    )


def _reviewing():
    return apply_ci_decision(_waiting_for_ci(), CiDecision(head_sha=HEAD_A, status="PASS"))


def test_every_status_has_an_explicit_successor_set() -> None:
    assert set(ALLOWED_SUCCESSORS) == {
        "NEW",
        "IMPLEMENTING",
        "VERIFYING",
        "WAITING_FOR_CI",
        "REVIEWING",
        "REPAIRING",
        "READY",
        "ESCALATED",
        "CANCELLED",
    }


def test_happy_path_requires_exact_head_ci_and_review_before_ready() -> None:
    state = _reviewing()
    state = apply_review_decision(
        state,
        ReviewDecision(head_sha=HEAD_A, reviewer_thread_id="rt", reviewer_run_id="rr"),
    )
    assert state["status"] == "READY"
    assert state["ci_head_sha"] == HEAD_A
    assert state["reviewed_head_sha"] == HEAD_A


def test_ready_cannot_be_synthesized_from_wrong_phase() -> None:
    state = initial_state(objective="x", repo_owner="o", repo_name="r")
    with pytest.raises(PolicyViolation):
        apply_review_decision(
            state,
            ReviewDecision(head_sha=HEAD_A, reviewer_thread_id="rt", reviewer_run_id="rr"),
        )


def test_stale_ci_is_rejected() -> None:
    with pytest.raises(PolicyViolation):
        apply_ci_decision(_waiting_for_ci(), CiDecision(head_sha=HEAD_B, status="PASS"))


def test_stale_review_is_rejected() -> None:
    with pytest.raises(PolicyViolation):
        apply_review_decision(
            _reviewing(),
            ReviewDecision(head_sha=HEAD_B, reviewer_thread_id="rt", reviewer_run_id="rr"),
        )


def test_no_progress_retries_same_lifecycle_then_escalates() -> None:
    budget = PolicyBudget(no_progress_retries=2)
    state = initial_state(objective="x", repo_owner="o", repo_name="r")
    for expected_retry in (1, 2):
        state = start_implementation(state) if state["status"] == "NEW" else state
        state = mark_run_terminal(state)
        state = apply_implementation_evidence(
            state,
            ImplementationEvidence(pr_url="", pr_number=0, head_sha="", progressed=False),
            budget=budget,
        )
        assert state["status"] == "IMPLEMENTING"
        assert state["run_retry_count"] == expected_retry
    state = mark_run_terminal(state)
    state = apply_implementation_evidence(
        state,
        ImplementationEvidence(pr_url="", pr_number=0, head_sha="", progressed=False),
        budget=budget,
    )
    assert state["status"] == "ESCALATED"


def test_new_head_invalidates_old_ci_and_review_evidence() -> None:
    state = _reviewing()
    state["reviewed_head_sha"] = HEAD_A
    state["reviewer_run_id"] = "old-review"
    state["blocking_finding_ids"] = ["old"]
    state["status"] = "VERIFYING"
    state = apply_implementation_evidence(
        state, ImplementationEvidence(pr_url=PR, pr_number=1, head_sha=HEAD_B, progressed=True)
    )
    assert state["status"] == "WAITING_FOR_CI"
    assert "ci_head_sha" not in state
    assert "reviewed_head_sha" not in state
    assert "reviewer_run_id" not in state
    assert state["blocking_finding_ids"] == []


def test_pending_ci_does_not_advance_or_consume_repair_budget() -> None:
    state = _waiting_for_ci()
    pending = apply_ci_decision(state, CiDecision(head_sha=HEAD_A, status="PENDING"))
    assert pending["status"] == "WAITING_FOR_CI"
    assert pending["repair_round"] == 0


def test_failed_ci_enters_repair_without_incrementing_until_dispatch() -> None:
    state = apply_ci_decision(
        _waiting_for_ci(), CiDecision(head_sha=HEAD_A, status="FAIL", failure_code="tests")
    )
    assert state["status"] == "REPAIRING"
    assert state["repair_round"] == 0
    state = mark_repair_dispatched(state)
    assert state["repair_round"] == 1


def test_blocking_review_enters_repair() -> None:
    state = apply_review_decision(
        _reviewing(),
        ReviewDecision(
            head_sha=HEAD_A,
            reviewer_thread_id="rt",
            reviewer_run_id="rr",
            findings=(FindingSummary(id="f1", severity="high"),),
        ),
    )
    assert state["status"] == "REPAIRING"
    assert state["blocking_finding_ids"] == ["f1"]


def test_low_findings_do_not_block_ready() -> None:
    state = apply_review_decision(
        _reviewing(),
        ReviewDecision(
            head_sha=HEAD_A,
            reviewer_thread_id="rt",
            reviewer_run_id="rr",
            findings=(FindingSummary(id="f1", severity="low"),),
        ),
    )
    assert state["status"] == "READY"


def test_resolved_high_findings_do_not_block_ready() -> None:
    state = apply_review_decision(
        _reviewing(),
        ReviewDecision(
            head_sha=HEAD_A,
            reviewer_thread_id="rt",
            reviewer_run_id="rr",
            findings=(FindingSummary(id="f1", severity="high", status="resolved"),),
        ),
    )
    assert state["status"] == "READY"


def test_repair_budget_escalates_instead_of_sixth_repair() -> None:
    state = apply_ci_decision(
        _waiting_for_ci(), CiDecision(head_sha=HEAD_A, status="FAIL")
    )
    state["repair_round"] = 5
    state = mark_repair_dispatched(state)
    assert state["status"] == "ESCALATED"


def test_repair_run_returns_to_evidence_verification() -> None:
    state = apply_ci_decision(
        _waiting_for_ci(), CiDecision(head_sha=HEAD_A, status="FAIL")
    )
    state = mark_repair_dispatched(state)
    state = mark_repair_run_terminal(state)
    assert state["status"] == "VERIFYING"


def test_cancel_is_terminal_and_idempotent() -> None:
    state = cancel(_waiting_for_ci())
    assert state["status"] == "CANCELLED"
    assert cancel(state) == state


@pytest.mark.parametrize(
    ("source", "expected"),
    [("critical", "P0"), ("high", "P1"), ("medium", "P2"), ("low", "P3")],
)
def test_severity_mapping(source, expected) -> None:
    assert severity_to_policy(source) == expected
