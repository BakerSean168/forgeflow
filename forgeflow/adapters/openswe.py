"""The single ForgeFlow production import boundary into Open SWE internals.

Open SWE moves quickly. Keep every direct ``agent.*`` dependency here so an
upstream bump has one compatibility surface instead of leaking through policy code.
"""

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from agent.dispatch import dispatch_agent_run
from agent.github.app import get_github_app_installation_token
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


def implementation_config(
    *,
    thread_id: str,
    model_id: str = "openai:gpt-5.6-luna",
    effort: str = "xhigh",
    draft_prs: bool = True,
) -> dict[str, Any]:
    """Build the minimal Open SWE configurable contract for implementation/repair."""
    config = {
        "thread_id": thread_id,
        "source": "forgeflow",
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


__all__ = [
    "GRAPH_ENTRIES",
    "GitHubPrRef",
    "RunConfig",
    "dispatch_agent_run",
    "fetch_github_pr_metadata",
    "get_github_app_installation_token",
    "get_pull_request_check_states",
    "implementation_config",
    "list_findings",
    "open_swe_webapp",
    "parse_github_pr_url",
    "reviewer_config",
    "trigger_pr_review_from_ref",
]
