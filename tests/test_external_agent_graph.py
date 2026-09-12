import asyncio

from openswe_ext.external_agent_graph import ExternalAgentGraphResult, build_external_agent_graph


class FakeServices:
    def __init__(self, result: ExternalAgentGraphResult) -> None:
        self.result = result
        self.requests = []

    async def run(self, request):
        self.requests.append(request)
        return self.result


def _input():
    return {
        "owner": "o",
        "repo": "r",
        "base_ref": "main",
        "objective": "implement x",
        "operation_key": "op:1",
        "route_id": "external",
        "phase": "IMPLEMENT",
    }


def test_external_graph_persists_normalized_success_result() -> None:
    services = FakeServices(
        ExternalAgentGraphResult(
            external_status="SUCCESS",
            attempt_id="attempt",
            source_revision="a" * 40,
            pr_url="https://github.com/o/r/pull/1",
            pr_number=1,
            head_sha="b" * 40,
            head_ref="forgeflow/external-x",
            external_session_id="session",
            external_conversation_id="conversation",
        )
    )
    result = asyncio.run(build_external_agent_graph(services=services).ainvoke(_input()))
    assert result["external_status"] == "SUCCESS"
    assert result["pr_number"] == 1
    assert result["head_sha"] == "b" * 40
    assert result["external_session_id"] == "session"
    assert services.requests[0]["route_id"] == "external"


def test_external_graph_persists_bounded_blocked_result() -> None:
    services = FakeServices(
        ExternalAgentGraphResult(
            external_status="BLOCKED",
            failure_code="ANTIGRAVITY_TIMEOUT",
            failure_class="ROUTE_AVAILABILITY",
            attempt_id="attempt",
        )
    )
    result = asyncio.run(build_external_agent_graph(services=services).ainvoke(_input()))
    assert result["external_status"] == "BLOCKED"
    assert result["failure_code"] == "ANTIGRAVITY_TIMEOUT"
    assert result["failure_class"] == "ROUTE_AVAILABILITY"


