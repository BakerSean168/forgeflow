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
    assert "/usr/local/libexec/forgeflow-*" not in purge
    assert "litellm.env" in purge and "preserved" in purge


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


def test_reviewer_sandbox_defaults_to_self_hosted_docker_not_local() -> None:
    start = (DEPLOY / "start-forgeflow-policy.sh").read_text(encoding="utf-8")
    installer = (DEPLOY / "install.sh").read_text(encoding="utf-8")
    assert 'SANDBOX_TYPE="${SANDBOX_TYPE:-docker}"' in start
    assert 'SANDBOX_TYPE="${SANDBOX_TYPE:-local}"' not in start
    assert 'setup-docker-sandbox.sh' in installer


def test_docker_sandbox_firewall_is_reapplied_with_docker_daemon() -> None:
    unit = (DEPLOY / "forgeflow-openswe-sandbox-network.service.in").read_text(encoding="utf-8")
    ensure = (DEPLOY / "ensure-docker-sandbox-network.sh").read_text(encoding="utf-8")
    assert "PartOf=docker.service" in unit
    assert "After=docker.service" in unit
    assert "DOCKER-USER" in ensure
    assert "169.254.0.0/16" in ensure
    assert "169.254.169.254/32" in ensure
    assert "obsolete_destinations" in ensure
    assert ' -D DOCKER-USER ' in ensure
    assert "100.64.0.0/10" in ensure


def test_broker_unit_has_no_writable_state_directory() -> None:
    unit = (DEPLOY / "open-swe-codex-broker.service.in").read_text(encoding="utf-8")
    assert "ReadWritePaths=@STATE_DIR@" not in unit
    assert "ReadOnlyPaths=@STATE_DIR@/codex-broker.secret" in unit


def test_installer_requires_systemd_user_linger() -> None:
    installer = (DEPLOY / "install.sh").read_text(encoding="utf-8")
    assert 'loginctl show-user "$USER" -p Linger --value' in installer
    assert '[[ "$linger" == yes ]]' in installer


def test_purge_verifies_authenticated_replacement_before_destructive_deletion() -> None:
    purge = (DEPLOY / "purge-legacy.sh").read_text(encoding="utf-8")
    preflight = purge.index("replacement_preflight")
    destructive = purge.index("docker rm -f forgeflow-openhands")
    assert preflight < destructive
    assert "/assistants/search" in purge
    assert 'Authorization: Bearer $auth' in purge
    assert 'Authorization: Bearer $broker_token' in purge
    assert "FragmentPath" in purge and "ExecStart" in purge
    assert "legacy unit is still active after stop" in purge


def test_purge_uses_exact_legacy_file_list_and_removes_apparmor_but_preserves_litellm() -> None:
    purge = (DEPLOY / "purge-legacy.sh").read_text(encoding="utf-8")
    assert "/usr/local/libexec/forgeflow-*" not in purge
    for name in (
        "forgeflow-antigravity-git-provenance.mjs",
        "forgeflow-antigravity-sandbox.sh",
        "forgeflow-antigravity-unit.mjs",
        "forgeflow-artifact-digest.sh",
        "forgeflow-prune-host-cache.sh",
        "forgeflow-self-promote.sh",
    ):
        assert name in purge
    assert "/etc/apparmor.d/forgeflow-openhands-codex" in purge
    assert "sudo -n grep -q '^forgeflow-openhands-codex '" in purge
    assert 'sudo -n apparmor_parser -R "$apparmor_profile"' in purge
    assert "command -v apparmor_parser" not in purge
    assert "/etc/forgeflow/openhands-literal-worktrees.override.yml" in purge
    assert "litellm.env" in purge and "preserved" in purge


def test_docker_sandbox_gc_is_hourly_bounded_and_not_part_of_policy_runtime() -> None:
    installer = (DEPLOY / "install.sh").read_text(encoding="utf-8")
    service = (DEPLOY / "forgeflow-openswe-sandbox-gc.service.in").read_text(encoding="utf-8")
    timer = (DEPLOY / "forgeflow-openswe-sandbox-gc.timer.in").read_text(encoding="utf-8")
    assert "forgeflow-openswe-sandbox-gc.timer" in installer
    assert "OPEN_SWE_DOCKER_IDLE_TTL_SECONDS=86400" in service
    assert "python -m openswe_ext.docker_gc" in service
    assert "OnUnitActiveSec=1h" in timer
    assert "Persistent=true" in timer
