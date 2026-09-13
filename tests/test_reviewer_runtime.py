from dataclasses import dataclass, field

import pytest

from forgeflow.adapters.openswe import (
    OpenSweReviewerRuntime,
    ReviewerSnapshot,
    ReviewerSupersededError,
    reviewer_thread_id,
)
from forgeflow.evidence import EvidenceViolation, blocking_repair_findings, review_decision

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


def test_unchanged_open_finding_remains_blocking_after_exact_head_rereview() -> None:
    old_head = "b" * 40
    snapshot = ReviewerSnapshot(
        thread_id="rt",
        run_id="rr",
        run_status="success",
        last_reviewed_sha=HEAD,
        findings=(
            {
                "id": "unchanged",
                "severity": "medium",
                "status": "open",
                "last_confirmed_sha": old_head,
                "title": "Unchanged finding",
                "file": "docs/old.md",
                "description": "The reviewer took no action, so this remains open.",
            },
        ),
    )

    decision = review_decision(snapshot, expected_head_sha=HEAD)
    assert [finding.id for finding in decision.findings] == ["unchanged"]
    repairs = blocking_repair_findings(snapshot, expected_head_sha=HEAD)
    assert [finding.id for finding in repairs] == ["unchanged"]


def test_resolved_historical_finding_does_not_reenter_current_head_summary() -> None:
    snapshot = ReviewerSnapshot(
        thread_id="rt",
        run_id="rr",
        run_status="success",
        last_reviewed_sha=HEAD,
        findings=(
            {
                "id": "resolved-old",
                "severity": "high",
                "status": "resolved",
                "last_confirmed_sha": "b" * 40,
            },
        ),
    )
    assert review_decision(snapshot, expected_head_sha=HEAD).findings == ()


def test_current_head_and_legacy_findings_remain_actionable() -> None:
    snapshot = ReviewerSnapshot(
        thread_id="rt",
        run_id="rr",
        run_status="success",
        last_reviewed_sha=HEAD,
        findings=(
            {
                "id": "current",
                "severity": "high",
                "status": "open",
                "last_confirmed_sha": HEAD,
                "title": "Current finding",
                "file": "src/current.py",
                "description": "Still present on this exact head.",
            },
            {
                "id": "legacy",
                "severity": "low",
                "status": "open",
            },
        ),
    )

    decision = review_decision(snapshot, expected_head_sha=HEAD)
    assert [finding.id for finding in decision.findings] == ["current", "legacy"]


def test_invalid_explicit_last_confirmed_sha_fails_closed() -> None:
    snapshot = ReviewerSnapshot(
        thread_id="rt",
        run_id="rr",
        run_status="success",
        last_reviewed_sha=HEAD,
        findings=(
            {
                "id": "f1",
                "severity": "high",
                "status": "open",
                "last_confirmed_sha": 123,
            },
        ),
    )

    with pytest.raises(EvidenceViolation, match="last_confirmed_sha"):
        review_decision(snapshot, expected_head_sha=HEAD)


@pytest.mark.asyncio
async def test_reviewer_uses_previous_sha_as_incremental_diff_baseline() -> None:
    client = FakeClient()
    thread_id = reviewer_thread_id("o", "r", 1)
    previous = "c" * 40
    client.threads.records[thread_id] = {
        "status": "idle",
        "metadata": {"last_reviewed_sha": previous},
    }
    calls = []
    baseline_calls = []

    async def baseline(owner, repo, base_sha, previous_sha, head_sha):
        baseline_calls.append((owner, repo, base_sha, previous_sha, head_sha))
        return previous_sha

    async def dispatch(thread_id, content, configurable, **kwargs):
        calls.append((content, configurable))
        return {"run_id": "incremental-review"}

    runtime = OpenSweReviewerRuntime(client, dispatch=dispatch, baseline_resolver=baseline)
    await runtime.trigger_review(
        owner="o",
        repo="r",
        pr_number=1,
        pr_url=PR,
        head_sha=HEAD,
        head_ref="feature",
        base_sha="b" * 40,
        base_ref="main",
        operation_key="review:ancestor",
    )

    assert baseline_calls == [("o", "r", "b" * 40, previous, HEAD)]
    assert calls[0][1]["re_review"] is True
    assert calls[0][1]["last_reviewed_sha"] == previous


