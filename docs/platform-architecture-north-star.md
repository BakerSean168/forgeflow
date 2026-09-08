# ForgeFlow Platform Architecture — North Star

> Status: Architecture decision baseline for ForgeFlow v1.x → v2-quality internals.
> Scope: control-plane structure, extensibility, API ownership, runtime composition, and engineering governance.
> This document is intentionally higher-level than [`architecture.md`](./architecture.md), which remains the detailed runtime-invariant reference.

## 1. Executive decision

ForgeFlow will evolve as a **modular, durable control plane with explicit extension points**.

The north-star is not a collection of coding-agent wrappers and not a generic runtime plugin host. It is a platform in which:

1. **durable domain state is authoritative**;
2. **small reconcilers/controllers move observed state toward desired lifecycle state**;
3. **external consumers depend on a versioned API contract, never runtime internals**;
4. **projects are declarative data**;
5. **capabilities are narrow, reviewed modules behind typed ports**;
6. **composition is explicit and boring**;
7. **provider/workspace/delivery implementations are replaceable adapters**;
8. **CI enforces architecture, API, safety, and release invariants**;
9. **models propose; deterministic code authorizes and persists**.

The intended steady-state shape is:

```text
                     External consumers
             CLI / automation / future UI / SDK
                            |
                            v
                  Versioned API surface
                 OpenAPI + typed client
                            |
                            v
                   Application services
             commands / queries / use-case ports
                            |
              +-------------+-------------+
              |                           |
              v                           v
      Domain + deterministic       Reconciliation runtime
             kernels              small focused controllers
              |                           |
              +-------------+-------------+
                            |
                            v
                   Durable repositories
                    events / state / CAS
                            |
            +---------------+---------------+
            |               |               |
            v               v               v
         Provider        Workspace        Delivery
         adapters         adapters         adapters

  Project Registry --------------> project-scoped policy/config
  Bootstrap/Composition ----------> wires all modules and adapters
```

## 2. What we learned from mature open-source systems

ForgeFlow borrows **principles**, not product shapes. Every imported pattern is adapted to the security and lifecycle constraints of autonomous software engineering.

### 2.1 Backstage — modules, services, and explicit extension points

References:

- <https://backstage.io/docs/backend-system/>
- <https://backstage.io/docs/backend-system/architecture/modules/>
- <https://backstage.io/docs/backend-system/architecture/index/>

Useful pattern:

- a deployable backend has an explicit composition root;
- features are isolated as plugins/modules;
- modules extend a bounded target through declared extension points;
- shared services are injected rather than rediscovered through globals;
- extension points are separate, narrow APIs that can evolve independently.

Adopt in ForgeFlow:

- `bootstrap/` becomes the only composition root;
- feature modules receive purpose-built dependencies;
- extension contracts are capability-specific and versioned;
- one giant controller context is forbidden;
- initialization order is explicit and validated before serving traffic.

Do **not** copy:

- arbitrary third-party code loading into the privileged control-plane process;
- feature packages receiving broad controller authority by default.

Reason: ForgeFlow may hold repository, review, provider, delivery, and release authority. Unreviewed runtime code would become part of the trusted computing base.

### 2.2 OpenHands — server contract before client/product integration

Reference:

- <https://github.com/OpenHands/software-agent-sdk>

Useful pattern:

```text
Server implementation -> OpenAPI contract -> typed client -> product/integration
```

The Agent Server owns execution behavior; consumers use an API/client boundary instead of importing backend internals.

Adopt in ForgeFlow:

- the committed OpenAPI document is a release artifact;
- every public route has request/response schemas;
- future integrations consume a generated client instead of hand-built payloads;
- API transport code cannot import persistence/adapters/orchestration internals;
- runtime changes and client changes remain independently reviewable.

Do **not** copy:

- agent-runtime state as the top-level lifecycle authority.

ForgeFlow intentionally sits above execution runtimes: provider success is evidence, not engineering completion.

### 2.3 Fastify — encapsulated feature graph

Reference:

- <https://fastify.dev/docs/latest/Reference/Plugins/>

Useful pattern:

- `register()` creates an encapsulated scope;
- routes, decorators, hooks, and schemas can be grouped into a directed feature graph;
- dependencies are explicit at plugin registration.

