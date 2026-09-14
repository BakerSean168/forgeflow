"""The single ForgeFlow production import boundary into Open SWE internals.

Open SWE moves quickly. Keep every direct ``agent.*`` dependency here so an
upstream bump has one compatibility surface instead of leaking through policy code.
"""

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any
from uuid import NAMESPACE_URL, uuid5

import httpx2

from openswe_ext.context_policy import install_agent_context_policy
from openswe_ext.model_policy import (
    implementation_model_policy,
    install_forgeflow_model_policy,
    reasoning_model_ids,
    review_model_id,
)
from openswe_ext.provider_fallback import install_provider_fallback_overlay
from openswe_ext.reviewer_fallback import install_reviewer_fallback_overlay

install_provider_fallback_overlay()
install_forgeflow_model_policy()
install_agent_context_policy()
install_reviewer_fallback_overlay()

from agent.dashboard.team_settings import get_team_default_model_pair
from agent.dispatch import dispatch_agent_run
from agent.github.app import (
    GITHUB_APP_ID,
    GITHUB_APP_INSTALLATION_ID,
    GITHUB_APP_PRIVATE_KEY,
    get_github_app_installation_id_for_repo,
    get_github_app_installation_token,
)
from agent.github.ci import list_check_runs, list_commit_statuses
from agent.github.pull_request_checks import get_pull_request_check_states
from agent.github.webhook import trigger_pr_review_from_ref
from agent.graphs.agent import traced_agent
from agent.graphs.analyzer import traced_analyzer
from agent.graphs.chat import traced_chat_agent
from agent.graphs.reviewer import traced_reviewer_agent
from agent.graphs.scheduler import get_scheduler
from agent.middleware.model_fallback import MODEL_OUTAGE_MESSAGE
from agent.review.findings import coerce_findings, list_findings
from agent.run_config import RunConfig
from agent.slack.client import GitHubPrRef, parse_github_pr_url
from agent.thread_ids import reviewer_thread_id
from agent.utils.errors import LAST_MODEL_ERROR_KEY
from agent.webapp import app as open_swe_webapp
from agent.webhooks.common import fetch_github_pr_metadata
from langgraph_sdk.errors import NotFoundError

GRAPH_ENTRIES: Mapping[str, Callable[..., Any]] = {
    "agent": traced_agent,
    "reviewer": traced_reviewer_agent,
    "analyzer": traced_analyzer,
    "chat": traced_chat_agent,
    "scheduler": get_scheduler,
}

DispatchFn = Callable[..., Awaitable[Mapping[str, Any]]]
FindingsReader = Callable[[str], Awaitable[list[dict[str, Any]]]]
ReviewTrigger = Callable[..., Awaitable[dict[str, Any]]]
ReviewBaselineResolver = Callable[[str, str, str, str, str], Awaitable[str]]


class OpenSweAdapterError(RuntimeError):
    pass


class ReviewerSupersededError(OpenSweAdapterError):
    def __init__(self, current_run_id: str | None) -> None:
        super().__init__("official reviewer run was superseded")
        self.current_run_id = current_run_id


@dataclass(frozen=True, slots=True)
class ChildRunSnapshot:
    thread_id: str
    run_id: str
    status: str
    failure_code: str | None = None
    failure_class: str | None = None


@dataclass(frozen=True, slots=True)
class ThreadSnapshot:
    thread_id: str
    status: str
    metadata: dict[str, Any]




def configured_github_installation_id() -> int | None:
    raw = str(GITHUB_APP_INSTALLATION_ID or "").strip()
    if not raw.isdigit() or int(raw) <= 0:
        return None
    return int(raw)

def github_app_configured() -> bool:
    """Return only configuration readiness; never expose App credentials."""
    installation = str(GITHUB_APP_INSTALLATION_ID or "").strip()
    return bool(
        str(GITHUB_APP_ID or "").strip()
        and str(GITHUB_APP_PRIVATE_KEY or "").strip()
        and installation.isdigit()
        and int(installation) > 0
    )

