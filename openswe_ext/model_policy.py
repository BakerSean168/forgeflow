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
    "review_model_id",
]
