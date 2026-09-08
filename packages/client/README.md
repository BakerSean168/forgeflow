# @forgeflow/client

Typed TypeScript client for the ForgeFlow autonomous software-engineering control plane.

The package is generated from ForgeFlow's committed `api/openapi.v1.json` contract and has **no dependency on ForgeFlow server internals**. Runtime transport is provided by `openapi-fetch`; request paths, path/query parameters, request bodies, and response/error shapes come from the generated OpenAPI `paths` type.

## Usage

```ts
import {
  createForgeFlowClient,
  FORGEFLOW_API_CONTRACT_SHA256,
  FORGEFLOW_API_CONTRACT_VERSION,
} from '@forgeflow/client';

const forgeflow = createForgeFlowClient({
  baseUrl: 'http://127.0.0.1:8420',
});

const { data, error, response } = await forgeflow.GET('/api/v1/projects');
if (error) throw new Error(`ForgeFlow request failed: ${response.status}`);

const plan = await forgeflow.GET('/api/v1/plans/{planId}', {
  params: { path: { planId: 'plan-example' } },
});

console.log(FORGEFLOW_API_CONTRACT_VERSION, FORGEFLOW_API_CONTRACT_SHA256);
```

Unknown paths and missing required path parameters are rejected by TypeScript.

## Contract provenance

The generated package exports:

- `FORGEFLOW_OPENAPI_SPEC_VERSION` — OpenAPI specification version;
- `FORGEFLOW_API_CONTRACT_VERSION` — `info.version` from the committed API contract;
- `FORGEFLOW_API_CONTRACT_SHA256` — SHA-256 of the exact committed OpenAPI JSON used for generation.

The npm/package release version and API contract version are intentionally separate. A ForgeFlow release can add SDK/build capabilities without changing HTTP semantics; conversely, a future API-contract change can be versioned according to compatibility rules.

## Generation and verification

From the repository root:

```bash
npm run client:generate
npm run check:client-contract
npm run test:client
npm run build:client
npm run check:client-package
```

`check:client-contract` regenerates the client contract in memory and fails on byte-level drift. The generated files must never be edited manually.

## Design boundary

The first SDK surface is deliberately **path/method based** rather than a second hand-written DTO/facade layer. This keeps one authority:

```text
api/openapi.v1.json
        |
        v
openapi-typescript
        |
        v
@forgeflow/client generated paths
        |
        v
openapi-fetch runtime
```

Stable semantic `operationId` convenience methods can be added later when the public OpenAPI operations are explicitly named. They must delegate to the generated path client rather than create duplicate request/response models.
