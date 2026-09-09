from forgeflow.adapters.github import PullRequestEvidence
from forgeflow.adapters.openswe import ReviewerSnapshot
from forgeflow.evidence import (
    blocking_repair_findings,
    implementation_evidence,
    review_decision,
    tracked_pull_request,
)
from forgeflow.models import CiDecision, ImplementationEvidence
from forgeflow.policy import (
    apply_ci_decision,
    apply_implementation_evidence,
    apply_review_decision,
    mark_repair_dispatched,
    mark_repair_run_terminal,
    mark_run_terminal,
    start_implementation,
)
from forgeflow.prompts.repair import build_review_repair_prompt
from forgeflow.state import initial_state

PR = "https://github.com/o/r/pull/1"
BASE = "a" * 40
HEAD1 = "b" * 40
HEAD2 = "c" * 40


def _tracked():
    result = tracked_pull_request(
        {
            "pr_url": PR,
            "pr_number": 1,
            "pr_state": "open",
            "branch_name": "open-swe/task",
            "base_branch": "main",
        }
    )
    assert result is not None
    return result


def _pr(head):
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


def _review(head, *, status="open"):
    return ReviewerSnapshot(
        thread_id="review-thread",
        run_id=f"review-{head[:4]}",
        run_status="success",
        last_reviewed_sha=head,
        findings=(
            {
                "id": "f1",
                "severity": "high",
                "status": status,
                "title": "Stale result can overwrite current intent",
                "file": "src/search.ts",
                "start_line": 42,
                "end_line": 44,
                "description": "An older request can still commit after a newer input arrives.",
            },
        ),
    )


def test_review_repair_rereview_reaches_ready_only_on_new_exact_head() -> None:
    state = initial_state(objective="fix search", repo_owner="o", repo_name="r")
    state = start_implementation(state)
    state = mark_run_terminal(state)
    initial_evidence: ImplementationEvidence = implementation_evidence(
        state, run_status="success", tracked_pr=_tracked(), authoritative_pr=_pr(HEAD1)
    )
    state = apply_implementation_evidence(state, initial_evidence)
    state = apply_ci_decision(state, CiDecision(head_sha=HEAD1, status="PASS"))

    first_snapshot = _review(HEAD1)
    state = apply_review_decision(state, review_decision(first_snapshot, expected_head_sha=HEAD1))
    assert state["status"] == "REPAIRING"
    findings = blocking_repair_findings(first_snapshot, expected_head_sha=HEAD1)
    prompt = build_review_repair_prompt(pr_url=PR, rejected_head_sha=HEAD1, findings=findings)
    assert "f1" in prompt and HEAD1 in prompt and "existing branch and PR" in prompt

    state = mark_repair_dispatched(state)
    assert state["repair_round"] == 1
    state = mark_repair_run_terminal(state)
    repaired_evidence = implementation_evidence(
        state, run_status="success", tracked_pr=_tracked(), authoritative_pr=_pr(HEAD2)
    )
    state = apply_implementation_evidence(state, repaired_evidence)
    assert state["observed_head_sha"] == HEAD2
    assert "reviewed_head_sha" not in state
    assert "ci_head_sha" not in state

    state = apply_ci_decision(state, CiDecision(head_sha=HEAD2, status="PASS"))
    second_snapshot = _review(HEAD2, status="resolved")
    state = apply_review_decision(state, review_decision(second_snapshot, expected_head_sha=HEAD2))
    assert state["status"] == "READY"
    assert state["reviewed_head_sha"] == HEAD2
    assert state["blocking_finding_ids"] == []


def test_repair_prompt_is_bounded_and_does_not_embed_unlimited_review_text() -> None:
    snapshot = ReviewerSnapshot(
        thread_id="rt",
        run_id="rr",
        run_status="success",
        last_reviewed_sha=HEAD1,
        findings=(
            {
                "id": "f1",
                "severity": "medium",
                "status": "open",
                "title": "x" * 1000,
                "file": "src/x.ts",
                "start_line": 1,
                "end_line": 1,
                "description": "y" * 10000,
            },
        ),
    )
    prompt = build_review_repair_prompt(
        pr_url=PR,
        rejected_head_sha=HEAD1,
        findings=blocking_repair_findings(snapshot, expected_head_sha=HEAD1),
    )
    assert len(prompt) < 4000
    assert "y" * 2000 not in prompt
