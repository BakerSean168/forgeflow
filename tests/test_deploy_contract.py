import json
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
    default_routes = json.loads((DEPLOY / "routes.default.json").read_text(encoding="utf-8"))
    canary = (DEPLOY / "run-external-agent-project-canary.py").read_text(encoding="utf-8")
    assert "projects.default.json" in install
    assert "migrate_project_defaults.py" in install
    assert '--current "$config_dir/projects.json"' in install
    assert '--target-default "$root/deploy/gcp-dev/projects.default.json"' in install
    assert "routes.default.json" in install
    assert "migrate_route_defaults.py" in install
    assert '--current "$config_dir/routes.json"' in install
    assert '--target-default "$root/deploy/gcp-dev/routes.default.json"' in install
    assert "forgeflow.routing validate" in install
    assert "FORGEFLOW_ROUTE_CONFIG_FILE" in start
    assert "FORGEFLOW_ATTEMPT_LEDGER_FILE" in start
    assert "FORGEFLOW_RESOURCE_PROBE_FILE" in start
    routes = {route["id"]: route for route in default_routes["routes"]}
    assert routes["openswe-current"]["enabled"] is True
    assert routes["openswe-current"]["priority"] == 10
    assert routes["openswe-current"]["runtime"] == "OPEN_SWE"
    assert routes["antigravity-account-primary"]["enabled"] is True
    assert routes["antigravity-account-primary"]["priority"] == 20
    assert routes["antigravity-account-primary"]["runtime"] == "EXTERNAL_ACP"
    assert "AttemptLedger" in canary
    assert "classify_failure_code" in canary


def test_external_agent_graph_is_registered_without_becoming_an_openswe_graph_alias() -> None:
    root = DEPLOY.parents[1]
    config = json.loads((root / "langgraph.json").read_text(encoding="utf-8"))
    assert config["graphs"]["external_agent"] == (
        "openswe_ext.external_agent_graph:get_external_agent_graph"
    )
    installer = (DEPLOY / "install.sh").read_text(encoding="utf-8")
    assert '"external_agent"' in installer
    assert "$state_dir/external-agent-workspaces" in installer


def test_external_agent_route_and_availability_fallback_are_enabled_by_default() -> None:
    start = (DEPLOY / "start-forgeflow-policy.sh").read_text(encoding="utf-8")
    assert (
        'FORGEFLOW_ANTIGRAVITY_ACP_ENABLED="${FORGEFLOW_ANTIGRAVITY_ACP_ENABLED:-true}"'
        in start
    )
    assert (
        'FORGEFLOW_AUTOMATIC_ROUTE_FALLBACK_ENABLED="${FORGEFLOW_AUTOMATIC_ROUTE_FALLBACK_ENABLED:-true}"'
        in start
    )


def test_example_project_manifest_documents_external_agent_validation_command() -> None:
    payload = json.loads(Path("deploy/gcp-dev/projects.example.json").read_text(encoding="utf-8"))
    assert payload[0]["external_agent_test_command"] == ["uv", "run", "pytest", "-q"]


def test_operator_api_is_mounted_inside_the_existing_openswe_webapp() -> None:
    root = DEPLOY.parents[1]
    config = json.loads((root / "langgraph.json").read_text(encoding="utf-8"))
    assert config["http"]["app"] == "openswe_ext.webapp:app"
    extension = (root / "openswe_ext/webapp.py").read_text(encoding="utf-8")
    assert "from agent.webapp import app" in extension
    assert "include_router" in extension
    assert "8420" not in extension


def test_invariant_supervisor_is_separate_low_frequency_failure_domain() -> None:
    root = DEPLOY.parents[1]
    config = json.loads((root / "langgraph.json").read_text(encoding="utf-8"))
    assert config["graphs"]["invariant_reviewer"] == (
        "forgeflow.invariant_reviewer_graph:get_invariant_reviewer_graph"
    )
    timer = (DEPLOY / "forgeflow-invariant-supervisor.timer.in").read_text(encoding="utf-8")
    service = (DEPLOY / "forgeflow-invariant-supervisor.service.in").read_text(encoding="utf-8")
    installer = (DEPLOY / "install.sh").read_text(encoding="utf-8")
    assert "OnUnitActiveSec=1h" in timer
    assert "run-invariant-supervisor.py" in service
    assert "enable --now forgeflow-invariant-supervisor.timer" in installer


def test_invariant_proposal_operator_view_is_read_only_and_bounded() -> None:
    viewer = (DEPLOY / "show-invariant-proposals.py").read_text(encoding="utf-8")
    assert "discover_proposals" in viewer
    assert "pending_proposals" in viewer
    assert "accepted_dynamic_rules" in viewer
    assert "record_proposal_decision" not in viewer


def test_invariant_operator_views_use_project_python_and_run_outside_repo(tmp_path) -> None:
    import os
    import subprocess

    state = tmp_path / "state"
    state.mkdir()
    env = os.environ.copy()
    env["FORGEFLOW_POLICY_STATE_DIR"] = str(state)
    for name in ("show-invariant-learning.py", "show-invariant-proposals.py"):
        script = DEPLOY / name
        assert script.read_text(encoding="utf-8").startswith(
            "#!/usr/bin/env -S uv run --no-project --python 3.14 python\n"
        )
        result = subprocess.run(
            [str(script), "BakerSean168/MemoFlow"],
            cwd=tmp_path,
            env=env,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip().startswith(("[", "{"))
        assert "Installed " not in result.stderr
        assert not (tmp_path / ".venv").exists()


def test_project_supervisor_is_stateless_opt_in_and_runs_frequently() -> None:
    timer = (DEPLOY / "forgeflow-project-supervisor.timer.in").read_text(encoding="utf-8")
    service = (DEPLOY / "forgeflow-project-supervisor.service.in").read_text(encoding="utf-8")
    installer = (DEPLOY / "install.sh").read_text(encoding="utf-8")
    defaults = json.loads((DEPLOY / "projects.default.json").read_text(encoding="utf-8"))
    memoflow = next(item for item in defaults if item.get("project_key") == "memoflow")
    assert "OnUnitActiveSec=2min" in timer
    assert "run-project-supervisor.py" in service
    assert "EnvironmentFile=-@CONFIG_DIR@/github-app.env" in service
    assert "enable --now forgeflow-project-supervisor.timer" in installer
    assert memoflow["continuous_supervisor"]["enabled"] is False
    assert memoflow["continuous_supervisor"]["auto_merge_ready"] is True
