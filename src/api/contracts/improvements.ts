import type { FastifySchema } from 'fastify';

import {
  IMPROVEMENT_CANDIDATE_RISKS,
  IMPROVEMENT_CANDIDATE_STATUSES,
  MAINTENANCE_PROGRAM_SCOPES,
} from '../../core/maintenance/index.js';
import type { ForgeFlowApiOperationId } from '../operations.js';

type SchemaMap = Partial<Record<ForgeFlowApiOperationId, FastifySchema>>;

const unknownObject = { type: 'object', additionalProperties: true };
const nullableObject = { anyOf: [unknownObject, { type: 'null' }] };
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
const programSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['programId', 'projectKey', 'autonomousScope', 'autoMerge', 'enabled'],
  properties: {
    programId: { type: 'string' },
    projectKey: { type: 'string' },
    repositoryPath: { type: 'string' },
    implementationRoutes: { type: 'array', items: { type: 'string' } },
    reviewRoutes: { type: 'array', items: { type: 'string' } },
    autonomousScope: { type: 'string', enum: [...MAINTENANCE_PROGRAM_SCOPES] },
    autoMerge: { type: 'boolean' },
    enabled: { type: 'boolean' },
    failureCodePrefixes: { type: 'array', items: { type: 'string' } },
    failureThreshold: { type: 'integer' },
    recentExecutionLimit: { type: 'integer' },
    candidateRisk: { type: 'string', enum: [...IMPROVEMENT_CANDIDATE_RISKS] },
  },
};
const candidateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['candidateId', 'programId', 'fingerprint', 'title', 'evidence', 'risk', 'status'],
  properties: {
    candidateId: { type: 'string' },
    programId: { type: 'string' },
    fingerprint: { type: 'string' },
    title: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    risk: { type: 'string', enum: [...IMPROVEMENT_CANDIDATE_RISKS] },
    status: { type: 'string', enum: [...IMPROVEMENT_CANDIDATE_STATUSES] },
    planId: { type: 'string' },
    pullRequestId: { type: 'string' },
  },
};
const discoverBody = {
  type: 'object',
  additionalProperties: true,
  required: ['programId', 'projectKey'],
  properties: {
    programId: { type: 'string' },
    projectKey: { type: 'string' },
    repositoryPath: { type: 'string' },
    implementationRoutes: { type: 'array', items: { type: 'string' } },
    reviewRoutes: { type: 'array', items: { type: 'string' } },
    autonomousScope: {
      type: 'string',
      enum: [...MAINTENANCE_PROGRAM_SCOPES],
      default: 'CONSERVATIVE',
    },
    autoMerge: { type: 'boolean', default: false },
    enabled: { type: 'boolean', default: true },
    failureCodePrefixes: { type: 'array', items: { type: 'string' } },
    failureThreshold: { type: 'integer', default: 3 },
    recentExecutionLimit: { type: 'integer', default: 200 },
    candidateRisk: {
      type: 'string',
      enum: [...IMPROVEMENT_CANDIDATE_RISKS],
      default: 'LOW',
    },
  },
};
const adoptObject = {
  type: 'object',
  additionalProperties: true,
  properties: {
    repositoryPath: { type: 'string' },
    baseRevision: { type: 'string' },
    priority: { type: 'integer' },
    acknowledgeHighRisk: { type: 'boolean' },
    delivery: deliverySchema,
  },
};
const selfChangeProjection = {
  type: 'object',
  additionalProperties: false,
  required: [
    'selfChange',
    'selfPromotionEnabled',
    'canaries',
    'promotionRequest',
    'promotion',
    'releaseProvenance',
  ],
  properties: {
    selfChange: { type: 'boolean' },
    selfPromotionEnabled: { type: 'boolean' },
    canaries: { type: 'array', items: unknownObject },
    promotionRequest: nullableObject,
    promotion: nullableObject,
    releaseProvenance: nullableObject,
  },
};

