from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEPLOY = REPO / "deploy/gcp-dev"


def test_new_service_runs_full_langgraph_overlay_not_legacy_runtime() -> None:
    service = (DEPLOY / "forgeflow-policy.service.in").read_text(encoding="utf-8")
    start = (DEPLOY / "start-forgeflow-policy.sh").read_text(encoding="utf-8")
    assert "langgraph dev" in start
    assert "--config langgraph.json" in start
    assert "open-swe-codex-broker.service" in service
    assert "node dist/main.js" not in service + start
    assert "OpenHands" not in service + start


def test_deployment_uses_loopback_and_external_secret_files() -> None:
    start = (DEPLOY / "start-forgeflow-policy.sh").read_text(encoding="utf-8")
    broker = (DEPLOY / "codex_oauth_broker.py").read_text(encoding="utf-8")
    assert "--host 127.0.0.1" in start
    assert 'http://127.0.0.1:${broker_port}/token' in start
    assert '("127.0.0.1", PORT)' in broker
    assert ".codex/auth.json" in broker
    assert "GITHUB_APP_PRIVATE_KEY=" not in start


def test_legacy_purge_is_explicit_guarded_and_scoped() -> None:
    purge = (DEPLOY / "purge-legacy.sh").read_text(encoding="utf-8")
    assert 'FORGEFLOW_POLICY_CONFIRM_PURGE:-' in purge
    assert "systemctl --user is-active --quiet forgeflow-policy.service" in purge
    assert "/var/lib/forgeflow" in purge
    assert "forgeflow-openhands-agent-server:1.39.1-source" in purge
    assert "/usr/local/libexec/forgeflow-*" in purge
    assert "litellm.env" in purge and "Do not delete" in purge


def test_user_units_avoid_capability_hardening_unsupported_on_gcp_dev() -> None:
    units = "\n".join(
        (DEPLOY / name).read_text(encoding="utf-8")
        for name in ("forgeflow-policy.service.in", "open-swe-codex-broker.service.in")
    )
    assert "PrivateDevices=true" not in units
    assert "ProtectKernelModules=true" not in units
    assert "NoNewPrivileges=true" in units
    assert "ProtectSystem=" in units


def test_legacy_purge_parses_systemd_units_without_decorative_bullets() -> None:
    purge = (DEPLOY / "purge-legacy.sh").read_text(encoding="utf-8")
    assert "--plain --no-legend" in purge
    assert "reset-failed 'forgeflow-antigravity@*.service'" in purge


def test_github_app_preflight_is_secret_free_and_fail_closed() -> None:
    check = (DEPLOY / "check-github-app.sh").read_text(encoding="utf-8")
    docs = (REPO / "docs/github-app.md").read_text(encoding="utf-8")
    assert "python -m forgeflow.preflight github" in check
    assert "CONFIG_MISSING" in check
    assert "GITHUB_APP_PRIVATE_KEY" not in check
    assert "GITHUB_APP_NOT_CONFIGURED" in docs
    assert "GITHUB_APP_REPO_OR_PERMISSION_UNAVAILABLE" in docs
