import type { FastifyInstance } from 'fastify';

import { ForgeFlowError } from '../core/domain/errors.js';

export const FORGEFLOW_API_OPERATIONS = Object.freeze([
  { method: 'GET', route: '/api/health', operationId: 'systemHealth' },
  { method: 'GET', route: '/api/v1/executions', operationId: 'executionsList' },
  { method: 'GET', route: '/api/v1/executions/:executionId', operationId: 'executionsGet' },
  { method: 'POST', route: '/api/v1/executions/:executionId/abort-paused-provider', operationId: 'executionsAbortPausedProvider' },
  { method: 'POST', route: '/api/v1/executions/:executionId/adopt-workspace', operationId: 'executionsAdoptWorkspace' },
  { method: 'POST', route: '/api/v1/executions/:executionId/continue', operationId: 'executionsContinue' },
  { method: 'POST', route: '/api/v1/executions/:executionId/provider-cleanup', operationId: 'executionsProviderCleanup' },
  { method: 'POST', route: '/api/v1/executions/:executionId/replace-provider-session', operationId: 'executionsReplaceProviderSession' },
  { method: 'POST', route: '/api/v1/executions/:executionId/run', operationId: 'executionsRun' },
  { method: 'GET', route: '/api/v1/improvements', operationId: 'improvementsList' },
  { method: 'GET', route: '/api/v1/improvements/:candidateId', operationId: 'improvementsGet' },
  { method: 'POST', route: '/api/v1/improvements/:candidateId/adopt', operationId: 'improvementsAdopt' },
  { method: 'POST', route: '/api/v1/improvements/:candidateId/diagnose', operationId: 'improvementsDiagnose' },
  { method: 'POST', route: '/api/v1/improvements/:candidateId/reconcile', operationId: 'improvementsReconcile' },
  { method: 'POST', route: '/api/v1/improvements/:candidateId/reject', operationId: 'improvementsReject' },
  { method: 'POST', route: '/api/v1/improvements/:candidateId/self-canary', operationId: 'improvementsSelfCanary' },
  { method: 'POST', route: '/api/v1/improvements/:candidateId/self-promote', operationId: 'improvementsSelfPromote' },
  { method: 'POST', route: '/api/v1/improvements/cycle', operationId: 'improvementsRunCycle' },
  { method: 'POST', route: '/api/v1/improvements/discover', operationId: 'improvementsDiscover' },
  { method: 'GET', route: '/api/v1/maintenance/programs', operationId: 'maintenanceProgramsList' },
  { method: 'POST', route: '/api/v1/maintenance/programs/:programId/state', operationId: 'maintenanceProgramsSetState' },
  { method: 'GET', route: '/api/v1/plans', operationId: 'plansList' },
  { method: 'POST', route: '/api/v1/plans', operationId: 'plansCreate' },
  { method: 'GET', route: '/api/v1/plans/:planId', operationId: 'plansGet' },
  { method: 'POST', route: '/api/v1/plans/:planId/cancel', operationId: 'plansCancel' },
  { method: 'POST', route: '/api/v1/plans/:planId/cancel-queued', operationId: 'plansCancelQueued' },
  { method: 'POST', route: '/api/v1/plans/:planId/children', operationId: 'plansCreateChild' },
  { method: 'POST', route: '/api/v1/plans/:planId/delivery', operationId: 'plansAttachDelivery' },
  { method: 'POST', route: '/api/v1/plans/:planId/reconcile', operationId: 'plansReconcile' },
  { method: 'POST', route: '/api/v1/plans/:planId/reprioritize', operationId: 'plansReprioritize' },
  { method: 'POST', route: '/api/v1/plans/:planId/run', operationId: 'plansRun' },
  { method: 'GET', route: '/api/v1/projects', operationId: 'projectsList' },
  { method: 'GET', route: '/api/v1/projects/:projectKey', operationId: 'projectsGet' },
  { method: 'GET', route: '/api/v1/projects/:projectKey/plan-queue', operationId: 'projectsGetPlanQueue' },
  { method: 'GET', route: '/api/v1/release-acceptance/autonomous-lifecycle', operationId: 'releaseAcceptanceGetAutonomousLifecycle' },
  { method: 'POST', route: '/api/v1/release-acceptance/autonomous-lifecycle', operationId: 'releaseAcceptanceRecordAutonomousLifecycle' },
  { method: 'GET', route: '/api/v1/resources', operationId: 'resourcesList' },
  { method: 'POST', route: '/api/v1/resources/:resourceId/bindings/:bindingId/state', operationId: 'resourcesSetBindingState' },
  { method: 'POST', route: '/api/v1/resources/:resourceId/state', operationId: 'resourcesSetState' },
  { method: 'GET', route: '/api/v1/runtime-admission', operationId: 'runtimeAdmissionGet' },
  { method: 'GET', route: '/api/v1/storage', operationId: 'storageGet' },
  { method: 'POST', route: '/api/v1/storage/reconcile', operationId: 'storageReconcile' },
  { method: 'GET', route: '/api/v1/supervisor-admission', operationId: 'supervisorAdmissionGet' },
  { method: 'POST', route: '/api/v1/supervisors/:supervisorId/decisions', operationId: 'supervisorsDecide' },
  { method: 'GET', route: '/api/v1/supervisors/:supervisorId/projection', operationId: 'supervisorsGetProjection' },
] as const);

export type ForgeFlowApiOperationId = (typeof FORGEFLOW_API_OPERATIONS)[number]['operationId'];

function normalizeRoute(route: string): string {
  if (route.length > 1 && route.endsWith('/')) return route.slice(0, -1);
  return route;
}

export function openApiPath(route: string): string {
  return normalizeRoute(route).replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

export function operationIdForRoute(method: string, route: string): ForgeFlowApiOperationId | undefined {
  const normalizedMethod = method.toUpperCase();
  const normalizedRoute = normalizeRoute(route);
  return FORGEFLOW_API_OPERATIONS.find(
    (operation) => operation.method === normalizedMethod && operation.route === normalizedRoute,
  )?.operationId;
}

export function registerApiOperationIds(app: FastifyInstance): void {
  app.addHook('onRoute', (options) => {
    if (Array.isArray(options.method)) return;
    const operationId = operationIdForRoute(options.method, options.url);
    if (!operationId) return;
    const existing = options.schema?.operationId;
    if (existing !== undefined && existing !== operationId)
      throw new ForgeFlowError('API_OPERATION_ID_CONFLICT');
    options.schema = { ...(options.schema ?? {}), operationId };
  });
}
