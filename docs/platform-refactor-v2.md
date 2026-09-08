# ForgeFlow Platform Refactor V2 — Execution Plan

> Goal: aggressively simplify internal structure while preserving all durable, API, repository-safety, review, provider, and release contracts.
> Architecture authority: [`platform-architecture-north-star.md`](./platform-architecture-north-star.md).
> Runtime invariant reference: [`architecture.md`](./architecture.md).

## 1. Executive objective

The current ForgeFlow runtime is functionally strong but structurally concentrated. `src/app.ts` is 3345 lines and still owns 43 historical public route registrations plus execution-resource construction, Supervisor wiring, Improvement wiring, timers, health projection, release acceptance, and shutdown coordination.

This plan turns that composition-heavy shape into:

```text
thin bootstrap
   -> application services
   -> feature API modules
   -> focused reconcilers
   -> explicit integration registries
   -> durable core
```

The work is intentionally **big in internal structure and small in external behavior**.

## 2. Current-system evidence

Verified baseline at plan creation:

- branch: `main`;
- source baseline: `589207c89f67ba26c7e451d1d2b425cac7662b3b`;
- package: `1.1.0`;
- deterministic tests: 376 passing;
- `src/app.ts`: 3345 lines;
- historical inline public routes: 43;
- existing modular Projects routes: 2 route handlers behind one API module;
- OpenAPI 3.1 artifact committed;
- production Project Registry source: manifest;
- latest v1.1.0 real-provider lifecycle: attested;
- active Plans at baseline: 0.

## 3. Protected contracts

Every ticket below must preserve unless its ticket explicitly states a migration:

| Contract | Policy |
| --- | --- |
| `/api/v1` paths and behavior | preserve |
| OpenAPI v1 compatibility | extend schemas, no accidental breaking change |
| DB/schema/migrations | preserve |
| event meanings and audit history | preserve |
| Plan lease/queue semantics | preserve |
| literal worktree security/provenance | preserve |
| exact-SHA independent review | preserve |
| resource selection/admission semantics | preserve |
| provider cleanup before retirement | preserve |
| release provenance/acceptance | preserve |
| self-change gates | preserve disabled defaults |

## 4. Phase map

```text
Phase 0  Baseline + architecture docs
   |
Phase 1  HTTP/application boundary
   |
Phase 2  Bootstrap/composition split
   |
Phase 3  Focused reconcilers
   |
Phase 4  Integration adapters/registries
   |
Phase 5  Typed client + external integration migration
   |
Phase 6  Legacy deletion + hardening
```

## 5. Phase 0 — Baseline and architecture authority

### Goal

Make the desired structure and migration constraints explicit before moving code.

### Deliverables

- north-star architecture document;
- this execution plan;
- route inventory and baseline metrics;
- architecture fitness functions in CI;
- no functional runtime change.

### Acceptance

- docs link from README/development docs;
- `npm run check` remains green;
- baseline metrics recorded and reproducible.

## 6. Phase 1 — HTTP and application boundary

### Goal

Remove transport behavior from `app.ts` and stop API handlers from depending directly on runtime internals.

### Target modules

```text
src/api/v1/
  health/
  releaseAcceptance/
  maintenance/
  improvements/
  storage/
  admission/
  resources/
  plans/
  executions/
  supervisor/
  projects/

src/application/
  system/
  projects/
  plans/
  executions/
  resources/
  improvements/
  supervisor/
```

### TICKET P1-01 — Shared HTTP errors and schema primitives

**Goal:** one stable error envelope and reusable schema primitives.

**Scope:** extract `statusFor`, error handler registration, ids/status schemas, pagination primitives.

**Protected contracts:** existing error code/status mapping.

**Implementation:** move transport helpers to `src/api/shared`; install handler before feature modules; add direct transport tests.

**Acceptance:** no error response regression; `app.ts` contains no error mapping logic.

### TICKET P1-02 — System/readiness API module

**Goal:** extract health, storage, release-acceptance, and admission routes.

**Why now:** mostly query/readiness surfaces; they establish dependency-object patterns with low lifecycle mutation risk.

**Scope:** health, release acceptance, storage, Supervisor admission, runtime admission.

**Acceptance:** identical route paths and projections; OpenAPI stays compatible; inline route budget decreases.

### TICKET P1-03 — Resource API module

