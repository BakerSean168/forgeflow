from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

from forgeflow.adapters.github import PullRequestEvidence
from forgeflow.projects import ContinuousProjectConfig, load_continuous_project_configs

SCRIPT = Path(__file__).resolve().parents[1] / "deploy/gcp-dev/run-project-supervisor.py"
spec = importlib.util.spec_from_file_location("forgeflow_project_supervisor_cli", SCRIPT)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeThreads:
    def __init__(self, rows=None):
        self.rows = list(rows or [])

    async def search(self, **kwargs):
        return self.rows

    async def create(self, **kwargs):
        row = {
            "thread_id": kwargs["thread_id"],
            "metadata": {**kwargs.get("metadata", {}), "graph_id": kwargs.get("graph_id")},
            "values": {},
        }
        self.rows.insert(0, row)
        return row


class FakeRuns:
    def __init__(self):
        self.calls = []

    async def create(self, thread_id, assistant_id, **kwargs):
        self.calls.append((thread_id, assistant_id, kwargs))
        return {"run_id": f"run-{len(self.calls)}"}


class FakeClient:
    def __init__(self, rows=None):
        self.threads = FakeThreads(rows)
        self.runs = FakeRuns()


def _config(tmp_path: Path, *, auto_merge=True) -> ContinuousProjectConfig:
    plan = tmp_path / "docs/plan/active/current.md"
    plan.parent.mkdir(parents=True, exist_ok=True)
    plan.write_text("# plan\n", encoding="utf-8")
    return ContinuousProjectConfig(
        project_key="memoflow",
        owner="BakerSean168",
        repo="memoflow",
        cwd=tmp_path,
        base_ref="feat/convergence",
        plan_paths=(plan,),
        objective="Continue the canonical plan",
        acceptance_criteria=("CI passes",),
        auto_merge_ready=auto_merge,
    )


def _thread(status: str, **values):
    return {
        "thread_id": "policy-1",
        "values": {"status": status, **values},
        "metadata": {"graph_id": "forgeflow", "project_key": "memoflow"},
    }


def test_load_continuous_project_configs_uses_existing_manifest(tmp_path: Path, monkeypatch) -> None:
    repo = tmp_path / "memoflow"
    repo.mkdir()
    manifest = tmp_path / "projects.json"
    manifest.write_text(
        json.dumps(
            [
                {
                    "project_key": "memoflow",
                    "repo": "BakerSean168/memoflow",
                    "cwd": str(repo),
                    "continuous_supervisor": {
                        "enabled": True,
                        "base_ref": "feat/convergence",
                        "plan_paths": ["docs/plan/active/current.md"],
                        "objective": "Continue canonical plan",
                        "acceptance_criteria": ["CI passes"],
                        "auto_merge_ready": True,
                    },
                }
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("OPEN_SWE_LOCAL_PROJECTS_FILE", str(manifest))
    configs = load_continuous_project_configs()
    assert len(configs) == 1
    assert configs[0].project_key == "memoflow"
    assert configs[0].auto_merge_ready is True
    assert configs[0].plan_paths[0] == repo / "docs/plan/active/current.md"


@pytest.mark.asyncio
async def test_supervisor_leaves_active_resource_wait_alone(tmp_path: Path) -> None:
    client = FakeClient([_thread("WAITING_FOR_RESOURCE")])
    result = await module.supervise_project(client, "assistant", _config(tmp_path))
    assert result == "active:WAITING_FOR_RESOURCE"
    assert client.runs.calls == []


@pytest.mark.asyncio
async def test_supervisor_recovers_only_resource_escalation(tmp_path: Path) -> None:
    client = FakeClient([_thread("ESCALATED", last_failure_code="OPENSWE_PROVIDER_UNAVAILABLE")])
    result = await module.supervise_project(client, "assistant", _config(tmp_path))
    assert result == "recovering:OPENSWE_PROVIDER_UNAVAILABLE"
    assert client.runs.calls[0][2]["input"] == {"recover_requested": True}


@pytest.mark.asyncio
async def test_supervisor_does_not_loop_on_engineering_escalation(tmp_path: Path) -> None:
    client = FakeClient([_thread("ESCALATED", last_failure_code="REPAIR_BUDGET_EXHAUSTED")])
    result = await module.supervise_project(client, "assistant", _config(tmp_path))
    assert result == "blocked:REPAIR_BUDGET_EXHAUSTED"
    assert client.runs.calls == []


@pytest.mark.asyncio
async def test_ready_exact_head_merges_then_creates_next_objective(tmp_path: Path, monkeypatch) -> None:
    head = "a" * 40
    client = FakeClient(
        [
            _thread(
                "READY",
                pr_url="https://github.com/BakerSean168/memoflow/pull/1",
                observed_head_sha=head,
                ci_head_sha=head,
                reviewed_head_sha=head,
            )
        ]
    )
    monkeypatch.setattr(module, "_head_is_on_base", lambda config, sha: False)

    async def fake_fetch(url):
        return PullRequestEvidence(
            owner="BakerSean168",
            repo="memoflow",
            number=1,
            url=url,
            state="open",
            head_sha=head,
            head_ref="agent/task",
            base_sha="b" * 40,
            base_ref="feat/convergence",
        )

    async def fake_merge(pr, *, expected_head_sha, merge_method):
        assert expected_head_sha == head
        assert merge_method == "merge"
        return True

    monkeypatch.setattr(module, "fetch_pull_request", fake_fetch)
    monkeypatch.setattr(module, "merge_pull_request_exact_head", fake_merge)
    result = await module.supervise_project(client, "assistant", _config(tmp_path))
    assert result == "merged"
    assert client.runs.calls == []


@pytest.mark.asyncio
async def test_ready_head_already_on_base_creates_exactly_one_next_objective(tmp_path: Path, monkeypatch) -> None:
    head = "a" * 40
    client = FakeClient(
        [
            _thread(
                "READY",
                pr_url="https://github.com/BakerSean168/memoflow/pull/1",
                observed_head_sha=head,
                ci_head_sha=head,
                reviewed_head_sha=head,
            )
        ]
    )
    monkeypatch.setattr(module, "_head_is_on_base", lambda config, sha: True)
    result = await module.supervise_project(client, "assistant", _config(tmp_path))
    assert result.startswith("created:")
    assert len(client.runs.calls) == 1
    assert client.runs.calls[0][2]["input"]["base_ref"] == "feat/convergence"
    assert "Continue the canonical plan" in client.runs.calls[0][2]["input"]["objective"]


@pytest.mark.asyncio
async def test_missing_plan_stops_project_without_new_objective(tmp_path: Path) -> None:
    cfg = _config(tmp_path)
    cfg.plan_paths[0].unlink()
    client = FakeClient([])
    result = await module.supervise_project(client, "assistant", cfg)
    assert result == "plan-complete"
    assert client.runs.calls == []
