# API contract

ForgeFlow is an independent control plane. External integrations and orchestrators should treat the HTTP API as the product boundary and must not couple to SQLite, worktree internals, provider sessions, or implementation classes.

## Versioning

- Stable product routes live below `/api/v1/*`.
- `/api/health` is the operational health/readiness surface.
- `/api/openapi.json` exposes the live OpenAPI 3.1 contract.
- [`../api/openapi.v1.json`](../api/openapi.v1.json) is the deterministic checked-in API artifact.
- `npm run check:api-contract` fails when the generated contract drifts from the checked-in artifact.

Within `v1`, changes should be additive and backward compatible. Removing or changing the meaning of an existing field, status, or route requires an explicit migration or a new API version.

## Project API

Projects are now first-class platform configuration rather than names scattered through runtime environment lists.

```text
GET /api/v1/projects
GET /api/v1/projects/:projectKey
```

These endpoints expose safe project identity and execution-policy metadata. They do not expose credentials or mutable repository authority.

Project registration itself is operator-controlled and intentionally not writable through the Agent-facing API. This prevents a model or integration from granting itself access to a new repository.

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

The existing V1 routes predate the schema-first boundary and are being migrated incrementally. New routes are not allowed to expand that legacy pattern.

### Time-bounded V1 compatibility exception

Phase 1 moves legacy V1 routes behind API modules and application services **without tightening request validation or response serialization**, because changing validation while changing ownership would mix a contract migration with an architecture migration. Those moved legacy routes may therefore retain permissive/generated OpenAPI shapes until the dedicated contract-hardening/typed-client phase. This exception is time-bounded:

- it applies only to public routes that existed before the Phase-1 modularization baseline;
- it does not allow new public routes without request/response JSON Schema;
- public path/status/field semantics must remain backward compatible during ownership migration;
- OpenAPI drift remains a mandatory CI gate;
- the exception closes when the typed-client/contract-hardening phase gives every retained V1 route an explicit schema.

This separation keeps Phase 1 behavior-preserving while preventing the compatibility surface from growing.

## Client strategy

The checked-in OpenAPI artifact is the source from which typed clients can be generated. A future standalone SDK should be generated from this contract rather than duplicating HTTP payload definitions by hand. Until that package exists, integrations should still use only documented HTTP routes and must tolerate additive fields.

## TypeScript client

ForgeFlow ships a standalone TypeScript client package under [`packages/client`](../packages/client/README.md):

```ts
import { createForgeFlowClient } from '@forgeflow/client';

const client = createForgeFlowClient({ baseUrl: 'http://127.0.0.1:8420' });
const { data, error } = await client.GET('/api/v1/projects');
```

The client is generated from the committed `api/openapi.v1.json` artifact with `openapi-typescript` and uses `openapi-fetch` at runtime. It does not import server domain, persistence, bootstrap, or integration code. Generation is deterministic and checked by `npm run check:client-contract`; package type/runtime/build/pack checks are part of the repository `npm run check` gate.

The package exports the exact contract SHA-256 and API/OpenAPI versions used for generation. This lets external consumers identify the contract they were compiled against without coupling package SemVer to the server's internal implementation version.

The initial SDK intentionally uses typed HTTP method/path calls instead of hand-authored DTO wrappers. Many V1 routes still carry compatibility-permissive schemas, and most operations do not yet have stable `operationId` values. Contract hardening and semantic convenience methods should therefore proceed monotonically: first tighten the OpenAPI schemas/operation identities, then generate ergonomics from those same declarations. No second DTO authority should be introduced.
