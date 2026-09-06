# ForgeFlow Architecture

## Purpose

ForgeFlow owns an engineering objective from durable planning to verified delivery. It separates deterministic control from model-driven reasoning so that intelligence can change *what should happen next* without gaining authority to violate repository, provenance, review, or deployment rules.

## Control layers

### Domain and persistence

The durable model records Plans, graph versions, WorkItems, Executions, Reviews, resource selections, ACP runtime-admission cache state, Supervisor direct-admission cache state, worktrees, delivery state, Supervisor state, and immutable events. Terminal state is monotonic and writes use idempotency/CAS where duplicate execution would be unsafe.

### Deterministic kernel

Kernel operations are the only state-changing authority exposed to the Supervisor. Typed actions include creating/continuing/retrying executions, requesting reviews, creating repairs, replanning the remainder, creating bounded child plans, parking external gates, and escalation.

### Orchestration runtime

The runtime advances dependency-ready work through implementation, review, repair, integration, and delivery. It treats each of those as a distinct state rather than collapsing them into “done”. Active-root operator cancellation is also deterministic and fail-closed: the Plan first enters `SAFETY_HOLD`, its Supervisor is retired, every unfinished Execution must become `CANCELLED` (with any live provider session demonstrably quiesced first), unfinished WorkItems are cancelled, and the Plan becomes terminal. A cancelled literal-worktree execution is not considered fully quiesced until its unaccepted repository changes are reset to the execution source revision and its durable writer ownership is released; cleanup failure is retryable without re-cancelling the already-quiesced provider. Worktree retirement must then succeed before the project lease can be released or handed off. A provider that remains live, a held/dirty worktree, descendant Plan, or stale lease therefore blocks handoff instead of being hidden by a `CANCELLED` label. Descendant Plans are cancelled deepest-first through the same operator API: a child enters `SAFETY_HOLD`, retires its own Supervisor, quiesces/cancels its own Executions, cancels non-passed Reviews and unfinished WorkItems, and becomes `CANCELLED`, but it never retires the shared root worktree family or releases the root project lease. Repeating a completed cancellation is idempotent, while repeating one that stopped at execution/workspace cleanup resumes that cleanup before root retirement or lease release.

### Workspace isolation

ForgeFlow supports isolated execution workspaces and shared-common-dir literal Git worktrees. The controller owns workspace topology and provenance; a model receives only the workspace and Git capabilities required for its phase. Independent review is detached at the exact candidate revision and cannot become an implementation writer.

### Resource selector

Execution resources combine model family, agent backend, transport, resource tier, ordering, health, runtime admission, and durable selection evidence. Selection is deterministic within policy and the chosen resource is immutable for an Execution. ACP runtime admission is demand-driven: an idle control plane does not periodically launch probe conversations, while READY/RUNNING/WAITING_FOR_RESOURCE Plans or active Executions trigger admission before automation or an explicit run/reconcile action proceeds. Admission outcomes are durably cached with bounded success/failure TTLs, so a control-plane restart can reuse a still-fresh sanitized readiness result instead of immediately launching another ACP probe. The cache stores only route identity, readiness, sanitized error code, and check time; readiness/error transitions are audited, while TTL refreshes do not generate event spam. A disabled runtime exposes the durable cache read-only but does not hydrate those rows as active readiness. Operator resource or binding state changes invalidate the matching durable and in-memory ACP admission entries before any subsequent selection, and directory reconciliation drops admission rows for routes that no longer exist; reactivation therefore cannot reuse a pre-change `ready=true` result merely because its TTL has not expired. Transient resource suspension is recovery-gated rather than timer-only: community/free resources probe after their longer suspension and disable on a failed recovery probe, while metered/subscription resources probe after each bounded cooldown and remain suspended for another cooldown when the probe still fails. LiteLLM probes honor each binding's declared wire protocol (`/chat/completions` or `/responses`) and never persist provider response bodies. Resource-level recovery requires every remaining enabled/ready managed binding to pass; a separately disabled binding is excluded from that recovery quorum. Automatic `SUSPENDED -> ACTIVE` recovery only clears ForgeFlow's resource-level routing fence; it never removes an independently managed binding-level block. Only an explicit operator resource activation carries the broader remote-unblock semantics.

### AI Supervisor

The Supervisor consumes a bounded projection of durable state and returns exactly one typed decision. It can diagnose unusual failures or alter the remaining plan, but it cannot execute arbitrary shell commands, mutate the database, fabricate evidence, approve its own implementation, or bypass safety gates.

