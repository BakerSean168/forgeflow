import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';

import { registerOpenApi } from './api/openapi.js';
import { registerApiErrorHandler } from './api/shared/errors.js';
import { requiredText } from './api/shared/input.js';
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

import {
  AntigravityExecutionProvider,
  AntigravityReviewProvider,
} from './core/adapters/antigravity.js';
import { LocalGitWorkspaceAdapter } from './core/adapters/gitWorkspace.js';
import { LiteralWorktreeWorkspaceAdapter } from './core/adapters/literalWorktreeWorkspace.js';
import { PlanWorktreeManager } from './core/adapters/planWorktrees.js';
import { ProjectScopedWorkspaceAdapter } from './core/adapters/projectScopedWorkspace.js';
import { LiteLlmExecutionTelemetry } from './core/adapters/liteLlmTelemetry.js';
import { GitHubCliDeliveryAdapter } from './core/adapters/githubDelivery.js';
import { MaintenanceCandidateRegistry } from './core/adapters/maintenance.js';
import { ResourceSelectedImprovementDiagnosisClient } from './core/adapters/improvementDiagnosis.js';
import { ExactShaSelfChangeCanary } from './core/adapters/selfChangeCanary.js';
import { FileSelfChangePromotionQueue } from './core/adapters/selfChangePromotion.js';
import {
  createOpenHandsProviderFactory,
  OpenHandsCodexBusinessReviewProvider,
  OpenHandsCodexManagedExecutionProvider,
  OpenHandsExecutionProvider,
  OpenHandsReviewProvider,
  type OpenHandsAgentBackend,
} from './core/adapters/openHandsCoding.js';
import {
  HttpOpenHandsSupervisorClient,
  OpenHandsSupervisorAdapter,
} from './core/adapters/openhands.js';
import {
  CompositeResourceDirectory,
  LiteLlmResourceDirectory,
  LiteLlmResourceProbe,
  LiteLlmResourceStateEffect,
  ResourceLifecycleManager,
  ResourceStateService,
  StaticResourceDirectory,
  providerNativeResources,
  type ResourceProbePort,
} from './core/adapters/resourceDirectory.js';
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
import { ExecutionWorker, type ExecutionWorkerRoute } from './core/orchestration/executionWorker.js';
import { MaintenanceImprovementRuntime } from './core/orchestration/maintenanceRuntime.js';
import { ProjectPlanQueueRuntime } from './core/orchestration/projectPlanQueueRuntime.js';
import {
  AUTONOMOUS_ACCEPTANCE_EVENT,
  decodeAutonomousLifecycleAttestation,
  releaseAcceptanceAggregateId,
} from './core/orchestration/releaseAcceptance.js';
import type { ExecutionProviderPort, WorkspaceProviderPort } from './core/orchestration/contracts.js';
import {
  ResourceSelector,
  selectExecutableProfile,
  type ResourceSelectionCandidate,
} from './core/orchestration/resourceSelector.js';
import {
  RuntimeAdmissionRegistry,
  createRuntimeAdmissionStatus,
  requiresAcpRuntimeAdmission,
  runtimeAdmissionKey,
} from './core/orchestration/runtimeAdmission.js';
import {
  PlanAutomationRuntime,
  StaticPlanAutomationPolicyResolver,
  type PlanAutomationPolicy,
} from './core/orchestration/planAutomationRuntime.js';
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
import {
  loadProjectRegistry,
  type ProjectRegistry,
} from './platform/projects/index.js';

export interface BuildControlPlaneOptions {
  env?: NodeJS.ProcessEnv;
  dbFile?: string;
  logger?: boolean;
  environment?: 'test' | 'development' | 'staging' | 'production';
  allowDataReset?: boolean;
  fetchImpl?: typeof fetch;
}

