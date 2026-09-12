import json
import stat
from pathlib import Path

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
