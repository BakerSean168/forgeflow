import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from forgeflow.routing import RouteConfigError, RouteDefinition, RouteRegistry, load_route_registry

ROOT = Path(__file__).resolve().parents[1]
DEFAULT = ROOT / "deploy/gcp-dev/routes.default.json"


def test_default_routes_preserve_current_openswe_policy() -> None:
    registry = load_route_registry(DEFAULT)
    implement = registry.select("IMPLEMENT")
    reasoning = registry.select("REASONING")
    assert implement is not None
    assert (implement.id, implement.priority, implement.runtime, implement.target) == (
        "openswe-current",
        10,
        "OPEN_SWE",
        "current-model-policy",
    )
    assert reasoning is not None
    assert (reasoning.id, reasoning.priority, reasoning.runtime) == (
        "openswe-reviewer",
        10,
        "OPEN_SWE",
    )
    anti = registry.get("antigravity-account-primary")
    assert anti.priority == 20
    assert anti.runtime == "EXTERNAL_ACP"
    assert anti.enabled is False


def test_priority_alone_selects_between_enabled_eligible_routes() -> None:
    now = datetime.now(UTC)
    registry = RouteRegistry(
        (
            RouteDefinition("open", "IMPLEMENT", 20, "OPEN_SWE", "current"),
            RouteDefinition("external", "IMPLEMENT", 5, "EXTERNAL_ACP", "account", adapter="x"),
        )
    )
    assert registry.select("IMPLEMENT", now=now).id == "external"


def test_disabled_cooldown_and_expired_routes_are_skipped() -> None:
    now = datetime.now(UTC)
    registry = RouteRegistry(
        (
            RouteDefinition("disabled", "IMPLEMENT", 1, "OPEN_SWE", "a", enabled=False),
            RouteDefinition("cooldown", "IMPLEMENT", 2, "OPEN_SWE", "b", health="COOLDOWN"),
            RouteDefinition(
                "expired", "IMPLEMENT", 3, "OPEN_SWE", "c", expires_at=now - timedelta(seconds=1)
            ),
            RouteDefinition("ready", "IMPLEMENT", 4, "OPEN_SWE", "d"),
        )
    )
    assert [route.id for route in registry.eligible("IMPLEMENT", now=now)] == ["ready"]


def test_duplicate_priority_in_same_role_is_rejected() -> None:
    with pytest.raises(RouteConfigError, match="duplicate priority"):
        RouteRegistry(
            (
                RouteDefinition("a", "IMPLEMENT", 10, "OPEN_SWE", "a"),
                RouteDefinition("b", "IMPLEMENT", 10, "OPEN_SWE", "b"),
            )
        )


def test_route_file_rejects_naive_expiry(tmp_path: Path) -> None:
    payload = json.loads(DEFAULT.read_text(encoding="utf-8"))
    payload["routes"][0]["expires_at"] = "2026-09-23T00:00:00"
    path = tmp_path / "routes.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(RouteConfigError, match="timezone"):
        load_route_registry(path)


def test_failure_classifier_only_marks_route_availability_for_provider_runtime_failures() -> None:
    from forgeflow.routing import classify_failure_code

    assert classify_failure_code("ANTIGRAVITY_PROCESS_EXITED") == "ROUTE_AVAILABILITY"
    assert classify_failure_code("EXTERNAL_AGENT_DOCKER_COMMAND_FAILED:timeout") == "ROUTE_AVAILABILITY"
    assert classify_failure_code("EXTERNAL_AGENT_WORKSPACE_NOT_ALLOWED") == "POLICY_DENIED"
    assert classify_failure_code("EXTERNAL_AGENT_TEST_FAILED:1") == "TASK_FAILURE"
    assert classify_failure_code("EXTERNAL_AGENT_PROJECT_CONFIG_MISSING") == "POLICY_DENIED"
    assert classify_failure_code("SOMETHING_NEW") == "UNCLASSIFIED"
