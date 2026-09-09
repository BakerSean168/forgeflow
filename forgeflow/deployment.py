"""Fail-closed checks for the isolated sandbox used by the official reviewer."""

import os
from dataclasses import dataclass

_ISOLATED_PROVIDER_KEYS: dict[str, tuple[tuple[str, ...], ...]] = {
    "langsmith": (("SANDBOX_LANGSMITH_API_KEY", "LANGSMITH_API_KEY"),),
    "daytona": (("DAYTONA_API_KEY",),),
    "runloop": (("RUNLOOP_API_KEY",),),
    "e2b": (("E2B_API_KEY",),),
    "modal": (("MODAL_TOKEN_ID",), ("MODAL_TOKEN_SECRET",)),
}


@dataclass(frozen=True, slots=True)
class ReviewerSandboxPreflight:
    ready: bool
    provider: str
    failure_code: str | None = None


def reviewer_sandbox_preflight() -> ReviewerSandboxPreflight:
    provider = os.environ.get("SANDBOX_TYPE", "langsmith").strip().casefold() or "langsmith"
    if provider == "local":
        return ReviewerSandboxPreflight(False, provider, "LOCAL_SANDBOX_FORBIDDEN")
    requirements = _ISOLATED_PROVIDER_KEYS.get(provider)
    if requirements is None:
        return ReviewerSandboxPreflight(False, provider, "UNSUPPORTED_REVIEWER_SANDBOX")
    for alternatives in requirements:
        if not any(os.environ.get(name, "").strip() for name in alternatives):
            return ReviewerSandboxPreflight(False, provider, "REVIEWER_SANDBOX_CREDENTIAL_MISSING")
    return ReviewerSandboxPreflight(True, provider)