def implementation_thread_id(policy_thread_id: str) -> str:
    """Derive one stable implementation thread per ForgeFlow policy thread."""
    if not policy_thread_id:
        raise ValueError("policy_thread_id is required")
    return str(uuid5(NAMESPACE_URL, f"forgeflow:implementation:{policy_thread_id}"))


def implementation_config(
    *,
    thread_id: str,
    repo_owner: str,
    repo_name: str,
    workspace_path: str | None = None,
    model_id: str | None = None,
    effort: str | None = None,
    draft_prs: bool = True,
) -> dict[str, Any]:
    """Build the minimal Open SWE configurable contract for implementation/repair."""
    default_model_id, default_effort, _fallback = implementation_model_policy()
    config = {
        "thread_id": thread_id,
        "source": "desktop" if workspace_path else "forgeflow",
        "repo": {"owner": repo_owner, "name": repo_name},
        "agent_model_id": model_id or default_model_id,
        "agent_effort": effort or default_effort,
        "draft_prs": draft_prs,
    }
    if workspace_path:
        config["local_project_path"] = workspace_path
    # Fail locally if upstream renamed a field we rely on.
    parsed = RunConfig.parse(config)
    return parsed.dump()


def reviewer_config(
    *,
    reviewer_thread_id: str,
    model_id: str | None = None,
    effort: str = "medium",
    subagent_model_id: str | None = None,
    subagent_effort: str = "medium",
) -> dict[str, Any]:
    """Build the model overrides ForgeFlow expects the official reviewer to inherit."""
    selected_model_id = model_id or review_model_id()
    selected_subagent_model_id = subagent_model_id or selected_model_id
    config = {
        "reviewer_thread_id": reviewer_thread_id,
        "reviewer_model_id": selected_model_id,
        "reviewer_reasoning_effort": effort,
        "reviewer_subagent_model_id": selected_subagent_model_id,
        "reviewer_subagent_reasoning_effort": subagent_effort,
    }
    return RunConfig.parse(config).dump()


_OPENSWE_PROVIDER_FAILURE_CODES = frozenset(
    {
        "provider_rate_limited",
        "provider_overloaded",
        "provider_unavailable",
        "provider_timeout",
        "provider_quota_exhausted",
        "model_unavailable",
    }
)


def _provider_failure_for_run(
    metadata: Any, run_id: str, *, terminal_error_type: str | None = None
) -> str | None:
    if not isinstance(metadata, Mapping):
        return None
    raw = metadata.get(LAST_MODEL_ERROR_KEY)
    if not isinstance(raw, Mapping) or raw.get("run_id") != run_id:
        return None
    if terminal_error_type is not None and raw.get("error_type") != terminal_error_type:
        return None
    code = raw.get("code")
    if not isinstance(code, str) or code not in _OPENSWE_PROVIDER_FAILURE_CODES:
        return None
    return code


def _terminal_error_type(joined: Any) -> str | None:
    if not isinstance(joined, Mapping):
        return None
    error = joined.get("__error__")
    if not isinstance(error, Mapping):
        return None
    error_type = error.get("error")
    return error_type if isinstance(error_type, str) and error_type else None


def _message_text(message: Any) -> str | None:
    if not isinstance(message, Mapping) or message.get("type") != "ai":
        return None
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return None
    parts: list[str] = []
    for block in content:
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, Mapping):
            text = block.get("text")
            if isinstance(text, str):
                parts.append(text)
    return "".join(parts).strip() if parts else None


def _state_ends_with_model_outage(state: Any) -> bool:
    if not isinstance(state, Mapping):
        return False
    values = state.get("values")
    if not isinstance(values, Mapping):
        return False
    messages = values.get("messages")
    if not isinstance(messages, list):
        return False
    for message in reversed(messages):
        text = _message_text(message)
        if text is not None:
            return text == MODEL_OUTAGE_MESSAGE
    return False


