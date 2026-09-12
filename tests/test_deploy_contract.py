from pathlib import Path

DEPLOY = Path(__file__).resolve().parents[1] / "deploy/gcp-dev"


def test_pr_review_gate_is_exact_head_and_keeps_auth_internal() -> None:
    gate = (DEPLOY / "run-pr-review-gate.py").read_text(encoding="utf-8")
    assert "local-auth.secret" in gate
    assert "--expected-head" in gate
    assert "review_decision" in gate
    assert "find_current_review" in gate
    assert "OpenSweReviewerRuntime" in gate
    assert "print(auth)" not in gate
    assert '"Authorization": f"Bearer {auth}"' in gate
