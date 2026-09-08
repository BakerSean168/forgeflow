import fs from 'node:fs';
import path from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';

import { registerOpenApi } from './api/openapi.js';
import { registerApiErrorHandler } from './api/shared/errors.js';
import { registerApiModules } from './api/module.js';
import { createProjectApiModule } from './api/v1/projects.js';
import { createSystemApiModule } from './api/v1/system/index.js';
import { createResourceApiModule } from './api/v1/resources/index.js';
import { createImprovementApiModule } from './api/v1/improvements/index.js';
import { createPlanApiModule } from './api/v1/plans/index.js';
import { createExecutionApiModule } from './api/v1/executions/index.js';
import { createSupervisorApiModule } from './api/v1/supervisors/index.js';
import { SystemApplication } from './application/system/index.js';
import { ResourceApplication } from './application/resources/index.js';
import { ImprovementApplication } from './application/improvements/index.js';
import { PlanApplication } from './application/plans/index.js';
import { ExecutionApplication } from './application/executions/index.js';
import { SupervisorApplication } from './application/supervisors/index.js';

import { buildExecutionAutomation, type ExecutionAutomationRuntime } from './bootstrap/executionRuntime.js';
import { loadBootstrapConfig } from './bootstrap/config.js';
import type { ProjectRegistry } from './platform/projects/index.js';

import { LiteLlmExecutionTelemetry } from './core/adapters/liteLlmTelemetry.js';
import { MaintenanceCandidateRegistry } from './core/adapters/maintenance.js';
import { ResourceSelectedImprovementDiagnosisClient } from './core/adapters/improvementDiagnosis.js';
import { ExactShaSelfChangeCanary } from './core/adapters/selfChangeCanary.js';
import { FileSelfChangePromotionQueue } from './core/adapters/selfChangePromotion.js';
import {
  HttpOpenHandsSupervisorClient,
  OpenHandsSupervisorAdapter,
} from './core/adapters/openhands.js';
import { ForgeFlowError } from './core/domain/errors.js';
import { isTerminalPlanStatus } from './core/domain/plan.js';
import {
  DEFAULT_AFFINITY_POLICY,
  createExecutionResourceSelection,
  type ExecutionResource,
  type ExecutionResourceSelection,
} from './core/domain/resourceRouting.js';
import {
  DeliveryKernel,
  ExecutionKernel,
  PlanKernel,
  RecoveryKernel,
  ReviewKernel,
  WorkGraphKernel,
} from './core/kernel/index.js';
import { MaintenanceImprovementRuntime } from './core/orchestration/maintenanceRuntime.js';
import { ProjectPlanQueueRuntime } from './core/orchestration/projectPlanQueueRuntime.js';
import {
  AUTONOMOUS_ACCEPTANCE_EVENT,
  decodeAutonomousLifecycleAttestation,
  releaseAcceptanceAggregateId,
} from './core/orchestration/releaseAcceptance.js';
import {
  ResourceSelector,
  selectExecutableProfile,
  type ResourceSelectionCandidate,
} from './core/orchestration/resourceSelector.js';
import { bootstrapForgeFlow } from './core/persistence/bootstrap.js';
import { createRepositories, type ForgeFlowRepositories } from './core/persistence/repositories.js';
import { SupervisorActionExecutor, type SupervisorKernelPort } from './core/supervisor/executor.js';
import { ResourceSelectedSupervisorDecisionClient } from './core/supervisor/resourceClient.js';
import { SupervisorDirectAdmissionProbe } from './core/adapters/supervisorDirectAdmission.js';
import {
  SupervisorDirectAdmissionRegistry,
  createSupervisorDirectAdmissionStatus,
  supervisorDirectAdmissionKey,
} from './core/supervisor/admission.js';
import { SupervisorRuntime } from './core/supervisor/runtime.js';
import { SupervisorWakeScheduler } from './core/supervisor/scheduler.js';


export interface BuildControlPlaneOptions {
  env?: NodeJS.ProcessEnv;
  dbFile?: string;
  logger?: boolean;
  environment?: 'test' | 'development' | 'staging' | 'production';
  allowDataReset?: boolean;
  fetchImpl?: typeof fetch;
}

export interface ControlPlaneRuntime {
  app: FastifyInstance;
  db: ReturnType<typeof bootstrapForgeFlow>['db'];
  dbFile: string;
  host: string;
  port: number;
  repositories: ForgeFlowRepositories;
  projects: ProjectRegistry;
  kernels: {
    plan: PlanKernel;
    graph: WorkGraphKernel;
    execution: ExecutionKernel;
    review: ReviewKernel;
    recovery: RecoveryKernel;
    delivery: DeliveryKernel;
  };
  supervisor: {
    actions: SupervisorActionExecutor;
    openHands: OpenHandsSupervisorAdapter;
    scheduler: SupervisorWakeScheduler;
    runtime: SupervisorRuntime;
    directAdmission: SupervisorDirectAdmissionRegistry;
    reconcileDirectAdmission: () => Promise<void>;
    reconcileReadiness: () => Promise<{ becameAvailable: string[]; scheduledWakes: number }>;
  };
  automation?: ExecutionAutomationRuntime;
  improvements: MaintenanceImprovementRuntime;
  projectPlanQueue?: ProjectPlanQueueRuntime;
  singleActivePlanEnabled: boolean;
  literalWorktreesEnabled: boolean;
}

