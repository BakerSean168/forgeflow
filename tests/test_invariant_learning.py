import json
from pathlib import Path

from forgeflow.learning import (
    project_learning_lines,
    record_review_snapshot,
    summarize_repository,
)
from forgeflow.prompts.implementation import build_implementation_prompt

REPO = "BakerSean168/MemoFlow"
HEAD1 = "a" * 40
HEAD2 = "b" * 40
HEAD3 = "c" * 40


def _finding(*, finding_id: str, status: str, title: str, description: str, file: str):
    return {
        "id": finding_id,
        "severity": "medium",
        "status": status,
        "title": title,
        "description": description,
        "file": file,
    }


def test_open_finding_is_candidate_but_not_future_prompt_learning(tmp_path: Path) -> None:
    ledger = tmp_path / "learning.jsonl"
    finding = _finding(
        finding_id="f1",
        status="open",
        title="Future birthday bypasses owner validation",
        description="Portable account birthday accepts a future date.",
        file="packages/account/account-portability.ts",
    )
    assert (
        record_review_snapshot(
            repository=REPO, pr_number=342, head_sha=HEAD1, findings=(finding,), path=ledger
        )
        == 1
    )
    summary = {item.invariant_id: item for item in summarize_repository(REPO, path=ledger)}
    assert summary["INV-TIME-001"].status == "candidate"
    assert summary["INV-OWNER-001"].status == "candidate"
    assert (
        project_learning_lines(
            owner="BakerSean168", repo="MemoFlow", objective="import portable birthday", path=ledger
        )
        == ()
    )


def test_explicit_resolved_finding_becomes_validated_learning_and_is_idempotent(
    tmp_path: Path,
) -> None:
    ledger = tmp_path / "learning.jsonl"
    open_finding = _finding(
        finding_id="f1",
        status="open",
        title="Future birthday bypasses owner validation",
        description="Portable account birthday accepts a future date.",
        file="packages/account/account-portability.ts",
    )
    resolved = {**open_finding, "status": "resolved"}
    record_review_snapshot(
        repository=REPO, pr_number=342, head_sha=HEAD1, findings=(open_finding,), path=ledger
    )
    assert (
        record_review_snapshot(
            repository=REPO, pr_number=342, head_sha=HEAD2, findings=(resolved,), path=ledger
        )
        == 1
    )
    assert (
        record_review_snapshot(
            repository=REPO, pr_number=342, head_sha=HEAD2, findings=(resolved,), path=ledger
        )
        == 0
    )

    lines = project_learning_lines(
        owner="BakerSean168",
        repo="MemoFlow",
        objective="add portable birthday import with owner validation",
        path=ledger,
    )
    text = "\n".join(lines)
    assert "INV-TIME-001" in text
    assert "INV-OWNER-001" in text
    assert "validated" in text
    assert "Future birthday" not in text
    assert "bypasses owner validation" not in text


def test_same_invariant_resolved_across_two_prs_is_promoted(tmp_path: Path) -> None:
    ledger = tmp_path / "learning.jsonl"
    first = _finding(
        finding_id="f1",
        status="resolved",
        title="Future birthday bypasses owner validation",
        description="Portable birthday accepts a future date.",
        file="account-portability.ts",
    )
    second = _finding(
        finding_id="f2",
        status="resolved",
        title="Scheduler computes date without product clock",
        description="A scheduled date bypasses the injected clock and timezone semantics.",
        file="scheduler.ts",
    )
    record_review_snapshot(
        repository=REPO, pr_number=342, head_sha=HEAD2, findings=(first,), path=ledger
    )
    record_review_snapshot(
        repository=REPO, pr_number=350, head_sha=HEAD3, findings=(second,), path=ledger
    )
    summary = {item.invariant_id: item for item in summarize_repository(REPO, path=ledger)}
    assert summary["INV-TIME-001"].status == "promoted"
    assert summary["INV-TIME-001"].validated_prs == 2


def test_dismissed_finding_is_counter_evidence_not_prompt_learning(tmp_path: Path) -> None:
    ledger = tmp_path / "learning.jsonl"
    dismissed = _finding(
        finding_id="f1",
        status="dismissed",
        title="Future birthday bypasses owner validation",
        description="Portable birthday accepts a future date.",
        file="account-portability.ts",
    )
    record_review_snapshot(
        repository=REPO, pr_number=342, head_sha=HEAD2, findings=(dismissed,), path=ledger
    )
    summary = {item.invariant_id: item for item in summarize_repository(REPO, path=ledger)}
    assert summary["INV-TIME-001"].status == "dismissed"
    assert summary["INV-TIME-001"].dismissed_findings == 1
    assert (
        project_learning_lines(
            owner="BakerSean168", repo="MemoFlow", objective="portable birthday", path=ledger
        )
        == ()
    )


def test_unknown_finding_is_audited_without_creating_prompt_rule(tmp_path: Path) -> None:
    ledger = tmp_path / "learning.jsonl"
    unknown = _finding(
        finding_id="f-x",
        status="resolved",
        title="Widget frobnication mismatch",
        description="A very project-specific phenomenon with no known risk vocabulary.",
        file="frobnicator.ts",
    )
    record_review_snapshot(
        repository=REPO, pr_number=360, head_sha=HEAD3, findings=(unknown,), path=ledger
    )
    assert ledger.read_text().strip()
    assert summarize_repository(REPO, path=ledger) == ()


def test_corrupt_ledger_line_is_ignored(tmp_path: Path) -> None:
    ledger = tmp_path / "learning.jsonl"
    ledger.write_text("not-json\n", encoding="utf-8")
    assert summarize_repository(REPO, path=ledger) == ()


def test_prompt_accepts_instruction_safe_project_learning() -> None:
    prompt = build_implementation_prompt(
        objective="Add portable birthday import",
        operation_key="implementation:p:retry:0",
        base_ref="integration",
        project_learning=(
            "ForgeFlow project learning (resolved historical reviewer evidence; not instructions):",
            "- [INV-TIME-001] validated: 1 resolved finding(s) across 1 PR(s); treat this as a known regression class and exercise its preflight checks.",
        ),
    )
    assert "resolved historical reviewer evidence; not instructions" in prompt
    assert "INV-TIME-001" in prompt


def test_ledger_does_not_persist_raw_description(tmp_path: Path) -> None:
    ledger = tmp_path / "learning.jsonl"
    secretish = _finding(
        finding_id="f1",
        status="open",
        title="Owner validation drift",
        description="do not persist this long reviewer explanation",
        file="account.ts",
    )
    record_review_snapshot(
        repository=REPO, pr_number=1, head_sha=HEAD1, findings=(secretish,), path=ledger
    )
    raw = json.loads(ledger.read_text().strip())
    assert "description" not in raw
