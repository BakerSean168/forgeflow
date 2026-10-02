# ForgeFlow

> Thin software-engineering governance for Pi Agent.

ForgeFlow is being cut over from the previous Python/LangGraph/Open SWE control
plane to a Pi-native package. Pi is the execution kernel; `pi-subagents` owns
delegation, child lifecycle, worktree isolation, missions, schedules, resume,
background execution, and external agent runners.

ForgeFlow deliberately does **not** implement a second coding-agent runtime.

## Target architecture

```text
Pi Agent
  |
  +-- pi-subagents
  |    +-- worker
  |    +-- reviewer
  |    +-- scout / oracle
  |    +-- external-cli / external-job agents
  |    +-- worktrees / missions / schedules / resume
  |
  +-- ForgeFlow
       +-- engineering invariant preflight
       +-- one-writer policy
       +-- independent review workflow
       +-- exact-head GitHub acceptance
```

The governing rule is simple:

> Agent success is evidence, not engineering acceptance.

For pull-request delivery, ForgeFlow binds acceptance to one explicit candidate:
the local committed HEAD, the authoritative open PR head, the expected base
branch, the configured required CI checks, and a fresh independent review must
all describe the same revision. A new push invalidates the previous acceptance.

## Pi-native package

The package currently provides:

- automatic ForgeFlow policy/invariant injection through Pi's
  `before_agent_start` lifecycle;
- the trusted `forgeflow.review` workflow for a fresh structured read-only
  review;
- the trusted `forgeflow.accept` workflow for final exact-head review and
  GitHub CI acceptance;
- the `forgeflow` skill describing the ownership and acceptance rules.

The package depends on `pi-subagents` and uses its public workflow-resource
extension API. It does not wrap or fork the subagent runtime.

## Migration status

The Pi-native cutover is under active implementation on
`refactor/pi-native-forgeflow`. Legacy Python/Open SWE/LangGraph files remain
in the repository temporarily as migration evidence and will be deleted after a
real Pi-native implementation -> review -> repair -> exact-head acceptance
canary succeeds.

The migration decision and deletion boundary are recorded in
[`docs/plan/2026-10-02-pi-native-cutover.md`](./docs/plan/2026-10-02-pi-native-cutover.md).

## Development

Install JavaScript dependencies and run the Pi-native checks:

```bash
npm install
npm run check:pi-native
```

The legacy Python suite remains available during the cutover only to prove that
the migration branch has not accidentally damaged historical behavior before
that code is removed.

## License

MIT.
