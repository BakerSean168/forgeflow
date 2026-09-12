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
