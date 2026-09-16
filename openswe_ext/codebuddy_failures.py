"""Normalize non-secret CodeBuddy response text into stable ForgeFlow failure codes."""

from __future__ import annotations

_RATE_LIMIT_MARKERS = (
    "rate limit",
    "rate-limit",
    "rate limited",
    "too many requests",
    "usage limit",
    "quota exceeded",
    "usage exceeded",
    "frequency limit",
    "频率限制",
    "使用量已超出",
    "额度已用完",
    "额度不足",
)
_AUTH_MARKERS = (
    "authentication required",
    "please use /login",
    "not authenticated",
    "login required",
)
_MODEL_MARKERS = (
    "service info not found",
    "supported models",
    "model unavailable",
    "model not found",
)


def classify_codebuddy_response(text: str) -> str | None:
    """Classify bounded CodeBuddy output without persisting or exposing the response.

    The CodeBuddy CLI currently reports account throttling as a successful process
    whose text starts with HTTP 429, while native ACP may surface the same server
    response as ``stop_reason=refusal``.  ForgeFlow needs a stable route-level code
    so the policy can fail over instead of retrying the task as if it were a code
    failure.
    """

    normalized = text.casefold().strip()
    if not normalized:
        return None
    if normalized.startswith("429 ") or any(marker in normalized for marker in _RATE_LIMIT_MARKERS):
        return "CODEBUDDY_RATE_LIMITED"
    if any(marker in normalized for marker in _AUTH_MARKERS):
        return "CODEBUDDY_AUTH_UNAVAILABLE"
    if any(marker in normalized for marker in _MODEL_MARKERS):
        return "CODEBUDDY_MODEL_UNAVAILABLE"
    return None


__all__ = ["classify_codebuddy_response"]
