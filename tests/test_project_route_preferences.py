"""Focused coverage for explicit, deterministic per-project route preferences.

The project manifest (``OPEN_SWE_LOCAL_PROJECTS_FILE``) is the single ownership
source. These tests exercise default/global behavior, project isolation,
preferred selection, ineligible-preference fallback, fail-closed validation,
REASONING integration, and the operator projection without introducing a second
registry.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

import forgeflow.operator_api as api
from forgeflow.projects import load_project_route_preferences, resolve_project_route
from forgeflow.reconcile import DefaultPolicyServices, ReconcileError
from forgeflow.routing import (
    RouteConfigError,
    load_route_registry,
    parse_project_route_preferences,
)
from openswe_ext.model_policy import (
    REVIEW_FALLBACK_MODEL_ID,
    REVIEW_MODEL_ID,
    ModelPolicyError,
    reasoning_model_ids,
    reasoning_routes,
)

GLM53_TARGET = "fireworks:accounts/fireworks/models/glm-5p3"

ROUTES = {
    "version": 1,
    "routes": [
        {
            "id": "openswe-current",
            "role": "IMPLEMENT",
            "priority": 10,
            "runtime": "OPEN_SWE",
            "target": "current-model-policy",
            "enabled": True,
            "health": "READY",
        },
        {
            "id": "antigravity-account-primary",
            "role": "IMPLEMENT",
            "priority": 20,
            "runtime": "EXTERNAL_ACP",
            "adapter": "antigravity",
            "target": "google-account",
            "enabled": True,
            "health": "READY",
        },
        {
            "id": "codebuddy-account-primary",
            "role": "IMPLEMENT",
            "priority": 30,
            "runtime": "EXTERNAL_ACP",
            "adapter": "codebuddy",
            "target": "codebuddy-account",
            "enabled": True,
            "health": "READY",
        },
        {
            "id": "openswe-reviewer",
            "role": "REASONING",
            "priority": 10,
            "runtime": "OPEN_SWE",
            "target": REVIEW_MODEL_ID,
            "enabled": True,
            "health": "READY",
        },
        {
            "id": "openswe-reviewer-glm53",
            "role": "REASONING",
            "priority": 20,
            "runtime": "OPEN_SWE",
            "target": GLM53_TARGET,
            "enabled": True,
            "health": "READY",
        },
    ],
}

MEMO_IMPLEMENT_PREFERENCE = [
    {"role": "IMPLEMENT", "route_id": "codebuddy-account-primary"}
]


def _write_json(path: Path, payload: object) -> Path:
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


@pytest.fixture
def routes_path(tmp_path: Path) -> Path:
    return _write_json(tmp_path / "routes.json", ROUTES)


@pytest.fixture
def manifest_factory(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    path = tmp_path / "projects.json"

    def make(entries: list[dict]) -> Path:
        _write_json(path, entries)
        monkeypatch.setenv("OPEN_SWE_LOCAL_PROJECTS_FILE", str(path))
        return path

    return make


# --- default behavior -------------------------------------------------------


def test_project_without_preferences_keeps_global_role_priority(
    routes_path: Path, manifest_factory
) -> None:
    manifest_factory([{"repo": "o/r", "cwd": "/tmp/r"}])
    registry = load_route_registry(routes_path)

    assert load_project_route_preferences(registry, "o", "r").empty is True
    assert resolve_project_route(registry, "IMPLEMENT", owner="o", repo="r").id == (
        "openswe-current"
    )
    assert resolve_project_route(registry, "REASONING", owner="o", repo="r").id == (
        "openswe-reviewer"
    )
    # A project absent from the manifest is also an empty preference.
    assert resolve_project_route(registry, "IMPLEMENT", owner="ghost", repo="none").id == (
        "openswe-current"
    )
    # The global registry selection is byte-for-byte the pre-feature behavior.
    assert registry.select("IMPLEMENT").id == "openswe-current"
    assert registry.select("REASONING").id == "openswe-reviewer"


def test_absent_manifest_preserves_global_selection(
    routes_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("OPEN_SWE_LOCAL_PROJECTS_FILE", raising=False)
    registry = load_route_registry(routes_path)
    assert load_project_route_preferences(registry, "o", "r").empty is True
    assert resolve_project_route(registry, "IMPLEMENT", owner="o", repo="r").id == (
        "openswe-current"
    )


# --- project isolation ------------------------------------------------------


def test_preference_is_isolated_to_the_owning_project(
    routes_path: Path, manifest_factory
) -> None:
    manifest_factory(
        [
            {
                "repo": "o/memo",
                "cwd": "/tmp/memo",
                "route_preferences": MEMO_IMPLEMENT_PREFERENCE,
            },
            {"repo": "o/other", "cwd": "/tmp/other"},
        ]
    )
    registry = load_route_registry(routes_path)

    assert resolve_project_route(registry, "IMPLEMENT", owner="o", repo="memo").id == (
        "codebuddy-account-primary"
    )
    assert resolve_project_route(registry, "IMPLEMENT", owner="o", repo="other").id == (
        "openswe-current"
    )
    # No global mutation occurred while serving the preferred project.
    assert registry.select("IMPLEMENT").id == "openswe-current"


# --- preferred route selection ---------------------------------------------


def test_preferred_route_outranks_global_priority(
    routes_path: Path, manifest_factory
) -> None:
    manifest_factory(
        [
            {
                "repo": "o/memo",
                "cwd": "/tmp/memo",
                "route_preferences": MEMO_IMPLEMENT_PREFERENCE,
            }
        ]
    )
    registry = load_route_registry(routes_path)

    selected = resolve_project_route(registry, "IMPLEMENT", owner="o", repo="memo")
    assert selected is not None
    assert (selected.id, selected.priority, selected.runtime) == (
        "codebuddy-account-primary",
        30,
        "EXTERNAL_ACP",
    )
    # The unpreferred REASONING role still follows the global role/priority order.
    assert resolve_project_route(registry, "REASONING", owner="o", repo="memo").id == (
        "openswe-reviewer"
    )


# --- ineligible preference fallback ----------------------------------------


def _prefer_codebuddy_with_ineligible_routes(
    tmp_path: Path, mutate
) -> Path:
    payload = json.loads(json.dumps(ROUTES))
    for route in payload["routes"]:
        if route["id"] == "codebuddy-account-primary":
            mutate(route)
    return _write_json(tmp_path / "routes-ineligible.json", payload)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda route: route.update(enabled=False),
        lambda route: route.update(health="COOLDOWN"),
        lambda route: route.update(expires_at="2000-01-01T00:00:00Z"),
    ],
    ids=["disabled", "cooldown", "expired"],
)
def test_ineligible_preferred_route_falls_back_to_global_order(
    tmp_path: Path, manifest_factory, mutate
) -> None:
    routes_path = _prefer_codebuddy_with_ineligible_routes(tmp_path, mutate)
    manifest_factory(
        [
            {
                "repo": "o/memo",
                "cwd": "/tmp/memo",
                "route_preferences": MEMO_IMPLEMENT_PREFERENCE,
            }
        ]
    )
    registry = load_route_registry(routes_path)

    # The preferred route is skipped and the unmodified global primary wins.
    assert resolve_project_route(registry, "IMPLEMENT", owner="o", repo="memo").id == (
        "openswe-current"
    )
    # Global order is unchanged for every other project.
    assert registry.select("IMPLEMENT").id == "openswe-current"


def test_excluded_preferred_route_falls_back_to_next_global_route(
    routes_path: Path, manifest_factory
) -> None:
    manifest_factory(
        [
            {
                "repo": "o/memo",
                "cwd": "/tmp/memo",
                "route_preferences": MEMO_IMPLEMENT_PREFERENCE,
            }
        ]
    )
    registry = load_route_registry(routes_path)

    # Excluding the preferred route mirrors a classified route-availability retry.
    assert resolve_project_route(
        registry,
        "IMPLEMENT",
        owner="o",
        repo="memo",
        exclude_ids=frozenset({"codebuddy-account-primary"}),
    ).id == "openswe-current"

    # Excluding the two higher-priority routes still falls back in global order.
    assert resolve_project_route(
        registry,
        "IMPLEMENT",
        owner="o",
        repo="memo",
        exclude_ids=frozenset(
            {"codebuddy-account-primary", "openswe-current"}
        ),
    ).id == "antigravity-account-primary"


def test_ineligible_fallback_does_not_reorder_global_priorities(
    routes_path: Path, manifest_factory
) -> None:
    manifest_factory(
        [
            {
                "repo": "o/memo",
                "cwd": "/tmp/memo",
                "route_preferences": MEMO_IMPLEMENT_PREFERENCE,
            }
        ]
    )
    registry = load_route_registry(routes_path)
    resolve_project_route(
        registry,
        "IMPLEMENT",
        owner="o",
        repo="memo",
        exclude_ids=frozenset({"codebuddy-account-primary"}),
    )
    assert [route.id for route in registry.eligible("IMPLEMENT")] == [
        "openswe-current",
        "antigravity-account-primary",
        "codebuddy-account-primary",
    ]


# --- invalid configuration (fail-closed) -----------------------------------


@pytest.mark.parametrize(
    ("raw", "match"),
    [
        ({"role": "IMPLEMENT", "route_id": "codebuddy-account-primary"}, "non-empty list"),
        ([], "non-empty list"),
        ("codebuddy-account-primary", "non-empty list"),
        ([["IMPLEMENT", "codebuddy-account-primary"]], "must be an object"),
        ([{"role": "IMPLEMENT"}], "route_id is required"),
        ([{"role": "NOPE", "route_id": "codebuddy-account-primary"}], "invalid role"),
        ([{"role": "IMPLEMENT", "route_id": "ghost-route"}], "unknown route"),
        (
            [{"role": "REASONING", "route_id": "codebuddy-account-primary"}],
            "has role IMPLEMENT, not REASONING",
        ),
        (
            [
                {"role": "IMPLEMENT", "route_id": "codebuddy-account-primary"},
                {"role": "IMPLEMENT", "route_id": "antigravity-account-primary"},
            ],
            "duplicate role",
        ),
        (
            [{"role": "IMPLEMENT", "route_id": "codebuddy-account-primary", "x": 1}],
            "unknown fields",
        ),
    ],
)
def test_malformed_preferences_are_rejected(
    routes_path: Path, raw: object, match: str
) -> None:
    registry = load_route_registry(routes_path)
    with pytest.raises(RouteConfigError, match=match):
        parse_project_route_preferences(raw, registry=registry)


def test_malformed_preference_propagates_from_manifest_fail_closed(
    routes_path: Path, manifest_factory
) -> None:
    manifest_factory(
        [
            {
                "repo": "o/memo",
                "cwd": "/tmp/memo",
                "route_preferences": [{"role": "IMPLEMENT", "route_id": "ghost-route"}],
            }
        ]
    )
    registry = load_route_registry(routes_path)
    with pytest.raises(RouteConfigError, match="unknown route"):
        load_project_route_preferences(registry, "o", "memo")


def test_policy_services_fail_closed_on_invalid_project_preference(
    routes_path: Path, manifest_factory, monkeypatch: pytest.MonkeyPatch
) -> None:
    manifest_factory(
        [
            {
                "repo": "o/memo",
                "cwd": "/tmp/memo",
                "route_preferences": [{"role": "IMPLEMENT", "route_id": "ghost-route"}],
            }
        ]
    )
    monkeypatch.setenv("FORGEFLOW_ROUTE_CONFIG_FILE", str(routes_path))
    services = DefaultPolicyServices(client=object())

    with pytest.raises(ReconcileError, match="PROJECT_ROUTE_PREFERENCE_INVALID"):
        services.select_implementation_route(owner="o", repo="memo")

    # Omitting owner/repo keeps the unmodified global selection path.
    assert services.select_implementation_route().id == "openswe-current"


def test_policy_services_apply_valid_project_preference(
    routes_path: Path, manifest_factory, monkeypatch: pytest.MonkeyPatch
) -> None:
    manifest_factory(
        [
            {
                "repo": "o/memo",
                "cwd": "/tmp/memo",
                "route_preferences": MEMO_IMPLEMENT_PREFERENCE,
            }
        ]
    )
    monkeypatch.setenv("FORGEFLOW_ROUTE_CONFIG_FILE", str(routes_path))
    services = DefaultPolicyServices(client=object())
    assert services.select_implementation_route(owner="o", repo="memo").id == (
        "codebuddy-account-primary"
    )
    assert services.select_implementation_route().id == "openswe-current"


# --- REASONING integration --------------------------------------------------


def test_reasoning_preference_selects_project_primary(
    routes_path: Path, manifest_factory
) -> None:
    # The preference names a route id, not a model target.
    manifest_factory(
        [
            {
                "repo": "o/memo",
                "cwd": "/tmp/memo",
                "route_preferences": [
                    {"role": "REASONING", "route_id": "openswe-reviewer-glm53"}
                ],
            }
        ]
    )
    assert reasoning_model_ids(routes_path, owner="o", repo="memo") == (GLM53_TARGET, None)
    # An unconfigured project keeps Sol -> GLM 5.3.
    assert reasoning_model_ids(routes_path, owner="o", repo="other") == (
        REVIEW_MODEL_ID,
        REVIEW_FALLBACK_MODEL_ID,
    )


def test_reasoning_default_preference_keeps_reviewer_pair(
    routes_path: Path, manifest_factory
) -> None:
    manifest_factory(
        [
            {
                "repo": "o/memo",
                "cwd": "/tmp/memo",
                "route_preferences": [{"role": "REASONING", "route_id": "openswe-reviewer"}],
            }
        ]
    )
    assert reasoning_model_ids(routes_path, owner="o", repo="memo") == (
        REVIEW_MODEL_ID,
        REVIEW_FALLBACK_MODEL_ID,
    )
    routes = reasoning_routes(routes_path, owner="o", repo="memo")
    assert [(route.id, route.target) for route in routes] == [
        ("openswe-reviewer", REVIEW_MODEL_ID),
        ("openswe-reviewer-glm53", GLM53_TARGET),
    ]


def test_reasoning_invalid_preference_fails_closed(
    routes_path: Path, manifest_factory
) -> None:
    manifest_factory(
        [
            {
                "repo": "o/memo",
                "cwd": "/tmp/memo",
                "route_preferences": [{"role": "REASONING", "route_id": "ghost-route"}],
            }
        ]
    )
    with pytest.raises(ModelPolicyError, match="REASONING_ROUTE_PREFERENCE_INVALID"):
        reasoning_model_ids(routes_path, owner="o", repo="memo")


def test_reasoning_preference_is_isolated(
    routes_path: Path, manifest_factory
) -> None:
    manifest_factory(
        [
            {
                "repo": "o/memo",
                "cwd": "/tmp/memo",
                "route_preferences": [
                    {"role": "REASONING", "route_id": "openswe-reviewer-glm53"}
                ],
            },
            {"repo": "o/other", "cwd": "/tmp/other"},
        ]
    )
    assert reasoning_model_ids(routes_path, owner="o", repo="memo") == (GLM53_TARGET, None)
    assert reasoning_model_ids(routes_path, owner="o", repo="other") == (
        REVIEW_MODEL_ID,
        REVIEW_FALLBACK_MODEL_ID,
    )


def test_ineligible_reasoning_preference_falls_back_to_global_primary(
    tmp_path: Path, manifest_factory
) -> None:
    payload = json.loads(json.dumps(ROUTES))
    for route in payload["routes"]:
        if route["id"] == "openswe-reviewer-glm53":
            route["expires_at"] = "2000-01-01T00:00:00Z"
    routes_path = _write_json(tmp_path / "routes-reasoning-expired.json", payload)
    manifest_factory(
        [
            {
                "repo": "o/memo",
                "cwd": "/tmp/memo",
                "route_preferences": [
                    {"role": "REASONING", "route_id": "openswe-reviewer-glm53"}
                ],
            }
        ]
    )
    assert reasoning_model_ids(routes_path, owner="o", repo="memo") == (
        REVIEW_MODEL_ID,
        None,
    )


# --- operator projection ----------------------------------------------------


def _policy(registry, owner: str, repo: str) -> dict:
    return api._project_route_policy(registry, owner, repo)


def test_operator_project_projection_exposes_preference_and_selection(
    routes_path: Path, manifest_factory, monkeypatch: pytest.MonkeyPatch
) -> None:
    manifest_factory(
        [
            {
                "repo": "o/memo",
                "cwd": "/tmp/memo",
                "route_preferences": MEMO_IMPLEMENT_PREFERENCE,
            },
            {"repo": "o/other", "cwd": "/tmp/other"},
        ]
    )
    monkeypatch.setenv("FORGEFLOW_ROUTE_CONFIG_FILE", str(routes_path))
    registry = load_route_registry(routes_path)

    memo = _policy(registry, "o", "memo")
    assert memo["routeConfigurationError"] is None
    assert memo["routePreferences"] == {"IMPLEMENT": "codebuddy-account-primary"}
    implement = memo["selectedRoutes"]["IMPLEMENT"]
    assert implement["id"] == "codebuddy-account-primary"
    assert implement["source"] == "PREFERENCE"
    # The projection is allowlisted and never leaks extra route fields/secrets.
    assert set(implement) == {
        "id",
        "role",
        "priority",
        "runtime",
        "target",
        "adapter",
        "source",
    }

    other = _policy(registry, "o", "other")
    assert other["routePreferences"] == {}
    assert other["selectedRoutes"]["IMPLEMENT"]["id"] == "openswe-current"
    assert other["selectedRoutes"]["IMPLEMENT"]["source"] == "GLOBAL"


def test_operator_projection_surfaces_invalid_preference_fail_closed(
    routes_path: Path, manifest_factory
) -> None:
    manifest_factory(
        [
            {
                "repo": "o/memo",
                "cwd": "/tmp/memo",
                "route_preferences": [{"role": "IMPLEMENT", "route_id": "ghost-route"}],
            }
        ]
    )
    registry = load_route_registry(routes_path)
    memo = _policy(registry, "o", "memo")
    assert memo["routeConfigurationError"] is not None
    assert memo["selectedRoutes"] == {}
    assert memo["routePreferences"] == {}


def test_operator_projection_without_registry_is_empty(
    manifest_factory,
) -> None:
    manifest_factory([{"repo": "o/memo", "cwd": "/tmp/memo"}])
    assert _policy(None, "o", "memo") == {
        "routePreferences": {},
        "selectedRoutes": {},
        "routeConfigurationError": None,
    }


def test_operator_objective_projection_includes_route_policy(
    routes_path: Path, manifest_factory, monkeypatch: pytest.MonkeyPatch
) -> None:
    manifest_factory(
        [
            {
                "repo": "o/memo",
                "cwd": "/tmp/memo",
                "route_preferences": MEMO_IMPLEMENT_PREFERENCE,
            }
        ]
    )
    monkeypatch.setenv("FORGEFLOW_ROUTE_CONFIG_FILE", str(routes_path))
    snapshot = asyncio.run(
        api._execution_snapshot(
            object(),
            {
                "repoOwner": "o",
                "repoName": "memo",
                "implementationRouteId": None,
                "implementationRuntime": None,
                "status": "NEW",
            },
        )
    )
    policy = snapshot["routePolicy"]
    assert policy["routePreferences"] == {"IMPLEMENT": "codebuddy-account-primary"}
    assert policy["selectedRoutes"]["IMPLEMENT"]["id"] == "codebuddy-account-primary"
    assert policy["routeConfigurationError"] is None


def test_operator_resource_projection_exposes_per_project_selections(
    routes_path: Path, manifest_factory, monkeypatch: pytest.MonkeyPatch
) -> None:
    manifest_factory(
        [
            {
                "repo": "o/memo",
                "cwd": "/tmp/memo",
                "route_preferences": MEMO_IMPLEMENT_PREFERENCE,
            },
            {"repo": "o/other", "cwd": "/tmp/other"},
        ]
    )
    monkeypatch.setenv("FORGEFLOW_ROUTE_CONFIG_FILE", str(routes_path))
    monkeypatch.setenv("OPEN_SWE_LOCAL_AUTH_TOKEN", "secret")
    monkeypatch.delenv("FORGEFLOW_ATTEMPT_LEDGER_FILE", raising=False)
    monkeypatch.delenv("FORGEFLOW_RESOURCE_PROBE_FILE", raising=False)

    payload = asyncio.run(api.list_resources(authorization="Bearer secret"))
    assert payload["selection"]["IMPLEMENT"]["id"] == "openswe-current"
    assert payload["selection"]["IMPLEMENT"]["source"] == "GLOBAL"
    projects = payload["projectSelections"]
    assert projects["memo"]["selectedRoutes"]["IMPLEMENT"]["id"] == (
        "codebuddy-account-primary"
    )
    assert projects["other"]["selectedRoutes"]["IMPLEMENT"]["source"] == "GLOBAL"
