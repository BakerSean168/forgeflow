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


def _managed_default_before_codebuddy() -> dict:
    payload = json.loads(TARGET.read_text(encoding="utf-8"))
    payload["routes"] = [
        route for route in payload["routes"] if route["id"] != "codebuddy-account-primary"
    ]
    return payload


def _managed_default_before_antigravity_enablement() -> dict:
    payload = _managed_default_before_codebuddy()
    next(route for route in payload["routes"] if route["id"] == "antigravity-account-primary")[
        "enabled"
    ] = False
    return payload


def _managed_default_with_codebuddy_disabled() -> dict:
    payload = json.loads(TARGET.read_text(encoding="utf-8"))
    next(route for route in payload["routes"] if route["id"] == "codebuddy-account-primary")[
        "enabled"
    ] = False
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


def test_untouched_pre_codebuddy_default_adds_enabled_codebuddy_atomically(tmp_path: Path) -> None:
    current = tmp_path / "routes.json"
    payload = _managed_default_before_codebuddy()
    current.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    current.chmod(0o600)

    result = _run(current)
    migrated = json.loads(current.read_text(encoding="utf-8"))
    codebuddy = next(
        route for route in migrated["routes"] if route["id"] == "codebuddy-account-primary"
    )

    assert result.stdout.strip() == "route_config_migration=codebuddy-added-enabled"
    assert codebuddy["enabled"] is True
    assert migrated == json.loads(TARGET.read_text(encoding="utf-8"))
    assert stat.S_IMODE(current.stat().st_mode) == 0o600


def test_older_managed_default_enables_antigravity_and_codebuddy(tmp_path: Path) -> None:
    current = tmp_path / "routes.json"
    current.write_text(
        json.dumps(_managed_default_before_antigravity_enablement(), indent=2) + "\n",
        encoding="utf-8",
    )

    result = _run(current)
    migrated = json.loads(current.read_text(encoding="utf-8"))

    assert result.stdout.strip() == "route_config_migration=antigravity-enabled-codebuddy-enabled"
    assert migrated == json.loads(TARGET.read_text(encoding="utf-8"))


def test_exact_managed_disabled_codebuddy_is_promoted_after_canary(tmp_path: Path) -> None:
    current = tmp_path / "routes.json"
    payload = _managed_default_with_codebuddy_disabled()
    current.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    current.chmod(0o600)

    result = _run(current)
    migrated = json.loads(current.read_text(encoding="utf-8"))

    assert result.stdout.strip() == "route_config_migration=codebuddy-enabled"
    assert migrated == json.loads(TARGET.read_text(encoding="utf-8"))
    assert stat.S_IMODE(current.stat().st_mode) == 0o600


def test_custom_route_policy_is_preserved_byte_for_byte(tmp_path: Path) -> None:
    current = tmp_path / "routes.json"
    payload = _managed_default_with_codebuddy_disabled()
    next(route for route in payload["routes"] if route["id"] == "openswe-current")["priority"] = 7
    original = json.dumps(payload, indent=2) + "\n"
    current.write_text(original, encoding="utf-8")

    result = _run(current)

    assert result.stdout.strip() == "route_config_migration=already-codebuddy-or-custom"
    assert current.read_text(encoding="utf-8") == original


def test_custom_policy_without_codebuddy_is_preserved_byte_for_byte(tmp_path: Path) -> None:
    current = tmp_path / "routes.json"
    payload = _managed_default_before_codebuddy()
    next(route for route in payload["routes"] if route["id"] == "openswe-current")["priority"] = 7
    original = json.dumps(payload, indent=2) + "\n"
    current.write_text(original, encoding="utf-8")

    result = _run(current)

    assert result.stdout.strip() == "route_config_migration=preserved-custom"
    assert current.read_text(encoding="utf-8") == original


def test_already_enabled_custom_policy_is_not_rewritten(tmp_path: Path) -> None:
    current = tmp_path / "routes.json"
    payload = deepcopy(json.loads(TARGET.read_text(encoding="utf-8")))
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

    assert result.stdout.strip() == "route_config_migration=already-codebuddy-or-custom"
    assert current.read_text(encoding="utf-8") == original


def test_already_current_managed_default_is_noop(tmp_path: Path) -> None:
    current = tmp_path / "routes.json"
    original = TARGET.read_text(encoding="utf-8")
    current.write_text(original, encoding="utf-8")

    result = _run(current)

    assert result.stdout.strip() == "route_config_migration=already-enabled"
    assert current.read_text(encoding="utf-8") == original
