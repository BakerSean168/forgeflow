"""Deterministic role-based route selection for ForgeFlow execution runtimes."""

from __future__ import annotations

import argparse
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

RouteRole = Literal["IMPLEMENT", "REASONING"]
RouteRuntime = Literal["OPEN_SWE", "EXTERNAL_ACP"]
RouteHealth = Literal["READY", "COOLDOWN", "DISABLED"]

_ROLES: tuple[RouteRole, ...] = ("IMPLEMENT", "REASONING")
_RUNTIMES = frozenset({"OPEN_SWE", "EXTERNAL_ACP"})
_HEALTH = frozenset({"READY", "COOLDOWN", "DISABLED"})
_ROUTE_PREFERENCE_FIELDS = frozenset({"role", "route_id"})


class RouteConfigError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class RouteDefinition:
    id: str
    role: RouteRole
    priority: int
    runtime: RouteRuntime
    target: str
    enabled: bool = True
    health: RouteHealth = "READY"
    adapter: str | None = None
    expires_at: datetime | None = None

    def eligible(self, *, now: datetime) -> bool:
        if not self.enabled or self.health != "READY":
            return False
        return self.expires_at is None or self.expires_at > now


class RouteRegistry:
    def __init__(self, routes: tuple[RouteDefinition, ...]) -> None:
        ids: set[str] = set()
        priorities: set[tuple[str, int]] = set()
        for route in routes:
            if route.id in ids:
                raise RouteConfigError(f"duplicate route id: {route.id}")
            key = (route.role, route.priority)
            if key in priorities:
                raise RouteConfigError(
                    f"duplicate priority {route.priority} for role {route.role}"
                )
            ids.add(route.id)
            priorities.add(key)
        self._routes = routes

    @property
    def routes(self) -> tuple[RouteDefinition, ...]:
        return self._routes

    def get(self, route_id: str) -> RouteDefinition:
        for route in self._routes:
            if route.id == route_id:
                return route
        raise KeyError(route_id)

    def eligible(self, role: RouteRole, *, now: datetime | None = None) -> tuple[RouteDefinition, ...]:
        current = now or datetime.now(UTC)
        if current.tzinfo is None:
            raise ValueError("routing clock must be timezone-aware")
        candidates = [
            route for route in self._routes if route.role == role and route.eligible(now=current)
        ]
        return tuple(sorted(candidates, key=lambda route: (route.priority, route.id)))

    def select(
        self,
        role: RouteRole,
        *,
        now: datetime | None = None,
        exclude_ids: frozenset[str] = frozenset(),
        preferred_ids: Sequence[str] = (),
    ) -> RouteDefinition | None:
        """Select one eligible route for ``role``.

        ``preferred_ids`` is an ordered, already-validated project preference.
        Preferred eligible routes move to the front of the deterministic
        ``(priority, id)`` order.  A preferred route that is disabled, on
        cooldown, expired, or excluded is skipped and selection continues with
        the unmodified global priority order.  Global route priorities are never
        mutated.
        """
        candidates = self.eligible(role, now=now)
        if preferred_ids:
            rank = {route_id: index for index, route_id in enumerate(preferred_ids)}
            candidates = tuple(
                sorted(
                    candidates,
                    key=lambda route: (rank.get(route.id, len(rank)), route.priority, route.id),
                )
            )
        return next((route for route in candidates if route.id not in exclude_ids), None)


@dataclass(frozen=True, slots=True)
class ProjectRoutePreferences:
    """Validated, role-scoped preferred routes for one project.

    An empty instance means the project has no explicit preference and must keep
    the global role/priority selection exactly.
    """

    by_role: tuple[tuple[str, str], ...] = ()

    @property
    def empty(self) -> bool:
        return not self.by_role

    def preferred_ids(self, role: RouteRole) -> tuple[str, ...]:
        return tuple(route_id for configured_role, route_id in self.by_role if configured_role == role)

    def as_dict(self) -> dict[str, str]:
        return {role: route_id for role, route_id in self.by_role}


