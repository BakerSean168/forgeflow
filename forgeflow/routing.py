"""Deterministic role-based route selection for ForgeFlow execution runtimes."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

RouteRole = Literal["IMPLEMENT", "REASONING"]
RouteRuntime = Literal["OPEN_SWE", "EXTERNAL_ACP"]
RouteHealth = Literal["READY", "COOLDOWN", "DISABLED"]

_ROLES = frozenset({"IMPLEMENT", "REASONING"})
_RUNTIMES = frozenset({"OPEN_SWE", "EXTERNAL_ACP"})
_HEALTH = frozenset({"READY", "COOLDOWN", "DISABLED"})


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

    def select(self, role: RouteRole, *, now: datetime | None = None) -> RouteDefinition | None:
        candidates = self.eligible(role, now=now)
        return candidates[0] if candidates else None


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
        "EXTERNAL_AGENT_OBJECTIVE_EMPTY",
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
    if normalized.startswith(("ANTIGRAVITY_", "EXTERNAL_AGENT_DOCKER_")):
        return "ROUTE_AVAILABILITY"
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
