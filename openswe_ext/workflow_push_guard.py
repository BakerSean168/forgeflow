"""Compatibility fix for Open SWE workflow-push approval on non-default bases.

Pinned Open SWE treats a new remote task branch as if it were based on
``origin/HEAD``.  That is safe for the common main-based case, but it produces a
false workflow-change approval when a task intentionally tracks another base
branch which already changed ``.github/workflows``.

ForgeFlow preserves the upstream approval machinery and only changes the
fallback ref used by that machinery: if the current task branch has a safe
``origin/*`` upstream, expose that ref as the effective origin HEAD while the
upstream guard computes its diff.  Real workflow changes relative to the task's
tracked base are therefore still approval-gated.
"""

from __future__ import annotations

import shlex
from typing import Any

import agent.middleware.workflow_push_guard as upstream
from deepagents.backends.protocol import ExecuteResponse

_UPSTREAM_CHANGE_FOR_PUSH = upstream._workflow_change_for_push


class _OriginHeadOverrideBackend:
    """Delegate a sandbox backend while overriding one trusted git query."""

    def __init__(self, backend: Any, tracked_upstream: str) -> None:
        self._backend = backend
        self._tracked_upstream = tracked_upstream

    async def aexecute(self, command: str, **kwargs: Any) -> Any:
        if command.rstrip().endswith("symbolic-ref --short refs/remotes/origin/HEAD"):
            return ExecuteResponse(self._tracked_upstream, 0, False)
        return await self._backend.aexecute(command, **kwargs)


async def _tracked_origin_upstream(
    backend: Any, parsed: upstream.ParsedGitPush
) -> str | None:
    """Return the current branch's safe origin tracking ref, if it has one."""
    root_result = await upstream._run_git(backend, parsed.repo_dir, "rev-parse --show-toplevel")
    if not root_result.ok:
        return None
    root = upstream._first_line(root_result.output)
    if not root:
        return None

    result = await upstream._run_git(
        backend,
        root,
        f"rev-parse --abbrev-ref --symbolic-full-name {shlex.quote('@{upstream}')}",
    )
    if not result.ok:
        return None
    tracked = upstream._first_line(result.output)
    prefix = f"{parsed.remote}/"
    if not tracked.startswith(prefix) or tracked == f"{parsed.remote}/HEAD":
        return None
    if not upstream._safe_ref(tracked, allow_head=False):
        return None
    return tracked


async def workflow_change_for_push(
    backend: Any, parsed: upstream.ParsedGitPush
) -> upstream.WorkflowPushChange | None:
    """Run upstream approval detection against the task branch's tracked base."""
    tracked = await _tracked_origin_upstream(backend, parsed)
    if tracked is None:
        return await _UPSTREAM_CHANGE_FOR_PUSH(backend, parsed)
    return await _UPSTREAM_CHANGE_FOR_PUSH(_OriginHeadOverrideBackend(backend, tracked), parsed)


def install_workflow_push_guard_base_fix() -> None:
    """Install the narrow compatibility fix once, failing closed on collisions."""
    current = upstream._workflow_change_for_push
    if current is workflow_change_for_push:
        return
    if current is not _UPSTREAM_CHANGE_FOR_PUSH:
        raise RuntimeError("Open SWE workflow push guard was already replaced")
    upstream._workflow_change_for_push = workflow_change_for_push
