#!/usr/bin/env python3
"""Show bounded reviewer finding state without exposing local auth or model messages."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from langgraph_sdk import get_client

from forgeflow.adapters.openswe import OpenSweReviewerRuntime, reviewer_thread_id


class DiagnosticError(RuntimeError):
    pass


async def _run(args: argparse.Namespace) -> None:
    owner, sep, repo = args.repository.partition("/")
    if not sep or not owner or not repo or "/" in repo:
        raise DiagnosticError("REVIEW_DIAGNOSTIC_REPOSITORY_INVALID")
    auth_file = Path(args.config_dir).expanduser().resolve(strict=True) / "local-auth.secret"
    if not auth_file.is_file():
        raise DiagnosticError("REVIEW_DIAGNOSTIC_LOCAL_AUTH_MISSING")
    auth = auth_file.read_text(encoding="utf-8").strip()
    if not auth:
        raise DiagnosticError("REVIEW_DIAGNOSTIC_LOCAL_AUTH_EMPTY")

    client = get_client(
        url=f"http://127.0.0.1:{args.port}",
        headers={"Authorization": f"Bearer {auth}"},
    )
    thread_id = reviewer_thread_id(owner, repo, args.pr_number)
    thread = await client.threads.get(thread_id)
    metadata = thread.get("metadata") if isinstance(thread, dict) else None
    metadata = metadata if isinstance(metadata, dict) else {}
    run_id = metadata.get("current_reviewer_run_id")
    head_sha = metadata.get("head_sha")
    if not isinstance(run_id, str) or not run_id:
        raise DiagnosticError("REVIEW_DIAGNOSTIC_RUN_MISSING")
    if args.expected_head and head_sha != args.expected_head:
        raise DiagnosticError("REVIEW_DIAGNOSTIC_HEAD_MISMATCH")

    snapshot = await OpenSweReviewerRuntime(client).read_review(thread_id=thread_id, run_id=run_id)
    findings = []
    for item in snapshot.findings:
        findings.append(
            {
                "id": item.get("id"),
                "severity": item.get("severity"),
                "status": item.get("status"),
                "title": item.get("title"),
                "file": item.get("file"),
                "description": item.get("description"),
                "last_confirmed_sha": item.get("last_confirmed_sha"),
                "last_reconciliation_note": item.get("last_reconciliation_note"),
                "resolution_note": item.get("resolution_note"),
            }
        )
    print(
        json.dumps(
            {
                "thread_id": snapshot.thread_id,
                "run_id": snapshot.run_id,
                "run_status": snapshot.run_status,
                "last_reviewed_sha": snapshot.last_reviewed_sha,
                "findings": findings,
            },
            sort_keys=True,
        )
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Show bounded exact-head reviewer finding state")
    parser.add_argument("--repository", required=True)
    parser.add_argument("--pr-number", required=True, type=int)
    parser.add_argument("--expected-head", default="")
    parser.add_argument("--port", type=int, default=58810)
    parser.add_argument(
        "--config-dir", default=str(Path.home() / ".config/forgeflow-policy")
    )
    return parser


def main() -> None:
    try:
        asyncio.run(_run(_parser().parse_args()))
    except (DiagnosticError, OSError, ValueError) as exc:
        code = str(exc).split(":", 1)[0] or type(exc).__name__
        print(json.dumps({"status": "BLOCKED", "failure_code": code}, sort_keys=True))
        raise SystemExit(2) from None


if __name__ == "__main__":
    main()
