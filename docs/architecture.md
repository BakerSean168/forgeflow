# ForgeFlow architecture

ForgeFlow is a thin governance package for Pi Agent.

## Ownership

### Pi / pi-subagents own

- model and provider execution;
- parent and child sessions;
- subagent dispatch and lifecycle;
- worktree isolation;
- missions, schedules, background work, resume, and retained children;
- external CLI/job agent runners;
- workflow receipts and runtime artifacts.

### ForgeFlow owns

- a deterministic engineering-invariant preflight;
- the one-writer-per-worktree governance rule;
- the trusted `forgeflow.review` resource;
- the trusted `forgeflow.accept` exact-head acceptance resource;
- deterministic parsing of reviewer verdicts and GitHub check evidence.

If a new feature needs generic execution, scheduling, state, routing, worktrees,
or resume, it belongs in Pi/pi-subagents rather than ForgeFlow.

## Invariant preflight

`extension/invariants.js` is the retained learning layer. It contains a small
stable catalog covering owner validation, product time, identity ownership,
lifecycle/tombstones, retry/idempotency, path parity, preflight-before-mutation,
stable ordering, host-owned facts, and single-truth cutovers.

The preflight is deterministic and adds no model call or durable workflow state.

## Independent review

`forgeflow.review` launches the builtin Pi reviewer with fresh context. The
reviewer is read-only. Its full report is persisted to an absolute path under
`.pi/subagents/`.

A Pi typed gate executes `scripts/review-verdict.mjs` against that same report.
Only Pi's canonical merge-verdict forms are accepted:

- `Merge verdict: BLOCK|OK|OK with notes`
- the builtin reviewer's Markdown-list form of the same line.

Anything else fails closed.

## Exact-head acceptance

`forgeflow.accept` performs four independent gates in order:

1. **HEAD before review** — the worktree is clean and equals `expectedHead`.
2. **Fresh review** — the Pi reviewer must return a clean typed verdict.
3. **HEAD after review** — review must not have changed the candidate.
4. **GitHub exact-head** — the PR is open, targets the expected base, still
   points at `expectedHead`, and every configured required check resolves to
   the newest unambiguous terminal `success`.

The reviewer evaluates code/contracts/repository-local evidence. Live GitHub CI
state is deliberately owned by the final host gate, avoiding a circular
requirement for a read-only reviewer to prove external check-run state.

## Retired architecture

The former Python/LangGraph/Open SWE control plane, its provider routing,
attempt ledger, custom agent wrappers, Docker sandbox deployment, supervisors,
and GCP systemd units were removed during the Pi-native cutover. Git history is
the audit record for that retired implementation.
