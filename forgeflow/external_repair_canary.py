"""External repair canary readiness value for the external agent handoff."""

from __future__ import annotations


def external_repair_canary_value() -> str:
    """Return the readiness marker asserted by the canary test."""
    return "ready"
