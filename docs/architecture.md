# ForgeFlow architecture

ForgeFlow is a thin governance package for Pi Agent.

## Ownership

### Pi / pi-subagents own

- physical model and provider execution;
- virtual-model dispatch mechanics and subagent model resolution;
- parent and child sessions;
- subagent dispatch and lifecycle;
- worktree isolation;
- missions, schedules, background work, resume, and retained children;
- external CLI/job agent runners;
- workflow receipts and runtime artifacts.

### ForgeFlow owns

- stable engineering model roles (`forgeflow/planner`, `worker`, `reviewer`, `scout`, `oracle`) and their thin operator-controlled role policy;
- a deterministic engineering-invariant preflight;
- the one-writer-per-worktree governance rule;
- the trusted `forgeflow.review` resource;
- the trusted `forgeflow.accept` exact-head acceptance resource;
- deterministic parsing of reviewer verdicts and GitHub check evidence.

If a new feature needs generic execution, scheduling, workflow state, provider/channel routing, worktrees,
or resume, it belongs in Pi/pi-subagents or the provider layer rather than ForgeFlow. ForgeFlow may select a physical model for an engineering role through Pi's native virtual-model primitive, but it must not own API transport, credentials, channel weights, quota routing, or a second model runtime.

## Model policy boundary

ForgeFlow registers stable logical roles as Pi virtual models. Their physical model mapping is read from operator policy rather than hard-coded into workflows or subagent definitions. For native pi-subagents children, ForgeFlow registers its own extension as a required child extension so those virtual roles are present even though local foreground children intentionally skip parent ambient-extension discovery. New user/direct requests resolve the current mapping, while continuation/retry requests stay on the physical model already handling the turn to preserve prompt-cache and reasoning-signature continuity.

Project-local `.pi/forgeflow-models.json` is considered only when Pi reports the project trusted. User-level policy under `~/.pi/forgeflow-models.json` remains available for untrusted projects. `FORGEFLOW_MODEL_POLICY` is an explicit operator override.

Provider gateways such as LiteLLM/New API/Bifrost sit below this boundary: ForgeFlow chooses the physical model; the provider plane chooses endpoint/channel/key for that already-selected model. This avoids double semantic routing.

See `docs/model-policy.md` for the v1 schema and role mapping.

## Invariant preflight

`extension/invariants.js` is the retained learning layer. It contains a small
stable catalog covering owner validation, product time, identity ownership,
lifecycle/tombstones, retry/idempotency, path parity, preflight-before-mutation,
stable ordering, host-owned facts, and single-truth cutovers.

The preflight is deterministic and adds no model call or durable workflow state.

## Independent review

`forgeflow.review` launches the builtin Pi reviewer agent with fresh context and
explicitly selects the stable `forgeflow/reviewer` virtual model. The reviewer is
read-only. Its full report is persisted to an absolute path under `.pi/subagents/`.

A Pi typed gate executes `scripts/review-verdict.mjs` against that same report.
Only Pi's canonical merge-verdict forms are accepted:

- `Merge verdict: BLOCK|OK|OK with notes`
- the builtin reviewer's Markdown-list form of the same line.

Anything else fails closed.

## Exact-head acceptance

`forgeflow.accept` performs four independent gates in order:

1. **HEAD before review** — the worktree is clean and equals `expectedHead`.
2. **Fresh review** — the Pi reviewer running as `forgeflow/reviewer` must return a clean typed verdict.
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
