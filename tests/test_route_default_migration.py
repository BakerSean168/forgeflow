from __future__ import annotations

import json
import stat
import subprocess
import sys
from copy import deepcopy
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEPLOY = REPO / "deploy/gcp-dev"
TARGET = DEPLOY / "routes.default.json"
MIGRATE = DEPLOY / "migrate_route_defaults.py"


def _previous_managed_default() -> dict:
    payload = json.loads(TARGET.read_text(encoding="utf-8"))
    for route in payload["routes"]:
        if route["id"] == "antigravity-account-primary":
            route["enabled"] = False
            break
    return payload


def _run(current: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(MIGRATE),
            "--current",
            str(current),
            "--target-default",
            str(TARGET),
        ],
        text=True,
        capture_output=True,
        check=True,
    )


def test_untouched_previous_managed_default_enables_antigravity_atomically(tmp_path: Path) -> None:
    current = tmp_path / "routes.json"
    payload = _previous_managed_default()
    current.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    current.chmod(0o600)

    result = _run(current)
    migrated = json.loads(current.read_text(encoding="utf-8"))
    anti = next(route for route in migrated["routes"] if route["id"] == "antigravity-account-primary")

    assert result.stdout.strip() == "route_config_migration=antigravity-enabled"
    assert anti["enabled"] is True
    expected = deepcopy(payload)
    next(route for route in expected["routes"] if route["id"] == "antigravity-account-primary")[
        "enabled"
    ] = True
    assert migrated == expected
    assert stat.S_IMODE(current.stat().st_mode) == 0o600


def test_custom_route_policy_is_preserved_byte_for_byte(tmp_path: Path) -> None:
    current = tmp_path / "routes.json"
    payload = _previous_managed_default()
    next(route for route in payload["routes"] if route["id"] == "openswe-current")["priority"] = 7
    original = json.dumps(payload, indent=2) + "\n"
    current.write_text(original, encoding="utf-8")

    result = _run(current)

    assert result.stdout.strip() == "route_config_migration=preserved-custom"
    assert current.read_text(encoding="utf-8") == original


def test_already_enabled_or_custom_policy_is_not_rewritten(tmp_path: Path) -> None:
    current = tmp_path / "routes.json"
    payload = json.loads(TARGET.read_text(encoding="utf-8"))
    payload["routes"].append(
        {
            "id": "custom-reasoning",
            "role": "REASONING",
            "priority": 99,
            "runtime": "OPEN_SWE",
            "target": "custom-model",
            "enabled": False,
            "health": "DISABLED",
        }
    )
    original = json.dumps(payload, indent=2) + "\n"
    current.write_text(original, encoding="utf-8")

    result = _run(current)

    assert result.stdout.strip() == "route_config_migration=already-enabled-or-custom"
    assert current.read_text(encoding="utf-8") == original