def parse_project_route_preferences(
    raw: object, *, registry: RouteRegistry
) -> ProjectRoutePreferences:
    """Validate the explicit ``route_preferences`` block of one project entry.

    The raw value is supplied only when the project entry actually declares
    ``route_preferences``; an absent key is handled upstream by
    :func:`forgeflow.projects.load_project_route_preferences`, which returns the
    empty default. Consequently an explicit ``null`` (``None``) is malformed and
    is rejected fail-closed with ``RouteConfigError`` along with other malformed
    shapes, duplicate roles/routes, unknown route ids, and routes that belong to a
    different role.
    """
    if not isinstance(raw, list) or not raw:
        raise RouteConfigError("project route_preferences must be a non-empty list")
    parsed: list[tuple[str, str]] = []
    seen_roles: set[str] = set()
    seen_routes: set[str] = set()
    for index, item in enumerate(raw):
        if not isinstance(item, Mapping):
            raise RouteConfigError(f"project route_preferences[{index}] must be an object")
        unknown = set(item) - _ROUTE_PREFERENCE_FIELDS
        if unknown:
            raise RouteConfigError(
                "project route_preferences[{}] has unknown fields: {}".format(
                    index, ",".join(sorted(str(field) for field in unknown))
                )
            )
        role = item.get("role")
        route_id = item.get("route_id")
        if not isinstance(role, str) or role not in _ROLES:
            raise RouteConfigError(f"project route_preferences[{index}] has invalid role")
        if not isinstance(route_id, str) or not route_id.strip():
            raise RouteConfigError(f"project route_preferences[{index}] route_id is required")
        normalized = route_id.strip()
        if role in seen_roles:
            raise RouteConfigError(f"project route_preferences has duplicate role: {role}")
        if normalized in seen_routes:
            raise RouteConfigError(f"project route_preferences has duplicate route_id: {normalized}")
        try:
            route = registry.get(normalized)
        except KeyError as exc:
            raise RouteConfigError(
                f"project route_preferences[{index}] references unknown route: {normalized}"
            ) from exc
        if route.role != role:
            raise RouteConfigError(
                f"project route_preferences[{index}] route {normalized} has role "
                f"{route.role}, not {role}"
            )
        seen_roles.add(role)
        seen_routes.add(normalized)
        parsed.append((role, normalized))
    return ProjectRoutePreferences(tuple(parsed))


def _parse_datetime(value: object, *, route_id: str) -> datetime | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise RouteConfigError(f"route {route_id} has invalid expires_at")
    text = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise RouteConfigError(f"route {route_id} has invalid expires_at") from exc
    if parsed.tzinfo is None:
        raise RouteConfigError(f"route {route_id} expires_at must include a timezone")
    return parsed.astimezone(UTC)


def _parse_route(raw: object) -> RouteDefinition:
    if not isinstance(raw, dict):
        raise RouteConfigError("route entry must be an object")
    route_id = raw.get("id")
    role = raw.get("role")
    priority = raw.get("priority")
    runtime = raw.get("runtime")
    target = raw.get("target")
    enabled = raw.get("enabled", True)
    health = raw.get("health", "READY")
    adapter = raw.get("adapter")
    if not isinstance(route_id, str) or not route_id.strip():
        raise RouteConfigError("route id is required")
    route_id = route_id.strip()
    if role not in _ROLES:
        raise RouteConfigError(f"route {route_id} has invalid role")
    if not isinstance(priority, int) or isinstance(priority, bool) or priority < 0:
        raise RouteConfigError(f"route {route_id} has invalid priority")
    if runtime not in _RUNTIMES:
        raise RouteConfigError(f"route {route_id} has invalid runtime")
    if not isinstance(target, str) or not target.strip():
        raise RouteConfigError(f"route {route_id} target is required")
    if not isinstance(enabled, bool):
        raise RouteConfigError(f"route {route_id} enabled must be boolean")
    if health not in _HEALTH:
        raise RouteConfigError(f"route {route_id} has invalid health")
    if adapter is not None and (not isinstance(adapter, str) or not adapter.strip()):
        raise RouteConfigError(f"route {route_id} has invalid adapter")
    if runtime == "EXTERNAL_ACP" and not adapter:
        raise RouteConfigError(f"route {route_id} external runtime requires adapter")
    return RouteDefinition(
        id=route_id,
        role=role,
        priority=priority,
        runtime=runtime,
        target=target.strip(),
        enabled=enabled,
        health=health,
        adapter=adapter.strip() if isinstance(adapter, str) else None,
        expires_at=_parse_datetime(raw.get("expires_at"), route_id=route_id),
    )


