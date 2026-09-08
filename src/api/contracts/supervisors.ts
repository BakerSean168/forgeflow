import type { FastifySchema } from 'fastify';

import { SUPERVISOR_ACTION_TYPES } from '../../core/domain/action.js';
import { PLAN_STATUSES } from '../../core/domain/plan.js';
import { SUPERVISOR_STATUSES } from '../../core/domain/supervisor.js';
import { SUPERVISOR_PROTOCOL_VERSION } from '../../core/supervisor/protocol.js';
import type { ForgeFlowApiOperationId } from '../operations.js';

type SchemaMap = Partial<Record<ForgeFlowApiOperationId, FastifySchema>>;
const unknownObject = { type: 'object', additionalProperties: true };
const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };

const supervisorProjection = {
  type: 'object',
  additionalProperties: false,
  required: [
    'projectionVersion',
    'plan',
    'graph',
    'executions',
    'reviews',
    'supervisor',
    'recentEvents',
    'cursor',
    'digest',
    'truncated',
  ],
  properties: {
    projectionVersion: { type: 'integer', enum: [1] },
    plan: {
      type: 'object',
      additionalProperties: false,
      required: [
        'planId',
        'projectKey',
        'objective',
        'repositoryPath',
        'baseRevision',
        'currentRevision',
        'status',
      ],
      properties: {
        planId: { type: 'string' },
        projectKey: { type: 'string' },
        objective: { type: 'string' },
        repositoryPath: { type: 'string' },
        baseRevision: { type: 'string' },
        currentRevision: { type: 'string' },
        status: { type: 'string', enum: [...PLAN_STATUSES] },
      },
    },
    delivery: unknownObject,
    graph: {
      type: 'object',
      additionalProperties: false,
      required: ['items'],
      properties: {
        graphVersionId: { type: 'string' },
        version: { type: 'integer' },
        items: { type: 'array', items: unknownObject },
      },
    },
    executions: { type: 'array', items: unknownObject },
    reviews: { type: 'array', items: unknownObject },
    supervisor: {
      type: 'object',
      additionalProperties: false,
      required: ['supervisorId', 'status', 'observationCursor', 'allowedActions'],
      properties: {
        supervisorId: { type: 'string' },
        status: { type: 'string', enum: [...SUPERVISOR_STATUSES] },
        observationCursor: { type: 'integer', minimum: 0 },
        allowedActions: { type: 'array', items: { type: 'string', enum: [...SUPERVISOR_ACTION_TYPES] } },
      },
    },
    recentEvents: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['cursor', 'type', 'aggregateType', 'aggregateId', 'occurredAt'],
        properties: {
          cursor: { type: 'integer', minimum: 0 },
          type: { type: 'string' },
          aggregateType: { type: 'string' },
          aggregateId: { type: 'string' },
          occurredAt: { type: 'string' },
        },
      },
    },
    cursor: { type: 'integer', minimum: 0 },
    digest: { type: 'string' },
    truncated: { type: 'boolean' },
  },
};

const decisionBody = {
  type: 'object',
  additionalProperties: true,
  required: [
    'version',
    'planId',
    'supervisorId',
    'observationCursor',
    'projectionDigest',
    'idempotencyKey',
    'action',
  ],
  properties: {
    decisionId: { type: 'string' },
    version: {
      anyOf: [
        { type: 'integer', enum: [SUPERVISOR_PROTOCOL_VERSION] },
        { type: 'string', enum: ['FORGEFLOW_SUPERVISOR_DECISION_V1'] },
      ],
    },
    planId: { type: 'string' },
    supervisorId: { type: 'string' },
    observationCursor: { type: 'integer', minimum: 0 },
    projectionDigest: { type: 'string' },
    idempotencyKey: { type: 'string' },
    preconditionSnapshot: unknownObject,
    action: {
      type: 'object',
      additionalProperties: true,
      required: ['type', 'payload'],
      properties: {
        actionId: { type: 'string' },
        type: { type: 'string', enum: [...SUPERVISOR_ACTION_TYPES] },
        // Individual action payloads are validated by the protocol parser. Keep this object broad so
        // the HTTP contract never becomes an alternate authority for kernel action semantics.
        payload: unknownObject,
      },
    },
  },
};

export const SUPERVISOR_OPENAPI_SCHEMAS: SchemaMap = {
  supervisorsGetProjection: { response: { 200: supervisorProjection } },
  supervisorsDecide: {
    body: decisionBody,
    response: {
      200: {
        type: 'object',
        additionalProperties: false,
        required: ['actionId', 'status', 'code'],
        properties: {
          actionId: { type: 'string' },
          status: { type: 'string', enum: ['SUCCEEDED', 'FAILED', 'REJECTED', 'DUPLICATE'] },
          code: { type: 'string' },
          action: unknownObject,
        },
      },
    },
  },
};
