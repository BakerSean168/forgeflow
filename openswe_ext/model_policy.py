"""ForgeFlow-specific Open SWE model routing policy.

Implementation/repair keeps its existing GLM 5.3 -> Luna policy. Reviewer
reasoning is sourced from ForgeFlow's REASONING route registry so the official
Open SWE reviewer can keep Sol as the primary while using the promotional GLM
5.3 resource only for transient provider failures.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Callable
from pathlib import Path

import agent.utils.model as upstream_model

from forgeflow.projects import load_project_route_preferences
from forgeflow.routing import (
    RouteConfigError,
    RouteDefinition,
    RouteRegistry,
    load_route_registry,
)

IMPLEMENTATION_MODEL_ID = "fireworks:accounts/fireworks/models/glm-5p3"
IMPLEMENTATION_EFFORT = "max"
IMPLEMENTATION_FALLBACK_MODEL_ID = "openai:gpt-5.6-luna"
REVIEW_MODEL_ID = "openai:gpt-5.6-sol"
REVIEW_FALLBACK_MODEL_ID = IMPLEMENTATION_MODEL_ID

_original_fallback_model_id_for: Callable[[str], str | None] = upstream_model.fallback_model_id_for
_installed = False


class ModelPolicyError(RuntimeError):
    """The configured model route cannot be represented by the Open SWE runtime."""


def implementation_model_policy() -> tuple[str, str, str | None]:
    """Return deployment-selected implementation model, effort and fallback.

    Repository constants remain the defaults. Operators may override them at
    service start when a provider is unavailable. An explicitly empty fallback
    disables model-level fallback.
    """
    model_id = os.environ.get(
        "FORGEFLOW_IMPLEMENTATION_MODEL_ID", IMPLEMENTATION_MODEL_ID
    ).strip()
    effort = os.environ.get(
        "FORGEFLOW_IMPLEMENTATION_EFFORT", IMPLEMENTATION_EFFORT
    ).strip()
    fallback_raw = os.environ.get("FORGEFLOW_IMPLEMENTATION_FALLBACK_MODEL_ID")
    fallback = (
        IMPLEMENTATION_FALLBACK_MODEL_ID
        if fallback_raw is None
        else fallback_raw.strip() or None
    )
    if not model_id:
        raise ModelPolicyError("IMPLEMENTATION_MODEL_ID_EMPTY")
    if not effort:
        raise ModelPolicyError("IMPLEMENTATION_EFFORT_EMPTY")
    if fallback == model_id:
        raise ModelPolicyError("IMPLEMENTATION_FALLBACK_EQUALS_PRIMARY")
    return model_id, effort, fallback


def _resolve_route_config(route_config_path: Path | None) -> Path | None:
    if route_config_path is not None:
        return route_config_path
    raw = os.environ.get("FORGEFLOW_ROUTE_CONFIG_FILE", "").strip()
    return Path(raw) if raw else None


def _project_reasoning_preference(
    registry: RouteRegistry, owner: str | None, repo: str | None
) -> tuple[str, ...]:
    """Return this project's validated REASONING preference, if any."""
    if not (owner and repo):
        return ()
    try:
        preferences = load_project_route_preferences(registry, owner=owner, repo=repo)
    except RouteConfigError as exc:
        raise ModelPolicyError(f"REASONING_ROUTE_PREFERENCE_INVALID:{exc}") from exc
    return preferences.preferred_ids("REASONING")


