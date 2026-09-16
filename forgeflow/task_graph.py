"""Repository-owned execution-ready task graph contract for ForgeFlow.

The task graph is planning truth, not execution state. It is intentionally
versionable in the target repository and can be authored by a human, ChatGPT,
or a future AI planner. ForgeFlow validates it deterministically before any
mutation worker is started.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath
from typing import Literal

TaskRisk = Literal["low", "medium", "high"]

_SCHEMA_VERSION = 1
_GRAPH_FIELDS = frozenset(
    {
        "schema_version",
        "graph_id",
        "revision",
        "title",
        "objective",
        "planned_by",
        "context_refs",
        "architecture_decisions",
        "protected_contracts",
        "non_goals",
        "acceptance_criteria",
        "tasks",
    }
)
_TASK_FIELDS = frozenset(
    {
        "id",
        "title",
        "goal",
        "why_now",
        "risk",
        "scope",
        "out_of_scope",
        "context_refs",
        "protected_contracts",
        "implementation_steps",
        "integration_notes",
        "acceptance_criteria",
        "verification_commands",
        "depends_on",
        "conflicts_with",
        "mutation_keys",
    }
)


@dataclass(frozen=True, slots=True)
class TaskSpec:
    id: str
    title: str
    goal: str
    why_now: str
    risk: TaskRisk
    scope: tuple[str, ...]
    out_of_scope: tuple[str, ...]
    context_refs: tuple[str, ...]
    protected_contracts: tuple[str, ...]
    implementation_steps: tuple[str, ...]
    integration_notes: tuple[str, ...]
    acceptance_criteria: tuple[str, ...]
    verification_commands: tuple[str, ...]
    depends_on: tuple[str, ...]
    conflicts_with: tuple[str, ...]
    mutation_keys: tuple[str, ...]

    @property
    def key(self) -> str:
        return self.id.casefold()

    @property
    def objective(self) -> str:
        """Compatibility projection for the existing mutation scheduler."""
        return self.goal


@dataclass(frozen=True, slots=True)
class TaskGraphSpec:
    schema_version: int
    graph_id: str
    revision: int
    title: str
    objective: str
    planned_by: str
    context_refs: tuple[str, ...]
    architecture_decisions: tuple[str, ...]
    protected_contracts: tuple[str, ...]
    non_goals: tuple[str, ...]
    acceptance_criteria: tuple[str, ...]
    tasks: tuple[TaskSpec, ...]

    def task(self, key: str) -> TaskSpec:
        normalized = key.casefold()
        for task in self.tasks:
            if task.key == normalized:
                return task
        raise KeyError(key)

    def execution_fingerprint(self, task: TaskSpec) -> str:
        """Hash execution semantics while deliberately excluding revision/provenance.

        A revision-only edit can therefore adopt an identical in-flight/accepted
        task, while any change to architecture, ownership, steps, verification,
        or acceptance yields a different identity and fails closed.
        """
        payload = {
            "schema_version": self.schema_version,
            "graph_id": self.graph_id,
            "objective": self.objective,
            "context_refs": self.context_refs,
            "architecture_decisions": self.architecture_decisions,
            "protected_contracts": self.protected_contracts,
            "non_goals": self.non_goals,
            "acceptance_criteria": self.acceptance_criteria,
            "task": asdict(task),
        }
        canonical = json.dumps(
            payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True
        ).encode("utf-8")
        return hashlib.sha256(canonical).hexdigest()


def _required_text(raw: Mapping[str, object], field: str, *, label: str) -> str:
    value = raw.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} requires non-empty {field}")
    return value.strip()


def _strings(
    value: object,
    *,
    label: str,
    required: bool = False,
    normalize_case: bool = False,
) -> tuple[str, ...]:
    if value is None:
        if required:
            raise ValueError(f"{label} must be a non-empty list of strings")
        return ()
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError(f"{label} must be a list of strings")
    items = tuple(
        dict.fromkeys(
            (item.strip().casefold() if normalize_case else item.strip())
            for item in value
            if item.strip()
        )
    )
    if required and not items:
        raise ValueError(f"{label} must be a non-empty list of strings")
    return items


def _repo_relative_refs(value: object, *, label: str) -> tuple[str, ...]:
    refs = _strings(value, label=label)
    for ref in refs:
        path = PurePosixPath(ref)
        if path.is_absolute() or ".." in path.parts:
            raise ValueError(f"{label} must contain repository-relative paths")
    return refs


def _task(raw: object, *, graph_id: str, index: int) -> TaskSpec:
    if not isinstance(raw, Mapping):
        raise TypeError(f"task graph {graph_id} tasks[{index}] must be an object")
    unknown = set(raw) - _TASK_FIELDS
    if unknown:
        raise ValueError(
            f"task graph {graph_id} tasks[{index}] has unknown fields: "
            + ", ".join(sorted(str(item) for item in unknown))
        )
    task_id = _required_text(raw, "id", label=f"task graph {graph_id} tasks[{index}]")
    label = f"task graph {graph_id} task {task_id}"
    risk = raw.get("risk", "medium")
    if risk not in {"low", "medium", "high"}:
        raise ValueError(f"{label} risk must be low, medium, or high")
    return TaskSpec(
        id=task_id,
        title=_required_text(raw, "title", label=label),
        goal=_required_text(raw, "goal", label=label),
        why_now=_required_text(raw, "why_now", label=label),
        risk=risk,
        scope=_strings(raw.get("scope"), label=f"{label} scope", required=True),
        out_of_scope=_strings(raw.get("out_of_scope"), label=f"{label} out_of_scope"),
        context_refs=_repo_relative_refs(raw.get("context_refs"), label=f"{label} context_refs"),
        protected_contracts=_strings(
            raw.get("protected_contracts"), label=f"{label} protected_contracts"
        ),
        implementation_steps=_strings(
            raw.get("implementation_steps"),
            label=f"{label} implementation_steps",
            required=True,
        ),
        integration_notes=_strings(
            raw.get("integration_notes"), label=f"{label} integration_notes"
        ),
        acceptance_criteria=_strings(
            raw.get("acceptance_criteria"),
            label=f"{label} acceptance_criteria",
            required=True,
        ),
        verification_commands=_strings(
            raw.get("verification_commands"),
            label=f"{label} verification_commands",
            required=True,
        ),
        depends_on=_strings(
            raw.get("depends_on"), label=f"{label} depends_on", normalize_case=True
        ),
        conflicts_with=_strings(
            raw.get("conflicts_with"),
            label=f"{label} conflicts_with",
            normalize_case=True,
        ),
        mutation_keys=_strings(
            raw.get("mutation_keys"),
            label=f"{label} mutation_keys",
            required=True,
            normalize_case=True,
        ),
    )


def _validate_graph_relations(graph: TaskGraphSpec) -> None:
    known = {task.key for task in graph.tasks}
    for task in graph.tasks:
        referenced = set(task.depends_on) | set(task.conflicts_with)
        unknown = referenced - known
        if unknown:
            raise ValueError(
                f"task graph {graph.graph_id} task {task.id} references unknown tasks: "
                + ", ".join(sorted(unknown))
            )
        if task.key in referenced:
            raise ValueError(
                f"task graph {graph.graph_id} task {task.id} cannot depend/conflict with itself"
            )

    visiting: set[str] = set()
    visited: set[str] = set()
    task_map = {task.key: task for task in graph.tasks}

    def visit(key: str, trail: tuple[str, ...]) -> None:
        if key in visited:
            return
        if key in visiting:
            cycle = " -> ".join((*trail, key))
            raise ValueError(f"task graph {graph.graph_id} dependency cycle: {cycle}")
        visiting.add(key)
        task = task_map[key]
        for dependency in task.depends_on:
            visit(dependency, (*trail, key))
        visiting.remove(key)
        visited.add(key)

    for task in graph.tasks:
        visit(task.key, ())


def parse_task_graph(raw: object) -> TaskGraphSpec:
    if not isinstance(raw, Mapping):
        raise TypeError("task graph must be a JSON object")
    unknown = set(raw) - _GRAPH_FIELDS
    if unknown:
        raise ValueError(
            "task graph has unknown fields: " + ", ".join(sorted(str(item) for item in unknown))
        )
    version = raw.get("schema_version")
    if isinstance(version, bool) or version != _SCHEMA_VERSION:
        raise ValueError(f"task graph schema_version must be {_SCHEMA_VERSION}")
    graph_id = _required_text(raw, "graph_id", label="task graph")
    raw_tasks = raw.get("tasks")
    if not isinstance(raw_tasks, list) or not raw_tasks:
        raise ValueError(f"task graph {graph_id} tasks must be a non-empty list")
    tasks = tuple(_task(item, graph_id=graph_id, index=index) for index, item in enumerate(raw_tasks))
    keys = [task.key for task in tasks]
    if len(keys) != len(set(keys)):
        raise ValueError(f"task graph {graph_id} has duplicate task ids")
    revision = raw.get("revision")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
        raise ValueError(f"task graph {graph_id} revision must be a positive integer")
    graph = TaskGraphSpec(
        schema_version=_SCHEMA_VERSION,
        graph_id=graph_id,
        revision=revision,
        title=_required_text(raw, "title", label=f"task graph {graph_id}"),
        objective=_required_text(raw, "objective", label=f"task graph {graph_id}"),
        planned_by=_required_text(raw, "planned_by", label=f"task graph {graph_id}"),
        context_refs=_repo_relative_refs(
            raw.get("context_refs"), label=f"task graph {graph_id} context_refs"
        ),
        architecture_decisions=_strings(
            raw.get("architecture_decisions"),
            label=f"task graph {graph_id} architecture_decisions",
            required=True,
        ),
        protected_contracts=_strings(
            raw.get("protected_contracts"),
            label=f"task graph {graph_id} protected_contracts",
            required=True,
        ),
        non_goals=_strings(raw.get("non_goals"), label=f"task graph {graph_id} non_goals"),
        acceptance_criteria=_strings(
            raw.get("acceptance_criteria"),
            label=f"task graph {graph_id} acceptance_criteria",
            required=True,
        ),
        tasks=tasks,
    )
    _validate_graph_relations(graph)
    return graph


def load_task_graph(path: Path) -> TaskGraphSpec:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ValueError(f"task graph is unavailable: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"task graph is invalid JSON: {path}") from exc
    return parse_task_graph(raw)


__all__ = ["TaskGraphSpec", "TaskRisk", "TaskSpec", "load_task_graph", "parse_task_graph"]
