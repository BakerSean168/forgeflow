# Contributing to ForgeFlow

ForgeFlow is a control plane for autonomous software engineering. Changes that look small at the code level can affect writer ownership, Git provenance, retry safety, provider cleanup, or release acceptance, so contributions are expected to preserve the system's fail-closed contracts.

## Development setup

Requirements:

- Node.js 24+
- npm 10+
- Git

```bash
npm ci
npm run check
```

`npm run check` runs the product-boundary check, TypeScript type checking, the full deterministic test suite, and a clean production build.

Real-provider smoke tests are intentionally separate because they create real executions and may consume paid or quota-limited provider resources.

## Change workflow

1. Branch from the current `main`.
2. Keep one concern per branch/PR.
3. Add or update characterization/regression tests for lifecycle changes.
4. Run focused tests first, then `npm run check`.
5. Describe the protected contract affected by the change.
6. Do not claim provider, review, CI, merge, deployment, or release evidence that was not actually observed.

Recommended branch prefixes include `feat/`, `fix/`, `docs/`, and `refactor/`.

## Protected contracts

Changes must preserve or explicitly migrate these invariants:

- one active root Plan per project;
- one mutable writer per worktree;
- immutable execution resource selection and lineage;
- exact-revision independent review;
- controller-owned Git/worktree provenance;
- provider cleanup proof before writer handoff or terminal retirement;
- fail-closed cancellation and recovery;
- exact source SHA + artifact digest release provenance;
- no privileged self-change path that bypasses ordinary implementation/review/integration gates.

If a change intentionally modifies one of these contracts, document the migration and add tests that prove both the new behavior and the expected failure path.

## Pull requests

A good PR states:

- the observable problem and target outcome;
- the lifecycle or architecture boundary touched;
- tests/commands actually run;
- any real-provider evidence, if applicable;
- rollback or containment for high-risk changes.

Documentation-only PRs do not need real-provider acceptance unless they change deployment scripts, runtime configuration semantics, or operator safety instructions.

## Security-sensitive changes

Never commit or paste provider credentials, authentication files, SSH material, production database contents, raw authorization headers, or unredacted provider bodies. See [`SECURITY.md`](./SECURITY.md).
