"""GitHub auth bridge for ForgeFlow-originated Open SWE agent runs.

Open SWE's upstream token resolver knows product surfaces such as GitHub,
Slack, Linear, and dashboard, but ForgeFlow is an external automation source.
This bridge maps only that source to the already-configured GitHub App. It does
not own credentials and never exposes the App private key to a sandbox.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import agent.github.token as token_module
from agent.github.app import get_github_app_installation_token_with_expiry
from agent.run_config import RunConfig

_UPSTREAM_RESOLVE = token_module.resolve_github_token


async def resolve_github_token(
    config: Mapping[str, Any], thread_id: str
) -> tuple[str, str | None]:
    """Resolve ForgeFlow runs through a repo-scoped read-only App token."""
    cfg = RunConfig.from_config(config)
    if cfg.source != "forgeflow":
        return await _UPSTREAM_RESOLVE(config, thread_id)
    if cfg.repo is None or not cfg.repo.name:
        raise RuntimeError(f"GitHub auth failed for thread {thread_id}: missing repository")
    token, expires_at = await get_github_app_installation_token_with_expiry(
        repositories=[cfg.repo.name],
        permissions={"contents": "read", "pull_requests": "read"},
        log_errors=False,
    )
    if not token:
        raise RuntimeError(f"GitHub auth failed for thread {thread_id}: App token unavailable")
    return token, expires_at


def install_forgeflow_github_auth() -> None:
    """Install the bridge before upstream agent modules bind the resolver."""
    current = token_module.resolve_github_token
    if current is resolve_github_token:
        return
    if current is not _UPSTREAM_RESOLVE:
        raise RuntimeError("upstream GitHub token resolver was already replaced")
    token_module.resolve_github_token = resolve_github_token
