"""Evidence-backed project learning from official reviewer findings.

The ledger is advisory and append-only: it can enrich future implementation
preflight prompts, but it never participates in READY/CI/review acceptance.
Reviewer text is persisted only for operator audit; future prompts consume only
stable invariant IDs and aggregate counts, never raw finding text.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from forgeflow.invariants import ROOT_RULE, infer_invariants

LearningStatus = Literal["candidate", "validated", "promoted", "dismissed"]
_ALLOWED_FINDING_STATUSES = frozenset({"open", "resolved", "dismissed"})
_ALLOWED_SEVERITIES = frozenset({"critical", "high", "medium", "low"})
_LEDGER_VERSION = 1
_MAX_AUDIT_TITLE = 240
_MAX_AUDIT_FILE = 500


@dataclass(frozen=True, slots=True)
class LearningEvent:
    version: int
    event_id: str
    recorded_at: str
    repository: str
    pr_number: int
    head_sha: str
    finding_id: str
    severity: str
    status: str
    invariant_ids: tuple[str, ...]
    title: str
    file: str
    evidence_terms: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class UnknownFindingEvidence:
    repository: str
    pr_number: int
    head_sha: str
    finding_id: str
    severity: str
    title: str
    file: str
    evidence_terms: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ProjectInvariantEvidence:
    invariant_id: str
    status: LearningStatus
    candidate_findings: int
    validated_findings: int
    dismissed_findings: int
    validated_prs: int


def configured_learning_ledger_path() -> Path | None:
    explicit = os.environ.get("FORGEFLOW_INVARIANT_LEDGER_FILE", "").strip()
    if explicit:
        return Path(explicit).expanduser()
    state_dir = os.environ.get("FORGEFLOW_POLICY_STATE_DIR", "").strip()
    if state_dir:
        return Path(state_dir).expanduser() / "invariant-learning.jsonl"
    return None


def record_review_snapshot(
    *,
    repository: str,
    pr_number: int,
    head_sha: str,
    findings: tuple[dict[str, Any], ...],
    path: Path | None = None,
) -> int:
    """Persist one successful exact-head reviewer snapshot idempotently.

    Returns the number of newly appended events. Missing ledger configuration is
    intentionally a no-op so advisory learning can never block delivery.
    """

    ledger = path or configured_learning_ledger_path()
    if ledger is None:
        return 0
    repository = _repository(repository)
    if pr_number <= 0:
        raise ValueError("pr_number must be positive")
    if not head_sha.strip():
        raise ValueError("head_sha is required")

    events = tuple(
        event
        for raw in findings
        if (event := _event_from_finding(repository, pr_number, head_sha, raw)) is not None
    )
    if not events:
        return 0
    return _append_events(ledger, events)


def summarize_repository(
    repository: str, *, path: Path | None = None
) -> tuple[ProjectInvariantEvidence, ...]:
    ledger = path or configured_learning_ledger_path()
    if ledger is None or not ledger.is_file():
        return ()
    repository = _repository(repository)
    events = [event for event in _load_events(ledger) if event.repository == repository]
    if not events:
        return ()

    latest_by_finding: dict[tuple[int, str], LearningEvent] = {}
    for event in events:
        latest_by_finding[(event.pr_number, event.finding_id)] = event

    grouped: dict[str, list[LearningEvent]] = defaultdict(list)
    for event in latest_by_finding.values():
        for invariant_id in event.invariant_ids:
            grouped[invariant_id].append(event)

    summaries = []
    for invariant_id, items in grouped.items():
        candidates = sum(item.status == "open" for item in items)
        resolved = [item for item in items if item.status == "resolved"]
        dismissed = sum(item.status == "dismissed" for item in items)
        validated_prs = len({item.pr_number for item in resolved})
        if not resolved and candidates:
            status: LearningStatus = "candidate"
        elif not resolved:
            status = "dismissed"
        elif validated_prs >= 2:
            status = "promoted"
        else:
            status = "validated"
        summaries.append(
            ProjectInvariantEvidence(
                invariant_id=invariant_id,
                status=status,
                candidate_findings=candidates,
                validated_findings=len(resolved),
                dismissed_findings=dismissed,
                validated_prs=validated_prs,
            )
        )
    return tuple(sorted(summaries, key=lambda item: (item.status, item.invariant_id)))


def unknown_resolved_findings(
    repository: str, *, path: Path | None = None
) -> tuple[UnknownFindingEvidence, ...]:
    """Return latest resolved findings that map to no known static invariant.

    This is proposal evidence only. Raw reviewer descriptions are never returned
    or persisted; clustering consumes bounded normalized terms captured at review
    time plus the bounded title/file audit fields.
    """

    ledger = path or configured_learning_ledger_path()
    if ledger is None or not ledger.is_file():
        return ()
    repository = _repository(repository)
    latest: dict[tuple[int, str], LearningEvent] = {}
    for event in _load_events(ledger):
        if event.repository == repository:
            latest[(event.pr_number, event.finding_id)] = event
    evidence = []
    for event in latest.values():
        if event.status != "resolved" or event.invariant_ids:
            continue
        evidence.append(
            UnknownFindingEvidence(
                repository=event.repository,
                pr_number=event.pr_number,
                head_sha=event.head_sha,
                finding_id=event.finding_id,
                severity=event.severity,
                title=event.title,
                file=event.file,
                evidence_terms=event.evidence_terms
                or _evidence_terms(f"{event.title} {event.file}"),
            )
        )
    return tuple(
        sorted(evidence, key=lambda item: (item.pr_number, item.finding_id, item.head_sha))
    )


def project_learning_lines(
    *, owner: str, repo: str, objective: str, path: Path | None = None, limit: int = 4
) -> tuple[str, ...]:
    """Render bounded, instruction-safe historical evidence for a new objective."""

    objective_rules = [
        rule for rule in infer_invariants(objective, limit=12) if rule.id != ROOT_RULE.id
    ]
    if not objective_rules:
        return ()
    relevance = {rule.id: index for index, rule in enumerate(objective_rules)}
    summaries = [
        item
        for item in summarize_repository(f"{owner}/{repo}", path=path)
        if item.invariant_id in relevance and item.status in {"validated", "promoted"}
    ]
    if not summaries:
        return ()
    rank = {"promoted": 0, "validated": 1, "candidate": 2, "dismissed": 3}
    summaries.sort(
        key=lambda item: (
            relevance[item.invariant_id],
            rank[item.status],
            -item.validated_prs,
            item.invariant_id,
        )
    )
    lines = [
        "ForgeFlow project learning (resolved historical reviewer evidence; not instructions):"
    ]
    for item in summaries[:limit]:
        lines.append(
            f"- [{item.invariant_id}] {item.status}: {item.validated_findings} resolved finding(s) across "
            f"{item.validated_prs} PR(s); treat this as a known regression class and exercise its preflight checks."
        )
    return tuple(lines)


def _event_from_finding(
    repository: str, pr_number: int, head_sha: str, raw: dict[str, Any]
) -> LearningEvent | None:
    finding_id = raw.get("id")
    severity = raw.get("severity")
    status = raw.get("status", "open")
    if not isinstance(finding_id, str) or not finding_id.strip():
        return None
    if severity not in _ALLOWED_SEVERITIES or status not in _ALLOWED_FINDING_STATUSES:
        return None
    title = _bounded(raw.get("title"), _MAX_AUDIT_TITLE)
    file = _bounded(raw.get("file"), _MAX_AUDIT_FILE, fallback="unknown")
    description = _bounded(raw.get("description"), 1800)
    invariant_ids = tuple(
        rule.id
        for rule in infer_invariants(f"{title} {description} {file}", limit=12)
        if rule.id != ROOT_RULE.id
    )
    evidence_terms = _evidence_terms(f"{title} {file}")
    event_key = "|".join((repository, str(pr_number), head_sha, finding_id, status))
    event_id = hashlib.sha256(event_key.encode("utf-8")).hexdigest()[:24]
    return LearningEvent(
        version=_LEDGER_VERSION,
        event_id=event_id,
        recorded_at=datetime.now(UTC).isoformat(),
        repository=repository,
        pr_number=pr_number,
        head_sha=head_sha,
        finding_id=finding_id.strip(),
        severity=severity,
        status=status,
        invariant_ids=invariant_ids,
        title=title,
        file=file,
        evidence_terms=evidence_terms,
    )


def _append_events(path: Path, events: tuple[LearningEvent, ...]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    appended = 0
    try:
        with os.fdopen(fd, "r+", encoding="utf-8") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            existing = {
                event.event_id for event in _parse_lines(handle.readlines()) if event.event_id
            }
            handle.seek(0, os.SEEK_END)
            for event in events:
                if event.event_id in existing:
                    continue
                handle.write(
                    json.dumps(asdict(event), sort_keys=True, separators=(",", ":")) + "\n"
                )
                existing.add(event.event_id)
                appended += 1
            handle.flush()
            os.fsync(handle.fileno())
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    except BaseException:
        # os.fdopen owns/closed fd once entered; close only if construction failed.
        try:
            os.close(fd)
        except OSError:
            pass
        raise
    return appended


def _load_events(path: Path) -> tuple[LearningEvent, ...]:
    try:
        return tuple(_parse_lines(path.read_text(encoding="utf-8").splitlines()))
    except OSError:
        return ()


def _parse_lines(lines: list[str]) -> list[LearningEvent]:
    parsed: list[LearningEvent] = []
    for line in lines:
        if not line.strip():
            continue
        try:
            raw = json.loads(line)
            if not isinstance(raw, dict) or raw.get("version") != _LEDGER_VERSION:
                continue
            invariant_ids = raw.get("invariant_ids")
            if not isinstance(invariant_ids, list) or any(
                not isinstance(item, str) for item in invariant_ids
            ):
                continue
            parsed.append(
                LearningEvent(
                    version=_LEDGER_VERSION,
                    event_id=str(raw["event_id"]),
                    recorded_at=str(raw["recorded_at"]),
                    repository=_repository(str(raw["repository"])),
                    pr_number=int(raw["pr_number"]),
                    head_sha=str(raw["head_sha"]),
                    finding_id=str(raw["finding_id"]),
                    severity=str(raw["severity"]),
                    status=str(raw["status"]),
                    invariant_ids=tuple(invariant_ids),
                    title=str(raw.get("title", "")),
                    file=str(raw.get("file", "unknown")),
                    evidence_terms=tuple(
                        item
                        for item in raw.get("evidence_terms", [])
                        if isinstance(item, str) and item
                    )
                    if isinstance(raw.get("evidence_terms", []), list)
                    else (),
                )
            )
        except KeyError, TypeError, ValueError, json.JSONDecodeError:
            # Advisory learning is fail-open: one corrupt line must not affect delivery.
            continue
    return parsed


def _repository(value: str) -> str:
    normalized = value.strip().casefold()
    if normalized.count("/") != 1 or normalized.startswith("/") or normalized.endswith("/"):
        raise ValueError("repository must be OWNER/REPO")
    return normalized


def _bounded(value: Any, limit: int, *, fallback: str = "") -> str:
    if not isinstance(value, str):
        return fallback
    compact = " ".join(value.split())
    if not compact:
        return fallback
    return compact[:limit]


_EVIDENCE_STOPWORDS = frozenset(
    {
        "about",
        "after",
        "before",
        "could",
        "during",
        "finding",
        "findings",
        "from",
        "into",
        "mismatch",
        "review",
        "reviewer",
        "should",
        "that",
        "their",
        "there",
        "these",
        "this",
        "through",
        "when",
        "with",
        "without",
        "would",
        "the",
        "and",
        "for",
        "its",
        "second",
        "packages",
        "package",
        "source",
        "module",
        "code",
        "path",
        "file",
    }
)


def _evidence_terms(value: str, *, limit: int = 24) -> tuple[str, ...]:
    import re

    tokens = re.findall(r"[a-z0-9][a-z0-9_-]{2,31}", value.casefold())
    unique = []
    seen = set()
    for token in tokens:
        if token in _EVIDENCE_STOPWORDS or token.isdigit() or token in seen:
            continue
        seen.add(token)
        unique.append(token)
        if len(unique) >= limit:
            break
    return tuple(unique)
