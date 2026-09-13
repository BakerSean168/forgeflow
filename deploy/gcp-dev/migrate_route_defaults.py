#!/usr/bin/env python3
"""Upgrade untouched ForgeFlow-managed route defaults without overwriting custom policy."""

from __future__ import annotations

import argparse
import json
import os
import stat
import tempfile
from copy import deepcopy
from pathlib import Path

# Exact semantic shape shipped immediately before Antigravity production fallback
# was enabled. Keeping this snapshot here lets hosts that skip a release still
# receive the one safe managed-default promotion later without guessing whether
# a disabled external route is an operator override.
_PREVIOUS_MANAGED_DEFAULT = {
    "version": 1,
    "routes": [
        {
            "id": "openswe-current",
            "role": "IMPLEMENT",
            "priority": 10,
            "runtime": "OPEN_SWE",
            "target": "current-model-policy",
            "enabled": True,
            "health": "READY",
        },
        {
            "id": "antigravity-account-primary",
            "role": "IMPLEMENT",
            "priority": 20,
            "runtime": "EXTERNAL_ACP",
            "adapter": "antigravity",
            "target": "google-account",
            "enabled": False,
            "health": "READY",
        },
        {
            "id": "openswe-reviewer",
            "role": "REASONING",
            "priority": 10,
            "runtime": "OPEN_SWE",
            "target": "openai:gpt-5.6-sol",
            "enabled": True,
            "health": "READY",
        },
        {
            "id": "openswe-reviewer-glm53",
            "role": "REASONING",
            "priority": 20,
            "runtime": "OPEN_SWE",
            "target": "fireworks:accounts/fireworks/models/glm-5p3",
            "enabled": True,
            "health": "READY",
            "expires_at": "2026-09-23T16:00:00Z",
        },
    ],
}


def _load(path: Path) -> dict:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"route config must be a JSON object: {path}")
    return payload


def _antigravity_enabled(payload: dict) -> bool | None:
    rows = payload.get("routes")
    if not isinstance(rows, list):
        return None
    matches = [row for row in rows if isinstance(row, dict) and row.get("id") == "antigravity-account-primary"]
    if len(matches) != 1:
        return None
    value = matches[0].get("enabled", True)
    return value if isinstance(value, bool) else None


def _write_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    original_mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False
    ) as handle:
        temp = Path(handle.name)
        json.dump(payload, handle, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    try:
        os.chmod(temp, original_mode)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def migrate(current_path: Path, target_default_path: Path) -> str:
    current = _load(current_path)
    target = _load(target_default_path)
    if _antigravity_enabled(target) is not True:
        raise ValueError("target default must enable antigravity-account-primary")

    if current == _PREVIOUS_MANAGED_DEFAULT:
        upgraded = deepcopy(current)
        for route in upgraded["routes"]:
            if route["id"] == "antigravity-account-primary":
                route["enabled"] = True
                break
        _write_atomic(current_path, upgraded)
        return "antigravity-enabled"

    if _antigravity_enabled(current) is True:
        return "already-enabled-or-custom"
    return "preserved-custom"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--current", required=True, type=Path)
    parser.add_argument("--target-default", required=True, type=Path)
    args = parser.parse_args()
    status = migrate(args.current, args.target_default)
    print(f"route_config_migration={status}")


if __name__ == "__main__":
    main()
