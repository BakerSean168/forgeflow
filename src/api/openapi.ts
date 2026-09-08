import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';

export async function registerOpenApi(app: FastifyInstance): Promise<void> {
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
