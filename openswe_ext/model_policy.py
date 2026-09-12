"""ForgeFlow-specific Open SWE model routing policy.

Keep provider selection outside upstream Open SWE. ForgeFlow uses the short-lived
GLM 5.3 promotional resource for implementation/repair, falls back to Luna only
for that role, and keeps the independent Sol reviewer on its existing OAuth path.
"""

from __future__ import annotations

import sys
from collections.abc import Callable

import agent.utils.model as upstream_model

IMPLEMENTATION_MODEL_ID = "fireworks:accounts/fireworks/models/glm-5p3"
IMPLEMENTATION_EFFORT = "max"
IMPLEMENTATION_FALLBACK_MODEL_ID = "openai:gpt-5.6-luna"
REVIEW_MODEL_ID = "openai:gpt-5.6-sol"

_original_fallback_model_id_for: Callable[[str], str | None] = upstream_model.fallback_model_id_for
_installed = False


def fallback_model_id_for(primary_model_id: str) -> str | None:
    """Return ForgeFlow's role-safe fallback without crossing reviewer boundaries."""
    if primary_model_id == IMPLEMENTATION_MODEL_ID:
        return IMPLEMENTATION_FALLBACK_MODEL_ID
    if primary_model_id in {IMPLEMENTATION_FALLBACK_MODEL_ID, REVIEW_MODEL_ID}:
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
    "REVIEW_MODEL_ID",
    "fallback_model_id_for",
    "install_forgeflow_model_policy",
]
