#!/usr/bin/env python3
"""Run one exact-head Open SWE reviewer gate through the local ForgeFlow service."""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import time
from pathlib import Path
from typing import Any

from langgraph_sdk import get_client
from langgraph_sdk.errors import NotFoundError

from forgeflow.adapters.openswe import (
    OpenSweReviewerRuntime,
    ReviewerSnapshot,
    ReviewerSupersededError,
    reviewer_thread_id,
)
from forgeflow.evidence import EvidenceViolation, review_decision

_PENDING = frozenset({"pending", "running"})
_BLOCKING = frozenset({"critical", "high", "medium"})


class ReviewGateError(RuntimeError):
    pass


def _github_pr(repository: str, pr_number: int) -> dict[str, Any]:
    result = subprocess.run(
        ["gh", "api", f"repos/{repository}/pulls/{pr_number}"],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    if result.returncode != 0:
        raise ReviewGateError("REVIEW_GATE_GITHUB_PR_UNAVAILABLE")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ReviewGateError("REVIEW_GATE_GITHUB_PR_INVALID") from exc
    if not isinstance(payload, dict):
        raise ReviewGateError("REVIEW_GATE_GITHUB_PR_INVALID")
    return payload


def _pr_fields(payload: dict[str, Any], *, repository: str, pr_number: int) -> dict[str, Any]:
    owner, sep, repo = repository.partition("/")
    if not sep or not owner or not repo or "/" in repo:
        raise ReviewGateError("REVIEW_GATE_REPOSITORY_INVALID")
    head = payload.get("head") if isinstance(payload.get("head"), dict) else {}
    base = payload.get("base") if isinstance(payload.get("base"), dict) else {}
    fields = {
        "owner": owner,
        "repo": repo,
        "pr_number": pr_number,
        "pr_url": payload.get("html_url"),
        "head_sha": head.get("sha"),
        "head_ref": head.get("ref"),
        "base_sha": base.get("sha"),
        "base_ref": base.get("ref"),
    }
    if any(not isinstance(value, str) or not value for key, value in fields.items() if key != "pr_number"):
        raise ReviewGateError("REVIEW_GATE_PR_METADATA_INCOMPLETE")
    return fields


async def _adopt_current_exact_head(
    client: Any,
    *,
    owner: str,
    repo: str,
    pr_number: int,
    head_sha: str,
) -> tuple[str, str] | None:
    thread_id = reviewer_thread_id(owner, repo, pr_number)
    try:
        thread = await client.threads.get(thread_id)
    except NotFoundError:
        return None
    metadata = thread.get("metadata") if isinstance(thread, dict) else None
    metadata = metadata if isinstance(metadata, dict) else {}
    current = metadata.get("current_reviewer_run_id")
    if metadata.get("head_sha") != head_sha or not isinstance(current, str) or not current:
        return None
    return thread_id, current


def _decision_payload(snapshot: ReviewerSnapshot, *, head_sha: str) -> tuple[int, dict[str, Any]]:
    decision = review_decision(snapshot, expected_head_sha=head_sha)
    blocking = [
        {"id": finding.id, "severity": finding.severity}
        for finding in decision.findings
        if finding.status == "open" and finding.severity in _BLOCKING
    ]
    if blocking:
        return 2, {
            "status": "BLOCKED",
            "failure_code": "REVIEW_BLOCKED",
            "head_sha": head_sha,
            "reviewer_thread_id": snapshot.thread_id,
            "reviewer_run_id": snapshot.run_id,
            "blocking_findings": blocking,
        }
    return 0, {
        "status": "PASS",
        "head_sha": head_sha,
        "reviewer_thread_id": snapshot.thread_id,
        "reviewer_run_id": snapshot.run_id,
        "finding_count": len(decision.findings),
    }


async def _run(args: argparse.Namespace) -> int:
    config_dir = Path(args.config_dir).expanduser().resolve(strict=True)
    auth_file = config_dir / "local-auth.secret"
    if not auth_file.is_file():
        raise ReviewGateError("REVIEW_GATE_LOCAL_AUTH_MISSING")
    auth = auth_file.read_text(encoding="utf-8").strip()
    if not auth:
        raise ReviewGateError("REVIEW_GATE_LOCAL_AUTH_EMPTY")

    payload = _github_pr(args.repository, args.pr_number)
    fields = _pr_fields(payload, repository=args.repository, pr_number=args.pr_number)
    head_sha = fields["head_sha"]
    if args.expected_head and args.expected_head != head_sha:
        raise ReviewGateError("REVIEW_GATE_HEAD_MISMATCH")

    client = get_client(
        url=f"http://127.0.0.1:{args.port}",
        headers={"Authorization": f"Bearer {auth}"},
    )
    runtime = OpenSweReviewerRuntime(client)
    operation_key = f"review-gate:{args.repository}#{args.pr_number}:{head_sha}"
    pair = await runtime.find_current_review(
        pr_url=fields["pr_url"], expected_head_sha=head_sha, operation_key=operation_key
    )
    if pair is None:
        pair = await _adopt_current_exact_head(
            client,
            owner=fields["owner"],
            repo=fields["repo"],
            pr_number=args.pr_number,
            head_sha=head_sha,
        )
    if pair is None:
        pair = await runtime.trigger_review(
            owner=fields["owner"],
            repo=fields["repo"],
            pr_number=args.pr_number,
            pr_url=fields["pr_url"],
            head_sha=head_sha,
            head_ref=fields["head_ref"],
            base_sha=fields["base_sha"],
            base_ref=fields["base_ref"],
            operation_key=operation_key,
        )

    thread_id, run_id = pair
    deadline = time.monotonic() + args.timeout_minutes * 60
    while True:
        snapshot = await runtime.read_review(thread_id=thread_id, run_id=run_id)
        if snapshot.run_status == "success":
            code, result = _decision_payload(snapshot, head_sha=head_sha)
            print(json.dumps(result, sort_keys=True))
            return code
        if snapshot.run_status not in _PENDING:
            print(
                json.dumps(
                    {
                        "status": "BLOCKED",
                        "failure_code": f"REVIEW_RUN_{snapshot.run_status.upper()}",
                        "head_sha": head_sha,
                        "reviewer_thread_id": thread_id,
                        "reviewer_run_id": run_id,
                    },
                    sort_keys=True,
                )
            )
            return 2
        if time.monotonic() >= deadline:
            print(
                json.dumps(
                    {
                        "status": "BLOCKED",
                        "failure_code": "REVIEW_GATE_TIMEOUT",
                        "head_sha": head_sha,
                        "reviewer_thread_id": thread_id,
                        "reviewer_run_id": run_id,
                    },
                    sort_keys=True,
                )
            )
            return 2
        await asyncio.sleep(args.poll_seconds)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run an exact-head Open SWE PR reviewer gate")
    parser.add_argument("--repository", required=True, help="OWNER/REPO")
    parser.add_argument("--pr-number", required=True, type=int)
    parser.add_argument("--expected-head", default="")
    parser.add_argument("--port", type=int, default=58810)
    parser.add_argument(
        "--config-dir",
        default=str(Path.home() / ".config/forgeflow-policy"),
    )
    parser.add_argument("--timeout-minutes", type=int, default=20)
    parser.add_argument("--poll-seconds", type=float, default=5.0)
    return parser


def main() -> None:
    args = _parser().parse_args()
    try:
        raise SystemExit(asyncio.run(_run(args)))
    except (ReviewGateError, EvidenceViolation, ReviewerSupersededError, OSError, ValueError) as exc:
        code = str(exc).split(":", 1)[0] or type(exc).__name__
        print(json.dumps({"status": "BLOCKED", "failure_code": code}, sort_keys=True))
        raise SystemExit(2) from None


if __name__ == "__main__":
    main()
