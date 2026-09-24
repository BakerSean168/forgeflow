#!/usr/bin/env python3
"""Stateless project continuation supervisor for unattended ForgeFlow runs.

Repository-owned plans/task graphs remain planning truth and LangGraph
ForgeFlow threads remain execution truth. The legacy mode advances one project
objective at a time. Execution-ready task graphs are projected onto bounded
mutation slots while every task keeps an independent ForgeFlow objective/sandbox.
"""

from __future__ import annotations

import argparse
import asyncio
import fcntl
import os
import subprocess
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, uuid4, uuid5

from langgraph_sdk import get_client

from forgeflow.adapters.github import (
    GitHubEvidenceError,
    fetch_pull_request,
    merge_pull_request_exact_head,
)
from forgeflow.projects import (
    ContinuousLaneConfig,
    ContinuousProjectConfig,
    load_continuous_project_configs,
)
from forgeflow.task_graph import TaskSpec

ACTIVE = frozenset(
    {
        "NEW",
        "IMPLEMENTING",
        "VERIFYING",
        "WAITING_FOR_CI",
        "REVIEWING",
        "REPAIRING",
        "WAITING_FOR_RESOURCE",
    }
)
RESOURCE_FAILURES = frozenset(
    {
        "OPENSWE_PROVIDER_UNAVAILABLE",
        "IMPLEMENTATION_ROUTE_UNAVAILABLE",
        "IMPLEMENTATION_ROUTE_EXHAUSTED",
        "REVIEWER_PROVIDER_UNAVAILABLE",
    }
)


def _values(thread: Mapping[str, Any]) -> Mapping[str, Any]:
    raw = thread.get("values")
    return raw if isinstance(raw, Mapping) else {}


def _metadata(thread: Mapping[str, Any]) -> Mapping[str, Any]:
    raw = thread.get("metadata")
    return raw if isinstance(raw, Mapping) else {}


def _plan_active(config: ContinuousProjectConfig) -> bool:
    return any(path.is_file() for path in config.plan_paths)


def _plan_text(config: ContinuousProjectConfig) -> str:
    chunks: list[str] = []
    for path in config.plan_paths:
        try:
            chunks.append(path.read_text(encoding="utf-8"))
        except OSError:
            continue
    return "\n".join(chunks)


