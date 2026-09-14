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
