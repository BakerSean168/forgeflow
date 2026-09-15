import pytest

from forgeflow.proposals import InvariantProposalCandidate
from openswe_ext import invariant_proposal_reviewer as module


class FakeStructured:
    def __init__(self, result=None, error=None):
        self.result = result
        self.error = error

    async def ainvoke(self, _messages):
        if self.error is not None:
            raise self.error
        return self.result


class FakeModel:
    def __init__(self, structured):
        self.structured = structured

    def with_structured_output(self, _schema):
        return self.structured


def _candidate() -> InvariantProposalCandidate:
    return InvariantProposalCandidate(
        proposal_id="prop-1",
        revision_id="rev-1",
        repository="bakersean168/memoflow",
        dynamic_rule_id="INV-DYN-ABC",
        evidence_count=2,
        pr_numbers=(1, 2),
        evidence_ids=("e1", "e2"),
        representative_terms=("frobnicator", "continuity", "marker"),
        titles=("Frobnicator drops continuity marker", "Continuity marker disappears"),
        files=("a.ts", "b.ts"),
    )


@pytest.mark.asyncio
async def test_proposal_reviewer_uses_reasoning_primary_and_structured_output(monkeypatch) -> None:
    monkeypatch.setattr(
        module,
        "reasoning_model_ids",
        lambda **_kwargs: ("openai:gpt-5.6-sol", "fireworks:fallback"),
    )
    calls = []
    output = module.ProposalReviewOutput(
        decision="accept",
        title="Preserve continuity marker",
        triggers=["frobnicator", "continuity"],
        check="Frobnicator resume preserves the continuity marker.",
        adversarial="Interrupt and resume the flow, then compare the marker.",
        rationale="Two independent PRs fixed the same root cause.",
    )

    def fake_make_model(model_id, **_kwargs):
        calls.append(model_id)
        return FakeModel(FakeStructured(result=output))

    monkeypatch.setattr(module, "make_model", fake_make_model)
    decision, model_id = await module.review_invariant_proposal(_candidate())
    assert model_id == "openai:gpt-5.6-sol"
    assert calls == ["openai:gpt-5.6-sol"]
    assert decision.decision == "accept"
    assert decision.triggers == ("frobnicator", "continuity")


@pytest.mark.asyncio
async def test_proposal_reviewer_falls_back_only_after_primary_failure(monkeypatch) -> None:
    monkeypatch.setattr(
        module,
        "reasoning_model_ids",
        lambda **_kwargs: ("openai:gpt-5.6-sol", "fireworks:glm"),
    )
    calls = []
    output = module.ProposalReviewOutput(
        decision="needs_more_evidence",
        rationale="The two cases may be adjacent symptoms rather than one invariant.",
    )

    def fake_make_model(model_id, **_kwargs):
        calls.append(model_id)
        if model_id == "openai:gpt-5.6-sol":
            return FakeModel(FakeStructured(error=RuntimeError("provider unavailable")))
        return FakeModel(FakeStructured(result=output))

    monkeypatch.setattr(module, "make_model", fake_make_model)
    decision, model_id = await module.review_invariant_proposal(_candidate())
    assert calls == ["openai:gpt-5.6-sol", "fireworks:glm"]
    assert model_id == "fireworks:glm"
    assert decision.decision == "needs_more_evidence"
