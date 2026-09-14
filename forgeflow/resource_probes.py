"""Private cached health-probe evidence for operator-facing resource status."""

from __future__ import annotations

import fcntl
import json
import os
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import IO, Literal

ProbeStatus = Literal["AVAILABLE", "UNAVAILABLE"]


class ResourceProbeStoreError(RuntimeError):
    """Cached resource health evidence is malformed or cannot be updated safely."""


@dataclass(frozen=True, slots=True)
class ResourceProbeRecord:
    route_id: str
    status: ProbeStatus
    checked_at: str
    model: str | None
    duration_ms: int
    failure_code: str | None = None


class ResourceProbeStore:
    def __init__(self, path: Path) -> None:
        self._path = path.expanduser()
        self._lock_path = self._path.with_suffix(self._path.suffix + ".lock")

    @property
    def path(self) -> Path:
        return self._path

    def get(self, route_id: str) -> ResourceProbeRecord | None:
        if not route_id.strip():
            raise ValueError("route_id is required")
        with self._locked():
            payload = self._read()
        raw = payload["routes"].get(route_id)
        return _record_from_json(route_id, raw) if raw is not None else None

    def all(self) -> dict[str, ResourceProbeRecord]:
        with self._locked():
            payload = self._read()
        return {
            route_id: _record_from_json(route_id, raw)
            for route_id, raw in payload["routes"].items()
        }

    def record(
        self,
        *,
        route_id: str,
        status: ProbeStatus,
        model: str | None,
        duration_ms: int,
        failure_code: str | None = None,
        checked_at: datetime | None = None,
    ) -> ResourceProbeRecord:
        if not route_id.strip():
            raise ValueError("route_id is required")
        if status not in {"AVAILABLE", "UNAVAILABLE"}:
            raise ValueError("invalid probe status")
        if duration_ms < 0:
            raise ValueError("duration_ms must be non-negative")
        if status == "AVAILABLE" and failure_code is not None:
            raise ValueError("available probe cannot have failure_code")
        when = (checked_at or datetime.now(UTC)).astimezone(UTC)
        record = ResourceProbeRecord(
            route_id=route_id,
            status=status,
            checked_at=when.isoformat(),
            model=model,
            duration_ms=duration_ms,
            failure_code=failure_code,
        )
        with self._locked():
            payload = self._read()
            payload["routes"][route_id] = {
                key: value for key, value in asdict(record).items() if key != "route_id"
            }
            self._write_atomic(payload)
        return record

    @contextmanager
    def _locked(self) -> Iterator[None]:
        self._path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            self._path.parent.chmod(0o700)
        except OSError:
            pass
        fd = os.open(self._lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        file: IO[str] | None = None
        try:
            os.fchmod(fd, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX)
            file = os.fdopen(fd, "r+", encoding="utf-8", closefd=False)
            yield
        finally:
            if file is not None:
                file.close()
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)

    def _read(self) -> dict[str, object]:
        if not self._path.exists():
            return {"version": 1, "routes": {}}
        try:
            payload = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ResourceProbeStoreError("RESOURCE_PROBE_STORE_INVALID") from exc
        if not isinstance(payload, dict) or payload.get("version") != 1:
            raise ResourceProbeStoreError("RESOURCE_PROBE_STORE_INVALID")
        routes = payload.get("routes")
        if not isinstance(routes, dict):
            raise ResourceProbeStoreError("RESOURCE_PROBE_STORE_INVALID")
        for route_id, raw in routes.items():
            if not isinstance(route_id, str) or not isinstance(raw, dict):
                raise ResourceProbeStoreError("RESOURCE_PROBE_STORE_INVALID")
        return {"version": 1, "routes": dict(routes)}

    def _write_atomic(self, payload: dict[str, object]) -> None:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=self._path.parent,
            prefix=f".{self._path.name}.",
            delete=False,
        ) as handle:
            temp = Path(handle.name)
            json.dump(payload, handle, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.chmod(temp, 0o600)
            os.replace(temp, self._path)
        finally:
            temp.unlink(missing_ok=True)


def _record_from_json(route_id: str, raw: object) -> ResourceProbeRecord:
    if not isinstance(raw, dict):
        raise ResourceProbeStoreError("RESOURCE_PROBE_RECORD_INVALID")
    status = raw.get("status")
    checked_at = raw.get("checked_at")
    model = raw.get("model")
    duration_ms = raw.get("duration_ms")
    failure_code = raw.get("failure_code")
    if status not in {"AVAILABLE", "UNAVAILABLE"}:
        raise ResourceProbeStoreError("RESOURCE_PROBE_RECORD_INVALID")
    if not isinstance(checked_at, str):
        raise ResourceProbeStoreError("RESOURCE_PROBE_RECORD_INVALID")
    try:
        parsed = datetime.fromisoformat(checked_at)
    except ValueError as exc:
        raise ResourceProbeStoreError("RESOURCE_PROBE_RECORD_INVALID") from exc
    if parsed.tzinfo is None:
        raise ResourceProbeStoreError("RESOURCE_PROBE_RECORD_INVALID")
    if model is not None and not isinstance(model, str):
        raise ResourceProbeStoreError("RESOURCE_PROBE_RECORD_INVALID")
    if not isinstance(duration_ms, int) or isinstance(duration_ms, bool) or duration_ms < 0:
        raise ResourceProbeStoreError("RESOURCE_PROBE_RECORD_INVALID")
    if failure_code is not None and not isinstance(failure_code, str):
        raise ResourceProbeStoreError("RESOURCE_PROBE_RECORD_INVALID")
    if status == "AVAILABLE" and failure_code is not None:
        raise ResourceProbeStoreError("RESOURCE_PROBE_RECORD_INVALID")
    return ResourceProbeRecord(
        route_id=route_id,
        status=status,
        checked_at=parsed.astimezone(UTC).isoformat(),
        model=model,
        duration_ms=duration_ms,
        failure_code=failure_code,
    )


__all__ = [
    "ProbeStatus",
    "ResourceProbeRecord",
    "ResourceProbeStore",
    "ResourceProbeStoreError",
]
