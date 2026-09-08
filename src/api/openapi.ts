import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';

import { registerApiOperationIds } from './operations.js';
import { openApiContractOverlay } from './contracts/index.js';

export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  registerApiOperationIds(app);
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'ForgeFlow Control Plane API',
        description: 'Versioned HTTP contract for ForgeFlow integrations. Internal runtime state remains controller-owned.',
        version: '1.1.0',
      },
      tags: [
        { name: 'Projects', description: 'Declarative project registration and policy projection.' },
      ],
    },
    // Documentation-only overlay for legacy V1 routes. This enriches OpenAPI without
    // changing Fastify request validation or response serialization semantics.
    transform: ({ schema, url }) => ({ schema: openApiContractOverlay(schema), url }),
  });
  app.get(
    '/api/openapi.json',
    {
      schema: {
        hide: true,
        response: { 200: { type: 'object', additionalProperties: true } },
      },
    },
    async () => app.swagger(),
  );
}
