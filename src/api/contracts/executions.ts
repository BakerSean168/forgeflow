import type { FastifySchema } from 'fastify';

import { EXECUTION_STATUSES } from '../../core/domain/execution.js';
import type { ForgeFlowApiOperationId } from '../operations.js';

type SchemaMap = Partial<Record<ForgeFlowApiOperationId, FastifySchema>>;
const unknownObject = { type: 'object', additionalProperties: true };
const nullableObject = { anyOf: [unknownObject, { type: 'null' }] };
const idempotencyHeaders = {
  type: 'object',
  additionalProperties: true,
  properties: { 'idempotency-key': { type: 'string' } },
};
const reasonBody = {
  type: 'object',
  additionalProperties: true,
  required: ['reason'],
  properties: { idempotencyKey: { type: 'string' }, reason: { type: 'string' } },
};

export const EXECUTION_OPENAPI_SCHEMAS: SchemaMap = {
  executionsList: {
    querystring: {
      type: 'object',
      additionalProperties: true,
      properties: {
        limit: { anyOf: [{ type: 'integer', minimum: 1, maximum: 1000 }, { type: 'string' }] },
        planId: { type: 'string' },
        status: { type: 'string', enum: [...EXECUTION_STATUSES] },
        view: { type: 'string', enum: ['dashboard'] },
      },
    },
    response: {
      200: {
        type: 'object',
        additionalProperties: false,
        required: ['items', 'count'],
        properties: {
          items: { type: 'array', items: unknownObject },
          count: { type: 'integer', minimum: 0 },
        },
      },
    },
  },
  executionsGet: {
    response: {
      200: {
        type: 'object',
        additionalProperties: false,
        required: [
          'execution',
          'resourceSelection',
          'session',
          'evidence',
          'reviewAsImplementation',
          'reviewAsReviewer',
        ],
        properties: {
          execution: unknownObject,
          resourceSelection: nullableObject,
          session: nullableObject,
          evidence: { type: 'array', items: unknownObject },
          reviewAsImplementation: nullableObject,
          reviewAsReviewer: nullableObject,
        },
      },
    },
  },
  executionsRun: { response: { 200: unknownObject } },
  executionsContinue: {
    body: {
      type: 'object',
      additionalProperties: true,
      properties: {
        instruction: { type: 'string' },
        interruptCurrent: { type: 'boolean' },
      },
    },
    response: { 200: unknownObject },
  },
  executionsAdoptWorkspace: {
    headers: idempotencyHeaders,
    body: reasonBody,
    response: { 200: unknownObject },
  },
  executionsAbortPausedProvider: {
    headers: idempotencyHeaders,
    body: reasonBody,
    response: { 200: unknownObject },
  },
  executionsProviderCleanup: {
    headers: idempotencyHeaders,
    body: reasonBody,
    response: { 200: unknownObject },
  },
  executionsReplaceProviderSession: {
    headers: idempotencyHeaders,
    body: {
      type: 'object',
      additionalProperties: true,
      properties: {
        idempotencyKey: { type: 'string' },
        instruction: { type: 'string' },
        reason: { type: 'string' },
      },
    },
    response: { 200: unknownObject },
  },
};
