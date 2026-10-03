# ForgeFlow architecture

ForgeFlow is a thin policy package for Pi Agent.

## Ownership

### Pi and installed plugins own

- physical model/provider execution and virtual-model dispatch mechanics;
- parent/child sessions and subagent lifecycle;
- worktree isolation, missions, schedules, background work, resume, and retained children;
- external CLI/job runners;
- reviewer execution, review loops, and runtime acceptance evidence;
- pull-request verification, CI evidence collection, freshness checks, and merge operations.

`pi-subagents` is the primary child/runtime primitive. When installed,
`pi-gauntlet` provides higher-level engineering workflows such as `gatekeep-pr`.
ForgeFlow does not wrap those capabilities in a second workflow layer.

### ForgeFlow owns

- stable engineering model roles (`forgeflow/planner`, `worker`, `reviewer`, `scout`, `oracle`);
- a deterministic engineering-invariant preflight;
- the one-writer-per-worktree governance rule;
- policy text requiring evidence to remain bound to the current candidate.

If a feature needs generic execution, review orchestration, PR acceptance,
scheduling, durable workflow state, provider/channel routing, worktrees, or resume,
it belongs in Pi, an existing plugin, or the provider layer rather than ForgeFlow.

## Model policy boundary

ForgeFlow registers stable logical roles as Pi virtual models. Their physical model
mapping is read from operator policy rather than hard-coded into workflows or agent
definitions.

For native pi-subagents children, ForgeFlow registers its own extension as a
required child extension. Local foreground children intentionally skip parent
ambient-extension discovery, so this keeps the `forgeflow/*` roles available in
foreground, detached, nested, and recovery child sessions without hard-coding an
installation path in operator profile settings.

New user/direct requests resolve the current role mapping. Continuation/retry
requests stay on the physical model already handling the turn to preserve cache and
reasoning-signature continuity.

Project-local `.pi/forgeflow-models.json` is considered only when Pi reports the
project trusted. User-level policy under `~/.pi/forgeflow-models.json` remains
available for untrusted projects. `FORGEFLOW_MODEL_POLICY` is an explicit operator
override.

Provider gateways such as LiteLLM sit below this boundary: ForgeFlow chooses a
logical role and Pi resolves its physical model; the provider plane chooses the
endpoint/channel/key for that already-selected physical model.

See `docs/model-policy.md` for the v1 schema and role mapping.

## Invariant preflight

`extension/invariants.js` is the retained engineering-policy layer. It contains a
small stable catalog covering owner validation, product time, identity ownership,
lifecycle/tombstones, retry/idempotency, path parity, preflight-before-mutation,
stable ordering, host-owned facts, and single-truth cutovers.

The preflight is deterministic and adds no model call or durable workflow state.

## Review and delivery

ForgeFlow does not implement a reviewer runtime or PR acceptance workflow.

Use the reviewer and acceptance primitives already supplied by `pi-subagents`.
For GitHub PR delivery, `pi-gauntlet`'s `gatekeep-pr` skill (when installed)
already handles exact-head CI evidence, head freshness, review, compare-and-swap,
and head-matched merge execution. Adding a second ForgeFlow implementation would
create two sources of truth for the same gate.

## Retired architecture

The former Python/LangGraph/Open SWE control plane, provider routing, attempt ledger,
custom agent wrappers, Docker sandbox deployment, supervisors, and GCP systemd units
were removed during the Pi-native cutover. Git history is the audit record for that
retired implementation.
