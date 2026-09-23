#!/usr/bin/env python3
"""Read-only health check for required ForgeFlow systemd user units."""

from __future__ import annotations

import subprocess
from collections.abc import Callable, Sequence
from typing import NamedTuple

REQUIRED_USER_UNITS = (
    "open-swe-codex-broker.service",
    "forgeflow-policy.service",
    "forgeflow-openswe-sandbox-gc.timer",
    "forgeflow-invariant-supervisor.timer",
    "forgeflow-project-supervisor.timer",
)


class UnitHealth(NamedTuple):
    unit: str
    status: str
    load_state: str
    active_state: str
    unit_file_state: str


class RuntimeHealth(NamedTuple):
    ok: bool
    items: tuple[UnitHealth, ...]


RunCommand = Callable[..., subprocess.CompletedProcess[str]]


def _properties(stdout: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in stdout.splitlines():
        key, separator, value = line.partition("=")
        if separator and key:
            values[key] = value
    return values


def inspect_unit(unit: str, *, run: RunCommand = subprocess.run) -> UnitHealth:
    result = run(
        [
            "systemctl",
            "--user",
            "show",
            unit,
            "--property=LoadState",
            "--property=ActiveState",
            "--property=UnitFileState",
            "--no-pager",
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        return UnitHealth(
            unit=unit,
            status="PROBE_FAILED",
            load_state="unknown",
            active_state="unknown",
            unit_file_state="unknown",
        )

    values = _properties(result.stdout)
    load_state = values.get("LoadState", "unknown")
    active_state = values.get("ActiveState", "unknown")
    unit_file_state = values.get("UnitFileState", "unknown")
    if load_state != "loaded":
        status = "NOT_LOADED"
    elif active_state != "active":
        status = "NOT_ACTIVE"
    else:
        status = "READY"
    return UnitHealth(
        unit=unit,
        status=status,
        load_state=load_state,
        active_state=active_state,
        unit_file_state=unit_file_state,
    )


def inspect_required_units(
    *,
    run: RunCommand = subprocess.run,
    units: Sequence[str] = REQUIRED_USER_UNITS,
) -> RuntimeHealth:
    items = tuple(inspect_unit(unit, run=run) for unit in units)
    return RuntimeHealth(
        ok=all(item.status == "READY" for item in items),
        items=items,
    )


def main() -> int:
    report = inspect_required_units()
    for item in report.items:
        print(
            "runtime_unit="
            + item.unit
            + " status="
            + item.status
            + " load="
            + item.load_state
            + " active="
            + item.active_state
            + " unit_file="
            + item.unit_file_state
        )
    if report.ok:
        print(f"runtime_health=READY required={len(report.items)}")
        return 0
    failures = ",".join(item.unit for item in report.items if item.status != "READY")
    print(f"runtime_health=DEGRADED failed={failures}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
