"""Non-secret resource health projection and explicit CodeBuddy model probing."""

from __future__ import annotations

import os
import subprocess
import tempfile
import time
from collections.abc import Mapping
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from forgeflow.attempts import RouteAttemptSummary
from forgeflow.resource_probes import ResourceProbeRecord
from openswe_ext.codebuddy_auth import inspect_codebuddy_auth

_CODEBUDDY_MARKER = "FORGEFLOW_CODEBUDDY_HEALTH_OK"


def codebuddy_observability(
    *,
    values: Mapping[str, str],
    attempts: RouteAttemptSummary | None,
    probe: ResourceProbeRecord | None,
    configured_health: str,
    enabled: bool,
    now: datetime | None = None,
) -> dict[str, Any]:
    reference = (now or datetime.now(UTC)).astimezone(UTC)
    binary = Path(
        values.get("FORGEFLOW_CODEBUDDY_BIN", str(Path.home() / ".local/bin/codebuddy"))
    ).expanduser()
    executable = binary.is_file() and os.access(binary, os.X_OK)
    auth = inspect_codebuddy_auth(values, now=reference)
    probe_view = _probe_view(probe, now=reference)
    attempt_view = _attempt_view(attempts)

    status = "READY" if enabled else "DISABLED"
    if enabled and configured_health != "READY":
        status = configured_health
    needs_attention = False
    reasons: list[str] = []
    if enabled:
        if not executable:
            status = "UNAVAILABLE"
            needs_attention = True
            reasons.append("binary_missing")
        if auth["status"] in {"MISSING", "INVALID", "EXPIRED"}:
            status = "UNAVAILABLE"
            needs_attention = True
            reasons.append(f"auth_{str(auth['status']).casefold()}")
        elif auth["status"] == "EXPIRING_SOON" and status != "UNAVAILABLE":
            status = "DEGRADED"
            needs_attention = True
            reasons.append("auth_expiring_soon")
        if probe is None:
            if status == "READY":
                status = "UNKNOWN"
            reasons.append("model_not_probed")
        elif probe.status == "UNAVAILABLE":
            needs_attention = True
            reasons.append("model_probe_failed")
            if status != "UNAVAILABLE":
                status = "DEGRADED"
        if attempts is not None and attempts.last_failure_class == "ROUTE_AVAILABILITY":
            needs_attention = True
            reasons.append("recent_route_availability_failure")
            if status == "READY":
                status = "DEGRADED"

    return {
        "status": status,
        "needsAttention": needs_attention,
        "reasons": reasons,
        "binary": {
            "status": "READY" if executable else "MISSING",
            "executable": executable,
        },
        "auth": auth,
        "modelProbe": probe_view,
        "attempts": attempt_view,
    }


def generic_route_observability(
    *, attempts: RouteAttemptSummary | None, configured_health: str, enabled: bool
) -> dict[str, Any]:
    if not enabled:
        status = "DISABLED"
    elif configured_health != "READY":
        status = configured_health
    else:
        status = "READY"
    needs_attention = bool(
        attempts is not None and attempts.last_failure_class == "ROUTE_AVAILABILITY"
    )
    if status == "READY" and needs_attention:
        status = "DEGRADED"
    return {
        "status": status,
        "needsAttention": needs_attention,
        "reasons": ["recent_route_availability_failure"] if needs_attention else [],
        "binary": None,
        "auth": None,
        "modelProbe": None,
        "attempts": _attempt_view(attempts),
    }