type ReleaseProvenanceProjection =
  | { status: 'MISSING' | 'INVALID' | 'MISMATCH' }
  | {
      status: 'PENDING' | 'HEALTHY';
      version: 1;
      sourceSha: string;
      artifactSha256: string;
      releasedAt: string;
    };

function readReleaseProvenance(file: string): ReleaseProvenanceProjection {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024)
      return { status: 'INVALID' };
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (
      value.version !== 1 ||
      (value.status !== 'PENDING' && value.status !== 'HEALTHY') ||
      typeof value.sourceSha !== 'string' ||
      !/^[0-9a-f]{40}$/.test(value.sourceSha) ||
      typeof value.artifactSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.artifactSha256) ||
      typeof value.releasedAt !== 'string' ||
      value.releasedAt.length > 64 ||
      !Number.isFinite(Date.parse(value.releasedAt))
    )
      return { status: 'INVALID' };
    return {
      status: value.status,
      version: 1,
      sourceSha: value.sourceSha,
      artifactSha256: value.artifactSha256,
      releasedAt: value.releasedAt,
    };
  } catch {
    return fs.existsSync(file) ? { status: 'INVALID' } : { status: 'MISSING' };
  }
}

function bindReleaseProvenance(file: string): () => ReleaseProvenanceProjection {
  const boot = readReleaseProvenance(file);
  const valid = (value: ReleaseProvenanceProjection): value is Extract<
    ReleaseProvenanceProjection,
    { status: 'PENDING' | 'HEALTHY' }
  > => value.status === 'PENDING' || value.status === 'HEALTHY';
  return () => {
    const current = readReleaseProvenance(file);
    if (valid(boot) && valid(current)) {
      if (
        boot.sourceSha === current.sourceSha &&
        boot.artifactSha256 === current.artifactSha256 &&
        boot.releasedAt === current.releasedAt
      )
        return current;
      return { status: 'MISMATCH' };
    }
    if (!valid(boot) && !valid(current) && boot.status === current.status) return current;
    return { status: 'MISMATCH' };
  };
}

type HostCacheMaintenanceProjection =
  | { status: 'DISABLED' | 'MISSING' | 'INVALID' }
  | {
      status: 'AVAILABLE';
      version: 1;
      checkedAt: string;
      action: string;
      reason: string;
      freeBytesBefore: number;
      freeBytesAfter: number;
      activeExecutions: number;
      triggerFreeBytes: number;
      targetFreeBytes: number;
      steps: string[];
    };

const HOST_CACHE_ACTIONS = new Set([
  'NOOP_CAPACITY_OK',
  'SKIPPED_RELEASE_ACTIVE',
  'SKIPPED_CONTROL_PLANE_UNAVAILABLE',
  'SKIPPED_ACTIVE_EXECUTION',
  'PRUNE_FAILED',
  'PRUNED_TARGET_REACHED',
  'PRUNED_PARTIAL',
  'CAPACITY_STILL_LOW',
]);
const HOST_CACHE_STEPS = new Set([
  'BUILDER_CACHE_OLDER_THAN_POLICY',
  'ALL_UNUSED_BUILDER_CACHE',
  'DANGLING_IMAGES',
  'OLD_UNUSED_IMAGES',
]);

const HOST_CACHE_REASONS = new Set([
  'FREE_SPACE_ABOVE_TRIGGER',
  'RELEASE_LOCK_HELD',
  'ACTIVE_EXECUTION_STATE_UNAVAILABLE',
  'FORGEFLOW_EXECUTION_RUNNING',
  'SAFE_RECLAIM_COMPLETED',
  'ABOVE_TRIGGER_BELOW_TARGET',
  'SAFE_RECLAIM_EXHAUSTED',
  ...HOST_CACHE_STEPS,
]);

function readHostCacheMaintenance(file: string | undefined): HostCacheMaintenanceProjection {
  if (!file) return { status: 'DISABLED' };
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024)
      return { status: 'INVALID' };
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const numeric = [
      'freeBytesBefore',
      'freeBytesAfter',
      'activeExecutions',
      'triggerFreeBytes',
      'targetFreeBytes',
    ] as const;
    if (
      value.version !== 1 ||
      typeof value.checkedAt !== 'string' ||
      value.checkedAt.length > 64 ||
      !Number.isFinite(Date.parse(value.checkedAt)) ||
      typeof value.action !== 'string' ||
      !HOST_CACHE_ACTIONS.has(value.action) ||
      typeof value.reason !== 'string' ||
      !HOST_CACHE_REASONS.has(value.reason) ||
      !Array.isArray(value.steps) ||
      value.steps.some((item) => typeof item !== 'string' || !HOST_CACHE_STEPS.has(item)) ||
      numeric.some(
        (key) =>
          typeof value[key] !== 'number' ||
          !Number.isSafeInteger(value[key]) ||
          (value[key] as number) < 0,
      )
    )
      return { status: 'INVALID' };
    return {
      status: 'AVAILABLE',
      version: 1,
      checkedAt: value.checkedAt,
      action: value.action,
      reason: value.reason,
      freeBytesBefore: value.freeBytesBefore as number,
      freeBytesAfter: value.freeBytesAfter as number,
      activeExecutions: value.activeExecutions as number,
      triggerFreeBytes: value.triggerFreeBytes as number,
      targetFreeBytes: value.targetFreeBytes as number,
      steps: value.steps as string[],
    };
  } catch {
    return fs.existsSync(file) ? { status: 'INVALID' } : { status: 'MISSING' };
  }
}

