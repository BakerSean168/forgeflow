"""Repository policy projected from Open SWE's existing local project manifest."""

import json
import os
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from forgeflow.models import RepositoryPolicy
from forgeflow.routing import (
    ProjectRoutePreferences,
    RouteDefinition,
    RouteRegistry,
    RouteRole,
    parse_project_route_preferences,
)
from forgeflow.task_graph import TaskGraphSpec, TaskSpec, load_task_graph


@dataclass(frozen=True, slots=True)
class ExternalAgentProjectConfig:
    cwd: Path
    test_command: tuple[str, ...]
    prepare_command: tuple[str, ...] | None = None
    package_manager: str | None = None


def _project_entry(owner: str, repo: str) -> dict | None:
    path = os.environ.get("OPEN_SWE_LOCAL_PROJECTS_FILE", "").strip()
    if not path:
        return None
    try:
        entries = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(entries, list):
        return None
    expected = f"{owner}/{repo}".casefold()
    for raw in entries:
        if not isinstance(raw, dict):
            continue
        full_name = raw.get("repo")
        if isinstance(full_name, str) and full_name.casefold() == expected:
            return raw
    return None


def load_repository_policy(owner: str, repo: str) -> RepositoryPolicy:
    """Load CI policy without introducing a second project registry or database."""
    raw = _project_entry(owner, repo)
    if raw is None:
        return RepositoryPolicy(ci_required=True)
    ci_required = raw.get("ci_required", True)
    if not isinstance(ci_required, bool):
        return RepositoryPolicy(ci_required=True)
    checks = raw.get("required_checks", [])
    if not isinstance(checks, list) or any(not isinstance(item, str) for item in checks):
        return RepositoryPolicy(ci_required=ci_required)
    normalized = tuple(dict.fromkeys(item.strip() for item in checks if item.strip()))
    return RepositoryPolicy(ci_required=ci_required, required_checks=normalized)


def load_external_agent_project_config(owner: str, repo: str) -> ExternalAgentProjectConfig | None:
    """Read the optional external-agent execution contract from the same project manifest."""
    raw = _project_entry(owner, repo)
    if raw is None:
        return None
    cwd = raw.get("cwd")
    command = raw.get("external_agent_test_command")
    prepare = raw.get("external_agent_prepare_command")
    package_manager = raw.get("external_agent_package_manager")
    if not isinstance(cwd, str) or not cwd.strip():
        return None
    if (
        not isinstance(command, list)
        or not command
        or any(not isinstance(item, str) or not item.strip() for item in command)
    ):
        return None
    if prepare is not None and (
        not isinstance(prepare, list)
        or not prepare
        or any(not isinstance(item, str) or not item.strip() for item in prepare)
    ):
        return None
    if package_manager is not None and (
        not isinstance(package_manager, str) or not package_manager.strip()
    ):
        return None
    path = Path(cwd).expanduser()
    try:
        resolved = path.resolve(strict=True)
    except OSError:
        return None
    if not resolved.is_dir():
        return None
    return ExternalAgentProjectConfig(
        cwd=resolved,
        test_command=tuple(item.strip() for item in command),
        prepare_command=(tuple(item.strip() for item in prepare) if prepare is not None else None),
        package_manager=(package_manager.strip() if isinstance(package_manager, str) else None),
    )


def load_project_route_preferences(
    registry: RouteRegistry, owner: str, repo: str
) -> ProjectRoutePreferences:
    """Read optional role-scoped route preferences from the same project manifest.

    Absent or unconfigured projects yield the empty default and keep the global
    role/priority selection exactly. Malformed configuration is rejected
    fail-closed by :func:`forgeflow.routing.parse_project_route_preferences`.
    """
    raw = _project_entry(owner, repo)
    if not isinstance(raw, dict) or "route_preferences" not in raw:
        return ProjectRoutePreferences()
    return parse_project_route_preferences(raw["route_preferences"], registry=registry)


def resolve_project_route(
    registry: RouteRegistry,
    role: RouteRole,
    *,
    owner: str,
    repo: str,
    now: datetime | None = None,
    exclude_ids: frozenset[str] = frozenset(),
) -> RouteDefinition | None:
    """Select a role route honoring this project's validated preference.

    Eligibility (enabled/health/expiry) is unchanged. When a preferred route is
    temporarily ineligible or excluded, selection deterministically continues
    with the unmodified global priority order; global priorities are not mutated.
    """
    preferences = load_project_route_preferences(registry, owner, repo)
    return registry.select(
        role,
        now=now,
        exclude_ids=exclude_ids,
        preferred_ids=preferences.preferred_ids(role),
    )


__all__ = [
    "ExternalAgentProjectConfig",
    "load_external_agent_project_config",
    "load_project_route_preferences",
    "load_repository_policy",
    "resolve_project_route",
]


