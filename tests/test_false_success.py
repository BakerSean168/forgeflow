"""Regression for the observed Open SWE 429 -> run success -> no work false positive."""

from forgeflow.evidence import implementation_evidence
from forgeflow.models import ImplementationEvidence
from forgeflow.policy import apply_implementation_evidence, mark_run_terminal, start_implementation
from forgeflow.state import initial_state


def test_success_status_without_repository_delta_never_reaches_ci_or_ready() -> None:
    state = initial_state(objective="x", repo_owner="o", repo_name="r")
    state = start_implementation(state)

    # LangGraph/Open SWE says success, but the model did no repository work.
    observation: ImplementationEvidence = implementation_evidence(
        state,
        run_status="success",
        tracked_pr=None,
        authoritative_pr=None,
    )
    state = mark_run_terminal(state)
    state = apply_implementation_evidence(state, observation)

    assert state["status"] == "IMPLEMENTING"
    assert state["run_retry_count"] == 1
    assert state["last_failure_code"] == "NO_PROGRESS_NO_TRACKED_PR"
    assert "ci_head_sha" not in state
    assert "reviewed_head_sha" not in state
