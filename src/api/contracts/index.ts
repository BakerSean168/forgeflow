import type { FastifySchema } from 'fastify';

import type { ForgeFlowApiOperationId } from '../operations.js';
import { RESOURCE_OPENAPI_SCHEMAS } from './resources.js';
import { SYSTEM_OPENAPI_SCHEMAS } from './system.js';

const overlays: Partial<Record<ForgeFlowApiOperationId, FastifySchema>> = Object.freeze({
  ...SYSTEM_OPENAPI_SCHEMAS,
  ...RESOURCE_OPENAPI_SCHEMAS,
});

export function openApiContractOverlay(schema: FastifySchema): FastifySchema {
  const operationId = schema.operationId as ForgeFlowApiOperationId | undefined;
  if (!operationId) return schema;
  const overlay = overlays[operationId];
  if (!overlay) return schema;
  return {
    ...schema,
    ...overlay,
    ...(schema.response || overlay.response
      ? { response: { ...(schema.response ?? {}), ...(overlay.response ?? {}) } }
      : {}),
  };
}

export function documentedOperationIds(): readonly ForgeFlowApiOperationId[] {
  return Object.freeze(Object.keys(overlays).sort() as ForgeFlowApiOperationId[]);
}
