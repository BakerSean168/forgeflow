"""Append-only execution-attempt ledger for auditable route decisions."""

from __future__ import annotations

import fcntl
import json
import os
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import IO, Literal

AttemptEventKind = Literal["STARTED", "FINISHED"]
AttemptOutcome = Literal["SUCCEEDED", "FAILED", "BLOCKED"]


class AttemptLedgerError(RuntimeError):
    """The append-only attempt ledger cannot be reconciled safely."""


@dataclass(frozen=True, slots=True)
class AttemptHandle:
    attempt_id: str
    role: str
    route_id: str
    priority: int
    runtime: str
    target: str
    operation_key: str
    started_at: str


@dataclass(frozen=True, slots=True)
class AttemptStatus:
    handle: AttemptHandle
    finished: bool


class AttemptLedger:
    def __init__(self, path: Path) -> None:
        self._path = path.expanduser()

    @property
    def path(self) -> Path:
        return self._path

    def start(
        self,
        *,
        role: str,
        route_id: str,
        priority: int,
        runtime: str,
        target: str,
        operation_key: str,
        source_revision: str | None = None,
    ) -> AttemptHandle:
        handle, payload = _new_start(
            role=role,
            route_id=route_id,
            priority=priority,
            runtime=runtime,
            target=target,
            operation_key=operation_key,
            source_revision=source_revision,
        )
        self._append(payload)
        return handle

    def ensure_started(
        self,
        *,
        role: str,
        route_id: str,
        priority: int,
        runtime: str,
        target: str,
        operation_key: str,
        source_revision: str | None = None,
    ) -> AttemptStatus:
        """Create or recover exactly one attempt for a stable operation key.

        This is the crash-safe entry point used by the durable policy reconciler.
        It performs the read/validate/append decision while holding the ledger
        file lock so repeated reconciliation cannot create duplicate STARTED rows.
        """
        _validate_identity(role, route_id, runtime, target, operation_key)
        with self._locked_file() as file:
            rows = _read_rows(file)
            starts = _matching_starts(rows, route_id=route_id, operation_key=operation_key)
            if len(starts) > 1:
                raise AttemptLedgerError("ATTEMPT_LEDGER_DUPLICATE_OPERATION")
            if starts:
                start = starts[0]
                _require_start_identity(
                    start,
                    role=role,
                    route_id=route_id,
                    priority=priority,
                    runtime=runtime,
                    target=target,
                    operation_key=operation_key,
                    source_revision=source_revision,
                )
                handle = _handle_from_start(start)
                finished = any(
                    row.get("event") == "FINISHED"
                    and row.get("attempt_id") == handle.attempt_id
                    for row in rows
                )
                return AttemptStatus(handle=handle, finished=finished)

            handle, payload = _new_start(
                role=role,
                route_id=route_id,
                priority=priority,
                runtime=runtime,
                target=target,
                operation_key=operation_key,
                source_revision=source_revision,
            )
            _append_locked(file, payload)
            return AttemptStatus(handle=handle, finished=False)

    def finish(
        self,
        handle: AttemptHandle,
        *,
        outcome: AttemptOutcome,
        failure_class: str | None = None,
        fallback_reason: str | None = None,
        source_revision: str | None = None,
        result_revision: str | None = None,
        external_session_id: str | None = None,
        external_conversation_id: str | None = None,
    ) -> None:
        payload = _finish_payload(
            handle,
            outcome=outcome,
            failure_class=failure_class,
            fallback_reason=fallback_reason,
            source_revision=source_revision,
            result_revision=result_revision,
            external_session_id=external_session_id,
            external_conversation_id=external_conversation_id,
        )
        self._append(payload)

    def finish_operation(
        self,
        *,
        route_id: str,
        operation_key: str,
        outcome: AttemptOutcome,
        failure_class: str | None = None,
        fallback_reason: str | None = None,
        source_revision: str | None = None,
        result_revision: str | None = None,
    ) -> str:
        """Idempotently close the unique attempt for one operation key."""
        with self._locked_file() as file:
            rows = _read_rows(file)
            starts = _matching_starts(rows, route_id=route_id, operation_key=operation_key)
            if not starts:
                raise AttemptLedgerError("ATTEMPT_LEDGER_START_MISSING")
            if len(starts) > 1:
                raise AttemptLedgerError("ATTEMPT_LEDGER_DUPLICATE_OPERATION")
            handle = _handle_from_start(starts[0])
            finishes = [
                row
                for row in rows
                if row.get("event") == "FINISHED" and row.get("attempt_id") == handle.attempt_id
            ]
            if len(finishes) > 1:
                raise AttemptLedgerError("ATTEMPT_LEDGER_DUPLICATE_FINISH")
            if finishes:
                _require_finish_compatible(
                    finishes[0],
                    outcome=outcome,
                    failure_class=failure_class,
                    fallback_reason=fallback_reason,
                    source_revision=source_revision,
                    result_revision=result_revision,
                )
                return handle.attempt_id
            _append_locked(
                file,
                _finish_payload(
                    handle,
                    outcome=outcome,
                    failure_class=failure_class,
                    fallback_reason=fallback_reason,
                    source_revision=source_revision,
                    result_revision=result_revision,
                ),
            )
            return handle.attempt_id

    def _append(self, payload: dict[str, object]) -> None:
        with self._locked_file() as file:
            _append_locked(file, payload)

    @contextmanager
    def _locked_file(self) -> Iterator[IO[str]]:
        parent = self._path.parent
        parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            parent.chmod(0o700)
        except OSError:
            pass
        fd = os.open(self._path, os.O_RDWR | os.O_CREAT, 0o600)
        file: IO[str] | None = None
        try:
            os.fchmod(fd, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX)
            file = os.fdopen(fd, "r+", encoding="utf-8", closefd=False)
            yield file
        finally:
            try:
                if file is not None:
                    file.flush()
                os.fsync(fd)
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)
                if file is not None:
                    file.close()
                os.close(fd)


