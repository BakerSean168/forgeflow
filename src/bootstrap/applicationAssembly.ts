import type { DatabaseSync } from 'node:sqlite';

import { ExecutionApplication } from '../application/executions/index.js';
import { ImprovementApplication } from '../application/improvements/index.js';
import { PlanApplication } from '../application/plans/index.js';
import { ResourceApplication } from '../application/resources/index.js';
import { SupervisorApplication } from '../application/supervisors/index.js';
import { SystemApplication } from '../application/system/index.js';
import { LiteLlmExecutionTelemetry } from '../integrations/resources/index.js';
import { ForgeFlowError } from '../core/domain/errors.js';
import type {
  DeliveryKernel,
  ExecutionKernel,
  PlanKernel,
  RecoveryKernel,
  ReviewKernel,
  WorkGraphKernel,
} from '../core/kernel/index.js';
import type { ProjectPlanQueueRuntime } from '../core/orchestration/projectPlanQueueRuntime.js';
import type { ForgeFlowRepositories } from '../core/persistence/repositories.js';
import { SupervisorActionExecutor, type SupervisorKernelPort } from '../core/supervisor/executor.js';
import type { ProjectRegistry } from '../platform/projects/index.js';
import type { ForgeFlowBootstrapConfig } from './config.js';
import type { ExecutionAutomationRuntime } from './executionRuntime.js';
import type { ImprovementRuntimeAssembly } from './improvementRuntime.js';
import type { SupervisorRuntimeAssembly } from './supervisorRuntime.js';
import type { ReleaseProvenanceProjection } from './systemState.js';
import type { RuntimeAdmissionReconciler } from '../reconcilers/runtimeAdmission.js';
import type { StorageMaintenanceReconciler } from '../reconcilers/storageMaintenance.js';
import type { SupervisorReconciler } from '../reconcilers/supervisor.js';

export interface KernelAssembly {
  plan: PlanKernel;
  graph: WorkGraphKernel;
  execution: ExecutionKernel;
  review: ReviewKernel;
  recovery: RecoveryKernel;
  delivery: DeliveryKernel;
}

export function requireExecutionRuntime(
  automation: ExecutionAutomationRuntime | undefined,
): () => ExecutionAutomationRuntime {
  return () => {
    if (!automation) throw new ForgeFlowError('EXECUTION_RUNTIME_DISABLED');
    return automation;
  };
}

