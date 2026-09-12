import json
import stat
from pathlib import Path

import pytest

from forgeflow.attempts import AttemptLedger


def test_attempt_ledger_is_append_only_and_private(tmp_path: Path) -> None:
    path = tmp_path / "state" / "attempt-ledger.jsonl"
    ledger = AttemptLedger(path)
    handle = ledger.start(
        role="IMPLEMENT",
        route_id="external",
        priority=20,
        runtime="EXTERNAL_ACP",
        target="account-label",
        operation_key="op:1",
        source_revision="a" * 40,
    )
    ledger.finish(
        handle,
        outcome="SUCCEEDED",
        source_revision="a" * 40,
        result_revision="b" * 40,
        external_session_id="session",
        external_conversation_id="conversation",
    )
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    assert [row["event"] for row in rows] == ["STARTED", "FINISHED"]
    assert rows[0]["attempt_id"] == rows[1]["attempt_id"] == handle.attempt_id
    assert rows[1]["outcome"] == "SUCCEEDED"
    assert rows[1]["result_revision"] == "b" * 40
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_failed_attempt_records_bounded_failure_metadata(tmp_path: Path) -> None:
    ledger = AttemptLedger(tmp_path / "attempt-ledger.jsonl")
    handle = ledger.start(
        role="IMPLEMENT",
        route_id="route",
        priority=10,
        runtime="OPEN_SWE",
        target="current-model-policy",
        operation_key="op:2",
    )
    ledger.finish(handle, outcome="FAILED", failure_class="ROUTE_AVAILABILITY", fallback_reason="timeout")
    row = json.loads(ledger.path.read_text(encoding="utf-8").splitlines()[-1])
    assert row["failure_class"] == "ROUTE_AVAILABILITY"
    assert row["fallback_reason"] == "timeout"
    assert row["duration_ms"] >= 0


def test_ensure_started_reuses_open_operation_and_finish_is_idempotent(tmp_path: Path) -> None:
    path = tmp_path / "attempt-ledger.jsonl"
    ledger = AttemptLedger(path)
    first = ledger.ensure_started(
        role="IMPLEMENT",
        route_id="openswe-current",
        priority=10,
        runtime="OPEN_SWE",
        target="current-model-policy",
        operation_key="implementation:policy:retry:0",
    )
    second = ledger.ensure_started(
        role="IMPLEMENT",
        route_id="openswe-current",
        priority=10,
        runtime="OPEN_SWE",
        target="current-model-policy",
        operation_key="implementation:policy:retry:0",
    )
    assert first.finished is False
    assert second.finished is False
    assert second.handle.attempt_id == first.handle.attempt_id

    closed_id = ledger.finish_operation(
        route_id="openswe-current",
        operation_key="implementation:policy:retry:0",
        outcome="SUCCEEDED",
        result_revision="b" * 40,
    )
    repeated_id = ledger.finish_operation(
        route_id="openswe-current",
        operation_key="implementation:policy:retry:0",
        outcome="SUCCEEDED",
        result_revision="b" * 40,
    )
    assert closed_id == repeated_id == first.handle.attempt_id
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    assert [row["event"] for row in rows] == ["STARTED", "FINISHED"]


def test_ensure_started_recovers_finished_operation_without_appending(tmp_path: Path) -> None:
    path = tmp_path / "attempt-ledger.jsonl"
    ledger = AttemptLedger(path)
    status = ledger.ensure_started(
        role="IMPLEMENT",
        route_id="openswe-current",
        priority=10,
        runtime="OPEN_SWE",
        target="current-model-policy",
        operation_key="op:closed",
    )
    ledger.finish_operation(
        route_id="openswe-current",
        operation_key="op:closed",
        outcome="FAILED",
        failure_class="TASK_FAILURE",
        fallback_reason="NO_PROGRESS",
    )
    recovered = ledger.ensure_started(
        role="IMPLEMENT",
        route_id="openswe-current",
        priority=10,
        runtime="OPEN_SWE",
        target="current-model-policy",
        operation_key="op:closed",
    )
    assert recovered.finished is True
    assert recovered.handle.attempt_id == status.handle.attempt_id
    assert len(path.read_text(encoding="utf-8").splitlines()) == 2


