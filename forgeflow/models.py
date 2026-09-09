"""Normalized evidence objects consumed by the pure ForgeFlow policy kernel."""

from dataclasses import dataclass
from typing import Literal

FindingSeverity = Literal["critical", "high", "medium", "low"]
PolicySeverity = Literal["P0", "P1", "P2", "P3"]
CiStatus = Literal["PENDING", "PASS", "FAIL", "UNRESOLVED"]


@dataclass(frozen=True, slots=True)
class ImplementationEvidence:
    pr_url: str
    pr_number: int
    head_sha: str
    progressed: bool
    failure_code: str | None = None


@dataclass(frozen=True, slots=True)
class CiDecision:
    head_sha: str
    status: CiStatus
    failure_code: str | None = None


@dataclass(frozen=True, slots=True)
class FindingSummary:
    id: str
    severity: FindingSeverity
    status: Literal["open", "resolved", "dismissed"] = "open"


@dataclass(frozen=True, slots=True)
class ReviewDecision:
    head_sha: str
    reviewer_thread_id: str
    reviewer_run_id: str
    findings: tuple[FindingSummary, ...] = ()


@dataclass(frozen=True, slots=True)
class RepositoryPolicy:
    ci_required: bool = True
    required_checks: tuple[str, ...] = ()
