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

Status: **completed and production-attested in v1.1.4**.

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

Verification and release closure:

- PR and main CI: passing;
- v1.1.4 exact-SHA release: HEALTHY;
- v1.1.4 real-provider lifecycle acceptance: ATTESTED;
- same-wave implementations, two independent exact-SHA PASS reviews, combined integration, provider cleanup, five worktree retirements, lease release, and zero activation failures verified.

### Batch 5 — Phase-4 integration architecture

Status: **completed and production-attested in v1.1.5**.

Completed:

- P4-01 Provider integrations moved under `src/integrations/providers/`; governed execution-provider selection now resolves through a narrow fail-closed `CapabilityRegistry`; selector-off compatibility construction also remains integration-owned;
- P4-02 Workspace integrations moved under `src/integrations/workspaces/`; local clone, literal worktree, Plan worktree management, Agent Harness admission, and OpenHands common-dir mount proof are built by one workspace assembly;
- P4-03 Resource integrations moved under `src/integrations/resources/`; LiteLLM directory/probe/state-effect/resource lifecycle plus provider-native readiness are built by one resource assembly while preserving separate source-vs-overridden directory authority;
- P4-04 Delivery integration moved under `src/integrations/delivery/`; GitHub delivery construction is hidden behind the `DeliveryAutomationPort`;
- P4-05 narrow integration surfaces are enforced: Provider uses a registry because multiple concrete implementations are selected dynamically, while Workspace/Resource/Delivery use capability-specific assemblies/ports rather than an artificial universal plugin context;
- Supervisor core no longer depends on concrete OpenHands; it consumes the new `SupervisorConversationHost` core port;
- release/intake integrations are physically separated under `src/integrations/release/` and `src/integrations/intake/`;
- Phase 4 initially retained deprecated `src/core/adapters/*` compatibility re-exports; Phase 6 Batch 1 has now retired that layer after all consumers migrated to capability package surfaces.

Realized integration package map:

```text
src/integrations/
  registry.ts                  generic exact-one capability registry
  providers/                   OpenHands, Antigravity, Supervisor admission/host, diagnosis
  workspaces/                  local/literal worktrees + assembly
  resources/                   LiteLLM/native resources + assembly + telemetry
  delivery/                    GitHub delivery + assembly
  release/                     self-change canary/promotion external effects
  intake/                      GitHub intake
```

Dependency rules now enforced by CI:

- core feature code cannot import concrete integrations;
- core feature code has no integration exception; the former `core/adapters/*` compatibility directory is retired and CI forbids recreating it;
- API/Application cannot import integrations;
- bootstrap can consume integration capability package `index.ts` surfaces, not concrete files;
- integrations cannot depend back on API/Application/Bootstrap;
- bootstrap contains no direct construction of migrated Provider/Workspace/Resource/Delivery concrete classes.

Why there is no universal registry for everything:

- Provider genuinely has multiple runtime-selected implementations, so exact-one capability resolution is useful and fail-closed;
- Workspace selection is a project-policy composition concern and is isolated inside its own assembly;
- Resource discovery already comes from governed directories/bindings; another registry would duplicate that authority;
- Delivery currently has one stable port/implementation contract, so a registry would add abstraction without a second selection dimension.

Verification before PR:

- generic integration registry duplicate/unsupported/ambiguous behavior is independently tested;
- Provider/Execution focused regression passes after real registry wiring;
- architecture/deployment/integration-registry focused tests pass;
- full deterministic suite, OpenAPI drift, architecture boundary and production build pass;
- non-shim core integration references: 0;
- API/Application integration references: 0;
- bootstrap direct construction of migrated concrete integrations: 0;
- bootstrap non-package integration imports: 0.

Next:

1. merge/release Phase 4 as v1.1.5 if PR/main CI remain green;
2. run exact-SHA real-provider lifecycle acceptance on v1.1.5;
3. enter Phase 5 typed-client/SDK generation only after the release is ATTESTED.

