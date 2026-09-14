"""CodeBuddy official-login discovery and non-secret expiry inspection."""

from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

OFFICIAL_AUTH_FILE = "Tencent-Cloud.coding-copilot.info"


class CodeBuddyAuthError(RuntimeError):
    pass


def resolve_codebuddy_auth_dir(values: Mapping[str, str]) -> Path:
    home = Path(values.get("HOME", str(Path.home()))).expanduser()
    raw = values.get(
        "FORGEFLOW_CODEBUDDY_AUTH_STATE_DIR",
        str(home / ".local/share/CodeBuddyExtension/Data/Public/auth"),
    )
    try:
        auth_dir = Path(raw).expanduser().resolve(strict=True)
    except FileNotFoundError as exc:
        raise CodeBuddyAuthError("CODEBUDDY_OFFICIAL_AUTH_REQUIRED") from exc
    if not auth_dir.is_dir() or not (auth_dir / OFFICIAL_AUTH_FILE).is_file():
        raise CodeBuddyAuthError("CODEBUDDY_OFFICIAL_AUTH_REQUIRED")
    return auth_dir


def inspect_codebuddy_auth(
    values: Mapping[str, str],
    *,
    now: datetime | None = None,
    warning_window: timedelta = timedelta(hours=24),
) -> dict[str, Any]:
    """Return expiry-only official-login health; token values never leave this function."""

    reference = (now or datetime.now(UTC)).astimezone(UTC)
    try:
        auth_dir = resolve_codebuddy_auth_dir(values)
    except CodeBuddyAuthError:
        return {
            "status": "MISSING",
            "authenticated": False,
            "accessTokenFresh": False,
            "refreshable": False,
            "lastRefreshAt": None,
            "accessExpiresAt": None,
            "refreshExpiresAt": None,
            "secondsUntilRefreshExpiry": None,
        }

    try:
        payload = json.loads((auth_dir / OFFICIAL_AUTH_FILE).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {
            "status": "INVALID",
            "authenticated": False,
            "accessTokenFresh": False,
            "refreshable": False,
            "lastRefreshAt": None,
            "accessExpiresAt": None,
            "refreshExpiresAt": None,
            "secondsUntilRefreshExpiry": None,
        }
    auth = payload.get("auth") if isinstance(payload, dict) else None
    if not isinstance(auth, dict):
        return {
            "status": "INVALID",
            "authenticated": False,
            "accessTokenFresh": False,
            "refreshable": False,
            "lastRefreshAt": None,
            "accessExpiresAt": None,
            "refreshExpiresAt": None,
            "secondsUntilRefreshExpiry": None,
        }

    access_token_present = isinstance(auth.get("accessToken"), str) and bool(auth["accessToken"])
    refresh_token_present = isinstance(auth.get("refreshToken"), str) and bool(auth["refreshToken"])
    last_refresh = _millis_timestamp(auth.get("lastRefreshTime"))
    access_expires = _millis_timestamp(auth.get("expiresAt"))
    refresh_expires = _millis_timestamp(auth.get("refreshExpiresAt"))
    if not access_token_present or not refresh_token_present or refresh_expires is None:
        return {
            "status": "INVALID",
            "authenticated": False,
            "accessTokenFresh": False,
            "refreshable": False,
            "lastRefreshAt": _iso(last_refresh),
            "accessExpiresAt": _iso(access_expires),
            "refreshExpiresAt": _iso(refresh_expires),
            "secondsUntilRefreshExpiry": None,
        }

    remaining = round((refresh_expires - reference).total_seconds())
    refreshable = remaining > 0
    access_fresh = access_expires is not None and access_expires > reference
    if not refreshable:
        status = "EXPIRED"
    elif refresh_expires - reference <= warning_window:
        status = "EXPIRING_SOON"
    else:
        status = "READY"
    return {
        "status": status,
        "authenticated": refreshable,
        "accessTokenFresh": access_fresh,
        "refreshable": refreshable,
        "lastRefreshAt": _iso(last_refresh),
        "accessExpiresAt": _iso(access_expires),
        "refreshExpiresAt": _iso(refresh_expires),
        "secondsUntilRefreshExpiry": max(0, remaining),
    }


def _millis_timestamp(value: object) -> datetime | None:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    try:
        return datetime.fromtimestamp(float(value) / 1000, tz=UTC)
    except (OverflowError, OSError, ValueError):
        return None


def _iso(value: datetime | None) -> str | None:
    return value.astimezone(UTC).isoformat() if value is not None else None


__all__ = [
    "OFFICIAL_AUTH_FILE",
    "CodeBuddyAuthError",
    "inspect_codebuddy_auth",
    "resolve_codebuddy_auth_dir",
]
