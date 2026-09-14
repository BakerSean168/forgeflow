"""Small operator/Hermes facade mounted inside the ForgeFlow LangGraph web app.

This is deliberately not a second control plane. LangGraph threads remain the
single durable lifecycle state; this router only provides stable, bounded views
and commands for Hermes and the human status dashboard.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import secrets
import subprocess
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from uuid import uuid4

from fastapi import APIRouter, Header, HTTPException, Query
from langgraph_sdk import get_client
from langgraph_sdk.errors import NotFoundError
from pydantic import BaseModel, Field

from forgeflow.attempts import AttemptLedger, AttemptLedgerError, RouteAttemptSummary
from forgeflow.projects import load_project_route_preferences
from forgeflow.resource_probes import ResourceProbeStore, ResourceProbeStoreError
from forgeflow.routing import (
    RouteConfigError,
    RouteDefinition,
    RouteRegistry,
    load_route_registry,
)
from openswe_ext.operator_projection import (
    LAST_MODEL_ERROR_KEY,
    implementation_profile,
    model_view,
    provider_for_model,
    review_profile,
)
from openswe_ext.resource_observability import (
    codebuddy_observability,
    generic_route_observability,
    probe_codebuddy_model,
)

router = APIRouter(prefix="/forgeflow/api/v1", tags=["forgeflow-operator"])

_ACTIVE_STATUSES = frozenset(
    {"NEW", "IMPLEMENTING", "VERIFYING", "WAITING_FOR_CI", "REVIEWING", "REPAIRING"}
)
_PROVIDER_FAILURE_CODES = frozenset(
    {
        "provider_rate_limited",
        "provider_overloaded",
        "provider_unavailable",
        "provider_timeout",
        "provider_quota_exhausted",
        "model_unavailable",
    }
)
_PROJECT_KEY_RE = re.compile(r"[^a-z0-9]+")


class ObjectiveCreate(BaseModel):
    project_key: str = Field(alias="projectKey", min_length=1, max_length=120)
    objective: str = Field(min_length=1, max_length=50_000)
    base_ref: str | None = Field(default=None, alias="baseRef", max_length=300)
    workspace_path: str | None = Field(default=None, alias="workspacePath", max_length=4096)
    acceptance_criteria: list[str] = Field(default_factory=list, alias="acceptanceCriteria")


class ObjectiveCommand(BaseModel):
    reason: str | None = Field(default=None, max_length=1000)


def _operator_token() -> str:
    return os.environ.get("OPEN_SWE_LOCAL_AUTH_TOKEN", "").strip()


def require_operator_auth(authorization: str | None = Header(default=None)) -> None:
    expected = _operator_token()
    if not expected:
        raise HTTPException(status_code=503, detail="ForgeFlow operator auth is not configured")
    prefix = "Bearer "
    supplied = authorization[len(prefix) :].strip() if authorization and authorization.startswith(prefix) else ""
    if not supplied or not secrets.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="invalid ForgeFlow operator token")


def _manifest_path() -> Path | None:
    raw = os.environ.get("OPEN_SWE_LOCAL_PROJECTS_FILE", "").strip()
    return Path(raw) if raw else None


def _project_key(raw: Mapping[str, Any]) -> str:
    explicit = raw.get("project_key")
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip().casefold()
    repo = raw.get("repo")
    source = repo.rsplit("/", 1)[-1] if isinstance(repo, str) and repo.strip() else str(raw.get("name") or "")
    return _PROJECT_KEY_RE.sub("-", source.casefold()).strip("-")


def _load_projects() -> list[dict[str, Any]]:
    path = _manifest_path()
    if path is None:
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=503, detail="ForgeFlow project manifest is unavailable") from exc
    if not isinstance(payload, list):
        raise HTTPException(status_code=503, detail="ForgeFlow project manifest is invalid")
    projects: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in payload:
        if not isinstance(raw, dict):
            continue
        repo = raw.get("repo")
        if not isinstance(repo, str) or "/" not in repo:
            continue
        key = _project_key(raw)
        if not key or key in seen:
            continue
        owner, name = repo.split("/", 1)
        seen.add(key)
        projects.append(
            {
                "projectKey": key,
                "name": str(raw.get("name") or name),
                "repository": repo,
                "repoOwner": owner,
                "repoName": name,
                "cwd": raw.get("cwd") if isinstance(raw.get("cwd"), str) else None,
                "defaultBaseRef": str(raw.get("default_branch") or "main"),
                "ciRequired": bool(raw.get("ci_required", True)),
                "requiredChecks": [
                    item.strip()
                    for item in raw.get("required_checks", [])
                    if isinstance(item, str) and item.strip()
                ]
                if isinstance(raw.get("required_checks", []), list)
                else [],
            }
        )
    return projects


def _resolve_project(project_key: str) -> dict[str, Any]:
    requested = project_key.strip().casefold()
    for project in _load_projects():
        if project["projectKey"] == requested:
            return project
    raise HTTPException(status_code=404, detail=f"unknown ForgeFlow project: {project_key}")


def _normalized_github_repository(remote_url: str) -> str | None:
    """Return owner/repo for a GitHub remote without retaining credentials."""
    value = remote_url.strip()
    if not value:
        return None
    if value.startswith("git@github.com:"):
        path = value.removeprefix("git@github.com:")
    else:
        parsed = urlparse(value)
        if parsed.hostname != "github.com":
            return None
        path = parsed.path.lstrip("/")
    path = path.removesuffix(".git").strip("/")
    if path.count("/") != 1:
        return None
    owner, repo = path.split("/", 1)
    if not owner or not repo:
        return None
    return f"{owner}/{repo}".casefold()


def _git_output(workspace: Path, *args: str) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(workspace), *args],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise HTTPException(
            status_code=400, detail="workspacePath is not a usable Git workspace"
        ) from exc
    if result.returncode != 0:
        raise HTTPException(status_code=400, detail="workspacePath is not a usable Git workspace")
    return result.stdout.strip()


def _trusted_workspace_roots(project: Mapping[str, Any]) -> tuple[Path, ...]:
    roots: list[Path] = []
    project_cwd = project.get("cwd")
    if isinstance(project_cwd, str) and project_cwd.strip():
        roots.append(Path(project_cwd).expanduser().resolve(strict=False).parent)
    managed_root = os.environ.get("OPEN_SWE_LOCAL_WORKTREES_DIR", "").strip()
    if managed_root:
        roots.append(Path(managed_root).expanduser().resolve(strict=False))
    return tuple(dict.fromkeys(roots))


def _validated_workspace_path(
    project: Mapping[str, Any], raw_path: str | None
) -> str | None:
    """Validate an operator-supplied existing workspace and fail closed."""
    if raw_path is None:
        return None
    value = raw_path.strip()
    if not value:
        return None
    candidate = Path(value).expanduser()
    if not candidate.is_absolute():
        raise HTTPException(status_code=400, detail="workspacePath must be absolute")
    try:
        workspace = candidate.resolve(strict=True)
    except OSError as exc:
        raise HTTPException(status_code=400, detail="workspacePath does not exist") from exc
    if not workspace.is_dir():
        raise HTTPException(status_code=400, detail="workspacePath must be a directory")

    roots = _trusted_workspace_roots(project)
    if not roots or not any(
        workspace == root or workspace.is_relative_to(root) for root in roots
    ):
        raise HTTPException(status_code=400, detail="workspacePath is outside trusted project roots")

    top_level = Path(
        _git_output(workspace, "rev-parse", "--show-toplevel")
    ).resolve(strict=False)
    if top_level != workspace:
        raise HTTPException(status_code=400, detail="workspacePath must be the Git worktree root")

    expected_repo = project.get("repository")
    origin_repo = _normalized_github_repository(
        _git_output(workspace, "remote", "get-url", "origin")
    )
    if not isinstance(expected_repo, str) or origin_repo != expected_repo.casefold():
        raise HTTPException(status_code=400, detail="workspacePath repository does not match project")
    return str(workspace)


def _project_lookup(projects: list[dict[str, Any]]) -> dict[str, str]:
    return {project["repository"].casefold(): project["projectKey"] for project in projects}


def _thread_project_key(thread: Mapping[str, Any], lookup: Mapping[str, str]) -> str | None:
    metadata = thread.get("metadata")
    metadata = metadata if isinstance(metadata, Mapping) else {}
    values = thread.get("values")
    values = values if isinstance(values, Mapping) else {}
    explicit = metadata.get("project_key")
    if isinstance(explicit, str) and explicit:
        return explicit.casefold()
    owner = values.get("repo_owner")
    repo = values.get("repo_name")
    if not (isinstance(owner, str) and isinstance(repo, str)):
        raw_repo = metadata.get("repo")
        if isinstance(raw_repo, Mapping):
            owner = raw_repo.get("owner")
            repo = raw_repo.get("name")
    if isinstance(owner, str) and isinstance(repo, str):
        return lookup.get(f"{owner}/{repo}".casefold())
    return None


def _attempt_ledger() -> AttemptLedger | None:
    raw = os.environ.get("FORGEFLOW_ATTEMPT_LEDGER_FILE", "").strip()
    return AttemptLedger(Path(raw)) if raw else None


def _resource_probe_store() -> ResourceProbeStore | None:
    raw = os.environ.get("FORGEFLOW_RESOURCE_PROBE_FILE", "").strip()
    return ResourceProbeStore(Path(raw)) if raw else None


def _route_registry():
    path_raw = os.environ.get("FORGEFLOW_ROUTE_CONFIG_FILE", "").strip()
    if not path_raw:
        return None
    try:
        return load_route_registry(Path(path_raw))
    except RouteConfigError as exc:
        raise HTTPException(status_code=503, detail="ForgeFlow route registry is invalid") from exc


def _route_summary(route: RouteDefinition, *, source: str) -> dict[str, Any]:
    """Secrets-free descriptor for one selected route."""
    return {
        "id": route.id,
        "role": route.role,
        "priority": route.priority,
        "runtime": route.runtime,
        "target": route.target,
        "adapter": route.adapter,
        "source": source,
    }


def _project_route_policy(
    registry: RouteRegistry | None, owner: Any, repo: Any
) -> dict[str, Any]:
    """Effective per-project route preference and selected route (no secrets).

    Invalid project preferences are surfaced as ``routeConfigurationError`` and
    never silently replaced by the global selection.
    """
    if registry is None or not (isinstance(owner, str) and owner and isinstance(repo, str) and repo):
        return {"routePreferences": {}, "selectedRoutes": {}, "routeConfigurationError": None}
    try:
        preferences = load_project_route_preferences(registry, owner=owner, repo=repo)
    except RouteConfigError as exc:
        return {
            "routePreferences": {},
            "selectedRoutes": {},
            "routeConfigurationError": str(exc),
        }
    selected: dict[str, Any] = {}
    for role in ("IMPLEMENT", "REASONING"):
        preferred = preferences.preferred_ids(role)
        route = registry.select(role, preferred_ids=preferred)
        selected[role] = (
            None
            if route is None
            else _route_summary(route, source="PREFERENCE" if route.id in preferred else "GLOBAL")
        )
    return {
        "routePreferences": preferences.as_dict(),
        "selectedRoutes": selected,
        "routeConfigurationError": None,
    }


def _project_views() -> list[dict[str, Any]]:
    projects = _load_projects()
    registry = _route_registry()
    for project in projects:
        project.update(
            _project_route_policy(registry, project.get("repoOwner"), project.get("repoName"))
        )
    return projects


def _objective_repository(values: Mapping[str, Any], metadata: Mapping[str, Any]) -> tuple[Any, Any]:
    owner = values.get("repo_owner")
    repo = values.get("repo_name")
    if not (isinstance(owner, str) and isinstance(repo, str)):
        raw_repo = metadata.get("repo")
        if isinstance(raw_repo, Mapping):
            owner = raw_repo.get("owner")
            repo = raw_repo.get("name")
    return (owner if isinstance(owner, str) else None, repo if isinstance(repo, str) else None)


def _objective_view(thread: Mapping[str, Any], lookup: Mapping[str, str], *, full: bool = False) -> dict[str, Any]:
    values = thread.get("values")
    values = values if isinstance(values, Mapping) else {}
    metadata = thread.get("metadata")
    metadata = metadata if isinstance(metadata, Mapping) else {}
    objective = values.get("objective")
    objective = objective if isinstance(objective, str) else str(metadata.get("title") or "")
    if not full and len(objective) > 600:
        objective = objective[:597] + "..."
    status = values.get("status") if isinstance(values.get("status"), str) else "NEW"
    repo_owner, repo_name = _objective_repository(values, metadata)
    return {
        "planId": thread.get("thread_id"),
        "threadId": thread.get("thread_id"),
        "projectKey": _thread_project_key(thread, lookup),
        "repoOwner": repo_owner,
        "repoName": repo_name,
        "objective": objective,
        "status": status,
        "active": status in _ACTIVE_STATUSES,
        "baseRef": values.get("base_ref"),
        "workspacePath": values.get("workspace_path"),
        "implementationRouteId": values.get("implementation_route_id"),
        "implementationRuntime": values.get("implementation_runtime"),
        "implementationThreadId": values.get("implementation_thread_id"),
        "implementationRunId": values.get("implementation_run_id"),
        "implementationOperationKey": values.get("implementation_operation_key"),
        "implementationPhase": values.get("implementation_phase"),
        "implementationFailedRouteIds": values.get("implementation_failed_route_ids", []),
        "reviewerThreadId": values.get("reviewer_thread_id"),
        "reviewerRunId": values.get("reviewer_run_id"),
        "reviewerRetryCount": values.get("reviewer_retry_count", 0),
        "runRetryCount": values.get("run_retry_count", 0),
        "repairRound": values.get("repair_round", 0),
        "blockingFindingIds": values.get("blocking_finding_ids", []),
        "waitStage": values.get("wait_stage"),
        "waitCount": values.get("wait_count", 0),
        "lastFailureCode": values.get("last_failure_code"),
        "prUrl": values.get("pr_url"),
        "prNumber": values.get("pr_number"),
        "observedHeadSha": values.get("observed_head_sha"),
        "createdAt": thread.get("created_at"),
        "updatedAt": thread.get("updated_at"),
        "threadStatus": thread.get("status"),
    }


def _is_forgeflow_thread(thread: Mapping[str, Any]) -> bool:
    metadata = thread.get("metadata")
    return isinstance(metadata, Mapping) and metadata.get("graph_id") == "forgeflow"


def _client():
    return get_client()


async def _assistant_id(client: Any) -> str:
    assistants = await client.assistants.search(graph_id="forgeflow", limit=10)
    if not isinstance(assistants, list) or len(assistants) != 1:
        raise HTTPException(status_code=503, detail="ForgeFlow graph assistant is unavailable or ambiguous")
    assistant_id = assistants[0].get("assistant_id") if isinstance(assistants[0], Mapping) else None
    if not isinstance(assistant_id, str) or not assistant_id:
        raise HTTPException(status_code=503, detail="ForgeFlow graph assistant has no id")
    return assistant_id


async def _search_threads(*, limit: int | None = 100) -> list[Mapping[str, Any]]:
    client = _client()
    rows: list[Mapping[str, Any]] = []
    offset = 0
    while limit is None or len(rows) < limit:
        page_limit = 200 if limit is None else min(max(limit - len(rows), 1), 200)
        page = await client.threads.search(
            metadata={"graph_id": "forgeflow"},
            limit=page_limit,
            offset=offset,
            sort_by="updated_at",
            sort_order="desc",
        )
        page_rows = [
            row for row in page if isinstance(row, Mapping) and _is_forgeflow_thread(row)
        ]
        rows.extend(page_rows)
        if len(page) < page_limit:
            break
        offset += len(page)
    return rows if limit is None else rows[:limit]


def _matching_run(rows: Any, run_id: str | None) -> Mapping[str, Any] | None:
    if not isinstance(rows, list) or not run_id:
        return None
    for row in rows:
        if isinstance(row, Mapping) and row.get("run_id") == run_id:
            return row
    return None


async def _run_observation(
    client: Any, thread_id: Any, run_id: Any
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    if not (isinstance(thread_id, str) and thread_id and isinstance(run_id, str) and run_id):
        return None, None
    try:
        thread = await client.threads.get(thread_id)
    except NotFoundError:
        return None, None
    metadata = thread.get("metadata") if isinstance(thread, Mapping) else None
    metadata = metadata if isinstance(metadata, Mapping) else {}
    raw_error = metadata.get(LAST_MODEL_ERROR_KEY)
    last_model_error = None
    if isinstance(raw_error, Mapping) and raw_error.get("run_id") == run_id:
        last_model_error = {
            "code": raw_error.get("code"),
            "errorType": raw_error.get("error_type"),
        }
    run = _matching_run(await client.runs.list(thread_id, limit=100), run_id)
    run_view = (
        {
            "runId": run.get("run_id"),
            "status": run.get("status"),
            "createdAt": run.get("created_at"),
            "updatedAt": run.get("updated_at"),
        }
        if run is not None
        else None
    )
    return run_view, last_model_error


async def _execution_snapshot(client: Any, objective: Mapping[str, Any]) -> dict[str, Any]:
    route_id = objective.get("implementationRouteId")
    runtime = objective.get("implementationRuntime")
    route = None
    registry = _route_registry()
    if registry is not None and isinstance(route_id, str) and route_id:
        try:
            route = registry.get(route_id)
        except KeyError:
            route = None
    implementation = implementation_profile(route, runtime if isinstance(runtime, str) else None)
    review = review_profile()
    implementation_run, implementation_error = await _run_observation(
        client,
        objective.get("implementationThreadId"),
        objective.get("implementationRunId"),
    )
    review_run, review_error = await _run_observation(
        client,
        objective.get("reviewerThreadId"),
        objective.get("reviewerRunId"),
    )
    reviewing = objective.get("status") == "REVIEWING"
    active_profile = review if reviewing else implementation
    active_run = review_run if reviewing else implementation_run
    active_error = review_error if reviewing else implementation_error
    fallback_triggered = bool(
        active_profile
        and active_profile.get("fallbackModel")
        and active_error
        and active_error.get("code") in _PROVIDER_FAILURE_CODES
    )
    return {
        "routeId": route_id,
        "runtime": runtime,
        "routeTarget": route.target if route is not None else None,
        "routeHealth": route.health if route is not None else None,
        "routePolicy": _project_route_policy(
            registry, objective.get("repoOwner"), objective.get("repoName")
        ),
        "implementation": implementation,
        "review": review,
        "activeProfile": active_profile,
        "implementationRun": implementation_run,
        "reviewRun": review_run,
        "childRun": active_run,
        "lastModelError": active_error,
        "fallbackTriggered": fallback_triggered,
    }


async def _enrich_objective(client: Any, objective: dict[str, Any]) -> dict[str, Any]:
    result = dict(objective)
    result["execution"] = await _execution_snapshot(client, result)
    return result


def _compose_objective(body: ObjectiveCreate) -> str:
    text = body.objective.strip()
    criteria = [item.strip() for item in body.acceptance_criteria if item.strip()]
    if not criteria:
        return text
    return text + "\n\nAcceptance criteria:\n" + "\n".join(f"- {item}" for item in criteria)


@router.get("/health", dependencies=[])
async def operator_health(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    require_operator_auth(authorization)
    projects = _load_projects()
    return {"status": "healthy", "runtime": "policy-v1", "projects": len(projects)}


@router.get("/projects")
async def list_projects(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    require_operator_auth(authorization)
    return {"projects": _project_views()}


@router.get("/projects/{project_key}")
async def get_project(project_key: str, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    require_operator_auth(authorization)
    project = _resolve_project(project_key)
    project.update(
        _project_route_policy(_route_registry(), project.get("repoOwner"), project.get("repoName"))
    )
    return project


@router.post("/objectives", status_code=201)
async def create_objective(body: ObjectiveCreate, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    require_operator_auth(authorization)
    project = _resolve_project(body.project_key)
    client = _client()
    assistant_id = await _assistant_id(client)
    thread_id = str(uuid4())
    objective = _compose_objective(body)
    base_ref = body.base_ref.strip() if isinstance(body.base_ref, str) and body.base_ref.strip() else project["defaultBaseRef"]
    workspace_path = await asyncio.to_thread(
        _validated_workspace_path, project, body.workspace_path
    )
    await client.threads.create(
        thread_id=thread_id,
        graph_id="forgeflow",
        if_exists="raise",
        metadata={
            "kind": "forgeflow-policy",
            "source": "hermes",
            "project_key": project["projectKey"],
            "repo": {"owner": project["repoOwner"], "name": project["repoName"]},
            "title": objective[:120],
        },
    )
    run = await client.runs.create(
        thread_id,
        assistant_id,
        input={
            "objective": objective,
            "repo_owner": project["repoOwner"],
            "repo_name": project["repoName"],
            "base_ref": base_ref,
            "workspace_path": workspace_path,
        },
        config={"configurable": {"thread_id": thread_id}},
        metadata={"kind": "forgeflow_policy", "source": "hermes"},
        multitask_strategy="reject",
    )
    run_id = run.get("run_id") if isinstance(run, Mapping) else None
    return {
        "planId": thread_id,
        "threadId": thread_id,
        "runId": run_id,
        "projectKey": project["projectKey"],
        "status": "NEW",
        "baseRef": base_ref,
        "workspacePath": workspace_path,
        "objective": objective,
    }


@router.get("/objectives")
async def list_objectives(
    project_key: str | None = Query(default=None),
    active_only: bool = Query(default=False),
    limit: int = Query(default=50, ge=1, le=200),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    require_operator_auth(authorization)
    projects = _load_projects()
    lookup = _project_lookup(projects)
    requested = project_key.casefold() if project_key else None
    rows = []
    for thread in await _search_threads(limit=200):
        view = _objective_view(thread, lookup)
        if requested and view["projectKey"] != requested:
            continue
        if active_only and not view["active"]:
            continue
        rows.append(view)
        if len(rows) >= limit:
            break
    return {"objectives": rows}


@router.get("/objectives/{thread_id}")
async def get_objective(thread_id: str, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    require_operator_auth(authorization)
    client = _client()
    thread = await client.threads.get(thread_id, include=["values"])
    if not isinstance(thread, Mapping) or not _is_forgeflow_thread(thread):
        raise HTTPException(status_code=404, detail="ForgeFlow objective not found")
    return await _enrich_objective(client, _objective_view(thread, _project_lookup(_load_projects()), full=True))


async def _command_objective(thread_id: str, *, cancel_requested: bool) -> dict[str, Any]:
    client = _client()
    thread = await client.threads.get(thread_id, include=["values"])
    if not isinstance(thread, Mapping) or not _is_forgeflow_thread(thread):
        raise HTTPException(status_code=404, detail="ForgeFlow objective not found")
    assistant_id = await _assistant_id(client)
    run = await client.runs.create(
        thread_id,
        assistant_id,
        input={"cancel_requested": True} if cancel_requested else {},
        config={"configurable": {"thread_id": thread_id}},
        metadata={"kind": "forgeflow_policy_command", "command": "cancel" if cancel_requested else "reconcile"},
        multitask_strategy="enqueue",
    )
    return {"planId": thread_id, "threadId": thread_id, "runId": run.get("run_id") if isinstance(run, Mapping) else None, "accepted": True}


@router.post("/objectives/{thread_id}/reconcile")
async def reconcile_objective(thread_id: str, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    require_operator_auth(authorization)
    return await _command_objective(thread_id, cancel_requested=False)


@router.post("/objectives/{thread_id}/cancel")
async def cancel_objective(
    thread_id: str,
    body: ObjectiveCommand | None = None,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    require_operator_auth(authorization)
    return await _command_objective(thread_id, cancel_requested=True)


def _route_view(
    route: RouteDefinition,
    *,
    fallback_target: str | None = None,
    attempts: RouteAttemptSummary | None = None,
    attempts_available: bool = True,
    probe: Any = None,
) -> dict[str, Any]:
    if route.role == "REASONING":
        model = model_view(route.target, effort="medium")
        profile = {
            "agent": {"id": "open-swe-reviewer", "name": "Open SWE Reviewer", "harness": "Open SWE"},
            "provider": provider_for_model(route.target),
            "model": model,
            "fallbackModel": model_view(fallback_target, effort="medium"),
        }
    else:
        profile = implementation_profile(route, route.runtime) or {}
    if (route.adapter or "").casefold() == "codebuddy":
        observability = codebuddy_observability(
            values=os.environ,
            attempts=attempts,
            probe=probe,
            configured_health=route.health,
            enabled=route.enabled,
        )
    else:
        observability = generic_route_observability(
            attempts=attempts,
            configured_health=route.health,
            enabled=route.enabled,
        )
    if not attempts_available:
        observability = dict(observability)
        observability["attempts"] = None
        observability["needsAttention"] = True
        observability["reasons"] = [
            *observability.get("reasons", []),
            "attempt_ledger_unavailable",
        ]
        if observability.get("status") == "READY":
            observability["status"] = "DEGRADED"
    return {
        "id": route.id,
        "role": route.role,
        "priority": route.priority,
        "runtime": route.runtime,
        "target": route.target,
        "adapter": route.adapter,
        "enabled": route.enabled,
        "health": route.health,
        "expiresAt": route.expires_at.isoformat() if route.expires_at else None,
        "agent": profile.get("agent"),
        "provider": profile.get("provider"),
        "model": profile.get("model"),
        "fallbackModel": profile.get("fallbackModel"),
        "observability": observability,
    }


async def _route_attempt_summaries(
    routes: list[RouteDefinition],
) -> dict[str, RouteAttemptSummary]:
    ledger = _attempt_ledger()
    if ledger is None:
        return {}
    route_ids = tuple(route.id for route in routes)
    try:
        return await asyncio.to_thread(ledger.route_summaries, route_ids)
    except (AttemptLedgerError, OSError) as exc:
        raise HTTPException(status_code=503, detail="ForgeFlow attempt ledger is unavailable") from exc


async def _route_probe_records() -> dict[str, Any]:
    store = _resource_probe_store()
    if store is None:
        return {}
    try:
        return await asyncio.to_thread(store.all)
    except ResourceProbeStoreError as exc:
        raise HTTPException(status_code=503, detail="ForgeFlow resource probe store is invalid") from exc


async def _list_resources_payload(
    authorization: str | None, *, tolerate_attempt_ledger_errors: bool = False
) -> dict[str, Any]:
    require_operator_auth(authorization)
    registry = _route_registry()
    if registry is None:
        return {
            "routes": [],
            "selection": {},
            "projectSelections": {},
            "attemptLedgerStatus": "UNAVAILABLE",
        }
    routes = list(registry.routes)
    attempts_available = True
    try:
        attempts, probes = await asyncio.gather(
            _route_attempt_summaries(routes),
            _route_probe_records(),
        )
    except HTTPException as exc:
        if not (
            tolerate_attempt_ledger_errors
            and exc.status_code == 503
            and exc.detail == "ForgeFlow attempt ledger is unavailable"
        ):
            raise
        attempts_available = False
        attempts = {}
        probes = await _route_probe_records()
    reasoning = list(registry.eligible("REASONING"))
    next_reasoning: dict[str, str | None] = {}
    for index, route in enumerate(reasoning):
        next_reasoning[route.id] = reasoning[index + 1].target if index + 1 < len(reasoning) else None
    route_views = await asyncio.gather(
        *(
            asyncio.to_thread(
                _route_view,
                route,
                fallback_target=next_reasoning.get(route.id),
                attempts=attempts.get(route.id),
                attempts_available=attempts_available,
                probe=probes.get(route.id),
            )
            for route in routes
        )
    )
    selection: dict[str, Any] = {}
    for role in ("IMPLEMENT", "REASONING"):
        route = registry.select(role)
        selection[role] = None if route is None else _route_summary(route, source="GLOBAL")
    try:
        projects = _load_projects()
    except HTTPException:
        projects = []
    project_selections = {
        project["projectKey"]: _project_route_policy(
            registry, project.get("repoOwner"), project.get("repoName")
        )
        for project in projects
    }
    return {
        "routes": list(route_views),
        "selection": selection,
        "projectSelections": project_selections,
        "attemptLedgerStatus": "AVAILABLE" if attempts_available else "UNAVAILABLE",
    }


@router.get("/resources")
async def list_resources(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    return await _list_resources_payload(authorization)


@router.post("/resources/{route_id}/probe")
async def probe_resource(
    route_id: str,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    require_operator_auth(authorization)
    registry = _route_registry()
    if registry is None:
        raise HTTPException(status_code=503, detail="ForgeFlow route registry is unavailable")
    try:
        route = registry.get(route_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="ForgeFlow resource route not found") from exc
    if (route.adapter or "").casefold() != "codebuddy":
        raise HTTPException(status_code=400, detail="active resource probe is not supported for this route")
    store = _resource_probe_store()
    if store is None:
        raise HTTPException(status_code=503, detail="ForgeFlow resource probe store is not configured")
    status, duration_ms, failure_code = await asyncio.to_thread(probe_codebuddy_model, os.environ)
    model = os.environ.get("FORGEFLOW_CODEBUDDY_MODEL", "deepseek-v4.1-flash").strip() or None
    try:
        record = await asyncio.to_thread(
            store.record,
            route_id=route.id,
            status=status,
            model=model,
            duration_ms=duration_ms,
            failure_code=failure_code,
        )
    except ResourceProbeStoreError as exc:
        raise HTTPException(status_code=503, detail="ForgeFlow resource probe store is invalid") from exc
    attempts = (await _route_attempt_summaries([route])).get(route.id)
    route_view = await asyncio.to_thread(_route_view, route, attempts=attempts, probe=record)
    return {
        "route": route_view,
        "probe": {
            "status": record.status,
            "checkedAt": record.checked_at,
            "model": record.model,
            "durationMs": record.duration_ms,
            "failureCode": record.failure_code,
        },
    }


def _attempt_is_policy_attached(attempt: Any, active: list[dict[str, Any]]) -> bool:
    operation_key = attempt.operation_key
    for objective in active:
        current_operation = objective.get("implementationOperationKey")
        if isinstance(current_operation, str) and current_operation:
            if current_operation == operation_key:
                return True
            continue
        plan_id = objective.get("planId")
        if not isinstance(plan_id, str) or not plan_id:
            continue
        if operation_key.startswith(f"implementation:{plan_id}:"):
            return True
        if operation_key.startswith(f"repair:{plan_id}:"):
            return True
    return False


def _unattached_execution_view(attempt: Any, registry: RouteRegistry | None) -> dict[str, Any]:
    route = None
    if registry is not None:
        try:
            route = registry.get(attempt.route_id)
        except KeyError:
            route = None
    profile = None
    if attempt.role == "IMPLEMENT":
        profile = implementation_profile(route, attempt.runtime)
    elif attempt.role == "REASONING":
        model = model_view(attempt.target, effort="medium")
        profile = {
            "role": "REASONING",
            "agent": {
                "id": "open-swe-reviewer",
                "name": "Open SWE Reviewer",
                "harness": "Open SWE",
            },
            "provider": provider_for_model(attempt.target),
            "model": model,
            "fallbackModel": None,
        }
    return {
        "attemptId": attempt.attempt_id,
        "routeId": attempt.route_id,
        "role": attempt.role,
        "runtime": attempt.runtime,
        "target": attempt.target,
        "startedAt": attempt.started_at,
        "sourceRevision": attempt.source_revision,
        "operationKeyHash": hashlib.sha256(attempt.operation_key.encode("utf-8")).hexdigest()[:12],
        "reason": "NO_ACTIVE_POLICY_OBJECTIVE",
        "profile": profile,
    }


async def _unattached_execution_snapshot(active: list[dict[str, Any]]) -> dict[str, Any]:
    ledger = _attempt_ledger()
    if ledger is None:
        return {
            "status": "UNAVAILABLE",
            "error": "ATTEMPT_LEDGER_NOT_CONFIGURED",
            "count": None,
            "items": [],
            "truncated": False,
        }
    try:
        attempts = await asyncio.to_thread(ledger.open_attempts)
    except (AttemptLedgerError, OSError):
        return {
            "status": "UNAVAILABLE",
            "error": "ATTEMPT_LEDGER_UNAVAILABLE",
            "count": None,
            "items": [],
            "truncated": False,
        }
    registry = _route_registry()
    unmatched = [attempt for attempt in attempts if not _attempt_is_policy_attached(attempt, active)]
    limit = 50
    return {
        "status": "AVAILABLE",
        "error": None,
        "count": len(unmatched),
        "items": [_unattached_execution_view(attempt, registry) for attempt in unmatched[:limit]],
        "truncated": len(unmatched) > limit,
    }


@router.get("/summary")
async def summary(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    require_operator_auth(authorization)
    projects = _project_views()
    lookup = _project_lookup(projects)
    client = _client()
    latest: dict[str, dict[str, Any]] = {}
    active: list[dict[str, Any]] = []
    for thread in await _search_threads(limit=None):
        view = _objective_view(thread, lookup)
        key = view["projectKey"]
        needs_enrichment = bool(view["active"] or (isinstance(key, str) and key not in latest))
        enriched = await _enrich_objective(client, view) if needs_enrichment else view
        if view["active"]:
            active.append(enriched)
        if isinstance(key, str) and key not in latest:
            latest[key] = enriched
    project_views = [dict(project, latestObjective=latest.get(project["projectKey"])) for project in projects]
    resources = await _list_resources_payload(
        authorization, tolerate_attempt_ledger_errors=True
    )
    active.sort(key=lambda row: str(row.get("updatedAt") or ""), reverse=True)
    unattached = await _unattached_execution_snapshot(active)
    running_agents = sum(
        1
        for row in active
        if isinstance(row.get("execution"), Mapping)
        and isinstance(row["execution"].get("childRun"), Mapping)
        and row["execution"]["childRun"].get("status") in {"pending", "running"}
    )
    return {
        "runtime": {"status": "ONLINE", "kind": "policy-v1"},
        "activeObjectiveCount": len(active),
        "runningAgentCount": running_agents,
        "unattachedExecutionStatus": unattached["status"],
        "unattachedExecutionError": unattached["error"],
        "unattachedExecutionCount": unattached["count"],
        "unattachedExecutions": unattached["items"],
        "unattachedExecutionsTruncated": unattached["truncated"],
        "projects": project_views,
        "activeObjectives": active,
        "routes": resources["routes"],
    }
