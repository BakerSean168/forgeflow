"""Thin graph wrappers that register self-hosted Open SWE runtime extensions."""

from __future__ import annotations

from agent.sandboxes.providers.registry import SANDBOX_FACTORIES

from openswe_ext.github_auth import install_forgeflow_github_auth

_DOCKER_FACTORY = ("openswe_ext.docker_sandbox", "create_docker_sandbox")


def register_runtime_extensions() -> None:
    existing = SANDBOX_FACTORIES.get("docker")
    if existing is not None and existing != _DOCKER_FACTORY:
        raise RuntimeError(f"upstream already owns a different docker sandbox provider: {existing!r}")
    SANDBOX_FACTORIES["docker"] = _DOCKER_FACTORY


register_runtime_extensions()
install_forgeflow_github_auth()

# Import upstream graphs only after provider registration. These are aliases, not forks.
from agent.graphs.agent import traced_agent as agent_graph
from agent.graphs.analyzer import traced_analyzer as analyzer_graph
from agent.graphs.chat import traced_chat_agent as chat_graph
from agent.graphs.reviewer import traced_reviewer_agent as reviewer_graph
from agent.graphs.scheduler import get_scheduler as scheduler_graph

__all__ = [
    "agent_graph",
    "analyzer_graph",
    "chat_graph",
    "register_runtime_extensions",
    "reviewer_graph",
    "scheduler_graph",
]
