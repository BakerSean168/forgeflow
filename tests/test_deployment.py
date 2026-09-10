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



def test_gitignore_covers_langgraph_state_directory_and_symlink() -> None:
    gitignore = (REPO / ".gitignore").read_text(encoding="utf-8").splitlines()
    assert "/.langgraph_api" in gitignore
    assert ".langgraph_api/" not in gitignore


def test_installer_binds_langgraph_state_before_restart_and_restarts_broker() -> None:
    installer = (DEPLOY / "install.sh").read_text(encoding="utf-8")
    start = (DEPLOY / "start-forgeflow-policy.sh").read_text(encoding="utf-8")
    stop_at = installer.index("systemctl --user stop forgeflow-policy.service")
    verify_stopped_at = installer.index("is still active; refusing LangGraph state migration")
    migrate_at = installer.index("migrate_langgraph_state.py")
    restart_at = installer.index("systemctl --user restart forgeflow-policy.service")
    assert stop_at < verify_stopped_at < migrate_at < restart_at
    assert 'systemctl --user stop forgeflow-policy.service 2>/dev/null || true' not in installer
    assert 'WorkingDirectory --value' in installer
    assert 'policy_was_active=false' in installer
    assert 'if ! python3 "$root/deploy/gcp-dev/migrate_langgraph_state.py"' in installer
    assert 'systemctl --user start forgeflow-policy.service || true' in installer
    assert 'systemctl --user restart open-swe-codex-broker.service' in installer
    assert 'enable --now open-swe-codex-broker.service' not in installer
    assert 'langgraph_state_dir="$state_dir/langgraph"' in start
    assert 'expected_langgraph_state="$(readlink -f "$langgraph_state_dir"' in start
    assert 'readlink -f "$langgraph_root_link"' in start
    assert 'set -Eeuo pipefail' in installer
    assert 'trap restore_policy_on_error ERR' in installer
    assert 'policy_restore_pending=false' in installer
    assert 'trap - ERR' in installer


def test_start_script_accepts_canonical_equivalent_langgraph_state_path(tmp_path: Path) -> None:
    import os
    import subprocess

    home = tmp_path / "home"
    root = tmp_path / "repo"
    config = home / ".config/forgeflow-policy"
    state = home / ".local/share/forgeflow-policy"
    stable = state / "langgraph"
    uv = home / ".local/bin/uv"
    root.mkdir(parents=True)
    config.mkdir(parents=True)
    stable.mkdir(parents=True)
    uv.parent.mkdir(parents=True)
    (config / "local-auth.secret").write_text("auth", encoding="utf-8")
    (config / "projects.json").write_text("[]\n", encoding="utf-8")
    (state / "codex-broker.secret").write_text("broker", encoding="utf-8")
    uv.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    uv.chmod(0o700)
    (root / ".langgraph_api").symlink_to(stable, target_is_directory=True)

    # Deliberately non-canonical text: the link target is valid even though the
    # configured state path contains a parent traversal and trailing slash.
    configured_state = state / "nested" / ".."
    (state / "nested").mkdir()
    env = os.environ.copy()
    env.update(
        HOME=str(home),
        FORGEFLOW_POLICY_ROOT=str(root),
        FORGEFLOW_POLICY_CONFIG_DIR=str(config),
        FORGEFLOW_POLICY_STATE_DIR=str(configured_state) + "/",
    )
    result = subprocess.run(
        [str(DEPLOY / "start-forgeflow-policy.sh")],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


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


def _run_state_migration(tmp_path: Path, *, previous: bool = False):
    import subprocess
    import sys

    root = tmp_path / "new-root"
    root.mkdir()
    state = tmp_path / "state"
    args = [
        sys.executable,
        str(DEPLOY / "migrate_langgraph_state.py"),
        "--root",
        str(root),
        "--state-dir",
        str(state),
    ]
    old = None
    if previous:
        old = tmp_path / "old-root"
        old.mkdir()
        args.extend(["--previous-root", str(old)])
    return root, old, state, args, subprocess


def test_langgraph_state_migration_creates_stable_link_for_fresh_install(tmp_path: Path) -> None:
    root, _old, state, args, subprocess = _run_state_migration(tmp_path)
    result = subprocess.run(args, text=True, capture_output=True, check=True)
    stable = state / "langgraph"
    assert stable.is_dir()
    assert (root / ".langgraph_api").is_symlink()
    assert (root / ".langgraph_api").resolve() == stable
    assert f"langgraph_state_dir={stable}" in result.stdout


def test_langgraph_state_migration_preserves_previous_worktree_state(tmp_path: Path) -> None:
    root, old, state, args, subprocess = _run_state_migration(tmp_path, previous=True)
    assert old is not None
    local = old / ".langgraph_api"
    local.mkdir()
    (local / ".langgraph_ops.pckl").write_bytes(b"authoritative-state")
    subprocess.run(args, text=True, capture_output=True, check=True)
    stable = state / "langgraph"
    assert (stable / ".langgraph_ops.pckl").read_bytes() == b"authoritative-state"
    assert local.is_symlink() and local.resolve() == stable
    assert (root / ".langgraph_api").is_symlink()
    assert (root / ".langgraph_api").resolve() == stable


def test_langgraph_state_migration_is_idempotent_with_existing_stable_link(tmp_path: Path) -> None:
    root, _old, state, args, subprocess = _run_state_migration(tmp_path)
    subprocess.run(args, text=True, capture_output=True, check=True)
    stable = state / "langgraph"
    (stable / "checkpoint").write_text("keep", encoding="utf-8")
    subprocess.run(args, text=True, capture_output=True, check=True)
    assert (stable / "checkpoint").read_text(encoding="utf-8") == "keep"
    assert (root / ".langgraph_api").resolve() == stable


def test_langgraph_state_migration_rejects_divergent_state(tmp_path: Path) -> None:
    root, _old, state, args, subprocess = _run_state_migration(tmp_path)
    stable = state / "langgraph"
    stable.mkdir(parents=True)
    (stable / "state").write_text("stable", encoding="utf-8")
    local = root / ".langgraph_api"
    local.mkdir()
    (local / "state").write_text("different", encoding="utf-8")
    result = subprocess.run(args, text=True, capture_output=True, check=False)
    assert result.returncode != 0
    assert "conflicts with worktree-local state" in result.stderr
    assert not local.is_symlink()
    assert (local / "state").read_text(encoding="utf-8") == "different"
