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
