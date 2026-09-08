import type { FastifySchema } from 'fastify';

import { PLAN_STATUSES } from '../../core/domain/plan.js';
import type { ForgeFlowApiOperationId } from '../operations.js';

type SchemaMap = Partial<Record<ForgeFlowApiOperationId, FastifySchema>>;

const unknownObject = { type: 'object', additionalProperties: true };
const nullableObject = { anyOf: [unknownObject, { type: 'null' }] };
const integerLike = { anyOf: [{ type: 'integer' }, { type: 'string' }, { type: 'null' }] };
const idempotencyHeaders = {
  type: 'object',
  additionalProperties: true,
  properties: {
    'idempotency-key': { type: 'string' },
  },
};
const deliverySchema = {
  type: 'object',
  additionalProperties: true,
  required: ['branch', 'autoMerge'],
  properties: {
    remote: { type: 'string' },
    branch: { type: 'string' },
    targetBranch: { type: 'string' },
    autoMerge: { type: 'boolean' },
    mergeMethod: { type: 'string', enum: ['merge', 'squash', 'rebase'] },
    requiredChecks: { type: 'array', items: { type: 'string' } },
  },
};
const graphItemSchema = {
  type: 'object',
  additionalProperties: true,
  required: ['itemKey', 'title', 'objective'],
  properties: {
    itemKey: { type: 'string' },
    title: { type: 'string' },
    objective: { type: 'string' },
    dependencies: { type: 'array', items: { type: 'string' } },
    acceptanceCriteria: { type: 'array', items: { type: 'string' } },
    parallelSafe: { type: 'boolean' },
    writeScopes: { type: 'array', items: { type: 'string' } },
    conflictKeys: { type: 'array', items: { type: 'string' } },
  },
};
const planCreateBody = {
  type: 'object',
  additionalProperties: true,
  required: ['projectKey', 'objective', 'baseRevision'],
  properties: {
    idempotencyKey: { type: 'string' },
    projectKey: { type: 'string' },
    objective: { type: 'string' },
    repositoryPath: { type: 'string' },
    baseRevision: { type: 'string' },
    delivery: deliverySchema,
    workItems: { type: 'array', items: graphItemSchema },
    priority: integerLike,
  },
};
const childCreateBody = {
  type: 'object',
  additionalProperties: true,
  required: ['childPlanId', 'objective'],
  properties: {
    childPlanId: { type: 'string' },
    repositoryPath: { type: 'string' },
    objective: { type: 'string' },
    relation: {
      type: 'string',
      enum: ['SYSTEM_REPAIR', 'INFRASTRUCTURE_REPAIR', 'FOLLOW_UP'],
      default: 'FOLLOW_UP',
    },
    delivery: deliverySchema,
    workItems: { type: 'array', items: graphItemSchema },
  },
};
const planViewSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'plan',
    'delivery',
    'graph',
    'workItems',
    'executions',
    'reviews',
    'sessions',
    'worktrees',
    'activationEvents',
    'supervisor',
  ],
  properties: {
    plan: unknownObject,
    delivery: nullableObject,
    graph: nullableObject,
    workItems: { type: 'array', items: unknownObject },
    executions: { type: 'array', items: unknownObject },
    reviews: { type: 'array', items: unknownObject },
    sessions: { type: 'array', items: unknownObject },
    worktrees: { type: 'array', items: unknownObject },
    activationEvents: { type: 'array', items: unknownObject },
    supervisor: nullableObject,
  },
};

