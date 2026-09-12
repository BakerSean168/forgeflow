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


def test_execution_moves_git_hashing_and_tests_off_event_loop(tmp_path: Path, monkeypatch) -> None:
    import asyncio
    import subprocess
    import threading

    import openswe_ext.external_agent_execution as module
    from forgeflow.external_agents.acp import AcpExecutionResult
    from forgeflow.external_agents.execution import ExternalAgentExecutionRequest
    from openswe_ext.external_agent_execution import AcpWorkspaceExecutionAdapter

    root = tmp_path / "root"
    workspace = root / "work"
    workspace.mkdir(parents=True)
    subprocess.check_call(["git", "init", "-b", "main"], cwd=workspace)
    subprocess.check_call(["git", "config", "user.name", "test"], cwd=workspace)
    subprocess.check_call(["git", "config", "user.email", "test@example.invalid"], cwd=workspace)
    (workspace / "a.txt").write_text("base\n", encoding="utf-8")
    subprocess.check_call(["git", "add", "a.txt"], cwd=workspace)
    subprocess.check_call(["git", "commit", "-m", "base"], cwd=workspace)

    caller = threading.get_ident()
    git_threads: list[int] = []
    test_threads: list[int] = []
    original_git = module._git
    original_test = module._test

    def recording_git(*args, **kwargs):
        git_threads.append(threading.get_ident())
        return original_git(*args, **kwargs)

    def recording_test(*args, **kwargs):
        test_threads.append(threading.get_ident())
        return original_test(*args, **kwargs)

    async def fake_agent(**kwargs):
        target = Path(kwargs["cwd"]) / "a.txt"
        target.write_text("changed\n", encoding="utf-8")
        return AcpExecutionResult(
            stop_reason="end_turn",
            text="done",
            session_id="session",
            metadata={"model": "fake", "conversation_id": "conversation"},
        )

    monkeypatch.setattr(module, "_git", recording_git)
    monkeypatch.setattr(module, "_test", recording_test)
    monkeypatch.setattr(module, "run_acp_agent", fake_agent)

    adapter = AcpWorkspaceExecutionAdapter(
        gate=ExternalAgentRouteGate(True, frozenset({"o/r"}), root),
        agent_command="unused",
        agent_args=(),
        runtime_label="fake",
    )
    request = ExternalAgentExecutionRequest(
        owner="o",
        repo="r",
        workspace=workspace,
        objective="make one bounded change",
        operation_key="canary:1",
        phase="IMPLEMENT",
        test_command=("git", "diff", "--check"),
    )
    evidence = asyncio.run(adapter.execute(request))
    assert evidence.changed_files == ("a.txt",)
    assert git_threads and all(thread_id != caller for thread_id in git_threads)
    assert test_threads and all(thread_id != caller for thread_id in test_threads)
