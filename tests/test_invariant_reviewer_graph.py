from dataclasses import asdict

import pytest

from forgeflow.invariant_reviewer_graph import build_invariant_reviewer_graph
from forgeflow.proposals import InvariantProposalCandidate, InvariantProposalDecision


@pytest.mark.asyncio
async def test_invariant_reviewer_graph_returns_only_structured_decision() -> None:
    seen = []

    async def fake(candidate):
        seen.append(candidate)
        return (
            InvariantProposalDecision(
                decision="accept",
                title="Preserve frobnicator continuity marker",
                triggers=("frobnicator", "continuity"),
                check="Widget resume must preserve the continuity marker across frobnicator boundaries.",
                adversarial="Interrupt the widget flow, resume it, and compare the continuity marker.",
                rationale="Two independent PRs fixed the same failure.",
            ),
            "openai:gpt-5.6-sol",
        )

    candidate = InvariantProposalCandidate(
        proposal_id="prop-1",
        revision_id="rev-1",
        repository="bakersean168/memoflow",
        dynamic_rule_id="INV-DYN-ABC123",
        evidence_count=2,
        pr_numbers=(401, 402),
        evidence_ids=("e1", "e2"),
        representative_terms=("frobnicator", "continuity", "marker"),
        titles=("first", "second"),
        files=("a.ts", "b.ts"),
    )
    graph = build_invariant_reviewer_graph(reviewer=fake)
    result = await graph.ainvoke({"proposal": asdict(candidate)})
    assert len(seen) == 1
    assert result["decision"]["decision"] == "accept"
    assert result["reviewer_model_id"] == "openai:gpt-5.6-sol"
    assert set(result) == {"proposal", "decision", "reviewer_model_id"}


@pytest.mark.asyncio
async def test_invariant_reviewer_graph_rejects_single_pr_evidence() -> None:
    async def should_not_run(_candidate):
        raise AssertionError("reviewer must not receive invalid proposal")

    graph = build_invariant_reviewer_graph(reviewer=should_not_run)
    with pytest.raises(ValueError, match="independent PRs"):
        await graph.ainvoke(
            {
                "proposal": {
                    "proposal_id": "prop-1",
                    "revision_id": "rev-1",
                    "repository": "o/r",
                    "dynamic_rule_id": "INV-DYN-X",
                    "evidence_count": 2,
                    "pr_numbers": [1, 1],
                    "evidence_ids": ["a", "b"],
                    "representative_terms": ["alpha", "beta"],
                    "titles": ["a", "b"],
                    "files": ["a.ts", "b.ts"],
                }
            }
        )
