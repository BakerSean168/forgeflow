import type { FastifySchema } from 'fastify';

import { RESOURCE_TRANSPORTS } from '../../core/domain/resourceRouting.js';
import type { ForgeFlowApiOperationId } from '../operations.js';

type SchemaMap = Partial<Record<ForgeFlowApiOperationId, FastifySchema>>;

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const unknownObject = { type: 'object', additionalProperties: true };
const summarySchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    checked: { type: 'integer', minimum: 0 },
    ready: { type: 'integer', minimum: 0 },
    unready: { type: 'integer', minimum: 0 },
    implementationReady: { type: 'integer', minimum: 0 },
    reviewReady: { type: 'integer', minimum: 0 },
  },
};
const supervisorAdmissionItemSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'resourceId',
    'bindingId',
    'modelFamily',
    'routeModel',
    'protocol',
    'ready',
    'checkedAt',
    'errorCode',
  ],
  properties: {
    resourceId: { type: 'string' },
    bindingId: { type: 'string' },
    modelFamily: { type: 'string' },
    routeModel: { type: 'string' },
    protocol: { type: 'string' },
    ready: { type: 'boolean' },
    checkedAt: { type: 'string' },
    errorCode: nullableString,
  },
};
const runtimeAdmissionItemSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'phase',
    'agentBackend',
    'transport',
    'resourceId',
    'bindingId',
    'modelFamily',
    'routeModel',
    'ready',
    'checkedAt',
    'errorCode',
  ],
  properties: {
    phase: nullableString,
    agentBackend: { type: 'string' },
    transport: { type: 'string', enum: [...RESOURCE_TRANSPORTS] },
    resourceId: { type: 'string' },
    bindingId: { type: 'string' },
    modelFamily: { type: 'string' },
    routeModel: { type: 'string' },
    ready: { type: 'boolean' },
    checkedAt: { type: 'string' },
    errorCode: nullableString,
  },
};
function admissionProjection(itemSchema: Record<string, unknown>) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['enabled', 'demandDriven', 'hasDemand', 'summary', 'items', 'durableCache'],
    properties: {
      enabled: { type: 'boolean' },
      demandDriven: { type: 'boolean' },
      hasDemand: { type: 'boolean' },
      summary: summarySchema,
      items: { type: 'array', items: itemSchema },
      durableCache: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'items'],
        properties: {
          summary: summarySchema,
          items: { type: 'array', items: itemSchema },
        },
      },
    },
  };
}
const releaseAcceptanceBody = {
  type: 'object',
  additionalProperties: true,
  required: ['planId', 'sourceSha', 'artifactSha256', 'canonicalHead', 'externalChecks'],
  properties: {
    planId: { type: 'string' },
    sourceSha: { type: 'string' },
    artifactSha256: { type: 'string' },
    canonicalHead: { type: 'string' },
    externalChecks: { type: 'array', items: { type: 'string' } },
  },
};
const releaseAcceptanceResponse = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'attestation', 'attestedAt'],
  properties: {
    status: { type: 'string', enum: ['ATTESTED'] },
    attestation: unknownObject,
    attestedAt: { type: 'string' },
  },
};

export const SYSTEM_OPENAPI_SCHEMAS: SchemaMap = {
  systemHealth: {
    response: {
      200: {
        type: 'object',
        additionalProperties: true,
        required: [
          'status',
          'service',
          'apiVersion',
          'mode',
          'releaseProvenance',
          'autonomousLifecycleAcceptance',
          'workspaceStorage',
          'hostCacheMaintenance',
          'planScheduling',
          'supervisorRuntime',
          'improvementRuntime',
          'executionRuntime',
        ],
        properties: {
          status: { type: 'string', enum: ['ok'] },
          service: { type: 'string', enum: ['forgeflow-control-plane'] },
          apiVersion: { type: 'integer', enum: [1] },
          mode: { type: 'string', enum: ['autonomous-engineering'] },
          database: { type: 'string' },
          releaseProvenance: unknownObject,
          autonomousLifecycleAcceptance: unknownObject,
          workspaceStorage: { anyOf: [unknownObject, { type: 'null' }] },
          hostCacheMaintenance: unknownObject,
          planScheduling: unknownObject,
          supervisorRuntime: unknownObject,
          improvementRuntime: unknownObject,
          executionRuntime: unknownObject,
        },
      },
    },
  },
  releaseAcceptanceGetAutonomousLifecycle: {
    response: { 200: unknownObject },
  },
  releaseAcceptanceRecordAutonomousLifecycle: {
    body: releaseAcceptanceBody,
    response: {
      200: releaseAcceptanceResponse,
      201: releaseAcceptanceResponse,
    },
  },
  storageGet: {
    response: {
      200: {
        type: 'object',
        additionalProperties: false,
        required: ['storage', 'hostCacheMaintenance'],
        properties: {
          storage: { anyOf: [unknownObject, { type: 'null' }] },
          hostCacheMaintenance: unknownObject,
        },
      },
    },
  },
  storageReconcile: {
    response: {
      200: {
        type: 'object',
        additionalProperties: false,
        required: ['storage', 'hostCacheMaintenance', 'cleanup'],
        properties: {
          storage: { anyOf: [unknownObject, { type: 'null' }] },
          hostCacheMaintenance: unknownObject,
          cleanup: { anyOf: [unknownObject, { type: 'null' }] },
        },
      },
    },
  },
  supervisorAdmissionGet: {
    response: { 200: admissionProjection(supervisorAdmissionItemSchema) },
  },
  runtimeAdmissionGet: {
    response: { 200: admissionProjection(runtimeAdmissionItemSchema) },
  },
};
