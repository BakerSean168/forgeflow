"""Fail-closed checks for the isolated sandbox used by Open SWE."""

import os
import shutil
import subprocess
from dataclasses import dataclass

_REMOTE_PROVIDER_KEYS: dict[str, tuple[tuple[str, ...], ...]] = {
    "langsmith": (("SANDBOX_LANGSMITH_API_KEY", "LANGSMITH_API_KEY"),),
    "daytona": (("DAYTONA_API_KEY",),),
    "runloop": (("RUNLOOP_API_KEY",),),
    "e2b": (("E2B_API_KEY",),),
    "modal": (("MODAL_TOKEN_ID",), ("MODAL_TOKEN_SECRET",)),
}
_DEFAULT_DOCKER_IMAGE = "forgeflow/openswe-sandbox:bookworm-node24"
_DEFAULT_DOCKER_NETWORK = "openswe-sandbox"


@dataclass(frozen=True, slots=True)
class ReviewerSandboxPreflight:
    ready: bool
    provider: str
    failure_code: str | None = None


def _command_ok(args: list[str]) -> bool:
    try:
        result = subprocess.run(
            args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def _docker_runtime_ready() -> bool:
    if shutil.which("docker") is None:
        return False
    image = os.environ.get("OPEN_SWE_DOCKER_IMAGE", _DEFAULT_DOCKER_IMAGE)
    network = os.environ.get("OPEN_SWE_DOCKER_NETWORK", _DEFAULT_DOCKER_NETWORK)
    return all(
        (
            _command_ok(["docker", "info"]),
            _command_ok(["docker", "image", "inspect", image]),
            _command_ok(["docker", "network", "inspect", network]),
        )
    )


def reviewer_sandbox_preflight() -> ReviewerSandboxPreflight:
    provider = os.environ.get("SANDBOX_TYPE", "docker").strip().casefold() or "docker"
    if provider == "local":
        return ReviewerSandboxPreflight(False, provider, "LOCAL_SANDBOX_FORBIDDEN")
    if provider == "docker":
        if not _docker_runtime_ready():
            return ReviewerSandboxPreflight(False, provider, "DOCKER_SANDBOX_RUNTIME_UNAVAILABLE")
        return ReviewerSandboxPreflight(True, provider)
    requirements = _REMOTE_PROVIDER_KEYS.get(provider)
    if requirements is None:
        return ReviewerSandboxPreflight(False, provider, "UNSUPPORTED_REVIEWER_SANDBOX")
    for alternatives in requirements:
        if not any(os.environ.get(name, "").strip() for name in alternatives):
            return ReviewerSandboxPreflight(False, provider, "REVIEWER_SANDBOX_CREDENTIAL_MISSING")
    return ReviewerSandboxPreflight(True, provider)
