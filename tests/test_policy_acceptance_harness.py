import importlib.util
import json
import stat
from pathlib import Path

import httpx
import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "deploy/gcp-dev/run_policy_acceptance.py"
spec = importlib.util.spec_from_file_location("run_policy_acceptance", SCRIPT)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_acceptance_evidence_is_bounded_and_mode_600(tmp_path: Path) -> None:
    values = {
        "status": "READY",
        "pr_url": "https://github.com/o/r/pull/1",
        "observed_head_sha": "a" * 40,
        "ci_head_sha": "a" * 40,
        "reviewed_head_sha": "a" * 40,
        "huge_runtime_blob": {"must": "not leak"},
    }
    evidence = module.extract_evidence(values, thread_id="thread-1", worktree=tmp_path / "wt")
    assert evidence["status"] == "READY"
    assert evidence["ci_head_sha"] == evidence["reviewed_head_sha"] == "a" * 40
    assert "huge_runtime_blob" not in evidence
    path = tmp_path / "evidence.json"
    module.write_evidence(path, evidence)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    saved = json.loads(path.read_text())
    assert saved["policy_thread_id"] == "thread-1"


def test_acceptance_terminal_set_treats_ready_as_evidence_not_runtime_terminal() -> None:
    assert module.TERMINAL_FOR_ACCEPTANCE == {"READY", "ESCALATED", "CANCELLED"}


class _FakeRuns:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.calls: list[dict[str, object]] = []

    async def wait(self, thread_id: str, assistant_id: str, **kwargs: object) -> None:
        self.calls.append({"thread_id": thread_id, "assistant_id": assistant_id, **kwargs})
        if self.error is not None:
            raise self.error


class _FakeClient:
    def __init__(self, runs: _FakeRuns) -> None:
        self.runs = runs


def _http_error(status: int, detail: str) -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "http://127.0.0.1/threads/t/runs/wait")
    response = httpx.Response(status, request=request, json={"detail": detail})
    return httpx.HTTPStatusError("reconcile failed", request=request, response=response)


@pytest.mark.asyncio
async def test_reconcile_yields_when_policy_cron_already_owns_thread_slot() -> None:
    runs = _FakeRuns(_http_error(409, "Thread is already running a task. Wait for it."))
    accepted = await module._reconcile(_FakeClient(runs), "thread-1", "assistant-1", {})
    assert accepted is False
    assert runs.calls[0]["multitask_strategy"] == "reject"


@pytest.mark.asyncio
async def test_reconcile_reports_when_manual_step_was_accepted() -> None:
    runs = _FakeRuns()
    accepted = await module._reconcile(
        _FakeClient(runs), "thread-1", "assistant-1", {"objective": "x"}
    )
    assert accepted is True
    assert runs.calls[0]["input"] == {"objective": "x"}


@pytest.mark.asyncio
async def test_reconcile_does_not_swallow_unrelated_conflict() -> None:
    runs = _FakeRuns(_http_error(409, "Different conflict"))
    with pytest.raises(httpx.HTTPStatusError):
        await module._reconcile(_FakeClient(runs), "thread-1", "assistant-1", {})
