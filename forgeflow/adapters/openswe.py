"""The single ForgeFlow production import boundary into Open SWE internals.

Open SWE moves quickly. Keep every direct ``agent.*`` dependency here so an
upstream bump has one compatibility surface instead of leaking through policy code.
"""

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from agent.dashboard.team_settings import get_team_default_model_pair
from agent.dispatch import dispatch_agent_run
from agent.github.app import get_github_app_installation_token
from agent.github.ci import list_check_runs, list_commit_statuses
from agent.github.pull_request_checks import get_pull_request_check_states
from agent.github.webhook import trigger_pr_review_from_ref
from agent.graphs.agent import traced_agent
from agent.graphs.analyzer import traced_analyzer
from agent.graphs.chat import traced_chat_agent
from agent.graphs.reviewer import traced_reviewer_agent
from agent.graphs.scheduler import get_scheduler
from agent.review.findings import list_findings
from agent.run_config import RunConfig
from agent.slack.client import GitHubPrRef, parse_github_pr_url
from agent.webapp import app as open_swe_webapp
from agent.webhooks.common import fetch_github_pr_metadata

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


class OpenSweAdapterError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ChildRunSnapshot:
    thread_id: str
    run_id: str
    status: str


@dataclass(frozen=True, slots=True)
class ThreadSnapshot:
    thread_id: str
    status: str
    metadata: dict[str, Any]


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
    model_id: str = "openai:gpt-5.6-luna",
    effort: str = "xhigh",
    draft_prs: bool = True,
) -> dict[str, Any]:
    """Build the minimal Open SWE configurable contract for implementation/repair."""
    config = {
        "thread_id": thread_id,
        "source": "forgeflow",
        "repo": {"owner": repo_owner, "name": repo_name},
        "agent_model_id": model_id,
        "agent_effort": effort,
        "draft_prs": draft_prs,
    }
    # Fail locally if upstream renamed a field we rely on.
    parsed = RunConfig.parse(config)
    return parsed.dump()


def reviewer_config(
    *,
    reviewer_thread_id: str,
    model_id: str = "openai:gpt-5.6-sol",
    effort: str = "medium",
    subagent_model_id: str = "openai:gpt-5.6-sol",
    subagent_effort: str = "medium",
) -> dict[str, Any]:
    """Build the model overrides ForgeFlow expects the official reviewer to inherit."""
    config = {
        "reviewer_thread_id": reviewer_thread_id,
        "reviewer_model_id": model_id,
        "reviewer_reasoning_effort": effort,
        "reviewer_subagent_model_id": subagent_model_id,
        "reviewer_subagent_reasoning_effort": subagent_effort,
    }
    return RunConfig.parse(config).dump()


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
    ) -> str:
        run = await self._dispatch(
            thread_id,
            objective,
            implementation_config(
                thread_id=thread_id,
                repo_owner=repo_owner,
                repo_name=repo_name,
            ),
            source="forgeflow",
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
    ) -> str:
        return await self.dispatch_implementation(
            thread_id=thread_id,
            objective=prompt,
            repo_owner=repo_owner,
            repo_name=repo_name,
        )

    async def read_run(self, *, thread_id: str, run_id: str) -> ChildRunSnapshot:
        run = await self._client.runs.get(thread_id, run_id)
        status = run.get("status") if isinstance(run, Mapping) else None
        if not isinstance(status, str):
            raise OpenSweAdapterError("Open SWE run has no status")
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
    "dispatch_agent_run",
    "fetch_github_pr_metadata",
    "get_github_app_installation_token",
    "get_pull_request_check_states",
    "get_team_default_model_pair",
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


class OpenSweReviewerRuntime:
    """Official Open SWE reviewer trigger/read adapter; no custom reviewer graph."""

    def __init__(
        self,
        client: Any,
        *,
        trigger: ReviewTrigger = trigger_pr_review_from_ref,
        findings_reader: FindingsReader = list_findings,
        model_pair_reader: Callable[..., Awaitable[Any]] = get_team_default_model_pair,
    ) -> None:
        self._client = client
        self._trigger = trigger
        self._findings_reader = findings_reader
        self._model_pair_reader = model_pair_reader

    async def assert_model_policy(self) -> None:
        main, subagent = await self._model_pair_reader("reviewer")
        expected = ("openai:gpt-5.6-sol", "medium")
        if tuple(main) != expected or tuple(subagent) != expected:
            raise OpenSweAdapterError(
                f"official reviewer model policy mismatch: main={main!r} subagent={subagent!r}"
            )

    async def trigger_review(self, pr_url: str) -> tuple[str, str]:
        await self.assert_model_policy()
        pr_ref = parse_github_pr_url(pr_url)
        if pr_ref is None:
            raise OpenSweAdapterError("invalid GitHub PR URL")
        result = await self._trigger(pr_ref, source="forgeflow")
        if not result.get("success"):
            raise OpenSweAdapterError(str(result.get("error") or "official reviewer trigger failed"))
        thread_id = result.get("thread_id")
        if not isinstance(thread_id, str) or not thread_id:
            raise OpenSweAdapterError("official reviewer trigger returned no thread_id")
        thread = await self._client.threads.get(thread_id)
        metadata = thread.get("metadata") if isinstance(thread, Mapping) else None
        run_id = metadata.get("current_reviewer_run_id") if isinstance(metadata, Mapping) else None
        if not isinstance(run_id, str) or not run_id:
            raise OpenSweAdapterError("reviewer thread has no current_reviewer_run_id")
        return thread_id, run_id

    async def read_review(self, *, thread_id: str, run_id: str) -> ReviewerSnapshot:
        thread = await self._client.threads.get(thread_id)
        metadata = thread.get("metadata") if isinstance(thread, Mapping) else None
        metadata = metadata if isinstance(metadata, Mapping) else {}
        run = await self._client.runs.get(thread_id, run_id)
        status = run.get("status") if isinstance(run, Mapping) else None
        findings = await self._findings_reader(thread_id)
        last_reviewed_sha = metadata.get("last_reviewed_sha")
        return ReviewerSnapshot(
            thread_id=thread_id,
            run_id=run_id,
            run_status=status if isinstance(status, str) else "unknown",
            last_reviewed_sha=last_reviewed_sha if isinstance(last_reviewed_sha, str) else "",
            findings=tuple(dict(item) for item in findings),
        )

__all__ += ["OpenSweReviewerRuntime", "ReviewerSnapshot", "get_team_default_model_pair"]