def _validate_identity(role: str, route_id: str, runtime: str, target: str, operation_key: str) -> None:
    if not all(value.strip() for value in (role, route_id, runtime, target, operation_key)):
        raise ValueError("attempt identity fields are required")


def _new_start(
    *,
    role: str,
    route_id: str,
    priority: int,
    runtime: str,
    target: str,
    operation_key: str,
    source_revision: str | None,
) -> tuple[AttemptHandle, dict[str, object]]:
    _validate_identity(role, route_id, runtime, target, operation_key)
    now = datetime.now(UTC).isoformat()
    handle = AttemptHandle(
        attempt_id=str(uuid.uuid4()),
        role=role,
        route_id=route_id,
        priority=priority,
        runtime=runtime,
        target=target,
        operation_key=operation_key,
        started_at=now,
    )
    payload: dict[str, object] = {
        "version": 1,
        "event": "STARTED",
        "timestamp": now,
        "attempt_id": handle.attempt_id,
        "role": role,
        "route_id": route_id,
        "priority": priority,
        "runtime": runtime,
        "target": target,
        "operation_key": operation_key,
        "source_revision": source_revision,
    }
    return handle, payload


def _finish_payload(
    handle: AttemptHandle,
    *,
    outcome: AttemptOutcome,
    failure_class: str | None,
    fallback_reason: str | None,
    source_revision: str | None,
    result_revision: str | None,
    external_session_id: str | None = None,
    external_conversation_id: str | None = None,
) -> dict[str, object]:
    if outcome == "SUCCEEDED" and failure_class is not None:
        raise ValueError("successful attempt cannot have failure_class")
    finished_dt = datetime.now(UTC)
    try:
        started_dt = datetime.fromisoformat(handle.started_at)
    except ValueError as exc:
        raise AttemptLedgerError("ATTEMPT_LEDGER_STARTED_AT_INVALID") from exc
    if started_dt.tzinfo is None:
        raise AttemptLedgerError("ATTEMPT_LEDGER_STARTED_AT_INVALID")
    duration_ms = max(0, round((finished_dt - started_dt.astimezone(UTC)).total_seconds() * 1000))
    return {
        "version": 1,
        "event": "FINISHED",
        "timestamp": finished_dt.isoformat(),
        "attempt_id": handle.attempt_id,
        "role": handle.role,
        "route_id": handle.route_id,
        "priority": handle.priority,
        "runtime": handle.runtime,
        "target": handle.target,
        "operation_key": handle.operation_key,
        "outcome": outcome,
        "failure_class": failure_class,
        "fallback_reason": fallback_reason,
        "duration_ms": duration_ms,
        "source_revision": source_revision,
        "result_revision": result_revision,
        "external_session_id": external_session_id,
        "external_conversation_id": external_conversation_id,
    }


