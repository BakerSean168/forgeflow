"""ForgeFlow overlay for provider-capacity failures that upstream Open SWE misses.

Some OpenAI-compatible gateways surface exhausted prepaid/provider quota as HTTP
402/403 rather than 429.  A generic 403 must remain a hard permission failure,
so this overlay only treats a narrow set of quota/balance markers as transient
route-capacity exhaustion.  That lets Open SWE's existing ModelFallbackMiddleware
try the configured secondary model without forking the middleware implementation.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from agent.middleware import model_errors, model_fallback
from agent.utils import errors

_CAPACITY_STATUSES = frozenset({402, 403})
_CAPACITY_MARKERS = (
    "额度不足",
    "余额不足",
    "insufficient quota",
    "insufficient balance",
    "insufficient credit",
    "insufficient credits",
    "quota exhausted",
    "quota exceeded",
    "credit exhausted",
    "credits exhausted",
    "balance exhausted",
    "out of credits",
)

_original_should_fallback: Callable[[BaseException], bool] = model_fallback._should_fallback
_original_classify_exception: Callable[[BaseException], str | None] = errors.classify_exception
_installed = False


def _body_text(value: Any) -> str:
    if value is None:
        return ""
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(value)


def is_provider_capacity_exhaustion(exc: BaseException) -> bool:
    """Return true only for quota/balance exhaustion disguised as 402/403."""

    status = getattr(exc, "status_code", None)
    if status not in _CAPACITY_STATUSES:
        return False
    body = getattr(exc, "body", None)
    haystack = f"{exc} {_body_text(body)}".casefold()
    return any(marker.casefold() in haystack for marker in _CAPACITY_MARKERS)


def should_fallback(exc: BaseException) -> bool:
    return _original_should_fallback(exc) or is_provider_capacity_exhaustion(exc)


def classify_exception(exc: BaseException) -> str | None:
    if is_provider_capacity_exhaustion(exc):
        return "provider_quota_exhausted"
    return _original_classify_exception(exc)


def install_provider_fallback_overlay() -> None:
    """Install the narrow compatibility overlay once per interpreter."""

    global _installed
    if _installed:
        return
    model_fallback._should_fallback = should_fallback
    errors.classify_exception = classify_exception
    # ModelErrorMiddleware imported classify_exception by value.
    model_errors.classify_exception = classify_exception
    _installed = True


__all__ = [
    "classify_exception",
    "install_provider_fallback_overlay",
    "is_provider_capacity_exhaustion",
    "should_fallback",
]