export async function buildControlPlane(
  options: BuildControlPlaneOptions = {},
): Promise<ControlPlaneRuntime> {
  const { config, projects } = loadBootstrapConfig(options.env, {
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.dbFile ? { dbFile: options.dbFile } : {}),
    ...(options.allowDataReset === undefined ? {} : { allowDataReset: options.allowDataReset }),
  });
  const allowedRepositoryRoots = config.repositories.allowedRoots;
  const selfChangeEnabled = config.improvement.selfChangeEnabled;
  const selfPromotionEnabled = config.improvement.selfPromotionEnabled;
  const selfAutoPromotionEnabled = config.improvement.selfAutoPromotionEnabled;
  const improvementAiDiagnosisEnabled = config.improvement.aiDiagnosisEnabled;
  const improvementProjectKeys = projects.improvementProjectKeys();
  if (improvementAiDiagnosisEnabled && improvementProjectKeys.length === 0)
    throw new ForgeFlowError('IMPROVEMENT_AI_DIAGNOSIS_PROJECTS_REQUIRED');
  if (
    improvementAiDiagnosisEnabled &&
    !config.execution.enabled
  )
    throw new ForgeFlowError('IMPROVEMENT_AI_DIAGNOSIS_EXECUTION_RUNTIME_REQUIRED');
  if (
    improvementAiDiagnosisEnabled &&
    !config.execution.resourceSelectorEnabled
  )
    throw new ForgeFlowError('IMPROVEMENT_AI_DIAGNOSIS_RESOURCE_SELECTOR_REQUIRED');
  if (selfPromotionEnabled && !selfChangeEnabled)
    throw new ForgeFlowError('IMPROVEMENT_SELF_PROMOTION_REQUIRES_SELF_CHANGE');
  if (selfAutoPromotionEnabled && !selfPromotionEnabled)
    throw new ForgeFlowError('IMPROVEMENT_SELF_AUTO_PROMOTION_REQUIRES_PROMOTION');
  const selfRepositoryPath = config.improvement.selfRepositoryPath;
  const selfPromotionRequestFile = config.improvement.selfPromotionRequestFile;
  if (
    selfPromotionEnabled &&
    config.environment === 'production' &&
    path.resolve(selfPromotionRequestFile) !== '/var/lib/forgeflow/self-promotion-request.json'
  )
    throw new ForgeFlowError('IMPROVEMENT_SELF_PROMOTION_REQUEST_PATH_UNSUPPORTED');
  const releaseProvenance = bindReleaseProvenance(
    config.release.provenanceFile,
  );
  const boot = bootstrapForgeFlow({
    ...(config.database.file ? { dbFile: config.database.file } : {}),
    env: {},
    environment: config.environment,
    allowDataReset: config.database.allowDataReset,
  });
  const db = boot.db;
  const repositories = createRepositories(db);
  const singleActivePlanEnabled = config.scheduling.singleActivePlanEnabled;
  const literalWorktreesEnabled = config.scheduling.literalWorktreesEnabled;
  if (literalWorktreesEnabled && !singleActivePlanEnabled)
    throw new ForgeFlowError('LITERAL_WORKTREES_REQUIRE_SINGLE_ACTIVE_PLAN');
  const projectPlanQueue = singleActivePlanEnabled
    ? new ProjectPlanQueueRuntime(repositories)
    : undefined;
  const autonomousLifecycleAcceptanceProjection = () => {
    const release = releaseProvenance();
    if (release.status !== 'HEALTHY')
      return { status: 'UNAVAILABLE' as const, releaseStatus: release.status };
    const aggregateId = releaseAcceptanceAggregateId(release.sourceSha);
    const candidates = repositories.events
      .listRecentByAggregate(aggregateId, 100)
      .filter((event) => event.type === AUTONOMOUS_ACCEPTANCE_EVENT)
      .reverse();
    for (const event of candidates) {
      try {
        const attestation = decodeAutonomousLifecycleAttestation(event.payload);
        if (attestation.artifactSha256 !== release.artifactSha256) continue;
        return {
          status: 'ATTESTED' as const,
          sourceSha: attestation.sourceSha,
          artifactSha256: attestation.artifactSha256,
          planId: attestation.planId,
          projectKey: attestation.projectKey,
          finalRevision: attestation.finalRevision,
          attestedAt: event.occurredAt,
        };
      } catch {
        return {
          status: 'INVALID' as const,
          sourceSha: release.sourceSha,
          artifactSha256: release.artifactSha256,
        };
      }
    }
    return {
      status: 'MISSING' as const,
      sourceSha: release.sourceSha,
      artifactSha256: release.artifactSha256,
    };
  };

  const executionTelemetry = new LiteLlmExecutionTelemetry({
    baseUrl: config.telemetry.baseUrl,
    envFile: config.telemetry.adminEnvFile,
    keyName: config.telemetry.adminKeyName,
    fetchImpl: options.fetchImpl ?? fetch,
    requestTimeoutMs: config.telemetry.requestTimeoutMs,
  });
  const kernels = {
    plan: new PlanKernel(repositories),
    graph: new WorkGraphKernel(repositories),
    execution: new ExecutionKernel(repositories),
    review: new ReviewKernel(repositories),
    recovery: new RecoveryKernel(repositories),
    delivery: new DeliveryKernel(),
  };
  const improvementRegistry = new MaintenanceCandidateRegistry(db);
  const selfCanary = selfChangeEnabled
    ? new ExactShaSelfChangeCanary({
        repositoryPath: selfRepositoryPath,
        worktreeRoot:
          config.improvement.selfCanaryRoot,
        commandTimeoutMs: config.improvement.selfCanaryTimeoutMs,
      })
    : undefined;
  const selfPromotionQueue = selfPromotionEnabled
    ? new FileSelfChangePromotionQueue(selfPromotionRequestFile)
    : undefined;
  const improvements = new MaintenanceImprovementRuntime(
    db,
    improvementRegistry,
    repositories,
    kernels.plan,
    projectPlanQueue,
    {
      discoveryEnabled: config.improvement.discoveryEnabled,
      adoptionEnabled: config.improvement.adoptionEnabled,
      autoAdoptLowRisk: config.improvement.autoAdoptLowRisk,
      allowedProjectKeys: improvementProjectKeys,
      selfChangeEnabled,
      selfPromotionEnabled,
      selfAutoPromotionEnabled,
      aiDiagnosisEnabled: improvementAiDiagnosisEnabled,
      aiDiagnosisMaxPerCycle: config.improvement.aiDiagnosisMaxPerCycle,
      selfProjectKey: config.improvement.selfProjectKey,
      selfRepositoryPath,
    },
    selfCanary,
    selfPromotionQueue,
    releaseProvenance,
  );
  const automation = await buildExecutionAutomation(
    config.execution,
    repositories,
    options.fetchImpl ?? fetch,
    projects,
  );
  if (projectPlanQueue && automation) {
    projectPlanQueue.setExecutionCancellation({
      cancelExecution: async (executionId, idempotencyKey, reason) =>
        await automation.worker.cancelExecution(executionId, idempotencyKey, reason),
      cleanupProviderSession: async (executionId, idempotencyKey, reason) =>
        await automation.worker.cleanupProviderSession(executionId, idempotencyKey, reason),
    });
  }
  if (projectPlanQueue) {
    projectPlanQueue.bootstrapExistingRootPlans();
    if (automation?.planWorktreeManager) {
      const literalProjects = new Set(automation.literalWorktreeProjectKeys);
      projectPlanQueue.setLifecycle({
        activate: async (rootPlanId) => {
          const plan = repositories.plans.getPlan(rootPlanId);
          if (literalProjects.has(plan.projectKey))
            await automation.planWorktreeManager!.ensurePlanActivated(rootPlanId);
        },
        retire: async (rootPlanId) => {
          const plan = repositories.plans.getPlan(rootPlanId);
          if (literalProjects.has(plan.projectKey)) {
            if (automation.workspace.preparePlanRetirement)
              await automation.workspace.preparePlanRetirement(rootPlanId);
            await automation.planWorktreeManager!.retirePlan(rootPlanId, automation.workspaceUid);
          }
        },
      });
      for (const lease of repositories.projectPlans.listLeases()) {
        if (!lease.activeRootPlanId) continue;
        const plan = repositories.plans.getPlan(lease.activeRootPlanId);
        if (
          literalProjects.has(plan.projectKey) &&
          plan.status !== 'SAFETY_HOLD' &&
          !isTerminalPlanStatus(plan.status)
        )
          await automation.planWorktreeManager.ensurePlanActivated(lease.activeRootPlanId);
      }
    }
  }
  const requireAutomation = (): ExecutionAutomationRuntime => {
    if (!automation) throw new ForgeFlowError('EXECUTION_RUNTIME_DISABLED');
    return automation;
  };
  const requireProjectPlanQueue = (): ProjectPlanQueueRuntime => {
    if (!projectPlanQueue) throw new ForgeFlowError('PROJECT_PLAN_QUEUE_DISABLED');
    return projectPlanQueue;
  };
  const supervisorKernel: SupervisorKernelPort = {
    createExecution: async (payload, planId) => {
      const runtime = requireAutomation();
      await runtime.reconcileRuntimeAdmission();
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
      if (result.status === 'FAILED' || result.status === 'SKIPPED') throw new ForgeFlowError(result.code);
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
  const supervisorActions = new SupervisorActionExecutor(
    repositories.actions,
    repositories.decisions,
    supervisorKernel,
    repositories.supervisors,
  );
  const openHands = new OpenHandsSupervisorAdapter(
    config.supervisor.openHandsUrl
      ? new HttpOpenHandsSupervisorClient(
          config.supervisor.openHandsUrl,
          config.supervisor.openHandsToken,
        )
      : undefined,
  );
  const scheduler = new SupervisorWakeScheduler(repositories.supervisors, db);
  const supervisorRuntimeEnabled = config.supervisor.enabled;
  const supervisorMaxResourceAttempts = config.supervisor.maxResourceAttempts;
  if (
    supervisorRuntimeEnabled &&
    config.supervisor.hasRetiredStaticRoute
  )
    throw new ForgeFlowError('SUPERVISOR_STATIC_ROUTE_UNSUPPORTED');
  if (supervisorRuntimeEnabled && !automation?.resourceSelectorEnabled)
    throw new ForgeFlowError('SUPERVISOR_RESOURCE_SELECTOR_REQUIRED');
  const supervisorDirectAdmission = new SupervisorDirectAdmissionRegistry();
  const supervisorDirectAdmissionEnabled =
    (supervisorRuntimeEnabled || improvementAiDiagnosisEnabled) &&
    Boolean(automation?.resourceSelectorEnabled);
  if (supervisorDirectAdmissionEnabled)
    supervisorDirectAdmission.restore(repositories.supervisorDirectAdmissions.list());
  const supervisorDirectAdmissionReadyTtlMs = config.supervisor.admissionReadyTtlMs;
  const supervisorDirectAdmissionFailureTtlMs = config.supervisor.admissionFailureTtlMs;
  const supervisorDirectAdmissionProbe = supervisorDirectAdmissionEnabled
    ? new SupervisorDirectAdmissionProbe({
        baseUrl: config.supervisor.directAdmission.baseUrl,
        bearerToken: config.supervisor.directAdmission.apiKey,
        fetchImpl: options.fetchImpl ?? fetch,
        timeoutMs: config.supervisor.directAdmission.timeoutMs,
      })
    : undefined;
  const supervisorAdmissionCandidates = (): ResourceSelectionCandidate[] => {
    if (!automation?.resourceSelectorEnabled) return [];
    const values = new Map<string, ResourceSelectionCandidate>();
    const priorAttempts: Array<{ resourceId: string; bindingId?: string; modelFamily?: string }> = [];
    for (let index = 0; index < 100; index += 1) {
      const selected = selectExecutableProfile(automation.resources, {
        phase: 'SUPERVISE',
        includeProviderNativeProfiles: false,
        policy: {
          allowProviderNative: false,
          allowedTransports: ['LITELLM_MANAGED'],
          isAllowed: (candidate) => Boolean(candidate.profile.routeModel),
        },
        priorAttempts,
      });
      if (selected.status !== 'SELECTED') break;
      values.set(supervisorDirectAdmissionKey(selected.candidate), selected.candidate);
      priorAttempts.push({
        resourceId: selected.profile.resourceId,
        ...(selected.profile.bindingId ? { bindingId: selected.profile.bindingId } : {}),
        modelFamily: selected.profile.modelFamily,
      });
    }
    return [...values.values()];
  };
  const directReasoningAdmissionHasDemand = (): boolean =>
    repositories.supervisors.hasNonTerminal() || improvements.hasDiagnosisDemand();
  let supervisorDirectAdmissionCycle: Promise<void> | undefined;
  const reconcileSupervisorDirectAdmission = async (): Promise<void> => {
    if (!supervisorDirectAdmissionEnabled || !supervisorDirectAdmissionProbe) return;
    if (!directReasoningAdmissionHasDemand()) return;
    if (supervisorDirectAdmissionCycle) return await supervisorDirectAdmissionCycle;
    supervisorDirectAdmissionCycle = (async () => {
      const candidates = supervisorAdmissionCandidates();
      const admissionKeys = candidates.map(supervisorDirectAdmissionKey);
      repositories.supervisorDirectAdmissions.retain(admissionKeys);
      supervisorDirectAdmission.retain(candidates);
      const now = Date.now();
      for (const candidate of candidates) {
        if (
          !supervisorDirectAdmission.isStale(
            candidate,
            now,
            supervisorDirectAdmissionReadyTtlMs,
            supervisorDirectAdmissionFailureTtlMs,
          )
        )
          continue;
        const result = await supervisorDirectAdmissionProbe.probe(candidate);
        const status = createSupervisorDirectAdmissionStatus(candidate, result);
        const persisted = repositories.supervisorDirectAdmissions.record(status);
        if (!persisted.value || persisted.status === 'rejected')
          throw new ForgeFlowError(persisted.reason ?? 'SUPERVISOR_ADMISSION_PERSIST_FAILED');
        supervisorDirectAdmission.restore([persisted.value]);
      }
    })();
    try {
      await supervisorDirectAdmissionCycle;
    } finally {
      supervisorDirectAdmissionCycle = undefined;
    }
  };
  const reasoningResourceSelector = supervisorDirectAdmissionEnabled
    ? new ResourceSelector(
        automation!.resources,
        DEFAULT_AFFINITY_POLICY,
        supervisorDirectAdmission,
      )
    : undefined;
  const supervisorResourceSelector = supervisorRuntimeEnabled ? reasoningResourceSelector : undefined;
  if (improvementAiDiagnosisEnabled) {
    improvements.configureDiagnosisClient(
      new ResourceSelectedImprovementDiagnosisClient(
        reasoningResourceSelector!,
        config.improvement.diagnosis.baseUrl,
        config.improvement.diagnosis.apiKey,
        repositories.events,
        automation!.resourceState,
        options.fetchImpl ?? fetch,
        config.improvement.diagnosis.timeoutMs,
        config.improvement.diagnosis.maxResourceAttempts,
        reconcileSupervisorDirectAdmission,
      ),
    );
  }
  const modelClient = supervisorRuntimeEnabled
    ? new ResourceSelectedSupervisorDecisionClient(
        supervisorResourceSelector!,
        config.supervisor.reasoning.baseUrl,
        config.supervisor.reasoning.apiKey,
        repositories.events,
        automation!.resourceState,
        options.fetchImpl ?? fetch,
        config.supervisor.reasoning.timeoutMs,
        supervisorMaxResourceAttempts,
      )
    : undefined;
  const supervisorRuntime = new SupervisorRuntime(
    db,
    repositories.supervisors,
    scheduler,
    openHands,
    supervisorActions,
    modelClient,
  );
  const app = Fastify({ logger: options.logger ?? true });
  registerApiErrorHandler(app);
  await registerOpenApi(app);
  const availableSupervisorResourceIds = (): string[] =>
    automation
      ? automation.resources
          .listResources()
          .filter(
            (resource) =>
              selectExecutableProfile(
                [resource],
                {
                  phase: 'SUPERVISE',
                  includeProviderNativeProfiles: false,
                  policy: {
                    allowProviderNative: false,
                    allowedTransports: ['LITELLM_MANAGED'],
                    isAllowed: (candidate) => Boolean(candidate.profile.routeModel),
                  },
                },
                DEFAULT_AFFINITY_POLICY,
                supervisorDirectAdmission,
              ).status === 'SELECTED',
          )
          .map((resource) => resource.resourceId)
          .sort()
      : [];
  let lastAvailableSupervisorResourceIds = new Set<string>();
  const reconcileSupervisorResourceAvailability = () => {
    const current = new Set(availableSupervisorResourceIds());
    const becameAvailable = [...current].filter(
      (resourceId) => !lastAvailableSupervisorResourceIds.has(resourceId),
    );
    lastAvailableSupervisorResourceIds = current;
    if (becameAvailable.length === 0) return { becameAvailable, scheduledWakes: 0 };
    if (repositories.supervisors.listByStatus('WAITING_FOR_RESOURCE').length === 0)
      return { becameAvailable, scheduledWakes: 0 };
    repositories.events.appendNew({
      aggregateId: 'supervisor-resource-availability',
      aggregateType: 'RESOURCE',
      type: 'SUPERVISOR_RESOURCE_AVAILABILITY_CHANGED',
      payload: { becameAvailable: [...becameAvailable].sort() },
      occurredAt: new Date().toISOString(),
      correlationId: 'supervisor-resource-availability',
    });
    const wakes = scheduler.scheduleWaitingForResource();
    return { becameAvailable, scheduledWakes: wakes.length };
  };
  const reconcileSupervisorReadiness = async () => {
    await reconcileSupervisorDirectAdmission();
    return reconcileSupervisorResourceAvailability();
  };
  const durableSupervisorAdmissionSummary = () => {
    const items = repositories.supervisorDirectAdmissions.list();
    return {
      checked: items.length,
      ready: items.filter((item) => item.ready).length,
      unready: items.filter((item) => !item.ready).length,
    };
  };
  const projectSupervisorAdmission = (item: {
    resourceId: string;
    bindingId: string;
    modelFamily: string;
    routeModel: string;
    protocol: string;
    ready: boolean;
    checkedAt: string;
    errorCode?: string;
  }) => ({
    resourceId: item.resourceId,
    bindingId: item.bindingId,
    modelFamily: item.modelFamily,
    routeModel: item.routeModel,
    protocol: item.protocol,
    ready: item.ready,
    checkedAt: item.checkedAt,
    errorCode: item.errorCode ?? null,
  });
  const workspaceStorage = () => automation?.workspace.storageStatus?.() ?? null;
  const hostCacheMaintenance = () =>
    readHostCacheMaintenance(config.release.hostCacheStateFile);
  const runWorkspaceStorageMaintenance = async () => {
    if (!automation?.workspace.storageStatus || !automation.workspace.pruneTerminalCaches)
      return null;
    const before = automation.workspace.storageStatus();
    if (!before.lowCapacity) return null;
    const terminal = repositories.executions.listByStatuses(
      ['SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED'],
      1000,
    );
    const workspaces = terminal
      .map(
        (execution) => repositories.sessions.getOptional(execution.identity.executionId)?.workspace,
      )
      .filter((workspace): workspace is NonNullable<typeof workspace> => Boolean(workspace));
    const result = await automation.workspace.pruneTerminalCaches(workspaces);
    app.log.warn(
      {
        ...result,
        minimumFreeBytes: before.minimumFreeBytes,
        terminalExecutions: terminal.length,
      },
      'workspace storage high-watermark cleanup',
    );
    return result;
  };

  const systemApplication = new SystemApplication({
    dbFile: boot.dbFile,
    repositories,
    releaseProvenance,
    autonomousLifecycleAcceptanceProjection,
    workspaceStorage,
    hostCacheMaintenance,
    reconcileWorkspaceStorage: runWorkspaceStorageMaintenance,
    singleActivePlanEnabled,
    literalWorktreesEnabled,
    projectPlanQueueEnabled: Boolean(projectPlanQueue),
    supervisorRuntimeEnabled,
    supervisorResourceSelectorEnabled: Boolean(modelClient),
    supervisorDirectAdmissionEnabled,
    supervisorDirectAdmissionHasDemand: directReasoningAdmissionHasDemand,
    supervisorDirectAdmission,
    supervisorMaxResourceAttempts,
    improvementStatus: () => improvements.status(),
    ...(automation ? { executionRuntime: automation } : {}),
    autonomousPollingEnabled: Boolean(
      automation && config.automation.enabled,
    ),
  });


  const resourceApplication = new ResourceApplication({
    repositories,
    requireRuntime: requireAutomation,
    invalidateSupervisorResource: (resourceId) => {
      repositories.supervisorDirectAdmissions.invalidateResource(resourceId);
      supervisorDirectAdmission.invalidateResource(resourceId);
    },
    reconcileSupervisorReadiness,
  });


  const planApplication = new PlanApplication({
    repositories,
    planKernel: kernels.plan,
    projects,
    ...(projectPlanQueue ? { projectPlanQueue } : {}),
    singleActivePlanEnabled,
    requireAutomation,
    ...(automation ? { automation } : {}),
  });

  const executionApplication = new ExecutionApplication({
    repositories,
    telemetry: executionTelemetry,
    requireRuntime: requireAutomation,
    ...(automation ? { runtime: automation } : {}),
  });

  const supervisorApplication = new SupervisorApplication(db, supervisorActions);

  const improvementApplication = new ImprovementApplication(
    improvementRegistry,
    improvements,
    (planId) => planApplication.view(planId),
  );


  await registerApiModules(app, [
    createSystemApiModule(systemApplication),
    createProjectApiModule(projects),
    createResourceApiModule(resourceApplication),
    createImprovementApiModule(improvementApplication),
    createPlanApiModule(planApplication),
    createExecutionApiModule(executionApplication),
    createSupervisorApiModule(supervisorApplication),
  ]);

  const supervisorInterval = supervisorRuntimeEnabled
    ? setInterval(
          () => {
            void reconcileSupervisorReadiness()
              .then((resourceWake) => {
                if (resourceWake.scheduledWakes > 0)
                  app.log.info(resourceWake, 'Supervisor admission woke waiting supervisors');
                return supervisorRuntime.runOnce();
              })
              .then((results) => {
                for (const result of results)
                  if (result.status !== 'SKIPPED')
                    app.log.info(
                      {
                        supervisorId: result.supervisorId,
                        status: result.status,
                        code: result.code,
                      },
                      'supervisor runtime cycle',
                    );
              })
              .catch((error) =>
                app.log.error(
                  { error: error instanceof Error ? error.message : String(error) },
                  'supervisor runtime cycle failed',
                ),
              );
          },
          config.supervisor.pollMs,
        )
      : undefined;

  if (supervisorDirectAdmissionEnabled) {
    setImmediate(() => {
      void reconcileSupervisorReadiness()
        .then((resourceWake) => {
          if (resourceWake.scheduledWakes > 0)
            app.log.info(resourceWake, 'Supervisor admission warmup woke waiting supervisors');
        })
        .catch((error) =>
          app.log.error(
            { error: error instanceof Error ? error.message : String(error) },
            'Supervisor direct admission warmup failed',
          ),
        );
    });
  }

  if (automation?.runtimeAdmissionEnabled) {
    setImmediate(() => {
      void automation
        .reconcileRuntimeAdmission()
        .catch((error) =>
          app.log.error(
            { error: error instanceof Error ? error.message : String(error) },
            'runtime admission warmup failed',
          ),
        );
    });
  }

  let resourceCycleRunning = false;
  const resourceInterval = automation?.resourceSelectorEnabled
    ? setInterval(
        () => {
          if (resourceCycleRunning) return;
          resourceCycleRunning = true;
          void automation.liteLlmResources
            .refresh()
            .then(() => automation.resourceLifecycle.reconcileOnce())
            .then(() => reconcileSupervisorReadiness())
            .then((resourceWake) => {
              if (resourceWake.scheduledWakes > 0)
                app.log.info(resourceWake, 'resource availability woke waiting supervisors');
            })
            .then(() => automation.reconcileRuntimeAdmission())
            .catch((error) =>
              app.log.error(
                { error: error instanceof Error ? error.message : String(error) },
                'resource directory cycle failed',
              ),
            )
            .finally(() => {
              resourceCycleRunning = false;
            });
        },
        config.automation.resourceRefreshMs,
      )
    : undefined;

  const improvementRuntimeEnabled =
    config.improvement.discoveryEnabled ||
    config.improvement.adoptionEnabled ||
    improvementAiDiagnosisEnabled ||
    selfPromotionEnabled;
  let improvementCycleRunning = false;
  const runImprovementCycle = () => {
    if (improvementCycleRunning) return;
    improvementCycleRunning = true;
    void improvements
      .runAutonomousCycle()
      .then((result) => {
        if (
          result.programs.length > 0 ||
          result.reconciledCandidateIds.length > 0 ||
          result.diagnosis.diagnosedCandidateIds.length > 0 ||
          result.diagnosis.adoptedPlanIds.length > 0 ||
          result.diagnosis.errors.length > 0 ||
          result.selfPromotion.requestedCandidateIds.length > 0 ||
          result.selfPromotion.errors.length > 0
        )
          app.log.info(
            {
              reconciledCandidates: result.reconciledCandidateIds.length,
              programs: result.programs.map((program) => ({
                programId: program.programId,
                projectKey: program.projectKey,
                discovered: program.discovered,
                created: program.created,
                adoptedPlans: program.adoptedPlanIds.length,
                errors: program.errors,
              })),
              diagnosis: result.diagnosis,
              selfPromotion: result.selfPromotion,
            },
            'improvement cycle',
          );
      })
      .catch((error) =>
        app.log.error(
          { error: error instanceof Error ? error.message : String(error) },
          'improvement cycle failed',
        ),
      )
      .finally(() => {
        improvementCycleRunning = false;
      });
  };
  if (improvementRuntimeEnabled) setImmediate(runImprovementCycle);
  const improvementInterval = improvementRuntimeEnabled
    ? setInterval(
        runImprovementCycle,
        config.improvement.cycleMs,
      )
    : undefined;

  let automationCycleRunning = false;
  const automationInterval =
    automation && config.automation.enabled
      ? setInterval(
          () => {
            if (automationCycleRunning) return;
            automationCycleRunning = true;
            void runWorkspaceStorageMaintenance()
              .then(async () => {
                if (projectPlanQueue) await projectPlanQueue.reconcile();
                const results = await automation.plans.runOnce();
                // Runtime admission is a readiness refresh, not part of the active-execution
                // heartbeat path. Its own single-flight serializes provider probes; keeping it
                // detached here prevents a slow or unhealthy standby route from starving
                // RUNNING execution inspection and stall recovery.
                void automation.reconcileRuntimeAdmission().catch((error) =>
                  app.log.error(
                    { error: error instanceof Error ? error.message : String(error) },
                    'runtime admission cycle failed',
                  ),
                );
                return results;
              })
              .then((results) => {
                for (const result of results)
                  if (result.status !== 'SKIPPED')
                    app.log.info(
                      {
                        planId: result.planId,
                        workItemId: result.workItemId,
                        executionId: result.executionId,
                        status: result.status,
                        code: result.code,
                      },
                      'plan automation cycle',
                    );
              })
              .catch((error) =>
                app.log.error(
                  { error: error instanceof Error ? error.message : String(error) },
                  'plan automation cycle failed',
                ),
              )
              .finally(() => {
                automationCycleRunning = false;
              });
          },
          config.automation.pollMs,
        )
      : undefined;

  app.addHook('onClose', async () => {
    if (supervisorInterval) clearInterval(supervisorInterval);
    if (resourceInterval) clearInterval(resourceInterval);
    if (improvementInterval) clearInterval(improvementInterval);
    if (automationInterval) clearInterval(automationInterval);
    if (automation) {
      try {
        await automation.shutdownRuntimeAdmission();
      } catch (error) {
        app.log.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'runtime admission shutdown drain failed',
        );
      }
    }
    db.close();
  });

  const { host, port } = config.server;
  return {
    app,
    db,
    dbFile: boot.dbFile,
    host,
    port,
    repositories,
    projects,
    kernels,
    supervisor: {
      actions: supervisorActions,
      openHands,
      scheduler,
      runtime: supervisorRuntime,
      directAdmission: supervisorDirectAdmission,
      reconcileDirectAdmission: reconcileSupervisorDirectAdmission,
      reconcileReadiness: reconcileSupervisorReadiness,
    },
    improvements,
    ...(automation ? { automation } : {}),
    ...(projectPlanQueue ? { projectPlanQueue } : {}),
    singleActivePlanEnabled,
    literalWorktreesEnabled,
  };
}