Adopt in ForgeFlow:

- public HTTP features live under `src/api/v1/<feature>/`;
- one module owns one coherent API capability;
- shared HTTP concerns are registered before child modules;
- no new public route is declared in the composition root;
- modules consume application/query/command contracts rather than controller internals.

### 2.4 Temporal — durable truth, replaceable workers

Reference:

- <https://docs.temporal.io/>

Useful pattern:

- long-running work survives process and infrastructure failures;
- durable workflow truth is independent from a particular worker process;
- workers execute tasks; they are not the source of truth for workflow completion.

Adopt in ForgeFlow:

- Plan/WorkItem/Execution/Review/Delivery state remains controller-owned and restart-safe;
- workers/providers are replaceable execution resources;
- retries create durable lineage rather than rewriting history;
- provider process success never directly marks a Plan complete;
- external side effects need deterministic reconciliation/evidence before terminal acceptance.

Do **not** copy:

- Temporal's programming model or service topology wholesale.

ForgeFlow already has a domain-specific durable state machine and should remain a modular monolith until scale or fault-isolation evidence justifies service extraction.

### 2.5 Kubernetes controllers — reconcile current state toward desired state

References:

- <https://kubernetes.io/docs/concepts/architecture/controller/>
- <https://kubernetes.io/docs/concepts/extend-kubernetes/operator/>

Useful pattern:

- controllers watch durable/shared state;
- each controller owns a bounded aspect of convergence;
- failures are expected and reconciliation is repeatable;
- many small controllers are preferable to one interlinked monolithic loop.

Adopt in ForgeFlow:

- split the current broad polling/composition logic into focused reconcilers;
- each reconciler declares the state it observes, side effects it may request, and evidence it persists;
- reconciliation is idempotent and bounded;
- controllers coordinate through durable state/events, not mutable in-memory cross-calls where avoidable.

Examples of target reconcilers:

- `PlanLifecycleReconciler`
- `ExecutionReconciler`
- `ProviderCleanupReconciler`
- `RuntimeAdmissionReconciler`
- `SupervisorReconciler`
- `ImprovementReconciler`
- `ReleaseAcceptanceReconciler`

## 3. Architecture principles

### P1 — One authoritative owner for every state transition

Every mutable lifecycle field has exactly one deterministic authority. HTTP handlers, models, adapters, and external integrations may request a transition; they do not mutate durable state directly.

### P2 — Durable state before conversation/process state

SQLite/event state, repository identity, Git revision, review lineage, and cleanup evidence outrank provider session state or model claims.

### P3 — Commands and queries are application contracts

API handlers should become thin transport adapters:

```text
HTTP -> validate -> command/query -> application service -> kernel/repository/port
```

An API module must not know how to construct an OpenHands provider, mutate resource state tables, or perform Git operations.

### P4 — Reconciliation over orchestration sprawl

Long-running loops should converge durable state in small, replayable steps. No large `runEverything()` path should need to understand every subsystem.

### P5 — Projects are configuration, capabilities are code

A new repository/project is added through a versioned Project Manifest. A new provider/workspace/delivery capability is added through a narrow reviewed port/adapter/module.

### P6 — Extension authority is proportional to capability

No global plugin context. A delivery extension gets delivery authority, not database/provider/workspace authority. A resource probe gets probe authority, not Plan mutation authority.

### P7 — Public API is a product contract

`/api/v1` compatibility is protected independently from internal refactors. OpenAPI drift is CI-gated. Breaking changes require an explicit versioned migration.

### P8 — Composition root contains wiring, not behavior

The final `bootstrap` layer may instantiate and connect components, start/stop reconcilers, and register API modules. Business validation and lifecycle branching do not belong there.

### P9 — Internal modules can change aggressively behind stable contracts

We will prefer a large internal cleanup now while the public API, durable schema, provider evidence, and release contract remain stable.

### P10 — Every privileged side effect has observable evidence

Repository mutation, provider lifecycle, review, integration, delivery, cleanup, and release promotion must leave controller-verifiable evidence.

## 4. Target source layout

