# Extensibility model

> Strategic architecture authority: [`platform-architecture-north-star.md`](./platform-architecture-north-star.md).
> Active migration plan: [`platform-refactor-v2.md`](./platform-refactor-v2.md).

ForgeFlow uses a **modular monolith with explicit extension points**. The goal is to make projects and capabilities easy to add without turning privileged controller code into an unrestricted runtime plugin host.

## Why not arbitrary runtime plugins?

ForgeFlow can hold repository write authority, provider credentials, review evidence, and release capabilities. Loading arbitrary third-party JavaScript into the control-plane process would make every plugin part of that trusted computing base.

The V1 extension model therefore distinguishes two cases:

- **Projects are data** — add them declaratively through the Project Registry.
- **Capabilities are reviewed modules** — add them behind typed ports / Fastify modules and ship them through the normal build, test, review, and release gates.

This preserves plugin-like composition without silently granting unreviewed code control-plane privilege.

## North-star layers

```text
External integrations
Orchestrators / CLI / future UI / automation
                 |
                 v
        Versioned HTTP API
      OpenAPI + JSON Schema
                 |
                 v
     Application composition
      use cases / runtimes
                 |
       +---------+---------+
       |                   |
       v                   v
Project Registry      Extension ports
       |                   |
       v                   v
 Domain + kernels     provider/workspace/
 durable invariants   delivery integrations
       |                   |
       +---------+---------+
                 |
                 v
       Durable persistence
```

The domain/kernels own privileged lifecycle invariants. API and integration modules may call approved application contracts, but they must not bypass those invariants with direct database mutations.

## Project Registry

The preferred configuration source is a versioned YAML manifest:

```yaml
version: 1
projects:
  - projectKey: memoflow
    displayName: MemoFlow
    repositoryPath: /home/dev/projects/.forgeflow-control/memoflow
    tags: [product]
    execution:
      enabled: true
      workspace: literal-worktree
      allowProviderNative: true
      maxParallelWorkItems: 2
    improvement:
      enabled: false
```

Set:

```text
FORGEFLOW_PROJECTS_FILE=/etc/forgeflow/projects.yaml
```

The registry is fail-closed:

- the manifest is versioned;
- duplicate project keys are rejected;
- duplicate repository ownership is rejected;
- repository paths must be absolute and remain inside configured repository roots;
- literal-worktree use still requires the global safety gate;
- project-level parallelism can only narrow the host-level maximum;
- project registration does not contain credentials.

The old comma-separated environment lists remain a compatibility input while existing deployments migrate. When `FORGEFLOW_PROJECTS_FILE` is configured, the manifest is authoritative for project membership and project capabilities.

Adding another repository should therefore become an operator configuration change plus deployment reconciliation, not a ForgeFlow source-code edit.

## Feature modules

HTTP features should be implemented as encapsulated Fastify plugins under `src/api/`. The Projects API is the first migrated slice. New public features should not add route declarations directly to `src/app.ts`.

Runtime integrations should use existing typed ports, for example execution providers, workspaces, delivery, resource state, and Supervisor decision clients. If a capability does not fit an existing port, define the smallest purpose-specific extension contract instead of creating a global “plugin context” that exposes the whole controller.

Good extension points are:

- capability-specific;
- versionable;
- narrow in authority;
- mockable in tests;
- unable to mutate unrelated state;
- registered explicitly at composition time.

## Architecture enforcement

`npm run check:architecture` enforces dependency direction. In particular:

- `core` cannot import API/platform/composition code;
- platform code cannot reach into runtime/persistence internals;
- API modules cannot directly depend on adapters, persistence, or orchestration internals.

The `src/app.ts` composition root contains no public route declarations and is protected by a zero-inline-route budget plus a <=250-line composition budget. Runtime configuration is centralized in `src/bootstrap/config.ts`; feature timers are forbidden in bootstrap; automatic convergence belongs to focused reconcilers under `src/reconcilers/`.

## Planned migration sequence

1. **Foundation — completed** — Project Registry, OpenAPI artifact, API module boundary, architecture gate.
2. **HTTP modularization — completed** — Plans, Executions, Resources, Supervisor, Improvement, Projects, and system routes are feature modules; the `app.ts` inline-route budget is zero.
3. **Composition split — completed** — typed config, execution/Supervisor/Improvement builders, application assembly, project scheduling, system projections, and public runtime contracts live under `src/bootstrap/`; `app.ts` is a thin composition root.
4. **Focused reconcilers — implemented** — a single lifecycle manager schedules independently testable Plan, Resource, Runtime Admission, Supervisor, Improvement, and Storage controllers; bootstrap owns no feature timers.
5. **Integration packages — implemented** — Provider, Workspace, Resource, Delivery, Release, and Intake concrete I/O live under `src/integrations/`; Provider uses exact-one registry selection, while other capabilities use narrow package assemblies/ports. Deprecated `core/adapters/*` re-exports remain only for compatibility until Phase 6.
6. **Typed client — next** — generate a standalone client/SDK from the committed OpenAPI contract for external orchestrators and future consumers.

Each stage must preserve durable database/event compatibility, exact-SHA review, resource selection provenance, worktree/lease safety, and release acceptance.
