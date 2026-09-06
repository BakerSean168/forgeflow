# ForgeFlow Architecture

## Purpose

ForgeFlow owns an engineering objective from durable planning to verified delivery. It separates deterministic control from model-driven reasoning so that intelligence can change *what should happen next* without gaining authority to violate repository, provenance, review, or deployment rules.

## Control layers

### Domain and persistence

The durable model records Plans, graph versions, WorkItems, Executions, Reviews, resource selections, worktrees, delivery state, Supervisor state, and immutable events. Terminal state is monotonic and writes use idempotency/CAS where duplicate execution would be unsafe.

### Deterministic kernel

Kernel operations are the only state-changing authority exposed to the Supervisor. Typed actions include creating/continuing/retrying executions, requesting reviews, creating repairs, replanning the remainder, creating bounded child plans, parking external gates, and escalation.

### Orchestration runtime

The runtime advances dependency-ready work through implementation, review, repair, integration, and delivery. It treats each of those as a distinct state rather than collapsing them into “done”.

### Workspace isolation

ForgeFlow supports isolated execution workspaces and shared-common-dir literal Git worktrees. The controller owns workspace topology and provenance; a model receives only the workspace and Git capabilities required for its phase. Independent review is detached at the exact candidate revision and cannot become an implementation writer.

### Resource selector

Execution resources combine model family, agent backend, transport, resource tier, ordering, health, runtime admission, and durable selection evidence. Selection is deterministic within policy and the chosen resource is immutable for an Execution.

### AI Supervisor

The Supervisor consumes a bounded projection of durable state and returns exactly one typed decision. It can diagnose unusual failures or alter the remaining plan, but it cannot execute arbitrary shell commands, mutate the database, fabricate evidence, approve its own implementation, or bypass safety gates.

Supervisor reasoning is itself governed by the Resource Selector. There is no production static model alias or alternate Supervisor endpoint: each decision selects a `REASONING` resource through the `SUPERVISE` phase, records sanitized selection provenance, and uses a bounded failover budget. Readiness is path-specific: implementation/review candidates retain ACP runtime admission, while Supervisor decisions use direct Chat/Responses protocol readiness plus live resource feedback because they do not execute through ACP. Provider/network/quota failures feed the normal resource-health policy before trying the next eligible reasoning resource. A malformed decision is rejected without globally poisoning an otherwise healthy provider. Its sanitized failure stage/code is recorded against a semantic decision-context digest that excludes Supervisor housekeeping, and that resource is durably excluded while the actionable context remains unchanged. If all eligible reasoning candidates are exhausted, the Supervisor parks in `WAITING_FOR_RESOURCE` instead of repeatedly spending requests; new durable evidence, resource recovery, or a later wake can reopen selection. Both Chat Completions and Responses protocol bindings are honored according to the selected resource contract.

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
