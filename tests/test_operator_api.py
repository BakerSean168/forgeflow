from __future__ import annotations

import asyncio
import json
import subprocess
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi import HTTPException

import forgeflow.operator_api as api
from forgeflow.attempts import AttemptLedger
from forgeflow.resource_probes import ResourceProbeStore
from openswe_ext.codebuddy_auth import OFFICIAL_AUTH_FILE


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


def _init_git_workspace(path: Path, repository: str) -> Path:
    path.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(path),
            "remote",
            "add",
            "origin",
            f"https://github.com/{repository}.git",
        ],
        check=True,
    )
    return path


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
    assert created["workspacePath"] is None
    assert client.runs.calls[0][2]["input"]["repo_name"] == "memoflow"
    assert client.runs.calls[0][2]["input"]["workspace_path"] is None
    thread = client.threads.rows[created["threadId"]]
    thread["values"]["status"] = "IMPLEMENTING"
    listed = asyncio.run(api.list_objectives(project_key="memoflow", active_only=True, limit=10, authorization="Bearer secret"))
    assert listed["objectives"][0]["status"] == "IMPLEMENTING"
    assert listed["objectives"][0]["planId"] == created["planId"]


def test_create_objective_accepts_same_repo_workspace(
    manifest: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    workspace = _init_git_workspace(
        tmp_path / "bodysense-recovery", "BakerSean168/BodySense"
    )
    client = FakeClient()
    monkeypatch.setattr(api, "_client", lambda: client)

    created = asyncio.run(
        api.create_objective(
            api.ObjectiveCreate(
                projectKey="bodysense",
                objective="Resume the existing Phase 03 worktree",
                workspacePath=str(workspace),
            ),
            authorization="Bearer secret",
        )
    )

    resolved = str(workspace.resolve())
    assert created["workspacePath"] == resolved
    assert client.runs.calls[0][2]["input"]["workspace_path"] == resolved
    thread = client.threads.rows[created["threadId"]]
    thread["values"]["status"] = "IMPLEMENTING"
    listed = asyncio.run(
        api.list_objectives(
            project_key="bodysense",
            active_only=True,
            limit=10,
            authorization="Bearer secret",
        )
    )
    assert listed["objectives"][0]["workspacePath"] == resolved


@pytest.mark.parametrize(
    "workspace", ["relative/worktree", "/definitely/missing/forgeflow-worktree"]
)
def test_create_objective_rejects_invalid_workspace_path(
    manifest: Path, monkeypatch: pytest.MonkeyPatch, workspace: str
) -> None:
    client = FakeClient()
    monkeypatch.setattr(api, "_client", lambda: client)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            api.create_objective(
                api.ObjectiveCreate(
                    projectKey="bodysense", objective="Resume", workspacePath=workspace
                ),
                authorization="Bearer secret",
            )
        )
    assert exc.value.status_code == 400
    assert client.runs.calls == []


def test_create_objective_rejects_foreign_repository_workspace(
    manifest: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    workspace = _init_git_workspace(
        tmp_path / "foreign", "BakerSean168/not-bodysense"
    )
    client = FakeClient()
    monkeypatch.setattr(api, "_client", lambda: client)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            api.create_objective(
                api.ObjectiveCreate(
                    projectKey="bodysense",
                    objective="Resume",
                    workspacePath=str(workspace),
                ),
                authorization="Bearer secret",
            )
        )
    assert exc.value.status_code == 400
    assert "does not match project" in str(exc.value.detail)
    assert client.runs.calls == []


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
        {"id": "codebuddy-account-primary", "role": "IMPLEMENT", "priority": 30, "runtime": "EXTERNAL_ACP", "adapter": "codebuddy", "target": "codebuddy-account", "enabled": False, "health": "READY"},
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
    codebuddy = next(row for row in payload["routes"] if row["id"] == "codebuddy-account-primary")
    assert codebuddy["agent"]["name"] == "CodeBuddy"
    assert codebuddy["provider"]["name"] == "CodeBuddy Account"
    assert codebuddy["model"]["name"] == "DeepSeek V4.1 Flash"
    reviewer = next(row for row in payload["routes"] if row["id"] == "openswe-reviewer")
    assert reviewer["agent"]["name"] == "Open SWE Reviewer"
    assert reviewer["model"]["name"] == "gpt-5.6-sol"


