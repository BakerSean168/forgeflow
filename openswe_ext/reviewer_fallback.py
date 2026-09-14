"""ForgeFlow overlay that adds ordered REASONING fallback to Open SWE reviewer graphs.

Pinned Open SWE currently installs ``ModelFallbackMiddleware`` for the regular
agent factory but not for the dedicated reviewer or its review subagent. Keep
this overlay narrow: patch only ``agent.reviewer.create_deep_agent`` and only
when the reviewer model matches ForgeFlow's selected REASONING primary.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

import agent.reviewer as upstream_reviewer
from agent.middleware import ModelFallbackMiddleware

from openswe_ext.model_policy import (
    REVIEW_FALLBACK_MODEL_ID,
    REVIEW_MODEL_ID,
    reasoning_routes,
)

_installed = False
_original_create_deep_agent: Callable[..., Any] = upstream_reviewer.create_deep_agent


def _model_name(model: Any) -> str:
    return str(getattr(model, "model_name", None) or getattr(model, "model", None) or "")


def _matches_model_id(model: Any, model_id: str) -> bool:
    expected = model_id.split(":", 1)[-1]
    actual = _model_name(model)
    return actual == expected or actual == model_id


def _make_fallback_model(fallback_id: str) -> Any:
    # REASONING fallbacks are exact ForgeFlow routes. Do not let LangSmith/team
    # gateway settings remap the fallback resource; the Fireworks provider uses
    # the scoped private LiteLLM base/key exported by the ForgeFlow service.
    return upstream_reviewer._make_model_or_defer(
        fallback_id,
        use_gateway=False,
        max_tokens=upstream_reviewer.DEFAULT_LLM_MAX_TOKENS,
    )


def _reasoning_fallback_target(model: Any) -> str | None:
    """Return the next eligible REASONING route after ``model``'s route.

    The fallback is resolved from the global eligible priority order, so a
    project-selected reviewer primary keeps the same explicit fallback policy
    without mutating global priorities. When no route config is deployed the
    constant pair is preserved for isolated library/test construction.
    """
    routes = reasoning_routes()
    if not routes:
        return REVIEW_FALLBACK_MODEL_ID if _matches_model_id(model, REVIEW_MODEL_ID) else None
    for index, route in enumerate(routes):
        if _matches_model_id(model, route.target):
            return routes[index + 1].target if index + 1 < len(routes) else None
    return None


def _with_fallback(middleware: list[Any], fallback_model: Any) -> list[Any]:
    if any(isinstance(item, ModelFallbackMiddleware) for item in middleware):
        return middleware
    fallback = ModelFallbackMiddleware(fallback_model, surface_outage_message=False)
    insert_at = next(
        (
            index
            for index, item in enumerate(middleware)
            if item.__class__.__name__
            in {
                "SanitizeFireworksMessagesMiddleware",
                "SanitizeOpenAIResponsesMiddleware",
                "ModelErrorMiddleware",
            }
        ),
        len(middleware),
    )
    return [*middleware[:insert_at], fallback, *middleware[insert_at:]]


def _create_reviewer_deep_agent(*args: Any, **kwargs: Any) -> Any:
    model = kwargs.get("model")
    middleware = kwargs.get("middleware")
    if model is None or not isinstance(middleware, list):
        return _original_create_deep_agent(*args, **kwargs)

    fallback_id = _reasoning_fallback_target(model)
    if fallback_id is None:
        return _original_create_deep_agent(*args, **kwargs)
    fallback_model = _make_fallback_model(fallback_id)
    kwargs["middleware"] = _with_fallback(list(middleware), fallback_model)

    subagents = kwargs.get("subagents")
    if isinstance(subagents, list):
        rewritten: list[Any] = []
        for item in subagents:
            if not isinstance(item, Mapping):
                rewritten.append(item)
                continue
            subagent = dict(item)
            subagent_model = subagent.get("model")
            subagent_middleware = subagent.get("middleware")
            if subagent_model is not None and isinstance(subagent_middleware, list):
                subagent_fallback_id = _reasoning_fallback_target(subagent_model)
                if subagent_fallback_id is not None:
                    subagent_fallback = (
                        fallback_model
                        if subagent_fallback_id == fallback_id
                        else _make_fallback_model(subagent_fallback_id)
                    )
                    subagent["middleware"] = _with_fallback(
                        list(subagent_middleware), subagent_fallback
                    )
            rewritten.append(subagent)
        kwargs["subagents"] = rewritten

    return _original_create_deep_agent(*args, **kwargs)


def install_reviewer_fallback_overlay() -> None:
    """Install the reviewer-only fallback overlay once per interpreter."""
    global _installed
    if _installed:
        return
    upstream_reviewer.create_deep_agent = _create_reviewer_deep_agent
    _installed = True


__all__ = ["install_reviewer_fallback_overlay"]
