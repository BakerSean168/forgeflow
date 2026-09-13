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

from forgeflow.routing import load_route_registry

IMPLEMENTATION_MODEL_ID = "fireworks:accounts/fireworks/models/glm-5p3"
IMPLEMENTATION_EFFORT = "max"
IMPLEMENTATION_FALLBACK_MODEL_ID = "openai:gpt-5.6-luna"
REVIEW_MODEL_ID = "openai:gpt-5.6-sol"
REVIEW_FALLBACK_MODEL_ID = IMPLEMENTATION_MODEL_ID

_original_fallback_model_id_for: Callable[[str], str | None] = upstream_model.fallback_model_id_for
_installed = False


class ModelPolicyError(RuntimeError):
    """The configured model route cannot be represented by the Open SWE runtime."""


def reasoning_model_ids(route_config_path: Path | None = None) -> tuple[str, str | None]:
    """Return the eligible ordered Open SWE model pair for the REASONING role.

    The deployed service always provides ``FORGEFLOW_ROUTE_CONFIG_FILE``. The
    constant pair is retained only for isolated library/tests that intentionally
    construct Open SWE without the ForgeFlow deployment environment.
    """
    configured = route_config_path
    if configured is None:
        raw = os.environ.get("FORGEFLOW_ROUTE_CONFIG_FILE", "").strip()
        configured = Path(raw) if raw else None
    if configured is None:
        return REVIEW_MODEL_ID, REVIEW_FALLBACK_MODEL_ID

    registry = load_route_registry(configured)
    eligible = registry.eligible("REASONING")
    if not eligible:
        raise ModelPolicyError("REASONING_ROUTE_EXHAUSTED")
    unsupported = [route.id for route in eligible if route.runtime != "OPEN_SWE"]
    if unsupported:
        raise ModelPolicyError(
            "REASONING_ROUTE_RUNTIME_UNSUPPORTED:" + ",".join(unsupported)
        )
    models = tuple(route.target for route in eligible)
    if len(models) > 2:
        raise ModelPolicyError("REASONING_ROUTE_COUNT_UNSUPPORTED")
    primary = models[0]
    fallback = models[1] if len(models) > 1 else None
    return primary, fallback


def review_model_id() -> str:
    """Current primary reviewer model selected from the REASONING registry."""
    return reasoning_model_ids()[0]


def fallback_model_id_for(primary_model_id: str) -> str | None:
    """Return role-safe model fallback for Open SWE's native fallback middleware."""
    if primary_model_id == IMPLEMENTATION_MODEL_ID:
        return IMPLEMENTATION_FALLBACK_MODEL_ID
    if primary_model_id == IMPLEMENTATION_FALLBACK_MODEL_ID:
        return None

    review_primary, review_fallback = reasoning_model_ids()
    if primary_model_id == review_primary:
        return review_fallback
    if review_fallback is not None and primary_model_id == review_fallback:
        return None
    if primary_model_id == REVIEW_MODEL_ID:
        # A non-default route config may deliberately remove Sol. Do not route
        # an explicitly requested stale Sol reviewer outside that registry.
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
    "install_forgeflow_model_policy",
    "reasoning_model_ids",
    "review_model_id",
]