class OpenSweChildRuntime:
    """Thin child-thread/run adapter; LangGraph remains the runtime owner."""

    def __init__(self, client: Any, *, dispatch: DispatchFn = dispatch_agent_run) -> None:
        self._client = client
        self._dispatch = dispatch

    async def ensure_implementation_thread(
        self,
        *,
        policy_thread_id: str,
        repo_owner: str,
        repo_name: str,
        objective: str,
    ) -> str:
        thread_id = implementation_thread_id(policy_thread_id)
        await self._client.threads.create(
            thread_id=thread_id,
            if_exists="do_nothing",
            metadata={
                "agent_kind": "agent",
                "source": "forgeflow",
                "origin": "forgeflow",
                "thread_category": "interactive",
                "repo": {"owner": repo_owner, "name": repo_name},
                "repo_owner": repo_owner,
                "repo_name": repo_name,
                "title": objective[:80],
            },
        )
        return thread_id

    async def dispatch_implementation(
        self,
        *,
        thread_id: str,
        objective: str,
        repo_owner: str,
        repo_name: str,
        operation_key: str,
        workspace_path: str | None = None,
    ) -> str:
        run = await self._dispatch(
            thread_id,
            objective,
            implementation_config(
                thread_id=thread_id,
                repo_owner=repo_owner,
                repo_name=repo_name,
                workspace_path=workspace_path,
            ),
            source="forgeflow",
            metadata={"kind": "forgeflow_child", "forgeflow_operation_key": operation_key},
            client=self._client,
            multitask_strategy="enqueue",
        )
        run_id = run.get("run_id") if isinstance(run, Mapping) else None
        if not isinstance(run_id, str) or not run_id:
            raise OpenSweAdapterError("Open SWE dispatch returned no run_id")
        return run_id

    async def dispatch_repair(
        self,
        *,
        thread_id: str,
        prompt: str,
        repo_owner: str,
        repo_name: str,
        operation_key: str,
        workspace_path: str | None = None,
    ) -> str:
        return await self.dispatch_implementation(
            thread_id=thread_id,
            objective=prompt,
            repo_owner=repo_owner,
            repo_name=repo_name,
            operation_key=operation_key,
            workspace_path=workspace_path,
        )

    async def find_run_by_operation(self, *, thread_id: str, operation_key: str) -> str | None:
        runs = await self._client.runs.list(thread_id, limit=100)
        matches: list[str] = []
        for run in runs:
            if not isinstance(run, Mapping):
                continue
            metadata = run.get("metadata")
            if not isinstance(metadata, Mapping):
                continue
            if metadata.get("forgeflow_operation_key") != operation_key:
                continue
            run_id = run.get("run_id")
            if isinstance(run_id, str) and run_id:
                matches.append(run_id)
        unique = list(dict.fromkeys(matches))
        if len(unique) > 1:
            raise OpenSweAdapterError(f"duplicate child runs for operation {operation_key!r}: {unique!r}")
        return unique[0] if unique else None

    async def read_run(self, *, thread_id: str, run_id: str) -> ChildRunSnapshot:
        run = await self._client.runs.get(thread_id, run_id)
        status = run.get("status") if isinstance(run, Mapping) else None
        if not isinstance(status, str):
            raise OpenSweAdapterError("Open SWE run has no status")
        if status not in {"success", "error"}:
            return ChildRunSnapshot(thread_id=thread_id, run_id=run_id, status=status)

        thread = await self._client.threads.get(thread_id)
        metadata = thread.get("metadata") if isinstance(thread, Mapping) else None
        provider_failure = _provider_failure_for_run(metadata, run_id)
        if provider_failure is not None and status == "error":
            joined = await self._client.runs.join(thread_id, run_id)
            terminal_error_type = _terminal_error_type(joined)
            provider_failure = _provider_failure_for_run(
                metadata, run_id, terminal_error_type=terminal_error_type
            )
            if provider_failure is not None:
                return ChildRunSnapshot(
                    thread_id=thread_id,
                    run_id=run_id,
                    status="error",
                    failure_code="OPENSWE_PROVIDER_UNAVAILABLE",
                )
        if provider_failure is not None and status == "success":
            state = await self._client.threads.get_state(thread_id)
            if _state_ends_with_model_outage(state):
                return ChildRunSnapshot(
                    thread_id=thread_id,
                    run_id=run_id,
                    status="error",
                    failure_code="OPENSWE_PROVIDER_UNAVAILABLE",
                )
        return ChildRunSnapshot(thread_id=thread_id, run_id=run_id, status=status)

    async def read_thread(self, thread_id: str) -> ThreadSnapshot:
        thread = await self._client.threads.get(thread_id)
        if not isinstance(thread, Mapping):
            raise OpenSweAdapterError("Open SWE thread payload is not a mapping")
        metadata = thread.get("metadata")
        status = thread.get("status")
        return ThreadSnapshot(
            thread_id=thread_id,
            status=status if isinstance(status, str) else "unknown",
            metadata=dict(metadata) if isinstance(metadata, Mapping) else {},
        )


