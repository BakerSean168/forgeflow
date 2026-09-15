import importlib.util
import json
from pathlib import Path

import pytest

from forgeflow.learning import record_review_snapshot

SCRIPT = Path(__file__).resolve().parents[1] / "deploy/gcp-dev/run-invariant-supervisor.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("forgeflow_invariant_supervisor_cli", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _unknown(fid: str, title: str, description: str, file: str):
    return {
        "id": fid,
        "severity": "medium",
        "status": "resolved",
        "title": title,
        "description": description,
        "file": file,
    }


def _seed(config: Path, state: Path) -> None:
    config.mkdir(parents=True)
    state.mkdir(parents=True)
    (config / "local-auth.secret").write_text("test-token", encoding="utf-8")
    (config / "projects.json").write_text(
        json.dumps([{"repo": "BakerSean168/MemoFlow"}]), encoding="utf-8"
    )
    learning = state / "invariant-learning.jsonl"
    record_review_snapshot(
        repository="BakerSean168/MemoFlow",
        pr_number=501,
        head_sha="a" * 40,
        path=learning,
        findings=(
            _unknown(
                "u1",
                "Frobnicator drops continuity marker",
                "Widget frobnicator loses continuity marker when stream resumes.",
                "frobnicator.ts",
            ),
        ),
    )
    record_review_snapshot(
        repository="BakerSean168/MemoFlow",
        pr_number=502,
        head_sha="b" * 40,
        path=learning,
        findings=(
            _unknown(
                "u2",
                "Frobnicator continuity marker disappears",
                "Another widget frobnicator loses continuity marker on resume.",
                "resume-frobnicator.ts",
            ),
        ),
    )


class FakeAssistants:
    async def search(self, **_kwargs):
        return [{"graph_id": "invariant_reviewer", "assistant_id": "assistant-1"}]


class FakeThreads:
    def __init__(self, client):
        self.client = client

    async def create(self, **kwargs):
        self.client.thread_id = kwargs["thread_id"]
        return {"thread_id": kwargs["thread_id"]}

    async def get_state(self, _thread_id):
        return {"values": dict(self.client.state)}


class FakeRuns:
    def __init__(self, client):
        self.client = client

    async def list(self, _thread_id, **_kwargs):
        return list(self.client.runs_rows)

    async def wait(self, _thread_id, _assistant_id, **kwargs):
        self.client.wait_calls += 1
        proposal = kwargs["input"]["proposal"]
        self.client.state = {
            "proposal": proposal,
            "decision": {
                "decision": "accept",
                "title": "Preserve frobnicator continuity marker",
                "triggers": ["frobnicator", "continuity"],
                "check": "Widget resume must preserve the continuity marker across frobnicator boundaries.",
                "adversarial": "Interrupt a widget flow, resume it, and compare the continuity marker.",
                "rationale": "Independent PRs fixed the same root cause.",
            },
            "reviewer_model_id": "openai:gpt-5.6-sol",
        }
        run = {
            "run_id": "run-1",
            "status": "success",
            "metadata": kwargs["metadata"],
        }
        self.client.runs_rows = [run]
        callback = kwargs.get("on_run_created")
        if callback:
            callback({"run_id": "run-1"})
        return self.client.state


class FakeClient:
    def __init__(self):
        self.state = {}
        self.runs_rows = []
        self.wait_calls = 0
        self.assistants = FakeAssistants()
        self.threads = FakeThreads(self)
        self.runs = FakeRuns(self)


@pytest.mark.asyncio
async def test_supervisor_reviews_once_then_accepted_proposal_is_not_repeated(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = _load_module()
    config, state = tmp_path / "config", tmp_path / "state"
    _seed(config, state)
    fake = FakeClient()
    monkeypatch.setattr(module, "get_client", lambda **_kwargs: fake)
    monkeypatch.setenv("FORGEFLOW_INVARIANT_LEDGER_FILE", str(state / "invariant-learning.jsonl"))
    monkeypatch.setenv(
        "FORGEFLOW_INVARIANT_PROPOSAL_FILE", str(state / "invariant-proposals.jsonl")
    )

    assert await module.run_once(port=58810, config_dir=config, state_dir=state) == 0
    assert fake.wait_calls == 1
    assert (state / "invariant-proposals.jsonl").is_file()
    assert await module.run_once(port=58810, config_dir=config, state_dir=state) == 0
    assert fake.wait_calls == 1


@pytest.mark.asyncio
async def test_supervisor_recovers_completed_review_without_new_model_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = _load_module()
    config, state = tmp_path / "config", tmp_path / "state"
    _seed(config, state)
    fake = FakeClient()
    monkeypatch.setattr(module, "get_client", lambda **_kwargs: fake)
    monkeypatch.setenv("FORGEFLOW_INVARIANT_LEDGER_FILE", str(state / "invariant-learning.jsonl"))
    monkeypatch.setenv(
        "FORGEFLOW_INVARIANT_PROPOSAL_FILE", str(state / "invariant-proposals.jsonl")
    )

    # Simulate a previous process that completed the durable reviewer graph but
    # crashed before recording the local proposal decision ledger.
    from forgeflow.proposals import pending_proposals

    candidate = pending_proposals("BakerSean168/MemoFlow")[0]
    fake.state = {
        "proposal": {
            "proposal_id": candidate.proposal_id,
            "revision_id": candidate.revision_id,
            "repository": candidate.repository,
        },
        "decision": {
            "decision": "accept",
            "title": "Preserve frobnicator continuity marker",
            "triggers": ["frobnicator", "continuity"],
            "check": "Widget resume must preserve the continuity marker across frobnicator boundaries.",
            "adversarial": "Interrupt a widget flow, resume it, and compare the continuity marker.",
            "rationale": "Independent PRs fixed the same root cause.",
        },
        "reviewer_model_id": "openai:gpt-5.6-sol",
    }
    fake.runs_rows = [
        {
            "run_id": "run-existing",
            "status": "success",
            "metadata": {
                "proposal_id": candidate.proposal_id,
                "revision_id": candidate.revision_id,
            },
        }
    ]

    assert await module.run_once(port=58810, config_dir=config, state_dir=state) == 0
    assert fake.wait_calls == 0
    assert "run-existing" in (state / "invariant-proposals.jsonl").read_text(encoding="utf-8")
