from __future__ import annotations

import pytest

from openswe_ext.task_planner import (
    PlanningContext,
    TaskGraphPlanningOutput,
    TaskPlanningRequest,
    propose_task_graph,
)


def _request() -> TaskPlanningRequest:
    return TaskPlanningRequest(
        owner="BakerSean168",
        repo="memoflow",
        graph_id="memoflow-vnext",
        revision=1,
        title_hint="MemoFlow vNext",
        objective="Complete MemoFlow vNext coherently.",
        context=(
            PlanningContext(
                path="docs/plan/active/current.md",
                content="# Plan\nRoutine must precede planner.\n",
            ),
            PlanningContext(
                path="docs/adr/system.md",
                content="# ADR\nGo owns durable domain state.\n",
            ),
        ),
        constraints=("Do not restore retired DAG semantics.",),
    )


def _output(*, context_ref: str = "docs/adr/system.md") -> TaskGraphPlanningOutput:
    return TaskGraphPlanningOutput.model_validate(
        {
            "title": "MemoFlow vNext execution graph",
            "architecture_decisions": ["Go owns durable domain state."],
            "protected_contracts": ["Keep one routine contract owner."],
            "non_goals": ["Do not restore retired DAG semantics."],
            "acceptance_criteria": ["Exact-head CI and review pass."],
            "tasks": [
                {
                    "id": "ROUTINE-2201",
                    "title": "Routine contract migration",
                    "goal": "Finish the routine contract migration.",
                    "why_now": "Planner depends on the stable contract.",
                    "risk": "high",
                    "scope": ["Routine domain contract."],
                    "out_of_scope": ["Notification UI."],
                    "context_refs": [context_ref],
                    "protected_contracts": ["No duplicate repository abstraction."],
                    "implementation_steps": ["Characterize then migrate the contract."],
                    "integration_notes": ["Planner consumes this contract."],
                    "acceptance_criteria": ["Routine tests pass."],
                    "verification_commands": ["pnpm test:routine"],
                    "depends_on": [],
                    "conflicts_with": [],
                    "mutation_keys": ["contract:routine"],
                }
            ],
        }
    )


@pytest.mark.asyncio
async def test_ai_task_planner_is_disabled_by_default(monkeypatch) -> None:
    monkeypatch.delenv("FORGEFLOW_ENABLE_AI_DECOMPOSITION", raising=False)

    async def fake_invoker(request):
        raise AssertionError("disabled planner must not invoke a model")

    with pytest.raises(RuntimeError, match="AI_DECOMPOSITION_DISABLED"):
        await propose_task_graph(_request(), project_enabled=True, invoker=fake_invoker)


@pytest.mark.asyncio
async def test_ai_task_planner_requires_project_opt_in_even_with_global_gate(monkeypatch) -> None:
    monkeypatch.setenv("FORGEFLOW_ENABLE_AI_DECOMPOSITION", "1")

    async def fake_invoker(request):
        raise AssertionError("project opt-in is required before model invocation")

    with pytest.raises(RuntimeError, match="AI_DECOMPOSITION_DISABLED"):
        await propose_task_graph(_request(), project_enabled=False, invoker=fake_invoker)


@pytest.mark.asyncio
async def test_ai_task_planner_returns_validated_proposal_without_activation(monkeypatch) -> None:
    monkeypatch.setenv("FORGEFLOW_ENABLE_AI_DECOMPOSITION", "1")

    async def fake_invoker(request):
        return _output(), "openai:gpt-5.6-sol"

    graph, model_id = await propose_task_graph(
        _request(), project_enabled=True, invoker=fake_invoker
    )
    assert model_id == "openai:gpt-5.6-sol"
    assert graph.graph_id == "memoflow-vnext"
    assert graph.revision == 1
    assert graph.planned_by == "forgeflow-ai-planner/openai:gpt-5.6-sol"
    assert graph.tasks[0].key == "routine-2201"
    assert graph.tasks[0].mutation_keys == ("contract:routine",)


@pytest.mark.asyncio
async def test_ai_task_planner_rejects_context_refs_not_in_supplied_evidence(monkeypatch) -> None:
    monkeypatch.setenv("FORGEFLOW_ENABLE_AI_DECOMPOSITION", "true")

    async def fake_invoker(request):
        return _output(context_ref="docs/secret/unseen.md"), "fake:model"

    with pytest.raises(ValueError, match="outside the supplied repository evidence"):
        await propose_task_graph(_request(), project_enabled=True, invoker=fake_invoker)
