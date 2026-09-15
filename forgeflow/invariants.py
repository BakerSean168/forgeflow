"""Deterministic engineering-invariant preflight for implementation and repair prompts.

The catalog intentionally stays small and repository-agnostic.  It turns recurring
review findings into stable risk IDs that an implementation agent can apply before
editing, without requiring another model call or another durable workflow stage.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class InvariantRule:
    id: str
    title: str
    triggers: tuple[str, ...]
    check: str
    adversarial: str


ROOT_RULE = InvariantRule(
    id="INV-ROOT-001",
    title="Owner truth before new entrypoints",
    triggers=(),
    check="Inspect the owning domain/contracts/write path before editing; reuse its invariants instead of cloning weaker validation.",
    adversarial="Compare the new path with the canonical owner path for invalid, null, boundary and already-existing inputs.",
)

RULE_PRIORITY: dict[str, int] = {
    "INV-TIME-001": 100,
    "INV-IDENTITY-001": 95,
    "INV-OWNER-001": 90,
    "INV-LIFECYCLE-001": 90,
    "INV-CUTOVER-001": 90,
    "INV-PARITY-001": 85,
    "INV-REPLAY-001": 80,
    "INV-HOST-001": 80,
    "INV-ATOMIC-001": 75,
    "INV-ORDER-001": 70,
}


RULES: tuple[InvariantRule, ...] = (
    InvariantRule(
        id="INV-OWNER-001",
        title="Validation parity",
        triggers=(
            "schema",
            "import",
            "portable",
            "portability",
            "profile",
            "contract",
            "adapter",
            "restore",
        ),
        check="The new schema/import/restore path must be at least as strict as the owner command/domain invariant.",
        adversarial="Try malformed formats, out-of-range values, nullable edges and values rejected by the normal owner mutation path.",
    ),
    InvariantRule(
        id="INV-TIME-001",
        title="Explicit product-time semantics",
        triggers=(
            "birthday",
            "date",
            "time",
            "timezone",
            "dst",
            "schedule",
            "routine",
            "reminder",
            "clock",
        ),
        check="Resolve relative-time rules through the project time abstraction/injected clock and explicit user timezone/day semantics.",
        adversarial="Test future/past boundaries, day rollover, leap day and DST when the domain can observe them.",
    ),
    InvariantRule(
        id="INV-IDENTITY-001",
        title="Identity-scoped ownership",
        triggers=(
            "identity",
            "tenant",
            "user",
            "deterministic",
            "portable",
            "import",
            "restore",
            "ownership",
        ),
        check="IDs, lookups and upserts must not let one identity collide with, mutate or adopt another identity's state.",
        adversarial="Replay the same logical input for two identities and pre-seed a foreign-owned deterministic ID/child ID.",
    ),
    InvariantRule(
        id="INV-LIFECYCLE-001",
        title="Lifecycle and tombstone safety",
        triggers=(
            "status",
            "lifecycle",
            "archive",
            "archived",
            "delete",
            "deleted",
            "restore",
            "replay",
            "cutover",
        ),
        check="Model archived/deleted/terminal states explicitly; preflight must reject transitions the owner commands would reject.",
        adversarial="Exercise active, terminal, archived and soft-deleted targets, including an already-matching terminal replay.",
    ),
    InvariantRule(
        id="INV-REPLAY-001",
        title="Retry and idempotency",
        triggers=(
            "retry",
            "replay",
            "batch",
            "import",
            "restore",
            "idempot",
            "scheduler",
            "routine",
        ),
        check="A retry after partial progress must converge or fail closed without duplicating side effects or silently accepting drift.",
        adversarial="Interrupt after an early write, retry the same batch, then retry with the same identity/key but divergent business facts.",
    ),
    InvariantRule(
        id="INV-PARITY-001",
        title="Equivalent execution paths",
        triggers=(
            "dryrun",
            "dry-run",
            "apply",
            "prisma",
            "powersync",
            "desktop",
            "api",
            "adapter",
            "runtime",
        ),
        check="Dry-run/apply and parallel adapters/runtimes must perform equivalent semantic validation and produce equivalent owner-visible facts.",
        adversarial="Run one valid and one invalid case through every supported path and compare results/order/failure class.",
    ),
    InvariantRule(
        id="INV-ATOMIC-001",
        title="Preflight before mutation",
        triggers=("batch", "bulk", "import", "portable", "portability", "transaction", "apply"),
        check="Validate the whole mutable unit before the first irreversible write unless an owner transaction guarantees rollback.",
        adversarial="Make a later item invalid and verify earlier items were not committed or have an explicit rollback contract.",
    ),
    InvariantRule(
        id="INV-ORDER-001",
        title="Stable canonical ordering",
        triggers=(
            "export",
            "list",
            "sort",
            "order",
            "reference",
            "ref",
            "prisma",
            "powersync",
            "portable",
        ),
        check="Any ordinal/ref-producing output needs one owner-level deterministic ordering shared by all adapters.",
        adversarial="Seed the same logical set in different persistence orders/adapters and compare exported refs byte-for-byte.",
    ),
    InvariantRule(
        id="INV-HOST-001",
        title="Host-owned facts stay host-owned",
        triggers=(
            "portable",
            "portability",
            "backup",
            "import",
            "export",
            "identity",
            "auth",
            "version",
            "timestamp",
        ),
        check="Do not serialize or restore host identity/auth/database IDs/versions/timestamps/derived projections unless explicitly owner-owned.",
        adversarial="Inspect the payload for host identifiers and verify import binds to the target host rather than recreating source ownership.",
    ),
    InvariantRule(
        id="INV-CUTOVER-001",
        title="Single-truth cutover",
        triggers=(
            "cutover",
            "legacy",
            "retire",
            "delete",
            "destructive",
            "dual-write",
            "migration",
        ),
        check="A destructive cutover must name the sole post-cutover truth, characterize old behavior first, and avoid accidental permanent dual-write/read paths.",
        adversarial="Verify old storage/contracts cannot still mutate truth after cutover and rollback is source/deployment rollback, not hidden compatibility state.",
    ),
)


def _normalized_terms(value: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9]+", " ", value.casefold()).split())


def infer_invariants(text: str, *, limit: int = 6) -> tuple[InvariantRule, ...]:
    """Return the root rule plus the highest-signal triggered rules."""

    normalized = _normalized_terms(text)
    haystack = f" {normalized} "
    scored: list[tuple[int, int, InvariantRule]] = []
    for index, rule in enumerate(RULES):
        hits = sum(1 for trigger in rule.triggers if f" {_normalized_terms(trigger)} " in haystack)
        if hits:
            score = RULE_PRIORITY.get(rule.id, 0) + hits * 10
            scored.append((score, -index, rule))
    scored.sort(reverse=True)
    return (ROOT_RULE, *(rule for _, _, rule in scored[: max(0, limit - 1)]))


def render_preflight(text: str, *, limit: int = 6) -> tuple[str, ...]:
    rules = infer_invariants(text, limit=limit)
    lines = [
        "ForgeFlow invariant preflight (complete before editing):",
        "- Read the existing owner/domain/contracts and relevant characterization tests before choosing a write path.",
    ]
    for rule in rules:
        lines.append(f"- [{rule.id}] {rule.title}: {rule.check} Adversarial: {rule.adversarial}")
    lines.extend(
        [
            "- Convert every applicable invariant into a failing/characterization test before or with the production change; if a rule is not executable, state why in the implementation summary.",
            "- Validation ladder: focused regression first, then affected package/type/build checks; reserve broad integration/E2E for the candidate exact head instead of every edit.",
        ]
    )
    return tuple(lines)


def render_finding_reinforcement(
    finding_texts: Iterable[str], *, limit: int = 4
) -> tuple[str, ...]:
    combined = " ".join(finding_texts)
    rules = infer_invariants(combined, limit=limit)
    return (
        "Finding-derived invariant reinforcement:",
        *(f"- [{rule.id}] {rule.title}: {rule.check}" for rule in rules),
        "- Add a regression test that reproduces each finding and inspect at least one adjacent path sharing the same invariant before declaring the root cause fixed.",
    )
