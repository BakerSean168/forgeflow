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

from openswe_ext.model_policy import reasoning_model_ids

_installed = False
_original_create_deep_agent: Callable[..., Any] = upstream_reviewer.create_deep_agent


def _model_name(model: Any) -> str:
    return str(getattr(model, "model_name", None) or getattr(model, "model", None) or "")


def _matches_model_id(model: Any, model_id: str) -> bool:
    expected = model_id.split(":", 1)[-1]
    actual = _model_name(model)
    return actual == expected or actual == model_id


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

    primary_id, fallback_id = reasoning_model_ids()
    if fallback_id is None or not _matches_model_id(model, primary_id):
        return _original_create_deep_agent(*args, **kwargs)

    # REASONING fallbacks are exact ForgeFlow routes. Do not let LangSmith/team
    # gateway settings remap the fallback resource; the Fireworks provider uses
    # the scoped private LiteLLM base/key exported by the ForgeFlow service.
    fallback_model = upstream_reviewer._make_model_or_defer(
        fallback_id,
        use_gateway=False,
        max_tokens=upstream_reviewer.DEFAULT_LLM_MAX_TOKENS,
    )
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
            if (
                subagent_model is not None
                and _matches_model_id(subagent_model, primary_id)
                and isinstance(subagent_middleware, list)
            ):
                subagent["middleware"] = _with_fallback(
                    list(subagent_middleware), fallback_model
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