### Batch 6 — Phase-5 typed client / SDK

Status: **completed and production-attested in v1.2.0**.

Completed:

- standalone npm workspace package `@forgeflow/client` under `packages/client`;
- deterministic `openapi-typescript` generation from the committed `api/openapi.v1.json` authority;
- generated `paths/components/operations` TypeScript contract plus exact OpenAPI spec/API contract/SHA-256 provenance constants;
- runtime `createForgeFlowClient()` built on `openapi-fetch`, with no ForgeFlow server-internal dependency;
- client TypeScript tests prove unknown routes and missing required path parameters fail at compile time;
- runtime tests prove base-URL normalization, path-parameter encoding, default headers, package self-reference exports, and contract provenance;
- generation drift, package build, client test/typecheck, and `npm pack --dry-run` are part of the root `npm run check` gate;
- architecture CI rejects client imports of server internals and requires generated contract files to name the committed OpenAPI authority;
- package is publish-ready (`MIT`, public npm access metadata, repository metadata) but publication remains an explicit release action rather than an implicit server deploy side effect.

Design decision:

- V1.2 does **not** create a hand-written mirror of Plan/Execution DTOs;
- the generated path/method client is the public typed authority;
- stable semantic convenience methods should be generated/delegated only after public operations receive stable `operationId` values and stronger schemas;
- npm package version and API contract `info.version` are independent compatibility signals, with the exact contract SHA exported for provenance.

Verification before PR:

- root deterministic/API/architecture/build checks pass;
- client generation drift check passes;
- client TypeScript + runtime tests pass;
- client build resolves package self-reference through declared exports;
- npm pack dry-run succeeds with the intended dist/README/package metadata surface;
- `packages/client/src` server-internal imports: 0.

Verification and release closure:

- PR #11 and main CI passed from a clean GitHub checkout;
- v1.2.0 exact-SHA release `1dc4bf906d8813bb19ae6f4fb5f5f38e84f40f92` is HEALTHY;
- real-provider lifecycle acceptance is ATTESTED at the same source/artifact identity;
- the acceptance exercised same-wave execution, two first-attempt meaningful-progress stalls, deterministic route retry/failover, two successful second attempts, two independent exact-SHA PASS reviews, six provider cleanup proofs, five worktree retirements, lease release, and zero activation failures.

### Batch 7 — Phase-6 legacy adapter retirement

Status: **completed and production-attested in v1.2.1**.

Completed:

- deleted every deprecated external `src/core/adapters/*` compatibility re-export and the old adapter barrel;
- moved the durable Maintenance/Improvement registry from the misleading adapter location to `src/core/maintenance/registry.ts`;
- added `src/core/maintenance/contracts.ts` as the provider-neutral authority for Improvement diagnosis inputs/results/digest plus self-change canary/promotion ports;
- Provider and Release integrations now implement/re-export those core contracts rather than defining authority that core orchestration must import back through a shim;
- migrated repository tests and smoke tooling to `src/integrations/<capability>/index` package surfaces or `src/core/maintenance/index`;
- deleted the unused adapter-shaped `resourceState.ts` re-export; domain resource-routing policy remains the authority;
- architecture CI now fails if `src/core/adapters/` is recreated and core feature code has zero concrete integration import exceptions.

Verification before PR:

- focused regression: 394/394 passing;
- full repository/client deterministic gate: passing;
- retired `core/adapters` source/test/smoke consumers: 0;
- core -> integrations imports: 0;
- TypeScript/OpenAPI/client drift/build/pack gates: passing.

Verification and release closure:

- PR #12 and main CI passed from a clean GitHub checkout;
- v1.2.1 exact-SHA release `602ef2394c593900bfdc074be30edd3cefa95382` is HEALTHY and ATTESTED;
- real-provider acceptance verified same-wave execution, one meaningful-progress stall with deterministic Antigravity retry, two independent exact-SHA PASS reviews, five provider cleanup proofs, five worktree retirements, lease release, and zero activation failures.