def test_idempotent_finish_rejects_conflicting_result(tmp_path: Path) -> None:
    from forgeflow.attempts import AttemptLedgerError

    ledger = AttemptLedger(tmp_path / "attempt-ledger.jsonl")
    ledger.ensure_started(
        role="IMPLEMENT",
        route_id="openswe-current",
        priority=10,
        runtime="OPEN_SWE",
        target="current-model-policy",
        operation_key="op:conflict",
    )
    ledger.finish_operation(
        route_id="openswe-current",
        operation_key="op:conflict",
        outcome="SUCCEEDED",
        result_revision="a" * 40,
    )
    with pytest.raises(AttemptLedgerError, match="FINISH_RESULT_MISMATCH"):
        ledger.finish_operation(
            route_id="openswe-current",
            operation_key="op:conflict",
            outcome="SUCCEEDED",
            result_revision="b" * 40,
        )


def test_recovered_start_rejects_source_revision_drift(tmp_path: Path) -> None:
    from forgeflow.attempts import AttemptLedgerError

    ledger = AttemptLedger(tmp_path / "attempt-ledger.jsonl")
    ledger.ensure_started(
        role="IMPLEMENT",
        route_id="openswe-current",
        priority=10,
        runtime="OPEN_SWE",
        target="current-model-policy",
        operation_key="repair:1",
        source_revision="a" * 40,
    )
    with pytest.raises(AttemptLedgerError, match="OPERATION_SOURCE_MISMATCH"):
        ledger.ensure_started(
            role="IMPLEMENT",
            route_id="openswe-current",
            priority=10,
            runtime="OPEN_SWE",
            target="current-model-policy",
            operation_key="repair:1",
            source_revision="b" * 40,
        )


def test_torn_uncommitted_tail_is_truncated_and_recovery_continues(tmp_path: Path) -> None:
    path = tmp_path / "attempt-ledger.jsonl"
    ledger = AttemptLedger(path)
    first = ledger.ensure_started(
        role="IMPLEMENT",
        route_id="openswe-current",
        priority=10,
        runtime="OPEN_SWE",
        target="current-model-policy",
        operation_key="op:torn",
    )
    with path.open("a", encoding="utf-8") as handle:
        handle.write('{"version":1,"event":"FIN')
        handle.flush()

    recovered = ledger.ensure_started(
        role="IMPLEMENT",
        route_id="openswe-current",
        priority=10,
        runtime="OPEN_SWE",
        target="current-model-policy",
        operation_key="op:torn",
    )

    assert recovered.handle.attempt_id == first.handle.attempt_id
    assert recovered.finished is False
    text = path.read_text(encoding="utf-8")
    assert '"FIN' not in text
    assert text.endswith("\n")
    assert len(text.splitlines()) == 1


def test_committed_corrupt_row_remains_fail_closed(tmp_path: Path) -> None:
    from forgeflow.attempts import AttemptLedgerError

    path = tmp_path / "attempt-ledger.jsonl"
    ledger = AttemptLedger(path)
    ledger.ensure_started(
        role="IMPLEMENT",
        route_id="openswe-current",
        priority=10,
        runtime="OPEN_SWE",
        target="current-model-policy",
        operation_key="op:corrupt",
    )
    with path.open("a", encoding="utf-8") as handle:
        handle.write('{not-json}\n')

    with pytest.raises(AttemptLedgerError, match="ATTEMPT_LEDGER_INVALID_JSON"):
        ledger.ensure_started(
            role="IMPLEMENT",
            route_id="openswe-current",
            priority=10,
            runtime="OPEN_SWE",
            target="current-model-policy",
            operation_key="op:next",
        )


def test_operation_status_is_non_mutating(tmp_path: Path) -> None:
    path = tmp_path / "attempt-ledger.jsonl"
    ledger = AttemptLedger(path)
    assert ledger.operation_status(route_id="openswe-current", operation_key="op:missing") is None
    assert path.read_text(encoding="utf-8") == ""

    started = ledger.ensure_started(
        role="IMPLEMENT",
        route_id="openswe-current",
        priority=10,
        runtime="OPEN_SWE",
        target="current-model-policy",
        operation_key="op:status",
    )
    current = ledger.operation_status(route_id="openswe-current", operation_key="op:status")
    assert current is not None and current.finished is False
    assert current.handle.attempt_id == started.handle.attempt_id

    ledger.finish_operation(
        route_id="openswe-current",
        operation_key="op:status",
        outcome="BLOCKED",
        failure_class="POLICY_DENIED",
        fallback_reason="POLICY_CANCELLED",
    )
    finished = ledger.operation_status(route_id="openswe-current", operation_key="op:status")
    assert finished is not None and finished.finished is True
    assert len(path.read_text(encoding="utf-8").splitlines()) == 2
