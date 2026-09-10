import importlib.util
import stat
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "deploy/gcp-dev/github_app_manifest_bootstrap.py"
spec = importlib.util.spec_from_file_location("github_app_manifest_bootstrap", SCRIPT)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_manifest_is_private_inactive_and_has_required_open_swe_permissions() -> None:
    manifest = module.build_manifest("http://100.78.255.51:8765")
    assert manifest["public"] is False
    assert manifest["request_oauth_on_install"] is False
    assert manifest["hook_attributes"]["active"] is False
    assert manifest["redirect_url"] == "http://100.78.255.51:8765/manifest-callback"
    assert manifest["setup_url"] == "http://100.78.255.51:8765/installed"
    assert manifest["default_permissions"] == {
        "actions": "read",
        "checks": "write",
        "contents": "write",
        "issues": "write",
        "metadata": "read",
        "pull_requests": "write",
        "statuses": "read",
        "workflows": "write",
    }
    assert {
        "check_run",
        "check_suite",
        "issue_comment",
        "pull_request_review",
        "pull_request_review_comment",
        "workflow_run",
    } <= set(manifest["default_events"])


def test_app_env_is_mode_600_and_escapes_multiline_pem(tmp_path: Path) -> None:
    env = tmp_path / "github-app.env"
    app = {
        "id": 123,
        "client_id": "Iv1.test",
        "client_secret": "secret",
        "pem": "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
        "webhook_secret": "hook",
    }
    module.write_app_env(env, app, installation_id=456)
    parsed = module.read_app_env(env)
    assert stat.S_IMODE(env.stat().st_mode) == 0o600
    assert parsed["GITHUB_APP_ID"] == "123"
    assert parsed["GITHUB_APP_INSTALLATION_ID"] == "456"
    assert "\\n" in parsed["GITHUB_APP_PRIVATE_KEY"]
    assert "\n" not in parsed["GITHUB_APP_PRIVATE_KEY"]


def test_required_repo_set_is_narrow() -> None:
    assert module.OWNER == "BakerSean168"
    assert module.REQUIRED_REPOS == ("digital-biome", "forgeflow")


def test_manifest_conversion_can_be_held_pending_without_final_env(tmp_path: Path) -> None:
    pending = tmp_path / "github-app.env.pending.json"
    final_env = tmp_path / "github-app.env"
    app = {
        "id": 123,
        "client_id": "Iv1.test",
        "client_secret": "secret",
        "pem": "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
        "webhook_secret": "hook",
        "slug": "forgeflow-open-swe-test",
    }
    module.write_pending_app(pending, app)
    assert stat.S_IMODE(pending.stat().st_mode) == 0o600
    assert not final_env.exists()
    assert module.read_pending_app(pending)["slug"] == "forgeflow-open-swe-test"