**Goal:** extract resource directory/state endpoints behind a `ResourceApplication` contract.

**Scope:** list resources, resource state, binding state.

**Acceptance:** all resource state transitions remain through existing state services; no API import of adapters/persistence.

### TICKET P1-04 — Improvement/Maintenance API module

**Goal:** move maintenance programs and Improvement routes into feature modules.

**Acceptance:** discovery/diagnosis/adoption/self-change gate behavior unchanged.

### TICKET P1-05 — Plans API module

**Goal:** move Plan/queue/children/delivery/reconcile routes behind `PlanApplication`.

**Risk:** highest Phase-1 stateful API surface.

**Acceptance:** single-active Plan queue, cancellation, child Plan, delivery and reconcile tests remain green.

### TICKET P1-06 — Executions API module

**Goal:** move Execution query/run/continue/adoption/cleanup/replacement routes behind `ExecutionApplication`.

**Acceptance:** writer/provider cancellation and evidence semantics unchanged.

### TICKET P1-07 — Supervisor API module

**Goal:** move projection/decision routes behind a Supervisor application contract.

**Acceptance:** typed decision parsing and stale/projection validation unchanged.

### Phase-1 exit

- inline public routes in `app.ts`: 0;
- API modules import only application/domain/platform contracts;
- every moved route has request/response schema or an explicitly documented compatibility exception;
- OpenAPI diff reviewed as contract-preserving.

## 7. Phase 2 — Bootstrap and composition split

### Goal

Reduce `app.ts` from controller implementation to a thin compatibility export, then delete it or make it a small forwarding module.

### TICKET P2-01 — Runtime config parser

Extract environment parsing/validation into typed config groups:

- server;
- repositories/workspaces;
- execution;
- resources;
- Supervisor;
- Improvement;
- release/maintenance.

No raw `process.env` access outside bootstrap/config after completion, except explicitly approved low-level entrypoints.

### TICKET P2-02 — Execution runtime builder

Move `buildExecutionAutomation` and resource/provider construction into `bootstrap/executionRuntime.ts` plus integration registries.

### TICKET P2-03 — Supervisor builder

Move Supervisor client/admission/scheduler/runtime wiring into `bootstrap/supervisorRuntime.ts`.

### TICKET P2-04 — Improvement builder

Move candidate registry, diagnosis, canary, promotion queue and Improvement runtime composition into `bootstrap/improvementRuntime.ts`.

### TICKET P2-05 — Application assembly

Construct application command/query facades from repositories, kernels, runtimes, and Project Registry.

### TICKET P2-06 — Final control-plane builder

`buildControlPlane` becomes wiring only:

```text
load config
bootstrap DB/repositories
build integrations
build application
build API
start reconcilers
register shutdown
return runtime
```

### Phase-2 exit

- `app.ts` < 250 lines or removed;
- no provider-specific construction in API/application modules;
- config is typed and grouped;
- composition dependencies are visible from one bootstrap tree.

## 8. Phase 3 — Focused reconcilers

### Goal

Replace interlinked timer callbacks with independently testable convergence controllers.

### TICKET P3-01 — Reconciler contract and lifecycle manager

Create a narrow common lifecycle contract without a global plugin context.

### TICKET P3-02 — Execution/Plan lifecycle reconciler

Extract automatic Plan progression and execution heartbeat/progress processing.

### TICKET P3-03 — Runtime admission reconciler

Own demand-driven ACP admission refresh, scoped invalidation, shutdown drain.

### TICKET P3-04 — Supervisor reconciler

Own direct admission + waiting-resource wake + decision cycle.

### TICKET P3-05 — Improvement reconciler

Own periodic discovery/diagnosis/adoption/promotion-request cycle.

### TICKET P3-06 — Storage/maintenance reconciler

Own workspace and host-cache maintenance triggers/projections.

### Phase-3 exit

- no feature timer logic in bootstrap;
- each automatic transition has one controller owner;
- each reconciler has focused start/stop/reconcile tests;
- watchdog polling is documented as fallback rather than primary coordination where events exist.

## 9. Phase 4 — Integration architecture

### Goal

Make external capabilities replaceable without exposing controller internals.

### TICKET P4-01 — Provider integration packages

Move OpenHands and provider-native implementations under `src/integrations/providers` while preserving existing port interfaces.

