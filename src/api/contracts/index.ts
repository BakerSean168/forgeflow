import type { FastifySchema } from 'fastify';

import type { ForgeFlowApiOperationId } from '../operations.js';
import { EXECUTION_OPENAPI_SCHEMAS } from './executions.js';
import { PLAN_OPENAPI_SCHEMAS } from './plans.js';
import { RESOURCE_OPENAPI_SCHEMAS } from './resources.js';
import { SYSTEM_OPENAPI_SCHEMAS } from './system.js';

const overlays: Partial<Record<ForgeFlowApiOperationId, FastifySchema>> = Object.freeze({
  ...SYSTEM_OPENAPI_SCHEMAS,
  ...RESOURCE_OPENAPI_SCHEMAS,
  ...PLAN_OPENAPI_SCHEMAS,
  ...EXECUTION_OPENAPI_SCHEMAS,
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

export const OPTIONAL_REQUEST_BODY_OPERATION_IDS = Object.freeze(new Set<ForgeFlowApiOperationId>([
  'plansReconcile',
  'executionsContinue',
  'executionsReplaceProviderSession',
]));

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function finalizeOpenApiContract<T extends Record<string, unknown>>(document: T): T {
  const paths = objectRecord(document.paths) ?? {};
  for (const pathItemValue of Object.values(paths)) {
    const pathItem = objectRecord(pathItemValue);
    if (!pathItem) continue;
    for (const operationValue of Object.values(pathItem)) {
      const operation = objectRecord(operationValue);
      const requestBody = objectRecord(operation?.requestBody);
      if (
        requestBody &&
        typeof operation?.operationId === 'string' &&
        OPTIONAL_REQUEST_BODY_OPERATION_IDS.has(operation.operationId as ForgeFlowApiOperationId)
      ) requestBody.required = false;
    }
  }
  return document;
}

export function documentedOperationIds(): readonly ForgeFlowApiOperationId[] {
  return Object.freeze(Object.keys(overlays).sort() as ForgeFlowApiOperationId[]);
}
