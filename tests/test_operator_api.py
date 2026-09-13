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
        self.rows: dict[str, list[dict]] = {}

    async def create(self, thread_id, assistant_id, **kwargs):
        self.calls.append((thread_id, assistant_id, kwargs))
        if kwargs.get("input"):
            self.threads.rows[thread_id]["values"].update(kwargs["input"])
        row = {"run_id": f"run-{len(self.calls)}", "status": "running", "created_at": "2026-09-13T00:00:00+00:00", "updated_at": "2026-09-13T00:00:00+00:00"}
        self.rows.setdefault(thread_id, []).append(row)
        return row

    async def list(self, thread_id, **kwargs):
        return self.rows.get(thread_id, [])


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


def test_summary_exposes_active_agent_provider_model_and_fallback(manifest: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    routes = tmp_path / "routes.json"
    routes.write_text(json.dumps({"version": 1, "routes": [
        {"id": "openswe-current", "role": "IMPLEMENT", "priority": 10, "runtime": "OPEN_SWE", "target": "current-model-policy", "enabled": True, "health": "READY"},
        {"id": "openswe-reviewer", "role": "REASONING", "priority": 10, "runtime": "OPEN_SWE", "target": "openai:gpt-5.6-sol", "enabled": True, "health": "READY"},
        {"id": "openswe-reviewer-glm53", "role": "REASONING", "priority": 20, "runtime": "OPEN_SWE", "target": "fireworks:accounts/fireworks/models/glm-5p3", "enabled": True, "health": "READY"}
    ]}), encoding="utf-8")
    monkeypatch.setenv("FORGEFLOW_ROUTE_CONFIG_FILE", str(routes))
    client = FakeClient()
    monkeypatch.setattr(api, "_client", lambda: client)
    asyncio.run(client.threads.create(thread_id="body-active", graph_id="forgeflow", metadata={"project_key": "bodysense"}))
    asyncio.run(client.threads.create(thread_id="child-1", graph_id="agent", metadata={}))
    client.threads.rows["body-active"]["values"] = {
        "repo_owner": "BakerSean168", "repo_name": "BodySense", "objective": "Finish Phase 02",
        "status": "IMPLEMENTING", "implementation_route_id": "openswe-current",
        "implementation_runtime": "OPEN_SWE", "implementation_thread_id": "child-1",
        "implementation_run_id": "run-child"
    }
    client.runs.rows["child-1"] = [{"run_id": "run-child", "status": "running", "created_at": "2026-09-13T00:01:00+00:00", "updated_at": "2026-09-13T00:02:00+00:00"}]
    client.threads.rows["child-1"]["metadata"][api.LAST_MODEL_ERROR_KEY] = {"run_id": "run-child", "code": "provider_quota_exhausted", "error_type": "FireworksPermissionDeniedError"}
    payload = asyncio.run(api.summary(authorization="Bearer secret"))
    assert payload["activeObjectiveCount"] == 1
    assert payload["runningAgentCount"] == 1
    active = payload["activeObjectives"][0]
    assert active["execution"]["implementation"]["agent"]["name"] == "Open SWE Agent"
    assert active["execution"]["implementation"]["provider"]["name"] == "Private LiteLLM"
    assert active["execution"]["implementation"]["model"]["name"] == "glm-5p3"
    assert active["execution"]["implementation"]["fallbackModel"]["name"] == "gpt-5.6-luna"
    assert active["execution"]["fallbackTriggered"] is True
    assert active["execution"]["childRun"]["status"] == "running"


def test_resources_expose_agent_provider_and_model_profiles(manifest: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    routes = tmp_path / "routes.json"
    routes.write_text(json.dumps({"version": 1, "routes": [
        {"id": "openswe-current", "role": "IMPLEMENT", "priority": 10, "runtime": "OPEN_SWE", "target": "current-model-policy", "enabled": True, "health": "READY"},
        {"id": "antigravity-account-primary", "role": "IMPLEMENT", "priority": 20, "runtime": "EXTERNAL_ACP", "adapter": "antigravity", "target": "google-account", "enabled": True, "health": "READY"},
        {"id": "openswe-reviewer", "role": "REASONING", "priority": 10, "runtime": "OPEN_SWE", "target": "openai:gpt-5.6-sol", "enabled": True, "health": "READY"}
    ]}), encoding="utf-8")
    monkeypatch.setenv("FORGEFLOW_ROUTE_CONFIG_FILE", str(routes))
    payload = asyncio.run(api.list_resources(authorization="Bearer secret"))
    openswe = next(row for row in payload["routes"] if row["id"] == "openswe-current")
    assert openswe["agent"]["name"] == "Open SWE Agent"
    assert openswe["provider"]["name"] == "Private LiteLLM"
    assert openswe["fallbackModel"]["provider"]["name"] == "ChatGPT OAuth"
    antigravity = next(row for row in payload["routes"] if row["id"] == "antigravity-account-primary")
    assert antigravity["agent"]["name"] == "Antigravity"
    assert antigravity["provider"]["name"] == "Google Account"
    reviewer = next(row for row in payload["routes"] if row["id"] == "openswe-reviewer")
    assert reviewer["agent"]["name"] == "Open SWE Reviewer"
    assert reviewer["model"]["name"] == "gpt-5.6-sol"