def _read_rows(file: IO[str]) -> list[dict[str, object]]:
    file.seek(0)
    rows: list[dict[str, object]] = []
    while True:
        start = file.tell()
        raw = file.readline()
        if raw == "":
            break
        # A newline is the ledger commit marker. A crash can leave only the
        # final append torn; truncate that uncommitted tail while preserving
        # strict failure for corruption in any committed row.
        if not raw.endswith("\n"):
            file.seek(start)
            file.truncate()
            file.flush()
            os.fsync(file.fileno())
            break
        if not raw.strip():
            continue
        try:
            row = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise AttemptLedgerError("ATTEMPT_LEDGER_INVALID_JSON") from exc
        if not isinstance(row, dict):
            raise AttemptLedgerError("ATTEMPT_LEDGER_ROW_INVALID")
        rows.append(row)
    return rows


def _append_locked(file: IO[str], payload: dict[str, object]) -> None:
    file.seek(0, os.SEEK_END)
    file.write(json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n")
    file.flush()


def _matching_starts(
    rows: list[dict[str, object]], *, route_id: str, operation_key: str
) -> list[dict[str, object]]:
    return [
        row
        for row in rows
        if row.get("event") == "STARTED"
        and row.get("route_id") == route_id
        and row.get("operation_key") == operation_key
    ]


def _require_start_identity(
    row: dict[str, object],
    *,
    role: str,
    route_id: str,
    priority: int,
    runtime: str,
    target: str,
    operation_key: str,
    source_revision: str | None,
) -> None:
    expected = {
        "role": role,
        "route_id": route_id,
        "priority": priority,
        "runtime": runtime,
        "target": target,
        "operation_key": operation_key,
    }
    if any(row.get(key) != value for key, value in expected.items()):
        raise AttemptLedgerError("ATTEMPT_LEDGER_OPERATION_IDENTITY_MISMATCH")
    if row.get("source_revision") != source_revision:
        raise AttemptLedgerError("ATTEMPT_LEDGER_OPERATION_SOURCE_MISMATCH")


def _require_finish_compatible(
    row: dict[str, object],
    *,
    outcome: AttemptOutcome,
    failure_class: str | None,
    fallback_reason: str | None,
    source_revision: str | None,
    result_revision: str | None,
) -> None:
    expected = {
        "outcome": outcome,
        "failure_class": failure_class,
        "fallback_reason": fallback_reason,
    }
    if any(row.get(key) != value for key, value in expected.items()):
        raise AttemptLedgerError("ATTEMPT_LEDGER_FINISH_CONFLICT")
    if source_revision is not None and row.get("source_revision") != source_revision:
        raise AttemptLedgerError("ATTEMPT_LEDGER_FINISH_SOURCE_MISMATCH")
    if result_revision is not None and row.get("result_revision") != result_revision:
        raise AttemptLedgerError("ATTEMPT_LEDGER_FINISH_RESULT_MISMATCH")


def _handle_from_start(row: dict[str, object]) -> AttemptHandle:
    try:
        attempt_id = row["attempt_id"]
        role = row["role"]
        route_id = row["route_id"]
        priority = row["priority"]
        runtime = row["runtime"]
        target = row["target"]
        operation_key = row["operation_key"]
        started_at = row["timestamp"]
    except KeyError as exc:
        raise AttemptLedgerError("ATTEMPT_LEDGER_START_ROW_INCOMPLETE") from exc
    if (
        not isinstance(attempt_id, str)
        or not isinstance(role, str)
        or not isinstance(route_id, str)
        or not isinstance(priority, int)
        or isinstance(priority, bool)
        or not isinstance(runtime, str)
        or not isinstance(target, str)
        or not isinstance(operation_key, str)
        or not isinstance(started_at, str)
    ):
        raise AttemptLedgerError("ATTEMPT_LEDGER_START_ROW_INVALID")
    return AttemptHandle(
        attempt_id=attempt_id,
        role=role,
        route_id=route_id,
        priority=priority,
        runtime=runtime,
        target=target,
        operation_key=operation_key,
        started_at=started_at,
    )


__all__ = [
    "AttemptHandle",
    "AttemptLedger",
    "AttemptLedgerError",
    "AttemptOutcome",
    "AttemptStatus",
]
