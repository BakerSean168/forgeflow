# ForgeFlow architecture

ForgeFlow is a thin policy package for Pi Agent.

## Ownership

### Pi and installed plugins own

- physical model/provider execution and virtual-model dispatch mechanics;
- parent/child sessions and subagent lifecycle;
- worktree isolation, missions, schedules, background work, resume, and retained children;
- external CLI/job runners;
- reviewer execution, review loops, and runtime acceptance evidence.

`pi-subagents` is the sole child/runtime orchestration primitive. Reusable engineering
methods such as TDD, SDD, PR gating, and post-merge delivery verification belong in
host Skills. Deterministic CI, VCS, and deployment systems remain the authority for
facts such as exact head, test status, artifact identity, and rollout state.
ForgeFlow does not wrap those capabilities in a second workflow layer.

### ForgeFlow owns

- stable engineering model roles (`forgeflow/planner`, `worker`, `reviewer`, `scout`, `oracle`);
- a deterministic engineering-invariant preflight;
- the one-writer-per-worktree governance rule;
- policy text requiring evidence to remain bound to the current candidate.

If a feature needs generic execution, review orchestration, scheduling, durable
workflow state, provider/channel routing, worktrees, or resume, it belongs in Pi or
an existing plugin. If it is an engineering method or delivery procedure, it belongs
in a Skill. Provider/channel routing remains in the provider layer.

### External coding agents

ForgeFlow may register a thin transport adapter when an installed coding agent cannot
consume the `pi-subagents` stdin contract directly. The Antigravity integration is
one example: `pi-subagents` remains the orchestration owner, while a small bridge
converts the assembled stdin prompt into one `agy --print=<prompt>` argument.

The bridge owns no sessions, retries, workflow state, model routing, credentials, or
quota. `agy` remains the authority for Antigravity authentication, model entitlement,
and subscription usage. Two runtime agents are exposed when the `pi-subagents`
registration owner is present: `antigravity`/`agy` for plan-mode analysis and
`antigravity-writer`/`agy-writer` for explicit workspace mutation. Generic external
CLI runners are local-only under the current `pi-subagents` contract.

## Model policy boundary

ForgeFlow registers stable logical roles as Pi virtual models. Their physical model
mapping is read from operator policy rather than hard-coded into workflows or agent
definitions.

For native pi-subagents children, ForgeFlow registers its own extension as a
required child extension. Local foreground children intentionally skip parent
ambient-extension discovery, so this keeps the `forgeflow/*` roles available in
foreground, detached, nested, and recovery child sessions without hard-coding an
installation path in operator profile settings.

New user/direct requests resolve the current role mapping. Policy v3 separates model
capability from supply: a role chooses a logical model/effort, then an ordered supply
group chooses the physical Pi model that pays for it. The current GPT-6.1 Sol supply
order is Business Team (`openai-codex`) before the commercial relay (`litellm`).
LiteLLM then chooses only among channels for the already-selected commercial physical
model.

Continuations remain sticky. Retries remain sticky unless the failed response is
classified as a narrow supply failure (quota/rate/capacity/upstream/transport/auth/model
availability); only then may v3 move to the next source in the same supply group. Context,
request, policy, and tool/schema failures do not consume the next paid source.

The router records its decision in Pi's native virtual-model state. ForgeFlow additionally
maintains a credential-free local usage JSONL projection for subscription/native-provider
traffic, while LiteLLM SpendLogs remain authoritative for commercial relay/channel spend.
Explicit task classes use `[[forgeflow:task=<class>]]`; ForgeFlow deliberately does not add
a hidden LLM classifier or per-turn semantic router.

Project-local `.pi/forgeflow-models.json` is considered only when Pi reports the
project trusted. User-level policy under `~/.pi/forgeflow-models.json` remains
available for untrusted projects. `FORGEFLOW_MODEL_POLICY` is an explicit operator
override.

Provider gateways such as LiteLLM sit below this boundary: ForgeFlow chooses a
logical role and Pi resolves its physical model; the provider plane chooses the
endpoint/channel/key for that already-selected physical model.

See `docs/model-policy.md` for policy schemas, supply priority, failure classification, and usage projection.

## Invariant preflight

`extension/invariants.js` is the retained engineering-policy layer. It contains a
small stable catalog covering owner validation, product time, identity ownership,
lifecycle/tombstones, retry/idempotency, path parity, preflight-before-mutation,
stable ordering, host-owned facts, and single-truth cutovers.

The preflight is deterministic and adds no model call or durable workflow state.

## Review and delivery

ForgeFlow does not implement a reviewer runtime, TDD/SDD state machine, PR gate, or
delivery workflow.

Use the reviewer and acceptance primitives supplied by `pi-subagents`. Use host
Skills for engineering procedures such as `test-driven-development`,
`spec-driven-development`, `pr-gate`, and `delivery-verification`. Those Skills must
bind claims to deterministic repository, CI, VCS, artifact, and deployment evidence.
Adding a second ForgeFlow implementation would create competing sources of truth.

## Retired architecture

The former Python/LangGraph/Open SWE control plane, provider routing, attempt ledger,
custom agent wrappers, Docker sandbox deployment, supervisors, and GCP systemd units
were removed during the Pi-native cutover. Git history is the audit record for that
retired implementation.
