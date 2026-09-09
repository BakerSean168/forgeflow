"""Minimal ForgeFlow policy graph scaffold.

The real policy transitions are added in FFP-004. This graph intentionally owns
no coding runtime, workspace, provider session, reviewer store, or database.
"""

from typing import TypedDict

from langgraph.graph import END, START, StateGraph


class BootstrapState(TypedDict, total=False):
    objective: str
    status: str


async def _bootstrap(state: BootstrapState) -> BootstrapState:
    return {"status": state.get("status") or "BOOTSTRAP"}


def get_forgeflow_graph():
    builder = StateGraph(BootstrapState)
    builder.add_node("bootstrap", _bootstrap)
    builder.add_edge(START, "bootstrap")
    builder.add_edge("bootstrap", END)
    return builder.compile()
