import { randomUUID } from 'node:crypto';

import {
  ResourceSelectedImprovementDiagnosisClient,
  improvementDiagnosisContextDigest,
  type ImprovementDiagnosisInput,
} from '../src/integrations/providers/index.ts';
import {
  LiteLlmResourceDirectory,
  StaticResourceDirectory,
} from '../src/integrations/resources/index.ts';
import { ForgeFlowError } from '../src/core/domain/errors.ts';
import type {
  ExecutionResourceSelection,
  ResourceStateOverrideSource,
} from '../src/core/domain/resourceRouting.ts';
import { ResourceSelector } from '../src/core/orchestration/resourceSelector.ts';
import { openDatabase } from '../src/core/persistence/database.ts';
import { createRepositories } from '../src/core/persistence/repositories.ts';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function numberEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
}

class NoopFeedback {
  success(_selection: ExecutionResourceSelection, _source?: ResourceStateOverrideSource): void {}
  failure(
    _selection: ExecutionResourceSelection,
    _error: unknown,
    _source?: ResourceStateOverrideSource,
  ): void {}
}

const baseUrl = requiredEnv('FORGEFLOW_LITELLM_BASE_URL').replace(/\/$/, '');
const adminBaseUrl = (
  process.env.FORGEFLOW_LITELLM_ADMIN_BASE_URL?.trim() || baseUrl
)
  .replace(/\/$/, '')
  .replace(/\/v1$/, '');
const adminEnvFile =
  process.env.FORGEFLOW_LITELLM_ADMIN_ENV_FILE?.trim() || '/etc/forgeflow/litellm.env';
const adminKeyName =
  process.env.FORGEFLOW_LITELLM_ADMIN_KEY_NAME?.trim() || 'LITELLM_MASTER_KEY';
const allowedResourceIds = csv(process.env.FORGEFLOW_IMPROVEMENT_SMOKE_RESOURCE_IDS);
const requestTimeoutMs = numberEnv(
  'FORGEFLOW_IMPROVEMENT_SMOKE_TIMEOUT_MS',
  60_000,
  1_000,
  300_000,
);
const maxAttempts = numberEnv('FORGEFLOW_IMPROVEMENT_SMOKE_MAX_ATTEMPTS', 3, 1, 20);

const input: ImprovementDiagnosisInput = {
  candidateId: `candidate-smoke-${randomUUID()}`,
  programId: `program-smoke-${randomUUID()}`,
  fingerprint: 'd'.repeat(64),
  projectKey: 'forgeflow-diagnosis-smoke',
  currentRisk: 'LOW',
  failurePattern: {
    phase: 'IMPLEMENT',
    errorCode: 'WORKSPACE_INTEGRATION_LOCK_FAILED',
    observedCount: 4,
  },
  observations: [
    {
      evidenceRef: 'ev-' + '4'.repeat(32),
      phase: 'IMPLEMENT',
      errorCode: 'WORKSPACE_INTEGRATION_LOCK_FAILED',
      route: 'implementation-efficient',
      status: 'FAILED',
      retryable: true,
      updatedAt: '2026-09-06T09:00:00.000Z',
    },
    {
      evidenceRef: 'ev-' + '3'.repeat(32),
      phase: 'IMPLEMENT',
      errorCode: 'WORKSPACE_INTEGRATION_LOCK_FAILED',
      route: 'implementation-efficient',
      status: 'FAILED',
      retryable: true,
      updatedAt: '2026-09-06T08:00:00.000Z',
    },
  ],
};

const db = openDatabase(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } });
try {
  const repositories = createRepositories(db);
  const liveDirectory = new LiteLlmResourceDirectory({
    baseUrl: adminBaseUrl,
    envFile: adminEnvFile,
    keyName: adminKeyName,
    requestTimeoutMs: 10_000,
  });
  const discovered = await liveDirectory.refresh();
  const resources = allowedResourceIds.length
    ? discovered.filter((resource) => allowedResourceIds.includes(resource.resourceId))
    : discovered;
  if (resources.length === 0)
    throw new Error(
      allowedResourceIds.length
        ? 'No configured smoke resources were present in the live resource directory'
        : 'The live resource directory is empty',
    );

  const client = new ResourceSelectedImprovementDiagnosisClient(
    new ResourceSelector(new StaticResourceDirectory(resources)),
    baseUrl,
    requiredEnv('FORGEFLOW_LITELLM_API_KEY'),
    repositories.events,
    new NoopFeedback(),
    fetch,
    requestTimeoutMs,
    maxAttempts,
  );

  try {
    const result = await client.diagnose(input);
    console.log(
      JSON.stringify(
        {
          status: 'PASSED',
          contextRef: improvementDiagnosisContextDigest(input),
          selected: {
            resourceId: result.selection.resourceId,
            modelFamily: result.selection.modelFamily,
            bindingId: result.selection.bindingId,
            routeModel: result.selection.routeModel,
            protocol: result.selection.protocol,
          },
          proposal: result.proposal,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    const attempts = repositories.events
      .listRecentByAggregate(input.candidateId, 20)
      .filter((event) => event.type.startsWith('IMPROVEMENT_DIAGNOSIS_RESOURCE_'))
      .map((event) => {
        const payload = event.payload as Record<string, unknown>;
        return {
          type: event.type,
          attempt: payload.attempt,
          resourceId: payload.resourceId,
          modelFamily: payload.modelFamily,
          bindingId: payload.bindingId,
          routeModel: payload.routeModel,
          protocol: payload.protocol,
          failureClass: payload.failureClass,
          failureCode: payload.failureCode,
          statusCode: payload.statusCode,
        };
      });
    console.error(
      JSON.stringify(
        {
          status: 'FAILED',
          errorCode: error instanceof ForgeFlowError ? error.code : 'IMPROVEMENT_DIAGNOSIS_SMOKE_FAILED',
          attempts,
        },
        null,
        2,
      ),
    );
    process.exitCode = 2;
  }
} finally {
  db.close();
}
