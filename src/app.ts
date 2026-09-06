import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';

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
import { MaintenanceCandidateRegistry, type MaintenanceProgram } from './core/adapters/maintenance.js';
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
  LiteLlmResourceStateEffect,
  ResourceLifecycleManager,
  ResourceStateService,
  StaticResourceDirectory,
  providerNativeResources,
  type ResourceProbePort,
} from './core/adapters/resourceDirectory.js';
import type { PlanDeliveryConfig } from './core/domain/delivery.js';
import { ForgeFlowError } from './core/domain/errors.js';
import { EXECUTION_STATUSES, type ExecutionStatus } from './core/domain/execution.js';
import { PLAN_STATUSES, type PlanStatus } from './core/domain/plan.js';
import {
  DEFAULT_AFFINITY_POLICY,
  createExecutionResourceSelection,
  type ExecutionResource,
  type ExecutionResourceSelection,
  type ResourceState,
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
import type { ExecutionProviderPort, WorkspaceProviderPort } from './core/orchestration/contracts.js';
import {
  ResourceSelector,
  selectExecutableProfile,
  type ResourceSelectionCandidate,
} from './core/orchestration/resourceSelector.js';
import {
  RuntimeAdmissionRegistry,
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
import { buildBoundedProjection } from './core/supervisor/projection.js';
import { ResourceSelectedSupervisorDecisionClient } from './core/supervisor/resourceClient.js';
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
  reconcileRuntimeAdmission: () => Promise<void>;
}

export interface ControlPlaneRuntime {
  app: FastifyInstance;
  db: ReturnType<typeof bootstrapForgeFlow>['db'];
  dbFile: string;
  host: string;
  port: number;
  repositories: ForgeFlowRepositories;
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
  };
  automation?: ExecutionAutomationRuntime;
  improvements: MaintenanceImprovementRuntime;
  projectPlanQueue?: ProjectPlanQueueRuntime;
  singleActivePlanEnabled: boolean;
  literalWorktreesEnabled: boolean;
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ForgeFlowError('REQUEST_OBJECT_REQUIRED');
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ForgeFlowError(code);
  return value.trim();
}

function optionalTextArray(value: unknown, code: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ForgeFlowError(code);
  return value.map((item) => requiredText(item, code));
}

function maintenanceProgramBody(value: unknown): MaintenanceProgram {
  const body = bodyRecord(value);
  const scope = body.autonomousScope ?? 'CONSERVATIVE';
  if (scope !== 'CONSERVATIVE' && scope !== 'STANDARD')
    throw new ForgeFlowError('MAINTENANCE_PROGRAM_SCOPE_INVALID');
  const risk = body.candidateRisk ?? 'LOW';
  if (risk !== 'LOW' && risk !== 'MEDIUM' && risk !== 'HIGH')
    throw new ForgeFlowError('CANDIDATE_RISK_INVALID');
  const integer = (input: unknown, fallback: number, code: string) => {
    if (input === undefined || input === null) return fallback;
    if (typeof input !== 'number' || !Number.isInteger(input)) throw new ForgeFlowError(code);
    return input;
  };
  return {
    programId: requiredText(body.programId, 'MAINTENANCE_PROGRAM_REQUIRED'),
    projectKey: requiredText(body.projectKey, 'PLAN_PROJECT_REQUIRED'),
    ...(typeof body.repositoryPath === 'string' && body.repositoryPath.trim()
      ? { repositoryPath: body.repositoryPath.trim() }
      : {}),
    ...(optionalTextArray(body.implementationRoutes, 'MAINTENANCE_IMPLEMENTATION_ROUTE_INVALID')
      ? { implementationRoutes: optionalTextArray(body.implementationRoutes, 'MAINTENANCE_IMPLEMENTATION_ROUTE_INVALID')! }
      : {}),
    ...(optionalTextArray(body.reviewRoutes, 'MAINTENANCE_REVIEW_ROUTE_INVALID')
      ? { reviewRoutes: optionalTextArray(body.reviewRoutes, 'MAINTENANCE_REVIEW_ROUTE_INVALID')! }
      : {}),
    autonomousScope: scope,
    autoMerge: body.autoMerge === true,
    enabled: body.enabled !== false,
    ...(optionalTextArray(body.failureCodePrefixes, 'MAINTENANCE_FAILURE_PREFIX_INVALID')
      ? { failureCodePrefixes: optionalTextArray(body.failureCodePrefixes, 'MAINTENANCE_FAILURE_PREFIX_INVALID')! }
      : {}),
    failureThreshold: integer(body.failureThreshold, 3, 'MAINTENANCE_FAILURE_THRESHOLD_INVALID'),
    recentExecutionLimit: integer(body.recentExecutionLimit, 200, 'MAINTENANCE_EXECUTION_LIMIT_INVALID'),
    candidateRisk: risk,
  };
}

