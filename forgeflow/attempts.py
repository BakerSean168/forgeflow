"""Append-only execution-attempt ledger for auditable route decisions."""

from __future__ import annotations

import fcntl
import json
import os
import uuid
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
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


@dataclass(frozen=True, slots=True)
class RouteAttemptSummary:
    route_id: str
    attempt_count: int
    finished_count: int
    open_count: int
    succeeded_count: int
    failed_count: int
    blocked_count: int
    recent_attempt_count: int
    recent_succeeded_count: int
    recent_failed_count: int
    recent_blocked_count: int
    last_started_at: str | None
    last_finished_at: str | None
    last_success_at: str | None
    last_outcome: AttemptOutcome | None
    last_failure_class: str | None
    last_fallback_reason: str | None
    last_duration_ms: int | None


@dataclass(frozen=True, slots=True)
class OpenAttempt:
    attempt_id: str
    role: str
    route_id: str
    priority: int
    runtime: str
    target: str
    operation_key: str
    started_at: str
    source_revision: str | None


class AttemptLedger:
    def __init__(self, path: Path) -> None:
        self._path = path.expanduser()

    @property
    def path(self) -> Path:
        return self._path

    def operation_status(self, *, route_id: str, operation_key: str) -> AttemptStatus | None:
        """Read the unique attempt for an operation without creating ledger state."""
        with self._locked_file() as file:
            rows = _read_rows(file)
            starts = _matching_starts(rows, route_id=route_id, operation_key=operation_key)
            if not starts:
                return None
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
            return AttemptStatus(handle=handle, finished=bool(finishes))

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
        external_session_id: str | None = None,
        external_conversation_id: str | None = None,
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
                    external_session_id=external_session_id,
                    external_conversation_id=external_conversation_id,
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
                    external_session_id=external_session_id,
                    external_conversation_id=external_conversation_id,
                ),
            )
            return handle.attempt_id

    def route_summaries(
        self,
        route_ids: Iterable[str] | None = None,
        *,
        now: datetime | None = None,
        recent_window: timedelta = timedelta(hours=24),
    ) -> dict[str, RouteAttemptSummary]:
        """Summarize append-only route usage without exposing objectives or transcripts."""

        requested = None if route_ids is None else frozenset(route_ids)
        if requested is not None and any(not route_id.strip() for route_id in requested):
            raise ValueError("route ids must be non-empty")
        if recent_window.total_seconds() < 0:
            raise ValueError("recent_window must be non-negative")
        reference = (now or datetime.now(UTC)).astimezone(UTC)
        cutoff = reference - recent_window
        with self._locked_file() as file:
            rows = _read_rows(file)
        return _summarize_routes(rows, requested=requested, cutoff=cutoff)

    def open_attempts(self) -> tuple[OpenAttempt, ...]:
        """Return currently open attempts after validating the complete ledger.

        This is a provenance view, not a task scheduler. Callers can correlate
        operation keys with durable Policy V1 state and surface unmatched rows
        as abnormal/unattached executions.
        """
        with self._locked_file() as file:
            rows = _read_rows(file)

        _summarize_routes(
            rows,
            requested=None,
            cutoff=datetime.min.replace(tzinfo=UTC),
        )
        finished_ids = {
            row["attempt_id"]
            for row in rows
            if row.get("event") == "FINISHED" and isinstance(row.get("attempt_id"), str)
        }
        result: list[OpenAttempt] = []
        for row in rows:
            if row.get("event") != "STARTED" or row.get("attempt_id") in finished_ids:
                continue
            handle = _handle_from_start(row)
            source_revision = row.get("source_revision")
            if source_revision is not None and not isinstance(source_revision, str):
                raise AttemptLedgerError("ATTEMPT_LEDGER_SOURCE_REVISION_INVALID")
            result.append(
                OpenAttempt(
                    attempt_id=handle.attempt_id,
                    role=handle.role,
                    route_id=handle.route_id,
                    priority=handle.priority,
                    runtime=handle.runtime,
                    target=handle.target,
                    operation_key=handle.operation_key,
                    started_at=handle.started_at,
                    source_revision=source_revision,
                )
            )
        result.sort(key=lambda item: item.started_at, reverse=True)
        return tuple(result)

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
    external_session_id: str | None,
    external_conversation_id: str | None,
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
    if external_session_id is not None and row.get("external_session_id") != external_session_id:
        raise AttemptLedgerError("ATTEMPT_LEDGER_FINISH_SESSION_MISMATCH")
    if (
        external_conversation_id is not None
        and row.get("external_conversation_id") != external_conversation_id
    ):
        raise AttemptLedgerError("ATTEMPT_LEDGER_FINISH_CONVERSATION_MISMATCH")


