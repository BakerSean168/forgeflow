"""ForgeFlow Policy V1 LangGraph entrypoint."""

from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import RunnableConfig

from forgeflow.reconcile import (
    DefaultPolicyServices,
    PolicyServices,
    ReconcileError,
    reconcile_once,
)
from forgeflow.state import ForgeFlowInput, ForgeFlowState


def build_forgeflow_graph(
    *,
    services: PolicyServices | None = None,
    config: RunnableConfig | None = None,
):
    """Build the graph with optional fake services for deterministic tests."""

    async def reconcile_node(state: ForgeFlowState, config: RunnableConfig) -> ForgeFlowState:
        configurable = config.get("configurable") or {}
        policy_thread_id = configurable.get("thread_id")
        if not isinstance(policy_thread_id, str) or not policy_thread_id:
            raise ReconcileError("ForgeFlow graph requires configurable.thread_id")
        resolved_services = services or DefaultPolicyServices()
        return await reconcile_once(
            state,
            policy_thread_id=policy_thread_id,
            services=resolved_services,
        )

    builder = StateGraph(ForgeFlowState, input_schema=ForgeFlowInput)
    builder.add_node("reconcile", reconcile_node)
    builder.add_edge(START, "reconcile")
    builder.add_edge("reconcile", END)
    return builder.compile().with_config(config or {})


def get_forgeflow_graph(config: RunnableConfig | None = None):
    """Production graph factory accepted by LangGraph Server."""
    return build_forgeflow_graph(config=config)