def test_resources_expose_codebuddy_auth_probe_and_attempt_observability(
    manifest: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    routes = tmp_path / "routes.json"
    routes.write_text(
        json.dumps(
            {
                "version": 1,
                "routes": [
                    {
                        "id": "codebuddy-account-primary",
                        "role": "IMPLEMENT",
                        "priority": 30,
                        "runtime": "EXTERNAL_ACP",
                        "adapter": "codebuddy",
                        "target": "codebuddy-account",
                        "enabled": True,
                        "health": "READY",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("FORGEFLOW_ROUTE_CONFIG_FILE", str(routes))
    binary = tmp_path / "codebuddy"
    binary.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    binary.chmod(0o700)
    monkeypatch.setenv("FORGEFLOW_CODEBUDDY_BIN", str(binary))
    monkeypatch.setenv("FORGEFLOW_CODEBUDDY_MODEL", "deepseek-v4.1-flash")

    now = datetime.now(UTC)
    auth_dir = tmp_path / "auth"
    auth_dir.mkdir()
    millis = lambda value: round(value.timestamp() * 1000)
    (auth_dir / OFFICIAL_AUTH_FILE).write_text(
        json.dumps(
            {
                "auth": {
                    "accessToken": "never-expose-access",
                    "refreshToken": "never-expose-refresh",
                    "lastRefreshTime": millis(now - timedelta(minutes=5)),
                    "expiresAt": millis(now + timedelta(hours=2)),
                    "refreshExpiresAt": millis(now + timedelta(days=7)),
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("FORGEFLOW_CODEBUDDY_AUTH_STATE_DIR", str(auth_dir))

    ledger_path = tmp_path / "attempt-ledger.jsonl"
    ledger = AttemptLedger(ledger_path)
    handle = ledger.start(
        role="IMPLEMENT",
        route_id="codebuddy-account-primary",
        priority=30,
        runtime="EXTERNAL_ACP",
        target="codebuddy-account",
        operation_key="codebuddy:observability",
    )
    ledger.finish(handle, outcome="SUCCEEDED", result_revision="a" * 40)
    monkeypatch.setenv("FORGEFLOW_ATTEMPT_LEDGER_FILE", str(ledger_path))

    probe_path = tmp_path / "resource-probes.json"
    ResourceProbeStore(probe_path).record(
        route_id="codebuddy-account-primary",
        status="AVAILABLE",
        model="deepseek-v4.1-flash",
        duration_ms=222,
    )
    monkeypatch.setenv("FORGEFLOW_RESOURCE_PROBE_FILE", str(probe_path))
    monkeypatch.setattr(
        api,
        "probe_codebuddy_model",
        lambda _values: (_ for _ in ()).throw(AssertionError("GET /resources must not probe")),
    )

    payload = asyncio.run(api.list_resources(authorization="Bearer secret"))
    codebuddy = payload["routes"][0]
    observed = codebuddy["observability"]
    assert observed["status"] == "READY"
    assert observed["auth"]["status"] == "READY"
    assert observed["auth"]["refreshable"] is True
    assert observed["modelProbe"]["status"] == "AVAILABLE"
    assert observed["attempts"]["total"] == 1
    assert observed["attempts"]["succeeded"] == 1
    serialized = json.dumps(codebuddy)
    assert "never-expose-access" not in serialized
    assert "never-expose-refresh" not in serialized


def test_resource_filesystem_reads_are_offloaded_from_the_event_loop(
    manifest: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    routes = tmp_path / "routes.json"
    routes.write_text(
        json.dumps(
            {
                "version": 1,
                "routes": [
                    {
                        "id": "openswe-current",
                        "role": "IMPLEMENT",
                        "priority": 10,
                        "runtime": "OPEN_SWE",
                        "target": "current-model-policy",
                        "enabled": True,
                        "health": "READY",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("FORGEFLOW_ROUTE_CONFIG_FILE", str(routes))
    event_loop_thread = threading.get_ident()
    observed_threads: list[int] = []

    class FakeLedger:
        def route_summaries(self, route_ids):
            observed_threads.append(threading.get_ident())
            assert tuple(route_ids) == ("openswe-current",)
            return {}

    class FakeProbeStore:
        def all(self):
            observed_threads.append(threading.get_ident())
            return {}

    monkeypatch.setattr(api, "_attempt_ledger", lambda: FakeLedger())
    monkeypatch.setattr(api, "_resource_probe_store", lambda: FakeProbeStore())

    payload = asyncio.run(api.list_resources(authorization="Bearer secret"))
    assert payload["routes"][0]["id"] == "openswe-current"
    assert len(observed_threads) == 2
    assert all(thread_id != event_loop_thread for thread_id in observed_threads)


def test_explicit_resource_probe_updates_cache_without_polling_side_effects(
    manifest: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    routes = tmp_path / "routes.json"
    routes.write_text(
        json.dumps(
            {
                "version": 1,
                "routes": [
                    {
                        "id": "codebuddy-account-primary",
                        "role": "IMPLEMENT",
                        "priority": 30,
                        "runtime": "EXTERNAL_ACP",
                        "adapter": "codebuddy",
                        "target": "codebuddy-account",
                        "enabled": True,
                        "health": "READY",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("FORGEFLOW_ROUTE_CONFIG_FILE", str(routes))
    probe_path = tmp_path / "resource-probes.json"
    monkeypatch.setenv("FORGEFLOW_RESOURCE_PROBE_FILE", str(probe_path))
    monkeypatch.setenv("FORGEFLOW_CODEBUDDY_MODEL", "deepseek-v4.1-flash")
    monkeypatch.delenv("FORGEFLOW_ATTEMPT_LEDGER_FILE", raising=False)
    calls = 0

    def fake_probe(_values):
        nonlocal calls
        calls += 1
        return "AVAILABLE", 345, None

    monkeypatch.setattr(api, "probe_codebuddy_model", fake_probe)
    result = asyncio.run(
        api.probe_resource("codebuddy-account-primary", authorization="Bearer secret")
    )
    assert calls == 1
    assert result["probe"]["status"] == "AVAILABLE"
    assert result["probe"]["model"] == "deepseek-v4.1-flash"
    assert ResourceProbeStore(probe_path).get("codebuddy-account-primary") is not None
