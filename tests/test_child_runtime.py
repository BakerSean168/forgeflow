from dataclasses import dataclass, field

import pytest

from forgeflow.adapters.openswe import OpenSweChildRuntime, implementation_thread_id


@dataclass
class FakeThreads:
    created: list[dict] = field(default_factory=list)
    records: dict[str, dict] = field(default_factory=dict)

    async def create(self, **kwargs):
        self.created.append(kwargs)
        self.records.setdefault(
            kwargs["thread_id"], {"status": "idle", "metadata": kwargs.get("metadata", {})}
        )
        return self.records[kwargs["thread_id"]]

    async def get(self, thread_id):
        return self.records[thread_id]


@dataclass
class FakeRuns:
    records: dict[tuple[str, str], dict] = field(default_factory=dict)

    async def get(self, thread_id, run_id):
        return self.records[(thread_id, run_id)]


@dataclass
class FakeClient:
    threads: FakeThreads = field(default_factory=FakeThreads)
    runs: FakeRuns = field(default_factory=FakeRuns)


@pytest.mark.asyncio
async def test_one_policy_thread_maps_to_one_stable_implementation_thread() -> None:
    client = FakeClient()
    runtime = OpenSweChildRuntime(client)
    first = await runtime.ensure_implementation_thread(
        policy_thread_id="policy-1", repo_owner="o", repo_name="r", objective="Do work"
    )
    second = await runtime.ensure_implementation_thread(
        policy_thread_id="policy-1", repo_owner="o", repo_name="r", objective="Do work"
    )
    assert first == second == implementation_thread_id("policy-1")
    assert all(call["if_exists"] == "do_nothing" for call in client.threads.created)


@pytest.mark.asyncio
async def test_implementation_and_repair_dispatch_reuse_same_thread() -> None:
    calls = []

    async def fake_dispatch(thread_id, content, configurable, **kwargs):
        calls.append((thread_id, content, configurable, kwargs))
        return {"run_id": f"run-{len(calls)}"}

    client = FakeClient()
    runtime = OpenSweChildRuntime(client, dispatch=fake_dispatch)
    thread_id = await runtime.ensure_implementation_thread(
        policy_thread_id="policy-1", repo_owner="o", repo_name="r", objective="Do work"
    )
    first = await runtime.dispatch_implementation(
        thread_id=thread_id, objective="Do work", repo_owner="o", repo_name="r"
    )
    second = await runtime.dispatch_repair(
        thread_id=thread_id, prompt="Fix finding f1", repo_owner="o", repo_name="r"
    )
    assert (first, second) == ("run-1", "run-2")
    assert {call[0] for call in calls} == {thread_id}
    assert all(call[2]["agent_model_id"] == "openai:gpt-5.6-luna" for call in calls)
    assert all(call[2]["agent_effort"] == "xhigh" for call in calls)
    assert all(call[3]["multitask_strategy"] == "enqueue" for call in calls)


@pytest.mark.asyncio
async def test_read_run_and_thread_are_bounded_snapshots() -> None:
    client = FakeClient()
    client.runs.records[("t", "r")] = {"status": "success", "huge": "ignored"}
    client.threads.records["t"] = {"status": "idle", "metadata": {"pr_url": "x"}, "values": {"huge": 1}}
    runtime = OpenSweChildRuntime(client)
    run = await runtime.read_run(thread_id="t", run_id="r")
    thread = await runtime.read_thread("t")
    assert run.status == "success"
    assert thread.metadata == {"pr_url": "x"}
