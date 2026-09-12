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

    import httpx2

    import openswe_ext.external_agent_graph as module
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


def test_request_error_failure_code_preserves_structured_antigravity_code() -> None:
    from acp.exceptions import RequestError

    from openswe_ext.external_agent_graph import _failure_code

    exc = RequestError(
        -32012,
        "Antigravity bootstrap failed",
        {"code": "ANTIGRAVITY_TIMEOUT"},
    )
    assert _failure_code(exc) == "ANTIGRAVITY_TIMEOUT"