export interface ExecutionAutomationRuntime {
  workspace: WorkspaceProviderPort;
  planWorktreeManager?: PlanWorktreeManager;
  workspaceUid: number;
  worker: ExecutionWorker;
  plans: PlanAutomationRuntime;
  policy: StaticPlanAutomationPolicyResolver;
  compatibilityImplementationRoutes: string[];
  compatibilityReviewRoutes: string[];
  implementationRoutes: string[];
  reviewRoutes: string[];
  automationProjectKeys: string[];
  literalWorktreeProjectKeys: string[];
  requireDelivery: boolean;
  routeModels: Record<string, string>;
  resourceSelectorEnabled: boolean;
  resources: CompositeResourceDirectory;
  liteLlmResources: LiteLlmResourceDirectory;
  resourceSelector: ResourceSelector;
  resourceState: ResourceStateService;
  resourceStateEffect: LiteLlmResourceStateEffect;
  resourceLifecycle: ResourceLifecycleManager;
  runtimeAdmissionEnabled: boolean;
  runtimeAdmission: RuntimeAdmissionRegistry;
  runtimeAdmissionHasDemand: () => boolean;
  reconcileRuntimeAdmission: () => Promise<void>;
  shutdownRuntimeAdmission: () => Promise<void>;
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

interface RouteSpec {
  route: string;
  model: string;
}

function routeSpecs(value: string | undefined, fallback: string[]): RouteSpec[] {
  const items = (value ? value.split(',') : fallback).map((item) => item.trim()).filter(Boolean);
  const seen = new Set<string>();
  return items.map((item) => {
    const separator = item.indexOf('=');
    const route = (separator < 0 ? item : item.slice(0, separator)).trim();
    const model = (separator < 0 ? item : item.slice(separator + 1)).trim();
    if (!route || !model) throw new ForgeFlowError('EXECUTION_ROUTE_SPEC_INVALID');
    if (seen.has(route)) throw new ForgeFlowError('EXECUTION_ROUTE_DUPLICATE');
    seen.add(route);
    return { route, model };
  });
}

function rootList(value: string | undefined): string[] {
  return (value ?? '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function commaList(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function assertOpenHandsGitCommonDirMounted(
  repositoryPath: string,
  container: string,
  commandTimeoutMs: number,
  maxBufferBytes: number,
): void {
  try {
    const rawCommon = execFileSync(
      '/usr/bin/git',
      ['-c', `safe.directory=${repositoryPath}`, '-C', repositoryPath, 'rev-parse', '--git-common-dir'],
      {
        encoding: 'utf8',
        timeout: commandTimeoutMs,
        maxBuffer: maxBufferBytes,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
    const common = fs.realpathSync(
      path.isAbsolute(rawCommon) ? rawCommon : path.resolve(repositoryPath, rawCommon),
    );
    const rawMounts = execFileSync(
      '/usr/bin/docker',
      ['inspect', container, '--format', '{{json .Mounts}}'],
      {
        encoding: 'utf8',
        timeout: commandTimeoutMs,
        maxBuffer: maxBufferBytes,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
    const mounts = JSON.parse(rawMounts) as Array<{
      Source?: unknown;
      Destination?: unknown;
      RW?: unknown;
    }>;
    if (
      !Array.isArray(mounts) ||
      !mounts.some(
        (mount) =>
          mount.Source === common && mount.Destination === common && mount.RW === true,
      )
    )
      throw new ForgeFlowError(
        'WORKTREE_OPENHANDS_COMMON_DIR_NOT_MOUNTED',
        'Literal worktrees require the canonical Git common directory mounted read-write at the same path inside OpenHands.',
      );
  } catch (error) {
    if (error instanceof ForgeFlowError) throw error;
    throw new ForgeFlowError(
      'WORKTREE_OPENHANDS_MOUNT_CHECK_FAILED',
      'Unable to verify the OpenHands Git common-directory mount.',
      error,
    );
  }
}

function integerValue(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  code: string,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new ForgeFlowError(code);
  return parsed;
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

async function buildExecutionAutomation(
  env: NodeJS.ProcessEnv,
  repositories: ForgeFlowRepositories,
  fetchImpl: typeof fetch,
  projects: ProjectRegistry,
): Promise<ExecutionAutomationRuntime | undefined> {
  if (env.FORGEFLOW_EXECUTION_RUNTIME_ENABLED !== 'true') return undefined;
  const openHandsUrl = requiredText(env.FORGEFLOW_OPENHANDS_URL, 'OPENHANDS_BASE_URL_REQUIRED');
  const sessionApiKey = requiredText(env.FORGEFLOW_OPENHANDS_TOKEN, 'OPENHANDS_SESSION_KEY_REQUIRED');
  const liteLlmApiKey = requiredText(env.FORGEFLOW_LITELLM_API_KEY, 'OPENHANDS_LITELLM_KEY_REQUIRED');
  const liteLlmBaseUrl = requiredText(
    env.FORGEFLOW_LITELLM_BASE_URL,
    'OPENHANDS_LITELLM_URL_REQUIRED',
  );
  const allowedRepositoryRoots = rootList(env.FORGEFLOW_ALLOWED_REPOSITORY_ROOTS);
  if (allowedRepositoryRoots.length === 0) throw new ForgeFlowError('WORKSPACE_ALLOWED_ROOT_REQUIRED');
  const managedHostRoot = requiredText(
    env.FORGEFLOW_WORKSPACE_HOST_ROOT,
    'WORKSPACE_MANAGED_ROOT_REQUIRED',
  );
  const executionRoot = requiredText(
    env.FORGEFLOW_WORKSPACE_EXECUTION_ROOT ?? '/workspace',
    'WORKSPACE_EXECUTION_ROOT_REQUIRED',
  );
  const automationProjectKeys = projects.automationProjectKeys();
  const literalWorktreesEnabled = env.FORGEFLOW_LITERAL_WORKTREES_ENABLED === 'true';
  const configuredLiteralProjects = projects.literalWorktreeProjectKeys();
  if (projects.source() === 'manifest' && configuredLiteralProjects.length > 0 && !literalWorktreesEnabled)
    throw new ForgeFlowError('PROJECT_MANIFEST_LITERAL_WORKTREES_DISABLED');
  const literalWorktreeProjectKeys = literalWorktreesEnabled ? configuredLiteralProjects : [];
  if (literalWorktreesEnabled && literalWorktreeProjectKeys.length === 0)
    throw new ForgeFlowError('LITERAL_WORKTREE_PROJECTS_REQUIRED');
  if (
    automationProjectKeys.length > 0 &&
    literalWorktreeProjectKeys.some((projectKey) => !automationProjectKeys.includes(projectKey))
  )
    throw new ForgeFlowError('LITERAL_WORKTREE_PROJECT_NOT_AUTOMATED');
  const resourceSelectorEnabled = env.FORGEFLOW_RESOURCE_SELECTOR_ENABLED === 'true';
  // Selector-enabled ForgeFlow never reads the legacy route ladders. They remain only
  // as an explicit rollback path when the selector gate is disabled. This keeps
  // exactly one routing authority for every newly-created execution.
  const implementationSpecs = resourceSelectorEnabled
    ? []
    : routeSpecs(env.FORGEFLOW_IMPLEMENTATION_ROUTES, ['gpt-5.6-luna']);
  const reviewSpecs = resourceSelectorEnabled
    ? []
    : routeSpecs(env.FORGEFLOW_REVIEW_ROUTES, [
        'codex-business-review=gpt-5.6-sol',
        'gpt-5.6-sol',
      ]);
  const compatibilityImplementationRoutes = implementationSpecs.map((item) => item.route);
  const compatibilityReviewRoutes = reviewSpecs.map((item) => item.route);
  if (compatibilityImplementationRoutes.some((route) => compatibilityReviewRoutes.includes(route)))
    throw new ForgeFlowError('EXECUTION_ROUTE_ROLE_CONFLICT');
  const implementationRoutes = resourceSelectorEnabled
    ? DEFAULT_AFFINITY_POLICY.capabilities.IMPLEMENTATION.map((item) => item.modelFamily)
    : compatibilityImplementationRoutes;
  const reviewRoutes = resourceSelectorEnabled
    ? DEFAULT_AFFINITY_POLICY.capabilities.REASONING.map((item) => item.modelFamily)
    : compatibilityReviewRoutes;

  const common = {
    baseUrl: openHandsUrl,
    sessionApiKey,
    liteLlmApiKey,
    liteLlmBaseUrl,
    fetchImpl,
    requestTimeoutMs: integerValue(
      env.FORGEFLOW_PROVIDER_REQUEST_TIMEOUT_MS,
      30_000,
      1_000,
      120_000,
      'OPENHANDS_TIMEOUT_INVALID',
    ),
    llmTimeoutSeconds: integerValue(
      env.FORGEFLOW_PROVIDER_LLM_TIMEOUT_SECONDS,
      600,
      30,
      1_800,
      'OPENHANDS_LLM_TIMEOUT_INVALID',
    ),
    maxIterations: integerValue(
      env.FORGEFLOW_PROVIDER_MAX_ITERATIONS,
      500,
      1,
      1_000,
      'OPENHANDS_ITERATION_LIMIT_INVALID',
    ),
  };
  const liteLlmAdminBaseUrl = (
    env.FORGEFLOW_LITELLM_ADMIN_BASE_URL ??
    env.FORGEFLOW_LITELLM_BASE_URL ??
    liteLlmBaseUrl
  )
    .replace(/\/$/, '')
    .replace(/\/v1$/, '');
  const liteLlmResources = new LiteLlmResourceDirectory({
    baseUrl: liteLlmAdminBaseUrl,
    envFile: env.FORGEFLOW_LITELLM_ADMIN_ENV_FILE ?? '/etc/forgeflow/litellm.env',
    keyName: env.FORGEFLOW_LITELLM_ADMIN_KEY_NAME ?? 'LITELLM_MASTER_KEY',
    fetchImpl,
    requestTimeoutMs: integerValue(
      env.FORGEFLOW_RESOURCE_DIRECTORY_TIMEOUT_MS,
      10_000,
      1_000,
      60_000,
      'RESOURCE_DIRECTORY_TIMEOUT_INVALID',
    ),
  });
  if (resourceSelectorEnabled) await liteLlmResources.refresh();

  const businessAuthFile =
    env.FORGEFLOW_BUSINESS_AUTH_FILE ??
    '/var/lib/forgeflow/openhands/codex-business/auth.json';
  const businessEnabled = env.FORGEFLOW_BUSINESS_RESOURCE_ENABLED !== 'false';
  const businessReady = businessEnabled && fs.existsSync(businessAuthFile);
  const antigravityBinary =
    env.FORGEFLOW_ANTIGRAVITY_BIN ?? '/home/dev/.local/bin/agy';
  const antigravityHome =
    env.FORGEFLOW_ANTIGRAVITY_HOME ?? '/home/dev';
  const antigravityAuthFile = path.join(
    antigravityHome,
    '.gemini/antigravity-cli/antigravity-oauth-token',
  );
  const antigravityEnabled = env.FORGEFLOW_ANTIGRAVITY_RESOURCE_ENABLED === 'true';
  const antigravityReady =
    antigravityEnabled && fs.existsSync(antigravityBinary) && fs.existsSync(antigravityAuthFile);
  const nativeResources = new StaticResourceDirectory(
    providerNativeResources({
      businessEnabled,
      businessReady,
      antigravityEnabled,
      antigravityReady,
    }),
  );
  const sourceResources = new CompositeResourceDirectory([liteLlmResources, nativeResources]);
  const resources = new CompositeResourceDirectory(
    [liteLlmResources, nativeResources],
    repositories.resourceStateOverrides,
  );
  const runtimeAdmissionEnabled =
    resourceSelectorEnabled &&
    (env.FORGEFLOW_RUNTIME_ADMISSION_ENABLED === 'true' ||
      (env.FORGEFLOW_RUNTIME_ADMISSION_ENABLED !== 'false' && env.NODE_ENV !== 'test'));
  const runtimeAdmissionTtlMs = integerValue(
    env.FORGEFLOW_RUNTIME_ADMISSION_TTL_MS,
    15 * 60_000,
    60_000,
    24 * 60 * 60_000,
    'RUNTIME_ADMISSION_TTL_INVALID',
  );
  const runtimeAdmissionTransientFailureTtlMs = integerValue(
    env.FORGEFLOW_RUNTIME_ADMISSION_TRANSIENT_FAILURE_TTL_MS,
    15_000,
    1_000,
    runtimeAdmissionTtlMs,
    'RUNTIME_ADMISSION_TRANSIENT_FAILURE_TTL_INVALID',
  );
  const runtimeAdmission = new RuntimeAdmissionRegistry();
  if (runtimeAdmissionEnabled) runtimeAdmission.restore(repositories.runtimeAdmissions.list());
  const runtimeAdmissionHasDemand = (): boolean => {
    if (repositories.executions.listByStatuses(['QUEUED', 'RUNNING'], 1).length > 0) return true;
    return (['READY', 'RUNNING', 'WAITING_FOR_RESOURCE'] as const).some(
      (status) => repositories.plans.listPlans({ status, limit: 1 }).length > 0,
    );
  };
  const resourceStateEffect = new LiteLlmResourceStateEffect({
    baseUrl: liteLlmAdminBaseUrl,
    envFile: env.FORGEFLOW_LITELLM_ADMIN_ENV_FILE ?? '/etc/forgeflow/litellm.env',
    keyName: env.FORGEFLOW_LITELLM_ADMIN_KEY_NAME ?? 'LITELLM_MASTER_KEY',
    fetchImpl,
    requestTimeoutMs: integerValue(
      env.FORGEFLOW_RESOURCE_DIRECTORY_TIMEOUT_MS,
      10_000,
      1_000,
      60_000,
      'RESOURCE_DIRECTORY_TIMEOUT_INVALID',
    ),
  });
  const resourceState = new ResourceStateService(
    resources,
    repositories.resourceStateOverrides,
    3,
    resourceStateEffect,
  );
  const liteLlmResourceProbe = new LiteLlmResourceProbe({
    baseUrl: liteLlmBaseUrl,
    bearerToken: liteLlmApiKey,
    fetchImpl,
    timeoutMs: integerValue(
      env.FORGEFLOW_RESOURCE_PROBE_TIMEOUT_MS,
      30_000,
      1_000,
      120_000,
      'RESOURCE_PROBE_TIMEOUT_INVALID',
    ),
  });
  const resourceProbe: ResourceProbePort = {
    probe: async (resource: ExecutionResource): Promise<boolean> => {
      if (resource.resourceId === 'chatgpt-business-primary') return businessReady;
      if (resource.resourceId === 'antigravity-primary') return antigravityReady;
      return await liteLlmResourceProbe.probe(resource);
    },
  };
  const resourceLifecycle = new ResourceLifecycleManager(
    sourceResources,
    repositories.resourceStateOverrides,
    resourceProbe,
    resourceStateEffect,
  );
  const routes: ExecutionWorkerRoute[] = [
    ...implementationSpecs.map(({ route, model }) => ({
      route,
      provider:
        model === 'gpt-5.6-luna'
          ? new OpenHandsCodexManagedExecutionProvider({ ...common, implementationModel: model })
          : new OpenHandsExecutionProvider({ ...common, implementationModel: model }),
    })),
    ...reviewSpecs.map(({ route, model }) => ({
      route,
      provider:
        route === 'codex-business-review'
          ? new OpenHandsCodexBusinessReviewProvider({ ...common, reviewModel: model })
          : new OpenHandsReviewProvider({ ...common, reviewModel: model }),
    })),
  ];
  const workspaceUid = integerValue(
    env.FORGEFLOW_WORKSPACE_UID,
    10_001,
    0,
    2 ** 31 - 1,
    'WORKSPACE_OWNER_INVALID',
  );
  const workspaceGid = integerValue(
    env.FORGEFLOW_WORKSPACE_GID,
    10_001,
    0,
    2 ** 31 - 1,
    'WORKSPACE_OWNER_INVALID',
  );
  const gitTimeoutMs = integerValue(
    env.FORGEFLOW_GIT_TIMEOUT_MS,
    120_000,
    1_000,
    15 * 60_000,
    'WORKSPACE_GIT_TIMEOUT_INVALID',
  );
  const gitMaxBufferBytes = integerValue(
    env.FORGEFLOW_GIT_MAX_BUFFER_BYTES,
    8 * 1024 * 1024,
    64 * 1024,
    64 * 1024 * 1024,
    'WORKSPACE_GIT_BUFFER_INVALID',
  );
  const workspaceMinimumFreeBytes = integerValue(
    env.FORGEFLOW_WORKSPACE_MIN_FREE_BYTES,
    8 * 1024 * 1024 * 1024,
    0,
    1024 ** 5,
    'WORKSPACE_CAPACITY_THRESHOLD_INVALID',
  );
  const legacyWorkspace = new LocalGitWorkspaceAdapter({
    allowedRepositoryRoots,
    managedHostRoot,
    executionRoot,
    commandTimeoutMs: gitTimeoutMs,
    maxBufferBytes: gitMaxBufferBytes,
    minimumFreeBytes: workspaceMinimumFreeBytes,
    workspaceUid,
    workspaceGid,
  });
  const planWorktreeManager =
    literalWorktreeProjectKeys.length > 0
      ? new PlanWorktreeManager({
          repositories,
          allowedRepositoryRoots,
          managedHostRoot,
          executionRoot,
          commandTimeoutMs: gitTimeoutMs,
          maxBufferBytes: gitMaxBufferBytes,
          projectAdmission: (repositoryPath) => {
            const harnessctl =
              env.FORGEFLOW_AGENT_HARNESS_CTL ??
              '/home/dev/projects/agent-harness/bin/harnessctl.py';
            try {
              execFileSync(
                '/usr/bin/python3',
                [harnessctl, 'plan', repositoryPath, '--profile', 'openhands', '--json'],
                {
                  cwd: repositoryPath,
                  encoding: 'utf8',
                  timeout: gitTimeoutMs,
                  maxBuffer: gitMaxBufferBytes,
                  stdio: ['ignore', 'pipe', 'pipe'],
                },
              );
            } catch (error) {
              throw new ForgeFlowError(
                'WORKTREE_AGENT_HARNESS_PROJECT_UNREGISTERED',
                'Literal worktree projects must resolve through Agent Harness before activation.',
                error,
              );
            }
            if (env.NODE_ENV !== 'test')
              assertOpenHandsGitCommonDirMounted(
                repositoryPath,
                env.FORGEFLOW_OPENHANDS_CONTAINER ?? 'forgeflow-openhands',
                gitTimeoutMs,
                gitMaxBufferBytes,
              );
          },
        })
      : undefined;
  const literalWorkspace = planWorktreeManager
    ? new LiteralWorktreeWorkspaceAdapter({
        repositories,
        manager: planWorktreeManager,
        managedHostRoot,
        executionRoot,
        workspaceUid,
        workspaceGid,
        minimumFreeBytes: workspaceMinimumFreeBytes,
        commandTimeoutMs: gitTimeoutMs,
        maxBufferBytes: gitMaxBufferBytes,
      })
    : undefined;
  const workspace: WorkspaceProviderPort = literalWorkspace
    ? new ProjectScopedWorkspaceAdapter({
        repositories,
        legacy: legacyWorkspace,
        literal: literalWorkspace,
        literalProjects: literalWorktreeProjectKeys,
      })
    : legacyWorkspace;
  const openHandsProviderFactory = createOpenHandsProviderFactory(common);
  const antigravityBase = {
    binary: antigravityBinary,
    stateRoot:
      env.FORGEFLOW_ANTIGRAVITY_STATE_ROOT ??
      '/var/lib/forgeflow/antigravity',
    workspaceHostRoot: managedHostRoot,
    home: antigravityHome,
    uid: integerValue(
      env.FORGEFLOW_ANTIGRAVITY_UID,
      10_001,
      1,
      2 ** 31 - 1,
      'ANTIGRAVITY_UID_INVALID',
    ),
    gid: integerValue(
      env.FORGEFLOW_ANTIGRAVITY_GID,
      10_001,
      1,
      2 ** 31 - 1,
      'ANTIGRAVITY_GID_INVALID',
    ),
    authUid: integerValue(
      env.FORGEFLOW_ANTIGRAVITY_AUTH_UID,
      1001,
      1,
      2 ** 31 - 1,
      'ANTIGRAVITY_AUTH_UID_INVALID',
    ),
    authGid: integerValue(
      env.FORGEFLOW_ANTIGRAVITY_AUTH_GID,
      1002,
      1,
      2 ** 31 - 1,
      'ANTIGRAVITY_AUTH_GID_INVALID',
    ),
    workspaceGid,
    user: env.FORGEFLOW_ANTIGRAVITY_USER ?? 'forgeflow-worker',
    printTimeout:
      env.FORGEFLOW_ANTIGRAVITY_PRINT_TIMEOUT ??
      env.FORGEFLOW_ANTIGRAVITY_PRINT_TIMEOUT ??
      '20m',
    sandboxWrapper:
      env.FORGEFLOW_ANTIGRAVITY_SANDBOX_WRAPPER ??
      '/usr/local/libexec/forgeflow-antigravity-sandbox.sh',
    systemdUnitTemplate:
      env.FORGEFLOW_ANTIGRAVITY_SYSTEMD_UNIT ?? 'forgeflow-antigravity@%i.service',
  };
  const providerFactory = (selection: ExecutionResourceSelection): ExecutionProviderPort => {
    if (
      selection.agentBackend === 'antigravity-worker' ||
      selection.agentBackend === 'antigravity-review'
    ) {
      const options = { ...antigravityBase, model: selection.modelFamily };
      return selection.agentBackend === 'antigravity-review'
        ? new AntigravityReviewProvider(options)
        : new AntigravityExecutionProvider(options);
    }
    if (!['IMPLEMENT', 'IMPLEMENT_FIX', 'REVIEW'].includes(selection.phase))
      throw new ForgeFlowError('EXECUTION_RESOURCE_SELECTION_PHASE_UNSUPPORTED');
    return openHandsProviderFactory({
      backend: selection.agentBackend as OpenHandsAgentBackend,
      model: selection.routeModel ?? selection.modelFamily,
      modelFamily: selection.modelFamily,
      transport: selection.transport,
      phase: selection.phase as 'IMPLEMENT' | 'IMPLEMENT_FIX' | 'REVIEW',
      capability: selection.capability,
      resourceId: selection.resourceId,
    });
  };
  const admissionCandidates = (): ResourceSelectionCandidate[] => {
    const selected = new Map<string, ResourceSelectionCandidate>();
    for (const phase of ['IMPLEMENT', 'REVIEW'] as const) {
      const priorAttempts: Array<{ resourceId: string; bindingId?: string; modelFamily?: string }> =
        [];
      for (let index = 0; index < 100; index += 1) {
        const result = selectExecutableProfile(resources, {
          phase,
          includeProviderNativeProfiles: true,
          policy: {
            allowProviderNative: true,
            allowedPolicyKeys: ['provider-native-trusted-input'],
          },
          priorAttempts,
        });
        if (result.status !== 'SELECTED') break;
        selected.set(runtimeAdmissionKey(result.candidate), result.candidate);
        priorAttempts.push({
          resourceId: result.profile.resourceId,
          ...(result.profile.bindingId ? { bindingId: result.profile.bindingId } : {}),
          modelFamily: result.profile.modelFamily,
        });
      }
    }
    return [...selected.values()].filter(requiresAcpRuntimeAdmission);
  };

  const createAdmissionWorkspace = (_candidate: ResourceSelectionCandidate, probeId: string) => {
    const executionsRoot = path.join(managedHostRoot, 'forgeflow', 'executions');
    const root = path.join(executionsRoot, probeId);
    const repository = path.join(root, 'repo');
    fs.mkdirSync(executionsRoot, { recursive: true, mode: 0o755 });
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { mode: 0o750 });
    fs.chownSync(root, workspaceUid, workspaceGid);
    fs.mkdirSync(repository, { mode: 0o750 });
    fs.chownSync(repository, workspaceUid, workspaceGid);
    const git = (args: string[]) =>
      execFileSync('/usr/bin/git', ['-C', repository, ...args], {
        encoding: 'utf8',
        uid: workspaceUid,
        gid: workspaceGid,
        env: { ...process.env, HOME: '/tmp' },
      }).trim();
    git(['init', '-q', '-b', 'main']);
    const readme = path.join(repository, 'README.md');
    fs.writeFileSync(readme, '# ForgeFlow runtime admission probe\n');
    fs.chownSync(readme, workspaceUid, workspaceGid);
    const harnessManifest = path.join(repository, '.agent-harness.json');
    fs.writeFileSync(
      harnessManifest,
      JSON.stringify(
        {
          version: 1,
          id: 'forgeflow-runtime-admission',
          sharedMcpProfile: 'common',
          packs: [],
          capabilities: [],
        },
        null,
        2,
      ) + '\n',
      { mode: 0o640 },
    );
    fs.chownSync(harnessManifest, workspaceUid, workspaceGid);
    git(['add', 'README.md', '.agent-harness.json']);
    git([
      '-c',
      'user.name=ForgeFlow Runtime Probe',
      '-c',
      'user.email=forgeflow-runtime-probe@localhost',
      'commit',
      '-q',
      '-m',
      'chore: runtime admission probe',
    ]);
    const sourceRevision = git(['rev-parse', '--verify', 'HEAD^{commit}']);
    const executionPath = path.join(executionRoot, 'forgeflow', 'executions', probeId, 'repo');
    return {
      root,
      sourceRevision,
      workspace: {
        executionId: probeId,
        hostPath: repository,
        executionPath,
        evidenceHostPath: path.join(root, 'completion-evidence.json'),
        evidenceExecutionPath: path.join(
          executionRoot,
          'forgeflow',
          'executions',
          probeId,
          'completion-evidence.json',
        ),
        sourceRepositoryPath: repository,
        sourceRevision,
        createdAt: new Date().toISOString(),
      },
      git,
    };
  };

  const pruneAdmissionWorkspaces = (probeGroupId: string, currentRoot: string): number => {
    const executionsRoot = path.join(managedHostRoot, 'forgeflow', 'executions');
    if (!fs.existsSync(executionsRoot)) return 0;
    let removed = 0;
    for (const entry of fs.readdirSync(executionsRoot, { withFileTypes: true })) {
      if (entry.name !== probeGroupId && !entry.name.startsWith(probeGroupId + '-')) continue;
      const candidate = path.join(executionsRoot, entry.name);
      if (candidate === currentRoot) continue;
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new ForgeFlowError('RUNTIME_ADMISSION_STALE_WORKSPACE_UNSAFE');
      fs.rmSync(candidate, { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  };

  const recordRuntimeAdmission = (
    candidate: ResourceSelectionCandidate,
    input: { ready: boolean; checkedAt?: string; errorCode?: string },
  ) => {
    const status = createRuntimeAdmissionStatus(candidate, input);
    const persisted = repositories.runtimeAdmissions.record(status);
    if (!persisted.value || persisted.status === 'rejected')
      throw new ForgeFlowError(persisted.reason ?? 'RUNTIME_ADMISSION_STALE');
    runtimeAdmission.restore([persisted.value]);
    return persisted.value;
  };

  const probeAdmissionCandidate = async (
    candidate: ResourceSelectionCandidate,
    signal?: AbortSignal,
  ): Promise<void> => {
    const key = runtimeAdmissionKey(candidate);
    const probeGroupId =
      'runtime-admission-' + createHash('sha256').update(key).digest('hex').slice(0, 20);
    const probeId = probeGroupId + '-' + randomUUID().slice(0, 8);
    let probeRoot: string | undefined;
    try {
      const prepared = createAdmissionWorkspace(candidate, probeId);
      probeRoot = prepared.root;
      const provider = providerFactory(
        createExecutionResourceSelection(probeId, candidate.profile, new Date().toISOString()),
      );
      if (!provider.probeRuntime) throw new ForgeFlowError('RUNTIME_ADMISSION_PROBE_UNSUPPORTED');
      const result = await provider.probeRuntime({
        probeId,
        probeGroupId,
        workspace: prepared.workspace,
        sourceRevision: prepared.sourceRevision,
        signal,
      });
      // probeRuntime returning means its stable-group OpenHands cleanup completed.
      // Only then is it safe to remove crash residue from older attempts, including
      // the pre-attempt-id deterministic directory used by older ForgeFlow builds.
      pruneAdmissionWorkspaces(probeGroupId, prepared.root);
      const clean = prepared.git(['status', '--porcelain=v1']) === '';
      const head = prepared.git(['rev-parse', '--verify', 'HEAD^{commit}']);
      const ready = result.ready && clean && head === prepared.sourceRevision;
      recordRuntimeAdmission(candidate, {
        ready,
        ...(!ready
          ? {
              errorCode:
                result.errorCode ??
                (!clean
                  ? 'RUNTIME_PROBE_WORKSPACE_DIRTY'
                  : head !== prepared.sourceRevision
                    ? 'RUNTIME_PROBE_HEAD_DRIFT'
                    : 'RUNTIME_ADMISSION_PROBE_FAILED'),
            }
          : {}),
      });
    } catch (error) {
      if (signal?.aborted) return;
      recordRuntimeAdmission(candidate, {
        ready: false,
        errorCode: error instanceof ForgeFlowError ? error.code : 'RUNTIME_ADMISSION_PROBE_FAILED',
      });
    } finally {
      if (probeRoot) fs.rmSync(probeRoot, { recursive: true, force: true });
    }
  };

  let runtimeAdmissionCycle: Promise<void> | undefined;
  let runtimeAdmissionAbortController: AbortController | undefined;
  let runtimeAdmissionShuttingDown = false;
  const reconcileRuntimeAdmission = async (): Promise<void> => {
    if (!runtimeAdmissionEnabled || runtimeAdmissionShuttingDown) return;
    const candidates = admissionCandidates();
    runtimeAdmission.retain(candidates);
    repositories.runtimeAdmissions.retain(candidates.map(runtimeAdmissionKey));
    if (!runtimeAdmissionHasDemand()) return;
    if (runtimeAdmissionCycle) return await runtimeAdmissionCycle;
    const abortController = new AbortController();
    runtimeAdmissionAbortController = abortController;
    runtimeAdmissionCycle = (async () => {
      const now = Date.now();
      const queue = candidates.filter((candidate) =>
        runtimeAdmission.isStale(
          candidate,
          now,
          runtimeAdmissionTtlMs,
          runtimeAdmissionTransientFailureTtlMs,
        ),
      );
      // Admission is a readiness gate, not a startup dependency or throughput path.
      // Probe serially so provider-native OAuth homes and ACP runtime caches are never
      // mutated concurrently by sibling probes. The selector fails closed until a
      // candidate has a positive admission record.
      for (const candidate of queue) {
        if (abortController.signal.aborted) break;
        await probeAdmissionCandidate(candidate, abortController.signal);
      }
    })();
    try {
      await runtimeAdmissionCycle;
    } finally {
      if (runtimeAdmissionAbortController === abortController)
        runtimeAdmissionAbortController = undefined;
      runtimeAdmissionCycle = undefined;
    }
  };
  const shutdownRuntimeAdmission = async (): Promise<void> => {
    runtimeAdmissionShuttingDown = true;
    runtimeAdmissionAbortController?.abort();
    if (runtimeAdmissionCycle) await runtimeAdmissionCycle;
  };

  const resourceSelector = new ResourceSelector(
    resources,
    DEFAULT_AFFINITY_POLICY,
    runtimeAdmissionEnabled ? runtimeAdmission : undefined,
  );
  const worker = new ExecutionWorker(repositories, workspace, routes, {
    leaseTtlMs: integerValue(
      env.FORGEFLOW_EXECUTION_LEASE_TTL_MS,
      30_000,
      1_000,
      5 * 60_000,
      'EXECUTION_LEASE_TTL_INVALID',
    ),
    maxExecutionsPerCycle: integerValue(
      env.FORGEFLOW_MAX_EXECUTIONS_PER_CYCLE,
      20,
      1,
      1_000,
      'EXECUTION_CYCLE_LIMIT_INVALID',
    ),
    meaningfulProgressTimeoutMs: integerValue(
      env.FORGEFLOW_MEANINGFUL_PROGRESS_TIMEOUT_MS,
      15 * 60_000,
      30_000,
      24 * 60 * 60_000,
      'EXECUTION_MEANINGFUL_PROGRESS_TIMEOUT_INVALID',
    ),
    providerOnlyProgressTimeoutMs: integerValue(
      env.FORGEFLOW_PROVIDER_ONLY_PROGRESS_TIMEOUT_MS,
      10 * 60_000,
      30_000,
      24 * 60 * 60_000,
      'EXECUTION_PROVIDER_ONLY_PROGRESS_TIMEOUT_INVALID',
    ),
    opportunisticMeaningfulProgressTimeoutMs: integerValue(
      env.FORGEFLOW_OPPORTUNISTIC_MEANINGFUL_PROGRESS_TIMEOUT_MS,
      5 * 60_000,
      30_000,
      15 * 60_000,
      'EXECUTION_OPPORTUNISTIC_PROGRESS_TIMEOUT_INVALID',
    ),
    maxStallRecoveries: integerValue(
      env.FORGEFLOW_MAX_STALL_RECOVERIES,
      2,
      0,
      10,
      'EXECUTION_STALL_RECOVERY_LIMIT_INVALID',
    ),
    opportunisticMaxStallRecoveries: integerValue(
      env.FORGEFLOW_OPPORTUNISTIC_MAX_STALL_RECOVERIES,
      0,
      0,
      10,
      'EXECUTION_OPPORTUNISTIC_STALL_RECOVERY_LIMIT_INVALID',
    ),
    ...(resourceSelectorEnabled
      ? {
          providerFactory,
          resourceFeedback: resourceState,
          requireResourceSelection: true,
        }
      : {}),
  });
  const maxParallelWorkItems = integerValue(
    env.FORGEFLOW_MAX_PARALLEL_WORK_ITEMS,
    1,
    1,
    32,
    'PLAN_AUTOMATION_LIMIT_INVALID',
  );
  const defaultPolicy: PlanAutomationPolicy = {
    ...(resourceSelectorEnabled
      ? {}
      : {
          implementationRoutes: compatibilityImplementationRoutes,
          reviewRoutes: compatibilityReviewRoutes,
        }),
    resourceSelection: {
      includeProviderNativeProfiles: false,
    },
    requireDelivery: env.FORGEFLOW_REQUIRE_DELIVERY !== 'false',
    maxImplementationAttempts: integerValue(
      env.FORGEFLOW_MAX_IMPLEMENTATION_ATTEMPTS,
      3,
      1,
      20,
      'PLAN_AUTOMATION_LIMIT_INVALID',
    ),
    maxReviewAttempts: integerValue(
      env.FORGEFLOW_MAX_REVIEW_ATTEMPTS,
      4,
      1,
      20,
      'PLAN_AUTOMATION_LIMIT_INVALID',
    ),
    maxRepairCycles: integerValue(
      env.FORGEFLOW_MAX_REPAIR_CYCLES,
      3,
      1,
      20,
      'PLAN_AUTOMATION_LIMIT_INVALID',
    ),
    maxParallelWorkItems: 1,
  };
  const antigravityProjectKeys = new Set(projects.providerNativeProjectKeys());
  const literalProjectSet = new Set(literalWorktreeProjectKeys);
  const policyOverrides = Object.fromEntries(
    automationProjectKeys
      .filter(
        (projectKey) =>
          literalProjectSet.has(projectKey) ||
          (antigravityEnabled && antigravityProjectKeys.has(projectKey)),
      )
      .map((projectKey) => [
        projectKey,
        {
          ...defaultPolicy,
          maxParallelWorkItems: literalProjectSet.has(projectKey)
            ? Math.min(
                maxParallelWorkItems,
                projects.get(projectKey)?.execution.maxParallelWorkItems ?? maxParallelWorkItems,
              )
            : 1,
          ...(antigravityEnabled && antigravityProjectKeys.has(projectKey)
            ? {
                resourceSelection: {
                  includeProviderNativeProfiles: true,
                  allowedPolicyKeys: ['provider-native-trusted-input'],
                },
              }
            : {}),
        } satisfies PlanAutomationPolicy,
      ]),
  );
  const policy = new StaticPlanAutomationPolicyResolver(
    defaultPolicy,
    policyOverrides,
    automationProjectKeys.length > 0 ? automationProjectKeys : undefined,
  );
  const delivery = new GitHubCliDeliveryAdapter({
    allowedRepositoryRoots,
    allowedWorkspaceRoots: [managedHostRoot],
    commandTimeoutMs: integerValue(
      env.FORGEFLOW_DELIVERY_TIMEOUT_MS,
      120_000,
      1_000,
      15 * 60_000,
      'DELIVERY_TIMEOUT_INVALID',
    ),
    maxBufferBytes: integerValue(
      env.FORGEFLOW_DELIVERY_MAX_BUFFER_BYTES,
      8 * 1024 * 1024,
      64 * 1024,
      64 * 1024 * 1024,
      'DELIVERY_BUFFER_INVALID',
    ),
  });
  const plans = new PlanAutomationRuntime(
    repositories,
    worker,
    workspace,
    policy,
    delivery,
    resourceSelectorEnabled ? resourceSelector : undefined,
  );
  return {
    workspace,
    ...(planWorktreeManager ? { planWorktreeManager } : {}),
    workspaceUid,
    worker,
    plans,
    policy,
    compatibilityImplementationRoutes,
    compatibilityReviewRoutes,
    implementationRoutes,
    reviewRoutes,
    automationProjectKeys,
    literalWorktreeProjectKeys,
    requireDelivery: defaultPolicy.requireDelivery === true,
    routeModels: Object.fromEntries(
      [...implementationSpecs, ...reviewSpecs].map(({ route, model }) => [route, model]),
    ),
    resourceSelectorEnabled,
    resources,
    liteLlmResources,
    resourceSelector,
    resourceState,
    resourceStateEffect,
    resourceLifecycle,
    runtimeAdmissionEnabled,
    runtimeAdmission,
    runtimeAdmissionHasDemand,
    reconcileRuntimeAdmission,
    shutdownRuntimeAdmission,
  };
}

export async function buildControlPlane(
  options: BuildControlPlaneOptions = {},
): Promise<ControlPlaneRuntime> {
  const env = options.env ?? process.env;
  const allowedRepositoryRoots = rootList(env.FORGEFLOW_ALLOWED_REPOSITORY_ROOTS);
  const projects = loadProjectRegistry(env, allowedRepositoryRoots);
  const selfChangeEnabled = env.FORGEFLOW_IMPROVEMENT_SELF_CHANGE_ENABLED === 'true';
  const selfPromotionEnabled = env.FORGEFLOW_IMPROVEMENT_SELF_PROMOTION_ENABLED === 'true';
  const selfAutoPromotionEnabled =
    env.FORGEFLOW_IMPROVEMENT_SELF_AUTO_PROMOTION_ENABLED === 'true';
  const improvementAiDiagnosisEnabled =
    env.FORGEFLOW_IMPROVEMENT_AI_DIAGNOSIS_ENABLED === 'true';
  const improvementProjectKeys = projects.improvementProjectKeys();
  if (improvementAiDiagnosisEnabled && improvementProjectKeys.length === 0)
    throw new ForgeFlowError('IMPROVEMENT_AI_DIAGNOSIS_PROJECTS_REQUIRED');
  if (
    improvementAiDiagnosisEnabled &&
    env.FORGEFLOW_EXECUTION_RUNTIME_ENABLED !== 'true'
  )
    throw new ForgeFlowError('IMPROVEMENT_AI_DIAGNOSIS_EXECUTION_RUNTIME_REQUIRED');
  if (
    improvementAiDiagnosisEnabled &&
    env.FORGEFLOW_RESOURCE_SELECTOR_ENABLED !== 'true'
  )
    throw new ForgeFlowError('IMPROVEMENT_AI_DIAGNOSIS_RESOURCE_SELECTOR_REQUIRED');
  if (selfPromotionEnabled && !selfChangeEnabled)
    throw new ForgeFlowError('IMPROVEMENT_SELF_PROMOTION_REQUIRES_SELF_CHANGE');
  if (selfAutoPromotionEnabled && !selfPromotionEnabled)
    throw new ForgeFlowError('IMPROVEMENT_SELF_AUTO_PROMOTION_REQUIRES_PROMOTION');
  const selfRepositoryPath = env.FORGEFLOW_IMPROVEMENT_SELF_REPOSITORY ?? process.cwd();
  const selfPromotionRequestFile =
    env.FORGEFLOW_IMPROVEMENT_SELF_PROMOTION_REQUEST_FILE ??
    '/var/lib/forgeflow/self-promotion-request.json';
  if (
    selfPromotionEnabled &&
    (options.environment === 'production' || env.NODE_ENV === 'production') &&
    path.resolve(selfPromotionRequestFile) !== '/var/lib/forgeflow/self-promotion-request.json'
  )
    throw new ForgeFlowError('IMPROVEMENT_SELF_PROMOTION_REQUEST_PATH_UNSUPPORTED');
  const releaseProvenance = bindReleaseProvenance(
    env.FORGEFLOW_RELEASE_PROVENANCE_FILE ?? '/var/lib/forgeflow/release-provenance.json',
  );
  const boot = bootstrapForgeFlow({
    dbFile: options.dbFile,
    env,
    environment: options.environment,
    allowDataReset: options.allowDataReset,
  });
  const db = boot.db;
  const repositories = createRepositories(db);
  const singleActivePlanEnabled = env.FORGEFLOW_SINGLE_ACTIVE_PLAN_ENABLED === 'true';
  const literalWorktreesEnabled = env.FORGEFLOW_LITERAL_WORKTREES_ENABLED === 'true';
  if (literalWorktreesEnabled && !singleActivePlanEnabled)
    throw new ForgeFlowError('LITERAL_WORKTREES_REQUIRE_SINGLE_ACTIVE_PLAN');
  const projectPlanQueue = singleActivePlanEnabled
    ? new ProjectPlanQueueRuntime(repositories)
    : undefined;
  const testTelemetryBaseUrl =
    options.environment === 'test' || env.NODE_ENV === 'test' ? 'http://127.0.0.1:4000' : undefined;
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
    baseUrl: requiredText(
      env.FORGEFLOW_LITELLM_BASE_URL ?? testTelemetryBaseUrl,
      'LITELLM_TELEMETRY_URL_REQUIRED',
    ),
    envFile: env.FORGEFLOW_LITELLM_ADMIN_ENV_FILE ?? '/etc/forgeflow/litellm.env',
    keyName: env.FORGEFLOW_LITELLM_ADMIN_KEY_NAME ?? 'LITELLM_MASTER_KEY',
    fetchImpl: options.fetchImpl ?? fetch,
    requestTimeoutMs: integerValue(
      env.FORGEFLOW_LITELLM_TELEMETRY_TIMEOUT_MS,
      10_000,
      1_000,
      60_000,
      'LITELLM_TELEMETRY_TIMEOUT_INVALID',
    ),
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
          env.FORGEFLOW_IMPROVEMENT_SELF_CANARY_ROOT ?? '/var/lib/forgeflow/self-canary',
        commandTimeoutMs: integerValue(
          env.FORGEFLOW_IMPROVEMENT_SELF_CANARY_TIMEOUT_MS,
          15 * 60_000,
          30_000,
          60 * 60_000,
          'IMPROVEMENT_CANARY_TIMEOUT_INVALID',
        ),
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
      discoveryEnabled: env.FORGEFLOW_IMPROVEMENT_DISCOVERY_ENABLED === 'true',
      adoptionEnabled: env.FORGEFLOW_IMPROVEMENT_ADOPTION_ENABLED === 'true',
      autoAdoptLowRisk: env.FORGEFLOW_IMPROVEMENT_AUTO_ADOPT_LOW_RISK === 'true',
      allowedProjectKeys: improvementProjectKeys,
      selfChangeEnabled,
      selfPromotionEnabled,
      selfAutoPromotionEnabled,
      aiDiagnosisEnabled: improvementAiDiagnosisEnabled,
      aiDiagnosisMaxPerCycle: integerValue(
        env.FORGEFLOW_IMPROVEMENT_AI_DIAGNOSIS_MAX_PER_CYCLE,
        2,
        1,
        20,
        'IMPROVEMENT_DIAGNOSIS_CYCLE_LIMIT_INVALID',
      ),
      selfProjectKey: env.FORGEFLOW_IMPROVEMENT_SELF_PROJECT_KEY ?? 'forgeflow',
      selfRepositoryPath,
    },
    selfCanary,
    selfPromotionQueue,
    releaseProvenance,
  );
  const automation = await buildExecutionAutomation(
    env,
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
    env.FORGEFLOW_OPENHANDS_URL
      ? new HttpOpenHandsSupervisorClient(
          env.FORGEFLOW_OPENHANDS_URL,
          env.FORGEFLOW_OPENHANDS_TOKEN,
        )
      : undefined,
  );
  const scheduler = new SupervisorWakeScheduler(repositories.supervisors, db);
  const supervisorRuntimeEnabled = env.FORGEFLOW_SUPERVISOR_RUNTIME_ENABLED === 'true';
  const supervisorMaxResourceAttempts = integerValue(
    env.FORGEFLOW_SUPERVISOR_MAX_RESOURCE_ATTEMPTS,
    3,
    1,
    20,
    'SUPERVISOR_RESOURCE_ATTEMPT_LIMIT_INVALID',
  );
  if (
    supervisorRuntimeEnabled &&
    (env.FORGEFLOW_SUPERVISOR_ENDPOINT ||
      env.FORGEFLOW_SUPERVISOR_TOKEN ||
      env.FORGEFLOW_SUPERVISOR_MODEL)
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
  const supervisorDirectAdmissionReadyTtlMs = integerValue(
    env.FORGEFLOW_SUPERVISOR_ADMISSION_TTL_MS,
    15 * 60_000,
    30_000,
    24 * 60 * 60_000,
    'SUPERVISOR_ADMISSION_TTL_INVALID',
  );
  const supervisorDirectAdmissionFailureTtlMs = integerValue(
    env.FORGEFLOW_SUPERVISOR_ADMISSION_FAILURE_TTL_MS,
    5 * 60_000,
    10_000,
    supervisorDirectAdmissionReadyTtlMs,
    'SUPERVISOR_ADMISSION_FAILURE_TTL_INVALID',
  );
  const supervisorDirectAdmissionProbe = supervisorDirectAdmissionEnabled
    ? new SupervisorDirectAdmissionProbe({
        baseUrl: requiredText(
          env.FORGEFLOW_LITELLM_BASE_URL,
          'SUPERVISOR_DIRECT_ADMISSION_BASE_URL_REQUIRED',
        ),
        bearerToken: requiredText(
          env.FORGEFLOW_LITELLM_API_KEY,
          'SUPERVISOR_DIRECT_ADMISSION_KEY_REQUIRED',
        ),
        fetchImpl: options.fetchImpl ?? fetch,
        timeoutMs: integerValue(
          env.FORGEFLOW_SUPERVISOR_ADMISSION_TIMEOUT_MS,
          30_000,
          1_000,
          120_000,
          'SUPERVISOR_ADMISSION_TIMEOUT_INVALID',
        ),
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
        requiredText(
          env.FORGEFLOW_LITELLM_BASE_URL,
          'IMPROVEMENT_DIAGNOSIS_BASE_URL_REQUIRED',
        ),
        requiredText(
          env.FORGEFLOW_LITELLM_API_KEY,
          'IMPROVEMENT_DIAGNOSIS_KEY_REQUIRED',
        ),
        repositories.events,
        automation!.resourceState,
        options.fetchImpl ?? fetch,
        integerValue(
          env.FORGEFLOW_IMPROVEMENT_AI_DIAGNOSIS_TIMEOUT_MS,
          60_000,
          1_000,
          300_000,
          'IMPROVEMENT_DIAGNOSIS_TIMEOUT_INVALID',
        ),
        integerValue(
          env.FORGEFLOW_IMPROVEMENT_AI_DIAGNOSIS_MAX_RESOURCE_ATTEMPTS,
          3,
          1,
          20,
          'IMPROVEMENT_DIAGNOSIS_ATTEMPT_LIMIT_INVALID',
        ),
        reconcileSupervisorDirectAdmission,
      ),
    );
  }
  const modelClient = supervisorRuntimeEnabled
    ? new ResourceSelectedSupervisorDecisionClient(
        supervisorResourceSelector!,
        requiredText(env.FORGEFLOW_LITELLM_BASE_URL, 'SUPERVISOR_RESOURCE_BASE_URL_REQUIRED'),
        requiredText(env.FORGEFLOW_LITELLM_API_KEY, 'SUPERVISOR_RESOURCE_KEY_REQUIRED'),
        repositories.events,
        automation!.resourceState,
        options.fetchImpl ?? fetch,
        integerValue(
          env.FORGEFLOW_SUPERVISOR_REQUEST_TIMEOUT_MS,
          60_000,
          1_000,
          300_000,
          'SUPERVISOR_RESOURCE_TIMEOUT_INVALID',
        ),
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
    readHostCacheMaintenance(env.FORGEFLOW_HOST_CACHE_STATE_FILE);
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
      automation && env.FORGEFLOW_AUTOMATION_RUNTIME_ENABLED === 'true',
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
          integerValue(
            env.FORGEFLOW_SUPERVISOR_POLL_MS,
            5_000,
            1_000,
            300_000,
            'SUPERVISOR_POLL_INVALID',
          ),
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
        integerValue(
          env.FORGEFLOW_RESOURCE_REFRESH_MS,
          60_000,
          10_000,
          3_600_000,
          'RESOURCE_REFRESH_INVALID',
        ),
      )
    : undefined;

  const improvementRuntimeEnabled =
    env.FORGEFLOW_IMPROVEMENT_DISCOVERY_ENABLED === 'true' ||
    env.FORGEFLOW_IMPROVEMENT_ADOPTION_ENABLED === 'true' ||
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
        integerValue(
          env.FORGEFLOW_IMPROVEMENT_CYCLE_MS ?? env.FORGEFLOW_IMPROVEMENT_RECONCILE_MS,
          30_000,
          5_000,
          3_600_000,
          'IMPROVEMENT_CYCLE_INTERVAL_INVALID',
        ),
      )
    : undefined;

  let automationCycleRunning = false;
  const automationInterval =
    automation && env.FORGEFLOW_AUTOMATION_RUNTIME_ENABLED === 'true'
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
          integerValue(
            env.FORGEFLOW_AUTOMATION_POLL_MS,
            5_000,
            1_000,
            300_000,
            'AUTOMATION_POLL_INVALID',
          ),
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

  const host = env.FORGEFLOW_HOST ?? '127.0.0.1';
  const port = Number(env.FORGEFLOW_PORT ?? 8420);
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
