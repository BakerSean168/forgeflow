"""Adapter registry for complete external coding agents behind ForgeFlow ACP routes."""

from __future__ import annotations

from collections.abc import Callable, Mapping

from forgeflow.external_agents.execution import ExternalAgentExecutionPort
from forgeflow.routing import RouteDefinition
from openswe_ext.antigravity_execution import AntigravityExternalAgentExecution
from openswe_ext.codebuddy_execution import CodeBuddyExternalAgentExecution


class ExternalAgentAdapterError(RuntimeError):
    pass


AdapterFactory = Callable[..., ExternalAgentExecutionPort]

_ADAPTER_FACTORIES: dict[str, AdapterFactory] = {
    "antigravity": AntigravityExternalAgentExecution,
    "codebuddy": CodeBuddyExternalAgentExecution,
}


def build_external_agent_execution(
    route: RouteDefinition,
    *,
    allowed_projects: frozenset[str],
    env: Mapping[str, str] | None = None,
) -> ExternalAgentExecutionPort:
    if route.runtime != "EXTERNAL_ACP" or not route.adapter:
        raise ExternalAgentAdapterError("EXTERNAL_AGENT_ROUTE_ADAPTER_REQUIRED")
    factory = _ADAPTER_FACTORIES.get(route.adapter.casefold())
    if factory is None:
        raise ExternalAgentAdapterError(f"EXTERNAL_AGENT_ADAPTER_UNSUPPORTED:{route.adapter}")
    return factory(env=dict(env) if env is not None else None, allowed_projects=allowed_projects)


def supported_external_agent_adapters() -> tuple[str, ...]:
    return tuple(sorted(_ADAPTER_FACTORIES))


__all__ = [
    "ExternalAgentAdapterError",
    "build_external_agent_execution",
    "supported_external_agent_adapters",
]
