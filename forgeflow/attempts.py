"""Append-only execution-attempt ledger for auditable route decisions."""

from __future__ import annotations

import fcntl
import json
import os
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

AttemptEventKind = Literal["STARTED", "FINISHED"]
AttemptOutcome = Literal["SUCCEEDED", "FAILED", "BLOCKED"]


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
    started_monotonic: float


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
        if not all(value.strip() for value in (role, route_id, runtime, target, operation_key)):
            raise ValueError("attempt identity fields are required")
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
            started_monotonic=time.monotonic(),
        )
        self._append(
            {
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
        )
        return handle

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
        if outcome == "SUCCEEDED" and failure_class is not None:
            raise ValueError("successful attempt cannot have failure_class")
        finished = datetime.now(UTC).isoformat()
        self._append(
            {
                "version": 1,
                "event": "FINISHED",
                "timestamp": finished,
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
                "duration_ms": max(0, round((time.monotonic() - handle.started_monotonic) * 1000)),
                "source_revision": source_revision,
                "result_revision": result_revision,
                "external_session_id": external_session_id,
                "external_conversation_id": external_conversation_id,
            }
        )

    def _append(self, payload: dict[str, object]) -> None:
        parent = self._path.parent
        parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            parent.chmod(0o700)
        except OSError:
            pass
        fd = os.open(self._path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "a", encoding="utf-8", closefd=False) as handle:
                fcntl.flock(fd, fcntl.LOCK_EX)
                handle.write(json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n")
                handle.flush()
                os.fsync(fd)
                fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


__all__ = ["AttemptHandle", "AttemptLedger", "AttemptOutcome"]