### TICKET P4-02 — Workspace integration packages

Move Git/literal-worktree concrete implementations behind workspace ports.

### TICKET P4-03 — Resource integration packages

Move LiteLLM directory/probe/state-effect implementations behind resource ports.

### TICKET P4-04 — Delivery integration packages

Move GitHub delivery into explicit delivery integration registration.

### TICKET P4-05 — Capability registries

Introduce narrow registries only where multiple implementations require composition. Reject duplicate ids/capabilities at boot.

### Phase-4 exit

- `application` and `api` know no concrete external implementation;
- external integrations are grouped by capability;
- adding a new provider/workspace/delivery adapter does not require editing unrelated feature code.

## 10. Phase 5 — Typed client and external consumer migration

### Goal

Make OpenAPI the actual integration boundary, not just documentation.

### TICKET P5-01 — Complete route schemas

Reach 100% v1 request/response/error schema coverage.

### TICKET P5-02 — Generate `@forgeflow/client`

Generate deterministic TypeScript client types/operations from `api/openapi.v1.json`; commit or package according to reproducibility decision.

### TICKET P5-03 — Contract tests

Boot a real in-process server and run client operations against representative query/command endpoints.

### TICKET P5-04 — Migrate external integrations

Replace hand-written URL/payload code with generated client use.

### Phase-5 exit

- public consumers use typed client/SDK;
- OpenAPI change review is sufficient to understand external compatibility impact.

## 11. Phase 6 — Legacy deletion and hardening

### Goal

Delete compatibility scaffolding after parity is proven.

Candidates:

- legacy comma-separated project config input after an explicit deprecation window;
- old API composition helpers;
- transitional route-budget rules once inline route count reaches zero;
- duplicated parsing/projection helpers;
- old adapter locations after integration moves.

Hardening:

- dependency graph test;
- architecture size budgets;
- boot-time duplicate extension detection;
- API compatibility checks against previous release artifact;
- graceful shutdown/restart integration tests for every reconciler;
- fault-injection around provider/Git/network failures;
- startup configuration diagnostics that never expose secrets.

## 12. Verification matrix

| Change class | Focused | Repository | Release evidence |
| --- | --- | --- | --- |
| docs/architecture only | markdown/link checks | `npm run check` | not required |
| route/module move | API/module tests | `npm run check` | smoke if runtime semantics touched |
| application extraction | use-case + API tests | `npm run check` | smoke if mutation ordering touched |
| bootstrap/reconciler change | lifecycle/restart tests | `npm run check` | real-provider smoke required |
| integration/provider move | adapter + worker tests | `npm run check` | real-provider smoke required |
| OpenAPI/client | contract + client tests | `npm run check` | release smoke as normal |

## 13. Review protocol

Every implementation batch receives a five-layer review:

1. contract correctness;
2. vertical completeness;
3. lifecycle/failure completeness;
4. engineering quality and dependency direction;
5. plan integrity and evidence.

Findings are classified P0–P3. P0/P1 block merge. P2 becomes a focused repair pass or an explicit, reasoned follow-up ticket. P3 cannot justify broad churn inside a high-risk lifecycle batch.

## 14. Rollout strategy

The refactor uses **monotonic internal migration**:

1. add new module/application boundary;
2. characterize old behavior;
3. route existing behavior through the new boundary;
4. run focused tests;
5. run full deterministic gate;
6. delete the old path only after parity;
7. merge in bounded batches;
8. for runtime-affecting batches, deploy exact SHA and re-attest with real providers.

No dual writer, no shadow durable state, and no hidden alternate orchestration path will be introduced merely to make the migration easier.

## 15. Immediate implementation sequence

Start now in this order:

```text
P1-01 shared HTTP boundary
  -> P1-02 system/readiness module
  -> P1-03 resources module
  -> P1-04 improvement module
  -> P1-05 plans module
  -> P1-06 executions module
  -> P1-07 supervisor module
  -> P2 bootstrap split
```

The first batch should materially reduce `app.ts` while keeping product behavior unchanged. The target is not a cosmetic file split; the target is a dependency inversion in which HTTP no longer owns runtime internals.

## 16. Implementation progress ledger

### Batch 1 — HTTP/application foundation

Status: **completed and production-attested in v1.1.1**.

Completed:

- P1-01 shared HTTP error/input/delivery boundary;
- P1-02 System/Readiness API module and System application service;
- P1-03 Resource API module and Resource application service;
- P1-04 Maintenance/Improvement API module and Improvement application service.

Measured structural change after Batch 1:

| Metric | Before | After Batch 1 |
| --- | ---: | ---: |
| `src/app.ts` lines | 3345 | 2755 |
| inline public routes in `app.ts` | 43 | 21 |
| modular API route declarations | 3 | 25 |

Verification:

- deterministic suite: 378/378 passing;
- architecture dependency gate: passing;
- OpenAPI drift is included in the default CI path;
- v1.1.1 exact-SHA real-provider lifecycle acceptance: ATTESTED.

### Batch 2 — Complete Phase-1 API extraction

Status: **completed and production-attested in v1.1.2**.

Completed:

- P1-05 Plans API/application extraction;
- P1-06 Executions API/application extraction;
- P1-07 Supervisor API/application extraction;
- architecture route budget reduced from 21 to 0;
- architecture import analysis upgraded to TypeScript AST parsing so multi-line imports cannot bypass dependency rules;
- legacy V1 permissive-schema behavior documented as a time-bounded compatibility exception rather than silently treated as schema-first.

Measured structural change after Batch 2:

| Metric | Phase-1 start | After Batch 2 |
| --- | ---: | ---: |
| `src/app.ts` lines | 3345 | 2239 |
| inline public routes in `app.ts` | 43 | 0 |
| modular API route declarations | 3 | 46 |

Focused verification completed during implementation:

- Plans/queue/delivery/cancellation focused suite: 88/88 passing;
- Executions/provider lifecycle/telemetry focused suite: 88/88 passing;
- Supervisor/typed decision focused suite: 46/46 passing;
- architecture boundary gate: passing with a zero inline-route budget.

Verification and release closure:

- full deterministic suite: 379/379 passing at the Phase-1 release checkpoint;
- PR and main CI: passing;
- v1.1.2 exact-SHA real-provider lifecycle acceptance: ATTESTED;
- two parallel implementations, two independent exact-SHA PASS reviews, provider cleanup, five worktree retirements, and lease release verified.

### Batch 3 — Phase-2 bootstrap/composition split

Status: **completed and production-attested in v1.1.3**.

Completed:

- P2-01 typed, grouped runtime configuration in `bootstrap/config.ts`, with lazy feature-specific validation preserving disabled-feature startup semantics;
- P2-02 execution/provider/resource/workspace assembly in `bootstrap/executionRuntime.ts`;
- P2-03 Supervisor admission/reasoning/scheduler/runtime assembly in `bootstrap/supervisorRuntime.ts`;
- P2-04 Improvement registry/diagnosis/canary/promotion assembly in `bootstrap/improvementRuntime.ts`;
- P2-05 application facades and typed Supervisor effects in `bootstrap/applicationAssembly.ts`;
- P2-06 project scheduling recovery, system-state projections, runtime lifecycle/reconcilers, shutdown drain, and public control-plane runtime types moved into explicit bootstrap owners;
- deployment/source-ownership tests migrated from file-location assertions to the new subsystem owners;
- composition-root line budget added as a CI fitness function.

Current bootstrap ownership map:

```text
bootstrap/config.ts
  -> typed configuration + Project Registry loading
bootstrap/executionRuntime.ts
  -> provider/resource/workspace/execution assembly
bootstrap/supervisorRuntime.ts
  -> governed reasoning admission + Supervisor runtime
bootstrap/improvementRuntime.ts
  -> Improvement/diagnosis/self-change assembly
bootstrap/applicationAssembly.ts
  -> command/query facades + typed Supervisor effects
bootstrap/projectScheduling.ts
  -> durable project lease/worktree activation and recovery
bootstrap/systemState.ts
  -> release/acceptance/host-maintenance projections
src/reconcilers/*
  -> Phase-3 convergence ownership; the former bootstrap runtimeLifecycle timer bundle is retired
bootstrap/controlPlaneTypes.ts
  -> stable public runtime/build contracts
src/app.ts
  -> composition only
```

Measured Phase-2 structural change:

| Metric | Original V1 | Phase-1 exit | Phase-2 exit |
| --- | ---: | ---: | ---: |
| `src/app.ts` lines | 3345 | 2239 | 183 |
| inline public routes in `app.ts` | 43 | 0 | 0 |
| raw runtime env access in `app.ts` | many | 0 | 0 |
| raw runtime env access in execution builder | many | n/a | 0 |
| app composition line budget | none | none | <=250 CI-enforced |

Verification before PR:

- focused Phase-2 cross-boundary suite: 80/80 passing;
- full deterministic suite: 382/382 passing;
- TypeScript, OpenAPI drift, architecture boundary and production build: passing;
- `app.ts` inline-route budget: 0;
- `app.ts` composition line budget: 250, actual 183;
- raw env access gate prevents configuration reads from leaking back into composition/API/application/execution assembly.

Verification and release closure:

- PR and main CI: passing;
- v1.1.3 exact-SHA release: HEALTHY;
- v1.1.3 real-provider lifecycle acceptance: ATTESTED;
- two same-wave implementations, two independent exact-SHA PASS reviews, combined integration head, provider cleanup, five worktree retirements, lease release, and zero activation failures verified.

### Batch 4 — Phase-3 focused reconcilers

Status: **implemented; closure requires the normal PR/main-CI/exact-SHA v1.1.4 release and real-provider acceptance gates**.

Completed:

- P3-01 common Reconciler contract and single scheduling/shutdown lifecycle manager;
- P3-02 Plan lifecycle controller owns storage preflight, project queue convergence, Plan automation progression, and detached admission refresh request;
- P3-03 Runtime Admission controller is the sole refresh/shutdown authority above the low-level execution runtime, including explicit Plan/Resource/Supervisor action requests;
- P3-04 Supervisor controller owns direct admission/readiness, resource-transition wakes, warmup and decision cycles;
- P3-05 Improvement controller owns bounded autonomous discovery/diagnosis/adoption/promotion-request cycles;
- P3-06 Storage controller owns workspace-local capacity projection and bounded terminal-cache cleanup; host-wide cache pruning deliberately remains external systemd maintenance and is exposed only through its validated projection;
- the Phase-2 `bootstrap/runtimeLifecycle.ts` timer bundle is deleted;
- Resource, Plan and ControlPlane explicit convergence paths now request the same focused controllers instead of calling underlying automation admission/readiness functions directly;
- shutdown now stops new scheduling, closes capability-specific refreshers, and drains already-running lifecycle-managed reconciliations before the DB is closed.

Phase-3 ownership map:

```text
ReconcilerLifecycleManager
  -> scheduling + single-flight boundary + shutdown drain

RuntimeAdmissionReconciler
  -> ACP runtime admission refresh/shutdown
SupervisorReconciler
  -> reasoning admission/readiness + wakes + decisions
ResourceLifecycleReconciler
  -> directory/resource recovery -> Supervisor readiness -> admission
PlanLifecycleReconciler
  -> storage -> queue -> Plan automation -> detached admission refresh
ImprovementReconciler
  -> discovery/diagnosis/adoption/promotion-request cycle
StorageMaintenanceReconciler
  -> workspace storage projection + terminal cache cleanup
```

Coordination policy:

- durable events/wakes are primary where available;
- Supervisor resource recovery is event-driven with watchdog polling as fallback;
- runtime admission is demand-driven and cached durably;
- Plan/resource periodic polling remains bounded heartbeat/recovery convergence, never durable truth;
- feature reconcilers declare cadence but only the generic lifecycle manager owns timers.

Verification before PR:

- reconciler lifecycle/controller focused tests: 10/10 passing;
- broader Phase-3 focused suite: 86/86 passing before the shutdown-drain hardening pass;
- final full deterministic suite: 392/392 passing;
- TypeScript, OpenAPI drift, architecture boundary and production build: passing;
- bootstrap feature timer files: 0;
- feature reconciler timer files outside the generic lifecycle manager: 0;
- direct Runtime Admission reconcile/shutdown callers above the implementation: only `RuntimeAdmissionReconciler`;
- old `bootstrap/runtimeLifecycle.ts` references in runtime/tests: 0.

Next:

1. merge/release Phase 3 as v1.1.4 if PR/main CI remain green;
2. run exact-SHA real-provider lifecycle acceptance on v1.1.4;
3. enter Phase 4 integration architecture only after the release is ATTESTED.