@pytest.mark.asyncio
async def test_force_push_keeps_rereview_context_but_resets_diff_to_merge_base() -> None:
    client = FakeClient()
    thread_id = reviewer_thread_id("o", "r", 1)
    previous = "c" * 40
    merge_base = "d" * 40
    client.threads.records[thread_id] = {
        "status": "idle",
        "metadata": {"last_reviewed_sha": previous},
    }
    calls = []

    async def reset_baseline(_owner, _repo, _base_sha, _previous_sha, _head_sha):
        return merge_base

    async def dispatch(thread_id, content, configurable, **kwargs):
        calls.append((content, configurable))
        return {"run_id": "force-push-review"}

    runtime = OpenSweReviewerRuntime(
        client, dispatch=dispatch, baseline_resolver=reset_baseline
    )
    await runtime.trigger_review(
        owner="o",
        repo="r",
        pr_number=1,
        pr_url=PR,
        head_sha=HEAD,
        head_ref="feature",
        base_sha="b" * 40,
        base_ref="main",
        operation_key="review:force-push",
    )

    content, configurable = calls[0]
    assert configurable["re_review"] is True
    assert configurable["last_reviewed_sha"] == merge_base
    assert "Reconcile every existing finding" in content


@pytest.mark.asyncio
async def test_same_head_retry_resets_to_full_diff_baseline_instead_of_head_to_head() -> None:
    client = FakeClient()
    thread_id = reviewer_thread_id("o", "r", 1)
    merge_base = "d" * 40
    client.threads.records[thread_id] = {
        "status": "idle",
        "metadata": {"last_reviewed_sha": HEAD},
    }
    calls = []

    async def reset_baseline(_owner, _repo, _base_sha, previous_sha, head_sha):
        assert previous_sha == head_sha == HEAD
        return merge_base

    async def dispatch(thread_id, content, configurable, **kwargs):
        calls.append(configurable)
        return {"run_id": "same-head-full-review"}

    runtime = OpenSweReviewerRuntime(
        client, dispatch=dispatch, baseline_resolver=reset_baseline
    )
    await runtime.trigger_review(
        owner="o",
        repo="r",
        pr_number=1,
        pr_url=PR,
        head_sha=HEAD,
        head_ref="feature",
        base_sha="b" * 40,
        base_ref="main",
        operation_key="review:same-head-retry",
    )

    assert calls[0]["re_review"] is True
    assert calls[0]["last_reviewed_sha"] == merge_base

@pytest.mark.asyncio
async def test_github_compare_decode_error_is_treated_as_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import httpx2

    import forgeflow.adapters.openswe as module

    class BrokenClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, *args, **kwargs):
            raise httpx2.DecodingError("invalid content encoding")

    monkeypatch.setattr(module.httpx2, "AsyncClient", lambda **kwargs: BrokenClient())
    assert await module._github_compare("o", "r", "a" * 40, "b" * 40, "token") is None


@pytest.mark.asyncio
async def test_force_push_baseline_resolver_uses_current_pr_merge_base(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import forgeflow.adapters.openswe as module

    previous = "a" * 40
    base = "b" * 40
    head = "c" * 40
    merge_base = "d" * 40
    calls = []

    async def installation(_owner, _repo):
        return 1

    async def token(**kwargs):
        return "fake-token"

    async def compare(owner, repo, from_sha, to_sha, _token):
        calls.append((from_sha, to_sha))
        if from_sha == previous:
            return {"status": "diverged"}
        return {"status": "ahead", "merge_base_commit": {"sha": merge_base}}

    monkeypatch.setattr(module, "get_github_app_installation_id_for_repo", installation)
    monkeypatch.setattr(module, "get_github_app_installation_token", token)
    monkeypatch.setattr(module, "_github_compare", compare)

    resolved = await module._github_review_diff_baseline("o", "r", base, previous, head)
    assert resolved == merge_base
    assert calls == [(previous, head), (base, head)]


@pytest.mark.asyncio
async def test_unprovable_force_push_baseline_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import forgeflow.adapters.openswe as module

    async def installation(_owner, _repo):
        return 1

    async def token(**kwargs):
        return "fake-token"

    async def unavailable(*args, **kwargs):
        return None

    monkeypatch.setattr(module, "get_github_app_installation_id_for_repo", installation)
    monkeypatch.setattr(module, "get_github_app_installation_token", token)
    monkeypatch.setattr(module, "_github_compare", unavailable)

    with pytest.raises(module.OpenSweAdapterError, match="REVIEW_DIFF_BASELINE_UNAVAILABLE"):
        await module._github_review_diff_baseline(
            "o", "r", "b" * 40, "a" * 40, "c" * 40
        )
