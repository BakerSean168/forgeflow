#!/usr/bin/env python3
"""Explicit GCP Dev canary for one external-agent project change and GitHub delivery."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shlex
import shutil
import subprocess
import tempfile
from dataclasses import asdict
from pathlib import Path

from acp.exceptions import RequestError

from forgeflow.attempts import AttemptHandle, AttemptLedger
from forgeflow.external_agents.execution import ExternalAgentExecutionRequest
from forgeflow.routing import classify_failure_code, load_route_registry
from openswe_ext.antigravity_execution import AntigravityExternalAgentExecution


class ProjectCanaryError(RuntimeError):
    pass


def _load_external_env(path: Path) -> None:
    """Load the deployment env file without emitting values or shell-evaluating it."""

    if not path.is_file():
        raise ProjectCanaryError("PROJECT_CANARY_GITHUB_ENV_MISSING")
    for raw in path.read_text(encoding="utf-8").splitlines():
        if not raw or raw.lstrip().startswith("#") or "=" not in raw:
            continue
        key, encoded = raw.split("=", 1)
        parsed = shlex.split(encoded)
        if len(parsed) != 1:
            raise ProjectCanaryError(f"PROJECT_CANARY_GITHUB_ENV_INVALID:{key}")
        os.environ[key] = parsed[0]


def _git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["git", *args],
        cwd=repo,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
        env={**os.environ, "LC_ALL": "C.UTF-8"},
    )
    if check and result.returncode != 0:
        raise ProjectCanaryError("PROJECT_CANARY_GIT_FAILED")
    return result


def _prepare_workspace(repo_path: Path, base_ref: str, root: Path) -> tuple[Path, str]:
    source = repo_path.expanduser().resolve(strict=True)
    if not (source / ".git").exists():
        raise ProjectCanaryError("PROJECT_CANARY_SOURCE_NOT_GIT_REPOSITORY")
    if _git(source, "status", "--porcelain").stdout.strip():
        raise ProjectCanaryError("PROJECT_CANARY_SOURCE_DIRTY")
    _git(source, "fetch", "--quiet", "origin", base_ref)
    source_revision = _git(source, "rev-parse", f"origin/{base_ref}").stdout.strip()

    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root.chmod(0o700)
    placeholder = Path(tempfile.mkdtemp(prefix="forgeflow-project-canary-", dir=root))
    placeholder.rmdir()
    result = subprocess.run(
        ["git", "clone", "--quiet", "--no-local", "--no-checkout", str(source), str(placeholder)],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        check=False,
        timeout=180,
        env={**os.environ, "LC_ALL": "C.UTF-8"},
    )
    if result.returncode != 0:
        shutil.rmtree(placeholder, ignore_errors=True)
        raise ProjectCanaryError("PROJECT_CANARY_CLONE_FAILED")
    _git(placeholder, "checkout", "--quiet", "--detach", source_revision)
    return placeholder, source_revision


def _cleanup_workspace(workspace: Path | None) -> None:
    if workspace is not None and workspace.exists():
        shutil.rmtree(workspace, ignore_errors=False)


def _failure_code(exc: BaseException) -> str:
    if isinstance(exc, OSError):
        return "PROJECT_CANARY_IO_FAILED"
    code = str(exc).split(":", 1)[0].strip()
    return code or type(exc).__name__


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run one explicit external-agent project canary")
    parser.add_argument("--repo-path", required=True)
    parser.add_argument("--owner", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--base-ref", default="main")
    parser.add_argument("--objective", required=True)
    parser.add_argument("--operation-key", required=True)
    parser.add_argument("--test-command", default="git diff --check")
    parser.add_argument("--commit-subject", required=True)
    parser.add_argument("--pr-title", required=True)
    parser.add_argument("--pr-body", default="Guarded ForgeFlow external-agent canary.")
    parser.add_argument("--route-id", default="antigravity-account-primary")
    parser.add_argument(
        "--route-config",
        default=os.environ.get(
            "FORGEFLOW_ROUTE_CONFIG_FILE",
            str(Path.home() / ".config/forgeflow-policy/routes.json"),
        ),
    )
    parser.add_argument(
        "--attempt-ledger",
        default=os.environ.get(
            "FORGEFLOW_ATTEMPT_LEDGER_FILE",
            str(Path.home() / ".local/share/forgeflow-policy/attempt-ledger.jsonl"),
        ),
    )
    parser.add_argument(
        "--github-env",
        default=str(Path.home() / ".config/forgeflow-policy/github-app.env"),
    )
    return parser


async def _run(args: argparse.Namespace) -> int:
    root = Path.home() / ".local/share/forgeflow-policy/external-agent-workspaces"
    workspace: Path | None = None
    expected_source: str | None = None
    attempt: AttemptHandle | None = None
    ledger = AttemptLedger(Path(args.attempt_ledger))
    attempt_finished = False
    try:
        _load_external_env(Path(args.github_env).expanduser())
        # GitHub App values are captured by the pinned Open SWE modules at import time.
        # Import delivery only after the operator env has been loaded.
        from forgeflow.adapters.external_delivery import GitHubExternalAgentDelivery

        registry = load_route_registry(Path(args.route_config))
        route = registry.get(args.route_id)
        if (
            route.role != "IMPLEMENT"
            or route.runtime != "EXTERNAL_ACP"
            or route.adapter != "antigravity"
        ):
            raise ProjectCanaryError("PROJECT_CANARY_ROUTE_INVALID")

        workspace, expected_source = await asyncio.to_thread(
            _prepare_workspace,
            Path(args.repo_path),
            args.base_ref,
            root,
        )
        # This command is an explicit operator canary, so it may exercise a scheduler-disabled
        # route without changing persistent route configuration. The adapter itself remains gated
        # to this project/workspace for this invocation only.
        attempt = ledger.start(
            role=route.role,
            route_id=route.id,
            priority=route.priority,
            runtime=route.runtime,
            target=route.target,
            operation_key=args.operation_key,
            source_revision=expected_source,
        )
        route_env = dict(os.environ)
        route_env.update(
            {
                "FORGEFLOW_ANTIGRAVITY_ACP_ENABLED": "true",
                "FORGEFLOW_ANTIGRAVITY_ACP_PROJECTS": f"{args.owner}/{args.repo}",
                "FORGEFLOW_EXTERNAL_AGENT_WORKSPACE_ROOT": str(root),
                "FORGEFLOW_EXTERNAL_AGENT_OUTER_SANDBOX": "docker",
            }
        )
        request = ExternalAgentExecutionRequest(
            owner=args.owner,
            repo=args.repo,
            workspace=workspace,
            objective=args.objective,
            operation_key=args.operation_key,
            phase="IMPLEMENT",
            test_command=tuple(shlex.split(args.test_command)),
        )
        execution = AntigravityExternalAgentExecution(env=route_env)
        evidence = await execution.execute(request)
        if evidence.source_revision != expected_source:
            raise ProjectCanaryError("PROJECT_CANARY_SOURCE_REVISION_MISMATCH")
        delivery = await GitHubExternalAgentDelivery().deliver(
            request=request,
            evidence=evidence,
            base_ref=args.base_ref,
            commit_subject=args.commit_subject,
            pr_title=args.pr_title,
            pr_body=args.pr_body,
        )
        ledger.finish(
            attempt,
            outcome="SUCCEEDED",
            source_revision=evidence.source_revision,
            result_revision=delivery.head_sha,
            external_session_id=evidence.acp_session_id,
            external_conversation_id=evidence.external_conversation_id,
        )
        attempt_finished = True
        print(
            json.dumps(
                {
                    "status": "PASS",
                    "route": {"id": route.id, "priority": route.priority, "runtime": route.runtime},
                    "attempt_id": attempt.attempt_id,
                    "execution": asdict(evidence),
                    "delivery": asdict(delivery),
                },
                sort_keys=True,
            )
        )
        return 0
    except (RequestError, RuntimeError, OSError, subprocess.SubprocessError, ValueError, KeyError) as exc:
        code = _failure_code(exc)
        if attempt is not None and not attempt_finished:
            try:
                ledger.finish(
                    attempt,
                    outcome="BLOCKED",
                    failure_class=classify_failure_code(code),
                    fallback_reason=code,
                    source_revision=expected_source,
                )
            except OSError:
                code = "ATTEMPT_LEDGER_WRITE_FAILED"
        print(json.dumps({"status": "BLOCKED", "failure_code": code}, sort_keys=True))
        return 2
    finally:
        await asyncio.to_thread(_cleanup_workspace, workspace)


def main() -> None:
    args = _parser().parse_args()
    raise SystemExit(asyncio.run(_run(args)))


if __name__ == "__main__":
    main()