def _head_is_on_base(config: ContinuousProjectConfig, head_sha: str) -> bool:
    if not head_sha:
        return False
    try:
        subprocess.run(
            ["git", "-C", str(config.cwd), "fetch", "--quiet", "origin", config.base_ref],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
        )
        result = subprocess.run(
            [
                "git",
                "-C",
                str(config.cwd),
                "merge-base",
                "--is-ancestor",
                head_sha,
                f"origin/{config.base_ref}",
            ],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


async def _assistant_id(client: Any) -> str:
    rows = await client.assistants.search(graph_id="forgeflow", limit=10)
    matches = [row for row in rows if isinstance(row, Mapping) and row.get("graph_id") == "forgeflow"]
    if len(matches) != 1 or not isinstance(matches[0].get("assistant_id"), str):
        raise RuntimeError("forgeflow assistant is unavailable or ambiguous")
    return str(matches[0]["assistant_id"])


def _thread_matches_project(row: Mapping[str, Any], config: ContinuousProjectConfig) -> bool:
    metadata = _metadata(row)
    if str(metadata.get("project_key") or "").casefold() == config.project_key.casefold():
        return True
    repo = metadata.get("repo")
    if isinstance(repo, Mapping):
        owner = str(repo.get("owner") or "")
        name = str(repo.get("name") or repo.get("repo") or "")
        if owner.casefold() == config.owner.casefold() and name.casefold() == config.repo.casefold():
            return True
    values = _values(row)
    return (
        str(values.get("repo_owner") or "").casefold() == config.owner.casefold()
        and str(values.get("repo_name") or "").casefold() == config.repo.casefold()
    )


def _thread_has_execution_identity(row: Mapping[str, Any], config: ContinuousProjectConfig) -> bool:
    values = _values(row)
    return (
        isinstance(values.get("objective"), str)
        and bool(str(values.get("objective")).strip())
        and str(values.get("repo_owner") or "").casefold() == config.owner.casefold()
        and str(values.get("repo_name") or "").casefold() == config.repo.casefold()
        and isinstance(values.get("base_ref"), str)
        and bool(str(values.get("base_ref")).strip())
    )


async def _project_threads(client: Any, config: ContinuousProjectConfig) -> list[Mapping[str, Any]]:
    rows = await client.threads.search(
        metadata={"graph_id": "forgeflow"},
        limit=200,
        sort_by="updated_at",
        sort_order="desc",
    )
    return [
        row
        for row in rows
        if isinstance(row, Mapping) and _thread_matches_project(row, config)
    ]


def _select_project_thread(
    rows: list[Mapping[str, Any]], config: ContinuousProjectConfig
) -> Mapping[str, Any] | None:
    for row in rows:
        values = _values(row)
        status = str(values.get("status") or "NEW")
        if status in ACTIVE and _thread_has_execution_identity(row, config):
            return row
    for row in rows:
        if _thread_has_execution_identity(row, config):
            return row
    return None


def _thread_lane_key(
    row: Mapping[str, Any], config: ContinuousProjectConfig
) -> str | None:
    """Resolve one execution thread to the current task/lane, fail-closed on drift."""
    metadata = _metadata(row)
    tasks = config.execution_tasks
    known = {task.key for task in tasks}

    task_id = str(metadata.get("task_id") or "").strip().casefold()
    if config.task_graph is not None:
        if not task_id or task_id not in known:
            return None
        graph_id = str(metadata.get("task_graph_id") or "").strip()
        fingerprint = str(metadata.get("task_fingerprint") or "").strip()
        current = config.task_graph.task(task_id)
        expected_fingerprint = config.task_graph.execution_fingerprint(current)
        if graph_id != config.task_graph.graph_id or fingerprint != expected_fingerprint:
            return None
        return task_id

    metadata_key = str(metadata.get("lane_key") or "").strip().casefold()
    if metadata_key in known:
        return metadata_key

    # Legacy inline-lane compatibility only. TaskGraph mode never adopts an
    # unfingerprinted writer by lane key or objective text.
    objective = str(_values(row).get("objective") or "").casefold()
    if not objective:
        return None
    matches = []
    for task in tasks:
        terms = task.match_terms or (task.key,)
        if any(term.casefold() in objective for term in terms):
            matches.append(task.key)
    return matches[0] if len(matches) == 1 else None


def _lane_rows(
    rows: list[Mapping[str, Any]], config: ContinuousProjectConfig, lane_key: str
) -> list[Mapping[str, Any]]:
    return [row for row in rows if _thread_lane_key(row, config) == lane_key]


def _select_lane_thread(
    rows: list[Mapping[str, Any]], config: ContinuousProjectConfig, lane_key: str
) -> Mapping[str, Any] | None:
    return _select_project_thread(_lane_rows(rows, config, lane_key), config)


def _lane_marker_complete(lane: ContinuousLaneConfig, plan_text: str) -> bool:
    if not lane.completion_markers:
        return False
    folded = plan_text.casefold()
    return all(marker.casefold() in folded for marker in lane.completion_markers)


def _lane_thread_complete(
    config: ContinuousProjectConfig, row: Mapping[str, Any] | None
) -> bool:
    if row is None:
        return False
    values = _values(row)
    if str(values.get("status") or "") != "READY":
        return False
    head = values.get("observed_head_sha")
    ci_head = values.get("ci_head_sha")
    reviewed_head = values.get("reviewed_head_sha")
    if not all(isinstance(item, str) and item for item in (head, ci_head, reviewed_head)):
        return False
    if not (head == ci_head == reviewed_head):
        return False
    return _head_is_on_base(config, head)


def _lane_complete(
    config: ContinuousProjectConfig,
    lane: ContinuousLaneConfig | TaskSpec,
    rows: list[Mapping[str, Any]],
    plan_text: str,
) -> bool:
    if isinstance(lane, ContinuousLaneConfig) and _lane_marker_complete(lane, plan_text):
        return True
    return _lane_thread_complete(config, _select_lane_thread(rows, config, lane.key))


def _active_rows(
    rows: list[Mapping[str, Any]], config: ContinuousProjectConfig
) -> list[Mapping[str, Any]]:
    return [
        row
        for row in rows
        if str(_values(row).get("status") or "NEW") in ACTIVE
        and _thread_has_execution_identity(row, config)
    ]


async def _command_recover(client: Any, assistant_id: str, thread_id: str) -> None:
    await client.runs.create(
        thread_id,
        assistant_id,
        input={"recover_requested": True},
        config={"configurable": {"thread_id": thread_id}},
        metadata={
            "kind": "forgeflow_policy_command",
            "command": "recover",
            "source": "project-supervisor",
        },
        multitask_strategy="enqueue",
    )


def _render_list(title: str, items: tuple[str, ...] | list[str]) -> str:
    unique = tuple(dict.fromkeys(item for item in items if item))
    if not unique:
        return ""
    return f"\n\n{title}:\n" + "\n".join(f"- {item}" for item in unique)


def _objective_text(
    config: ContinuousProjectConfig, lane: ContinuousLaneConfig | TaskSpec | None
) -> str:
    criteria = list(config.acceptance_criteria)
    if lane is None:
        body = config.objective
    elif isinstance(lane, TaskSpec) and config.task_graph is not None:
        graph = config.task_graph
        criteria.extend(lane.acceptance_criteria)
        body = (
            f"Large objective: {graph.objective}\n\n"
            f"TaskGraph `{graph.graph_id}` revision {graph.revision}: {graph.title}\n"
            f"Planned by: {graph.planned_by}\n\n"
            f"Current task `{lane.id}` — {lane.title}\n"
            f"Goal: {lane.goal}\n"
            f"Why now: {lane.why_now}\n"
            f"Risk: {lane.risk}\n\n"
            "Implement only this task while preserving the TaskGraph's system-level design. "
            "Sibling tasks may run concurrently in isolated ForgeFlow objectives/sandboxes. "
            "Do not optimize locally by bypassing protected contracts, expanding scope, or "
            "stealing work owned by another task. If repository evidence contradicts the "
            "plan or mutation ownership, stop without mutation and report the blocker."
        )
        body += _render_list("TaskGraph context refs", graph.context_refs)
        body += _render_list("Architecture decisions", graph.architecture_decisions)
        body += _render_list("Global protected contracts", graph.protected_contracts)
        body += _render_list("Global non-goals", graph.non_goals)
        body += _render_list("Task scope", lane.scope)
        body += _render_list("Task out of scope", lane.out_of_scope)
        body += _render_list("Task context refs", lane.context_refs)
        body += _render_list("Task protected contracts", lane.protected_contracts)
        body += _render_list("Implementation steps", lane.implementation_steps)
        body += _render_list("Integration notes", lane.integration_notes)
        body += _render_list("Dependencies", lane.depends_on)
        body += _render_list("Explicit conflicts", lane.conflicts_with)
        body += _render_list("Exclusive mutation keys", lane.mutation_keys)
        body += _render_list("Verification commands", lane.verification_commands)
    else:
        criteria.extend(lane.acceptance_criteria)
        body = (
            config.objective
            + f"\n\nParallel mutation lane `{lane.key}`:\n"
            + lane.objective
            + "\n\nOwn only this lane. Other configured lanes may run concurrently in isolated "
            "ForgeFlow objectives/sandboxes. Before mutating, verify the lane is still "
            "dependency-ready and does not overlap an active sibling's owner contracts, "
            "schema, or files. If repository evidence contradicts readiness, stop without "
            "mutation and report the blocker rather than stealing another lane."
        )
    rendered = "\n".join(f"- {item}" for item in dict.fromkeys(criteria))
    return body if not rendered else f"{body}\n\nAcceptance criteria:\n{rendered}"


async def _create_objective(
    client: Any,
    assistant_id: str,
    config: ContinuousProjectConfig,
    lane: ContinuousLaneConfig | TaskSpec | None = None,
) -> str:
    if lane is None:
        thread_id = str(uuid4())
    elif isinstance(lane, TaskSpec) and config.task_graph is not None:
        graph = config.task_graph
        fingerprint = graph.execution_fingerprint(lane)
        thread_id = str(
            uuid5(
                NAMESPACE_URL,
                "forgeflow:task:"
                f"{config.owner}/{config.repo}:{config.base_ref}:"
                f"{graph.graph_id}:{lane.key}:{fingerprint}",
            )
        )
    else:
        thread_id = str(
            uuid5(
                NAMESPACE_URL,
                f"forgeflow:continuous:{config.owner}/{config.repo}:{config.base_ref}:{lane.key}",
            )
        )
    objective = _objective_text(config, lane)
    metadata = {
        "kind": "forgeflow-policy",
        "source": "project-supervisor",
        "project_key": config.project_key,
        "repo": {"owner": config.owner, "name": config.repo},
        "title": objective[:120],
    }
    if lane is not None:
        metadata["lane_key"] = lane.key
        if isinstance(lane, TaskSpec) and config.task_graph is not None:
            metadata.update(
                {
                    "task_id": lane.id,
                    "task_graph_id": config.task_graph.graph_id,
                    "task_graph_revision": config.task_graph.revision,
                    "task_fingerprint": config.task_graph.execution_fingerprint(lane),
                }
            )
    await client.threads.create(
        thread_id=thread_id,
        graph_id="forgeflow",
        if_exists="raise" if lane is None else "do_nothing",
        metadata=metadata,
    )
    await client.runs.create(
        thread_id,
        assistant_id,
        input={
            "objective": objective,
            "repo_owner": config.owner,
            "repo_name": config.repo,
            "base_ref": config.base_ref,
            "workspace_path": None,
            **(
                {"preferred_implementation_route_id": lane.preferred_implementation_route_id}
                if isinstance(lane, TaskSpec) and lane.preferred_implementation_route_id
                else {}
            ),
        },
        config={"configurable": {"thread_id": thread_id}},
        metadata={
            "kind": "forgeflow_policy",
            "source": "project-supervisor",
            **({"lane_key": lane.key} if lane is not None else {}),
            **(
                {
                    "task_id": lane.id,
                    "task_graph_id": config.task_graph.graph_id,
                    "task_graph_revision": config.task_graph.revision,
                    "task_fingerprint": config.task_graph.execution_fingerprint(lane),
                }
                if isinstance(lane, TaskSpec) and config.task_graph is not None
                else {}
            ),
        },
        multitask_strategy="reject",
    )
    return thread_id


async def _advance_ready(
    config: ContinuousProjectConfig, values: Mapping[str, Any]
) -> str:
    pr_url = values.get("pr_url")
    head = values.get("observed_head_sha")
    ci_head = values.get("ci_head_sha")
    reviewed_head = values.get("reviewed_head_sha")
    if not all(isinstance(item, str) and item for item in (pr_url, head, ci_head, reviewed_head)):
        return "blocked:READY_EVIDENCE_MISSING"
    if not (head == ci_head == reviewed_head):
        return "blocked:READY_HEAD_MISMATCH"
    if _head_is_on_base(config, head):
        return "complete:on-base"
    if not config.auto_merge_ready:
        return "ready:awaiting-merge"
    pr = await fetch_pull_request(pr_url)
    if pr is None:
        return "blocked:PR_EVIDENCE_UNAVAILABLE"
    if pr.base_ref != config.base_ref or pr.head_sha != head:
        return "blocked:PR_IDENTITY_DRIFT"
    if pr.state != "open":
        return "blocked:PR_NOT_OPEN"
    try:
        merged = await merge_pull_request_exact_head(
            pr, expected_head_sha=head, merge_method="merge"
        )
    except GitHubEvidenceError as exc:
        return f"blocked:{exc}"
    return "merged" if merged else "ready:merge-deferred"


async def _supervise_single_project(
    client: Any, assistant_id: str, config: ContinuousProjectConfig, rows: list[Mapping[str, Any]]
) -> str:
    latest = _select_project_thread(rows, config)
    if latest is None:
        thread_id = await _create_objective(client, assistant_id, config)
        return f"created:{thread_id}"

    values = _values(latest)
    status = str(values.get("status") or "NEW")
    thread_id = str(latest.get("thread_id") or "")
    if status in ACTIVE:
        return f"active:{status}"
    if status == "ESCALATED":
        failure = str(values.get("last_failure_code") or "")
        if failure in RESOURCE_FAILURES and thread_id:
            await _command_recover(client, assistant_id, thread_id)
            return f"recovering:{failure}"
        return f"blocked:{failure or 'ESCALATED'}"
    if status == "CANCELLED":
        return "blocked:CANCELLED"
    if status != "READY":
        return f"blocked:UNSUPPORTED_STATUS:{status}"

    result = await _advance_ready(config, values)
    if result == "complete:on-base":
        next_id = await _create_objective(client, assistant_id, config)
        return f"created:{next_id}"
    return result


def _mutation_conflicts(
    candidate: ContinuousLaneConfig | TaskSpec,
    active_keys: set[str],
    task_map: Mapping[str, ContinuousLaneConfig | TaskSpec],
) -> list[str]:
    candidate_keys = set(getattr(candidate, "mutation_keys", ()))
    if not candidate_keys:
        return []
    conflicts: list[str] = []
    for key in sorted(active_keys):
        sibling = task_map.get(key)
        if sibling is None:
            continue
        sibling_keys = set(getattr(sibling, "mutation_keys", ()))
        if candidate_keys & sibling_keys:
            conflicts.append(key)
    return conflicts


async def _supervise_parallel_project(
    client: Any, assistant_id: str, config: ContinuousProjectConfig, rows: list[Mapping[str, Any]]
) -> str:
    plan_text = _plan_text(config)
    tasks = config.execution_tasks
    lane_map = {lane.key: lane for lane in tasks}
    completed = {
        lane.key
        for lane in tasks
        if _lane_complete(config, lane, rows, plan_text)
    }
    active = _active_rows(rows, config)
    if (
        config.task_graph is not None
        and len(completed) == len(tasks)
        and not active
    ):
        return "task-graph-complete"

    # Process terminal/recoverable lane state before opening new capacity. Keep
    # READY merges single-effect per invocation to preserve crash/replay safety.
    for lane in tasks:
        latest = _select_lane_thread(rows, config, lane.key)
        if latest is None:
            continue
        values = _values(latest)
        status = str(values.get("status") or "NEW")
        thread_id = str(latest.get("thread_id") or "")
        if status == "ESCALATED":
            failure = str(values.get("last_failure_code") or "")
            if failure in RESOURCE_FAILURES and thread_id:
                await _command_recover(client, assistant_id, thread_id)
                return f"parallel:recovering:{lane.key}:{failure}"
        if status == "READY" and lane.key not in completed:
            result = await _advance_ready(config, values)
            if result == "merged":
                return f"parallel:merged:{lane.key}"

    active_lane_keys = {
        key
        for row in active
        if (key := _thread_lane_key(row, config)) is not None
    }
    reservations = len(active)
    unknown_active = [row for row in active if _thread_lane_key(row, config) is None]
    if unknown_active:
        return (
            f"parallel:active={reservations}/{config.max_parallel_mutations} "
            f"blocked=unknown-active:{len(unknown_active)}"
        )
    capacity = max(0, config.max_parallel_mutations - reservations)
    if capacity == 0:
        return (
            f"parallel:active={reservations}/{config.max_parallel_mutations} "
            + "lanes="
            + ",".join(sorted(active_lane_keys))
        )

    created: list[tuple[str, str]] = []
    blocked: list[str] = []
    for lane in tasks:
        if len(created) >= capacity:
            break
        if lane.key in completed or lane.key in active_lane_keys:
            continue
        latest = _select_lane_thread(rows, config, lane.key)
        if latest is not None:
            status = str(_values(latest).get("status") or "NEW")
            if status in {"ESCALATED", "CANCELLED"}:
                blocked.append(f"{lane.key}:{status}")
                continue
            if status == "READY":
                blocked.append(f"{lane.key}:READY")
                continue
        missing = [key for key in lane.depends_on if key not in completed]
        if missing:
            blocked.append(f"{lane.key}:depends-on:{'+'.join(missing)}")
            continue
        conflicts = [key for key in lane.conflicts_with if key in active_lane_keys]
        if conflicts:
            blocked.append(f"{lane.key}:conflicts:{'+'.join(conflicts)}")
            continue
        # Conflict declarations are directional in configuration, so also honor
        # a currently-active sibling that declares this candidate as conflicting.
        reverse_conflicts = [
            key
            for key in active_lane_keys
            if key in lane_map and lane.key in lane_map[key].conflicts_with
        ]
        if reverse_conflicts:
            blocked.append(f"{lane.key}:conflicts:{'+'.join(reverse_conflicts)}")
            continue
        ownership_conflicts = _mutation_conflicts(lane, active_lane_keys, lane_map)
        if ownership_conflicts:
            blocked.append(
                f"{lane.key}:mutation-conflicts:{'+'.join(ownership_conflicts)}"
            )
            continue
        thread_id = await _create_objective(client, assistant_id, config, lane)
        created.append((lane.key, thread_id))
        active_lane_keys.add(lane.key)

    created_text = ",".join(f"{key}:{thread_id}" for key, thread_id in created) or "-"
    blocked_text = ",".join(blocked) or "-"
    return (
        f"parallel:active={reservations + len(created)}/{config.max_parallel_mutations} "
        f"created={created_text} blocked={blocked_text}"
    )


async def supervise_project(client: Any, assistant_id: str, config: ContinuousProjectConfig) -> str:
    if not _plan_active(config):
        return "plan-complete"
    rows = await _project_threads(client, config)
    if config.execution_tasks:
        return await _supervise_parallel_project(client, assistant_id, config, rows)
    return await _supervise_single_project(client, assistant_id, config, rows)


async def _run_once_locked(*, port: int, config_dir: Path, state_dir: Path) -> int:
    os.environ.setdefault("FORGEFLOW_POLICY_CONFIG_DIR", str(config_dir))
    os.environ.setdefault("FORGEFLOW_POLICY_STATE_DIR", str(state_dir))
    os.environ.setdefault("OPEN_SWE_LOCAL_PROJECTS_FILE", str(config_dir / "projects.json"))
    auth = (config_dir / "local-auth.secret").read_text(encoding="utf-8").strip()
    client = get_client(
        url=f"http://127.0.0.1:{port}",
        headers={"Authorization": f"Bearer {auth}"},
    )
    assistant_id = await _assistant_id(client)
    configs = load_continuous_project_configs()
    if not configs:
        print("project_supervisor=no_enabled_projects")
        return 0
    for config in configs:
        result = await supervise_project(client, assistant_id, config)
        print(f"project_supervisor={config.project_key}:{result}")
    return 0


async def run_once(*, port: int, config_dir: Path, state_dir: Path) -> int:
    state_dir.mkdir(parents=True, exist_ok=True)
    lock_path = state_dir / "project-supervisor.lock"
    with lock_path.open("a+", encoding="utf-8") as lock_file:
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("project_supervisor=already-running")
            return 0
        try:
            return await _run_once_locked(port=port, config_dir=config_dir, state_dir=state_dir)
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=58810)
    parser.add_argument(
        "--config-dir",
        type=Path,
        default=Path(
            os.environ.get(
                "FORGEFLOW_POLICY_CONFIG_DIR", Path.home() / ".config/forgeflow-policy"
            )
        ),
    )
    parser.add_argument(
        "--state-dir",
        type=Path,
        default=Path(
            os.environ.get(
                "FORGEFLOW_POLICY_STATE_DIR", Path.home() / ".local/share/forgeflow-policy"
            )
        ),
    )
    args = parser.parse_args()
    raise SystemExit(
        asyncio.run(
            run_once(port=args.port, config_dir=args.config_dir, state_dir=args.state_dir)
        )
    )


if __name__ == "__main__":
    main()
