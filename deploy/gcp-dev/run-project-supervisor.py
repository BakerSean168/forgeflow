#!/usr/bin/env python3
"""Stateless project continuation supervisor for unattended ForgeFlow runs.

The supervisor persists no queue. Repository plan files are task truth and
LangGraph ForgeFlow threads are execution truth. One invocation performs at
most one action per configured project: recover a resource escalation, merge an
exact-head READY PR, or create the next bounded objective.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import subprocess
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from uuid import uuid4

from langgraph_sdk import get_client

from forgeflow.adapters.github import (
    GitHubEvidenceError,
    fetch_pull_request,
    merge_pull_request_exact_head,
)
from forgeflow.projects import ContinuousProjectConfig, load_continuous_project_configs

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


def _plan_active(config: ContinuousProjectConfig) -> bool:
    return any(path.is_file() for path in config.plan_paths)


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


async def _latest_project_thread(client: Any, project_key: str) -> Mapping[str, Any] | None:
    rows = await client.threads.search(
        metadata={"graph_id": "forgeflow", "project_key": project_key},
        limit=20,
        sort_by="updated_at",
        sort_order="desc",
    )
    for row in rows:
        if isinstance(row, Mapping):
            return row
    return None


async def _command_recover(client: Any, assistant_id: str, thread_id: str) -> None:
    await client.runs.create(
        thread_id,
        assistant_id,
        input={"recover_requested": True},
        config={"configurable": {"thread_id": thread_id}},
        metadata={"kind": "forgeflow_policy_command", "command": "recover", "source": "project-supervisor"},
        multitask_strategy="enqueue",
    )


async def _create_objective(
    client: Any, assistant_id: str, config: ContinuousProjectConfig
) -> str:
    thread_id = str(uuid4())
    criteria = "\n".join(f"- {item}" for item in config.acceptance_criteria)
    objective = config.objective if not criteria else f"{config.objective}\n\nAcceptance criteria:\n{criteria}"
    await client.threads.create(
        thread_id=thread_id,
        graph_id="forgeflow",
        if_exists="raise",
        metadata={
            "kind": "forgeflow-policy",
            "source": "project-supervisor",
            "project_key": config.project_key,
            "repo": {"owner": config.owner, "name": config.repo},
            "title": objective[:120],
        },
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
        },
        config={"configurable": {"thread_id": thread_id}},
        metadata={"kind": "forgeflow_policy", "source": "project-supervisor"},
        multitask_strategy="reject",
    )
    return thread_id


async def supervise_project(client: Any, assistant_id: str, config: ContinuousProjectConfig) -> str:
    if not _plan_active(config):
        return "plan-complete"

    latest = await _latest_project_thread(client, config.project_key)
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

    pr_url = values.get("pr_url")
    head = values.get("observed_head_sha")
    ci_head = values.get("ci_head_sha")
    reviewed_head = values.get("reviewed_head_sha")
    if not all(isinstance(item, str) and item for item in (pr_url, head, ci_head, reviewed_head)):
        return "blocked:READY_EVIDENCE_MISSING"
    if not (head == ci_head == reviewed_head):
        return "blocked:READY_HEAD_MISMATCH"

    if _head_is_on_base(config, head):
        next_id = await _create_objective(client, assistant_id, config)
        return f"created:{next_id}"

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
        merged = await merge_pull_request_exact_head(pr, expected_head_sha=head, merge_method="merge")
    except GitHubEvidenceError as exc:
        return f"blocked:{exc}"
    if not merged:
        return "ready:merge-deferred"

    # Keep the crash/replay boundary single-effect. The next timer tick proves
    # the accepted head is now on the base branch before creating a new objective.
    return "merged"


async def run_once(*, port: int, config_dir: Path, state_dir: Path) -> int:
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=58810)
    parser.add_argument(
        "--config-dir",
        type=Path,
        default=Path(os.environ.get("FORGEFLOW_POLICY_CONFIG_DIR", Path.home() / ".config/forgeflow-policy")),
    )
    parser.add_argument(
        "--state-dir",
        type=Path,
        default=Path(os.environ.get("FORGEFLOW_POLICY_STATE_DIR", Path.home() / ".local/share/forgeflow-policy")),
    )
    args = parser.parse_args()
    raise SystemExit(asyncio.run(run_once(port=args.port, config_dir=args.config_dir, state_dir=args.state_dir)))


if __name__ == "__main__":
    main()
