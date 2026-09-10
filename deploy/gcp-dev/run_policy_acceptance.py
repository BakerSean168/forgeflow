#!/usr/bin/env python3
"""Run one real ForgeFlow Policy acceptance objective on GCP Dev.

This is operator tooling, not a second runtime. LangGraph owns the thread/run
lifecycle and Open SWE owns implementation/review. The harness only prepares a
throwaway desktop worktree, drives bounded reconcile steps faster than the cron,
and records exact-head acceptance evidence.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shlex
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

from httpx import HTTPStatusError

TERMINAL_FOR_ACCEPTANCE = frozenset({"READY", "ESCALATED", "CANCELLED"})
EVIDENCE_KEYS = (
    "status",
    "implementation_thread_id",
    "implementation_run_id",
    "implementation_operation_key",
    "pr_url",
    "pr_number",
    "observed_head_sha",
    "ci_head_sha",
    "reviewer_thread_id",
    "reviewer_run_id",
    "reviewed_head_sha",
    "repair_round",
    "blocking_finding_ids",
    "last_failure_code",
    "reconcile_cron_id",
)


def _load_external_env(path: Path) -> None:
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        if not raw or raw.lstrip().startswith("#") or "=" not in raw:
            continue
        key, encoded = raw.split("=", 1)
        parsed = shlex.split(encoded)
        if len(parsed) != 1:
            raise RuntimeError(f"invalid external env line for {key}")
        os.environ[key] = parsed[0]


def _git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=check,
        text=True,
        capture_output=True,
    )


def prepare_worktree(
    *, repo_path: Path, base_ref: str, state_dir: Path, branch_name: str
) -> Path:
    if not (repo_path / ".git").exists():
        # Worktree roots use a .git file; source repositories normally use a dir.
        probe = _git(repo_path, "rev-parse", "--is-inside-work-tree", check=False)
        if probe.returncode != 0 or probe.stdout.strip() != "true":
            raise RuntimeError(f"not a Git worktree: {repo_path}")
    _git(repo_path, "fetch", "origin", base_ref)
    worktree = state_dir / "worktrees" / f"acceptance-{uuid.uuid4().hex[:12]}"
    worktree.parent.mkdir(parents=True, exist_ok=True)
    _git(repo_path, "worktree", "add", "-b", branch_name, str(worktree), f"origin/{base_ref}")
    return worktree


def extract_evidence(values: dict[str, Any], *, thread_id: str, worktree: Path) -> dict[str, Any]:
    evidence = {key: values.get(key) for key in EVIDENCE_KEYS}
    evidence["policy_thread_id"] = thread_id
    evidence["workspace_path"] = str(worktree)
    evidence["captured_at_unix"] = int(time.time())
    return evidence


def write_evidence(path: Path, evidence: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(path)
    os.chmod(path, 0o600)


def cleanup_worktree(repo_path: Path, worktree: Path, branch_name: str) -> str:
    status = _git(worktree, "status", "--porcelain", check=False)
    if status.returncode != 0 or status.stdout.strip():
        return "kept_dirty"
    remove = _git(repo_path, "worktree", "remove", str(worktree), check=False)
    if remove.returncode != 0:
        return "kept_remove_failed"
    _git(repo_path, "branch", "-D", branch_name, check=False)
    return "removed_clean"


async def _assistant_id(client: Any) -> str:
    assistants = await client.assistants.search(graph_id="forgeflow", limit=10)
    matches = [item for item in assistants if item.get("graph_id") == "forgeflow"]
    if len(matches) != 1:
        raise RuntimeError(f"expected exactly one forgeflow assistant, found {len(matches)}")
    value = matches[0].get("assistant_id")
    if not isinstance(value, str) or not value:
        raise RuntimeError("forgeflow assistant has no assistant_id")
    return value


_THREAD_BUSY_DETAIL = "Thread is already running a task."


def _is_thread_busy_conflict(exc: HTTPStatusError) -> bool:
    if exc.response.status_code != 409:
        return False
    try:
        detail = exc.response.json().get("detail")
    except (ValueError, AttributeError):
        return False
    return isinstance(detail, str) and detail.startswith(_THREAD_BUSY_DETAIL)


async def _reconcile(
    client: Any, thread_id: str, assistant_id: str, payload: dict[str, Any]
) -> bool:
    """Run one reconcile step, yielding cleanly when the cron owns the thread slot."""
    try:
        await client.runs.wait(
            thread_id,
            assistant_id,
            input=payload,
            config={"configurable": {"thread_id": thread_id}},
            multitask_strategy="reject",
            raise_error=True,
        )
    except HTTPStatusError as exc:
        if _is_thread_busy_conflict(exc):
            return False
        raise
    return True


async def run_acceptance(args: argparse.Namespace) -> int:
    config_dir = Path.home() / ".config/forgeflow-policy"
    state_dir = Path.home() / ".local/share/forgeflow-policy"
    _load_external_env(config_dir / "github-app.env")

    # Import after external env load: pinned Open SWE snapshots App env at import time.
    from langgraph_sdk import get_client

    from forgeflow.adapters.github import preflight_github_repository
    from forgeflow.deployment import reviewer_sandbox_preflight

    owner, repo = args.repository.split("/", 1)
    github = await preflight_github_repository(owner, repo)
    sandbox = reviewer_sandbox_preflight()
    if github.status != "READY":
        raise RuntimeError(f"GitHub App preflight is not READY: {github.status}")
    if not sandbox.ready:
        raise RuntimeError(f"reviewer sandbox preflight is not READY: {sandbox.failure_code}")

    objective = Path(args.objective_file).read_text(encoding="utf-8").strip()
    if not objective:
        raise RuntimeError("objective file is empty")
    repo_path = Path(args.repo_path).resolve()
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    branch_name = f"open-swe/forgeflow-acceptance-{stamp}"
    worktree = prepare_worktree(
        repo_path=repo_path,
        base_ref=args.base_ref,
        state_dir=state_dir,
        branch_name=branch_name,
    )
    thread_id = str(uuid.uuid4())
    evidence_path = state_dir / "acceptance" / f"{stamp}-{thread_id[:8]}.json"

    auth = (config_dir / "local-auth.secret").read_text(encoding="utf-8").strip()
    client = get_client(
        url=f"http://127.0.0.1:{args.port}",
        headers={"Authorization": f"Bearer {auth}"},
    )
    assistant_id = await _assistant_id(client)
    await client.threads.create(
        thread_id=thread_id,
        if_exists="raise",
        metadata={
            "source": "forgeflow-acceptance",
            "repo": {"owner": owner, "name": repo},
            "title": f"ForgeFlow acceptance {stamp}",
        },
    )
    initial = {
        "objective": objective,
        "repo_owner": owner,
        "repo_name": repo,
        "base_ref": args.base_ref,
        "workspace_path": str(worktree),
    }
    deadline = time.monotonic() + args.timeout_minutes * 60
    last_status: tuple[Any, ...] | None = None
    first = True
    while True:
        if await _reconcile(client, thread_id, assistant_id, initial if first else {}):
            first = False
        state = await client.threads.get_state(thread_id)
        values = dict(state.get("values") or {})
        marker = (
            values.get("status"),
            values.get("observed_head_sha"),
            values.get("repair_round"),
            values.get("last_failure_code"),
        )
        if marker != last_status:
            print(
                "status=" + str(marker[0])
                + " head=" + str(marker[1] or "-")
                + " repair_round=" + str(marker[2] or 0)
                + " failure=" + str(marker[3] or "-"),
                flush=True,
            )
            last_status = marker
        status = values.get("status")
        if status in TERMINAL_FOR_ACCEPTANCE:
            evidence = extract_evidence(values, thread_id=thread_id, worktree=worktree)
            evidence["repository"] = args.repository
            evidence["base_ref"] = args.base_ref
            evidence["branch_name"] = branch_name
            write_evidence(evidence_path, evidence)
            print(f"evidence_file={evidence_path}", flush=True)
            if status == "READY" and not args.leave_monitoring:
                while not await _reconcile(
                    client, thread_id, assistant_id, {"cancel_requested": True}
                ):
                    await asyncio.sleep(args.poll_seconds)
                while not await _reconcile(client, thread_id, assistant_id, {}):
                    await asyncio.sleep(args.poll_seconds)
                cleanup = cleanup_worktree(repo_path, worktree, branch_name)
                print(f"post_ready_policy=CANCELLED worktree_cleanup={cleanup}", flush=True)
            elif status != "READY":
                print(f"worktree_preserved={worktree}", flush=True)
            return 0 if status == "READY" else 2
        if time.monotonic() >= deadline:
            values = dict((await client.threads.get_state(thread_id)).get("values") or {})
            evidence = extract_evidence(values, thread_id=thread_id, worktree=worktree)
            evidence["timeout"] = True
            write_evidence(evidence_path, evidence)
            print(f"timeout evidence_file={evidence_path} worktree_preserved={worktree}", flush=True)
            return 3
        await asyncio.sleep(args.poll_seconds)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True, help="OWNER/REPO")
    parser.add_argument("--repo-path", required=True)
    parser.add_argument("--objective-file", required=True)
    parser.add_argument("--base-ref", default="main")
    parser.add_argument("--port", type=int, default=58810)
    parser.add_argument("--poll-seconds", type=int, default=8)
    parser.add_argument("--timeout-minutes", type=int, default=60)
    parser.add_argument("--leave-monitoring", action="store_true")
    args = parser.parse_args()
    if "/" not in args.repository or args.repository.count("/") != 1:
        raise SystemExit("--repository must be OWNER/REPO")
    if args.poll_seconds < 1 or args.timeout_minutes < 1:
        raise SystemExit("poll/timeout values must be positive")
    raise SystemExit(asyncio.run(run_acceptance(args)))


if __name__ == "__main__":
    main()
