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
worktrees, missions, schedules, resume, background jobs, external-agent runners,
and pull-request gating.

Use `pi-subagents` for delegation, reviewers, and runtime acceptance evidence.
When `pi-gauntlet` is installed, use its `gatekeep-pr` skill for exact-head PR
verification and merge safety. ForgeFlow deliberately does not wrap or duplicate
those surfaces.

Provider infrastructure remains below Pi model selection. ForgeFlow logical roles
may resolve to physical models, while endpoint selection, credentials, channel
health, weights, quotas, and transport belong to the provider layer.

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
