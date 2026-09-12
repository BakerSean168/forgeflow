from dataclasses import dataclass, field

import pytest

from openswe_ext.external_agent_runtime import (
    ExternalAgentChildRuntime,
    external_implementation_thread_id,
)


@dataclass
class FakeThreads:
    records: dict[str, dict] = field(default_factory=dict)
    states: dict[str, dict] = field(default_factory=dict)

    async def create(self, **kwargs):
        self.records.setdefault(
            kwargs["thread_id"],
            {"status": "idle", "metadata": dict(kwargs.get("metadata") or {})},
        )
        return self.records[kwargs["thread_id"]]

    async def get(self, thread_id):
        return self.records[thread_id]

    async def get_state(self, thread_id):
        return self.states.get(thread_id, {"values": {}})


@dataclass
class FakeRuns:
    records: dict[tuple[str, str], dict] = field(default_factory=dict)
    next_id: str = "run-1"

    async def create(self, thread_id, assistant_id, **kwargs):
        assert assistant_id == "external_agent"
        self.records[(thread_id, self.next_id)] = {
            "run_id": self.next_id,
            "status": "pending",
            "metadata": kwargs.get("metadata") or {},
        }
        return self.records[(thread_id, self.next_id)]

    async def list(self, thread_id, limit=100):
        del limit
        return [value for (tid, _), value in self.records.items() if tid == thread_id]

    async def get(self, thread_id, run_id):
        return self.records[(thread_id, run_id)]


class FakeClient:
    def __init__(self):
        self.threads = FakeThreads()
        self.runs = FakeRuns()


@pytest.mark.asyncio
async def test_external_runtime_dispatches_idempotent_operation_and_projects_pr_state() -> None:
    client = FakeClient()
    runtime = ExternalAgentChildRuntime(client)
    thread_id = await runtime.ensure_thread(
        policy_thread_id="policy",
        route_id="anti",
        repo_owner="o",
        repo_name="r",
        objective="implement x",
    )
    assert thread_id == external_implementation_thread_id("policy", "anti")
    run_id = await runtime.dispatch(
        thread_id=thread_id,
        route_id="anti",
        objective="implement x",
        repo_owner="o",
        repo_name="r",
        base_ref="main",
        operation_key="op:1",
        phase="IMPLEMENT",
    )
    assert await runtime.find_run_by_operation(thread_id=thread_id, operation_key="op:1") == run_id

    client.runs.records[(thread_id, run_id)]["status"] = "success"
    client.threads.states[thread_id] = {
        "values": {
            "external_status": "SUCCESS",
            "pr_url": "https://github.com/o/r/pull/1",
            "pr_number": 1,
            "head_ref": "forgeflow/external-x",
            "base_ref": "main",
        }
    }
    snapshot = await runtime.read_run(thread_id=thread_id, run_id=run_id)
    assert snapshot.status == "success"
    thread = await runtime.read_thread(thread_id)
    assert thread.metadata["pull_requests"][0]["number"] == 1


@pytest.mark.asyncio
async def test_external_runtime_maps_blocked_graph_result_to_child_failure() -> None:
    client = FakeClient()
    runtime = ExternalAgentChildRuntime(client)
    thread_id = await runtime.ensure_thread(
        policy_thread_id="policy",
        route_id="anti",
        repo_owner="o",
        repo_name="r",
        objective="implement x",
    )
    run_id = await runtime.dispatch(
        thread_id=thread_id,
        route_id="anti",
        objective="implement x",
        repo_owner="o",
        repo_name="r",
        base_ref="main",
        operation_key="op:2",
        phase="IMPLEMENT",
    )
    client.runs.records[(thread_id, run_id)]["status"] = "success"
    client.threads.states[thread_id] = {
        "values": {
            "external_status": "BLOCKED",
            "failure_code": "ANTIGRAVITY_TIMEOUT",
            "failure_class": "ROUTE_AVAILABILITY",
        }
    }
    snapshot = await runtime.read_run(thread_id=thread_id, run_id=run_id)
    assert snapshot.status == "error"
    assert snapshot.failure_code == "ANTIGRAVITY_TIMEOUT"
    assert snapshot.failure_class == "ROUTE_AVAILABILITY"
