import type { FastifySchema } from 'fastify';

import {
  RESOURCE_STATES,
  RESOURCE_TIERS,
  RESOURCE_TRANSPORTS,
} from '../../core/domain/resourceRouting.js';
import type { ForgeFlowApiOperationId } from '../operations.js';

type SchemaMap = Partial<Record<ForgeFlowApiOperationId, FastifySchema>>;

const nullableString = {
  anyOf: [{ type: 'string' }, { type: 'null' }],
};
const nullableInteger = {
  anyOf: [{ type: 'integer' }, { type: 'null' }],
};
const resourceWakeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['becameAvailable', 'scheduledWakes'],
  properties: {
    becameAvailable: { type: 'array', items: { type: 'string' } },
    scheduledWakes: { type: 'integer', minimum: 0 },
  },
};
const modelBindingSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'modelFamily',
    'capability',
    'agentBackend',
    'modelRank',
    'enabled',
    'ready',
    'deploymentId',
    'routeModel',
    'protocol',
  ],
  properties: {
    modelFamily: { type: 'string' },
    capability: nullableString,
    agentBackend: nullableString,
    modelRank: nullableInteger,
    enabled: { type: 'boolean' },
    ready: { type: 'boolean' },
    deploymentId: nullableString,
    routeModel: nullableString,
    protocol: nullableString,
  },
};
const normalizedFailureSchema = {
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['reasonClass', 'sanitizedReason', 'changedAt', 'source'],
      properties: {
        reasonClass: { type: 'string' },
        sanitizedReason: nullableString,
        changedAt: { type: 'string' },
        source: { type: 'string' },
      },
    },
    { type: 'null' },
  ],
};
const resourceSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'resourceId',
    'displayName',
    'providerKey',
    'resourceTier',
    'resourceSequence',
    'state',
    'transport',
    'modelBindings',
    'lastNormalizedFailure',
    'suspendedUntil',
    'version',
  ],
  properties: {
    resourceId: { type: 'string' },
    displayName: { type: 'string' },
    providerKey: nullableString,
    resourceTier: { type: 'string', enum: [...RESOURCE_TIERS] },
    resourceSequence: { type: 'integer', minimum: 1 },
    state: { type: 'string', enum: [...RESOURCE_STATES] },
    transport: { type: 'string', enum: [...RESOURCE_TRANSPORTS] },
    modelBindings: { type: 'array', items: modelBindingSchema },
    lastNormalizedFailure: normalizedFailureSchema,
    suspendedUntil: nullableString,
    version: { type: 'integer', minimum: 0 },
  },
};

const resourceStateBody = {
  type: 'object',
  additionalProperties: true,
  required: ['state'],
  properties: {
    // Runtime deliberately accepts case-insensitive state text; keep the OpenAPI input broad.
    state: { type: 'string' },
    reason: { type: 'string' },
    suspendedUntil: { type: 'string' },
    // Legacy runtime accepts a non-negative integer or a numeric string, and treats null as absent.
    expectedVersion: {
      anyOf: [{ type: 'integer', minimum: 0 }, { type: 'string' }, { type: 'null' }],
    },
  },
};
const bindingStateBody = {
  type: 'object',
  additionalProperties: true,
  required: ['state'],
  properties: {
    state: { type: 'string' },
  },
};

export const RESOURCE_OPENAPI_SCHEMAS: SchemaMap = {
  resourcesList: {
    response: {
      200: {
        type: 'object',
        additionalProperties: false,
        required: ['items', 'count'],
        properties: {
          items: { type: 'array', items: resourceSchema },
          count: { type: 'integer', minimum: 0 },
        },
      },
    },
  },
  resourcesSetState: {
    body: resourceStateBody,
    response: {
      200: {
        type: 'object',
        additionalProperties: false,
        required: ['resource', 'mutation', 'resourceWake'],
        properties: {
          resource: resourceSchema,
          mutation: { type: 'string' },
          resourceWake: resourceWakeSchema,
        },
      },
    },
  },
  resourcesSetBindingState: {
    body: bindingStateBody,
    response: {
      200: {
        type: 'object',
        additionalProperties: false,
        required: ['resource', 'bindingId', 'state', 'resourceWake'],
        properties: {
          resource: resourceSchema,
          bindingId: { type: 'string' },
          state: { type: 'string', enum: ['ACTIVE', 'DISABLED'] },
          resourceWake: resourceWakeSchema,
        },
      },
    },
  },
};