### Batch 8 — Phase-6 V1 API contract hardening

Status: **implemented; release closure is folded into v1.3.1 after the v1.3.0 production candidate failed the terminal cleanup acceptance gate**.

Completed:

- added the immutable v1.2.1 OpenAPI compatibility floor and a semantic checker that rejects route/method removal, parameter strengthening/removal, response-status/media-type loss, enum narrowing, schema-type drift, and response guarantee weakening;
- established one explicit 45-operation registry with stable unique `operationId` values and exact generated-spec bidirectional validation;
- hardened every retained legacy V1 operation through documentation-only Swagger overlays so OpenAPI/client types improve without changing Fastify validation or serialization behavior;
- preserved four genuinely optional legacy request bodies and historical generated response statuses while also documenting the runtime's accurate 201/202 statuses;
- established 45/45 contract coverage: every public operation has a 2xx JSON response schema; exactly 18 audited operations carry request bodies and exactly four are optional;
- generated the stronger `ForgeFlowOperations` semantic type surface in `@forgeflow/client` and compile-time tests for Plan, Execution, Resource, Improvement, and Supervisor contracts;
- exported Supervisor action and Improvement candidate vocabularies from their core authorities so protocol validation and OpenAPI generation do not maintain competing enum lists;
- added a v1.3.1 hardened compatibility floor and changed CI to validate every candidate against all committed floors;
- advanced API contract `info.version` from 1.1.0 to 1.2.0 while keeping `/api/v1` path compatibility; server/client package SemVer advances independently to v1.3.1; the v1.3.0 candidate was never tagged or released.

Contract-hardening policy:

- existing legacy handlers keep their original runtime validation/error semantics;
- OpenAPI hardening is documentation-only for those handlers;
- new routes are schema-first and cannot use the legacy overlay as an escape hatch;
- `api/openapi.v1.json` remains the only DTO authority;
- semantic client ergonomics may be generated from `operationId`, but a hand-written DTO/facade authority is forbidden.

Verification before PR:

- operation registry: 45/45 operations, 45 unique IDs;
- contract coverage: 45/45 operations, 18 request bodies, 4 optional bodies;
- compatibility: candidate passes both v1.2.1 legacy and v1.3.1 hardened baselines;
- focused final Improvement/Supervisor/API runtime regression: 407/407 passing;
- full repository + client deterministic gate: passing after each bounded schema group;
- client codegen/type/runtime/build/pack checks: passing.

Release-gate result:

- PR #13 and main CI passed and exact SHA `b8c4d4f67262d34a02ff1f03984954c9d4124420` was deployed as the v1.3.0 **candidate**;
- the candidate exercised the hardened API successfully through same-wave Plan execution and two independent exact-SHA PASS reviews;
- release acceptance correctly remained `MISSING` because terminal cleanup stalled before worktree retirement and lease release;
- no v1.3.0 Git tag or GitHub Release was created, so the failed acceptance candidate never became a public release.

### Batch 9 — v1.3.1 terminal retirement hotfix

Status: **completed and production-attested in v1.3.1**.

Production root cause:

- all six provider-session cleanup proofs were durably present;
- the terminal project lease remained active and all five Plan worktrees remained READY/QUIESCENT;
- short process tracing showed the cleanup loop repeatedly executing `git ls-files -- .forgeflow-completion-evidence.json` on WorkItem A and never reaching `git worktree remove`;
- the durable implementation evidence had already been exact-revision verified/promoted, but the provider later rewrote repository-local descriptive evidence (`summary` / test `command`) without changing revision, outcome, PASS status, or exit code;
- terminal retirement required full JSON equality between durable verified evidence and the late mutable residue, so a non-authoritative descriptive rewrite caused permanent `WORKSPACE_EVIDENCE_AMBIGUOUS` and blocked the cleanup barrier.

Hotfix:

