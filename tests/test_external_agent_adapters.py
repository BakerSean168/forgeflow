import pytest

from forgeflow.routing import RouteDefinition
from openswe_ext.antigravity_execution import AntigravityExternalAgentExecution
from openswe_ext.codebuddy_execution import CodeBuddyExternalAgentExecution
from openswe_ext.external_agent_adapters import (
    ExternalAgentAdapterError,
    build_external_agent_execution,
    supported_external_agent_adapters,
)


def test_adapter_registry_exposes_antigravity_and_codebuddy(tmp_path) -> None:
    agy = tmp_path / "agy"
    agy.write_text("#!/bin/sh\n", encoding="utf-8")
    agy.chmod(0o700)
    codebuddy = tmp_path / "codebuddy"
    codebuddy.write_text("#!/bin/sh\n", encoding="utf-8")
    codebuddy.chmod(0o700)
    root = tmp_path / "root"
    root.mkdir()
    auth = tmp_path / "auth"
    auth.mkdir()
    (auth / "Tencent-Cloud.coding-copilot.info").write_text("{}\n", encoding="utf-8")

    antigravity = build_external_agent_execution(
        RouteDefinition(
            "anti",
            "IMPLEMENT",
            20,
            "EXTERNAL_ACP",
            "google-account",
            adapter="antigravity",
        ),
        allowed_projects=frozenset({"o/r"}),
        env={
            "HOME": str(tmp_path),
            "FORGEFLOW_EXTERNAL_AGENT_WORKSPACE_ROOT": str(root),
            "FORGEFLOW_EXTERNAL_AGENT_OUTER_SANDBOX": "docker",
            "FORGEFLOW_ANTIGRAVITY_BIN": str(agy),
            "FORGEFLOW_ANTIGRAVITY_AUTH_STATE_DIR": str(tmp_path),
        },
    )
    codebuddy_agent = build_external_agent_execution(
        RouteDefinition(
            "buddy",
            "IMPLEMENT",
            30,
            "EXTERNAL_ACP",
            "codebuddy-account",
            adapter="codebuddy",
        ),
        allowed_projects=frozenset({"o/r"}),
        env={
            "HOME": str(tmp_path),
            "PATH": "/usr/bin:/bin",
            "FORGEFLOW_EXTERNAL_AGENT_WORKSPACE_ROOT": str(root),
            "FORGEFLOW_EXTERNAL_AGENT_OUTER_SANDBOX": "docker",
            "FORGEFLOW_CODEBUDDY_BIN": str(codebuddy),
            "FORGEFLOW_CODEBUDDY_AUTH_STATE_DIR": str(auth),
        },
    )

    assert isinstance(antigravity, AntigravityExternalAgentExecution)
    assert isinstance(codebuddy_agent, CodeBuddyExternalAgentExecution)
    assert supported_external_agent_adapters() == ("antigravity", "codebuddy")


def test_adapter_registry_rejects_unknown_adapter() -> None:
    route = RouteDefinition(
        "unknown",
        "IMPLEMENT",
        99,
        "EXTERNAL_ACP",
        "account",
        adapter="mystery",
    )
    with pytest.raises(ExternalAgentAdapterError, match="ADAPTER_UNSUPPORTED"):
        build_external_agent_execution(route, allowed_projects=frozenset({"o/r"}))