def test_delivery_transport_failure_is_normalized_and_closes_attempt(tmp_path, monkeypatch) -> None:
    import json
    import threading

    import httpx2

    import openswe_ext.external_agent_graph as module
    from forgeflow.attempts import AttemptLedger
    from forgeflow.external_agents.execution import ExternalAgentExecutionEvidence
    from forgeflow.projects import ExternalAgentProjectConfig
    from openswe_ext.external_agent_workspace import PreparedExternalWorkspace

    route_config = tmp_path / "routes.json"
    route_config.write_text(
        json.dumps(
            {
                "version": 1,
                "routes": [
                    {
                        "id": "external",
                        "role": "IMPLEMENT",
                        "priority": 1,
                        "runtime": "EXTERNAL_ACP",
                        "adapter": "antigravity",
                        "target": "account",
                        "enabled": True,
                        "health": "READY",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    ledger = tmp_path / "attempts.jsonl"
    root = tmp_path / "workspaces"
    root.mkdir()
    source = tmp_path / "source"
    source.mkdir()
    workspace = root / "run"
    workspace.mkdir()
    source_sha = "a" * 40

    monkeypatch.setenv("FORGEFLOW_ROUTE_CONFIG_FILE", str(route_config))
    monkeypatch.setenv("FORGEFLOW_ATTEMPT_LEDGER_FILE", str(ledger))
    monkeypatch.setenv("FORGEFLOW_EXTERNAL_AGENT_WORKSPACE_ROOT", str(root))
    caller_thread = threading.get_ident()
    ledger_threads: list[int] = []
    original_start = AttemptLedger.ensure_started

    def recording_start(self, **kwargs):
        ledger_threads.append(threading.get_ident())
        return original_start(self, **kwargs)

    monkeypatch.setattr(AttemptLedger, "ensure_started", recording_start)
    monkeypatch.setattr(
        module,
        "load_external_agent_project_config",
        lambda owner, repo: ExternalAgentProjectConfig(source, ("true",)),
    )
    monkeypatch.setattr(
        module,
        "prepare_external_workspace",
        lambda **kwargs: PreparedExternalWorkspace(workspace, source_sha),
    )
    monkeypatch.setattr(module, "cleanup_external_workspace", lambda path: None)

    class FakeExecution:
        async def execute(self, request):
            return ExternalAgentExecutionEvidence(
                runtime="antigravity",
                model="fake",
                source_revision=source_sha,
                changed_files=("a.txt",),
                diff_sha256="d" * 64,
                test_command=("true",),
                test_exit_code=0,
                test_output_sha256="e" * 64,
                acp_session_id="session",
                external_conversation_id="conversation",
                agent_stop_reason="end_turn",
            )

    class FailingDelivery:
        async def deliver(self, **kwargs):
            raise httpx2.ConnectError("network unavailable")

    monkeypatch.setattr(module, "AntigravityExternalAgentExecution", FakeExecution)
    monkeypatch.setattr(module, "GitHubExternalAgentDelivery", FailingDelivery)

    result = asyncio.run(module.DefaultExternalAgentGraphServices().run(_input()))
    assert result.external_status == "BLOCKED"
    assert result.failure_code == "EXTERNAL_AGENT_GITHUB_TRANSPORT_FAILED"
    rows = [json.loads(line) for line in ledger.read_text(encoding="utf-8").splitlines()]
    assert [row["event"] for row in rows] == ["STARTED", "FINISHED"]
    assert rows[-1]["outcome"] == "BLOCKED"
    assert rows[-1]["fallback_reason"] == "EXTERNAL_AGENT_GITHUB_TRANSPORT_FAILED"
    assert ledger_threads and ledger_threads[0] != caller_thread


def test_request_error_failure_code_preserves_structured_antigravity_code() -> None:
    from acp.exceptions import RequestError

    from openswe_ext.external_agent_graph import _failure_code

    exc = RequestError(
        -32012,
        "Antigravity bootstrap failed",
        {"code": "ANTIGRAVITY_TIMEOUT"},
    )
    assert _failure_code(exc) == "ANTIGRAVITY_TIMEOUT"


def test_cancellation_during_attempt_start_closes_one_idempotent_attempt(tmp_path, monkeypatch) -> None:
    import json
    import threading

    import pytest

    import openswe_ext.external_agent_graph as module
    from forgeflow.attempts import AttemptLedger

    route_config = tmp_path / "routes.json"
    route_config.write_text(
        json.dumps(
            {
                "version": 1,
                "routes": [
                    {
                        "id": "external",
                        "role": "IMPLEMENT",
                        "priority": 1,
                        "runtime": "EXTERNAL_ACP",
                        "adapter": "antigravity",
                        "target": "account",
                        "enabled": True,
                        "health": "READY",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    ledger_path = tmp_path / "attempts.jsonl"
    root = tmp_path / "workspaces"
    root.mkdir()
    monkeypatch.setenv("FORGEFLOW_ROUTE_CONFIG_FILE", str(route_config))
    monkeypatch.setenv("FORGEFLOW_ATTEMPT_LEDGER_FILE", str(ledger_path))
    monkeypatch.setenv("FORGEFLOW_EXTERNAL_AGENT_WORKSPACE_ROOT", str(root))

    entered = threading.Event()
    release = threading.Event()
    original = AttemptLedger.ensure_started

    def blocking_start(self, **kwargs):
        status = original(self, **kwargs)
        entered.set()
        assert release.wait(timeout=5)
        return status

    monkeypatch.setattr(AttemptLedger, "ensure_started", blocking_start)

    async def scenario():
        task = asyncio.create_task(module.DefaultExternalAgentGraphServices().run(_input()))
        assert await asyncio.to_thread(entered.wait, 5)
        task.cancel()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())

    rows = [json.loads(line) for line in ledger_path.read_text(encoding="utf-8").splitlines()]
    assert [row["event"] for row in rows] == ["STARTED", "FINISHED"]
    assert rows[0]["attempt_id"] == rows[1]["attempt_id"]
    assert rows[1]["outcome"] == "BLOCKED"
    assert rows[1]["fallback_reason"] == "EXTERNAL_AGENT_CANCELLED"
    recovered = AttemptLedger(ledger_path).ensure_started(
        role="IMPLEMENT",
        route_id="external",
        priority=1,
        runtime="EXTERNAL_ACP",
        target="account",
        operation_key="op:1",
    )
    assert recovered.finished is True
    assert len(ledger_path.read_text(encoding="utf-8").splitlines()) == 2


def test_cancellation_during_workspace_prepare_cleans_checkout_and_closes_attempt(
    tmp_path, monkeypatch
) -> None:
    import json
    import threading

    import pytest

    import openswe_ext.external_agent_graph as module
    from forgeflow.projects import ExternalAgentProjectConfig
    from openswe_ext.external_agent_workspace import PreparedExternalWorkspace

    route_config = tmp_path / "routes.json"
    route_config.write_text(
        json.dumps(
            {
                "version": 1,
                "routes": [
                    {
                        "id": "external",
                        "role": "IMPLEMENT",
                        "priority": 1,
                        "runtime": "EXTERNAL_ACP",
                        "adapter": "antigravity",
                        "target": "account",
                        "enabled": True,
                        "health": "READY",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    ledger_path = tmp_path / "attempts.jsonl"
    root = tmp_path / "workspaces"
    root.mkdir()
    source = tmp_path / "source"
    source.mkdir()
    workspace = root / "run"
    source_sha = "a" * 40
    monkeypatch.setenv("FORGEFLOW_ROUTE_CONFIG_FILE", str(route_config))
    monkeypatch.setenv("FORGEFLOW_ATTEMPT_LEDGER_FILE", str(ledger_path))
    monkeypatch.setenv("FORGEFLOW_EXTERNAL_AGENT_WORKSPACE_ROOT", str(root))
    monkeypatch.setattr(
        module,
        "load_external_agent_project_config",
        lambda owner, repo: ExternalAgentProjectConfig(source, ("true",)),
    )

    entered = threading.Event()
    release = threading.Event()

    def blocking_prepare(**kwargs):
        del kwargs
        workspace.mkdir()
        (workspace / "partial.txt").write_text("prepared\n", encoding="utf-8")
        entered.set()
        assert release.wait(timeout=5)
        return PreparedExternalWorkspace(workspace, source_sha)

    monkeypatch.setattr(module, "prepare_external_workspace", blocking_prepare)

    async def scenario():
        task = asyncio.create_task(module.DefaultExternalAgentGraphServices().run(_input()))
        assert await asyncio.to_thread(entered.wait, 5)
        task.cancel()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())

    assert not workspace.exists()
    rows = [json.loads(line) for line in ledger_path.read_text(encoding="utf-8").splitlines()]
    assert [row["event"] for row in rows] == ["STARTED", "FINISHED"]
    assert rows[-1]["outcome"] == "BLOCKED"
    assert rows[-1]["fallback_reason"] == "EXTERNAL_AGENT_CANCELLED"


def test_finished_external_operation_replay_is_bounded_and_does_not_rewrite_ledger(
    tmp_path, monkeypatch
) -> None:
    import json

    import openswe_ext.external_agent_graph as module
    from forgeflow.attempts import AttemptLedger

    route_config = tmp_path / "routes.json"
    route_config.write_text(
        json.dumps(
            {
                "version": 1,
                "routes": [
                    {
                        "id": "external",
                        "role": "IMPLEMENT",
                        "priority": 1,
                        "runtime": "EXTERNAL_ACP",
                        "adapter": "antigravity",
                        "target": "account",
                        "enabled": True,
                        "health": "READY",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    ledger_path = tmp_path / "attempts.jsonl"
    root = tmp_path / "workspaces"
    root.mkdir()
    monkeypatch.setenv("FORGEFLOW_ROUTE_CONFIG_FILE", str(route_config))
    monkeypatch.setenv("FORGEFLOW_ATTEMPT_LEDGER_FILE", str(ledger_path))
    monkeypatch.setenv("FORGEFLOW_EXTERNAL_AGENT_WORKSPACE_ROOT", str(root))

    ledger = AttemptLedger(ledger_path)
    ledger.ensure_started(
        role="IMPLEMENT",
        route_id="external",
        priority=1,
        runtime="EXTERNAL_ACP",
        target="account",
        operation_key="op:1",
    )
    ledger.finish_operation(
        route_id="external",
        operation_key="op:1",
        outcome="SUCCEEDED",
        source_revision="a" * 40,
        result_revision="b" * 40,
    )

    result = asyncio.run(module.DefaultExternalAgentGraphServices().run(_input()))

    assert result.external_status == "BLOCKED"
    assert result.failure_code == "EXTERNAL_AGENT_OPERATION_ALREADY_FINISHED"
    assert result.failure_class == "POLICY_DENIED"
    rows = [json.loads(line) for line in ledger_path.read_text(encoding="utf-8").splitlines()]
    assert [row["event"] for row in rows] == ["STARTED", "FINISHED"]
    assert rows[-1]["outcome"] == "SUCCEEDED"
    assert rows[-1]["result_revision"] == "b" * 40


def test_availability_failure_closes_attempt_after_workspace_cleanup(tmp_path, monkeypatch) -> None:
    import json

    from acp.exceptions import RequestError

    import openswe_ext.external_agent_graph as module
    from forgeflow.projects import ExternalAgentProjectConfig
    from openswe_ext.external_agent_workspace import PreparedExternalWorkspace

    route_config = tmp_path / "routes.json"
    route_config.write_text(
        json.dumps(
            {
                "version": 1,
                "routes": [
                    {
                        "id": "external",
                        "role": "IMPLEMENT",
                        "priority": 1,
                        "runtime": "EXTERNAL_ACP",
                        "adapter": "antigravity",
                        "target": "account",
                        "enabled": True,
                        "health": "READY",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    ledger = tmp_path / "attempts.jsonl"
    root = tmp_path / "workspaces"
    root.mkdir()
    source = tmp_path / "source"
    source.mkdir()
    workspace = root / "run"
    workspace.mkdir()
    monkeypatch.setenv("FORGEFLOW_ROUTE_CONFIG_FILE", str(route_config))
    monkeypatch.setenv("FORGEFLOW_ATTEMPT_LEDGER_FILE", str(ledger))
    monkeypatch.setenv("FORGEFLOW_EXTERNAL_AGENT_WORKSPACE_ROOT", str(root))
    monkeypatch.setattr(
        module,
        "load_external_agent_project_config",
        lambda owner, repo: ExternalAgentProjectConfig(source, ("true",)),
    )
    monkeypatch.setattr(
        module,
        "prepare_external_workspace",
        lambda **kwargs: PreparedExternalWorkspace(workspace, "a" * 40),
    )

    class FailingExecution:
        async def execute(self, request):
            del request
            raise RequestError(
                -32012,
                "Antigravity bootstrap failed",
                {"code": "ANTIGRAVITY_TIMEOUT"},
            )

    monkeypatch.setattr(module, "AntigravityExternalAgentExecution", FailingExecution)
    result = asyncio.run(module.DefaultExternalAgentGraphServices().run(_input()))
    assert result.external_status == "BLOCKED"
    assert result.failure_code == "ANTIGRAVITY_TIMEOUT"
    assert result.failure_class == "ROUTE_AVAILABILITY"
    assert not workspace.exists()
    rows = [json.loads(line) for line in ledger.read_text(encoding="utf-8").splitlines()]
    assert [row["event"] for row in rows] == ["STARTED", "FINISHED"]
    assert rows[-1]["outcome"] == "BLOCKED"
    assert rows[-1]["failure_class"] == "ROUTE_AVAILABILITY"
    assert rows[-1]["fallback_reason"] == "ANTIGRAVITY_TIMEOUT"


def test_cleanup_failure_is_fail_closed_and_finishes_attempt(tmp_path, monkeypatch) -> None:
    import json

    from acp.exceptions import RequestError

    import openswe_ext.external_agent_graph as module
    from forgeflow.projects import ExternalAgentProjectConfig
    from openswe_ext.external_agent_workspace import (
        ExternalAgentWorkspaceError,
        PreparedExternalWorkspace,
    )

    route_config = tmp_path / "routes.json"
    route_config.write_text(
        json.dumps(
            {
                "version": 1,
                "routes": [
                    {
                        "id": "external",
                        "role": "IMPLEMENT",
                        "priority": 1,
                        "runtime": "EXTERNAL_ACP",
                        "adapter": "antigravity",
                        "target": "account",
                        "enabled": True,
                        "health": "READY",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    ledger = tmp_path / "attempts.jsonl"
    root = tmp_path / "workspaces"
    root.mkdir()
    source = tmp_path / "source"
    source.mkdir()
    workspace = root / "run"
    workspace.mkdir()
    monkeypatch.setenv("FORGEFLOW_ROUTE_CONFIG_FILE", str(route_config))
    monkeypatch.setenv("FORGEFLOW_ATTEMPT_LEDGER_FILE", str(ledger))
    monkeypatch.setenv("FORGEFLOW_EXTERNAL_AGENT_WORKSPACE_ROOT", str(root))
    monkeypatch.setattr(
        module,
        "load_external_agent_project_config",
        lambda owner, repo: ExternalAgentProjectConfig(source, ("true",)),
    )
    monkeypatch.setattr(
        module,
        "prepare_external_workspace",
        lambda **kwargs: PreparedExternalWorkspace(workspace, "a" * 40),
    )

    class FailingExecution:
        async def execute(self, request):
            del request
            raise RequestError(
                -32012,
                "Antigravity bootstrap failed",
                {"code": "ANTIGRAVITY_TIMEOUT"},
            )

    def failing_cleanup(path):
        del path
        raise ExternalAgentWorkspaceError("EXTERNAL_AGENT_WORKSPACE_CLEANUP_FAILED")

    monkeypatch.setattr(module, "AntigravityExternalAgentExecution", FailingExecution)
    monkeypatch.setattr(module, "cleanup_external_workspace", failing_cleanup)
    result = asyncio.run(module.DefaultExternalAgentGraphServices().run(_input()))
    assert result.external_status == "BLOCKED"
    assert result.failure_code == "EXTERNAL_AGENT_WORKSPACE_CLEANUP_FAILED"
    assert result.failure_class == "POLICY_DENIED"
    rows = [json.loads(line) for line in ledger.read_text(encoding="utf-8").splitlines()]
    assert [row["event"] for row in rows] == ["STARTED", "FINISHED"]
    assert rows[-1]["outcome"] == "BLOCKED"
    assert rows[-1]["failure_class"] == "POLICY_DENIED"
    assert rows[-1]["fallback_reason"] == "EXTERNAL_AGENT_WORKSPACE_CLEANUP_FAILED"