- candidate integration keeps the historical full-evidence equality gate unchanged;
- only terminal retirement may prune late repository-local evidence when both staged and durable evidence independently pass the exact revision gate and their decision-critical projection matches;
- Implementation decision identity includes version, execution, phase, source/result revision, outcome, and test count/status/exitCode;
- Review decision identity includes version, execution, phase, reviewed SHA, verdict, and check count/status/exitCode;
- summary, command, per-check summary, and findings are treated as non-authoritative descriptive fields only after durable promotion and terminal execution;
- any revision/outcome/verdict/test/check status or exit-code drift remains fail-closed as `WORKSPACE_EVIDENCE_AMBIGUOUS`;
- project queue reconcile failures now carry an explicit internal failure marker and `PlanLifecycleReconciler` emits the sanitized project/code pair instead of silently retrying forever.

Verification before PR:

- real production residue was reproduced by deterministic Implementation and Review late-write tests;
- descriptive drift retires successfully; decision-critical drift remains rejected;
- pre-integration differing replay remains strictly rejected;
- queue reconciliation failure logging has a focused test;
- full repository tests: 410/410 passing;
- client tests: 5/5 passing;
- OpenAPI drift, both compatibility floors, 45/45 operation/coverage gates, TypeScript, server/client builds and npm-pack checks: passing.

Release closure:

- PR #14 and main CI passed from clean GitHub runners;
- exact SHA `3e2268f92f0c601f53cf3c47058b2e62981b8d66` deployed with HEALTHY provenance;
- the already-stuck v1.3.0 candidate Plan automatically retired all five worktrees and released its lease after the hotfix booted; this recovery was retained only as hotfix evidence and was not reused for release acceptance;
- one fresh v1.3.1 autonomous lifecycle smoke then completed two same-wave implementations, two independent exact-SHA PASS reviews, provider cleanup for every execution, five worktree retirements, project lease release, and zero activation failures;
- release acceptance is ATTESTED for the exact v1.3.1 source/artifact identity;
- Git tag and Latest GitHub Release `v1.3.1` point to the attested SHA.

### Phase-6 exit

Status: **completed**.

Legacy adapter retirement, V1 contract hardening, compatibility floors, generated semantic operation types, terminal cleanup hardening, dependency-direction enforcement, and release-gated real-provider verification are all in place. Future SDK ergonomics and other additive developer-experience work continue as bounded V1.x follow-ups rather than extending the refactor phase.


### Batch 10 — V1.x semantic SDK operations

Status: **implemented; release closure targets v1.4.0**.

Completed:

- client codegen now emits an exact `operationId -> HTTP method/path` map directly from `api/openapi.v1.json`;
- `createForgeFlowClient()` remains backward-compatible with raw `GET` / `POST` / `request` methods and adds `client.operations.<operationId>()`;
- semantic method parameter requiredness is derived from `openapi-fetch` `FetchOptions<operations[operationId]>`, so required path/header/body input remains compile-time enforced;
- semantic method response types are derived directly from generated OpenAPI operations, with no hand-written DTO or facade authority;
- all 45 hardened V1 operations are exposed through the generated map; generation fails on missing or duplicate `operationId` values;
- no-argument operations, required path parameters, required request bodies, request serialization, response typing, package build, self-reference exports, and npm pack surface are covered by client tests.

Verification before PR:

- full repository tests: 410/410 passing;
- client tests: 7/7 passing;
- V1 operation registry: 45/45 with unique IDs;
- compatibility: candidate passes both committed V1 floors;
- client codegen drift, TypeScript, server/client build, and npm-pack dry-run: passing.

Next:

1. merge only after PR and main CI pass;
2. deploy exact merge SHA and run the normal fresh real-provider lifecycle acceptance for v1.4.0;
3. create the v1.4.0 Tag/Latest GitHub Release only after ATTESTED;
4. npm publication of `@forgeflow/client` remains an explicit distribution action, not an implicit control-plane deploy side effect.
