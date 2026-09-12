from pathlib import Path

import pytest

from forgeflow.external_agents.execution import (
    ExternalAgentExecutionRequest,
    ExternalAgentRouteGate,
    ExternalAgentRouteRejected,
)
from openswe_ext.antigravity_execution import AntigravityExternalAgentExecution


def _request(workspace: Path, *, project: tuple[str, str] = ("o", "r")):
    return ExternalAgentExecutionRequest(
        owner=project[0],
        repo=project[1],
        workspace=workspace,
        objective="make one bounded change",
        operation_key="canary:1",
        phase="IMPLEMENT",
        test_command=("python3", "-m", "unittest", "-q"),
    )


def test_route_gate_requires_enable_project_and_workspace_root(tmp_path: Path) -> None:
    root = tmp_path / "root"
    workspace = root / "work"
    root.mkdir()
    workspace.mkdir()
    request = _request(workspace)

    with pytest.raises(ExternalAgentRouteRejected, match="ROUTE_DISABLED"):
        ExternalAgentRouteGate(False, frozenset({"o/r"}), root).validate(request)
    with pytest.raises(ExternalAgentRouteRejected, match="PROJECT_NOT_ALLOWED"):
        ExternalAgentRouteGate(True, frozenset({"other/r"}), root).validate(request)
    assert ExternalAgentRouteGate(True, frozenset({"O/R"}), root).validate(request) == workspace


def test_route_gate_rejects_workspace_outside_root(tmp_path: Path) -> None:
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    with pytest.raises(ExternalAgentRouteRejected, match="WORKSPACE_NOT_ALLOWED"):
        ExternalAgentRouteGate(True, frozenset({"o/r"}), root).validate(_request(outside))


def test_antigravity_execution_is_disabled_and_unallowlisted_by_default(tmp_path: Path) -> None:
    root = tmp_path / "root"
    workspace = root / "work"
    root.mkdir()
    workspace.mkdir()
    route = AntigravityExternalAgentExecution(
        env={
            "HOME": str(tmp_path),
            "FORGEFLOW_EXTERNAL_AGENT_WORKSPACE_ROOT": str(root),
        }
    )
    with pytest.raises(ExternalAgentRouteRejected, match="ROUTE_DISABLED"):
        import asyncio

        asyncio.run(route.execute(_request(workspace)))


def test_antigravity_requires_outer_docker(tmp_path: Path) -> None:
    with pytest.raises(ExternalAgentRouteRejected, match="OUTER_SANDBOX_REQUIRED"):
        AntigravityExternalAgentExecution(
            env={
                "HOME": str(tmp_path),
                "FORGEFLOW_EXTERNAL_AGENT_OUTER_SANDBOX": "host",
            }
        )