```text
src/
  bootstrap/
    buildControlPlane.ts
    buildApplication.ts
    lifecycle.ts
    config/

  application/
    contracts/
    plans/
    executions/
    resources/
    supervisor/
    improvements/
    system/

  api/
    shared/
      errors.ts
      schemas.ts
    v1/
      health/
      projects/
      plans/
      executions/
      resources/
      supervisor/
      improvements/
      maintenance/
      system/

  platform/
    projects/
    modules/

  core/
    domain/
    kernel/
    orchestration/
    persistence/

  integrations/
    providers/
      openhands/
      antigravity/
    resources/
      litellm/
    workspace/
      git/
      literal-worktree/
    delivery/
      github/
    maintenance/

  main.ts
```

This is a dependency direction, not a demand for dozens of tiny files. Modules should be split only where ownership is clearer.

## 5. Layer ownership

| Layer | Owns | Must not own |
| --- | --- | --- |
| `api` | transport validation, HTTP status, schemas | lifecycle logic, DB access, provider/Git calls |
| `application` | commands, queries, use-case coordination | Fastify, concrete provider/process implementations |
| `core/domain` | state, invariants, transitions | I/O |
| `core/kernel` | privileged deterministic mutations | transport/runtime construction |
| reconcilers | bounded convergence of durable state | unrelated feature state |
| `persistence` | durable storage/event implementation | product policy decisions |
| `integrations` | external side effects behind ports | direct cross-feature durable mutation |
| `platform/projects` | project identity/config/policy projection | runtime credentials |
| `bootstrap` | composition, lifecycle start/stop | business rules |

## 6. Public API architecture

Every v1 route must eventually satisfy:

1. request schema;
2. response schema;
3. shared error envelope;
4. OpenAPI representation;
5. transport-level tests;
6. a thin call into an application command/query.

Target:

```text
api/openapi.v1.json
        |
        v
 generated @forgeflow/client
        |
        +--> CLI
        +--> automation
        +--> future UI
        +--> external integrations
```

Hand-written URL/payload duplication outside the control plane becomes transitional debt.

## 7. Controller/reconciler model

Phase 3 makes convergence ownership explicit. Feature controllers do **not** create timers and do not share a global plugin context. They declare identity, enablement, optional cadence, optional warmup, one retry-safe convergence operation, and an optional close hook. A single lifecycle manager owns scheduling and shutdown.

The implemented contract is conceptually:

```ts
interface Reconciler {
  readonly id: string;
  readonly enabled: boolean;
  readonly intervalMs?: number;
  warmup?(context: ReconcileContext): Promise<void>;
  reconcile(context: ReconcileContext): Promise<void>;
  close?(): Promise<void>;
}
```

Current ownership is deliberately narrow:

| Controller | Authority |
| --- | --- |
| Runtime Admission | demand-driven ACP admission refresh, single-flight refresh, shutdown drain |
| Supervisor | direct reasoning admission/readiness, resource-transition wakes, decision cycles |
| Resource Lifecycle | directory refresh, resource recovery policy, readiness handoff |
| Plan Lifecycle | storage preflight, project queue reconcile, autonomous Plan progression |
| Improvement | discovery/diagnosis/adoption/self-promotion-request convergence |
| Storage Maintenance | in-process workspace cache status and bounded terminal-cache cleanup |

Host-wide cache pruning remains an **external systemd maintenance capability**; the in-process Storage controller exposes its validated projection and owns workspace-local cleanup, rather than duplicating host maintenance authority.

Rules:

- only one reconciler owns a specific automatic transition;
- feature reconcilers declare cadence but never call `setInterval`/`setImmediate` themselves;
- Runtime Admission refresh/shutdown can be invoked only through its dedicated reconciler above the low-level execution-runtime implementation;
- explicit API commands may request convergence through the same controller; they do not create a second authority path;
- reconcile operations are safe to retry and are single-flighted where overlapping work would be unsafe;
- no reconciler keeps correctness-critical truth only in memory;
- lifecycle shutdown disables new scheduling/capability refresh, runs close hooks, then drains already-running reconciliations before the database owner closes SQLite;
- event/wake scheduling remains primary where durable events exist. In particular, Supervisor resource recovery is event-driven with a watchdog fallback; runtime admission is demand-driven. Periodic Plan/resource polling remains a recovery/heartbeat mechanism rather than a second source of durable truth.

