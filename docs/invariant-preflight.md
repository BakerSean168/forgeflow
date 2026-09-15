# Invariant preflight

ForgeFlow implementation prompts perform a deterministic risk preflight before code edits. The goal is to move recurring review findings into the implementation plan without adding another model call or durable workflow stage.

The catalog lives in `forgeflow/invariants.py`. Each rule has a stable ID, objective/finding triggers, an invariant check, and an adversarial case. The implementation prompt requires the agent to inspect the owner/domain/contracts first, translate applicable rules into characterization or failing tests, and use a validation ladder from focused tests to exact-head broad gates.

Current rule families cover owner-validation parity, product time, identity ownership, lifecycle/tombstones, retry/idempotency, dry-run/adapter parity, preflight-before-mutation, stable ordering, host-owned facts, and destructive cutover single-truth semantics.

Review repair prompts map finding text back to the same catalog. A repair must add a reproducing regression test where behavioral, scan an adjacent path that shares the invariant, and fix the root cause rather than only the reported line.

This is intentionally the first learning layer. The static catalog makes repeated errors expensive only once while keeping ForgeFlow deterministic. A later durable finding ledger can persist project-specific rules after the catalog proves stable.

## Evidence-backed project learning

Successful exact-head official review snapshots are recorded in the local append-only
`invariant-learning.jsonl` ledger. Raw finding text is retained only as bounded local
audit evidence; it is never injected back into model prompts.

Learning is conservative:

- `open` findings are candidates only;
- an explicit later `resolved` status validates the mapped invariant class;
- the same invariant validated across at least two PRs is promoted;
- `dismissed` findings are counter-evidence and never become prompt lessons;
- findings that do not map to a known invariant remain auditable candidates rather
  than automatically creating a new rule.

Future implementation prompts receive only stable invariant IDs and aggregate counts
for validated/promoted classes relevant to the new objective. The learning ledger is
advisory: corruption or write failure must never block CI/review/delivery acceptance.

## Unknown-finding proposal supervisor

Findings that resolve without matching a static invariant remain unknown evidence. ForgeFlow
clusters only resolved unknown findings from distinct PRs using bounded normalized evidence terms.
A cluster needs at least two independent PRs before it can become a proposal.

Proposal review is a separate failure domain:

1. `forgeflow-invariant-supervisor.timer` runs at most hourly and processes at most one mature
   proposal per invocation, so normal implementation/review latency does not depend on learning.
2. The dedicated `invariant_reviewer` LangGraph graph has no tools, shell, GitHub write access, or
   sandbox. It uses the REASONING model policy and returns only structured
   `accept | reject | needs_more_evidence` output.
3. An accepted rule must pass deterministic validation: 2-6 triggers drawn only from cluster
   evidence terms, bounded declarative check/adversarial text, and prompt-injection/control-text
   rejection.
4. Accepted rules are repository-scoped. They are read from the append-only proposal ledger and
   injected only when a later objective matches their accepted triggers. They never mutate the
   static Python catalog automatically and never become cross-project/global rules automatically.
5. Stable proposal threads/revisions make the supervisor replay-safe: a process crash after model
   completion reuses the durable graph state rather than spending another review call.

This produces a three-tier learning model: static global invariants, resolved known project
regression evidence, and independently-reviewed dynamic project invariants learned from repeated
previously-unknown findings.

Operator visibility remains explicit and read-only:

- `deploy/gcp-dev/show-invariant-learning.py OWNER/REPO` shows known static-invariant evidence.
- `deploy/gcp-dev/show-invariant-proposals.py OWNER/REPO` shows discovered/pending unknown clusters
  and accepted repository-scoped dynamic rules.
