"""Durable LangGraph entrypoint for independent invariant proposal review."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import asdict
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from forgeflow.proposals import InvariantProposalDecision, proposal_candidate_from_dict
from openswe_ext.invariant_proposal_reviewer import review_invariant_proposal

ReviewerFn = Callable[[Any], Awaitable[tuple[InvariantProposalDecision, str]]]


class InvariantReviewerInput(TypedDict):
    proposal: dict[str, Any]


class InvariantReviewerState(TypedDict, total=False):
    proposal: dict[str, Any]
    decision: dict[str, Any]
    reviewer_model_id: str


def build_invariant_reviewer_graph(*, reviewer: ReviewerFn = review_invariant_proposal):
    async def review_node(state: InvariantReviewerState) -> InvariantReviewerState:
        raw = state.get("proposal")
        if not isinstance(raw, dict):
            raise TypeError("invariant reviewer requires proposal input")
        candidate = proposal_candidate_from_dict(raw)
        decision, model_id = await reviewer(candidate)
        return {
            "proposal": raw,
            "decision": asdict(decision),
            "reviewer_model_id": model_id,
        }

    builder = StateGraph(InvariantReviewerState, input_schema=InvariantReviewerInput)
    builder.add_node("review", review_node)
    builder.add_edge(START, "review")
    builder.add_edge("review", END)
    return builder.compile()


def get_invariant_reviewer_graph():
    return build_invariant_reviewer_graph()