def probe_codebuddy_model(
    values: Mapping[str, str],
    *,
    timeout_seconds: int = 60,
) -> tuple[str, int, str | None]:
    """Run one explicit no-tools model probe without persisting model output.

    Returns ``(status, duration_ms, failure_code)`` where status is AVAILABLE or
    UNAVAILABLE. The caller decides whether/where to cache the bounded result.
    """

    binary = Path(
        values.get("FORGEFLOW_CODEBUDDY_BIN", str(Path.home() / ".local/bin/codebuddy"))
    ).expanduser()
    model = values.get("FORGEFLOW_CODEBUDDY_MODEL", "deepseek-v4.1-flash").strip()
    if not binary.is_file() or not os.access(binary, os.X_OK):
        return "UNAVAILABLE", 0, "CODEBUDDY_PROBE_BINARY_MISSING"
    auth = inspect_codebuddy_auth(values)
    if auth["status"] in {"MISSING", "INVALID", "EXPIRED"}:
        return "UNAVAILABLE", 0, "CODEBUDDY_PROBE_AUTH_UNAVAILABLE"
    if not model:
        return "UNAVAILABLE", 0, "CODEBUDDY_PROBE_MODEL_REQUIRED"

    child_env = {
        "HOME": values.get("HOME", str(Path.home())),
        "PATH": values.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "LANG": values.get("LANG", "C.UTF-8"),
        "LC_ALL": values.get("LC_ALL", "C.UTF-8"),
        "CODEBUDDY_DISABLE_AUTO_MEMORY": "1",
    }
    internet_environment = values.get("FORGEFLOW_CODEBUDDY_INTERNET_ENVIRONMENT", "internal").strip()
    if internet_environment:
        child_env["CODEBUDDY_INTERNET_ENVIRONMENT"] = internet_environment
    started = time.monotonic()
    try:
        with tempfile.TemporaryDirectory(prefix="forgeflow-codebuddy-health-") as cwd:
            completed = subprocess.run(
                [
                    str(binary),
                    "-p",
                    f"Reply exactly {_CODEBUDDY_MARKER} and do not call tools.",
                    "--model",
                    model,
                    "--output-format",
                    "text",
                    "--permission-mode",
                    "plan",
                    "--setting-sources",
                    "user",
                    "--no-session-persistence",
                    "--max-turns",
                    "1",
                ],
                cwd=cwd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                check=False,
                timeout=timeout_seconds,
                env=child_env,
            )
    except subprocess.TimeoutExpired:
        duration_ms = round((time.monotonic() - started) * 1000)
        return "UNAVAILABLE", duration_ms, "CODEBUDDY_PROBE_TIMEOUT"
    duration_ms = round((time.monotonic() - started) * 1000)
    output = completed.stdout or ""
    if completed.returncode == 0 and output.strip() == _CODEBUDDY_MARKER:
        return "AVAILABLE", duration_ms, None
    lowered = output.casefold()
    if "authentication required" in lowered or "please use /login" in lowered:
        code = "CODEBUDDY_PROBE_AUTH_UNAVAILABLE"
    elif "service info not found" in lowered or "supported models" in lowered:
        code = "CODEBUDDY_PROBE_MODEL_UNAVAILABLE"
    elif completed.returncode != 0:
        code = "CODEBUDDY_PROBE_PROCESS_FAILED"
    else:
        code = "CODEBUDDY_PROBE_UNEXPECTED_RESPONSE"
    return "UNAVAILABLE", duration_ms, code


def _probe_view(record: ResourceProbeRecord | None, *, now: datetime) -> dict[str, Any] | None:
    if record is None:
        return None
    checked = datetime.fromisoformat(record.checked_at).astimezone(UTC)
    return {
        "status": record.status,
        "checkedAt": record.checked_at,
        "ageSeconds": max(0, round((now - checked).total_seconds())),
        "model": record.model,
        "durationMs": record.duration_ms,
        "failureCode": record.failure_code,
    }


def _attempt_view(summary: RouteAttemptSummary | None) -> dict[str, Any]:
    if summary is None:
        return {
            "total": 0,
            "finished": 0,
            "open": 0,
            "succeeded": 0,
            "failed": 0,
            "blocked": 0,
            "last24h": {"total": 0, "succeeded": 0, "failed": 0, "blocked": 0},
            "lastStartedAt": None,
            "lastFinishedAt": None,
            "lastSuccessAt": None,
            "lastOutcome": None,
            "lastFailureClass": None,
            "lastFallbackReason": None,
            "lastDurationMs": None,
        }
    raw = asdict(summary)
    return {
        "total": raw["attempt_count"],
        "finished": raw["finished_count"],
        "open": raw["open_count"],
        "succeeded": raw["succeeded_count"],
        "failed": raw["failed_count"],
        "blocked": raw["blocked_count"],
        "last24h": {
            "total": raw["recent_attempt_count"],
            "succeeded": raw["recent_succeeded_count"],
            "failed": raw["recent_failed_count"],
            "blocked": raw["recent_blocked_count"],
        },
        "lastStartedAt": raw["last_started_at"],
        "lastFinishedAt": raw["last_finished_at"],
        "lastSuccessAt": raw["last_success_at"],
        "lastOutcome": raw["last_outcome"],
        "lastFailureClass": raw["last_failure_class"],
        "lastFallbackReason": raw["last_fallback_reason"],
        "lastDurationMs": raw["last_duration_ms"],
    }


__all__ = [
    "codebuddy_observability",
    "generic_route_observability",
    "probe_codebuddy_model",
]
