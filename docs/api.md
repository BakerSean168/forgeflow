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

## Client strategy

The checked-in OpenAPI artifact is the source from which typed clients can be generated. A future standalone SDK should be generated from this contract rather than duplicating HTTP payload definitions by hand. Until that package exists, integrations should still use only documented HTTP routes and must tolerate additive fields.