__all__ = [
    "GRAPH_ENTRIES",
    "ChildRunSnapshot",
    "GitHubPrRef",
    "OpenSweAdapterError",
    "OpenSweChildRuntime",
    "RunConfig",
    "ThreadSnapshot",
    "configured_github_installation_id",
    "dispatch_agent_run",
    "fetch_github_pr_metadata",
    "get_github_app_installation_id_for_repo",
    "get_github_app_installation_token",
    "get_pull_request_check_states",
    "get_team_default_model_pair",
    "github_app_configured",
    "implementation_config",
    "implementation_thread_id",
    "list_check_runs",
    "list_commit_statuses",
    "list_findings",
    "open_swe_webapp",
    "parse_github_pr_url",
    "reviewer_config",
    "trigger_pr_review_from_ref",
]


@dataclass(frozen=True, slots=True)
class ReviewerSnapshot:
    thread_id: str
    run_id: str
    run_status: str
    last_reviewed_sha: str
    findings: tuple[dict[str, Any], ...]


async def _github_compare(
    owner: str, repo: str, base_sha: str, head_sha: str, token: str
) -> Mapping[str, Any] | None:
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    try:
        async with httpx2.AsyncClient(timeout=15) as client:
            response = await client.get(
                f"https://api.github.com/repos/{owner}/{repo}/compare/{base_sha}...{head_sha}",
                headers=headers,
            )
        if response.status_code != 200:
            return None
        payload = response.json()
    except (httpx2.RequestError, ValueError):
        return None
    return payload if isinstance(payload, Mapping) else None


async def _github_review_diff_baseline(
    owner: str, repo: str, base_sha: str, previous_sha: str, head_sha: str
) -> str:
    """Resolve a safe diff baseline while preserving re-review finding context.

    A linear push can review only the delta since the prior reviewed SHA. A
    force-push/rebase must keep re-review semantics so historical findings are
    reconciled, but the old SHA is not a valid incremental range. In that case
    reset only the *diff* baseline to GitHub's authoritative merge-base for the
    current PR. If GitHub cannot prove that baseline, fail closed rather than
    silently dropping prior finding evidence.
    """
    installation_id = await get_github_app_installation_id_for_repo(owner, repo)
    if installation_id is None:
        raise OpenSweAdapterError("REVIEW_DIFF_BASELINE_UNAVAILABLE")
    token = await get_github_app_installation_token(
        installation_id=installation_id,
        repositories=[repo],
        permissions={"contents": "read"},
        log_errors=False,
    )
    if not token:
        raise OpenSweAdapterError("REVIEW_DIFF_BASELINE_UNAVAILABLE")

    if previous_sha != head_sha:
        previous_compare = await _github_compare(owner, repo, previous_sha, head_sha, token)
        if previous_compare is not None and previous_compare.get("status") == "ahead":
            return previous_sha

    current_compare = await _github_compare(owner, repo, base_sha, head_sha, token)
    if current_compare is None:
        raise OpenSweAdapterError("REVIEW_DIFF_BASELINE_UNAVAILABLE")
    merge_base = current_compare.get("merge_base_commit")
    merge_base_sha = merge_base.get("sha") if isinstance(merge_base, Mapping) else None
    if not isinstance(merge_base_sha, str) or len(merge_base_sha) != 40:
        raise OpenSweAdapterError("REVIEW_DIFF_BASELINE_INVALID")
    return merge_base_sha