export function buildSupervisorActions(input: {
  repositories: ForgeFlowRepositories;
  kernels: KernelAssembly;
  requireAutomation(): ExecutionAutomationRuntime;
  runtimeAdmission: { request(): Promise<void> };
}): SupervisorActionExecutor {
  const { repositories, kernels, requireAutomation } = input;
  const supervisorKernel: SupervisorKernelPort = {
    createExecution: async (payload, planId) => {
      const runtime = requireAutomation();
      await input.runtimeAdmission.request();
      const item = repositories.plans.getWorkItem(payload.workItemId);
      if (item.planId !== planId) throw new ForgeFlowError('EXECUTION_WORK_ITEM_MISMATCH');
      const result = await runtime.plans.runPlan(planId);
      if (result.workItemId && result.workItemId !== payload.workItemId)
        throw new ForgeFlowError('WORK_ITEM_NOT_RUNNABLE');
      if (!result.executionId) throw new ForgeFlowError(result.code);
      return { code: result.code, linkedExecutionId: result.executionId };
    },
    continueExecution: async (payload) => {
      const result = await requireAutomation().worker.continueExecution(payload.executionId);
      if (result.status === 'FAILED' || result.status === 'SKIPPED')
        throw new ForgeFlowError(result.code);
      return { code: 'CONTINUE_' + result.code, linkedExecutionId: payload.executionId };
    },
    retryExecution: async (payload) => {
      const runtime = requireAutomation();
      const execution = repositories.executions.get(payload.executionId);
      const plan = repositories.plans.getPlan(execution.identity.planId);
      const result =
        plan.status === 'FAILED'
          ? await runtime.plans.reconcilePlan(plan.planId, 'auto')
          : await runtime.plans.runPlan(plan.planId);
      if (!result.executionId) throw new ForgeFlowError(result.code);
      return { code: result.code, linkedExecutionId: result.executionId };
    },
    requestReview: async (payload) => {
      const execution = repositories.executions.get(payload.executionId);
      if (!execution.resultRevision || execution.status !== 'SUCCEEDED')
        throw new ForgeFlowError('REVIEW_EXACT_RESULT_REQUIRED');
      const result = await requireAutomation().plans.runPlan(execution.identity.planId);
      if (!result.executionId) throw new ForgeFlowError(result.code);
      return { code: result.code, linkedExecutionId: result.executionId };
    },
    switchRoute: async (payload) => {
      const execution = repositories.executions.get(payload.executionId);
      const result = await requireAutomation().plans.runPlan(execution.identity.planId);
      if (!result.executionId) throw new ForgeFlowError(result.code);
      return { code: result.code, linkedExecutionId: result.executionId };
    },
    createRepair: async (payload) => {
      const base = repositories.executions.get(payload.baseExecutionId);
      if (!base.resultRevision || base.status !== 'SUCCEEDED')
        throw new ForgeFlowError('REPAIR_EXACT_RESULT_REQUIRED');
      const result = await requireAutomation().plans.runPlan(base.identity.planId);
      if (!result.executionId) throw new ForgeFlowError(result.code);
      return { code: result.code, linkedExecutionId: result.executionId };
    },
    replanRemainder: (payload, planId) => {
      const supervisor = repositories.supervisors.getByPlanId(planId);
      kernels.graph.replanRemainder({
        planId,
        reason: payload.reason,
        observationCursor: supervisor?.observationCursor ?? 0,
        items: payload.workItems,
      });
      return { code: 'REPLAN_ACCEPTED', linkedPlanId: planId };
    },
    createChildPlan: (payload, parentPlanId) => {
      const result = kernels.plan.createChildPlan({
        parentPlanId,
        childPlanId: payload.childPlanId,
        repositoryPath: payload.repositoryPath,
        objective: payload.objective,
        relation: payload.relation,
      });
      return { code: 'CHILD_PLAN_CREATED', linkedPlanId: result.plan.planId };
    },
    pauseForResource: (payload, planId) => {
      kernels.recovery.waitForResource(planId, payload.resourceId);
      return { code: 'RESOURCE_GATE_PARKED' };
    },
    parkExternalGate: (_payload, planId) => {
      const plan = repositories.plans.getPlan(planId);
      if (plan.status !== 'WAITING_FOR_EXTERNAL_EVIDENCE')
        kernels.plan.transition(planId, 'WAITING_FOR_EXTERNAL_EVIDENCE');
      return { code: 'EXTERNAL_GATE_PARKED' };
    },
    escalate: (_payload, planId) => {
      const plan = repositories.plans.getPlan(planId);
      if (plan.status !== 'SAFETY_HOLD') kernels.plan.transition(planId, 'SAFETY_HOLD');
      return { code: 'SAFETY_HOLD_ENTERED' };
    },
  };
  return new SupervisorActionExecutor(
    repositories.actions,
    repositories.decisions,
    supervisorKernel,
    repositories.supervisors,
  );
}

export interface ApplicationAssembly {
  system: SystemApplication;
  resource: ResourceApplication;
  plan: PlanApplication;
  execution: ExecutionApplication;
  supervisor: SupervisorApplication;
  improvement: ImprovementApplication;
}

