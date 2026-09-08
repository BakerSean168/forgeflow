import path from 'node:path';

import { ForgeFlowError } from '../core/domain/errors.js';
import { loadProjectRegistry, type ProjectRegistry } from '../platform/projects/index.js';

export interface RouteSpec {
  route: string;
  model: string;
}

export function requiredConfigText(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ForgeFlowError(code);
  return value.trim();
}

export function routeSpecs(value: string | undefined, fallback: string[]): RouteSpec[] {
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

export function rootList(value: string | undefined): string[] {
  return (value ?? '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function integerValue(
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

export type ForgeFlowEnvironment = 'test' | 'development' | 'staging' | 'production';

export interface ExecutionRuntimeConfig {
  enabled: boolean;
  nodeEnv?: string;
  childProcessEnv: NodeJS.ProcessEnv;
  allowedRepositoryRoots: string[];
  literalWorktreesEnabled: boolean;
  resourceSelectorEnabled: boolean;
  openHands: {
    baseUrl: string;
    sessionApiKey: string;
    liteLlmApiKey: string;
    liteLlmBaseUrl: string;
    requestTimeoutMs: number;
    llmTimeoutSeconds: number;
    maxIterations: number;
    container: string;
  };
  legacyRoutes: {
    implementation: RouteSpec[];
    review: RouteSpec[];
  };
  resources: {
    liteLlmAdminBaseUrl: string;
    adminEnvFile: string;
    adminKeyName: string;
    directoryTimeoutMs: number;
    probeTimeoutMs: number;
    businessAuthFile: string;
    businessEnabled: boolean;
    antigravityEnabled: boolean;
  };
  runtimeAdmission: {
    enabled: boolean;
    ttlMs: number;
    transientFailureTtlMs: number;
  };
  workspace: {
    managedHostRoot: string;
    executionRoot: string;
    uid: number;
    gid: number;
    gitTimeoutMs: number;
    gitMaxBufferBytes: number;
    minimumFreeBytes: number;
    agentHarnessCtl: string;
  };
  antigravity: {
    binary: string;
    home: string;
    stateRoot: string;
    uid: number;
    gid: number;
    authUid: number;
    authGid: number;
    user: string;
    printTimeout: string;
    sandboxWrapper: string;
    systemdUnitTemplate: string;
  };
  worker: {
    leaseTtlMs: number;
    maxExecutionsPerCycle: number;
    meaningfulProgressTimeoutMs: number;
    providerOnlyProgressTimeoutMs: number;
    opportunisticMeaningfulProgressTimeoutMs: number;
    maxStallRecoveries: number;
    opportunisticMaxStallRecoveries: number;
  };
  planPolicy: {
    maxParallelWorkItems: number;
    requireDelivery: boolean;
    maxImplementationAttempts: number;
    maxReviewAttempts: number;
    maxRepairCycles: number;
  };
  delivery: {
    commandTimeoutMs: number;
    maxBufferBytes: number;
  };
}

export interface ForgeFlowBootstrapConfig {
  environment: ForgeFlowEnvironment;
  nodeEnv?: string;
  server: { host: string; port: number };
  database: { file?: string; allowDataReset: boolean };
  repositories: { allowedRoots: string[] };
  scheduling: {
    singleActivePlanEnabled: boolean;
    literalWorktreesEnabled: boolean;
  };
  release: {
    provenanceFile: string;
    hostCacheStateFile?: string;
  };
  telemetry: {
    baseUrl: string;
    adminEnvFile: string;
    adminKeyName: string;
    requestTimeoutMs: number;
  };
  execution: ExecutionRuntimeConfig;
  automation: {
    enabled: boolean;
    pollMs: number;
    resourceRefreshMs: number;
  };
  supervisor: {
    enabled: boolean;
    openHandsUrl?: string;
    openHandsToken?: string;
    hasRetiredStaticRoute: boolean;
    maxResourceAttempts: number;
    admissionReadyTtlMs: number;
    admissionFailureTtlMs: number;
    directAdmission: {
      baseUrl: string;
      apiKey: string;
      timeoutMs: number;
    };
    reasoning: {
      baseUrl: string;
      apiKey: string;
      timeoutMs: number;
    };
    pollMs: number;
  };
  improvement: {
    discoveryEnabled: boolean;
    adoptionEnabled: boolean;
    autoAdoptLowRisk: boolean;
    selfChangeEnabled: boolean;
    selfPromotionEnabled: boolean;
    selfAutoPromotionEnabled: boolean;
    aiDiagnosisEnabled: boolean;
    aiDiagnosisMaxPerCycle: number;
    selfProjectKey: string;
    selfRepositoryPath: string;
    selfPromotionRequestFile: string;
    selfCanaryRoot: string;
    selfCanaryTimeoutMs: number;
    diagnosis: {
      baseUrl: string;
      apiKey: string;
      timeoutMs: number;
      maxResourceAttempts: number;
    };
    cycleMs: number;
  };
}

export interface LoadBootstrapConfigOptions {
  environment?: ForgeFlowEnvironment;
  dbFile?: string;
  allowDataReset?: boolean;
  cwd?: string;
  processEnv?: NodeJS.ProcessEnv;
}

export interface LoadedBootstrapConfig {
  config: ForgeFlowBootstrapConfig;
  projects: ProjectRegistry;
}

export function loadBootstrapConfig(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  options: LoadBootstrapConfigOptions = {},
): LoadedBootstrapConfig {
  const processEnv = options.processEnv ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const nodeEnv = sourceEnv.NODE_ENV;
  const environment =
    options.environment ??
    (nodeEnv === 'test' || nodeEnv === 'staging' || nodeEnv === 'production'
      ? nodeEnv
      : 'development');
  const isTest = options.environment === 'test' || nodeEnv === 'test';
  const allowedRoots = rootList(sourceEnv.FORGEFLOW_ALLOWED_REPOSITORY_ROOTS);
  const projects = loadProjectRegistry(sourceEnv, allowedRoots);
  const singleActivePlanEnabled = sourceEnv.FORGEFLOW_SINGLE_ACTIVE_PLAN_ENABLED === 'true';
  const literalWorktreesEnabled = sourceEnv.FORGEFLOW_LITERAL_WORKTREES_ENABLED === 'true';
  const executionEnabled = sourceEnv.FORGEFLOW_EXECUTION_RUNTIME_ENABLED === 'true';
  const resourceSelectorEnabled = sourceEnv.FORGEFLOW_RESOURCE_SELECTOR_ENABLED === 'true';
  const selfChangeEnabled = sourceEnv.FORGEFLOW_IMPROVEMENT_SELF_CHANGE_ENABLED === 'true';
  const selfPromotionEnabled = sourceEnv.FORGEFLOW_IMPROVEMENT_SELF_PROMOTION_ENABLED === 'true';
  const selfAutoPromotionEnabled =
    sourceEnv.FORGEFLOW_IMPROVEMENT_SELF_AUTO_PROMOTION_ENABLED === 'true';
  const aiDiagnosisEnabled = sourceEnv.FORGEFLOW_IMPROVEMENT_AI_DIAGNOSIS_ENABLED === 'true';
  const supervisorEnabled = sourceEnv.FORGEFLOW_SUPERVISOR_RUNTIME_ENABLED === 'true';
  const testTelemetryBaseUrl = isTest ? 'http://127.0.0.1:4000' : undefined;

  const execution: ExecutionRuntimeConfig = {
    enabled: executionEnabled,
    ...(nodeEnv ? { nodeEnv } : {}),
    childProcessEnv: processEnv,
    allowedRepositoryRoots: allowedRoots,
    literalWorktreesEnabled,
    resourceSelectorEnabled,
    openHands: {
      get baseUrl() {
        return requiredConfigText(sourceEnv.FORGEFLOW_OPENHANDS_URL, 'OPENHANDS_BASE_URL_REQUIRED');
      },
      get sessionApiKey() {
        return requiredConfigText(sourceEnv.FORGEFLOW_OPENHANDS_TOKEN, 'OPENHANDS_SESSION_KEY_REQUIRED');
      },
      get liteLlmApiKey() {
        return requiredConfigText(sourceEnv.FORGEFLOW_LITELLM_API_KEY, 'OPENHANDS_LITELLM_KEY_REQUIRED');
      },
      get liteLlmBaseUrl() {
        return requiredConfigText(sourceEnv.FORGEFLOW_LITELLM_BASE_URL, 'OPENHANDS_LITELLM_URL_REQUIRED');
      },
      get requestTimeoutMs() {
        return integerValue(
          sourceEnv.FORGEFLOW_PROVIDER_REQUEST_TIMEOUT_MS,
          30_000,
          1_000,
          120_000,
          'OPENHANDS_TIMEOUT_INVALID',
        );
      },
      get llmTimeoutSeconds() {
        return integerValue(
          sourceEnv.FORGEFLOW_PROVIDER_LLM_TIMEOUT_SECONDS,
          600,
          30,
          1_800,
          'OPENHANDS_LLM_TIMEOUT_INVALID',
        );
      },
      get maxIterations() {
        return integerValue(
          sourceEnv.FORGEFLOW_PROVIDER_MAX_ITERATIONS,
          500,
          1,
          1_000,
          'OPENHANDS_ITERATION_LIMIT_INVALID',
        );
      },
      container: sourceEnv.FORGEFLOW_OPENHANDS_CONTAINER ?? 'forgeflow-openhands',
    },
    legacyRoutes: {
      get implementation() {
        return routeSpecs(sourceEnv.FORGEFLOW_IMPLEMENTATION_ROUTES, ['gpt-5.6-luna']);
      },
      get review() {
        return routeSpecs(sourceEnv.FORGEFLOW_REVIEW_ROUTES, [
          'codex-business-review=gpt-5.6-sol',
          'gpt-5.6-sol',
        ]);
      },
    },
    resources: {
      get liteLlmAdminBaseUrl() {
        return (
          sourceEnv.FORGEFLOW_LITELLM_ADMIN_BASE_URL ??
          sourceEnv.FORGEFLOW_LITELLM_BASE_URL ??
          execution.openHands.liteLlmBaseUrl
        )
          .replace(/\/$/, '')
          .replace(/\/v1$/, '');
      },
      adminEnvFile: sourceEnv.FORGEFLOW_LITELLM_ADMIN_ENV_FILE ?? '/etc/forgeflow/litellm.env',
      adminKeyName: sourceEnv.FORGEFLOW_LITELLM_ADMIN_KEY_NAME ?? 'LITELLM_MASTER_KEY',
      get directoryTimeoutMs() {
        return integerValue(
          sourceEnv.FORGEFLOW_RESOURCE_DIRECTORY_TIMEOUT_MS,
          10_000,
          1_000,
          60_000,
          'RESOURCE_DIRECTORY_TIMEOUT_INVALID',
        );
      },
      get probeTimeoutMs() {
        return integerValue(
          sourceEnv.FORGEFLOW_RESOURCE_PROBE_TIMEOUT_MS,
          30_000,
          1_000,
          120_000,
          'RESOURCE_PROBE_TIMEOUT_INVALID',
        );
      },
      businessAuthFile:
        sourceEnv.FORGEFLOW_BUSINESS_AUTH_FILE ??
        '/var/lib/forgeflow/openhands/codex-business/auth.json',
      businessEnabled: sourceEnv.FORGEFLOW_BUSINESS_RESOURCE_ENABLED !== 'false',
      antigravityEnabled: sourceEnv.FORGEFLOW_ANTIGRAVITY_RESOURCE_ENABLED === 'true',
    },
    runtimeAdmission: {
      enabled:
        resourceSelectorEnabled &&
        (sourceEnv.FORGEFLOW_RUNTIME_ADMISSION_ENABLED === 'true' ||
          (sourceEnv.FORGEFLOW_RUNTIME_ADMISSION_ENABLED !== 'false' && nodeEnv !== 'test')),
      get ttlMs() {
        return integerValue(
          sourceEnv.FORGEFLOW_RUNTIME_ADMISSION_TTL_MS,
          15 * 60_000,
          60_000,
          24 * 60 * 60_000,
          'RUNTIME_ADMISSION_TTL_INVALID',
        );
      },
      get transientFailureTtlMs() {
        return integerValue(
          sourceEnv.FORGEFLOW_RUNTIME_ADMISSION_TRANSIENT_FAILURE_TTL_MS,
          15_000,
          1_000,
          execution.runtimeAdmission.ttlMs,
          'RUNTIME_ADMISSION_TRANSIENT_FAILURE_TTL_INVALID',
        );
      },
    },
    workspace: {
      get managedHostRoot() {
        return requiredConfigText(
          sourceEnv.FORGEFLOW_WORKSPACE_HOST_ROOT,
          'WORKSPACE_MANAGED_ROOT_REQUIRED',
        );
      },
      get executionRoot() {
        return requiredConfigText(
          sourceEnv.FORGEFLOW_WORKSPACE_EXECUTION_ROOT ?? '/workspace',
          'WORKSPACE_EXECUTION_ROOT_REQUIRED',
        );
      },
      get uid() {
        return integerValue(sourceEnv.FORGEFLOW_WORKSPACE_UID, 10_001, 0, 2 ** 31 - 1, 'WORKSPACE_OWNER_INVALID');
      },
      get gid() {
        return integerValue(sourceEnv.FORGEFLOW_WORKSPACE_GID, 10_001, 0, 2 ** 31 - 1, 'WORKSPACE_OWNER_INVALID');
      },
      get gitTimeoutMs() {
        return integerValue(
          sourceEnv.FORGEFLOW_GIT_TIMEOUT_MS,
          120_000,
          1_000,
          15 * 60_000,
          'WORKSPACE_GIT_TIMEOUT_INVALID',
        );
      },
      get gitMaxBufferBytes() {
        return integerValue(
          sourceEnv.FORGEFLOW_GIT_MAX_BUFFER_BYTES,
          8 * 1024 * 1024,
          64 * 1024,
          64 * 1024 * 1024,
          'WORKSPACE_GIT_BUFFER_INVALID',
        );
      },
      get minimumFreeBytes() {
        return integerValue(
          sourceEnv.FORGEFLOW_WORKSPACE_MIN_FREE_BYTES,
          8 * 1024 * 1024 * 1024,
          0,
          1024 ** 5,
          'WORKSPACE_CAPACITY_THRESHOLD_INVALID',
        );
      },
      agentHarnessCtl:
        sourceEnv.FORGEFLOW_AGENT_HARNESS_CTL ??
        '/home/dev/projects/agent-harness/bin/harnessctl.py',
    },
    antigravity: {
      binary: sourceEnv.FORGEFLOW_ANTIGRAVITY_BIN ?? '/home/dev/.local/bin/agy',
      home: sourceEnv.FORGEFLOW_ANTIGRAVITY_HOME ?? '/home/dev',
      stateRoot: sourceEnv.FORGEFLOW_ANTIGRAVITY_STATE_ROOT ?? '/var/lib/forgeflow/antigravity',
      get uid() {
        return integerValue(sourceEnv.FORGEFLOW_ANTIGRAVITY_UID, 10_001, 1, 2 ** 31 - 1, 'ANTIGRAVITY_UID_INVALID');
      },
      get gid() {
        return integerValue(sourceEnv.FORGEFLOW_ANTIGRAVITY_GID, 10_001, 1, 2 ** 31 - 1, 'ANTIGRAVITY_GID_INVALID');
      },
      get authUid() {
        return integerValue(sourceEnv.FORGEFLOW_ANTIGRAVITY_AUTH_UID, 1001, 1, 2 ** 31 - 1, 'ANTIGRAVITY_AUTH_UID_INVALID');
      },
      get authGid() {
        return integerValue(sourceEnv.FORGEFLOW_ANTIGRAVITY_AUTH_GID, 1002, 1, 2 ** 31 - 1, 'ANTIGRAVITY_AUTH_GID_INVALID');
      },
      user: sourceEnv.FORGEFLOW_ANTIGRAVITY_USER ?? 'forgeflow-worker',
      printTimeout: sourceEnv.FORGEFLOW_ANTIGRAVITY_PRINT_TIMEOUT ?? '20m',
      sandboxWrapper:
        sourceEnv.FORGEFLOW_ANTIGRAVITY_SANDBOX_WRAPPER ??
        '/usr/local/libexec/forgeflow-antigravity-sandbox.sh',
      systemdUnitTemplate:
        sourceEnv.FORGEFLOW_ANTIGRAVITY_SYSTEMD_UNIT ?? 'forgeflow-antigravity@%i.service',
    },
    worker: {
      get leaseTtlMs() {
        return integerValue(sourceEnv.FORGEFLOW_EXECUTION_LEASE_TTL_MS, 30_000, 1_000, 5 * 60_000, 'EXECUTION_LEASE_TTL_INVALID');
      },
      get maxExecutionsPerCycle() {
        return integerValue(sourceEnv.FORGEFLOW_MAX_EXECUTIONS_PER_CYCLE, 20, 1, 1_000, 'EXECUTION_CYCLE_LIMIT_INVALID');
      },
      get meaningfulProgressTimeoutMs() {
        return integerValue(sourceEnv.FORGEFLOW_MEANINGFUL_PROGRESS_TIMEOUT_MS, 15 * 60_000, 30_000, 24 * 60 * 60_000, 'EXECUTION_MEANINGFUL_PROGRESS_TIMEOUT_INVALID');
      },
      get providerOnlyProgressTimeoutMs() {
        return integerValue(sourceEnv.FORGEFLOW_PROVIDER_ONLY_PROGRESS_TIMEOUT_MS, 10 * 60_000, 30_000, 24 * 60 * 60_000, 'EXECUTION_PROVIDER_ONLY_PROGRESS_TIMEOUT_INVALID');
      },
      get opportunisticMeaningfulProgressTimeoutMs() {
        return integerValue(sourceEnv.FORGEFLOW_OPPORTUNISTIC_MEANINGFUL_PROGRESS_TIMEOUT_MS, 5 * 60_000, 30_000, 15 * 60_000, 'EXECUTION_OPPORTUNISTIC_PROGRESS_TIMEOUT_INVALID');
      },
      get maxStallRecoveries() {
        return integerValue(sourceEnv.FORGEFLOW_MAX_STALL_RECOVERIES, 2, 0, 10, 'EXECUTION_STALL_RECOVERY_LIMIT_INVALID');
      },
      get opportunisticMaxStallRecoveries() {
        return integerValue(sourceEnv.FORGEFLOW_OPPORTUNISTIC_MAX_STALL_RECOVERIES, 0, 0, 10, 'EXECUTION_OPPORTUNISTIC_STALL_RECOVERY_LIMIT_INVALID');
      },
    },
    planPolicy: {
      get maxParallelWorkItems() {
        return integerValue(sourceEnv.FORGEFLOW_MAX_PARALLEL_WORK_ITEMS, 1, 1, 32, 'PLAN_AUTOMATION_LIMIT_INVALID');
      },
      requireDelivery: sourceEnv.FORGEFLOW_REQUIRE_DELIVERY !== 'false',
      get maxImplementationAttempts() {
        return integerValue(sourceEnv.FORGEFLOW_MAX_IMPLEMENTATION_ATTEMPTS, 3, 1, 20, 'PLAN_AUTOMATION_LIMIT_INVALID');
      },
      get maxReviewAttempts() {
        return integerValue(sourceEnv.FORGEFLOW_MAX_REVIEW_ATTEMPTS, 4, 1, 20, 'PLAN_AUTOMATION_LIMIT_INVALID');
      },
      get maxRepairCycles() {
        return integerValue(sourceEnv.FORGEFLOW_MAX_REPAIR_CYCLES, 3, 1, 20, 'PLAN_AUTOMATION_LIMIT_INVALID');
      },
    },
    delivery: {
      get commandTimeoutMs() {
        return integerValue(sourceEnv.FORGEFLOW_DELIVERY_TIMEOUT_MS, 120_000, 1_000, 15 * 60_000, 'DELIVERY_TIMEOUT_INVALID');
      },
      get maxBufferBytes() {
        return integerValue(sourceEnv.FORGEFLOW_DELIVERY_MAX_BUFFER_BYTES, 8 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024, 'DELIVERY_BUFFER_INVALID');
      },
    },
  };

  const supervisorAdmissionReadyTtl = () =>
    integerValue(
      sourceEnv.FORGEFLOW_SUPERVISOR_ADMISSION_TTL_MS,
      15 * 60_000,
      30_000,
      24 * 60 * 60_000,
      'SUPERVISOR_ADMISSION_TTL_INVALID',
    );

  const config: ForgeFlowBootstrapConfig = {
    environment,
    ...(nodeEnv ? { nodeEnv } : {}),
    server: {
      host: sourceEnv.FORGEFLOW_HOST ?? '127.0.0.1',
      port: Number(sourceEnv.FORGEFLOW_PORT ?? 8420),
    },
    database: {
      ...(options.dbFile ?? sourceEnv.FORGEFLOW_DB
        ? { file: options.dbFile ?? sourceEnv.FORGEFLOW_DB }
        : {}),
      allowDataReset:
        options.allowDataReset === true || sourceEnv.FORGEFLOW_ALLOW_DATA_RESET === 'true',
    },
    repositories: { allowedRoots },
    scheduling: { singleActivePlanEnabled, literalWorktreesEnabled },
    release: {
      provenanceFile:
        sourceEnv.FORGEFLOW_RELEASE_PROVENANCE_FILE ?? '/var/lib/forgeflow/release-provenance.json',
      ...(sourceEnv.FORGEFLOW_HOST_CACHE_STATE_FILE
        ? { hostCacheStateFile: sourceEnv.FORGEFLOW_HOST_CACHE_STATE_FILE }
        : {}),
    },
    telemetry: {
      get baseUrl() {
        return requiredConfigText(
          sourceEnv.FORGEFLOW_LITELLM_BASE_URL ?? testTelemetryBaseUrl,
          'LITELLM_TELEMETRY_URL_REQUIRED',
        );
      },
      adminEnvFile: sourceEnv.FORGEFLOW_LITELLM_ADMIN_ENV_FILE ?? '/etc/forgeflow/litellm.env',
      adminKeyName: sourceEnv.FORGEFLOW_LITELLM_ADMIN_KEY_NAME ?? 'LITELLM_MASTER_KEY',
      get requestTimeoutMs() {
        return integerValue(
          sourceEnv.FORGEFLOW_LITELLM_TELEMETRY_TIMEOUT_MS,
          10_000,
          1_000,
          60_000,
          'LITELLM_TELEMETRY_TIMEOUT_INVALID',
        );
      },
    },
    execution,
    automation: {
      enabled: sourceEnv.FORGEFLOW_AUTOMATION_RUNTIME_ENABLED === 'true',
      get pollMs() {
        return integerValue(sourceEnv.FORGEFLOW_AUTOMATION_POLL_MS, 5_000, 1_000, 300_000, 'AUTOMATION_POLL_INVALID');
      },
      get resourceRefreshMs() {
        return integerValue(sourceEnv.FORGEFLOW_RESOURCE_REFRESH_MS, 60_000, 10_000, 3_600_000, 'RESOURCE_REFRESH_INVALID');
      },
    },
    supervisor: {
      enabled: supervisorEnabled,
      ...(sourceEnv.FORGEFLOW_OPENHANDS_URL ? { openHandsUrl: sourceEnv.FORGEFLOW_OPENHANDS_URL } : {}),
      ...(sourceEnv.FORGEFLOW_OPENHANDS_TOKEN ? { openHandsToken: sourceEnv.FORGEFLOW_OPENHANDS_TOKEN } : {}),
      hasRetiredStaticRoute: Boolean(
        sourceEnv.FORGEFLOW_SUPERVISOR_ENDPOINT ||
          sourceEnv.FORGEFLOW_SUPERVISOR_TOKEN ||
          sourceEnv.FORGEFLOW_SUPERVISOR_MODEL,
      ),
      get maxResourceAttempts() {
        return integerValue(sourceEnv.FORGEFLOW_SUPERVISOR_MAX_RESOURCE_ATTEMPTS, 3, 1, 20, 'SUPERVISOR_RESOURCE_ATTEMPT_LIMIT_INVALID');
      },
      get admissionReadyTtlMs() {
        return supervisorAdmissionReadyTtl();
      },
      get admissionFailureTtlMs() {
        return integerValue(
          sourceEnv.FORGEFLOW_SUPERVISOR_ADMISSION_FAILURE_TTL_MS,
          5 * 60_000,
          10_000,
          supervisorAdmissionReadyTtl(),
          'SUPERVISOR_ADMISSION_FAILURE_TTL_INVALID',
        );
      },
      directAdmission: {
        get baseUrl() {
          return requiredConfigText(sourceEnv.FORGEFLOW_LITELLM_BASE_URL, 'SUPERVISOR_DIRECT_ADMISSION_BASE_URL_REQUIRED');
        },
        get apiKey() {
          return requiredConfigText(sourceEnv.FORGEFLOW_LITELLM_API_KEY, 'SUPERVISOR_DIRECT_ADMISSION_KEY_REQUIRED');
        },
        get timeoutMs() {
          return integerValue(sourceEnv.FORGEFLOW_SUPERVISOR_ADMISSION_TIMEOUT_MS, 30_000, 1_000, 120_000, 'SUPERVISOR_ADMISSION_TIMEOUT_INVALID');
        },
      },
      reasoning: {
        get baseUrl() {
          return requiredConfigText(sourceEnv.FORGEFLOW_LITELLM_BASE_URL, 'SUPERVISOR_RESOURCE_BASE_URL_REQUIRED');
        },
        get apiKey() {
          return requiredConfigText(sourceEnv.FORGEFLOW_LITELLM_API_KEY, 'SUPERVISOR_RESOURCE_KEY_REQUIRED');
        },
        get timeoutMs() {
          return integerValue(sourceEnv.FORGEFLOW_SUPERVISOR_REQUEST_TIMEOUT_MS, 60_000, 1_000, 300_000, 'SUPERVISOR_RESOURCE_TIMEOUT_INVALID');
        },
      },
      get pollMs() {
        return integerValue(sourceEnv.FORGEFLOW_SUPERVISOR_POLL_MS, 5_000, 1_000, 300_000, 'SUPERVISOR_POLL_INVALID');
      },
    },
    improvement: {
      discoveryEnabled: sourceEnv.FORGEFLOW_IMPROVEMENT_DISCOVERY_ENABLED === 'true',
      adoptionEnabled: sourceEnv.FORGEFLOW_IMPROVEMENT_ADOPTION_ENABLED === 'true',
      autoAdoptLowRisk: sourceEnv.FORGEFLOW_IMPROVEMENT_AUTO_ADOPT_LOW_RISK === 'true',
      selfChangeEnabled,
      selfPromotionEnabled,
      selfAutoPromotionEnabled,
      aiDiagnosisEnabled,
      get aiDiagnosisMaxPerCycle() {
        return integerValue(sourceEnv.FORGEFLOW_IMPROVEMENT_AI_DIAGNOSIS_MAX_PER_CYCLE, 2, 1, 20, 'IMPROVEMENT_DIAGNOSIS_CYCLE_LIMIT_INVALID');
      },
      selfProjectKey: sourceEnv.FORGEFLOW_IMPROVEMENT_SELF_PROJECT_KEY ?? 'forgeflow',
      selfRepositoryPath: sourceEnv.FORGEFLOW_IMPROVEMENT_SELF_REPOSITORY ?? cwd,
      selfPromotionRequestFile:
        sourceEnv.FORGEFLOW_IMPROVEMENT_SELF_PROMOTION_REQUEST_FILE ??
        '/var/lib/forgeflow/self-promotion-request.json',
      selfCanaryRoot:
        sourceEnv.FORGEFLOW_IMPROVEMENT_SELF_CANARY_ROOT ?? '/var/lib/forgeflow/self-canary',
      get selfCanaryTimeoutMs() {
        return integerValue(sourceEnv.FORGEFLOW_IMPROVEMENT_SELF_CANARY_TIMEOUT_MS, 15 * 60_000, 30_000, 60 * 60_000, 'IMPROVEMENT_CANARY_TIMEOUT_INVALID');
      },
      diagnosis: {
        get baseUrl() {
          return requiredConfigText(sourceEnv.FORGEFLOW_LITELLM_BASE_URL, 'IMPROVEMENT_DIAGNOSIS_BASE_URL_REQUIRED');
        },
        get apiKey() {
          return requiredConfigText(sourceEnv.FORGEFLOW_LITELLM_API_KEY, 'IMPROVEMENT_DIAGNOSIS_KEY_REQUIRED');
        },
        get timeoutMs() {
          return integerValue(sourceEnv.FORGEFLOW_IMPROVEMENT_AI_DIAGNOSIS_TIMEOUT_MS, 60_000, 1_000, 300_000, 'IMPROVEMENT_DIAGNOSIS_TIMEOUT_INVALID');
        },
        get maxResourceAttempts() {
          return integerValue(sourceEnv.FORGEFLOW_IMPROVEMENT_AI_DIAGNOSIS_MAX_RESOURCE_ATTEMPTS, 3, 1, 20, 'IMPROVEMENT_DIAGNOSIS_ATTEMPT_LIMIT_INVALID');
        },
      },
      get cycleMs() {
        return integerValue(
          sourceEnv.FORGEFLOW_IMPROVEMENT_CYCLE_MS ?? sourceEnv.FORGEFLOW_IMPROVEMENT_RECONCILE_MS,
          30_000,
          5_000,
          3_600_000,
          'IMPROVEMENT_CYCLE_INTERVAL_INVALID',
        );
      },
    },
  };

  return { config, projects };
}
