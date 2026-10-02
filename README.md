# ForgeFlow

> Thin software-engineering governance for Pi Agent.

ForgeFlow is a Pi package, not a coding-agent runtime. Pi owns execution and
`pi-subagents` owns delegation, child lifecycle, worktree isolation, missions,
schedules, resume, background execution, and external-agent runners.

ForgeFlow adds only engineering policy that is not already a Pi primitive.

## Architecture

```text
Pi Agent
  |
  +-- pi-subagents
  |    +-- worker / reviewer / scout / oracle
  |    +-- worktrees / missions / schedules / resume
  |    +-- external-cli / external-job agents
  |
  +-- ForgeFlow
       +-- deterministic invariant preflight
       +-- one-writer policy
       +-- independent review workflow
       +-- exact-head GitHub acceptance
```

The governing rule is:

> Agent success is evidence, not engineering acceptance.

ForgeFlow deliberately does **not** implement sessions, provider routing,
generic agent execution, durable workflow state, a second worktree manager, or
a second scheduler.

## Workflows

### `forgeflow.review`

Runs a fresh Pi reviewer, persists the full report under `.pi/subagents/`, and
uses a Pi typed gate to validate the reviewer's canonical final merge verdict.
Malformed or missing verdicts fail closed.

### `forgeflow.accept`

Binds final acceptance to one exact committed candidate:

1. the local worktree must be clean and at the requested HEAD;
2. a fresh independent reviewer must return a clean typed verdict;
3. the local HEAD must remain unchanged during review;
4. the authoritative open PR must still target the expected base and exact HEAD;
5. every configured required GitHub check must have a successful terminal result.

A new push changes the candidate and invalidates prior acceptance evidence.

See [`docs/architecture.md`](./docs/architecture.md) for the ownership boundary.

## Development

```bash
npm ci --ignore-scripts
npm run check
npm pack --dry-run
```

## License

MIT.