class OpenSweReviewerRuntime:
    """Thin dispatcher for the official Open SWE reviewer graph."""

    def __init__(
        self,
        client: Any,
        *,
        dispatch: DispatchFn = dispatch_agent_run,
        findings_reader: FindingsReader | None = None,
        baseline_resolver: ReviewBaselineResolver = _github_review_diff_baseline,
    ) -> None:
        self._client = client
        self._dispatch = dispatch
        self._findings_reader = findings_reader or self._read_findings_from_client
        self._baseline_resolver = baseline_resolver

    async def _read_findings_from_client(self, thread_id: str) -> list[dict[str, Any]]:
        thread = await self._client.threads.get(thread_id)
        metadata = thread.get("metadata") if isinstance(thread, Mapping) else None
        metadata = metadata if isinstance(metadata, Mapping) else {}
        return [dict(item) for item in coerce_findings(metadata.get("findings"))]

    async def find_current_review(
        self, *, pr_url: str, expected_head_sha: str, operation_key: str
    ) -> tuple[str, str] | None:
        pr_ref = parse_github_pr_url(pr_url)
        if pr_ref is None:
            raise OpenSweAdapterError("invalid GitHub PR URL")
        thread_id = reviewer_thread_id(pr_ref.owner, pr_ref.repo, pr_ref.number)
        try:
            thread = await self._client.threads.get(thread_id)
        except NotFoundError:
            return None
        metadata = thread.get("metadata") if isinstance(thread, Mapping) else None
        if not isinstance(metadata, Mapping) or metadata.get("head_sha") != expected_head_sha:
            return None
        runs = await self._client.runs.list(thread_id, limit=100)
        matches: list[str] = []
        for run in runs:
            if not isinstance(run, Mapping):
                continue
            run_metadata = run.get("metadata")
            if not isinstance(run_metadata, Mapping):
                continue
            if run_metadata.get("forgeflow_review_operation_key") != operation_key:
                continue
            run_id = run.get("run_id")
            if isinstance(run_id, str) and run_id:
                matches.append(run_id)
        unique = list(dict.fromkeys(matches))
        if len(unique) > 1:
            raise OpenSweAdapterError(
                f"duplicate reviewer runs for operation {operation_key!r}: {unique!r}"
            )
        if not unique:
            return None
        run_id = unique[0]
        current = metadata.get("current_reviewer_run_id")
        if current is None:
            # Crash recovery: the durable run exists but the thread pointer write did not.
            # Repair exactly that pointer and return; this is the single upstream mutation
            # performed by this reconcile step.
            await self._client.threads.update(
                thread_id=thread_id, metadata={"current_reviewer_run_id": run_id}
            )
            return thread_id, run_id
        if current != run_id:
            raise ReviewerSupersededError(current if isinstance(current, str) else None)
        return thread_id, run_id

    async def trigger_review(
        self,
        *,
        owner: str,
        repo: str,
        pr_number: int,
        pr_url: str,
        head_sha: str,
        head_ref: str,
        base_sha: str,
        base_ref: str,
        operation_key: str,
    ) -> tuple[str, str]:
        pr_ref = parse_github_pr_url(pr_url)
        if (
            pr_ref is None
            or pr_ref.owner.casefold() != owner.casefold()
            or pr_ref.repo.casefold() != repo.casefold()
            or pr_ref.number != pr_number
        ):
            raise OpenSweAdapterError("review PR identity mismatch")
        thread_id = reviewer_thread_id(owner, repo, pr_number)
        await self._client.threads.create(
            thread_id=thread_id, if_exists="do_nothing", metadata={"kind": "reviewer"}
        )
        existing = await self._client.threads.get(thread_id)
        existing_meta = existing.get("metadata") if isinstance(existing, Mapping) else None
        existing_meta = existing_meta if isinstance(existing_meta, Mapping) else {}
        await self._client.threads.update(
            thread_id=thread_id,
            metadata={
                "kind": "reviewer",
                "pr": {
                    "owner": owner,
                    "name": repo,
                    "number": pr_number,
                    "url": pr_url,
                    "head_ref": head_ref,
                    "base_ref": base_ref,
                },
                "watch": True,
                "head_sha": head_sha,
            },
        )
        previous_reviewed_sha = existing_meta.get("last_reviewed_sha")
        review_diff_baseline: str | None = None
        if isinstance(previous_reviewed_sha, str) and previous_reviewed_sha:
            review_diff_baseline = await self._baseline_resolver(
                owner, repo, base_sha, previous_reviewed_sha, head_sha
            )
        is_re_review = review_diff_baseline is not None

        # The reviewer primary honors this project's validated REASONING route
        # preference. The fallback overlay resolves the next eligible global
        # route, so global fallback semantics are unchanged for other projects.
        reasoning_primary, _reasoning_fallback = reasoning_model_ids(owner=owner, repo=repo)
        configurable = reviewer_config(reviewer_thread_id=thread_id, model_id=reasoning_primary)
        configurable.update(
            {
                "thread_id": thread_id,
                "source": "forgeflow",
                "repo": {"owner": owner, "name": repo},
                "pr_number": pr_number,
                "pr_url": pr_url,
                "head_sha": head_sha,
                "base_sha": base_sha,
                "branch_name": head_ref,
                "review_requested": True,
                "re_review": is_re_review,
                "last_reviewed_sha": review_diff_baseline,
            }
        )
        review_request = (
            "Please re-review this GitHub pull request against the complete current PR diff. "
            "Reconcile every existing finding before publishing only concrete current-head findings."
            if is_re_review and review_diff_baseline != previous_reviewed_sha
            else "Please review this GitHub pull request. Submit only concrete findings."
        )
        run = await self._dispatch(
            thread_id,
            review_request,
            configurable,
            source="forgeflow",
            assistant_id="reviewer",
            metadata={
                "kind": "forgeflow_review",
                "head_sha": head_sha,
                "forgeflow_review_operation_key": operation_key,
            },
            client=self._client,
            multitask_strategy="interrupt",
        )
        run_id = run.get("run_id") if isinstance(run, Mapping) else None
        if not isinstance(run_id, str) or not run_id:
            raise OpenSweAdapterError("official reviewer dispatch returned no run_id")
        # This write may fail after the run already exists. Replay is safe because
        # the run itself carries the stable operation key above.
        await self._client.threads.update(
            thread_id=thread_id, metadata={"current_reviewer_run_id": run_id}
        )
        return thread_id, run_id

    async def read_review(self, *, thread_id: str, run_id: str) -> ReviewerSnapshot:
        before = await self._client.threads.get(thread_id)
        before_meta = before.get("metadata") if isinstance(before, Mapping) else None
        before_meta = before_meta if isinstance(before_meta, Mapping) else {}
        before_current = before_meta.get("current_reviewer_run_id")
        if before_current != run_id:
            raise ReviewerSupersededError(before_current if isinstance(before_current, str) else None)

        run = await self._client.runs.get(thread_id, run_id)
        status = run.get("status") if isinstance(run, Mapping) else None
        findings = await self._findings_reader(thread_id)

        after = await self._client.threads.get(thread_id)
        after_meta = after.get("metadata") if isinstance(after, Mapping) else None
        after_meta = after_meta if isinstance(after_meta, Mapping) else {}
        after_current = after_meta.get("current_reviewer_run_id")
        if after_current != run_id:
            raise ReviewerSupersededError(after_current if isinstance(after_current, str) else None)
        last_reviewed_sha = after_meta.get("last_reviewed_sha")
        return ReviewerSnapshot(
            thread_id=thread_id,
            run_id=run_id,
            run_status=status if isinstance(status, str) else "unknown",
            last_reviewed_sha=last_reviewed_sha if isinstance(last_reviewed_sha, str) else "",
            findings=tuple(dict(item) for item in findings),
        )

__all__ += ["OpenSweReviewerRuntime", "ReviewerSnapshot", "ReviewerSupersededError", "get_team_default_model_pair"]