FailureClass = Literal["ROUTE_AVAILABILITY", "POLICY_DENIED", "TASK_FAILURE", "UNCLASSIFIED"]


def classify_failure_code(code: str) -> FailureClass:
    normalized = code.split(":", 1)[0].strip().upper()
    if normalized in {
        "EXTERNAL_AGENT_ROUTE_DISABLED",
        "EXTERNAL_AGENT_PROJECT_NOT_ALLOWED",
        "EXTERNAL_AGENT_PHASE_NOT_ALLOWED",
        "EXTERNAL_AGENT_WORKSPACE_NOT_ALLOWED",
        "EXTERNAL_AGENT_WORKSPACE_NOT_DIRECTORY",
        "EXTERNAL_AGENT_WORKSPACE_CLEANUP_FAILED",
        "EXTERNAL_AGENT_OBJECTIVE_EMPTY",
        "EXTERNAL_AGENT_OPERATION_ALREADY_FINISHED",
        "EXTERNAL_AGENT_OPERATION_KEY_EMPTY",
        "EXTERNAL_AGENT_TEST_COMMAND_EMPTY",
        "EXTERNAL_AGENT_ROUTE_NOT_ELIGIBLE",
        "EXTERNAL_AGENT_PROJECT_CONFIG_MISSING",
        "EXTERNAL_AGENT_WORKSPACE_ROOT_MISSING",
        "EXTERNAL_AGENT_SOURCE_NOT_DIRECTORY",
        "EXTERNAL_AGENT_SOURCE_NOT_GIT_REPOSITORY",
        "EXTERNAL_AGENT_BASE_REF_EMPTY",
    }:
        return "POLICY_DENIED"
    if normalized in {
        "ANTIGRAVITY_BINARY_NOT_FOUND",
        "ANTIGRAVITY_BINARY_NOT_EXECUTABLE",
        "ANTIGRAVITY_SESSION_NOT_FOUND",
        "ANTIGRAVITY_STREAM_UNAVAILABLE",
        "ANTIGRAVITY_PROCESS_EXITED",
        "ANTIGRAVITY_TIMEOUT",
        "ANTIGRAVITY_BOOTSTRAP_STREAM_UNAVAILABLE",
        "ANTIGRAVITY_BOOTSTRAP_PROCESS_EXITED",
        "ANTIGRAVITY_EVENT_INVALID_JSON",
        "ANTIGRAVITY_EVENT_INVALID",
        "ANTIGRAVITY_EVENT_TOO_LARGE",
        "ANTIGRAVITY_RESULT_INVALID",
        "CODEBUDDY_BINARY_NOT_FOUND",
        "CODEBUDDY_BINARY_NOT_EXECUTABLE",
        "EXTERNAL_AGENT_DOCKER_COMMAND_FAILED",
        "OPENSWE_PROVIDER_UNAVAILABLE",
    }:
        return "ROUTE_AVAILABILITY"
    if normalized in {
        "ANTIGRAVITY_ADDITIONAL_DIRECTORIES_UNSUPPORTED",
        "ANTIGRAVITY_ACP_MCP_UNSUPPORTED",
        "ANTIGRAVITY_ALLOWED_ROOT_REQUIRED",
        "ANTIGRAVITY_AUTH_STATE_REQUIRED",
        "ANTIGRAVITY_BOOTSTRAP_PERMISSION_DENIED",
        "ANTIGRAVITY_BOOTSTRAP_TOOL_ACTIVITY",
        "ANTIGRAVITY_OUTER_SANDBOX_REQUIRED",
        "ANTIGRAVITY_PROMPT_EMPTY",
        "ANTIGRAVITY_PROMPT_INVALID",
        "ANTIGRAVITY_PROMPT_TOO_LARGE",
        "ANTIGRAVITY_TEXT_PROMPT_ONLY",
        "ANTIGRAVITY_TOOL_PERMISSION_DENIED",
        "ANTIGRAVITY_WORKSPACE_NOT_ALLOWED",
        "ANTIGRAVITY_WORKSPACE_NOT_DIRECTORY",
        "CODEBUDDY_BOOTSTRAP_SEAL_FAILED",
        "CODEBUDDY_BOOTSTRAP_STILL_MOUNTED",
        "CODEBUDDY_CONTAINER_NAME_REQUIRED",
        "CODEBUDDY_CONTAINER_PID_INVALID",
        "CODEBUDDY_CREDENTIAL_KIND_INVALID",
        "CODEBUDDY_CREDENTIAL_REQUIRED",
        "CODEBUDDY_MODEL_REQUIRED",
        "CODEBUDDY_OFFICIAL_AUTH_REQUIRED",
        "CODEBUDDY_OUTER_SANDBOX_REQUIRED",
        "CODEBUDDY_WORKSPACE_NOT_DIRECTORY",
        "EXTERNAL_AGENT_ADAPTER_UNSUPPORTED",
        "EXTERNAL_AGENT_ROUTE_ADAPTER_REQUIRED",
    }:
        return "POLICY_DENIED"
    if normalized in {
        "EXTERNAL_AGENT_NO_CHANGES",
        "EXTERNAL_AGENT_COMMIT_NOT_ALLOWED",
        "EXTERNAL_AGENT_BRANCH_CHANGE_NOT_ALLOWED",
        "EXTERNAL_AGENT_TEST_MUTATED_WORKSPACE",
    } or normalized.startswith("EXTERNAL_AGENT_TEST_FAILED"):
        return "TASK_FAILURE"
    return "UNCLASSIFIED"


