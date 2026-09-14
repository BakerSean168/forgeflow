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


def _external_implementation_profile(route: RouteDefinition | None) -> dict[str, Any]:
    adapter = (route.adapter if route is not None else None) or "external-acp"
    normalized = adapter.casefold()
    if normalized == "antigravity":
        model = os.environ.get("FORGEFLOW_ANTIGRAVITY_MODEL", "gemini-3.8-flash-high").strip()
        effort = os.environ.get("FORGEFLOW_ANTIGRAVITY_EFFORT", "high").strip()
        provider = {
            "id": "google-account",
            "name": "Google Account",
            "transport": "Antigravity native",
        }
        agent = {"id": "antigravity", "name": "Antigravity", "harness": "ACP"}
        model_name = model
    elif normalized == "codebuddy":
        model = os.environ.get("FORGEFLOW_CODEBUDDY_MODEL", "deepseek-v4-flash").strip()
        effort = None
        provider = {
            "id": "codebuddy-account",
            "name": "CodeBuddy Account",
            "transport": "CodeBuddy native ACP",
        }
        agent = {"id": "codebuddy", "name": "CodeBuddy", "harness": "ACP"}
        model_name = (
            "DeepSeek V4.1 Flash"
            if model in {"deepseek-flash", "deepseek-v4-flash", "deepseek-v4.1-flash"}
            else model
        )
    else:
        model = None
        effort = None
        provider = {
            "id": route.target if route is not None else "external-agent",
            "name": route.target if route is not None else "External Agent",
            "transport": "ACP",
        }
        agent = {"id": adapter, "name": adapter, "harness": "ACP"}
        model_name = None
    return {
        "role": "IMPLEMENT",
        "agent": agent,
        "provider": provider,
        "model": (
            None
            if model is None
            else {"id": model, "name": model_name, "effort": effort, "provider": provider}
        ),
        "fallbackModel": None,
    }


def implementation_profile(route: RouteDefinition | None, runtime: str | None) -> dict[str, Any] | None:
    if not runtime and route is None:
        return None
    if runtime == "EXTERNAL_ACP" or (route is not None and route.runtime == "EXTERNAL_ACP"):
        return _external_implementation_profile(route)
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
