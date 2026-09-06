# ForgeFlow

**ForgeFlow** is a headless autonomous software engineering control plane.

Give ForgeFlow an engineering objective. It turns that objective into a durable plan, executes dependency-ready work in isolated workspaces, independently reviews exact revisions, repairs failed work, integrates accepted changes, and closes delivery through real repository and CI evidence.

ForgeFlow is designed for long-running software work where correctness, recoverability, provenance, and controlled autonomy matter more than a single model response.

## Engineering loop

```text
Objective
  -> Plan / dependency graph
  -> Implementation
  -> Exact-revision independent review
  -> Repair + re-review when needed
  -> Integration
  -> CI / delivery verification
  -> Complete
```

Repeated bounded engineering failures can also enter a separate improvement intake path:

```text
Repeated verified failure
  -> deterministic Improvement Candidate
  -> explicit adoption (or separately enabled STANDARD/LOW-risk auto-adoption)
  -> ordinary ForgeFlow Plan
  -> the same implementation / independent review / integration / delivery gates
```

Discovery, adoption, low-risk auto-adoption, and self-change are independent opt-in controls. `CONSERVATIVE` programs remain human-adopted even if the global auto-adopt switch is enabled, and Maintenance never receives a privileged repository writer.

A bounded AI Supervisor observes durable state and handles exceptional cases such as replanning the remaining graph, changing an execution route, creating a repair/follow-up plan, or escalating a genuine external gate. Deterministic code retains authority over state transitions, leases, workspace ownership, review provenance, and delivery safety.

## V1 principles

- **Headless by default** — the product surface is plans, executions, reviews, repairs, resources, incidents, and deliveries.
- **Durable before conversational** — the database, not chat history, is the source of truth.
- **Single-writer safety** — one mutable writer owns a worktree at a time.
- **Exact-revision review** — implementation and review are separate phases with immutable Git provenance.
- **Evidence over claims** — tests, commits, reviews, CI, merges, releases, and sanitized Supervisor admission diagnostics remain inspectable as durable evidence rather than ephemeral process state.
- **Exact release identity** — each promoted artifact is bound at process boot to an exact Git source SHA and deterministic artifact digest; release health moves from `PENDING` to `HEALTHY` only after the restarted process proves that same identity.
- **Resource-aware execution** — models/providers are selected through a governed resource directory rather than hard-coded attempt ladders; transient recovery must pass a protocol-correct health probe before a resource re-enters selection, and both ACP execution admission and paid Supervisor admission are demand-driven with durable bounded-TTL readiness caches rather than probing providers while the control plane is idle or immediately after every restart.
- **Bounded intelligence** — AI may diagnose and propose typed actions; Supervisor reasoning must pass its own exact direct-protocol admission and cannot bypass deterministic safety gates.
- **Recoverable execution** — retries, process restarts, provider failures, and interrupted sessions preserve durable lineage; both ACP runtime-admission and Supervisor direct-admission TTLs survive restart. Runtime probes use a stable recovery group plus a unique attempt workspace, planned SIGTERM/SIGINT shutdown aborts new probe work but completes non-cancellable OpenHands cleanup, and recovered probe groups prune crash-residue workspaces only after the remote session is quiescent. Resource recovery wakes parked Supervisors through durable events with a bounded watchdog fallback.
- **Fail-closed operator cancellation** — cancelling an active root Plan first parks it in `SAFETY_HOLD`, quiesces/cancels live provider sessions, cancels unfinished Reviews/WorkItems, retires the Plan workspace family, and only then releases the project lease or hands it to the next queued Plan. Non-terminal child Plans must be cancelled deepest-first through the same public endpoint; child cancellation never retires the shared root worktree family or releases the root project lease. Cleanup or provider-cancel failure keeps the original lease fenced.
- **Explicit improvement adoption** — repeated failures become durable Candidates first; adoption creates an ordinary Plan rather than a privileged repair path.
- **Hard-gated self-change** — even an allowlisted `forgeflow` Candidate cannot target ForgeFlow's own repository unless the separate self-change gate is explicitly enabled; all resulting changes still pass implementation, independent review, tests, and release gates.

## Repository layout

```text
src/
  app.ts              HTTP/control-plane composition
  main.ts             production entrypoint
  core/
    domain/            plans, executions, reviews, resources, worktrees
    kernel/            deterministic state-changing operations
    orchestration/     execution/review/repair/delivery progression
    supervisor/        bounded AI observation and typed decisions
    adapters/          Git, OpenHands, providers, delivery and telemetry
    persistence/       SQLite schema, repositories and event store

deploy/
  gcp/                 hardened systemd deployment
  openhands/           isolated execution plane
openhands_tools/       execution/review ACP adapters
scripts/               release, probes and bounded maintenance
test/                  core, adapter, recovery and deployment contracts
```

## Development

Requirements: Node.js 24+ and npm 10+.

```bash
npm ci
npm run check
```

`npm run check` performs product-boundary validation, type checking, the full test suite, and a clean production build.

See [Architecture](docs/architecture.md) and [Development](docs/development.md) for the system model and contribution workflow.

## Deployment safety

The checked-in deployment is intentionally fail-closed. The example environment contains no enabled projects or credentials. A host operator must explicitly configure project allowlists and runtime credentials before `deploy/gcp/install.sh` will start autonomous execution.

ForgeFlow defaults to its own local interfaces and state:

- Control plane: `127.0.0.1:8420`
- OpenHands execution plane: `127.0.0.1:18420`
- State: `/var/lib/forgeflow`
- Configuration: `/etc/forgeflow`
- API: `/api/v1/*` (including `POST /api/v1/plans/:planId/cancel` for idempotent active-root cancellation)
- Release approval: `refs/forgeflow/release-approved`

These defaults allow ForgeFlow to coexist with another engineering system during migration or canary deployment without sharing mutable state.
