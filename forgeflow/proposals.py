"""Evidence-gated invariant proposals learned from previously unknown reviewer findings.

Unknown reviewer findings are never promoted directly into implementation prompts.
This module clusters only resolved findings from independent PRs, creates stable
proposal identities, records independent review decisions in an append-only ledger,
and exposes accepted project-scoped dynamic invariant rules.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from forgeflow.invariants import InvariantRule, _normalized_terms
from forgeflow.learning import UnknownFindingEvidence, unknown_resolved_findings

ProposalStatus = Literal["pending", "accepted", "rejected", "needs_more_evidence"]
_PROPOSAL_VERSION = 1
_MIN_DISTINCT_PRS = 2
_MIN_SHARED_TERMS = 2
_MIN_JACCARD = 0.30
_MAX_TERMS = 12
_MAX_EVIDENCE = 8


@dataclass(frozen=True, slots=True)
class InvariantProposalCandidate:
    proposal_id: str
    revision_id: str
    repository: str
    dynamic_rule_id: str
    evidence_count: int
    pr_numbers: tuple[int, ...]
    evidence_ids: tuple[str, ...]
    representative_terms: tuple[str, ...]
    titles: tuple[str, ...]
    files: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class InvariantProposalDecision:
    decision: Literal["accept", "reject", "needs_more_evidence"]
    title: str = ""
    triggers: tuple[str, ...] = ()
    check: str = ""
    adversarial: str = ""
    rationale: str = ""


@dataclass(frozen=True, slots=True)
class ProposalEvent:
    version: int
    event_id: str
    recorded_at: str
    proposal_id: str
    revision_id: str
    repository: str
    dynamic_rule_id: str
    status: ProposalStatus
    evidence_count: int
    pr_numbers: tuple[int, ...]
    evidence_ids: tuple[str, ...]
    representative_terms: tuple[str, ...]
    reviewer_run_id: str | None = None
    reviewer_model_id: str | None = None
    title: str = ""
    triggers: tuple[str, ...] = ()
    check: str = ""
    adversarial: str = ""
    rationale: str = ""


def configured_proposal_ledger_path() -> Path | None:
    explicit = os.environ.get("FORGEFLOW_INVARIANT_PROPOSAL_FILE", "").strip()
    if explicit:
        return Path(explicit).expanduser()
    state_dir = os.environ.get("FORGEFLOW_POLICY_STATE_DIR", "").strip()
    if state_dir:
        return Path(state_dir).expanduser() / "invariant-proposals.jsonl"
    return None


def discover_proposals(
    repository: str,
    *,
    learning_path: Path | None = None,
) -> tuple[InvariantProposalCandidate, ...]:
    evidence = unknown_resolved_findings(repository, path=learning_path)
    if len(evidence) < 2:
        return ()
    clusters = _clusters(evidence)
    candidates = []
    for cluster in clusters:
        prs = tuple(sorted({item.pr_number for item in cluster}))
        if len(prs) < _MIN_DISTINCT_PRS:
            continue
        ordered = tuple(sorted(cluster, key=_evidence_key))
        core_ids = tuple(_evidence_id(item) for item in ordered)
        anchor_ids = core_ids[:2]
        proposal_seed = "|".join((repository.casefold(), *anchor_ids))
        proposal_id = "prop-" + hashlib.sha256(proposal_seed.encode()).hexdigest()[:16]
        revision_id = "rev-" + hashlib.sha256("|".join(core_ids).encode()).hexdigest()[:16]
        terms = _representative_terms(ordered)
        dynamic_id = "INV-DYN-" + hashlib.sha256(proposal_id.encode()).hexdigest()[:10].upper()
        candidates.append(
            InvariantProposalCandidate(
                proposal_id=proposal_id,
                revision_id=revision_id,
                repository=repository.casefold(),
                dynamic_rule_id=dynamic_id,
                evidence_count=len(ordered),
                pr_numbers=prs,
                evidence_ids=core_ids,
                representative_terms=terms,
                titles=tuple(item.title for item in ordered[:_MAX_EVIDENCE]),
                files=tuple(item.file for item in ordered[:_MAX_EVIDENCE]),
            )
        )
    return tuple(sorted(candidates, key=lambda item: item.proposal_id))


def pending_proposals(
    repository: str,
    *,
    learning_path: Path | None = None,
    proposal_path: Path | None = None,
) -> tuple[InvariantProposalCandidate, ...]:
    ledger = proposal_path or configured_proposal_ledger_path()
    latest = _latest_events(ledger) if ledger is not None else {}
    pending = []
    for candidate in discover_proposals(repository, learning_path=learning_path):
        previous = latest.get(candidate.proposal_id)
        if previous is None:
            pending.append(candidate)
            continue
        if previous.revision_id == candidate.revision_id:
            if previous.status in {"accepted", "rejected", "needs_more_evidence"}:
                continue
            pending.append(candidate)
            continue
        # A new independent finding may reopen a previous reject/needs-more proposal.
        if candidate.evidence_count > previous.evidence_count:
            pending.append(candidate)
    return tuple(pending)


def record_proposal_decision(
    candidate: InvariantProposalCandidate,
    decision: InvariantProposalDecision,
    *,
    reviewer_run_id: str,
    reviewer_model_id: str,
    path: Path | None = None,
) -> ProposalEvent | None:
    ledger = path or configured_proposal_ledger_path()
    if ledger is None:
        return None
    status: ProposalStatus
    if decision.decision == "accept":
        status = "accepted"
        _validate_accepted_rule(candidate, decision)
    elif decision.decision == "reject":
        status = "rejected"
    elif decision.decision == "needs_more_evidence":
        status = "needs_more_evidence"
    else:  # pragma: no cover - Literal contract plus defensive fail-closed
        raise ValueError("unknown proposal decision")

    event_seed = f"{candidate.proposal_id}|{candidate.revision_id}|{status}|{reviewer_run_id}"
    event = ProposalEvent(
        version=_PROPOSAL_VERSION,
        event_id=hashlib.sha256(event_seed.encode()).hexdigest()[:24],
        recorded_at=datetime.now(UTC).isoformat(),
        proposal_id=candidate.proposal_id,
        revision_id=candidate.revision_id,
        repository=candidate.repository,
        dynamic_rule_id=candidate.dynamic_rule_id,
        status=status,
        evidence_count=candidate.evidence_count,
        pr_numbers=candidate.pr_numbers,
        evidence_ids=candidate.evidence_ids,
        representative_terms=candidate.representative_terms,
        reviewer_run_id=_bounded(reviewer_run_id, 120),
        reviewer_model_id=_bounded(reviewer_model_id, 160),
        title=_bounded(decision.title, 100),
        triggers=tuple(decision.triggers),
        check=_bounded(decision.check, 360),
        adversarial=_bounded(decision.adversarial, 360),
        rationale=_bounded(decision.rationale, 500),
    )
    _append_event(ledger, event)
    return event


def accepted_dynamic_rules(
    repository: str, *, path: Path | None = None
) -> tuple[InvariantRule, ...]:
    ledger = path or configured_proposal_ledger_path()
    if ledger is None:
        return ()
    repository = repository.casefold()
    events = _latest_events(ledger)
    rules = []
    for event in events.values():
        if event.repository != repository or event.status != "accepted":
            continue
        rule = InvariantRule(
            id=event.dynamic_rule_id,
            title=event.title,
            triggers=event.triggers,
            check=event.check,
            adversarial=event.adversarial,
        )
        rules.append(rule)
    return tuple(sorted(rules, key=lambda rule: rule.id))


def dynamic_project_lines(
    *, owner: str, repo: str, objective: str, path: Path | None = None, limit: int = 3
) -> tuple[str, ...]:
    normalized = f" {_normalized_terms(objective)} "
    matches = []
    for rule in accepted_dynamic_rules(f"{owner}/{repo}", path=path):
        hits = sum(
            1 for trigger in rule.triggers if f" {_normalized_terms(trigger)} " in normalized
        )
        if hits:
            matches.append((hits, rule))
    if not matches:
        return ()
    matches.sort(key=lambda item: (-item[0], item[1].id))
    lines = ["ForgeFlow accepted project invariants (independently reviewed):"]
    for _hits, rule in matches[:limit]:
        lines.append(f"- [{rule.id}] {rule.title}: {rule.check} Adversarial: {rule.adversarial}")
    return tuple(lines)


def _clusters(
    evidence: tuple[UnknownFindingEvidence, ...],
) -> tuple[tuple[UnknownFindingEvidence, ...], ...]:
    parent = list(range(len(evidence)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(left: int, right: int) -> None:
        lroot, rroot = find(left), find(right)
        if lroot != rroot:
            parent[max(lroot, rroot)] = min(lroot, rroot)

    for left in range(len(evidence)):
        for right in range(left + 1, len(evidence)):
            if evidence[left].pr_number == evidence[right].pr_number:
                continue
            if _similar(evidence[left], evidence[right]):
                union(left, right)

    grouped: dict[int, list[UnknownFindingEvidence]] = {}
    for index, item in enumerate(evidence):
        grouped.setdefault(find(index), []).append(item)
    return tuple(tuple(items) for _key, items in sorted(grouped.items()))


def _similar(left: UnknownFindingEvidence, right: UnknownFindingEvidence) -> bool:
    lterms, rterms = set(left.evidence_terms), set(right.evidence_terms)
    if not lterms or not rterms:
        return False
    shared = lterms & rterms
    if len(shared) < _MIN_SHARED_TERMS:
        return False
    union = lterms | rterms
    return len(shared) / len(union) >= _MIN_JACCARD


def _representative_terms(items: tuple[UnknownFindingEvidence, ...]) -> tuple[str, ...]:
    counts: dict[str, int] = {}
    for item in items:
        for term in set(item.evidence_terms):
            counts[term] = counts.get(term, 0) + 1
    minimum = max(2, (len(items) + 1) // 2)
    selected = [term for term, count in counts.items() if count >= minimum]
    selected.sort(key=lambda term: (-counts[term], term))
    return tuple(selected[:_MAX_TERMS])


def _evidence_key(item: UnknownFindingEvidence) -> tuple[int, str, str]:
    return item.pr_number, item.finding_id, item.head_sha


def _evidence_id(item: UnknownFindingEvidence) -> str:
    raw = "|".join((str(item.pr_number), item.finding_id, item.head_sha))
    return hashlib.sha256(raw.encode()).hexdigest()[:20]


def _validate_accepted_rule(
    candidate: InvariantProposalCandidate, decision: InvariantProposalDecision
) -> None:
    if not decision.title.strip() or len(decision.title.strip()) > 100:
        raise ValueError("accepted proposal requires a bounded title")
    triggers = tuple(
        dict.fromkeys(_normalized_terms(item) for item in decision.triggers if item.strip())
    )
    if not 2 <= len(triggers) <= 6:
        raise ValueError("accepted proposal requires 2-6 unique triggers")
    allowed = set(candidate.representative_terms)
    if any(trigger not in allowed for trigger in triggers):
        raise ValueError("accepted proposal triggers must come from representative evidence terms")
    for label, value, limit in (
        ("check", decision.check, 360),
        ("adversarial", decision.adversarial, 360),
    ):
        compact = " ".join(value.split())
        if not compact or len(compact) > limit:
            raise ValueError(f"accepted proposal {label} must be non-empty and bounded")
        if _unsafe_instruction(compact):
            raise ValueError(f"accepted proposal {label} contains unsafe instruction text")


def _unsafe_instruction(value: str) -> bool:
    lowered = value.casefold()
    forbidden = (
        "ignore previous",
        "ignore all",
        "system prompt",
        "developer message",
        "tool call",
        "execute command",
        "run shell",
        "curl http",
        "rm -rf",
        "sudo ",
        "api key",
        "read secret",
        "```",
        "http://",
        "https://",
    )
    return any(token in lowered for token in forbidden)


def _append_event(path: Path, event: ProposalEvent) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        with os.fdopen(fd, "r+", encoding="utf-8") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            existing = {item.event_id for item in _parse_lines(handle.readlines())}
            if event.event_id not in existing:
                handle.seek(0, os.SEEK_END)
                handle.write(
                    json.dumps(asdict(event), sort_keys=True, separators=(",", ":")) + "\n"
                )
                handle.flush()
                os.fsync(handle.fileno())
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    except BaseException:
        try:
            os.close(fd)
        except OSError:
            pass
        raise


def _latest_events(path: Path | None) -> dict[str, ProposalEvent]:
    if path is None or not path.is_file():
        return {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return {}
    latest = {}
    for event in _parse_lines(lines):
        latest[event.proposal_id] = event
    return latest


def _parse_lines(lines: list[str]) -> list[ProposalEvent]:
    parsed = []
    for line in lines:
        if not line.strip():
            continue
        try:
            raw = json.loads(line)
            if not isinstance(raw, dict) or raw.get("version") != _PROPOSAL_VERSION:
                continue
            parsed.append(
                ProposalEvent(
                    version=_PROPOSAL_VERSION,
                    event_id=str(raw["event_id"]),
                    recorded_at=str(raw["recorded_at"]),
                    proposal_id=str(raw["proposal_id"]),
                    revision_id=str(raw["revision_id"]),
                    repository=str(raw["repository"]).casefold(),
                    dynamic_rule_id=str(raw["dynamic_rule_id"]),
                    status=str(raw["status"]),  # type: ignore[arg-type]
                    evidence_count=int(raw["evidence_count"]),
                    pr_numbers=tuple(int(item) for item in raw.get("pr_numbers", [])),
                    evidence_ids=tuple(str(item) for item in raw.get("evidence_ids", [])),
                    representative_terms=tuple(
                        str(item) for item in raw.get("representative_terms", [])
                    ),
                    reviewer_run_id=_optional_str(raw.get("reviewer_run_id")),
                    reviewer_model_id=_optional_str(raw.get("reviewer_model_id")),
                    title=str(raw.get("title", "")),
                    triggers=tuple(str(item) for item in raw.get("triggers", [])),
                    check=str(raw.get("check", "")),
                    adversarial=str(raw.get("adversarial", "")),
                    rationale=str(raw.get("rationale", "")),
                )
            )
        except KeyError, TypeError, ValueError, json.JSONDecodeError:
            continue
    return parsed


def _optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _bounded(value: str, limit: int) -> str:
    return " ".join(value.split())[:limit]


def proposal_candidate_from_dict(raw: dict[str, Any]) -> InvariantProposalCandidate:
    """Validate the bounded LangGraph/CLI proposal input shape."""
    try:
        candidate = InvariantProposalCandidate(
            proposal_id=_bounded(str(raw["proposal_id"]), 80),
            revision_id=_bounded(str(raw["revision_id"]), 80),
            repository=_bounded(str(raw["repository"]), 180).casefold(),
            dynamic_rule_id=_bounded(str(raw["dynamic_rule_id"]), 80),
            evidence_count=int(raw["evidence_count"]),
            pr_numbers=tuple(int(item) for item in raw["pr_numbers"]),
            evidence_ids=tuple(_bounded(str(item), 80) for item in raw["evidence_ids"]),
            representative_terms=tuple(
                _normalized_terms(str(item)) for item in raw["representative_terms"]
            ),
            titles=tuple(_bounded(str(item), 240) for item in raw["titles"][:_MAX_EVIDENCE]),
            files=tuple(_bounded(str(item), 500) for item in raw["files"][:_MAX_EVIDENCE]),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("invalid invariant proposal candidate") from exc
    if not candidate.proposal_id or not candidate.revision_id:
        raise ValueError("proposal identity is required")
    if candidate.evidence_count < _MIN_DISTINCT_PRS:
        raise ValueError("proposal evidence_count is below review threshold")
    if len(set(candidate.pr_numbers)) < _MIN_DISTINCT_PRS:
        raise ValueError("proposal must contain evidence from independent PRs")
    if not candidate.representative_terms:
        raise ValueError("proposal representative terms are required")
    return candidate