Supervisor reasoning is itself governed by the Resource Selector. There is no production static model alias or alternate Supervisor endpoint: each decision selects a `REASONING` resource through the `SUPERVISE` phase, records sanitized selection provenance, and uses a bounded failover budget. Readiness is path-specific: implementation/review candidates retain ACP runtime admission, while Supervisor candidates pass an independent direct-protocol admission that exercises the same Chat/Responses endpoint, system prompt, JSON-output contract, and typed-decision parser used by the real Supervisor. A generic provider health probe is therefore insufficient to admit reasoning traffic. Direct-admission results are durably cached with bounded success/failure TTLs, so a control-plane restart does not immediately repeat a paid probe. Admission probing is demand-driven: when no non-terminal Supervisor exists, ForgeFlow preserves the cache but does not spend periodic provider requests merely to keep it warm. The cache stores only route identity, readiness, sanitized error code, and checked time; readiness/error transitions also leave immutable audit events. The control-plane exposes this durable cache read-only even while the Supervisor runtime is disabled, but cached rows are never counted as active readiness unless the runtime hydrates them under the normal admission policy. Reading the cache never triggers a provider probe. It never stores provider response bodies or credentials, and it does not poison a resource that may remain healthy for implementation. Provider/network/quota failures from a real Supervisor turn still feed the normal resource-health policy before trying the next eligible reasoning resource. A malformed decision is rejected without globally poisoning an otherwise healthy provider. Its sanitized failure stage/code is recorded against a semantic decision-context digest that excludes Supervisor housekeeping, and that resource is durably excluded while the actionable context remains unchanged.

If all eligible reasoning candidates are exhausted, the Supervisor parks in `WAITING_FOR_RESOURCE` instead of repeatedly spending requests. Recovery is event-driven: when a resource becomes eligible for the same `SUPERVISE` selector policy, ForgeFlow appends a sanitized resource-availability event and schedules a durable `RESOURCE_TRANSITION` wake for waiting Supervisors. Startup reconciles the same condition so provider recovery during downtime is not lost. A 15-minute `RESOURCE_WATCHDOG` remains as a fail-safe recheck and is explicitly allowed to re-evaluate an unchanged observation cursor; normal stale wakes remain rejected. Implementation-only resource recovery does not wake a reasoning Supervisor. Both Chat Completions and Responses protocol bindings are honored according to the selected resource contract.

## Delivery invariant

An implementation commit is not equivalent to accepted work. The normal acceptance chain is:

```text
implementation commit
  -> independent exact-SHA review
  -> accepted/integrated Plan revision
  -> required CI
  -> exact-head PR/merge verification
  -> delivery complete
```

A failure at a later stage preserves the earlier evidence and produces a repair/recovery path rather than rewriting history.

## Improvement loop and self-change boundary

ForgeFlow can deterministically aggregate repeated bounded execution failures into durable Improvement Candidates. Discovery is read-only with respect to project repositories: it groups allowlisted local engineering failure codes, deduplicates them by project/phase/failure identity, and records stable evidence without asking a model to invent a diagnosis. Candidate discovery and Plan adoption are separate gates. `CONSERVATIVE` programs only discover Candidates and require explicit adoption. A `STANDARD` program may auto-adopt only `LOW` risk Candidates when both adoption and the separate global low-risk auto-adopt switch are enabled. Medium/high risk work is never auto-adopted by this loop; high risk explicit adoption requires an acknowledgement. Programs are durably ACTIVE/DISABLED and can be stopped without deleting audit history.

Adopting a Candidate does not grant Maintenance a writer. It creates an ordinary root Plan with a normal WorkItem, project scheduling lease, Supervisor, Resource Selector policy, implementation execution, independent exact-revision review, integration, and delivery requirements. Candidate completion is derived from that linked Plan: `SUCCEEDED` closes the Candidate, while cancellation makes it stale. No Candidate can mark itself complete or fabricate review/delivery evidence. A bounded periodic cycle may discover, safely auto-adopt eligible low-risk work, and reconcile linked terminal Plans, but it never executes repository mutations itself.

Self-change has an additional hard gate. Even if the `forgeflow` project is accidentally included in the Improvement project allowlist, a Plan targeting ForgeFlow's own repository is rejected unless `FORGEFLOW_IMPROVEMENT_SELF_CHANGE_ENABLED=true`. The checked-in deployment defaults discovery, adoption, low-risk auto-adoption, project allowlists, and self-change to disabled. This preserves the current operating mode in which ForgeFlow may observe or represent improvement work, but cannot silently rewrite its live code, prompts, policy, or release state.
