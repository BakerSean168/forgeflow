"""Read-only execution labels for the ForgeFlow/Hermes operator surface.

Concrete Open SWE/external-agent/provider names belong in this integration layer,
not in the core ``forgeflow`` policy package.  These helpers project configured
runtime policy into UI-safe, non-secret descriptors only.
"""

from __future__ import annotations

import os
from typing import Any

from agent.utils.errors import LAST_MODEL_ERROR_KEY

from forgeflow.routing import RouteDefinition
from openswe_ext.model_policy import (
    IMPLEMENTATION_EFFORT,
    IMPLEMENTATION_FALLBACK_MODEL_ID,
    IMPLEMENTATION_MODEL_ID,
    reasoning_model_ids,
)


def provider_for_model(model_id: str) -> dict[str, str]:
    if model_id.startswith("openai:"):
        return {"id": "chatgpt-oauth", "name": "ChatGPT OAuth", "transport": "Codex OAuth broker"}
    if model_id.startswith("fireworks:"):
        return {"id": "private-litellm", "name": "Private LiteLLM", "transport": "Fireworks-compatible route"}
    if model_id.startswith("anthropic:"):
        return {"id": "anthropic", "name": "Anthropic", "transport": "native"}
    return {"id": "provider-native", "name": "Provider native", "transport": "native"}


def model_view(model_id: str | None, *, effort: str | None = None) -> dict[str, Any] | None:
    if not model_id:
        return None
    if model_id.startswith("fireworks:accounts/fireworks/models/"):
        name = model_id.removeprefix("fireworks:accounts/fireworks/models/")
    elif ":" in model_id:
        name = model_id.split(":", 1)[1]
    else:
        name = model_id
    return {
        "id": model_id,
        "name": name,
        "effort": effort,
        "provider": provider_for_model(model_id),
    }


def implementation_profile(route: RouteDefinition | None, runtime: str | None) -> dict[str, Any] | None:
    if not runtime and route is None:
        return None
    if runtime == "EXTERNAL_ACP" or (route is not None and route.runtime == "EXTERNAL_ACP"):
        model = os.environ.get("FORGEFLOW_ANTIGRAVITY_MODEL", "gemini-3.8-flash-high").strip()
        effort = os.environ.get("FORGEFLOW_ANTIGRAVITY_EFFORT", "high").strip()
        provider = {"id": "google-account", "name": "Google Account", "transport": "Antigravity native"}
        return {
            "role": "IMPLEMENT",
            "agent": {"id": "antigravity", "name": "Antigravity", "harness": "ACP"},
            "provider": provider,
            "model": {"id": model, "name": model, "effort": effort, "provider": provider},
            "fallbackModel": None,
        }
    return {
        "role": "IMPLEMENT",
        "agent": {"id": "open-swe-agent", "name": "Open SWE Agent", "harness": "Open SWE"},
        "provider": provider_for_model(IMPLEMENTATION_MODEL_ID),
        "model": model_view(IMPLEMENTATION_MODEL_ID, effort=IMPLEMENTATION_EFFORT),
        "fallbackModel": model_view(IMPLEMENTATION_FALLBACK_MODEL_ID, effort="xhigh"),
    }


def review_profile() -> dict[str, Any]:
    primary, fallback = reasoning_model_ids()
    return {
        "role": "REASONING",
        "agent": {"id": "open-swe-reviewer", "name": "Open SWE Reviewer", "harness": "Open SWE"},
        "provider": provider_for_model(primary),
        "model": model_view(primary, effort="medium"),
        "fallbackModel": model_view(fallback, effort="medium"),
    }


__all__ = [
    "LAST_MODEL_ERROR_KEY",
    "implementation_profile",
    "model_view",
    "provider_for_model",
    "review_profile",
]
