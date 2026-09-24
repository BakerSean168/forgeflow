# ForgeFlow operations and active-work lifecycle

This runbook defines how to determine whether ForgeFlow work is actually active, how to inspect
deployed runtime health, and when repository worktrees or plans may be closed. It does not grant
ForgeFlow ownership of Git worktree cleanup or plan archival.

## Evidence planes

Do not infer active engineering work from one filesystem signal. ForgeFlow deliberately separates four
sources of evidence:

| Plane | Source of truth | What it proves |
| --- | --- | --- |
| Planning | repository active plan and TaskGraph | intended scope, dependencies, protected contracts, and acceptance criteria |
| Execution | ForgeFlow/LangGraph objective threads and child runs | current implementation, verification, review, repair, wait, or escalation state |
| Delivery | GitHub PR, exact-head CI, and independent review | whether a revision has durable delivery evidence and is accepted |
| Filesystem | Git worktrees and local branches | isolated checkout state only |

**Worktree count is not active-task count.** A worktree may remain after its PR has merged, after a
task was superseded, or after an interrupted maintenance session. Conversely, an active objective may
reuse an existing workspace and therefore create no new visible worktree.

## Determining active work

Treat an implementation as active only when execution evidence supports it. Check, in order:

1. The repository contains the relevant active plan or TaskGraph and the task is not already accepted
   on the configured base branch.
2. A ForgeFlow/LangGraph thread for the same project and task identity is in an active state such as
   `NEW`, `IMPLEMENTING`, `VERIFYING`, `WAITING_FOR_CI`, `REVIEWING`, `REPAIRING`, or
   `WAITING_FOR_RESOURCE`; or an explicitly owned implementation process is still using the workspace.
3. Delivery evidence is still open or incomplete: for example, the PR is open, exact-head CI has not
   passed, review is incomplete, or the accepted head has not reached the configured base branch.

A clean historical worktree with no active thread or process and merged, closed, or superseded
delivery evidence is maintenance residue, not active implementation.

## Safe worktree closure

Before removing any worktree, require all of the following evidence:

1. `git status --porcelain` is empty. Never discard a dirty worktree as cleanup.
2. No live process has its current working directory inside the worktree and no known implementation
   runtime owns that workspace.
3. No active ForgeFlow/LangGraph objective is bound to the workspace, task id, or current TaskGraph
   semantic fingerprint.
4. The corresponding delivery is merged, closed, or explicitly superseded by newer accepted work.
5. Any branch-only commit that still matters is reachable from a retained branch or remote reference.

Only after those checks may an operator run `git worktree remove <path>`. Delete the local branch only
when it is merged or deliberately classified as superseded. Remote branch cleanup is a separate
operator decision.

## Plan and TaskGraph closure

An active plan remains planning truth until its acceptance evidence is complete. For a TaskGraph,
completion means every task has accepted exact-head evidence on the configured base branch and there
are no active or blocked objectives requiring repair.

After completion:

1. verify there are no active ForgeFlow objectives or unresolved delivery PRs for the plan;
2. run the plan's focused checks plus repository-wide required checks;
3. mark the plan completed and move the plan and TaskGraph from `docs/plan/active/` to
   `docs/plan/archive/`;
4. update repository-relative context references when the archive move changes their paths.

Removing or archiving the configured active plan is the deterministic stop signal used by the
continuous project supervisor. ForgeFlow does not silently rewrite or archive repository planning
truth.

## Self-supervision is explicit

The presence of an active plan or TaskGraph does **not** authorize ForgeFlow to modify its own
repository.

Unattended execution additionally requires project configuration with
`continuous_supervisor.enabled: true` and an active `forgeflow-project-supervisor.timer`. Enabling
self-supervision is an explicit operator/execution-mode decision. A planning-only change must not
silently alter either activation condition.

For TaskGraph-backed unattended work, new configurations should also bind authorization to the
reviewed graph identity and revision:

```json
"activation": {
  "task_graph_id": "example-vnext",
  "task_graph_revision": 1
}
```

A present binding is fail-closed: changing the configured TaskGraph id or revision requires an
operator to update the binding before dispatch can continue. Existing TaskGraph projects without the
field are migration-compatible and appear as `LEGACY_UNBOUND` in the operator summary. The binding
itself does not start the supervisor or mutate the TaskGraph.

## Runtime-unit health

Use the read-only deployment health check:

```bash
python3 deploy/gcp-dev/check-runtime-units.py
```

It inspects these required systemd user units:

- `open-swe-codex-broker.service`
- `forgeflow-policy.service`
- `forgeflow-openswe-sandbox-gc.timer`
- `forgeflow-invariant-supervisor.timer`
- `forgeflow-project-supervisor.timer`

The command returns zero only when every required unit is loaded and active. It reports lifecycle
state but never starts, restarts, stops, enables, or disables a unit. `deploy/gcp-dev/install.sh`
runs the same checker as a postcondition after it explicitly enables the required timers.

An `enabled` but `inactive` timer is therefore visible as deployment/runtime drift instead of being
mistaken for a healthy supervisor.

## Operator summary projection

`GET /forgeflow/api/v1/summary` projects the planning/execution boundary without becoming another
state owner. Each project reports whether continuous supervision is configured/enabled, active plan
paths, TaskGraph id/revision, activation state, and bounded progress counts for active, READY,
blocked, completed-on-base, and pending tasks.

The summary uses existing LangGraph thread metadata plus local Git ancestry only. It does not run
`git fetch`, merge branches, start timers, create objectives, or rewrite repository plans. A
TaskGraph reaches projected `COMPLETE` only when every current fingerprinted task has exact-head
READY evidence and its accepted head is already on the locally known configured base.

### Durable activity vs effective execution liveness

`activeObjectiveCount` remains the durable LangGraph lifecycle count for backward compatibility. An
objective can therefore remain durably `IMPLEMENTING` or `VERIFYING` after its repository plan has
been archived. The summary separately reports `actionableActiveObjectiveCount` and
`staleActiveObjectiveCount` so operational activity is not inferred from stale lifecycle state.

A currently active objective is projected as `STALE_PLAN_INACTIVE` only when it was created by the
`project-supervisor` and that project's configured planning input is now inactive. Manual/Hermes
objectives are not made stale solely because continuous planning is inactive. This is a read-only
classification: ForgeFlow does not cancel or rewrite the durable thread automatically.
