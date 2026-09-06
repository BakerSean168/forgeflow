# ForgeFlow Development

## Local checks

Run the same baseline used by CI:

```bash
npm ci
npm run check
```

The check sequence is intentionally deterministic:

1. Product-boundary validation.
2. TypeScript type checking.
3. Full Node test suite.
4. Clean production build.

Use focused tests while editing, then run the full check before committing.

## Change workflow

Prefer small commits that preserve a green durable baseline. For behavior changes:

1. State the invariant being changed.
2. Add or update the focused regression test.
3. Implement the smallest deterministic change.
4. Run focused tests.
5. Run `npm run check`.
6. Review the exact commit, not a mutable working tree.

Changes that affect execution isolation, review provenance, resource selection, recovery, or delivery should include a failure-path test in addition to the success path.

## Product boundary

ForgeFlow is an autonomous software engineering system. UI decoration, game/character state, simulated organizations, and alternate routing authorities do not belong in the core repository. `npm run check:boundary` guards the repository against historical product/runtime namespaces and paths being reintroduced.

## Deployment workflow

Production promotion uses a fast-forward-only approval ref beneath `refs/forgeflow/`. `scripts/release-gcp.sh` builds and tests an exact detached worktree, backs up the durable database when present, atomically exchanges the build artifact, restarts the service, and requires ForgeFlow v1 health before reporting success.

Do not point a production host at an uncommitted checkout and do not use environment files to weaken repository or review gates.
