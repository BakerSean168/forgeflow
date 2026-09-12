"""GitHub delivery adapter for already-verified external-agent workspace changes."""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import subprocess
import tempfile
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path

import httpx2

from forgeflow.adapters.github import _repository_token
from forgeflow.external_agents.execution import (
    ExternalAgentExecutionEvidence,
    ExternalAgentExecutionRequest,
)
from forgeflow.prompts.implementation import operation_trailer

_SLUG = re.compile(r"^[A-Za-z0-9_.-]+$")


class ExternalAgentDeliveryError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ExternalAgentPullRequestDelivery:
    pr_url: str
    pr_number: int
    branch: str
    head_sha: str
    base_ref: str


TokenProvider = Callable[[str, str], Awaitable[str | None]]
PrWriter = Callable[
    [str, str, str, str, str, str, str],
    Awaitable[ExternalAgentPullRequestDelivery],
]
PushFn = Callable[[Path, str, str, str, str], None]


def delivery_branch_name(operation_key: str) -> str:
    if not operation_key.strip():
        raise ValueError("operation_key is required")
    digest = hashlib.sha256(operation_key.encode("utf-8")).hexdigest()[:16]
    return f"forgeflow/external-{digest}"


def _git(workspace: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    result = subprocess.run(
        ["git", *args],
        cwd=workspace,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        check=False,
        timeout=60,
        env={**os.environ, "LC_ALL": "C.UTF-8"},
    )
    if check and result.returncode != 0:
        raise ExternalAgentDeliveryError("EXTERNAL_AGENT_GIT_COMMAND_FAILED")
    return result


def _status_paths(workspace: Path) -> tuple[str, ...]:
    raw = _git(workspace, "status", "--porcelain=v1", "-z").stdout
    entries = raw.split(b"\0")
    paths: list[str] = []
    for entry in entries:
        if not entry:
            continue
        text = entry.decode("utf-8", errors="strict")
        if len(text) < 4:
            raise ExternalAgentDeliveryError("EXTERNAL_AGENT_GIT_STATUS_INVALID")
        path = text[3:]
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        paths.append(path)
    return tuple(sorted(dict.fromkeys(paths)))


async def _write_token(owner: str, repo: str) -> str | None:
    scoped = await _repository_token(
        owner,
        repo,
        permissions={"contents": "write", "pull_requests": "write"},
    )
    return scoped[1] if scoped else None


def _push_with_token(workspace: Path, owner: str, repo: str, branch: str, token: str) -> None:
    if not (_SLUG.fullmatch(owner) and _SLUG.fullmatch(repo)):
        raise ExternalAgentDeliveryError("EXTERNAL_AGENT_REPOSITORY_INVALID")
    if not branch.startswith("forgeflow/external-"):
        raise ExternalAgentDeliveryError("EXTERNAL_AGENT_BRANCH_INVALID")
    with tempfile.TemporaryDirectory(prefix="forgeflow-git-auth-") as temp:
        root = Path(temp)
        askpass = root / "askpass.sh"
        askpass.write_text(
            "#!/bin/sh\n"
            'case "$1" in\n'
            "  *Username*) printf '%s\\n' x-access-token ;;\n"
            "  *Password*) printf '%s\\n' \"$FORGEFLOW_GITHUB_TOKEN\" ;;\n"
            "  *) exit 1 ;;\n"
            "esac\n",
            encoding="utf-8",
        )
        askpass.chmod(0o700)
        env = {
            "HOME": str(root),
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_ASKPASS": str(askpass),
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_SYSTEM": "/dev/null",
            "FORGEFLOW_GITHUB_TOKEN": token,
        }
        result = subprocess.run(
            [
                "git",
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "credential.helper=",
                "push",
                f"https://github.com/{owner}/{repo}.git",
                f"HEAD:refs/heads/{branch}",
            ],
            cwd=workspace,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            check=False,
            timeout=120,
            env=env,
        )
    if result.returncode != 0:
        raise ExternalAgentDeliveryError("EXTERNAL_AGENT_PUSH_FAILED")


async def _create_or_adopt_pr(
    owner: str,
    repo: str,
    branch: str,
    base_ref: str,
    title: str,
    body: str,
    token: str,
) -> ExternalAgentPullRequestDelivery:
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    url = f"https://api.github.com/repos/{owner}/{repo}/pulls"
    async with httpx2.AsyncClient(timeout=20) as client:
        response = await client.post(
            url,
            headers=headers,
            json={"title": title, "head": branch, "base": base_ref, "body": body},
        )
        if response.status_code == 201:
            payload = response.json()
        elif response.status_code == 422:
            existing = await client.get(
                url,
                headers=headers,
                params={"state": "open", "head": f"{owner}:{branch}", "base": base_ref},
            )
            if existing.status_code != 200:
                raise ExternalAgentDeliveryError("EXTERNAL_AGENT_PR_LOOKUP_FAILED")
            rows = existing.json()
            if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
                raise ExternalAgentDeliveryError("EXTERNAL_AGENT_PR_IDEMPOTENCY_CONFLICT")
            payload = rows[0]
        else:
            raise ExternalAgentDeliveryError("EXTERNAL_AGENT_PR_CREATE_FAILED")

    number = payload.get("number") if isinstance(payload, dict) else None
    html_url = payload.get("html_url") if isinstance(payload, dict) else None
    head = (
        payload.get("head")
        if isinstance(payload, dict) and isinstance(payload.get("head"), dict)
        else {}
    )
    head_sha = head.get("sha")
    head_ref = head.get("ref")
    base = (
        payload.get("base")
        if isinstance(payload, dict) and isinstance(payload.get("base"), dict)
        else {}
    )
    base_name = base.get("ref")
    if (
        not isinstance(number, int)
        or number <= 0
        or not isinstance(html_url, str)
        or not html_url
        or not isinstance(head_sha, str)
        or not head_sha
        or head_ref != branch
        or base_name != base_ref
    ):
        raise ExternalAgentDeliveryError("EXTERNAL_AGENT_PR_RESPONSE_INVALID")
    return ExternalAgentPullRequestDelivery(
        pr_url=html_url,
        pr_number=number,
        branch=branch,
        head_sha=head_sha,
        base_ref=base_ref,
    )


class GitHubExternalAgentDelivery:
    """Commit verified changes, push with a short-lived App token, and open/adopt one PR."""

    def __init__(
        self,
        *,
        token_provider: TokenProvider = _write_token,
        pr_writer: PrWriter = _create_or_adopt_pr,
        push: PushFn = _push_with_token,
    ) -> None:
        self._token_provider = token_provider
        self._pr_writer = pr_writer
        self._push = push

    async def deliver(
        self,
        *,
        request: ExternalAgentExecutionRequest,
        evidence: ExternalAgentExecutionEvidence,
        base_ref: str,
        commit_subject: str,
        pr_title: str,
        pr_body: str,
    ) -> ExternalAgentPullRequestDelivery:
        workspace = request.workspace.resolve(strict=True)
        current_head = _git(workspace, "rev-parse", "HEAD").stdout.decode().strip()
        if current_head != evidence.source_revision:
            raise ExternalAgentDeliveryError("EXTERNAL_AGENT_SOURCE_REVISION_DRIFT")
        status_paths = _status_paths(workspace)
        if status_paths != evidence.changed_files:
            raise ExternalAgentDeliveryError("EXTERNAL_AGENT_DELIVERY_DIFF_DRIFT")
        if not base_ref.strip():
            raise ExternalAgentDeliveryError("EXTERNAL_AGENT_BASE_REF_EMPTY")
        if not commit_subject.strip():
            raise ExternalAgentDeliveryError("EXTERNAL_AGENT_COMMIT_SUBJECT_EMPTY")

        branch = delivery_branch_name(request.operation_key)
        if (
            _git(workspace, "show-ref", "--verify", f"refs/heads/{branch}", check=False).returncode
            == 0
        ):
            raise ExternalAgentDeliveryError("EXTERNAL_AGENT_LOCAL_BRANCH_EXISTS")
        _git(workspace, "switch", "-c", branch)
        _git(workspace, "add", "--", *evidence.changed_files)
        staged = tuple(
            sorted(
                line
                for line in _git(workspace, "diff", "--cached", "--name-only")
                .stdout.decode()
                .splitlines()
                if line
            )
        )
        if staged != evidence.changed_files:
            raise ExternalAgentDeliveryError("EXTERNAL_AGENT_STAGED_DIFF_DRIFT")
        _git(
            workspace,
            "-c",
            "user.name=ForgeFlow",
            "-c",
            "user.email=forgeflow@users.noreply.github.com",
            "commit",
            "-m",
            commit_subject.strip(),
            "-m",
            operation_trailer(request.operation_key),
        )
        head_sha = _git(workspace, "rev-parse", "HEAD").stdout.decode().strip()
        if head_sha == evidence.source_revision:
            raise ExternalAgentDeliveryError("EXTERNAL_AGENT_DELIVERY_NO_COMMIT")
        if _git(workspace, "status", "--porcelain").stdout.strip():
            raise ExternalAgentDeliveryError("EXTERNAL_AGENT_DELIVERY_WORKSPACE_DIRTY")

        token = await self._token_provider(request.owner, request.repo)
        if not token:
            raise ExternalAgentDeliveryError("EXTERNAL_AGENT_GITHUB_WRITE_TOKEN_UNAVAILABLE")
        await asyncio.to_thread(
            self._push,
            workspace,
            request.owner,
            request.repo,
            branch,
            token,
        )
        delivered = await self._pr_writer(
            request.owner,
            request.repo,
            branch,
            base_ref,
            pr_title.strip(),
            pr_body.strip(),
            token,
        )
        if delivered.head_sha != head_sha:
            raise ExternalAgentDeliveryError("EXTERNAL_AGENT_PR_HEAD_MISMATCH")
        return delivered


__all__ = [
    "ExternalAgentDeliveryError",
    "ExternalAgentPullRequestDelivery",
    "GitHubExternalAgentDelivery",
    "delivery_branch_name",
]
