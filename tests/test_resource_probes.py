from __future__ import annotations

import json
import stat
from datetime import UTC, datetime
from pathlib import Path

import pytest

from forgeflow.resource_probes import ResourceProbeStore, ResourceProbeStoreError


def test_resource_probe_store_is_private_atomic_and_round_trips(tmp_path: Path) -> None:
    path = tmp_path / "state" / "resource-probes.json"
    store = ResourceProbeStore(path)
    record = store.record(
        route_id="codebuddy-account-primary",
        status="AVAILABLE",
        model="deepseek-v4.1-flash",
        duration_ms=321,
        checked_at=datetime(2026, 9, 14, 3, 0, tzinfo=UTC),
    )

    assert record.status == "AVAILABLE"
    assert store.get("codebuddy-account-primary") == record
    assert store.all() == {"codebuddy-account-primary": record}
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["version"] == 1
    assert payload["routes"]["codebuddy-account-primary"]["failure_code"] is None


def test_resource_probe_store_rejects_secret_free_but_malformed_cache(tmp_path: Path) -> None:
    path = tmp_path / "resource-probes.json"
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "routes": {
                    "codebuddy-account-primary": {
                        "status": "AVAILABLE",
                        "checked_at": "not-a-date",
                        "model": "deepseek-v4.1-flash",
                        "duration_ms": 10,
                        "failure_code": None,
                    }
                },
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(ResourceProbeStoreError, match="RESOURCE_PROBE_RECORD_INVALID"):
        ResourceProbeStore(path).all()


def test_unavailable_probe_requires_bounded_failure_code_only(tmp_path: Path) -> None:
    store = ResourceProbeStore(tmp_path / "resource-probes.json")
    record = store.record(
        route_id="codebuddy-account-primary",
        status="UNAVAILABLE",
        model="deepseek-v4.1-flash",
        duration_ms=500,
        failure_code="CODEBUDDY_PROBE_TIMEOUT",
    )
    assert record.failure_code == "CODEBUDDY_PROBE_TIMEOUT"
    with pytest.raises(ValueError, match="available probe cannot have failure_code"):
        store.record(
            route_id="codebuddy-account-primary",
            status="AVAILABLE",
            model="deepseek-v4.1-flash",
            duration_ms=1,
            failure_code="should-not-exist",
        )
