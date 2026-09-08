import type { ExecutionStatus } from '../../core/domain/execution.js';
import type { ForgeFlowRepositories } from '../../core/persistence/repositories.js';

export interface ExecutionWorkerPort {
  runExecution(executionId: string): Promise<unknown>;
  continueExecution(
    executionId: string,
    instruction?: string,
    options?: { interruptCurrent?: boolean },
  ): Promise<unknown>;
  adoptPausedImplementation(executionId: string, idempotencyKey: string, reason: string): Promise<unknown>;
  abortPausedProviderAttempt(executionId: string, idempotencyKey: string, reason: string): Promise<unknown>;
  cleanupProviderSession(executionId: string, idempotencyKey: string, reason: string): Promise<unknown>;
  replaceStalledProviderSession(
    executionId: string,
    idempotencyKey: string,
    instruction?: string,
    reason?: string,
  ): Promise<unknown>;
}

export interface ExecutionRuntimePort {
  worker: ExecutionWorkerPort;
  routeModels: Record<string, string>;
}

export interface ExecutionTelemetryProjection {
  health: 'OK' | 'UNAVAILABLE';
  usage: unknown;
  route?: unknown;
  routeUsage: readonly unknown[];
}

export interface ExecutionTelemetryPort {
  project(input: {
    executionId: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  }): Promise<ExecutionTelemetryProjection>;
}

export interface ExecutionApplicationDependencies {
  repositories: ForgeFlowRepositories;
  telemetry: ExecutionTelemetryPort;
  requireRuntime(): ExecutionRuntimePort;
  runtime?: ExecutionRuntimePort;
}

export class ExecutionApplication {
  constructor(private readonly dependencies: ExecutionApplicationDependencies) {}

  private projectExecution(execution: ReturnType<ForgeFlowRepositories['executions']['get']>) {
    return {
      ...execution,
      resourceSelection:
        this.dependencies.repositories.resourceSelections.get(execution.identity.executionId) ?? null,
    };
  }

  async list(input: {
    limit: number;
    planId?: string;
    status?: ExecutionStatus;
    view?: 'dashboard';
  }) {
    const repositories = this.dependencies.repositories;
    const items = repositories.executions.list({
      limit: input.limit,
      ...(input.planId ? { planId: input.planId } : {}),
      ...(input.status ? { status: input.status } : {}),
    });
    if (input.view !== 'dashboard') {
      const projected = items.map((execution) => this.projectExecution(execution));
      return { items: projected, count: projected.length };
    }

    const enriched = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(8, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        const execution = items[index]!;
        const telemetry = await this.dependencies.telemetry.project({
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
            : execution.identity.route === 'codex-business-review' && this.dependencies.runtime
              ? {
                  deploymentId: 'provider-native:openai-business',
                  providerKey: 'openai-business',
                  model:
                    this.dependencies.runtime.routeModels[execution.identity.route] ??
                    execution.identity.route,
                  modelGroup: execution.identity.route,
                  commercialType: 'SUBSCRIPTION',
                  supplyOrigin: 'OFFICIAL',
                }
              : undefined;
        enriched[index] = {
          ...this.projectExecution(execution),
          telemetry:
            telemetry.usage || telemetry.route || telemetry.routeUsage.length > 0
              ? telemetry
              : { ...telemetry, ...(providerNativeRoute ? { route: providerNativeRoute } : {}) },
        };
      }
    });
    await Promise.all(workers);
    return { items: enriched, count: enriched.length };
  }

  get(executionId: string) {
    const repositories = this.dependencies.repositories;
    return {
      execution: this.projectExecution(repositories.executions.get(executionId)),
      resourceSelection: repositories.resourceSelections.get(executionId) ?? null,
      session: repositories.sessions.getOptional(executionId),
      evidence: repositories.evidence.listByExecution(executionId),
      reviewAsImplementation: repositories.reviews.findByImplementationExecution(executionId),
      reviewAsReviewer: repositories.reviews.findByReviewerExecution(executionId),
    };
  }

  async run(executionId: string) {
    return await this.dependencies.requireRuntime().worker.runExecution(executionId);
  }

  async continue(executionId: string, instruction: string | undefined, interruptCurrent: boolean) {
    return await this.dependencies.requireRuntime().worker.continueExecution(executionId, instruction, {
      interruptCurrent,
    });
  }

  async adoptWorkspace(executionId: string, idempotencyKey: string, reason: string) {
    return await this.dependencies.requireRuntime().worker.adoptPausedImplementation(
      executionId,
      idempotencyKey,
      reason,
    );
  }

  async abortPausedProvider(executionId: string, idempotencyKey: string, reason: string) {
    return await this.dependencies.requireRuntime().worker.abortPausedProviderAttempt(
      executionId,
      idempotencyKey,
      reason,
    );
  }

  async cleanupProvider(executionId: string, idempotencyKey: string, reason: string) {
    return await this.dependencies.requireRuntime().worker.cleanupProviderSession(
      executionId,
      idempotencyKey,
      reason,
    );
  }

  async replaceProviderSession(
    executionId: string,
    idempotencyKey: string,
    instruction?: string,
    reason?: string,
  ) {
    return await this.dependencies.requireRuntime().worker.replaceStalledProviderSession(
      executionId,
      idempotencyKey,
      instruction,
      reason,
    );
  }
}