function planDeliveryConfig(value: unknown): PlanDeliveryConfig | undefined {
  if (value === undefined || value === null) return undefined;
  const body = bodyRecord(value);
  if (typeof body.autoMerge !== 'boolean') throw new ForgeFlowError('DELIVERY_AUTO_MERGE_INVALID');
  const mergeMethod = requiredText(body.mergeMethod ?? 'merge', 'DELIVERY_MERGE_METHOD_INVALID');
  if (mergeMethod !== 'merge' && mergeMethod !== 'squash' && mergeMethod !== 'rebase')
    throw new ForgeFlowError('DELIVERY_MERGE_METHOD_INVALID');
  const requiredChecks =
    body.requiredChecks === undefined
      ? []
      : Array.isArray(body.requiredChecks)
        ? body.requiredChecks.map((item) => requiredText(item, 'DELIVERY_REQUIRED_CHECKS_INVALID'))
        : (() => {
            throw new ForgeFlowError('DELIVERY_REQUIRED_CHECKS_INVALID');
          })();
  return {
    remote: requiredText(body.remote ?? 'origin', 'DELIVERY_REMOTE_REQUIRED'),
    branch: requiredText(body.branch, 'DELIVERY_BRANCH_REQUIRED'),
    targetBranch: requiredText(body.targetBranch ?? 'main', 'DELIVERY_TARGET_BRANCH_REQUIRED'),
    autoMerge: body.autoMerge,
    mergeMethod,
    requiredChecks,
  };
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

function statusFor(error: ForgeFlowError): number {
  if (error.code.endsWith('_NOT_FOUND')) return 404;
  if (
    error.code.includes('STALE') ||
    error.code.includes('DUPLICATE') ||
    error.code.includes('CONFLICT') ||
    error.code.includes('ACTIVE')
  )
    return 409;
  if (error.code.includes('UNAVAILABLE') || error.code.includes('DISABLED')) return 503;
  return 400;
}

async function buildExecutionAutomation(
  env: NodeJS.ProcessEnv,
  repositories: ForgeFlowRepositories,
  fetchImpl: typeof fetch,
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
  const automationProjectKeys = commaList(env.FORGEFLOW_AUTOMATION_PROJECTS);
  const literalWorktreesEnabled = env.FORGEFLOW_LITERAL_WORKTREES_ENABLED === 'true';
  const literalWorktreeProjectKeys = literalWorktreesEnabled
    ? commaList(env.FORGEFLOW_LITERAL_WORKTREE_PROJECTS)
    : [];
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
  const resourceProbe: ResourceProbePort = {
    probe: async (resource: ExecutionResource): Promise<boolean> => {
      if (resource.resourceId === 'chatgpt-business-primary') return businessReady;
      if (resource.resourceId === 'antigravity-primary') return antigravityReady;
      const binding = resource.bindings.find(
        (item) => item.enabled && item.routeModel && item.ready,
      );
      if (!binding?.routeModel) return false;
      try {
        const response = await fetchImpl(liteLlmBaseUrl.replace(/\/$/, '') + '/chat/completions', {
          method: 'POST',
          headers: {
            ['Author' + 'ization']: 'Bearer ' + liteLlmApiKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: binding.routeModel,
            messages: [{ role: 'user', content: 'Reply with OK.' }],
            max_tokens: 1,
            user: 'forgeflow-resource-probe',
          }),
          signal: AbortSignal.timeout(30_000),
        });
        return response.ok;
      } catch {
        return false;
      }
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
      env.FORGEFLOW_ANTIGRAVITY_UID ?? env.FORGEFLOW_ANTIGRAVITY_UID,
      1001,
      1,
      2 ** 31 - 1,
      'ANTIGRAVITY_UID_INVALID',
    ),
    gid: integerValue(
      env.FORGEFLOW_ANTIGRAVITY_GID ?? env.FORGEFLOW_ANTIGRAVITY_GID,
      1002,
      1,
      2 ** 31 - 1,
      'ANTIGRAVITY_GID_INVALID',
    ),
    workspaceGid,
    user: env.FORGEFLOW_ANTIGRAVITY_USER ?? env.FORGEFLOW_ANTIGRAVITY_USER ?? 'dev',
    printTimeout:
      env.FORGEFLOW_ANTIGRAVITY_PRINT_TIMEOUT ??
      env.FORGEFLOW_ANTIGRAVITY_PRINT_TIMEOUT ??
      '20m',
    sandboxWrapper:
      env.FORGEFLOW_ANTIGRAVITY_SANDBOX_WRAPPER ??
      path.join(process.cwd(), 'model-control-plane/scripts/run-antigravity-sandbox.sh'),
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

  const probeAdmissionCandidate = async (candidate: ResourceSelectionCandidate): Promise<void> => {
    const key = runtimeAdmissionKey(candidate);
    const probeId =
      'runtime-admission-' + createHash('sha256').update(key).digest('hex').slice(0, 20);
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
        workspace: prepared.workspace,
        sourceRevision: prepared.sourceRevision,
      });
      const clean = prepared.git(['status', '--porcelain=v1']) === '';
      const head = prepared.git(['rev-parse', '--verify', 'HEAD^{commit}']);
      const ready = result.ready && clean && head === prepared.sourceRevision;
      runtimeAdmission.record(candidate, {
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
      runtimeAdmission.record(candidate, {
        ready: false,
        errorCode: error instanceof ForgeFlowError ? error.code : 'RUNTIME_ADMISSION_PROBE_FAILED',
      });
    } finally {
      if (probeRoot) fs.rmSync(probeRoot, { recursive: true, force: true });
    }
  };

  let runtimeAdmissionCycle: Promise<void> | undefined;
  const reconcileRuntimeAdmission = async (): Promise<void> => {
    if (!runtimeAdmissionEnabled) return;
    if (runtimeAdmissionCycle) return await runtimeAdmissionCycle;
    runtimeAdmissionCycle = (async () => {
      const now = Date.now();
      const queue = admissionCandidates().filter((candidate) =>
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
      for (const candidate of queue) await probeAdmissionCandidate(candidate);
    })();
    try {
      await runtimeAdmissionCycle;
    } finally {
      runtimeAdmissionCycle = undefined;
    }
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
    maxStallRecoveries: integerValue(
      env.FORGEFLOW_MAX_STALL_RECOVERIES,
      2,
      0,
      10,
      'EXECUTION_STALL_RECOVERY_LIMIT_INVALID',
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
  const antigravityProjectKeys = new Set(
    commaList(env.FORGEFLOW_ANTIGRAVITY_PROJECTS),
  );
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
          maxParallelWorkItems: literalProjectSet.has(projectKey) ? maxParallelWorkItems : 1,
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
    reconcileRuntimeAdmission,
  };
}

export async function buildControlPlane(
  options: BuildControlPlaneOptions = {},
): Promise<ControlPlaneRuntime> {
  const env = options.env ?? process.env;
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
      allowedProjectKeys: commaList(env.FORGEFLOW_IMPROVEMENT_PROJECTS),
      selfChangeEnabled: env.FORGEFLOW_IMPROVEMENT_SELF_CHANGE_ENABLED === 'true',
      selfProjectKey: env.FORGEFLOW_IMPROVEMENT_SELF_PROJECT_KEY ?? 'forgeflow',
      selfRepositoryPath: env.FORGEFLOW_IMPROVEMENT_SELF_REPOSITORY ?? process.cwd(),
    },
  );
  const automation = await buildExecutionAutomation(env, repositories, options.fetchImpl ?? fetch);
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
          if (literalProjects.has(plan.projectKey))
            await automation.planWorktreeManager!.retirePlan(rootPlanId, automation.workspaceUid);
        },
      });
      for (const lease of repositories.projectPlans.listLeases()) {
        if (!lease.activeRootPlanId) continue;
        const plan = repositories.plans.getPlan(lease.activeRootPlanId);
        if (literalProjects.has(plan.projectKey))
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
  const supervisorResourceSelector = supervisorRuntimeEnabled
    ? new ResourceSelector(automation!.resources, DEFAULT_AFFINITY_POLICY)
    : undefined;
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
  const availableSupervisorResourceIds = (): string[] =>
    automation
      ? automation.resources
          .listResources()
          .filter(
            (resource) =>
              selectExecutableProfile([resource], {
                phase: 'SUPERVISE',
                includeProviderNativeProfiles: false,
                policy: {
                  allowProviderNative: false,
                  allowedTransports: ['LITELLM_MANAGED'],
                  isAllowed: (candidate) => Boolean(candidate.profile.routeModel),
                },
              }).status === 'SELECTED',
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
  reconcileSupervisorResourceAvailability();
  const affinityEntries = [
    ...DEFAULT_AFFINITY_POLICY.capabilities.IMPLEMENTATION,
    ...DEFAULT_AFFINITY_POLICY.capabilities.REASONING,
    ...(DEFAULT_AFFINITY_POLICY.providerNativeProfiles ?? []),
  ];
  const resourceProjection = (resource: ExecutionResource) => {
    const override = repositories.resourceStateOverrides.get(resource.resourceId);
    return {
      resourceId: resource.resourceId,
      displayName: resource.displayName ?? resource.providerId ?? resource.resourceId,
      providerKey: resource.providerId ?? null,
      resourceTier: resource.resourceTier,
      resourceSequence: resource.resourceSequence,
      state: resource.state,
      transport: resource.bindings[0]?.transport ?? 'LITELLM_MANAGED',
      modelBindings: resource.bindings.map((binding) => {
        const affinity = affinityEntries.find(
          (item) =>
            item.modelFamily === binding.modelFamily &&
            (!binding.agentBackend || item.agentBackend === binding.agentBackend),
        );
        return {
          modelFamily: binding.modelFamily,
          capability: affinity?.capability ?? null,
          agentBackend: binding.agentBackend ?? affinity?.agentBackend ?? null,
          modelRank: affinity?.modelRank ?? null,
          enabled: binding.enabled,
          ready: binding.ready,
          deploymentId: binding.deploymentId ?? null,
          routeModel: binding.routeModel ?? null,
          protocol: binding.protocol ?? null,
        };
      }),
      lastNormalizedFailure: override?.reasonClass
        ? {
            reasonClass: override.reasonClass,
            sanitizedReason: override.sanitizedReason ?? null,
            changedAt: override.updatedAt,
            source: override.source,
          }
        : null,
      suspendedUntil: override?.suspendedUntil ?? null,
      version: override?.version ?? 0,
    };
  };
  const executionProjection = (execution: ReturnType<ForgeFlowRepositories['executions']['get']>) => ({
    ...execution,
    resourceSelection: repositories.resourceSelections.get(execution.identity.executionId) ?? null,
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

  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'forgeflow-control-plane',
    apiVersion: 1,
    mode: 'autonomous-engineering',
    database: boot.dbFile,
    workspaceStorage: workspaceStorage(),
    hostCacheMaintenance: hostCacheMaintenance(),
    planScheduling: {
      singleActivePlanEnabled,
      literalWorktreesEnabled,
      leases: projectPlanQueue
        ? repositories.projectPlans.listLeases().map((lease) => ({
            ...lease,
            queuedPlans: repositories.projectPlans.listQueue(lease.projectKey).length,
          }))
        : [],
    },
    supervisorRuntime: {
      enabled: supervisorRuntimeEnabled,
      resourceSelectorEnabled: Boolean(modelClient),
      readinessAuthority: supervisorRuntimeEnabled ? 'DIRECT_PROTOCOL_FEEDBACK' : 'DISABLED',
      resourceWakeMode: 'EVENT_DRIVEN_WITH_15M_FALLBACK',
      maxResourceAttempts: supervisorMaxResourceAttempts,
    },
    improvementRuntime: improvements.status(),
    executionRuntime: {
      enabled: Boolean(automation),
      autonomousPolling: Boolean(automation && env.FORGEFLOW_AUTOMATION_RUNTIME_ENABLED === 'true'),
      resourceSelectorEnabled: automation?.resourceSelectorEnabled ?? false,
      resourceCount: automation?.resources.listResources().length ?? 0,
      runtimeAdmission: automation
        ? {
            enabled: automation.runtimeAdmissionEnabled,
            ...automation.runtimeAdmission.summary(),
          }
        : {
            enabled: false,
            checked: 0,
            ready: 0,
            unready: 0,
            implementationReady: 0,
            reviewReady: 0,
          },
      routingAuthority: automation?.resourceSelectorEnabled
        ? 'RESOURCE_SELECTOR'
        : 'LEGACY_ROUTE_LIST',
      compatibilityImplementationRoutes: automation?.compatibilityImplementationRoutes ?? [],
      compatibilityReviewRoutes: automation?.compatibilityReviewRoutes ?? [],
      implementationRoutes: automation?.implementationRoutes ?? [],
      reviewRoutes: automation?.reviewRoutes ?? [],
      automationProjectKeys: automation?.automationProjectKeys ?? [],
      literalWorktreeProjectKeys: automation?.literalWorktreeProjectKeys ?? [],
      requireDelivery: automation?.requireDelivery ?? false,
    },
  }));

  app.get('/api/v1/maintenance/programs', async () => ({
    items: improvementRegistry.listPrograms(),
  }));

  app.post('/api/v1/maintenance/programs/:programId/state', async (request) => {
    const programId = requiredText(
      (request.params as { programId?: string }).programId,
      'MAINTENANCE_PROGRAM_REQUIRED',
    );
    const body = bodyRecord(request.body);
    if (typeof body.enabled !== 'boolean')
      throw new ForgeFlowError('MAINTENANCE_PROGRAM_STATE_INVALID');
    return { program: improvementRegistry.setProgramEnabled(programId, body.enabled) };
  });

  app.get('/api/v1/improvements', async (request) => {
    const query = request.query as { programId?: string; status?: string; limit?: string };
    const limit = integerValue(query.limit, 100, 1, 1_000, 'CANDIDATE_LIST_LIMIT_INVALID');
    const status = query.status;
    const allowed = ['DISCOVERED', 'QUEUED', 'ADOPTED', 'REJECTED', 'STALE', 'COMPLETED'];
    if (status && !allowed.includes(status)) throw new ForgeFlowError('CANDIDATE_STATUS_INVALID');
    const items = improvementRegistry.list({
      limit,
      ...(query.programId ? { programId: query.programId } : {}),
      ...(status ? { status: status as import('./core/adapters/maintenance.js').ImprovementCandidate['status'] } : {}),
    });
    return { items, count: items.length, runtime: improvements.status() };
  });

  app.get('/api/v1/improvements/:candidateId', async (request) => {
    const candidateId = requiredText(
      (request.params as { candidateId?: string }).candidateId,
      'CANDIDATE_ID_REQUIRED',
    );
    const candidate = improvementRegistry.get(candidateId);
    return {
      candidate,
      program: improvementRegistry.getProgram(candidate.programId),
      plan: candidate.planId ? planView(candidate.planId) : null,
    };
  });

  app.post('/api/v1/improvements/discover', async (request) => {
    const program = maintenanceProgramBody(request.body);
    const items = improvements.discover(program);
    return { program: improvementRegistry.getProgram(program.programId), items, count: items.length };
  });

  app.post('/api/v1/improvements/cycle', async () => improvements.runCycle());

  app.post('/api/v1/improvements/:candidateId/adopt', async (request) => {
    const candidateId = requiredText(
      (request.params as { candidateId?: string }).candidateId,
      'CANDIDATE_ID_REQUIRED',
    );
    const body = request.body === undefined || request.body === null ? {} : bodyRecord(request.body);
    const priority =
      body.priority === undefined
        ? undefined
        : typeof body.priority === 'number' && Number.isInteger(body.priority)
          ? body.priority
          : (() => { throw new ForgeFlowError('PROJECT_PLAN_PRIORITY_INVALID'); })();
    const result = improvements.adopt(candidateId, {
      ...(typeof body.repositoryPath === 'string' && body.repositoryPath.trim()
        ? { repositoryPath: body.repositoryPath.trim() }
        : {}),
      ...(typeof body.baseRevision === 'string' && body.baseRevision.trim()
        ? { baseRevision: body.baseRevision.trim() }
        : {}),
      ...(priority === undefined ? {} : { priority }),
      acknowledgeHighRisk: body.acknowledgeHighRisk === true,
      ...(body.delivery === undefined ? {} : { delivery: planDeliveryConfig(body.delivery)! }),
    });
    return result;
  });

  app.post('/api/v1/improvements/:candidateId/reconcile', async (request) => {
    const candidateId = requiredText(
      (request.params as { candidateId?: string }).candidateId,
      'CANDIDATE_ID_REQUIRED',
    );
    return { candidate: improvements.reconcile(candidateId) };
  });

  app.post('/api/v1/improvements/:candidateId/reject', async (request) => {
    const candidateId = requiredText(
      (request.params as { candidateId?: string }).candidateId,
      'CANDIDATE_ID_REQUIRED',
    );
    return { candidate: improvementRegistry.transition(candidateId, 'REJECTED') };
  });

  app.get('/api/v1/storage', async () => ({
    storage: workspaceStorage(),
    hostCacheMaintenance: hostCacheMaintenance(),
  }));

  app.post('/api/v1/storage/reconcile', async () => ({
    storage: workspaceStorage(),
    hostCacheMaintenance: hostCacheMaintenance(),
    cleanup: await runWorkspaceStorageMaintenance(),
  }));

  app.get('/api/v1/runtime-admission', async () => {
    const runtime = requireAutomation();
    return {
      enabled: runtime.runtimeAdmissionEnabled,
      summary: runtime.runtimeAdmission.summary(),
      items: runtime.runtimeAdmission.list().map((item) => ({
        agentBackend: item.agentBackend,
        transport: item.transport,
        resourceId: item.resourceId,
        bindingId: item.bindingId,
        modelFamily: item.modelFamily,
        routeModel: item.routeModel ?? null,
        ready: item.ready,
        checkedAt: item.checkedAt,
        errorCode: item.errorCode ?? null,
      })),
    };
  });

  app.get('/api/v1/resources', async () => {
    const runtime = requireAutomation();
    if (runtime.resourceSelectorEnabled) await runtime.liteLlmResources.refresh();
    return {
      items: runtime.resources.listResources().map(resourceProjection),
      count: runtime.resources.listResources().length,
    };
  });

  app.post('/api/v1/resources/:resourceId/state', async (request) => {
    const runtime = requireAutomation();
    const resourceId = requiredText(
      (request.params as { resourceId?: string }).resourceId,
      'RESOURCE_ID_REQUIRED',
    );
    const body = bodyRecord(request.body);
    const state = requiredText(body.state, 'RESOURCE_STATE_REQUIRED').toUpperCase();
    if (!['ACTIVE', 'SUSPENDED', 'DISABLED'].includes(state))
      throw new ForgeFlowError('RESOURCE_STATE_INVALID');
    const resource = runtime.resources
      .listResources()
      .find((item) => item.resourceId === resourceId);
    if (!resource) throw new ForgeFlowError('RESOURCE_NOT_FOUND');
    const expectedVersion =
      body.expectedVersion === undefined || body.expectedVersion === null
        ? undefined
        : integerValue(
            String(body.expectedVersion),
            0,
            0,
            Number.MAX_SAFE_INTEGER,
            'RESOURCE_OVERRIDE_VERSION_INVALID',
          );
    const result = runtime.resourceState.manual(resourceId, state as ResourceState, {
      ...(typeof body.reason === 'string' && body.reason.trim()
        ? { reason: body.reason.trim() }
        : {}),
      ...(typeof body.suspendedUntil === 'string' && body.suspendedUntil.trim()
        ? { suspendedUntil: body.suspendedUntil.trim() }
        : {}),
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    });
    if (result.status === 'rejected') throw new ForgeFlowError(result.reason ?? 'STALE_RESOURCE_STATE');
    const projected = runtime.resources
      .listResources()
      .find((item) => item.resourceId === resourceId);
    if (!projected) throw new ForgeFlowError('RESOURCE_NOT_FOUND');
    return {
      resource: resourceProjection(projected),
      mutation: result.status,
    };
  });

  app.post('/api/v1/resources/:resourceId/bindings/:bindingId/state', async (request) => {
    const runtime = requireAutomation();
    const params = request.params as { resourceId?: string; bindingId?: string };
    const resourceId = requiredText(params.resourceId, 'RESOURCE_ID_REQUIRED');
    const bindingId = requiredText(params.bindingId, 'RESOURCE_BINDING_ID_REQUIRED');
    const body = bodyRecord(request.body);
    const state = requiredText(body.state, 'RESOURCE_BINDING_STATE_REQUIRED').toUpperCase();
    if (state !== 'ACTIVE' && state !== 'DISABLED')
      throw new ForgeFlowError('RESOURCE_BINDING_STATE_INVALID');
    const resource = runtime.resources
      .listResources()
      .find((item) => item.resourceId === resourceId);
    if (!resource) throw new ForgeFlowError('RESOURCE_NOT_FOUND');
    const binding = resource.bindings.find((item) => item.bindingId === bindingId);
    if (!binding) throw new ForgeFlowError('RESOURCE_BINDING_NOT_FOUND');
    if (!runtime.resourceStateEffect.applyBinding || !binding.deploymentId)
      throw new ForgeFlowError('RESOURCE_BINDING_STATE_UNSUPPORTED');
    await runtime.resourceStateEffect.applyBinding(resource, binding, state);
    await runtime.liteLlmResources.refresh();
    const resourceWake = reconcileSupervisorResourceAvailability();
    const projected = runtime.resources
      .listResources()
      .find((item) => item.resourceId === resourceId);
    if (!projected) throw new ForgeFlowError('RESOURCE_NOT_FOUND');
    return { resource: resourceProjection(projected), bindingId, state, resourceWake };
  });

  const planView = (planId: string) => {
    const plan = repositories.plans.getPlan(planId);
    const graph = repositories.plans.getActiveGraphVersion(planId);
    return {
      plan,
      delivery: plan.delivery ?? null,
      graph,
      workItems: graph ? repositories.plans.listWorkItems(planId, graph.graphVersionId) : [],
      executions: repositories.executions.listByPlan(planId).map(executionProjection),
      reviews: repositories.reviews.listByPlan(planId),
      sessions: repositories.sessions.listByPlan(planId),
      supervisor: repositories.supervisors.getByPlanId(planId),
    };
  };

  app.get('/api/v1/plans', async (request) => {
    const query = request.query as { limit?: string; status?: string; view?: string };
    const limit = integerValue(query.limit, 100, 1, 1000, 'PLAN_LIST_LIMIT_INVALID');
    const status = query.status;
    if (status && !(PLAN_STATUSES as readonly string[]).includes(status))
      throw new ForgeFlowError('PLAN_STATUS_INVALID');
    if (query.view && query.view !== 'full' && query.view !== 'summary')
      throw new ForgeFlowError('PLAN_LIST_VIEW_INVALID');
    const plans = repositories.plans.listPlans({
      limit,
      ...(status ? { status: status as PlanStatus } : {}),
    });
    const items =
      query.view === 'summary'
        ? plans.map((plan) => {
            const graph = repositories.plans.getActiveGraphVersion(plan.planId);
            return {
              plan,
              delivery: plan.delivery ?? null,
              graph,
              workItems: graph
                ? repositories.plans.listWorkItems(plan.planId, graph.graphVersionId)
                : [],
              executions: repositories.executions
                .listByPlan(plan.planId)
                .filter((execution) => ['QUEUED', 'RUNNING', 'BLOCKED'].includes(execution.status))
                .map(executionProjection),
            };
          })
        : plans.map((plan) => planView(plan.planId));
    return { items, count: items.length };
  });

  app.get('/api/v1/projects/:projectKey/plan-queue', async (request) => {
    requireProjectPlanQueue();
    const projectKey = requiredText(
      (request.params as { projectKey?: string }).projectKey,
      'PLAN_PROJECT_REQUIRED',
    );
    return {
      projectKey,
      lease: repositories.projectPlans.getLease(projectKey) ?? null,
      items: repositories.projectPlans.listQueue(projectKey),
    };
  });

  app.post('/api/v1/plans/:planId/reprioritize', async (request) => {
    requireProjectPlanQueue();
    const planId = requiredText((request.params as { planId?: string }).planId, 'PLAN_ID_REQUIRED');
    const body = bodyRecord(request.body);
    const priority = body.priority;
    if (typeof priority !== 'number' || !Number.isInteger(priority))
      throw new ForgeFlowError('PROJECT_PLAN_PRIORITY_INVALID');
    const result = repositories.projectPlans.reprioritize(planId, priority);
    if (result.status === 'rejected')
      throw new ForgeFlowError(result.reason ?? 'PROJECT_PLAN_REPRIORITIZE_FAILED');
    return { queueEntry: result.value, mutation: result.status };
  });

  app.post('/api/v1/plans/:planId/cancel-queued', async (request) => {
    const runtime = requireProjectPlanQueue();
    const planId = requiredText((request.params as { planId?: string }).planId, 'PLAN_ID_REQUIRED');
    runtime.cancelQueued(planId);
    return {
      plan: repositories.plans.getPlan(planId),
      queueEntry: repositories.projectPlans.getQueueEntry(planId) ?? null,
    };
  });

  app.post('/api/v1/plans', async (request, reply) => {
    const body = bodyRecord(request.body);
    const idempotencyKey = requiredText(
      request.headers['idempotency-key'] ?? body.idempotencyKey,
      'PLAN_IDEMPOTENCY_REQUIRED',
    );
    const delivery = planDeliveryConfig(body.delivery);
    const planResult = kernels.plan.createPlan({
      idempotencyKey,
      projectKey: requiredText(body.projectKey, 'PLAN_PROJECT_REQUIRED'),
      objective: requiredText(body.objective, 'PLAN_OBJECTIVE_REQUIRED'),
      repositoryPath: requiredText(body.repositoryPath, 'PLAN_REPOSITORY_REQUIRED'),
      baseRevision: requiredText(body.baseRevision, 'PLAN_BASE_REVISION_REQUIRED'),
      ...(delivery ? { delivery } : {}),
    });
    const plan = planResult.value;
    if (!plan) throw new ForgeFlowError('PLAN_CREATE_FAILED');
    const rawItems = Array.isArray(body.workItems)
      ? body.workItems
      : [
          {
            itemKey: 'objective',
            title: 'Complete objective',
            objective: plan.objective,
            dependencies: [],
            acceptanceCriteria: [],
          },
        ];
    const graph = kernels.plan.ensureReadyGraph(
      plan.planId,
      rawItems.map((item) => {
        const value = bodyRecord(item);
        return {
          itemKey: requiredText(value.itemKey, 'GRAPH_ITEM_KEY_REQUIRED'),
          title: requiredText(value.title, 'GRAPH_TITLE_REQUIRED'),
          objective: requiredText(value.objective, 'GRAPH_ITEM_OBJECTIVE_REQUIRED'),
          dependencies: Array.isArray(value.dependencies)
            ? value.dependencies.map((entry) => requiredText(entry, 'GRAPH_DEPENDENCY_INVALID'))
            : [],
          acceptanceCriteria: Array.isArray(value.acceptanceCriteria)
            ? value.acceptanceCriteria.map((entry) =>
                requiredText(entry, 'GRAPH_ACCEPTANCE_INVALID'),
              )
            : [],
          parallelSafe: value.parallelSafe === true,
          writeScopes: Array.isArray(value.writeScopes)
            ? value.writeScopes.map((entry) =>
                requiredText(entry, 'WORK_ITEM_WRITE_SCOPES_INVALID'),
              )
            : [],
          conflictKeys: Array.isArray(value.conflictKeys)
            ? value.conflictKeys.map((entry) =>
                requiredText(entry, 'WORK_ITEM_CONFLICT_KEYS_INVALID'),
              )
            : [],
        };
      }),
      { activate: !singleActivePlanEnabled },
    );
    const scheduling = projectPlanQueue
      ? projectPlanQueue.scheduleRootPlan(
          plan.planId,
          body.priority === undefined
            ? 0
            : typeof body.priority === 'number' && Number.isInteger(body.priority)
              ? body.priority
              : (() => {
                  throw new ForgeFlowError('PROJECT_PLAN_PRIORITY_INVALID');
                })(),
        )
      : undefined;
    if (
      scheduling?.status === 'ACTIVE' &&
      automation?.planWorktreeManager &&
      automation.literalWorktreeProjectKeys.includes(plan.projectKey)
    )
      await automation.planWorktreeManager.ensurePlanActivated(plan.planId);
    let supervisor = repositories.supervisors.getByPlanId(plan.planId);
    if (!projectPlanQueue) {
      supervisor = supervisor ?? repositories.supervisors.create({ planId: plan.planId }).value;
      if (!supervisor) throw new ForgeFlowError('SUPERVISOR_CREATE_FAILED');
      if (supervisor.status === 'CREATED')
        repositories.supervisors.updateStatus(supervisor.supervisorId, 'ACTIVE');
      supervisor = repositories.supervisors.getById(supervisor.supervisorId);
    } else if (scheduling?.status === 'ACTIVE') {
      supervisor = repositories.supervisors.getByPlanId(plan.planId);
    }
    reply.code(planResult.status === 'created' ? 201 : 200);
    return {
      plan: repositories.plans.getPlan(plan.planId),
      graph,
      supervisor: supervisor ?? null,
      ...(scheduling ? { scheduling } : {}),
    };
  });

  app.post('/api/v1/plans/:planId/children', async (request, reply) => {
    const parentPlanId = requiredText(
      (request.params as { planId?: string }).planId,
      'PLAN_ID_REQUIRED',
    );
    const body = bodyRecord(request.body);
    const relation = requiredText(body.relation ?? 'FOLLOW_UP', 'CHILD_RELATION_INVALID');
    if (
      relation !== 'SYSTEM_REPAIR' &&
      relation !== 'INFRASTRUCTURE_REPAIR' &&
      relation !== 'FOLLOW_UP'
    )
      throw new ForgeFlowError('CHILD_RELATION_INVALID');
    const parent = repositories.plans.getPlan(parentPlanId);
    const child = kernels.plan.createChildPlan({
      parentPlanId,
      childPlanId: requiredText(body.childPlanId, 'CHILD_PLAN_ID_REQUIRED'),
      repositoryPath: requiredText(
        body.repositoryPath ?? parent.repositoryPath,
        'CHILD_REPOSITORY_REQUIRED',
      ),
      objective: requiredText(body.objective, 'CHILD_OBJECTIVE_REQUIRED'),
      relation,
    });
    const rawItems = Array.isArray(body.workItems)
      ? body.workItems
      : [
          {
            itemKey: 'objective',
            title: 'Complete child objective',
            objective: child.plan.objective,
            dependencies: [],
            acceptanceCriteria: [],
          },
        ];
    const graph = kernels.plan.ensureReadyGraph(
      child.plan.planId,
      rawItems.map((item) => {
        const value = bodyRecord(item);
        return {
          itemKey: requiredText(value.itemKey, 'GRAPH_ITEM_KEY_REQUIRED'),
          title: requiredText(value.title, 'GRAPH_TITLE_REQUIRED'),
          objective: requiredText(value.objective, 'GRAPH_ITEM_OBJECTIVE_REQUIRED'),
          dependencies: Array.isArray(value.dependencies)
            ? value.dependencies.map((entry) => requiredText(entry, 'GRAPH_DEPENDENCY_INVALID'))
            : [],
          acceptanceCriteria: Array.isArray(value.acceptanceCriteria)
            ? value.acceptanceCriteria.map((entry) =>
                requiredText(entry, 'GRAPH_ACCEPTANCE_INVALID'),
              )
            : [],
          parallelSafe: value.parallelSafe === true,
          writeScopes: Array.isArray(value.writeScopes)
            ? value.writeScopes.map((entry) =>
                requiredText(entry, 'WORK_ITEM_WRITE_SCOPES_INVALID'),
              )
            : [],
          conflictKeys: Array.isArray(value.conflictKeys)
            ? value.conflictKeys.map((entry) =>
                requiredText(entry, 'WORK_ITEM_CONFLICT_KEYS_INVALID'),
              )
            : [],
        };
      }),
    );
    const delivery = planDeliveryConfig(body.delivery);
    if (delivery) repositories.plans.attachDelivery(child.plan.planId, delivery);
    let supervisor = repositories.supervisors.getByPlanId(child.plan.planId);
    if (!supervisor) {
      supervisor = repositories.supervisors.create({ planId: child.plan.planId }).value;
      if (!supervisor) throw new ForgeFlowError('SUPERVISOR_CREATE_FAILED');
      if (supervisor.status === 'CREATED')
        repositories.supervisors.updateStatus(supervisor.supervisorId, 'ACTIVE');
    }
    reply.code(201);
    return {
      plan: repositories.plans.getPlan(child.plan.planId),
      graph,
      relationshipId: child.relationshipId,
      supervisor: repositories.supervisors.getByPlanId(child.plan.planId),
      statusUrl: '/api/v1/plans/' + encodeURIComponent(child.plan.planId),
    };
  });

  app.post('/api/v1/plans/:planId/delivery', async (request, reply) => {
    const planId = requiredText((request.params as { planId?: string }).planId, 'PLAN_ID_REQUIRED');
    const config = planDeliveryConfig(request.body);
    if (!config) throw new ForgeFlowError('PLAN_DELIVERY_REQUIRED');
    const result = repositories.plans.attachDelivery(planId, config);
    reply.code(result.status === 'created' ? 201 : 200);
    return {
      planId,
      delivery: result.value,
      statusUrl: '/api/v1/plans/' + encodeURIComponent(planId),
    };
  });

  app.get('/api/v1/plans/:planId', async (request) => {
    const planId = requiredText((request.params as { planId?: string }).planId, 'PLAN_ID_REQUIRED');
    return planView(planId);
  });

  app.post('/api/v1/plans/:planId/run', async (request) => {
    const planId = requiredText((request.params as { planId?: string }).planId, 'PLAN_ID_REQUIRED');
    return await requireAutomation().plans.runPlan(planId);
  });

  app.post('/api/v1/plans/:planId/reconcile', async (request, reply) => {
    const planId = requiredText((request.params as { planId?: string }).planId, 'PLAN_ID_REQUIRED');
    const body = request.body === undefined ? {} : bodyRecord(request.body);
    const mode =
      body.mode === undefined ? 'auto' : requiredText(body.mode, 'PLAN_RECONCILE_MODE_INVALID');
    const result = await requireAutomation().plans.reconcilePlan(planId, mode);
    reply.code(202);
    return { ...result, statusUrl: '/api/v1/plans/' + encodeURIComponent(planId) };
  });

  app.get('/api/v1/executions', async (request) => {
    const query = request.query as {
      limit?: string;
      planId?: string;
      status?: string;
      view?: string;
    };
    const limit = integerValue(query.limit, 100, 1, 1000, 'EXECUTION_LIST_LIMIT_INVALID');
    const status = query.status;
    if (status && !(EXECUTION_STATUSES as readonly string[]).includes(status))
      throw new ForgeFlowError('EXECUTION_STATUS_INVALID');
    if (query.view && query.view !== 'dashboard') throw new ForgeFlowError('EXECUTION_LIST_VIEW_INVALID');
    const items = repositories.executions.list({
      limit,
      ...(query.planId ? { planId: requiredText(query.planId, 'EXECUTION_PLAN_REQUIRED') } : {}),
      ...(status ? { status: status as ExecutionStatus } : {}),
    });
    if (query.view !== 'dashboard') {
      const projected = items.map(executionProjection);
      return { items: projected, count: projected.length };
    }

    const enriched = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(8, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        const execution = items[index]!;
        const telemetry = await executionTelemetry.project({
          executionId: execution.identity.executionId,
          status: execution.status,
          createdAt: execution.createdAt,
          updatedAt: execution.updatedAt,
        });
        const selection = repositories.resourceSelections.get(execution.identity.executionId);
        const providerNativeRoute =
          selection?.transport === 'PROVIDER_NATIVE'
            ? {
                deploymentId: 'provider-native:' + selection.resourceId,
                providerKey: selection.resourceId,
                model: selection.modelFamily,
                modelGroup: selection.modelFamily,
                commercialType: 'SUBSCRIPTION',
                supplyOrigin: 'OFFICIAL',
              }
            : execution.identity.route === 'codex-business-review' && automation
              ? {
                  deploymentId: 'provider-native:openai-business',
                  providerKey: 'openai-business',
                  model:
                    automation.routeModels[execution.identity.route] ?? execution.identity.route,
                  modelGroup: execution.identity.route,
                  commercialType: 'SUBSCRIPTION',
                  supplyOrigin: 'OFFICIAL',
                }
              : undefined;
        enriched[index] = {
          ...executionProjection(execution),
          telemetry:
            telemetry.usage || telemetry.route || telemetry.routeUsage.length > 0
              ? telemetry
              : { ...telemetry, ...(providerNativeRoute ? { route: providerNativeRoute } : {}) },
        };
      }
    });
    await Promise.all(workers);
    return { items: enriched, count: enriched.length };
  });

  app.get('/api/v1/executions/:executionId', async (request) => {
    const executionId = requiredText(
      (request.params as { executionId?: string }).executionId,
      'EXECUTION_ID_REQUIRED',
    );
    return {
      execution: executionProjection(repositories.executions.get(executionId)),
      resourceSelection: repositories.resourceSelections.get(executionId) ?? null,
      session: repositories.sessions.getOptional(executionId),
      evidence: repositories.evidence.listByExecution(executionId),
      reviewAsImplementation: repositories.reviews.findByImplementationExecution(executionId),
      reviewAsReviewer: repositories.reviews.findByReviewerExecution(executionId),
    };
  });

  app.post('/api/v1/executions/:executionId/run', async (request) => {
    const executionId = requiredText(
      (request.params as { executionId?: string }).executionId,
      'EXECUTION_ID_REQUIRED',
    );
    return await requireAutomation().worker.runExecution(executionId);
  });

  app.post('/api/v1/executions/:executionId/continue', async (request) => {
    const executionId = requiredText(
      (request.params as { executionId?: string }).executionId,
      'EXECUTION_ID_REQUIRED',
    );
    const body = request.body === undefined ? {} : bodyRecord(request.body);
    const instruction =
      typeof body.instruction === 'string' && body.instruction.trim()
        ? body.instruction.trim()
        : undefined;
    if (body.interruptCurrent !== undefined && typeof body.interruptCurrent !== 'boolean')
      throw new ForgeFlowError('EXECUTION_CONTINUE_INTERRUPT_INVALID');
    return await requireAutomation().worker.continueExecution(executionId, instruction, {
      interruptCurrent: body.interruptCurrent === true,
    });
  });

  app.post('/api/v1/executions/:executionId/adopt-workspace', async (request) => {
    const executionId = requiredText(
      (request.params as { executionId?: string }).executionId,
      'EXECUTION_ID_REQUIRED',
    );
    const body = request.body === undefined ? {} : bodyRecord(request.body);
    const idempotencyKey = requiredText(
      request.headers['idempotency-key'] ?? body.idempotencyKey,
      'OPERATOR_ADOPTION_IDEMPOTENCY_REQUIRED',
    );
    const reason = requiredText(body.reason, 'OPERATOR_ADOPTION_REASON_INVALID');
    return await requireAutomation().worker.adoptPausedImplementation(
      executionId,
      idempotencyKey,
      reason,
    );
  });

  app.post('/api/v1/executions/:executionId/abort-paused-provider', async (request) => {
    const executionId = requiredText(
      (request.params as { executionId?: string }).executionId,
      'EXECUTION_ID_REQUIRED',
    );
    const body = request.body === undefined ? {} : bodyRecord(request.body);
    const idempotencyKey = requiredText(
      request.headers['idempotency-key'] ?? body.idempotencyKey,
      'PROVIDER_ABORT_IDEMPOTENCY_REQUIRED',
    );
    const reason = requiredText(body.reason, 'PROVIDER_ABORT_REASON_INVALID');
    return await requireAutomation().worker.abortPausedProviderAttempt(
      executionId,
      idempotencyKey,
      reason,
    );
  });

  app.post('/api/v1/executions/:executionId/replace-provider-session', async (request) => {
    const executionId = requiredText(
      (request.params as { executionId?: string }).executionId,
      'EXECUTION_ID_REQUIRED',
    );
    const body = request.body === undefined ? {} : bodyRecord(request.body);
    const idempotencyKey = requiredText(
      request.headers['idempotency-key'] ?? body.idempotencyKey,
      'PROVIDER_REPLACEMENT_IDEMPOTENCY_REQUIRED',
    );
    const instruction =
      typeof body.instruction === 'string' && body.instruction.trim()
        ? body.instruction.trim()
        : undefined;
    const reason =
      typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : undefined;
    return await requireAutomation().worker.replaceStalledProviderSession(
      executionId,
      idempotencyKey,
      instruction,
      reason,
    );
  });

  app.get('/api/v1/supervisors/:supervisorId/projection', async (request) => {
    const supervisorId = requiredText(
      (request.params as { supervisorId?: string }).supervisorId,
      'SUPERVISOR_ID_REQUIRED',
    );
    return buildBoundedProjection(db, supervisorId);
  });

  app.post('/api/v1/supervisors/:supervisorId/decisions', async (request) => {
    const supervisorId = requiredText(
      (request.params as { supervisorId?: string }).supervisorId,
      'SUPERVISOR_ID_REQUIRED',
    );
    const projection = buildBoundedProjection(db, supervisorId);
    const decisionBody = bodyRecord(request.body);
    const decision = (await import('./core/supervisor/protocol.js')).parseSupervisorDecision(
      JSON.stringify(decisionBody),
    );
    if (decision.supervisorId !== supervisorId) throw new ForgeFlowError('ACTION_SUPERVISOR_MISMATCH');
    return await supervisorActions.execute(decision, projection);
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ForgeFlowError) {
      void reply.code(statusFor(error)).send({ error: error.code, message: error.message });
      return;
    }
    void reply.code(500).send({
      error: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : String(error),
    });
  });

  const supervisorInterval = supervisorRuntimeEnabled
    ? setInterval(
          () => {
            void supervisorRuntime
              .runOnce()
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
            .then(() => {
              const resourceWake = reconcileSupervisorResourceAvailability();
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

  const improvementInterval =
    env.FORGEFLOW_IMPROVEMENT_DISCOVERY_ENABLED === 'true' ||
    env.FORGEFLOW_IMPROVEMENT_ADOPTION_ENABLED === 'true'
      ? setInterval(
          () => {
            try {
              const result = improvements.runCycle();
              if (result.programs.length > 0 || result.reconciledCandidateIds.length > 0)
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
                  },
                  'improvement cycle',
                );
            } catch (error) {
              app.log.error(
                { error: error instanceof Error ? error.message : String(error) },
                'improvement cycle failed',
              );
            }
          },
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
                return await automation.plans.runOnce();
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
    kernels,
    supervisor: { actions: supervisorActions, openHands, scheduler, runtime: supervisorRuntime },
    improvements,
    ...(automation ? { automation } : {}),
    ...(projectPlanQueue ? { projectPlanQueue } : {}),
    singleActivePlanEnabled,
    literalWorktreesEnabled,
  };
}