def reasoning_routes(
    route_config_path: Path | None = None,
    *,
    owner: str | None = None,
    repo: str | None = None,
) -> tuple[RouteDefinition, ...]:
    """Return the ordered eligible REASONING routes for one project.

    The project may explicitly prefer one existing REASONING route. The selected
    primary is that route when eligible, otherwise the unmodified global primary.
    The fallback is the next eligible route in global priority order after the
    selected primary, so a selected route never gains a fallback that would
    reorder global priorities for other projects. When no route config is
    deployed (isolated library/tests) an empty tuple is returned.
    """
    configured = _resolve_route_config(route_config_path)
    if configured is None:
        return ()
    registry = load_route_registry(configured)
    preferred = _project_reasoning_preference(registry, owner, repo)
    eligible = registry.eligible("REASONING")
    if not eligible:
        raise ModelPolicyError("REASONING_ROUTE_EXHAUSTED")
    unsupported = [route.id for route in eligible if route.runtime != "OPEN_SWE"]
    if unsupported:
        raise ModelPolicyError(
            "REASONING_ROUTE_RUNTIME_UNSUPPORTED:" + ",".join(unsupported)
        )
    if len(eligible) > 2:
        raise ModelPolicyError("REASONING_ROUTE_COUNT_UNSUPPORTED")

    primary = registry.select("REASONING", preferred_ids=preferred)
    if primary is None:  # defensive: eligible is non-empty above
        raise ModelPolicyError("REASONING_ROUTE_EXHAUSTED")
    selected: list[RouteDefinition] = [primary]
    for index, route in enumerate(eligible):
        if route.id == primary.id:
            if index + 1 < len(eligible):
                selected.append(eligible[index + 1])
            break
    return tuple(selected)


def reasoning_model_ids(
    route_config_path: Path | None = None,
    *,
    owner: str | None = None,
    repo: str | None = None,
) -> tuple[str, str | None]:
    """Return the eligible ordered Open SWE model pair for the REASONING role.

    The deployed service always provides ``FORGEFLOW_ROUTE_CONFIG_FILE``. The
    constant pair is retained only for isolated library/tests that intentionally
    construct Open SWE without the ForgeFlow deployment environment. Passing
    ``owner``/``repo`` applies that project's validated REASONING preference.
    """
    configured = _resolve_route_config(route_config_path)
    if configured is None:
        return REVIEW_MODEL_ID, REVIEW_FALLBACK_MODEL_ID
    routes = reasoning_routes(configured, owner=owner, repo=repo)
    models = tuple(route.target for route in routes)
    primary = models[0]
    fallback = models[1] if len(models) > 1 else None
    return primary, fallback


def review_model_id() -> str:
    """Current primary reviewer model selected from the REASONING registry."""
    return reasoning_model_ids()[0]


def fallback_model_id_for(primary_model_id: str) -> str | None:
    """Return role-safe model fallback for Open SWE's native fallback middleware."""
    implementation_model, _effort, implementation_fallback = implementation_model_policy()
    if primary_model_id == implementation_model:
        return implementation_fallback
    if implementation_fallback and primary_model_id == implementation_fallback:
        return None

    # Reviewer fallback is installed only inside the dedicated reviewer graph.
    # Keeping Sol out of this global hook prevents a regular agent that happens
    # to use Sol from inheriting the REASONING route by accident.
    if primary_model_id == REVIEW_MODEL_ID:
        return None
    return _original_fallback_model_id_for(primary_model_id)


def install_forgeflow_model_policy() -> None:
    """Install the narrow fallback hook before upstream agent graphs are imported."""
    global _installed
    if _installed:
        return
    upstream_model.fallback_model_id_for = fallback_model_id_for
    server = sys.modules.get("agent.server")
    if server is not None:
        server.fallback_model_id_for = fallback_model_id_for
    _installed = True


__all__ = [
    "IMPLEMENTATION_EFFORT",
    "IMPLEMENTATION_FALLBACK_MODEL_ID",
    "IMPLEMENTATION_MODEL_ID",
    "REVIEW_FALLBACK_MODEL_ID",
    "REVIEW_MODEL_ID",
    "ModelPolicyError",
    "fallback_model_id_for",
    "implementation_model_policy",
    "install_forgeflow_model_policy",
    "reasoning_model_ids",
    "reasoning_routes",
    "review_model_id",
]
