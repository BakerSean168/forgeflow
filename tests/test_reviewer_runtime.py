from dataclasses import dataclass, field

import pytest

from forgeflow.adapters.openswe import (
    OpenSweReviewerRuntime,
    ReviewerSnapshot,
    ReviewerSupersededError,
    reviewer_thread_id,
)
from forgeflow.evidence import EvidenceViolation, review_decision

PR = "https://github.com/o/r/pull/1"
HEAD = "a" * 40


@dataclass
class FakeThreads:
    records: dict[str, dict] = field(default_factory=dict)
    fail_pointer_update_once: bool = False

    async def create(self, **kwargs):
        self.records.setdefault(
            kwargs["thread_id"], {"status": "idle", "metadata": dict(kwargs.get("metadata") or {})}
        )
        return self.records[kwargs["thread_id"]]

    async def get(self, thread_id):
        return self.records[thread_id]

    async def update(self, *, thread_id, metadata):
        if self.fail_pointer_update_once and "current_reviewer_run_id" in metadata:
            self.fail_pointer_update_once = False
            raise RuntimeError("simulated pointer write failure")
        self.records.setdefault(thread_id, {"status": "idle", "metadata": {}})
        self.records[thread_id].setdefault("metadata", {}).update(metadata)
        return self.records[thread_id]


@dataclass
class FakeRuns:
    records: dict[tuple[str, str], dict] = field(default_factory=dict)

    async def get(self, thread_id, run_id):
        return self.records[(thread_id, run_id)]

    async def list(self, thread_id, limit=100):
        return [value for (tid, _), value in self.records.items() if tid == thread_id][:limit]


@dataclass
class FakeClient:
    threads: FakeThreads = field(default_factory=FakeThreads)
    runs: FakeRuns = field(default_factory=FakeRuns)


@pytest.mark.asyncio
async def test_official_reviewer_dispatch_is_sol_medium_and_operation_keyed() -> None:
    client = FakeClient()
    calls = []

    async def dispatch(thread_id, content, configurable, **kwargs):
        calls.append((thread_id, content, configurable, kwargs))
        run_id = "review-run"
        client.runs.records[(thread_id, run_id)] = {
            "run_id": run_id, "status": "running", "metadata": dict(kwargs["metadata"])
        }
        return {"run_id": run_id}

    runtime = OpenSweReviewerRuntime(client, dispatch=dispatch)
    thread_id, run_id = await runtime.trigger_review(
        owner="o", repo="r", pr_number=1, pr_url=PR, head_sha=HEAD, head_ref="feature",
        base_sha="b" * 40, base_ref="main", operation_key="review:head:retry:0"
    )
    assert run_id == "review-run"
    assert client.threads.records[thread_id]["metadata"]["current_reviewer_run_id"] == run_id
    configurable = calls[0][2]
    kwargs = calls[0][3]
    assert configurable["reviewer_model_id"] == "openai:gpt-5.6-sol"
    assert configurable["reviewer_reasoning_effort"] == "medium"
    assert configurable["reviewer_subagent_model_id"] == "openai:gpt-5.6-sol"
    assert configurable["reviewer_subagent_reasoning_effort"] == "medium"
    assert kwargs["assistant_id"] == "reviewer"
    assert kwargs["metadata"]["forgeflow_review_operation_key"] == "review:head:retry:0"


@pytest.mark.asyncio
async def test_review_run_created_before_pointer_write_is_recovered_by_operation_key() -> None:
    client = FakeClient()
    client.threads.fail_pointer_update_once = True

    async def dispatch(thread_id, content, configurable, **kwargs):
        run_id = "orphaned-review-run"
        client.runs.records[(thread_id, run_id)] = {
            "run_id": run_id, "status": "running", "metadata": dict(kwargs["metadata"])
        }
        return {"run_id": run_id}

    runtime = OpenSweReviewerRuntime(client, dispatch=dispatch)
    with pytest.raises(RuntimeError, match="pointer write failure"):
        await runtime.trigger_review(
            owner="o", repo="r", pr_number=1, pr_url=PR, head_sha=HEAD, head_ref="feature",
            base_sha="b" * 40, base_ref="main", operation_key="review:head:retry:0"
        )
    recovered = await runtime.find_current_review(
        pr_url=PR, expected_head_sha=HEAD, operation_key="review:head:retry:0"
    )
    assert recovered is not None
    assert recovered[1] == "orphaned-review-run"
    assert client.threads.records[recovered[0]]["metadata"]["current_reviewer_run_id"] == recovered[1]
    snapshot = await runtime.read_review(thread_id=recovered[0], run_id=recovered[1])
    assert snapshot.run_id == recovered[1]


