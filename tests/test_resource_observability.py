from __future__ import annotations

import os
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from forgeflow.attempts import RouteAttemptSummary
from forgeflow.resource_probes import ResourceProbeRecord
from openswe_ext import resource_observability as health
from openswe_ext.codebuddy_auth import OFFICIAL_AUTH_FILE, inspect_codebuddy_auth


def _auth_dir(tmp_path: Path, *, now: datetime, refresh_delta: timedelta) -> Path:
    auth_dir = tmp_path / "auth"
    auth_dir.mkdir()
    import json

    def ms(value: datetime) -> int:
        return round(value.timestamp() * 1000)

    (auth_dir / OFFICIAL_AUTH_FILE).write_text(
        json.dumps(
            {
                "auth": {
                    "accessToken": "super-secret-access",
                    "refreshToken": "super-secret-refresh",
                    "lastRefreshTime": ms(now - timedelta(hours=1)),
                    "expiresAt": ms(now + timedelta(hours=2)),
                    "refreshExpiresAt": ms(now + refresh_delta),
                }
            }
        ),
        encoding="utf-8",
    )
    return auth_dir


def _binary(tmp_path: Path) -> Path:
    binary = tmp_path / "codebuddy"
    binary.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    binary.chmod(0o700)
    return binary


def _summary() -> RouteAttemptSummary:
    return RouteAttemptSummary(
        route_id="codebuddy-account-primary",
        attempt_count=4,
        finished_count=4,
        open_count=0,
        succeeded_count=3,
        failed_count=1,
        blocked_count=0,
        recent_attempt_count=2,
        recent_succeeded_count=1,
        recent_failed_count=1,
        recent_blocked_count=0,
        last_started_at="2026-09-14T02:00:00+00:00",
        last_finished_at="2026-09-14T02:01:00+00:00",
        last_success_at="2026-09-13T02:01:00+00:00",
        last_outcome="FAILED",
        last_failure_class="TASK_FAILURE",
        last_fallback_reason=None,
        last_duration_ms=60_000,
    )


def test_codebuddy_auth_health_reports_expiry_without_exposing_tokens(tmp_path: Path) -> None:
    now = datetime(2026, 9, 14, 3, 0, tzinfo=UTC)
    auth_dir = _auth_dir(tmp_path, now=now, refresh_delta=timedelta(days=7))
    view = inspect_codebuddy_auth(
        {"HOME": str(tmp_path), "FORGEFLOW_CODEBUDDY_AUTH_STATE_DIR": str(auth_dir)},
        now=now,
    )
    assert view["status"] == "READY"
    assert view["authenticated"] is True
    assert view["accessTokenFresh"] is True
    serialized = repr(view)
    assert "super-secret-access" not in serialized
    assert "super-secret-refresh" not in serialized
    assert "accessToken" not in view
    assert "refreshToken" not in view


def test_codebuddy_auth_health_warns_before_refresh_expiry(tmp_path: Path) -> None:
    now = datetime(2026, 9, 14, 3, 0, tzinfo=UTC)
    auth_dir = _auth_dir(tmp_path, now=now, refresh_delta=timedelta(hours=12))
    view = inspect_codebuddy_auth(
        {"HOME": str(tmp_path), "FORGEFLOW_CODEBUDDY_AUTH_STATE_DIR": str(auth_dir)},
        now=now,
    )
    assert view["status"] == "EXPIRING_SOON"
    assert view["secondsUntilRefreshExpiry"] == 12 * 60 * 60


def test_codebuddy_observability_combines_auth_probe_and_attempts(tmp_path: Path) -> None:
    now = datetime(2026, 9, 14, 3, 0, tzinfo=UTC)
    auth_dir = _auth_dir(tmp_path, now=now, refresh_delta=timedelta(days=7))
    binary = _binary(tmp_path)
    probe = ResourceProbeRecord(
        route_id="codebuddy-account-primary",
        status="AVAILABLE",
        checked_at=(now - timedelta(minutes=5)).isoformat(),
        model="deepseek-v4.1-flash",
        duration_ms=400,
    )
    view = health.codebuddy_observability(
        values={
            "HOME": str(tmp_path),
            "FORGEFLOW_CODEBUDDY_AUTH_STATE_DIR": str(auth_dir),
            "FORGEFLOW_CODEBUDDY_BIN": str(binary),
        },
        attempts=_summary(),
        probe=probe,
        configured_health="READY",
        enabled=True,
        now=now,
    )
    assert view["status"] == "READY"
    assert view["modelProbe"]["status"] == "AVAILABLE"
    assert view["modelProbe"]["ageSeconds"] == 300
    assert view["attempts"]["total"] == 4
    assert view["attempts"]["last24h"]["total"] == 2
    assert view["attempts"]["lastSuccessAt"] == "2026-09-13T02:01:00+00:00"


def test_explicit_probe_uses_exact_model_and_never_inherits_unrelated_secrets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    now = datetime.now(UTC)
    auth_dir = _auth_dir(tmp_path, now=now, refresh_delta=timedelta(days=7))
    binary = _binary(tmp_path)
    captured: dict[str, object] = {}

    def fake_run(command, **kwargs):
        captured["command"] = command
        captured["env"] = kwargs["env"]
        return subprocess.CompletedProcess(command, 0, stdout="FORGEFLOW_CODEBUDDY_HEALTH_OK\n")

    monkeypatch.setattr(health.subprocess, "run", fake_run)
    status, duration_ms, failure_code = health.probe_codebuddy_model(
        {
            "HOME": str(tmp_path),
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "FORGEFLOW_CODEBUDDY_AUTH_STATE_DIR": str(auth_dir),
            "FORGEFLOW_CODEBUDDY_BIN": str(binary),
            "FORGEFLOW_CODEBUDDY_MODEL": "deepseek-v4.1-flash",
            "FIREWORKS_API_KEY": "must-not-leak",
            "OPEN_SWE_OPENAI_OAUTH_BROKER_TOKEN": "must-not-leak-either",
        }
    )
    assert status == "AVAILABLE"
    assert duration_ms >= 0
    assert failure_code is None
    command = captured["command"]
    assert isinstance(command, list)
    assert "deepseek-v4.1-flash" in command
    env = captured["env"]
    assert isinstance(env, dict)
    assert "FIREWORKS_API_KEY" not in env
    assert "OPEN_SWE_OPENAI_OAUTH_BROKER_TOKEN" not in env


def test_explicit_probe_classifies_codebuddy_429_as_rate_limited(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    now = datetime.now(UTC)
    auth_dir = _auth_dir(tmp_path, now=now, refresh_delta=timedelta(days=7))
    binary = _binary(tmp_path)

    def fake_run(command, **kwargs):
        del kwargs
        return subprocess.CompletedProcess(
            command,
            0,
            stdout=(
                "429 您的使用量已超出频率限制，将在 2026-09-16 15:42:36 UTC+8 重置，"
                "您也可以切换其他模型继续使用。\n"
            ),
        )

    monkeypatch.setattr(health.subprocess, "run", fake_run)
    status, duration_ms, failure_code = health.probe_codebuddy_model(
        {
            "HOME": str(tmp_path),
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "FORGEFLOW_CODEBUDDY_AUTH_STATE_DIR": str(auth_dir),
            "FORGEFLOW_CODEBUDDY_BIN": str(binary),
            "FORGEFLOW_CODEBUDDY_MODEL": "deepseek-v4.1-flash",
        }
    )

    assert status == "UNAVAILABLE"
    assert duration_ms >= 0
    assert failure_code == "CODEBUDDY_PROBE_RATE_LIMITED"
