# Contributing

ForgeFlow is deliberately small. Contributions should strengthen
software-engineering governance without reintroducing a second agent runtime.

Before submitting changes:

```bash
npm ci --ignore-scripts
npm run check
npm pack --dry-run
```

Keep the ownership boundary strict:

- Pi owns agent execution and session lifecycle.
- `pi-subagents` owns child orchestration, worktrees, missions, schedules,
  resume, and external-agent runners.
- ForgeFlow may add deterministic engineering invariants and acceptance gates
  only when those policies are not already Pi primitives.
- Do not add a ForgeFlow database, generic provider router, scheduler,
  worktree manager, or durable execution engine.
