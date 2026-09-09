import pytest

from forgeflow.adapters.github import CiSignals
from forgeflow.evidence import ci_decision
from forgeflow.models import RepositoryPolicy
from forgeflow.policy import PolicyViolation, apply_ci_decision
from forgeflow.state import initial_state

HEAD = "a" * 40
OTHER = "b" * 40


def _signals(*, checks=(), statuses=(), head=HEAD):
    return CiSignals(head_sha=head, check_runs=tuple(checks), statuses=tuple(statuses))


def _waiting_state(head=HEAD):
    state = initial_state(objective="x", repo_owner="o", repo_name="r")
    state["status"] = "WAITING_FOR_CI"
    state["observed_head_sha"] = head
    return state


def test_no_ci_is_unresolved_when_required() -> None:
    decision = ci_decision(_signals(), RepositoryPolicy(ci_required=True))
    assert decision.status == "UNRESOLVED"
    assert decision.failure_code == "NO_CI_SIGNALS"


def test_no_ci_can_pass_only_when_repo_explicitly_disables_ci() -> None:
    decision = ci_decision(_signals(), RepositoryPolicy(ci_required=False))
    assert decision.status == "PASS"


def test_pending_check_keeps_gate_pending() -> None:
    decision = ci_decision(
        _signals(checks=({"name": "tests", "status": "in_progress", "conclusion": None},)),
        RepositoryPolicy(),
    )
    assert decision.status == "PENDING"


def test_failed_check_enters_repair() -> None:
    decision = ci_decision(
        _signals(checks=({"name": "tests", "status": "completed", "conclusion": "failure"},)),
        RepositoryPolicy(),
    )
    assert decision.status == "FAIL"
    state = apply_ci_decision(_waiting_state(), decision)
    assert state["status"] == "REPAIRING"


def test_success_neutral_and_skipped_are_accepted_terminal_checks() -> None:
    decision = ci_decision(
        _signals(
            checks=(
                {"name": "tests", "status": "completed", "conclusion": "success"},
                {"name": "lint", "status": "completed", "conclusion": "neutral"},
                {"name": "optional", "status": "completed", "conclusion": "skipped"},
            ),
            statuses=({"context": "deploy", "state": "success"},),
        ),
        RepositoryPolicy(),
    )
    assert decision.status == "PASS"
    assert apply_ci_decision(_waiting_state(), decision)["status"] == "REVIEWING"


def test_required_check_names_ignore_unrelated_failures_but_require_all_named_checks() -> None:
    policy = RepositoryPolicy(required_checks=("tests", "lint"))
    missing = ci_decision(
        _signals(checks=({"name": "tests", "status": "completed", "conclusion": "success"},)),
        policy,
    )
    assert missing.status == "UNRESOLVED"
    assert missing.failure_code == "MISSING_REQUIRED_CHECK:lint"

    passing = ci_decision(
        _signals(
            checks=(
                {"name": "tests", "status": "completed", "conclusion": "success"},
                {"name": "lint", "status": "completed", "conclusion": "success"},
                {"name": "unrelated", "status": "completed", "conclusion": "failure"},
            )
        ),
        policy,
    )
    assert passing.status == "PASS"


def test_old_head_green_ci_cannot_pass_new_head() -> None:
    decision = ci_decision(
        _signals(
            head=OTHER,
            checks=({"name": "tests", "status": "completed", "conclusion": "success"},),
        ),
        RepositoryPolicy(),
    )
    with pytest.raises(PolicyViolation):
        apply_ci_decision(_waiting_state(HEAD), decision)