## 8. Extension model

### 8.1 Project extension

Use Project Manifest. No code change for normal project registration.

### 8.2 API feature extension

Use versioned `ForgeFlowApiModule` registered at bootstrap. The module receives only its application dependency object.

### 8.3 Runtime capability extension

Use typed ports/registries by capability:

- execution provider;
- reviewer;
- reasoning client;
- workspace;
- delivery;
- resource directory/probe/state effect;
- improvement diagnostician.

### 8.4 Forbidden extension shape

Do not expose:

```ts
register(plugin: (context: {
  db: Database,
  repositories: Everything,
  kernels: Everything,
  shell: Exec,
  secrets: Env,
}) => void)
```

That would erase the security architecture.

## 9. Protected contracts during the refactor

The refactor is intentionally aggressive internally but conservative at the boundary.

Must preserve:

- `/api/v1/*` behavior and HTTP semantics unless explicitly versioned;
- committed `api/openapi.v1.json` compatibility;
- SQLite schema and migration compatibility;
- immutable event meanings and idempotency/CAS behavior;
- single-active-root Plan lease semantics;
- literal-worktree identity, ACL, writer and protected-ref rules;
- exact-SHA independent review lineage;
- resource-selection provenance and failover behavior;
- provider cleanup barrier before worktree retirement/lease release;
- release source SHA + artifact digest provenance;
- real-provider autonomous-lifecycle acceptance;
- fail-closed defaults for improvement/self-change.

## 10. Explicit non-goals

Not part of this architecture refactor:

- microservice decomposition;
- swapping SQLite merely for fashion;
- introducing a message broker without measured need;
- arbitrary runtime third-party plugins;
- replacing OpenHands or provider-native workers;
- changing model/provider policy for unrelated reasons;
- enabling autonomous self-change in production;
- changing product behavior while moving code boundaries.

## 11. Architecture fitness functions

CI is part of the architecture.

Required steady-state gates:

- `npm run check:architecture` — dependency direction and composition budgets;
- `npm run check:api-contract` — OpenAPI drift;
- `npm run check:product-boundary` — product identity/scope;
- typecheck;
- full deterministic tests;
- production build;
- security/dependency audit;
- real-provider lifecycle smoke for releases that alter runtime behavior.

Migration metrics:

| Metric | Baseline | North-star |
| --- | ---: | ---: |
| `src/app.ts` lines | 3345 | < 250 / deleted |
| inline public routes in composition | 43 | 0 |
| public v1 routes with explicit response schema | partial | 100% |
| external integrations hand-building API payloads | present | 0 after typed client migration |
| feature modules importing persistence/adapters | CI-blocked for new modules | 0 |
| project membership authorities | 1 | 1 |
| bootstrap-owned feature timers | present | 0 |
| automatic transition owners | distributed | one focused reconciler per transition |

## 12. Decision summary

ForgeFlow should resemble mature infrastructure platforms in **discipline**, not in size:

- Backstage-style explicit extension contracts;
- OpenHands-style server-contract/client separation;
- Fastify-style encapsulated feature modules;
- Temporal-style durable truth with disposable workers;
- Kubernetes-style focused reconciliation loops.

The result should stay a **small, strongly governed modular monolith** until empirical scale or fault-isolation requirements justify further distribution.

## 9.1 Realized typed-client boundary

Phase 5 makes the external API boundary executable, not merely documented:

```text
api/openapi.v1.json (committed authority)
        |
        +-- server runtime registration / drift check
        |
        +-- openapi-typescript
                |
                v
        packages/client/generated paths
                |
                v
        @forgeflow/client (openapi-fetch)
                |
        +-------+--------+----------+
        |                |          |
      future CLI       future UI   TS integrations
```

The generated client never imports ForgeFlow server internals. It exports the exact contract SHA-256 and contract version used at generation time. CI checks generated drift, TypeScript rejection of unknown paths, runtime URL/path serialization, package exports/build, and npm pack contents.

The first client intentionally exposes typed HTTP method/path operations. Semantic convenience methods are deferred until operations have stable `operationId` identities and stronger request/response schemas. This prevents a manually maintained SDK facade from becoming a competing public contract.

