from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi import HTTPException

import forgeflow.operator_api as api


class FakeAssistants:
    async def search(self, **kwargs):
        return [{"assistant_id": "forgeflow-assistant"}]


class FakeThreads:
    def __init__(self):
        self.rows: dict[str, dict] = {}

    async def create(self, **kwargs):
        row = {
            "thread_id": kwargs["thread_id"],
            "metadata": {**kwargs.get("metadata", {}), "graph_id": kwargs.get("graph_id") or "forgeflow"},
            "values": {},
            "status": "idle",
            "created_at": "2026-09-13T00:00:00+00:00",
            "updated_at": "2026-09-13T00:00:00+00:00",
        }
        self.rows[row["thread_id"]] = row
        return row

    async def search(self, **kwargs):
        return list(self.rows.values())

    async def get(self, thread_id, **kwargs):
        return self.rows[thread_id]


class FakeRuns:
    def __init__(self, threads):
        self.threads = threads
        self.calls = []

    async def create(self, thread_id, assistant_id, **kwargs):
        self.calls.append((thread_id, assistant_id, kwargs))
        if kwargs.get("input"):
            self.threads.rows[thread_id]["values"].update(kwargs["input"])
        return {"run_id": f"run-{len(self.calls)}"}


class FakeClient:
    def __init__(self):
        self.assistants = FakeAssistants()
        self.threads = FakeThreads()
        self.runs = FakeRuns(self.threads)


@pytest.fixture
def manifest(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "projects.json"
    path.write_text(
        json.dumps(
            [
                {"name": "MemoFlow", "repo": "BakerSean168/memoflow", "cwd": "/tmp/memoflow", "ci_required": True, "required_checks": ["Validate Oracle"]},
                "/obsolete/worktree",
                {"name": "BodySense vNext", "repo": "BakerSean168/BodySense", "cwd": "/tmp/bodysense", "ci_required": True, "required_checks": ["Quality Oracle"]},
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("OPEN_SWE_LOCAL_PROJECTS_FILE", str(path))
    monkeypatch.setenv("OPEN_SWE_LOCAL_AUTH_TOKEN", "secret")
    return path


def test_project_manifest_ignores_legacy_string_entry(manifest: Path) -> None:
    projects = api._load_projects()
    assert [row["projectKey"] for row in projects] == ["memoflow", "bodysense"]


def test_operator_auth_rejects_missing_or_wrong_token(manifest: Path) -> None:
    with pytest.raises(HTTPException) as missing:
        api.require_operator_auth(None)
    assert missing.value.status_code == 401
    with pytest.raises(HTTPException) as wrong:
        api.require_operator_auth("Bearer wrong")
    assert wrong.value.status_code == 401
    api.require_operator_auth("Bearer secret")


def test_create_and_list_objective_use_langgraph_thread_as_plan_id(manifest: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = FakeClient()
    monkeypatch.setattr(api, "_client", lambda: client)
    created = asyncio.run(
        api.create_objective(
            api.ObjectiveCreate(projectKey="memoflow", objective="Implement durable status panel", acceptanceCriteria=["CI passes"]),
            authorization="Bearer secret",
        )
    )
    assert created["planId"] == created["threadId"]
    assert created["projectKey"] == "memoflow"
    assert client.runs.calls[0][2]["input"]["repo_name"] == "memoflow"
    thread = client.threads.rows[created["threadId"]]
    thread["values"]["status"] = "IMPLEMENTING"
    listed = asyncio.run(api.list_objectives(project_key="memoflow", active_only=True, limit=10, authorization="Bearer secret"))
    assert listed["objectives"][0]["status"] == "IMPLEMENTING"
    assert listed["objectives"][0]["planId"] == created["planId"]


def test_summary_surfaces_latest_project_state(manifest: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = FakeClient()
    monkeypatch.setattr(api, "_client", lambda: client)
    monkeypatch.delenv("FORGEFLOW_ROUTE_CONFIG_FILE", raising=False)
    asyncio.run(client.threads.create(thread_id="body-1", graph_id="forgeflow", metadata={"repo": {"owner": "BakerSean168", "name": "BodySense"}}))
    client.threads.rows["body-1"]["values"] = {"repo_owner": "BakerSean168", "repo_name": "BodySense", "objective": "Phase 02", "status": "ESCALATED", "last_failure_code": "CHILD_RUN_ERROR"}
    payload = asyncio.run(api.summary(authorization="Bearer secret"))
    body = next(row for row in payload["projects"] if row["projectKey"] == "bodysense")
    assert body["latestObjective"]["status"] == "ESCALATED"
    assert body["latestObjective"]["lastFailureCode"] == "CHILD_RUN_ERROR"
