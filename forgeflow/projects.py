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


@dataclass(frozen=True, slots=True)
class ExternalAgentProjectConfig:
    cwd: Path
    test_command: tuple[str, ...]


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
    if not isinstance(cwd, str) or not cwd.strip():
        return None
    if (
        not isinstance(command, list)
        or not command
        or any(not isinstance(item, str) or not item.strip() for item in command)
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


def load_continuous_project_configs() -> tuple[ContinuousProjectConfig, ...]:
    """Load opt-in unattended project continuation from the existing project manifest.

    The supervisor owns no second queue/database. Repository plan files remain the
    task truth; LangGraph objective threads remain the execution truth.
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
        objective = str(spec.get("objective") or "").strip()
        paths = spec.get("plan_paths")
        criteria = spec.get("acceptance_criteria", [])
        auto_merge = spec.get("auto_merge_ready", False)
        if not project_key or not base_ref or not objective:
            raise ValueError(f"continuous supervisor {repo_full} has incomplete configuration")
        if not isinstance(paths, list) or not paths or any(not isinstance(item, str) or not item.strip() for item in paths):
            raise ValueError(f"continuous supervisor {repo_full} requires plan_paths")
        if not isinstance(criteria, list) or any(not isinstance(item, str) for item in criteria):
            raise ValueError(f"continuous supervisor {repo_full} acceptance_criteria must be strings")
        if not isinstance(auto_merge, bool):
            raise TypeError(f"continuous supervisor {repo_full} auto_merge_ready must be boolean")
        plan_paths = tuple((cwd / item).resolve(strict=False) for item in paths)
        if any(cwd not in path.parents and path != cwd for path in plan_paths):
            raise ValueError(f"continuous supervisor {repo_full} plan path escapes repository")
        configs.append(
            ContinuousProjectConfig(
                project_key=project_key,
                owner=owner,
                repo=repo,
                cwd=cwd,
                base_ref=base_ref,
                plan_paths=plan_paths,
                objective=objective,
                acceptance_criteria=tuple(item.strip() for item in criteria if item.strip()),
                auto_merge_ready=auto_merge,
            )
        )
    return tuple(configs)


__all__ += ["ContinuousProjectConfig", "load_continuous_project_configs"]