@dataclass(frozen=True, slots=True)
class ContinuousLaneConfig:
    key: str
    objective: str
    acceptance_criteria: tuple[str, ...]
    depends_on: tuple[str, ...]
    conflicts_with: tuple[str, ...]
    match_terms: tuple[str, ...]
    completion_markers: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ContinuousProjectConfig:
    project_key: str
    owner: str
    repo: str
    cwd: Path
    base_ref: str
    plan_paths: tuple[Path, ...]
    objective: str
    acceptance_criteria: tuple[str, ...]
    auto_merge_ready: bool
    max_parallel_mutations: int = 1
    lanes: tuple[ContinuousLaneConfig, ...] = ()
    task_graph_path: Path | None = None
    task_graph: TaskGraphSpec | None = None
    ai_decomposition_enabled: bool = False

    @property
    def execution_tasks(self) -> tuple[ContinuousLaneConfig | TaskSpec, ...]:
        if self.task_graph is not None:
            return self.task_graph.tasks
        return self.lanes


def _string_list(value: object, *, label: str) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError(f"{label} must be a list of strings")
    return tuple(dict.fromkeys(item.strip() for item in value if item.strip()))


def _continuous_lanes(
    spec: dict[str, object], *, repo_full: str
) -> tuple[ContinuousLaneConfig, ...]:
    raw_lanes = spec.get("lanes", [])
    if raw_lanes is None:
        return ()
    if not isinstance(raw_lanes, list):
        raise TypeError(f"continuous supervisor {repo_full} lanes must be a list")

    lanes: list[ContinuousLaneConfig] = []
    seen: set[str] = set()
    for raw_lane in raw_lanes:
        if not isinstance(raw_lane, dict):
            raise TypeError(f"continuous supervisor {repo_full} lane must be an object")
        key = str(raw_lane.get("key") or "").strip().casefold()
        objective = str(raw_lane.get("objective") or "").strip()
        if not key or not objective:
            raise ValueError(f"continuous supervisor {repo_full} lane requires key/objective")
        if key in seen:
            raise ValueError(f"continuous supervisor {repo_full} has duplicate lane {key}")
        seen.add(key)
        criteria = _string_list(
            raw_lane.get("acceptance_criteria"),
            label=f"continuous supervisor {repo_full} lane {key} acceptance_criteria",
        )
        depends_on = tuple(
            item.casefold()
            for item in _string_list(
                raw_lane.get("depends_on"),
                label=f"continuous supervisor {repo_full} lane {key} depends_on",
            )
        )
        conflicts_with = tuple(
            item.casefold()
            for item in _string_list(
                raw_lane.get("conflicts_with"),
                label=f"continuous supervisor {repo_full} lane {key} conflicts_with",
            )
        )
        match_terms = _string_list(
            raw_lane.get("match_terms", [key]),
            label=f"continuous supervisor {repo_full} lane {key} match_terms",
        )
        completion_markers = _string_list(
            raw_lane.get("completion_markers"),
            label=f"continuous supervisor {repo_full} lane {key} completion_markers",
        )
        lanes.append(
            ContinuousLaneConfig(
                key=key,
                objective=objective,
                acceptance_criteria=criteria,
                depends_on=depends_on,
                conflicts_with=conflicts_with,
                match_terms=match_terms,
                completion_markers=completion_markers,
            )
        )

    known = {lane.key for lane in lanes}
    for lane in lanes:
        unknown = (set(lane.depends_on) | set(lane.conflicts_with)) - known
        if unknown:
            raise ValueError(
                f"continuous supervisor {repo_full} lane {lane.key} references unknown lanes: "
                + ", ".join(sorted(unknown))
            )
        if lane.key in lane.depends_on or lane.key in lane.conflicts_with:
            raise ValueError(
                f"continuous supervisor {repo_full} lane {lane.key} cannot depend/conflict with itself"
            )
    return tuple(lanes)


def _repo_path(cwd: Path, value: str, *, label: str) -> Path:
    path = (cwd / value).resolve(strict=False)
    if cwd not in path.parents and path != cwd:
        raise ValueError(f"{label} escapes repository")
    return path


def _load_project_task_graph(
    spec: dict[str, object], *, cwd: Path, repo_full: str
) -> tuple[Path | None, TaskGraphSpec | None]:
    raw_path = spec.get("task_graph_path")
    if raw_path is None:
        return None, None
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ValueError(f"continuous supervisor {repo_full} task_graph_path must be a string")
    path = _repo_path(
        cwd,
        raw_path.strip(),
        label=f"continuous supervisor {repo_full} task graph path",
    )
    graph = load_task_graph(path)
    refs = set(graph.context_refs)
    for task in graph.tasks:
        refs.update(task.context_refs)
    for ref in sorted(refs):
        resolved = _repo_path(
            cwd,
            ref,
            label=f"continuous supervisor {repo_full} task graph context ref {ref}",
        )
        if not resolved.is_file():
            raise ValueError(
                f"continuous supervisor {repo_full} task graph context ref is unavailable: {ref}"
            )
    return path, graph


