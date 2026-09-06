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

Changes that affect execution isolation, review provenance, resource selection, recovery, cancellation, or delivery should include a failure-path test in addition to the success path. Active Plan cancellation tests must prove that provider/worktree cleanup failure preserves the current project lease and prevents the next queued Plan from activating.

## Product boundary

ForgeFlow is an autonomous software engineering system. UI decoration, game/character state, simulated organizations, and alternate routing authorities do not belong in the core repository. `npm run check:boundary` guards the repository against historical product/runtime namespaces and paths being reintroduced.

## Improvement diagnosis

Cross-Plan AI diagnosis is optional and disabled by default. To enable it, configure a non-empty `FORGEFLOW_IMPROVEMENT_PROJECTS`, keep `FORGEFLOW_EXECUTION_RUNTIME_ENABLED=true` and `FORGEFLOW_RESOURCE_SELECTOR_ENABLED=true`, then set `FORGEFLOW_IMPROVEMENT_AI_DIAGNOSIS_ENABLED=true`. `FORGEFLOW_IMPROVEMENT_AI_DIAGNOSIS_MAX_PER_CYCLE` bounds new diagnoses per maintenance cycle, `FORGEFLOW_IMPROVEMENT_AI_DIAGNOSIS_MAX_RESOURCE_ATTEMPTS` bounds reasoning-route failover, and `FORGEFLOW_IMPROVEMENT_AI_DIAGNOSIS_TIMEOUT_MS` bounds each provider request. There is intentionally no diagnosis model alias: `DIAGNOSE` uses the same governed `REASONING` resource policy and direct-protocol admission as other bounded reasoning work.

The diagnoser receives only structured controller-owned failure metadata, not repository contents or raw provider/log text. Treat its output as an attestation, not an instruction channel. `POST /api/v1/improvements/:candidateId/diagnose` explicitly runs one diagnosis; the periodic Improvement cycle can do the same automatically when enabled. A safe `PROPOSE_REPAIR` may enrich an ordinary Improvement Plan, while `NO_ACTION`, raised risk, invalid evidence references, or unsafe attempts to weaken gates cannot auto-adopt work.

## Deployment workflow

Production promotion uses a fast-forward-only approval ref beneath `refs/forgeflow/`. `scripts/release-gcp.sh` builds and tests an exact detached worktree, hashes the emitted `dist/` with the shared `scripts/artifact-digest.sh`, backs up the durable database when present, atomically exchanges the artifact, writes root-owned release provenance as `PENDING`, restarts the service, and requires the boot-bound source SHA/artifact digest to match before promoting that same provenance to `HEALTHY`. A failed restart or identity mismatch leaves no false healthy-release claim.

The self-change path uses the same release builder with two additional fail-closed inputs: an exact `FORGEFLOW_RELEASE_SOURCE_SHA` and the canary's `FORGEFLOW_EXPECTED_ARTIFACT_SHA256`. The builder verifies that the source fast-forwards the currently approved release and that its rebuilt bytes exactly match the canary before installation. When `FORGEFLOW_ADVANCE_RELEASE_REF_ON_SUCCESS=true`, the approval ref advances only after the new process is verified `HEALTHY`; a failed self-release therefore cannot poison the operator approval ref. The systemd promotion runner is intentionally outside `forgeflow.service` so the release can restart the control plane without killing itself.

Do not point a production host at an uncommitted checkout and do not use environment files to weaken repository, canary, review, or release gates.
