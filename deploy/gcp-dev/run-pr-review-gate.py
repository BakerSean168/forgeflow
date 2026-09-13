#!/usr/bin/env python3
"""Run one exact-head Open SWE reviewer gate through the local ForgeFlow service."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shlex
import subprocess
import time
from pathlib import Path
from typing import Any

from langgraph_sdk import get_client

_PENDING = frozenset({"pending", "running"})
_BLOCKING = frozenset({"critical", "high", "medium"})


class ReviewGateError(RuntimeError):
    pass

_GITHUB_APP_ENV_KEYS = frozenset(
    {"GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_INSTALLATION_ID"}
)


def _load_github_app_env(config_dir: Path) -> None:
    """Load only the GitHub App fields reviewer baseline resolution requires.

    The long-running service receives these through systemd, but this operator
    gate is a separate process. Load the same deployment-owned env file before
    importing Open SWE so its module-level GitHub App settings are initialized
    consistently. Never print or return the values.
    """
    env_file = config_dir / "github-app.env"
    if not env_file.is_file():
        raise ReviewGateError("REVIEW_GATE_GITHUB_APP_ENV_MISSING")
    loaded: set[str] = set()
    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, sep, raw_value = line.partition("=")
        if not sep or key not in _GITHUB_APP_ENV_KEYS:
            continue
        try:
            parts = shlex.split(raw_value, posix=True)
        except ValueError as exc:
            raise ReviewGateError("REVIEW_GATE_GITHUB_APP_ENV_INVALID") from exc
        if len(parts) != 1 or not parts[0]:
            raise ReviewGateError("REVIEW_GATE_GITHUB_APP_ENV_INVALID")
        os.environ[key] = parts[0]
        loaded.add(key)
    if loaded != _GITHUB_APP_ENV_KEYS:
        raise ReviewGateError("REVIEW_GATE_GITHUB_APP_ENV_INCOMPLETE")


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
    from langgraph_sdk.errors import NotFoundError

    from forgeflow.adapters.openswe import reviewer_thread_id

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
    try:
        run = await client.runs.get(thread_id, current)
    except NotFoundError:
        return None
    run_metadata = run.get("metadata") if isinstance(run, dict) else None
    run_metadata = run_metadata if isinstance(run_metadata, dict) else {}
    run_head = run_metadata.get("head_sha")
    if not isinstance(run_head, str) or not run_head:
        kwargs = run.get("kwargs") if isinstance(run, dict) else None
        config = kwargs.get("config") if isinstance(kwargs, dict) else None
        configurable = config.get("configurable") if isinstance(config, dict) else None
        run_head = configurable.get("head_sha") if isinstance(configurable, dict) else None
    if run_head != head_sha:
        return None
    return thread_id, current


def _decision_payload(snapshot: Any, *, head_sha: str) -> tuple[int, dict[str, Any]]:
    from forgeflow.evidence import review_decision

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
    from forgeflow.adapters.openswe import OpenSweReviewerRuntime

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


def _blocked_exit(exc: BaseException) -> None:
    code = str(exc).split(":", 1)[0] or type(exc).__name__
    print(json.dumps({"status": "BLOCKED", "failure_code": code}, sort_keys=True))
    raise SystemExit(2) from None


def main() -> None:
    args = _parser().parse_args()
    try:
        config_dir = Path(args.config_dir).expanduser().resolve(strict=True)
        _load_github_app_env(config_dir)
    except (ReviewGateError, OSError, ValueError) as exc:
        _blocked_exit(exc)

    from forgeflow.adapters.openswe import ReviewerSupersededError
    from forgeflow.evidence import EvidenceViolation

    try:
        raise SystemExit(asyncio.run(_run(args)))
    except (ReviewGateError, EvidenceViolation, ReviewerSupersededError, OSError, ValueError) as exc:
        _blocked_exit(exc)


if __name__ == "__main__":
    main()