@pytest.mark.asyncio
async def test_read_review_returns_only_bounded_reviewer_state() -> None:
    client = FakeClient()
    client.threads.records["rt"] = {
        "metadata": {"current_reviewer_run_id": "rr", "last_reviewed_sha": HEAD, "huge": "ignored"}
    }
    client.runs.records[("rt", "rr")] = {"status": "success", "messages": ["ignored"]}

    async def findings_reader(thread_id):
        assert thread_id == "rt"
        return [{"id": "f1", "severity": "high", "status": "open", "description": "x"}]

    runtime = OpenSweReviewerRuntime(client, findings_reader=findings_reader)
    snapshot = await runtime.read_review(thread_id="rt", run_id="rr")
    assert snapshot.last_reviewed_sha == HEAD
    assert snapshot.run_status == "success"
    assert snapshot.findings[0]["id"] == "f1"



@pytest.mark.asyncio
async def test_default_findings_reader_uses_runtime_client_metadata() -> None:
    client = FakeClient()
    client.threads.records["rt"] = {
        "metadata": {
            "current_reviewer_run_id": "rr",
            "last_reviewed_sha": HEAD,
            "findings": [{"id": "f1", "severity": "medium", "status": "open", "description": "x"}],
        }
    }
    client.runs.records[("rt", "rr")] = {"status": "success"}
    snapshot = await OpenSweReviewerRuntime(client).read_review(thread_id="rt", run_id="rr")
    assert len(snapshot.findings) == 1
    assert snapshot.findings[0]["id"] == "f1"
    assert snapshot.findings[0]["severity"] == "medium"
    assert snapshot.findings[0]["status"] == "open"

def test_exact_head_reviewer_snapshot_normalizes_structured_findings() -> None:
    snapshot = ReviewerSnapshot(
        thread_id="rt",
        run_id="rr",
        run_status="success",
        last_reviewed_sha=HEAD,
        findings=(
            {"id": "f1", "severity": "high", "status": "open"},
            {"id": "f2", "severity": "low", "status": "resolved"},
        ),
    )
    decision = review_decision(snapshot, expected_head_sha=HEAD)
    assert [f.id for f in decision.findings] == ["f1", "f2"]


def test_stale_or_unsuccessful_review_never_becomes_review_decision() -> None:
    stale = ReviewerSnapshot(
        thread_id="rt", run_id="rr", run_status="success", last_reviewed_sha="b" * 40, findings=()
    )
    failed = ReviewerSnapshot(
        thread_id="rt", run_id="rr", run_status="error", last_reviewed_sha=HEAD, findings=()
    )
    with pytest.raises(EvidenceViolation, match="stale"):
        review_decision(stale, expected_head_sha=HEAD)
    with pytest.raises(EvidenceViolation, match="not successful"):
        review_decision(failed, expected_head_sha=HEAD)


@pytest.mark.asyncio
async def test_historical_success_cannot_mix_with_current_reviewer_thread_findings() -> None:
    client = FakeClient()
    client.threads.records["rt"] = {
        "metadata": {"current_reviewer_run_id": "r2", "last_reviewed_sha": HEAD}
    }
    client.runs.records[("rt", "r1")] = {"status": "success"}

    async def findings_reader(_thread_id):
        return []

    runtime = OpenSweReviewerRuntime(client, findings_reader=findings_reader)
    with pytest.raises(ReviewerSupersededError) as exc:
        await runtime.read_review(thread_id="rt", run_id="r1")
    assert exc.value.current_run_id == "r2"


@pytest.mark.asyncio
async def test_operation_run_does_not_overwrite_a_different_current_reviewer_run() -> None:
    client = FakeClient()
    thread_id = reviewer_thread_id("o", "r", 1)
    client.threads.records[thread_id] = {
        "metadata": {
            "head_sha": HEAD,
            "current_reviewer_run_id": "external-current",
        }
    }
    client.runs.records[(thread_id, "our-run")] = {
        "run_id": "our-run",
        "status": "success",
        "metadata": {"forgeflow_review_operation_key": "review:head:retry:0"},
    }
    runtime = OpenSweReviewerRuntime(client)
    with pytest.raises(ReviewerSupersededError) as exc:
        await runtime.find_current_review(
            pr_url=PR, expected_head_sha=HEAD, operation_key="review:head:retry:0"
        )
    assert exc.value.current_run_id == "external-current"
    assert client.threads.records[thread_id]["metadata"]["current_reviewer_run_id"] == "external-current"
