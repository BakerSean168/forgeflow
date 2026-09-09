from dataclasses import dataclass, field

import pytest

from forgeflow.adapters.openswe import OpenSweAdapterError, OpenSweReviewerRuntime, ReviewerSnapshot
from forgeflow.evidence import EvidenceViolation, review_decision

PR = "https://github.com/o/r/pull/1"
HEAD = "a" * 40


@dataclass
class FakeThreads:
    records: dict[str, dict] = field(default_factory=dict)

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
async def test_official_reviewer_trigger_requires_sol_medium_effective_defaults() -> None:
    client = FakeClient()
    client.threads.records["review-thread"] = {
        "metadata": {"current_reviewer_run_id": "review-run"}
    }
    calls = []

    async def trigger(pr_ref, **kwargs):
        calls.append((pr_ref, kwargs))
        return {"success": True, "thread_id": "review-thread", "pr_url": pr_ref.url}

    async def model_pairs(role):
        assert role == "reviewer"
        return (("openai:gpt-5.6-sol", "medium"), ("openai:gpt-5.6-sol", "medium"))

    runtime = OpenSweReviewerRuntime(client, trigger=trigger, model_pair_reader=model_pairs)
    thread_id, run_id = await runtime.trigger_review(PR)
    assert (thread_id, run_id) == ("review-thread", "review-run")
    assert calls[0][1] == {"source": "forgeflow"}


@pytest.mark.asyncio
async def test_model_policy_mismatch_fails_before_official_trigger() -> None:
    called = False

    async def trigger(*args, **kwargs):
        nonlocal called
        called = True
        return {"success": True}

    async def model_pairs(role):
        return (("openai:gpt-5.6-luna", "high"), ("openai:gpt-5.6-sol", "medium"))

    runtime = OpenSweReviewerRuntime(FakeClient(), trigger=trigger, model_pair_reader=model_pairs)
    with pytest.raises(OpenSweAdapterError, match="model policy mismatch"):
        await runtime.trigger_review(PR)
    assert called is False


@pytest.mark.asyncio
async def test_read_review_returns_only_bounded_reviewer_state() -> None:
    client = FakeClient()
    client.threads.records["rt"] = {"metadata": {"last_reviewed_sha": HEAD, "huge": "ignored"}}
    client.runs.records[("rt", "rr")] = {"status": "success", "messages": ["ignored"]}

    async def findings_reader(thread_id):
        assert thread_id == "rt"
        return [{"id": "f1", "severity": "high", "status": "open", "description": "x"}]

    runtime = OpenSweReviewerRuntime(client, findings_reader=findings_reader)
    snapshot = await runtime.read_review(thread_id="rt", run_id="rr")
    assert snapshot.last_reviewed_sha == HEAD
    assert snapshot.run_status == "success"
    assert snapshot.findings[0]["id"] == "f1"


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