def _row_timestamp(row: dict[str, object]) -> tuple[str, datetime]:
    raw = row.get("timestamp")
    if not isinstance(raw, str):
        raise AttemptLedgerError("ATTEMPT_LEDGER_TIMESTAMP_INVALID")
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError as exc:
        raise AttemptLedgerError("ATTEMPT_LEDGER_TIMESTAMP_INVALID") from exc
    if parsed.tzinfo is None:
        raise AttemptLedgerError("ATTEMPT_LEDGER_TIMESTAMP_INVALID")
    return raw, parsed.astimezone(UTC)


def _summarize_routes(
    rows: list[dict[str, object]],
    *,
    requested: frozenset[str] | None,
    cutoff: datetime,
) -> dict[str, RouteAttemptSummary]:
    counters: dict[str, dict[str, int]] = {}
    details: dict[str, dict[str, object | None]] = {}
    last_started_dt: dict[str, datetime] = {}
    last_finished_dt: dict[str, datetime] = {}
    starts: dict[str, dict[str, object]] = {}
    finishes: set[str] = set()

    def ensure(route_id: str) -> None:
        counters.setdefault(
            route_id,
            {
                "attempt_count": 0,
                "finished_count": 0,
                "succeeded_count": 0,
                "failed_count": 0,
                "blocked_count": 0,
                "recent_attempt_count": 0,
                "recent_succeeded_count": 0,
                "recent_failed_count": 0,
                "recent_blocked_count": 0,
            },
        )
        details.setdefault(
            route_id,
            {
                "last_started_at": None,
                "last_finished_at": None,
                "last_success_at": None,
                "last_outcome": None,
                "last_failure_class": None,
                "last_fallback_reason": None,
                "last_duration_ms": None,
            },
        )

    if requested is not None:
        for route_id in requested:
            ensure(route_id)

    for row in rows:
        event = row.get("event")
        route_id = row.get("route_id")
        attempt_id = row.get("attempt_id")
        if event not in {"STARTED", "FINISHED"}:
            raise AttemptLedgerError("ATTEMPT_LEDGER_EVENT_INVALID")
        if not isinstance(route_id, str) or not route_id:
            raise AttemptLedgerError("ATTEMPT_LEDGER_ROUTE_ID_INVALID")
        if not isinstance(attempt_id, str) or not attempt_id:
            raise AttemptLedgerError("ATTEMPT_LEDGER_ATTEMPT_ID_INVALID")
        timestamp_raw, timestamp = _row_timestamp(row)

        selected = requested is None or route_id in requested
        if selected:
            ensure(route_id)

        if event == "STARTED":
            if attempt_id in starts:
                raise AttemptLedgerError("ATTEMPT_LEDGER_DUPLICATE_ATTEMPT_ID")
            starts[attempt_id] = row
            if not selected:
                continue
            count = counters[route_id]
            count["attempt_count"] += 1
            if timestamp >= cutoff:
                count["recent_attempt_count"] += 1
            if timestamp >= last_started_dt.get(route_id, datetime.min.replace(tzinfo=UTC)):
                last_started_dt[route_id] = timestamp
                details[route_id]["last_started_at"] = timestamp_raw
            continue

        if attempt_id in finishes:
            raise AttemptLedgerError("ATTEMPT_LEDGER_DUPLICATE_FINISH")
        finishes.add(attempt_id)
        start = starts.get(attempt_id)
        if start is None:
            raise AttemptLedgerError("ATTEMPT_LEDGER_START_MISSING")
        if start.get("route_id") != route_id:
            raise AttemptLedgerError("ATTEMPT_LEDGER_FINISH_ROUTE_MISMATCH")
        identity_fields = ("role", "route_id", "priority", "runtime", "target", "operation_key")
        if any(start.get(field) != row.get(field) for field in identity_fields):
            raise AttemptLedgerError("ATTEMPT_LEDGER_FINISH_IDENTITY_MISMATCH")
        if not selected:
            continue

        outcome = row.get("outcome")
        if outcome not in {"SUCCEEDED", "FAILED", "BLOCKED"}:
            raise AttemptLedgerError("ATTEMPT_LEDGER_OUTCOME_INVALID")
        failure_class = row.get("failure_class")
        fallback_reason = row.get("fallback_reason")
        duration_ms = row.get("duration_ms")
        if failure_class is not None and not isinstance(failure_class, str):
            raise AttemptLedgerError("ATTEMPT_LEDGER_FAILURE_CLASS_INVALID")
        if fallback_reason is not None and not isinstance(fallback_reason, str):
            raise AttemptLedgerError("ATTEMPT_LEDGER_FALLBACK_REASON_INVALID")
        if duration_ms is not None and (
            not isinstance(duration_ms, int) or isinstance(duration_ms, bool) or duration_ms < 0
        ):
            raise AttemptLedgerError("ATTEMPT_LEDGER_DURATION_INVALID")

        count = counters[route_id]
        count["finished_count"] += 1
        outcome_key = {
            "SUCCEEDED": "succeeded_count",
            "FAILED": "failed_count",
            "BLOCKED": "blocked_count",
        }[outcome]
        count[outcome_key] += 1
        if timestamp >= cutoff:
            recent_key = {
                "SUCCEEDED": "recent_succeeded_count",
                "FAILED": "recent_failed_count",
                "BLOCKED": "recent_blocked_count",
            }[outcome]
            count[recent_key] += 1
        if outcome == "SUCCEEDED":
            previous_success = details[route_id]["last_success_at"]
            if not isinstance(previous_success, str) or timestamp >= datetime.fromisoformat(
                previous_success
            ).astimezone(UTC):
                details[route_id]["last_success_at"] = timestamp_raw
        if timestamp >= last_finished_dt.get(route_id, datetime.min.replace(tzinfo=UTC)):
            last_finished_dt[route_id] = timestamp
            details[route_id].update(
                {
                    "last_finished_at": timestamp_raw,
                    "last_outcome": outcome,
                    "last_failure_class": failure_class,
                    "last_fallback_reason": fallback_reason,
                    "last_duration_ms": duration_ms,
                }
            )

    summaries: dict[str, RouteAttemptSummary] = {}
    for route_id, count in counters.items():
        detail = details[route_id]
        summaries[route_id] = RouteAttemptSummary(
            route_id=route_id,
            attempt_count=count["attempt_count"],
            finished_count=count["finished_count"],
            open_count=count["attempt_count"] - count["finished_count"],
            succeeded_count=count["succeeded_count"],
            failed_count=count["failed_count"],
            blocked_count=count["blocked_count"],
            recent_attempt_count=count["recent_attempt_count"],
            recent_succeeded_count=count["recent_succeeded_count"],
            recent_failed_count=count["recent_failed_count"],
            recent_blocked_count=count["recent_blocked_count"],
            last_started_at=detail["last_started_at"] if isinstance(detail["last_started_at"], str) else None,
            last_finished_at=detail["last_finished_at"] if isinstance(detail["last_finished_at"], str) else None,
            last_success_at=detail["last_success_at"] if isinstance(detail["last_success_at"], str) else None,
            last_outcome=detail["last_outcome"] if detail["last_outcome"] in {"SUCCEEDED", "FAILED", "BLOCKED"} else None,
            last_failure_class=detail["last_failure_class"] if isinstance(detail["last_failure_class"], str) else None,
            last_fallback_reason=detail["last_fallback_reason"] if isinstance(detail["last_fallback_reason"], str) else None,
            last_duration_ms=detail["last_duration_ms"] if isinstance(detail["last_duration_ms"], int) else None,
        )
    return summaries


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
    "OpenAttempt",
    "RouteAttemptSummary",
]
