/* eslint-disable */
/**
 * GENERATED FILE — DO NOT EDIT.
 * Source: api/openapi.v1.json
 * Regenerate with: npm run client:generate
 */
import type { operations, paths } from './schema.js';

export const FORGEFLOW_OPERATION_ROUTES = {
  "executionsAbortPausedProvider": { method: "post", path: "/api/v1/executions/{executionId}/abort-paused-provider" },
  "executionsAdoptWorkspace": { method: "post", path: "/api/v1/executions/{executionId}/adopt-workspace" },
  "executionsContinue": { method: "post", path: "/api/v1/executions/{executionId}/continue" },
  "executionsGet": { method: "get", path: "/api/v1/executions/{executionId}" },
  "executionsList": { method: "get", path: "/api/v1/executions" },
  "executionsProviderCleanup": { method: "post", path: "/api/v1/executions/{executionId}/provider-cleanup" },
  "executionsReplaceProviderSession": { method: "post", path: "/api/v1/executions/{executionId}/replace-provider-session" },
  "executionsRun": { method: "post", path: "/api/v1/executions/{executionId}/run" },
  "improvementsAdopt": { method: "post", path: "/api/v1/improvements/{candidateId}/adopt" },
  "improvementsDiagnose": { method: "post", path: "/api/v1/improvements/{candidateId}/diagnose" },
  "improvementsDiscover": { method: "post", path: "/api/v1/improvements/discover" },
  "improvementsGet": { method: "get", path: "/api/v1/improvements/{candidateId}" },
  "improvementsList": { method: "get", path: "/api/v1/improvements" },
  "improvementsReconcile": { method: "post", path: "/api/v1/improvements/{candidateId}/reconcile" },
  "improvementsReject": { method: "post", path: "/api/v1/improvements/{candidateId}/reject" },
  "improvementsRunCycle": { method: "post", path: "/api/v1/improvements/cycle" },
  "improvementsSelfCanary": { method: "post", path: "/api/v1/improvements/{candidateId}/self-canary" },
  "improvementsSelfPromote": { method: "post", path: "/api/v1/improvements/{candidateId}/self-promote" },
  "maintenanceProgramsList": { method: "get", path: "/api/v1/maintenance/programs" },
  "maintenanceProgramsSetState": { method: "post", path: "/api/v1/maintenance/programs/{programId}/state" },
  "plansAttachDelivery": { method: "post", path: "/api/v1/plans/{planId}/delivery" },
  "plansCancel": { method: "post", path: "/api/v1/plans/{planId}/cancel" },
  "plansCancelQueued": { method: "post", path: "/api/v1/plans/{planId}/cancel-queued" },
  "plansCreate": { method: "post", path: "/api/v1/plans" },
  "plansCreateChild": { method: "post", path: "/api/v1/plans/{planId}/children" },
  "plansGet": { method: "get", path: "/api/v1/plans/{planId}" },
  "plansList": { method: "get", path: "/api/v1/plans" },
  "plansReconcile": { method: "post", path: "/api/v1/plans/{planId}/reconcile" },
  "plansReprioritize": { method: "post", path: "/api/v1/plans/{planId}/reprioritize" },
  "plansRun": { method: "post", path: "/api/v1/plans/{planId}/run" },
  "projectsGet": { method: "get", path: "/api/v1/projects/{projectKey}" },
  "projectsGetPlanQueue": { method: "get", path: "/api/v1/projects/{projectKey}/plan-queue" },
  "projectsList": { method: "get", path: "/api/v1/projects" },
  "releaseAcceptanceGetAutonomousLifecycle": { method: "get", path: "/api/v1/release-acceptance/autonomous-lifecycle" },
  "releaseAcceptanceRecordAutonomousLifecycle": { method: "post", path: "/api/v1/release-acceptance/autonomous-lifecycle" },
  "resourcesList": { method: "get", path: "/api/v1/resources" },
  "resourcesSetBindingState": { method: "post", path: "/api/v1/resources/{resourceId}/bindings/{bindingId}/state" },
  "resourcesSetState": { method: "post", path: "/api/v1/resources/{resourceId}/state" },
  "runtimeAdmissionGet": { method: "get", path: "/api/v1/runtime-admission" },
  "storageGet": { method: "get", path: "/api/v1/storage" },
  "storageReconcile": { method: "post", path: "/api/v1/storage/reconcile" },
  "supervisorAdmissionGet": { method: "get", path: "/api/v1/supervisor-admission" },
  "supervisorsDecide": { method: "post", path: "/api/v1/supervisors/{supervisorId}/decisions" },
  "supervisorsGetProjection": { method: "get", path: "/api/v1/supervisors/{supervisorId}/projection" },
  "systemHealth": { method: "get", path: "/api/health" },
} as const satisfies Record<keyof operations, { readonly method: 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch' | 'trace'; readonly path: keyof paths }>;

export type ForgeFlowOperationId = keyof typeof FORGEFLOW_OPERATION_ROUTES;
export type ForgeFlowOperationRoutes = typeof FORGEFLOW_OPERATION_ROUTES;
