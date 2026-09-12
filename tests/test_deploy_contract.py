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


def test_route_registry_and_attempt_ledger_are_deployed_fail_closed() -> None:
    install = (DEPLOY / "install.sh").read_text(encoding="utf-8")
    start = (DEPLOY / "start-forgeflow-policy.sh").read_text(encoding="utf-8")
    default_routes = (DEPLOY / "routes.default.json").read_text(encoding="utf-8")
    canary = (DEPLOY / "run-external-agent-project-canary.py").read_text(encoding="utf-8")
    assert "routes.default.json" in install
    assert "forgeflow.routing validate" in install
    assert "FORGEFLOW_ROUTE_CONFIG_FILE" in start
    assert "FORGEFLOW_ATTEMPT_LEDGER_FILE" in start
    assert '"enabled": false' in default_routes
    assert '"id": "openswe-current"' in default_routes
    assert "AttemptLedger" in canary
    assert "classify_failure_code" in canary
