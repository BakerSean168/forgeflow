# API contract

ForgeFlow is an independent control plane. External integrations and orchestrators should treat the HTTP API as the product boundary and must not couple to SQLite, worktree internals, provider sessions, or implementation classes.

## Versioning

- Stable product routes live below `/api/v1/*`.
- `/api/health` is the operational health/readiness surface.
- `/api/openapi.json` exposes the live OpenAPI 3.1 contract.
- [`../api/openapi.v1.json`](../api/openapi.v1.json) is the deterministic checked-in API artifact.
- `npm run check:api-contract` fails when the generated contract drifts from the checked-in artifact.
- `npm run check:api-compat` compares the candidate contract against every committed compatibility baseline under `api/compat/`.
- `npm run check:api-operations` and `npm run check:api-coverage` require stable unique operation identities plus complete response/body coverage for all 45 public operations.
- OpenAPI `info.version` is the HTTP contract version; it is intentionally independent from ForgeFlow/server and npm-package SemVer. The v1.3.1 release carries API contract version `1.2.0`; the v1.3.0 exact-SHA candidate was not released because its production lifecycle acceptance did not complete terminal worktree retirement.

Within `v1`, changes should be additive and backward compatible. Removing or changing the meaning of an existing field, status, or route requires an explicit migration or a new API version.

## Project API

Projects are now first-class platform configuration rather than names scattered through runtime environment lists.

```text
GET /api/v1/projects
GET /api/v1/projects/:projectKey
```

These endpoints expose safe project identity and execution-policy metadata. They do not expose credentials or mutable repository authority.

Project registration itself is operator-controlled and intentionally not writable through the Agent-facing API. This prevents a model or integration from granting itself access to a new repository.

## Plan recovery modes

`POST /api/v1/plans/:planId/reconcile` keeps its existing optional string `mode` contract. Supported V1 recovery modes include normal `auto`, review/delivery recovery, and the explicit `retry-infrastructure` operator mode.

`retry-infrastructure` is intentionally narrow: it applies only to a `WAITING_FOR_RESOURCE` Plan whose RUNNING work item has no active Execution and whose latest implementation/repair failure is classified as provider/resource/workspace-capacity infrastructure. ForgeFlow preserves every historical failed Execution and all prior route exclusions, verifies the durable literal-worktree/source revision when Plan worktrees are in use, preserves the product-attempt budget, and reopens only the latest failed route after it becomes healthy again. If the selector would choose a different route, the recovery remains waiting instead of silently substituting another provider. Multiple RUNNING siblings are preflighted before the recovery wave is committed so an operator action cannot create a half-wave.

This mode is for an infrastructure fault that was fixed outside the Plan, such as repairing a provider runner or mount/provenance boundary. It is not a general retry override and does not make product/test/review failures retryable.

## Trust boundary

The default service binds to `127.0.0.1:8420`. ForgeFlow does not assume that a raw control-plane port is safe to expose to the public internet. Remote integrations should cross an authenticated tunnel, service mesh, or trusted reverse proxy and should keep the control plane private.

External orchestrators are expected to integrate through this API boundary. They should not import ForgeFlow internals or access the durable database directly.

## Schema policy

New API modules should:

1. live under `src/api/`;
2. register as Fastify plugins rather than adding more routes to the composition root;
3. define request and response JSON Schema for every new public route;
4. reuse the shared ForgeFlow error contract;
5. regenerate and commit `api/openapi.v1.json`;
6. add an API-level test using Fastify injection.

All retained V1 public operations now have an explicit generated contract. The Phase-1 compatibility exception is **closed as of v1.3.1**.

### Legacy V1 runtime compatibility

The older V1 handlers originally performed validation inside their transport/application code rather than through Fastify JSON Schema. Replacing that validation in-place would change error timing, status handling, and response serialization. ForgeFlow therefore hardens those already-existing routes through a **documentation-only Swagger transform**:

- the final OpenAPI artifact carries explicit query/header/body/response schemas;
- the typed client consumes those same schemas;
- the legacy Fastify handlers keep their existing validation/serialization behavior;
- the four historically optional bodies (`plansReconcile`, `executionsContinue`, `executionsReplaceProviderSession`, `improvementsAdopt`) remain optional in the generated contract;
- historical generated response statuses are retained when the runtime also exposes a more accurate status, so hardening is monotonic rather than silently breaking old consumers.

New routes do not get this compatibility path: they must be schema-first in their Fastify module. The committed v1.2.1 baseline protects the old documented floor, while the v1.3.1 hardened baseline protects the stronger operation IDs, request bodies, enums, response shapes, and requiredness guarantees introduced by this phase.

## Client strategy

The checked-in OpenAPI artifact is the only HTTP DTO authority. `@forgeflow/client` is generated from it; integrations should never mirror Plan/Execution/Supervisor payloads by hand. All 45 public operations now have stable unique `operationId` values, so `ForgeFlowOperations` exposes semantic operation identities in addition to the path/method client. Future convenience methods may be generated from those identities, but they must delegate to the same generated contract rather than create a second model layer.

## TypeScript client

ForgeFlow ships a standalone TypeScript client package under [`packages/client`](../packages/client/README.md):

```ts
import { createForgeFlowClient } from '@forgeflow/client';

const client = createForgeFlowClient({ baseUrl: 'http://127.0.0.1:8420' });
const { data, error } = await client.GET('/api/v1/projects');
```

The client is generated from the committed `api/openapi.v1.json` artifact with `openapi-typescript` and uses `openapi-fetch` at runtime. It does not import server domain, persistence, bootstrap, or integration code. Generation is deterministic and checked by `npm run check:client-contract`; package type/runtime/build/pack checks are part of the repository `npm run check` gate.

The package exports the exact contract SHA-256 and API/OpenAPI versions used for generation. This lets external consumers identify the contract they were compiled against without coupling package SemVer to the server's internal implementation version.

The SDK intentionally keeps typed HTTP method/path calls as its runtime surface instead of hand-authored DTO wrappers. As of v1.3.1, all V1 public operations have stable `operationId` values and explicit contract coverage; generated `ForgeFlowOperations` can be used for semantic compile-time identities. Convenience methods remain optional ergonomics and, if added, must be generated/delegated from these declarations. No second DTO authority is allowed.