export const IMPROVEMENT_OPENAPI_SCHEMAS: SchemaMap = {
  maintenanceProgramsList: {
    response: {
      200: {
        type: 'object',
        additionalProperties: false,
        required: ['items'],
        properties: { items: { type: 'array', items: programSchema } },
      },
    },
  },
  maintenanceProgramsSetState: {
    body: {
      type: 'object',
      additionalProperties: true,
      required: ['enabled'],
      properties: { enabled: { type: 'boolean' } },
    },
    response: {
      200: {
        type: 'object',
        additionalProperties: false,
        required: ['program'],
        properties: { program: programSchema },
      },
    },
  },
  improvementsList: {
    querystring: {
      type: 'object',
      additionalProperties: true,
      properties: {
        programId: { type: 'string' },
        status: { type: 'string', enum: [...IMPROVEMENT_CANDIDATE_STATUSES] },
        limit: { anyOf: [{ type: 'integer', minimum: 1, maximum: 1000 }, { type: 'string' }] },
      },
    },
    response: {
      200: {
        type: 'object',
        additionalProperties: false,
        required: ['items', 'count', 'runtime'],
        properties: {
          items: { type: 'array', items: candidateSchema },
          count: { type: 'integer', minimum: 0 },
          runtime: unknownObject,
        },
      },
    },
  },
  improvementsGet: {
    response: {
      200: {
        type: 'object',
        additionalProperties: false,
        required: ['candidate', 'program', 'plan', 'diagnoses', 'selfChange'],
        properties: {
          candidate: candidateSchema,
          program: programSchema,
          plan: nullableObject,
          diagnoses: { type: 'array', items: unknownObject },
          selfChange: selfChangeProjection,
        },
      },
    },
  },
  improvementsDiscover: {
    body: discoverBody,
    response: {
      200: {
        type: 'object',
        additionalProperties: false,
        required: ['program', 'items', 'count'],
        properties: {
          program: programSchema,
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['candidate', 'mutation', 'observedCount', 'errorCode', 'phase'],
              properties: {
                candidate: candidateSchema,
                mutation: { type: 'string', enum: ['created', 'existing'] },
                observedCount: { type: 'integer', minimum: 0 },
                errorCode: { type: 'string' },
                phase: { type: 'string' },
              },
            },
          },
          count: { type: 'integer', minimum: 0 },
        },
      },
    },
  },
  improvementsRunCycle: { response: { 200: unknownObject } },
  improvementsDiagnose: {
    response: {
      200: {
        type: 'object',
        additionalProperties: false,
        required: ['diagnosis'],
        properties: { diagnosis: unknownObject },
      },
    },
  },
  improvementsAdopt: {
    // The runtime intentionally accepts both an absent body and JSON null as an empty adoption request.
    body: { anyOf: [adoptObject, { type: 'null' }] },
    response: {
      200: {
        type: 'object',
        additionalProperties: true,
        required: ['candidate', 'plan'],
        properties: {
          candidate: candidateSchema,
          plan: unknownObject,
          scheduling: unknownObject,
        },
      },
    },
  },
  improvementsReconcile: {
    response: {
      200: {
        type: 'object',
        additionalProperties: false,
        required: ['candidate'],
        properties: { candidate: candidateSchema },
      },
    },
  },
  improvementsSelfCanary: {
    response: {
      200: {
        type: 'object',
        additionalProperties: false,
        required: ['canary', 'selfChange'],
        properties: { canary: unknownObject, selfChange: selfChangeProjection },
      },
    },
  },
  improvementsSelfPromote: {
    response: {
      // Preserve the old generated 200 contract while documenting the runtime's actual 202.
      200: {
        type: 'object',
        additionalProperties: false,
        required: ['promotionRequest', 'selfChange'],
        properties: { promotionRequest: unknownObject, selfChange: selfChangeProjection },
      },
      202: {
        type: 'object',
        additionalProperties: false,
        required: ['promotionRequest', 'selfChange'],
        properties: { promotionRequest: unknownObject, selfChange: selfChangeProjection },
      },
    },
  },
  improvementsReject: {
    response: {
      200: {
        type: 'object',
        additionalProperties: false,
        required: ['candidate'],
        properties: { candidate: candidateSchema },
      },
    },
  },
};