def load_continuous_project_configs() -> tuple[ContinuousProjectConfig, ...]:
    """Load opt-in unattended project continuation from the existing project manifest.

    Repository plans/TaskGraphs remain planning truth and LangGraph objective
    threads remain execution truth. First-class TaskGraph input or legacy lane
    configuration adds bounded dependency-aware parallelism without creating a
    second workflow database.
    """
    raw_path = os.environ.get("OPEN_SWE_LOCAL_PROJECTS_FILE", "").strip()
    if not raw_path:
        return ()
    try:
        entries = json.loads(Path(raw_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("project manifest is unavailable") from exc
    if not isinstance(entries, list):
        raise TypeError("project manifest must be a JSON array")

    configs: list[ContinuousProjectConfig] = []
    for raw in entries:
        if not isinstance(raw, dict):
            continue
        spec = raw.get("continuous_supervisor")
        if not isinstance(spec, dict) or spec.get("enabled") is not True:
            continue
        repo_full = raw.get("repo")
        cwd_raw = raw.get("cwd")
        if not isinstance(repo_full, str) or repo_full.count("/") != 1:
            raise ValueError("continuous supervisor project requires owner/repo")
        if not isinstance(cwd_raw, str) or not cwd_raw.strip():
            raise ValueError(f"continuous supervisor {repo_full} requires cwd")
        cwd = Path(cwd_raw).expanduser().resolve(strict=False)
        owner, repo = repo_full.split("/", 1)
        project_key = str(raw.get("project_key") or repo).strip().casefold()
        base_ref = str(spec.get("base_ref") or raw.get("default_branch") or "main").strip()
        task_graph_path, task_graph = _load_project_task_graph(
            spec, cwd=cwd, repo_full=repo_full
        )
        objective = str(spec.get("objective") or "").strip()
        if task_graph is not None:
            objective = task_graph.objective
        paths = spec.get("plan_paths")
        criteria = spec.get("acceptance_criteria", [])
        auto_merge = spec.get("auto_merge_ready", False)
        max_parallel = spec.get("max_parallel_mutations", 1)
        ai_decomposition_enabled = spec.get("ai_decomposition_enabled", False)
        if isinstance(max_parallel, bool) or not isinstance(max_parallel, int) or not 1 <= max_parallel <= 4:
            raise ValueError(
                f"continuous supervisor {repo_full} max_parallel_mutations must be an integer from 1 to 4"
            )
        if not project_key or not base_ref or not objective:
            raise ValueError(f"continuous supervisor {repo_full} has incomplete configuration")
        if not isinstance(ai_decomposition_enabled, bool):
            raise TypeError(
                f"continuous supervisor {repo_full} ai_decomposition_enabled must be boolean"
            )
        if not isinstance(paths, list) or not paths or any(
            not isinstance(item, str) or not item.strip() for item in paths
        ):
            raise ValueError(f"continuous supervisor {repo_full} requires plan_paths")
        if not isinstance(criteria, list) or any(not isinstance(item, str) for item in criteria):
            raise ValueError(
                f"continuous supervisor {repo_full} acceptance_criteria must be strings"
            )
        if not isinstance(auto_merge, bool):
            raise TypeError(f"continuous supervisor {repo_full} auto_merge_ready must be boolean")
        lanes = _continuous_lanes(spec, repo_full=repo_full)
        if task_graph is not None and lanes:
            raise ValueError(
                f"continuous supervisor {repo_full} cannot configure both lanes and task_graph_path"
            )
        plan_paths = tuple(
            _repo_path(
                cwd,
                item,
                label=f"continuous supervisor {repo_full} plan path",
            )
            for item in paths
        )
        combined_criteria = tuple(item.strip() for item in criteria if item.strip())
        if task_graph is not None:
            combined_criteria = tuple(
                dict.fromkeys((*task_graph.acceptance_criteria, *combined_criteria))
            )
        configs.append(
            ContinuousProjectConfig(
                project_key=project_key,
                owner=owner,
                repo=repo,
                cwd=cwd,
                base_ref=base_ref,
                plan_paths=plan_paths,
                objective=objective,
                acceptance_criteria=combined_criteria,
                auto_merge_ready=auto_merge,
                max_parallel_mutations=max_parallel,
                lanes=lanes,
                task_graph_path=task_graph_path,
                task_graph=task_graph,
                ai_decomposition_enabled=ai_decomposition_enabled,
            )
        )
    return tuple(configs)


__all__ += [
    "ContinuousLaneConfig",
    "ContinuousProjectConfig",
    "load_continuous_project_configs",
]