export const PLAN_OPENAPI_SCHEMAS: SchemaMap = {
  plansList: {
    querystring: {
      type: 'object',
      additionalProperties: true,
      properties: {
        limit: { anyOf: [{ type: 'integer', minimum: 1, maximum: 1000 }, { type: 'string' }] },
        status: { type: 'string', enum: [...PLAN_STATUSES] },
        view: { type: 'string', enum: ['full', 'summary'] },
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
  projectsGetPlanQueue: {
    response: {
      200: {
        type: 'object',
        additionalProperties: false,
        required: ['projectKey', 'lease', 'items'],
        properties: {
          projectKey: { type: 'string' },
          lease: nullableObject,
          items: { type: 'array', items: unknownObject },
        },
      },
    },
  },
  plansReprioritize: {
    body: {
      type: 'object',
      additionalProperties: true,
      properties: { priority: integerLike },
    },
    response: {
      200: {
        type: 'object',
        additionalProperties: false,
        required: ['queueEntry', 'mutation'],
        properties: { queueEntry: unknownObject, mutation: { type: 'string' } },
      },
    },
  },
  plansCancelQueued: {
    response: {
      200: {
        type: 'object',
        additionalProperties: false,
        required: ['plan', 'queueEntry'],
        properties: { plan: unknownObject, queueEntry: nullableObject },
      },
    },
  },
  plansCancel: {
    headers: idempotencyHeaders,
    body: {
      type: 'object',
      additionalProperties: true,
      required: ['reason'],
      properties: { idempotencyKey: { type: 'string' }, reason: { type: 'string' } },
    },
    response: {
      200: {
        type: 'object',
        additionalProperties: true,
        required: ['plan', 'lease'],
        properties: { plan: unknownObject, lease: nullableObject },
      },
    },
  },
  plansCreate: {
    headers: idempotencyHeaders,
    body: planCreateBody,
    response: {
      200: {
        type: 'object',
        additionalProperties: true,
        required: ['plan', 'graph', 'supervisor'],
        properties: { plan: unknownObject, graph: unknownObject, supervisor: nullableObject, scheduling: unknownObject },
      },
      201: {
        type: 'object',
        additionalProperties: true,
        required: ['plan', 'graph', 'supervisor'],
        properties: { plan: unknownObject, graph: unknownObject, supervisor: nullableObject, scheduling: unknownObject },
      },
    },
  },
  plansCreateChild: {
    body: childCreateBody,
    response: {
      // Retain the legacy generated 200 contract while documenting the runtime's real 201.
      200: {
        type: 'object',
        additionalProperties: false,
        required: ['plan', 'graph', 'relationshipId', 'supervisor', 'statusUrl'],
        properties: {
          plan: unknownObject,
          graph: unknownObject,
          relationshipId: { type: 'string' },
          supervisor: nullableObject,
          statusUrl: { type: 'string' },
        },
      },
      201: {
        type: 'object',
        additionalProperties: false,
        required: ['plan', 'graph', 'relationshipId', 'supervisor', 'statusUrl'],
        properties: {
          plan: unknownObject,
          graph: unknownObject,
          relationshipId: { type: 'string' },
          supervisor: nullableObject,
          statusUrl: { type: 'string' },
        },
      },
    },
  },
  plansAttachDelivery: {
    body: deliverySchema,
    response: {
      200: {
        type: 'object',
        additionalProperties: false,
        required: ['planId', 'delivery', 'statusUrl'],
        properties: { planId: { type: 'string' }, delivery: deliverySchema, statusUrl: { type: 'string' } },
      },
      201: {
        type: 'object',
        additionalProperties: false,
        required: ['planId', 'delivery', 'statusUrl'],
        properties: { planId: { type: 'string' }, delivery: deliverySchema, statusUrl: { type: 'string' } },
      },
    },
  },
  plansGet: { response: { 200: planViewSchema } },
  plansRun: { response: { 200: unknownObject } },
  plansReconcile: {
    body: {
      type: 'object',
      additionalProperties: true,
      properties: {
        mode: { type: 'string' },
        scopeAmendments: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['itemKey', 'expectedWriteScopes', 'writeScopes', 'reason'],
            properties: {
              itemKey: { type: 'string' },
              expectedWriteScopes: {
                type: 'array',
                minItems: 1,
                maxItems: 64,
                items: { type: 'string' },
              },
              writeScopes: {
                type: 'array',
                minItems: 1,
                maxItems: 64,
                items: { type: 'string' },
              },
              reason: { type: 'string' },
            },
          },
        },
      },
    },
    response: {
      // Retain the legacy generated 200 contract while documenting the runtime's real 202.
      200: {
        type: 'object',
        additionalProperties: true,
        required: ['statusUrl'],
        properties: { statusUrl: { type: 'string' } },
      },
      202: {
        type: 'object',
        additionalProperties: true,
        required: ['statusUrl'],
        properties: { statusUrl: { type: 'string' } },
      },
    },
  },
};
