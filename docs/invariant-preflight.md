# Invariant preflight

ForgeFlow implementation prompts perform a deterministic risk preflight before code edits. The goal is to move recurring review findings into the implementation plan without adding another model call or durable workflow stage.

The catalog lives in `forgeflow/invariants.py`. Each rule has a stable ID, objective/finding triggers, an invariant check, and an adversarial case. The implementation prompt requires the agent to inspect the owner/domain/contracts first, translate applicable rules into characterization or failing tests, and use a validation ladder from focused tests to exact-head broad gates.

Current rule families cover owner-validation parity, product time, identity ownership, lifecycle/tombstones, retry/idempotency, dry-run/adapter parity, preflight-before-mutation, stable ordering, host-owned facts, and destructive cutover single-truth semantics.

Review repair prompts map finding text back to the same catalog. A repair must add a reproducing regression test where behavioral, scan an adjacent path that shares the invariant, and fix the root cause rather than only the reported line.

This is intentionally the first learning layer. The static catalog makes repeated errors expensive only once while keeping ForgeFlow deterministic. A later durable finding ledger can persist project-specific rules after the catalog proves stable.
