# Pi-native ForgeFlow cutover

## Decision

ForgeFlow will stop being an independent Python/LangGraph/Open SWE control plane.
The target product is a Pi package composed of a small extension, policy assets,
and optional project conventions on top of `pi-subagents`.

Pi owns execution. ForgeFlow owns only engineering policy that is not already a
Pi primitive.

## Keep as policy assets

- deterministic engineering invariants and preflight;
- one-writer-per-worktree policy;
- independent review as evidence rather than self-approval;
- exact-revision delivery semantics: PR head, CI head, and reviewed head must not
  be silently mixed;
- stale evidence invalidation after a new push;
- same-candidate repair rather than hidden parallel truth.

## Retire instead of porting

- Open SWE implementation and reviewer runtimes;
- LangGraph objective/reconcile graphs and cron ownership;
- ForgeFlow attempt ledger where Pi mission/run receipts already own lifecycle;
- custom provider/runtime routing duplicated by Pi agents and model settings;
- implementation continuation duplicated by Pi retained children and resume;
- external-agent wrappers that can be represented as pi-subagents external
  CLI/job agents;
- duplicate worktree/sandbox orchestration where Pi already owns isolation.

## Migration phases

1. Establish an installable Pi package with policy injection and a trusted
   independent-review resource.
2. Add the remaining unique delivery gate: authoritative PR/current-head/CI
   verification and exact-head merge semantics.
3. Prove one real implementation -> review -> repair -> exact-head acceptance
   canary without importing the old ForgeFlow runtime.
4. Remove Open SWE/LangGraph/Python runtime code and deployment units.
5. Re-evaluate optional learning/invariant proposal features separately; do not
   port them unless they still earn their complexity.

## Architectural guardrail

If a proposed ForgeFlow feature implements sessions, scheduling, missions,
subagent lifecycle, model/provider routing, worktree allocation, generic agent
execution, or resume, stop and use the Pi/pi-subagents owner instead.