def load_route_registry(path: Path) -> RouteRegistry:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RouteConfigError("route config is unreadable or invalid JSON") from exc
    if not isinstance(payload, dict) or payload.get("version") != 1:
        raise RouteConfigError("route config version must be 1")
    rows = payload.get("routes")
    if not isinstance(rows, list) or not rows:
        raise RouteConfigError("route config must contain routes")
    return RouteRegistry(tuple(_parse_route(item) for item in rows))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Validate or inspect ForgeFlow route configuration")
    sub = parser.add_subparsers(dest="command", required=True)
    validate = sub.add_parser("validate")
    validate.add_argument("path")
    select = sub.add_parser("select")
    select.add_argument("path")
    select.add_argument("role", choices=sorted(_ROLES))
    return parser


def main() -> None:
    args = _parser().parse_args()
    registry = load_route_registry(Path(args.path))
    if args.command == "validate":
        print(json.dumps({"status": "PASS", "routes": len(registry.routes)}, sort_keys=True))
        return
    route = registry.select(args.role)
    print(
        json.dumps(
            {
                "status": "PASS",
                "role": args.role,
                "selected": None
                if route is None
                else {
                    "id": route.id,
                    "priority": route.priority,
                    "runtime": route.runtime,
                    "target": route.target,
                    "adapter": route.adapter,
                },
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
