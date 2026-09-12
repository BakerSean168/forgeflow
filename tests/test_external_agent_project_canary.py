from pathlib import Path

SCRIPT = Path("deploy/gcp-dev/run-external-agent-project-canary.py")


def test_project_canary_is_explicit_and_uses_self_contained_clone() -> None:
    text = SCRIPT.read_text(encoding="utf-8")
    assert '"FORGEFLOW_ANTIGRAVITY_ACP_ENABLED": "true"' in text
    assert '"FORGEFLOW_ANTIGRAVITY_ACP_PROJECTS": f"{args.owner}/{args.repo}"' in text
    assert '"--no-local"' in text
    assert '"--no-checkout"' in text
    assert 'phase="IMPLEMENT"' in text
    assert "GitHubExternalAgentDelivery" in text
    assert "finally:" in text
    assert "_cleanup_workspace" in text


def test_project_canary_loads_github_app_env_before_delivery_import() -> None:
    text = SCRIPT.read_text(encoding="utf-8")
    load_at = text.index("_load_external_env(Path(args.github_env).expanduser())")
    import_at = text.index("from forgeflow.adapters.external_delivery import GitHubExternalAgentDelivery")
    assert load_at < import_at
    assert "github-app.env" in text
    assert "shlex.split(encoded)" in text
    assert "print(parsed" not in text