export function buildApplicationAssembly(input: {
  db: DatabaseSync;
  dbFile: string;
  repositories: ForgeFlowRepositories;
  projects: ProjectRegistry;
  kernels: KernelAssembly;
  projectPlanQueue?: ProjectPlanQueueRuntime;
  automation?: ExecutionAutomationRuntime;
  supervisor: SupervisorRuntimeAssembly;
  supervisorReconciler: SupervisorReconciler;
  supervisorActions: SupervisorActionExecutor;
  improvement: ImprovementRuntimeAssembly;
  runtimeAdmission: RuntimeAdmissionReconciler;
  storage: StorageMaintenanceReconciler;
  config: ForgeFlowBootstrapConfig;
  releaseProvenance(): ReleaseProvenanceProjection;
  autonomousLifecycleAcceptanceProjection(): unknown;
  fetchImpl: typeof fetch;
}): ApplicationAssembly {
  const { repositories, automation, supervisor, improvement, config } = input;
  const requireAutomation = requireExecutionRuntime(automation);
  const executionTelemetry = new LiteLlmExecutionTelemetry({
    baseUrl: config.telemetry.baseUrl,
    envFile: config.telemetry.adminEnvFile,
    keyName: config.telemetry.adminKeyName,
    fetchImpl: input.fetchImpl,
    requestTimeoutMs: config.telemetry.requestTimeoutMs,
  });
  const system = new SystemApplication({
    dbFile: input.dbFile,
    repositories,
    releaseProvenance: input.releaseProvenance,
    autonomousLifecycleAcceptanceProjection: input.autonomousLifecycleAcceptanceProjection,
    workspaceStorage: () => input.storage.workspaceStatus(),
    hostCacheMaintenance: () => input.storage.hostCacheMaintenanceStatus(),
    reconcileWorkspaceStorage: () => input.storage.runMaintenance(),
    singleActivePlanEnabled: config.scheduling.singleActivePlanEnabled,
    literalWorktreesEnabled: config.scheduling.literalWorktreesEnabled,
    projectPlanQueueEnabled: Boolean(input.projectPlanQueue),
    supervisorRuntimeEnabled: supervisor.enabled,
    supervisorResourceSelectorEnabled: supervisor.resourceSelectorEnabled,
    supervisorDirectAdmissionEnabled: supervisor.directAdmissionEnabled,
    supervisorDirectAdmissionHasDemand: supervisor.admissionHasDemand,
    supervisorDirectAdmission: supervisor.directAdmission,
    supervisorMaxResourceAttempts: supervisor.maxResourceAttempts,
    improvementStatus: () => improvement.runtime.status(),
    ...(automation ? { executionRuntime: automation } : {}),
    autonomousPollingEnabled: Boolean(automation && config.automation.enabled),
  });
  const resource = new ResourceApplication({
    repositories,
    requireRuntime: requireAutomation,
    invalidateSupervisorResource: (resourceId) => {
      repositories.supervisorDirectAdmissions.invalidateResource(resourceId);
      supervisor.directAdmission.invalidateResource(resourceId);
    },
    runtimeAdmission: input.runtimeAdmission,
    reconcileSupervisorReadiness: input.supervisorReconciler.reconcileReadiness.bind(input.supervisorReconciler),
  });
  const plan = new PlanApplication({
    repositories,
    planKernel: input.kernels.plan,
    projects: input.projects,
    ...(input.projectPlanQueue ? { projectPlanQueue: input.projectPlanQueue } : {}),
    singleActivePlanEnabled: config.scheduling.singleActivePlanEnabled,
    requireAutomation,
    ...(automation ? { automation } : {}),
    runtimeAdmission: input.runtimeAdmission,
  });
  const execution = new ExecutionApplication({
    repositories,
    telemetry: executionTelemetry,
    requireRuntime: requireAutomation,
    ...(automation ? { runtime: automation } : {}),
  });
  const supervisorApplication = new SupervisorApplication(input.db, input.supervisorActions);
  const improvementApplication = new ImprovementApplication(
    improvement.registry,
    improvement.runtime,
    (planId) => plan.view(planId),
  );

  return {
    system,
    resource,
    plan,
    execution,
    supervisor: supervisorApplication,
    improvement: improvementApplication,
  };
}
