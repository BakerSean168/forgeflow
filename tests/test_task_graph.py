from __future__ import annotations

import pytest

from forgeflow.task_graph import parse_task_graph


def _graph() -> dict:
    return {
        "schema_version": 1,
        "graph_id": "memoflow-core-vnext",
        "revision": 1,
        "title": "MemoFlow Core vNext execution plan",
        "objective": "Complete the Core vNext refactor without breaking system contracts.",
        "planned_by": "chatgpt-web",
        "context_refs": ["docs/plan/active/core-vnext.md"],
        "architecture_decisions": [
            "Go owns durable task state; web consumes contracts.",
            "Time semantics remain centralized in @memoflow/time.",
        ],
        "protected_contracts": ["Goal/Task public API remains compatible."],
        "non_goals": ["Do not restore retired DAG semantics."],
        "acceptance_criteria": ["All required CI gates pass on exact head."],
        "tasks": [
            {
                "id": "ROUTINE-2201",
                "title": "Stabilize routine contract",
                "goal": "Finish the routine contract migration.",
                "why_now": "Planner depends on the finalized routine contract.",
                "risk": "high",
                "scope": ["Routine domain contract and adapter wiring."],
                "out_of_scope": ["Notification UI."],
                "context_refs": ["docs/adr/adr-routine.md"],
                "protected_contracts": ["No duplicate routine repository abstraction."],
                "implementation_steps": [
                    "Characterize the current routine contract.",
                    "Implement the smallest coherent migration.",
                ],
                "integration_notes": ["Planner consumes the resulting routine contract."],
                "acceptance_criteria": ["Routine focused tests pass."],
                "verification_commands": ["pnpm test:routine"],
                "depends_on": [],
                "conflicts_with": [],
                "mutation_keys": ["contract:routine", "domain:routine"],
            },
            {
                "id": "PLANNER-2301",
                "title": "Build planner on the stable routine contract",
                "goal": "Implement planner using the migrated routine boundary.",
                "why_now": "Routine contract is the prerequisite.",
                "risk": "medium",
                "scope": ["Planner service and contract adapter."],
                "out_of_scope": [],
                "context_refs": [],
                "protected_contracts": [],
                "implementation_steps": ["Implement planner against the routine contract."],
                "integration_notes": [],
                "acceptance_criteria": ["Planner focused tests pass."],
                "verification_commands": ["pnpm test:planner"],
                "depends_on": ["ROUTINE-2201"],
                "conflicts_with": [],
                "mutation_keys": ["domain:planner"],
            },
        ],
    }


def test_parse_task_graph_builds_dependency_aware_execution_contract() -> None:
    graph = parse_task_graph(_graph())
    assert graph.graph_id == "memoflow-core-vnext"
    assert graph.revision == 1
    assert graph.planned_by == "chatgpt-web"
    assert [task.key for task in graph.tasks] == ["routine-2201", "planner-2301"]
    assert graph.tasks[1].depends_on == ("routine-2201",)
    assert graph.tasks[0].mutation_keys == ("contract:routine", "domain:routine")
    assert graph.tasks[0].objective == graph.tasks[0].goal
    assert len(graph.execution_fingerprint(graph.tasks[0])) == 64


def test_execution_fingerprint_ignores_revision_but_tracks_semantic_changes() -> None:
    first = parse_task_graph(_graph())
    revision_only = _graph()
    revision_only["revision"] = 2
    second = parse_task_graph(revision_only)
    assert first.execution_fingerprint(first.tasks[0]) == second.execution_fingerprint(
        second.tasks[0]
    )

    changed = _graph()
    changed["protected_contracts"] = ["A newly strengthened system invariant."]
    third = parse_task_graph(changed)
    assert first.execution_fingerprint(first.tasks[0]) != third.execution_fingerprint(
        third.tasks[0]
    )

    context_changed = _graph()
    context_changed["context_refs"] = ["docs/adr/other-system.md"]
    fourth = parse_task_graph(context_changed)
    assert first.execution_fingerprint(first.tasks[0]) != fourth.execution_fingerprint(
        fourth.tasks[0]
    )


def test_parse_task_graph_rejects_dependency_cycle() -> None:
    raw = _graph()
    raw["tasks"][0]["depends_on"] = ["PLANNER-2301"]
    with pytest.raises(ValueError, match="dependency cycle"):
        parse_task_graph(raw)


def test_parse_task_graph_requires_mutation_ownership() -> None:
    raw = _graph()
    raw["tasks"][0]["mutation_keys"] = []
    with pytest.raises(ValueError, match="mutation_keys must be a non-empty list"):
        parse_task_graph(raw)


def test_parse_task_graph_rejects_unknown_fields() -> None:
    raw = _graph()
    raw["tasks"][0]["magic_priority"] = 99
    with pytest.raises(ValueError, match="unknown fields: magic_priority"):
        parse_task_graph(raw)


@pytest.mark.parametrize("field", ["match_terms", "completion_markers"])
def test_parse_task_graph_rejects_legacy_lane_adoption_fields(field: str) -> None:
    raw = _graph()
    raw["tasks"][0][field] = ["legacy shortcut"]
    with pytest.raises(ValueError, match=f"unknown fields: {field}"):
        parse_task_graph(raw)


def test_parse_task_graph_rejects_escaping_context_ref() -> None:
    raw = _graph()
    raw["context_refs"] = ["../outside.md"]
    with pytest.raises(ValueError, match="repository-relative"):
        parse_task_graph(raw)


def test_parse_task_graph_revision_is_explicit_and_positive() -> None:
    raw = _graph()
    raw["revision"] = 0
    with pytest.raises(ValueError, match="revision must be a positive integer"):
        parse_task_graph(raw)


def test_parse_task_graph_rejects_boolean_schema_version() -> None:
    raw = _graph()
    raw["schema_version"] = True
    with pytest.raises(ValueError, match="schema_version must be 1"):
        parse_task_graph(raw)


def test_task_route_preference_is_execution_semantics_without_changing_legacy_fingerprint() -> None:
    baseline = parse_task_graph(_graph())
    baseline_fingerprint = baseline.execution_fingerprint(baseline.tasks[0])

    routed_raw = _graph()
    routed_raw["tasks"][0]["preferred_implementation_route_id"] = "openswe-current"
    routed = parse_task_graph(routed_raw)

    assert routed.tasks[0].preferred_implementation_route_id == "openswe-current"
    assert routed.execution_fingerprint(routed.tasks[0]) != baseline_fingerprint

    revision_only = _graph()
    revision_only["revision"] = 2
    unchanged = parse_task_graph(revision_only)
    assert unchanged.execution_fingerprint(unchanged.tasks[0]) == baseline_fingerprint
