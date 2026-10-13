# ForgeFlow

> Thin software-engineering policy for Pi Agent.

ForgeFlow is a Pi package, not an agent runtime or workflow engine. Pi and its
plugins own execution. ForgeFlow keeps only policy that is useful across those
plugins.

## What ForgeFlow owns

- stable logical model roles:
  `forgeflow/planner`, `worker`, `reviewer`, `scout`, and `oracle`;
- deterministic engineering-invariant preflight;
- the one-writer-per-worktree rule;
- policy reminders that bind delivery evidence to the current candidate.

## What ForgeFlow does not own

Pi and installed plugins own child execution, review loops, acceptance gates,
worktrees, missions, schedules, resume, background jobs, and external-agent runners.
Engineering Skills own reusable methods such as TDD, SDD, PR gating, and delivery
verification.

Use `pi-subagents` as the single child-orchestration primitive. Use host Skills such
as `test-driven-development`, `spec-driven-development`, `pr-gate`, and
`delivery-verification` when those workflows are installed. ForgeFlow deliberately
does not wrap or duplicate those surfaces.

Provider infrastructure remains below Pi model selection. ForgeFlow logical roles
choose model capability and thinking effort; policy v3 can also order equivalent quota
sources (for example Business Team before a commercial relay). Endpoint selection,
credentials, channel health, and transport remain provider-layer concerns. LiteLLM still
owns commercial-channel selection after ForgeFlow has selected the commercial physical
model.

ForgeFlow records credential-free local model/supply usage in `~/.pi/forgeflow-usage.jsonl`;
`forgeflow-usage` summarizes it. LiteLLM SpendLogs remain authoritative for relay-channel spend.

## External ACP coding agents

ForgeFlow can register local `pi-subagents` delegates for GLM Agent, ZCode and
DSH without owning an ACP runtime or model-provider gateway:

- `glm-agent` / `glm-agent-writer`: GLM ACP analysis and explicit write roles.
- `zcode-agent` / `zcode-agent-writer`: ZCode ACP plan and explicit build roles.
- `dsh-agent-writer`: DSH native `dsh acp` worker; DSH does not advertise an
  enforceable read-only mode.

Delegations are local, async-only and use each executable's configured model,
account and credentials. Reader modes deny ACP permission requests, but are not
substitutes for OS-level isolation. Each writer still requires exclusive worktree
ownership. No T3 Provider-instance model routing or automatic cross-Agent quota
failover is implied.

See [external-agent delegation](./docs/external-agent-delegation.md) for the
exact roles, executable configuration, protocol safeguards and smoke tests.

## Antigravity delegation

When the installed `pi-subagents` owner is present, ForgeFlow also registers two
external agents backed by the locally authenticated Antigravity CLI (`agy`):

- `antigravity` (alias `agy`) runs Antigravity in read-only `plan` mode;
- `antigravity-writer` (alias `agy-writer`) runs in `accept-edits` mode.

`pi-subagents` still owns child lifecycle, status, timeout, and stop. ForgeFlow only
bridges its stdin handoff to `agy --print`; Antigravity keeps its own authentication,
model selection, quota, and execution runtime. The bridge is local-only and requires
`agy` on `PATH`. It does not turn Antigravity subscription quota into a Pi model
provider.

See [`docs/model-policy.md`](./docs/model-policy.md) for logical-model policy and
[`docs/architecture.md`](./docs/architecture.md) for the ownership boundary.

## Development

```bash
npm ci --ignore-scripts
npm run check
npm pack --dry-run
```

## License

MIT.
