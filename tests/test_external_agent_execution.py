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



def test_explicit_project_allowlist_overrides_empty_environment(tmp_path: Path) -> None:
    root = tmp_path / "root"
    workspace = root / "work"
    workspace.mkdir(parents=True)
    route = AntigravityExternalAgentExecution(
        env={
            "HOME": str(tmp_path),
            "FORGEFLOW_ANTIGRAVITY_ACP_ENABLED": "true",
            "FORGEFLOW_EXTERNAL_AGENT_WORKSPACE_ROOT": str(root),
            "FORGEFLOW_EXTERNAL_AGENT_OUTER_SANDBOX": "docker",
        },
        allowed_projects=frozenset({"o/r"}),
    )
    assert route._gate.validate(_request(workspace)) == workspace

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

@pytest.mark.asyncio
async def test_cancellation_safe_to_thread_keeps_cancellation_authoritative_when_worker_fails() -> None:
    import asyncio
    import subprocess
    import threading

    from openswe_ext.external_agent_execution import _cancellation_safe_to_thread

    started = threading.Event()
    release = threading.Event()

    def failing_worker() -> None:
        started.set()
        release.wait(timeout=5)
        raise subprocess.TimeoutExpired(cmd=("git", "status"), timeout=1)

    task = asyncio.create_task(_cancellation_safe_to_thread(failing_worker))
    assert await asyncio.to_thread(started.wait, 5)
    task.cancel()
    release.set()

    with pytest.raises(asyncio.CancelledError) as exc_info:
        await task
    assert isinstance(exc_info.value.__cause__, subprocess.TimeoutExpired)


def test_acp_adapter_can_translate_vendor_refusal_into_route_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio
    import subprocess

    import openswe_ext.external_agent_execution as module
    from forgeflow.external_agents.acp import AcpExecutionResult
    from forgeflow.external_agents.execution import ExternalAgentExecutionRequest
    from openswe_ext.external_agent_execution import (
        AcpWorkspaceExecutionAdapter,
        ExternalAgentExecutionError,
    )

    root = tmp_path / "root"
    workspace = root / "work"
    workspace.mkdir(parents=True)
    subprocess.check_call(["git", "init", "-b", "main"], cwd=workspace)
    subprocess.check_call(["git", "config", "user.name", "test"], cwd=workspace)
    subprocess.check_call(["git", "config", "user.email", "test@example.invalid"], cwd=workspace)
    (workspace / "a.txt").write_text("base\n", encoding="utf-8")
    subprocess.check_call(["git", "add", "a.txt"], cwd=workspace)
    subprocess.check_call(["git", "commit", "-m", "base"], cwd=workspace)

    async def fake_agent(**kwargs):
        del kwargs
        return AcpExecutionResult(
            stop_reason="refusal",
            text="429 rate limit exceeded",
            session_id="session",
            metadata={},
        )

    monkeypatch.setattr(module, "run_acp_agent", fake_agent)
    adapter = AcpWorkspaceExecutionAdapter(
        gate=ExternalAgentRouteGate(True, frozenset({"o/r"}), root),
        agent_command="unused",
        agent_args=(),
        runtime_label="fake",
        stop_failure_code=lambda result: (
            "CODEBUDDY_RATE_LIMITED" if "429" in result.text else None
        ),
    )
    request = ExternalAgentExecutionRequest(
        owner="o",
        repo="r",
        workspace=workspace,
        objective="make one bounded change",
        operation_key="canary:refusal",
        phase="IMPLEMENT",
        test_command=("git", "diff", "--check"),
    )

    with pytest.raises(ExternalAgentExecutionError, match="CODEBUDDY_RATE_LIMITED"):
        asyncio.run(adapter.execute(request))

def test_acp_adapter_rejects_dirty_workspace_without_continuation_authorization(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import subprocess

    import openswe_ext.external_agent_execution as module
    from forgeflow.external_agents.execution import ExternalAgentExecutionRequest
    from openswe_ext.external_agent_execution import (
        AcpWorkspaceExecutionAdapter,
        ExternalAgentExecutionError,
    )

    root = tmp_path / "root"
    workspace = root / "work"
    workspace.mkdir(parents=True)
    subprocess.check_call(["git", "init", "-b", "main"], cwd=workspace)
    subprocess.check_call(["git", "config", "user.name", "test"], cwd=workspace)
    subprocess.check_call(["git", "config", "user.email", "test@example.invalid"], cwd=workspace)
    (workspace / "a.txt").write_text("base\n", encoding="utf-8")
    subprocess.check_call(["git", "add", "a.txt"], cwd=workspace)
    subprocess.check_call(["git", "commit", "-m", "base"], cwd=workspace)
    (workspace / "a.txt").write_text("restored\n", encoding="utf-8")

    async def should_not_run(**kwargs):
        raise AssertionError(f"agent should not run for untrusted dirty workspace: {kwargs}")

    monkeypatch.setattr(module, "run_acp_agent", should_not_run)
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
        objective="continue one bounded change",
        operation_key="canary:dirty-denied",
        phase="IMPLEMENT",
        test_command=("git", "diff", "--check"),
    )

    import asyncio

    with pytest.raises(ExternalAgentExecutionError, match="WORKSPACE_NOT_CLEAN"):
        asyncio.run(adapter.execute(request))


def test_acp_adapter_accepts_authorized_continuation_dirty_workspace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import subprocess

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
    source_revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=workspace, text=True).strip()

    # This is the already-validated continuation state restored by ForgeFlow.
    (workspace / "a.txt").write_text("restored\n", encoding="utf-8")
    (workspace / "continued.txt").write_text("from previous provider\n", encoding="utf-8")

    async def fake_agent(**kwargs):
        target = Path(kwargs["cwd"]) / "continued.txt"
        target.write_text("from previous provider\nfinished by fallback\n", encoding="utf-8")
        return AcpExecutionResult(
            stop_reason="end_turn",
            text="finished",
            session_id="session-continuation",
            metadata={"model": "fake", "conversation_id": "conversation-continuation"},
        )

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
        objective="continue the restored implementation",
        operation_key="canary:dirty-authorized",
        phase="IMPLEMENT",
        test_command=("git", "diff", "--check"),
        allow_dirty_workspace=True,
    )

    import asyncio

    evidence = asyncio.run(adapter.execute(request))

    assert evidence.source_revision == source_revision
    assert set(evidence.changed_files) == {"a.txt", "continued.txt"}
    assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=workspace, text=True).strip() == source_revision
    assert (workspace / "a.txt").read_text(encoding="utf-8") == "restored\n"
    assert (workspace / "continued.txt").read_text(encoding="utf-8") == (
        "from previous provider\nfinished by fallback\n"
    )
