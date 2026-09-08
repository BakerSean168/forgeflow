import assert from 'node:assert/strict';
import test from 'node:test';

import type { DeliveryObservation, PlanDeliveryConfig } from '../src/core/domain/delivery.js';
import { ForgeFlowError } from '../src/core/domain/errors.js';
import type { Execution } from '../src/core/domain/execution.js';
import {
  PlanAutomationRuntime,
  StaticPlanAutomationPolicyResolver,
  type ExecutionRunnerPort,
} from '../src/core/orchestration/planAutomationRuntime.js';
import type { ExecutionWorkerResult } from '../src/core/orchestration/executionWorker.js';
import type {
  DeliveryAutomationPort,
  WorkspaceCommittedCandidateSnapshot,
  WorkspaceDescriptor,
  WorkspaceProviderPort,
  WorkspaceProvisionInput,
} from '../src/core/orchestration/contracts.js';
import { openDatabase } from '../src/core/persistence/database.js';
import { createRepositories, type ForgeFlowRepositories } from '../src/core/persistence/repositories.js';

function now(offset = 0): string {
  return new Date(Date.now() + offset).toISOString();
}

function seed(
  items: Array<{
    itemKey: string;
    dependencies?: string[];
    parallelSafe?: boolean;
    writeScopes?: string[];
    conflictKeys?: string[];
  }> = [{ itemKey: 'first' }],
  delivery?: PlanDeliveryConfig,
) {
  const db = openDatabase(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } });
  const repositories = createRepositories(db);
  const plan = repositories.plans.createPlan({
    idempotencyKey: 'automation-plan',
    projectKey: 'automation-project',
    objective: 'complete the autonomous plan',
    repositoryPath: '/repositories/automation-project',
    baseRevision: 'base-sha',
    ...(delivery ? { delivery } : {}),
  }).value!;
  const graph = repositories.plans.createGraphVersion({
    planId: plan.planId,
    reason: 'automation graph',
  }).value!;
  for (const item of items) {
    repositories.plans.appendGraphWorkItem({
      graphVersionId: graph.graphVersionId,
      itemKey: item.itemKey,
      title: item.itemKey,
      objective: 'complete ' + item.itemKey,
      acceptanceCriteria: ['tests pass', 'independent review passes'],
      dependencies: item.dependencies ?? [],
      parallelSafe: item.parallelSafe ?? false,
      writeScopes: item.writeScopes ?? [],
      conflictKeys: item.conflictKeys ?? [],
    });
  }
  repositories.plans.updateStatus(plan.planId, 'READY');
  return { db, repositories, plan: repositories.plans.getPlan(plan.planId), graph };
}

class AutomationWorkspace implements WorkspaceProviderPort {
  repositoryHead = 'base-sha';
  repositoryClean = true;
  integrateCalls = 0;
  readonly workspaces = new Map<string, WorkspaceDescriptor>();
  readonly ancestorPairs = new Set<string>();
  readonly committedCandidates = new Map<string, string>();

  async observeRepository(repositoryPath: string, revision: string) {
    return {
      repositoryPath,
      rootPath: repositoryPath,
      headRevision: this.repositoryHead,
      clean: this.repositoryClean,
      commitExists: this.repositoryHead === revision,
      observedAt: now(),
    };
  }

  async isRevisionAncestor(
    _repositoryPath: string,
    ancestorRevision: string,
    descendantRevision: string,
  ): Promise<boolean> {
    return this.ancestorPairs.has(ancestorRevision + '->' + descendantRevision);
  }

  async provision(input: WorkspaceProvisionInput): Promise<WorkspaceDescriptor> {
    const existing = this.workspaces.get(input.executionId);
    if (existing) return existing;
    const workspace: WorkspaceDescriptor = {
      executionId: input.executionId,
      hostPath: '/managed/' + input.executionId + '/repo',
      executionPath: '/workspace/' + input.executionId + '/repo',
      evidenceHostPath: '/managed/' + input.executionId + '/completion-evidence.json',
      evidenceExecutionPath: '/workspace/' + input.executionId + '/completion-evidence.json',
      sourceRepositoryPath: input.repositoryPath,
      sourceRevision: input.sourceRevision,
      createdAt: now(),
    };
    this.workspaces.set(input.executionId, workspace);
    return workspace;
  }

  async inspectCommittedImplementation(
    workspace: WorkspaceDescriptor,
  ): Promise<WorkspaceCommittedCandidateSnapshot> {
    const headRevision = this.committedCandidates.get(workspace.executionId) ?? workspace.sourceRevision;
    return {
      workspace,
      headRevision,
      sourceRevision: workspace.sourceRevision,
      clean: true,
      descendantOfSource: true,
      changedFiles: headRevision === workspace.sourceRevision ? [] : ['src/recovered.ts'],
      diffStat: headRevision === workspace.sourceRevision ? '' : ' src/recovered.ts | 1 +',
      observedAt: now(),
    };
  }

  async verifyImplementation(): Promise<never> {
    throw new Error('not used');
  }
  async verifyReview(): Promise<never> {
    throw new Error('not used');
  }

  async integrateAcceptedRevision(input: {
    repositoryPath: string;
    expectedRevision: string;
    acceptedRevision: string;
    candidateWorkspace: WorkspaceDescriptor;
  }) {
    assert.ok(
      this.repositoryHead === input.expectedRevision ||
        this.repositoryHead === input.acceptedRevision,
    );
    this.integrateCalls += 1;
    this.repositoryHead = input.acceptedRevision;
    this.repositoryClean = true;
    return {
      repositoryPath: input.repositoryPath,
      rootPath: input.repositoryPath,
      headRevision: input.acceptedRevision,
      clean: true,
      commitExists: true,
      observedAt: now(),
    };
  }
}

class PlanWorktreeAutomationWorkspace extends AutomationWorkspace {
  readonly integrationStrategy = 'PLAN_WORKTREE' as const;
}

class AlreadyContainedAutomationWorkspace extends AutomationWorkspace {
  repositoryHead = 'later-canonical-sha';

  override async observeRepository(repositoryPath: string, revision: string) {
    return {
      repositoryPath,
      rootPath: repositoryPath,
      headRevision: this.repositoryHead,
      clean: true,
      commitExists: revision === 'result-sha-1',
      observedAt: now(),
    };
  }

  override async integrateAcceptedRevision(input: {
    repositoryPath: string;
    expectedRevision: string;
    acceptedRevision: string;
    candidateWorkspace: WorkspaceDescriptor;
  }) {
    assert.equal(input.expectedRevision, 'base-sha');
    assert.equal(input.acceptedRevision, 'result-sha-1');
    this.integrateCalls += 1;
    return {
      repositoryPath: input.repositoryPath,
      rootPath: input.repositoryPath,
      headRevision: this.repositoryHead,
      integratedRevision: input.acceptedRevision,
      clean: true,
      commitExists: true,
      observedAt: now(),
    };
  }
}

class ScriptedRunner implements ExecutionRunnerPort {
  readonly runCounts = new Map<string, number>();
  readonly implementationRoutes: string[] = [];
  readonly cleanupCalls: string[] = [];
  implementationFailures = 0;
  reviewFailures: Array<{ code: string; retryable: boolean }> = [];
  reviewVerdicts: Array<'PASS' | 'FAIL' | 'INVALID'> = ['PASS'];
  implementationRevision = 0;

  constructor(
    readonly repositories: ForgeFlowRepositories,
    readonly workspace: AutomationWorkspace,
  ) {}

  async cleanupProviderSession(
    executionId: string,
    _idempotencyKey: string,
    _reason: string,
  ): Promise<ExecutionWorkerResult> {
    this.cleanupCalls.push(executionId);
    if (!this.repositories.evidence.find(executionId, 'RECOVERY', 'provider-session-cleanup')) {
      const execution = this.repositories.executions.get(executionId);
      const session = this.repositories.sessions.get(executionId);
      this.repositories.evidence.append({
        executionId,
        kind: 'RECOVERY',
        name: 'provider-session-cleanup',
        sourceRevision: execution.identity.sourceRevision,
        payload: {
          mode: 'test-provider-session-cleanup',
          provider: session.provider,
          providerSessionId: session.providerSessionId,
          remoteProviderStatus: 'CANCELLED',
        },
      });
    }
    return { executionId, status: 'SUCCEEDED', code: 'EXECUTION_PROVIDER_SESSION_CLEANED' };
  }

  async runExecution(executionId: string): Promise<ExecutionWorkerResult> {
    const execution = this.repositories.executions.get(executionId);
    this.runCounts.set(executionId, (this.runCounts.get(executionId) ?? 0) + 1);
    if (execution.status !== 'QUEUED' && execution.status !== 'RUNNING')
      return { executionId, status: 'SKIPPED', code: 'terminal' };
    const plan = this.repositories.plans.getPlan(execution.identity.planId);
    const descriptor = await this.workspace.provision({
      executionId,
      repositoryPath: plan.repositoryPath,
      sourceRevision: execution.identity.sourceRevision!,
      phase: execution.identity.phase,
      ...(execution.identity.parentExecutionId
        ? {
            sourceWorkspace: this.repositories.sessions.get(execution.identity.parentExecutionId)
              .workspace,
          }
        : {}),
    });
    const provider =
      execution.identity.phase === 'REVIEW' ? 'scripted-review' : 'scripted-implementation';
    this.repositories.sessions.create({
      executionId,
      phase: execution.identity.phase,
      provider,
      workspace: descriptor,
      sourceRevision: execution.identity.sourceRevision!,
    });
    this.repositories.sessions.attachProviderSession(executionId, provider + '-' + executionId);
    if (execution.status === 'QUEUED')
      this.repositories.executions.updateStatus(executionId, 'RUNNING');
    this.repositories.sessions.updateProviderStatus(executionId, 'RUNNING', now(10));

    if (execution.identity.phase !== 'REVIEW') {
      this.implementationRoutes.push(execution.identity.route);
      if (this.implementationFailures > 0) {
        this.implementationFailures -= 1;
        this.repositories.sessions.complete(executionId, {
          status: 'FAILED',
          errorCode: 'PROVIDER_UNAVAILABLE',
          completedAt: now(20),
        });
        this.repositories.executions.recordResult(executionId, {
          status: 'FAILED',
          errorCode: 'PROVIDER_UNAVAILABLE',
          retryable: true,
        });
        return { executionId, status: 'FAILED', code: 'PROVIDER_UNAVAILABLE' };
      }
      this.implementationRevision += 1;
      const revision = 'result-sha-' + this.implementationRevision;
      this.repositories.sessions.complete(executionId, {
        status: 'SUCCEEDED',
        finalResponse: 'implemented',
        completedAt: now(20),
      });
      this.repositories.executions.recordResult(executionId, {
        status: 'SUCCEEDED',
        resultRevision: revision,
        resultSummary: 'implemented',
      });
      return { executionId, status: 'SUCCEEDED', code: 'implemented', resultRevision: revision };
    }

    const parent = this.repositories.executions.get(execution.identity.parentExecutionId!);
    const review = this.repositories.reviews.findByImplementationExecution(
      parent.identity.executionId,
    )!;
    this.repositories.reviews.attachReviewerExecution(review.reviewId, executionId);
    const failure = this.reviewFailures.shift();
    if (failure) {
      this.repositories.sessions.complete(executionId, {
        status: 'FAILED',
        errorCode: failure.code,
        completedAt: now(20),
      });
      this.repositories.executions.recordResult(executionId, {
        status: 'FAILED',
        errorCode: failure.code,
        retryable: failure.retryable,
      });
      return { executionId, status: 'FAILED', code: failure.code };
    }
    const verdict = this.reviewVerdicts.shift() ?? 'PASS';
    this.repositories.sessions.complete(executionId, {
      status: 'SUCCEEDED',
      finalResponse: verdict,
      completedAt: now(20),
    });
    this.repositories.executions.recordResult(executionId, {
      status: 'SUCCEEDED',
      resultRevision: execution.identity.sourceRevision!,
      resultSummary: verdict,
    });
    this.repositories.reviews.updateStatus(review.reviewId, 'RUNNING');
    this.repositories.reviews.recordVerdict(
      review.reviewId,
      verdict,
      verdict === 'PASS' ? [] : ['repair the boundary'],
    );
    return {
      executionId,
      status: 'SUCCEEDED',
      code: 'reviewed',
      resultRevision: execution.identity.sourceRevision,
    };
  }
}

class ScriptedDelivery implements DeliveryAutomationPort {
  readonly calls: string[] = [];
  observations: DeliveryObservation[] = [];

  async advance(
    plan: Parameters<DeliveryAutomationPort['advance']>[0],
  ): Promise<DeliveryObservation> {
    this.calls.push(plan.currentRevision);
    return (
      this.observations.shift() ?? {
        status: 'VERIFIED',
        headSha: plan.currentRevision,
        pullRequestNumber: 42,
        pullRequestUrl: 'https://example.test/pull/42',
        mergeSha: 'merge-sha',
      }
    );
  }
}

function runtime(
  repositories: ForgeFlowRepositories,
  runner: ExecutionRunnerPort,
  workspace: WorkspaceProviderPort,
  options: { requireDelivery?: boolean; delivery?: DeliveryAutomationPort } = {},
) {
  return new PlanAutomationRuntime(
    repositories,
    runner,
    workspace,
    new StaticPlanAutomationPolicyResolver({
      implementationRoutes: ['gpt-5.6-luna', 'implementation-efficient', 'glm-5.2'],
      reviewRoutes: ['gpt-5.6-sol', 'review-premium'],
      maxImplementationAttempts: 3,
      maxReviewAttempts: 2,
      maxInfrastructureAttempts: 2,
      maxRepairCycles: 3,
      requireDelivery: options.requireDelivery ?? false,
    }),
    options.delivery,
  );
}

async function drive(runtime: PlanAutomationRuntime, planId: string, limit = 20) {
  const results = [];
  for (let index = 0; index < limit; index += 1) {
    const result = await runtime.runPlan(planId);
    results.push(result);
    if (result.status === 'SUCCEEDED' || result.status === 'FAILED') return results;
  }
  throw new Error('plan did not reach a terminal state');
}

function retrySelector() {
  const calls: Array<{ phase: string; priorAttempts: unknown[] }> = [];
  return {
    calls,
    select(
      request: import('../src/core/orchestration/resourceSelector.js').ResourceSelectionRequest,
    ) {
      calls.push({ phase: request.phase, priorAttempts: [...(request.priorAttempts ?? [])] });
      const review = request.phase === 'REVIEW';
      const profile = review
        ? ({
            capability: 'REASONING',
            phase: 'REVIEW',
            modelFamily: 'gpt-5.6-sol',
            agentBackend: 'codex-business-review-headless',
            transport: 'PROVIDER_NATIVE',
            resourceId: 'chatgpt-business-primary',
            resourceTier: 'SUBSCRIPTION',
            modelRank: 10,
            resourceSequence: 10,
            resourceState: 'ACTIVE',
            selectionReason: 'STATIC_POLICY',
            bindingId: 'chatgpt-business-sol',
          } as const)
        : ({
            capability: 'IMPLEMENTATION',
            phase: request.phase === 'IMPLEMENT_FIX' ? 'IMPLEMENT_FIX' : 'IMPLEMENT',
            modelFamily: 'gpt-5.6-luna',
            agentBackend: 'codex-acp',
            transport: 'LITELLM_MANAGED',
            resourceId: 'managed-luna-primary',
            resourceTier: 'SUBSCRIPTION',
            modelRank: 10,
            resourceSequence: 10,
            resourceState: 'ACTIVE',
            selectionReason: 'STATIC_POLICY',
            bindingId: 'managed-luna',
          } as const);
      const excluded = [...(request.priorAttempts ?? [])].some(
        (attempt) =>
          attempt.resourceId === profile.resourceId &&
          (attempt.bindingId === undefined || attempt.bindingId === profile.bindingId) &&
          (attempt.modelFamily === undefined || attempt.modelFamily === profile.modelFamily),
      );
      if (excluded)
        return {
          status: 'WAITING_FOR_RESOURCE',
          capability: profile.capability,
          reason: 'NO_ELIGIBLE_RESOURCE',
        } as const;
      return {
        status: 'SELECTED',
        capability: profile.capability,
        profile,
        candidate: { profile, resource: {} as never, binding: {} as never },
      } as const;
    },
  };
}

test('retryable review transport failure may reuse the same recovered ready resource within the infrastructure budget', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  runner.reviewFailures = [{ code: 'REVIEW_TRANSPORT_ERROR', retryable: true }];
  const selector = retrySelector();
  const automation = new PlanAutomationRuntime(
    seeded.repositories,
    runner,
    workspace,
    new StaticPlanAutomationPolicyResolver({
      resourceSelection: { includeProviderNativeProfiles: true },
      maxImplementationAttempts: 3,
      maxReviewAttempts: 2,
      maxInfrastructureAttempts: 2,
      maxRepairCycles: 3,
    }),
    undefined,
    selector,
  );

  const results = await drive(automation, seeded.plan.planId, 20);
  assert.equal(results.at(-1)?.status, 'SUCCEEDED');
  assert.ok(results.some((result) => result.code === 'REVIEW_RETRY_QUEUED'));
  const reviews = seeded.repositories.executions
    .listByPlan(seeded.plan.planId)
    .filter((execution) => execution.identity.phase === 'REVIEW');
  assert.equal(reviews.length, 2);
  assert.equal(reviews[0]?.errorCode, 'REVIEW_TRANSPORT_ERROR');
  assert.equal(reviews[0]?.retryable, true);
  assert.equal(
    seeded.repositories.resourceSelections.get(reviews[0]!.identity.executionId)?.bindingId,
    'chatgpt-business-sol',
  );
  assert.equal(
    seeded.repositories.resourceSelections.get(reviews[1]!.identity.executionId)?.bindingId,
    'chatgpt-business-sol',
  );
  const retryCall = selector.calls.filter((call) => call.phase === 'REVIEW').at(-1)!;
  assert.deepEqual(retryCall.priorAttempts, []);
  seeded.db.close();
});

test('retryable flag does not permit same-resource reuse for normalized authentication failures', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  runner.reviewFailures = [{ code: 'PROVIDER_AUTHENTICATION_FAILED HTTP 401', retryable: true }];
  const selector = retrySelector();
  const automation = new PlanAutomationRuntime(
    seeded.repositories,
    runner,
    workspace,
    new StaticPlanAutomationPolicyResolver({
      resourceSelection: { includeProviderNativeProfiles: true },
      maxImplementationAttempts: 3,
      maxReviewAttempts: 2,
      maxInfrastructureAttempts: 2,
      maxRepairCycles: 3,
    }),
    undefined,
    selector,
  );

  const first = await automation.runPlan(seeded.plan.planId);
  await runner.runExecution(first.executionId!);
  const reviewQueued = await automation.runPlan(seeded.plan.planId);
  await runner.runExecution(reviewQueued.executionId!);
  const waiting = await automation.runPlan(seeded.plan.planId);
  assert.equal(waiting.code, 'WAITING_FOR_RESOURCE');
  assert.equal(
    seeded.repositories.plans.getPlan(seeded.plan.planId).status,
    'WAITING_FOR_RESOURCE',
  );
  const retryCall = selector.calls.filter((call) => call.phase === 'REVIEW').at(-1)!;
  assert.deepEqual(retryCall.priorAttempts, [
    {
      resourceId: 'chatgpt-business-primary',
      bindingId: 'chatgpt-business-sol',
      modelFamily: 'gpt-5.6-sol',
    },
  ]);
  seeded.db.close();
});

test('resource wait leaves a work item unassigned until an implementation resource becomes eligible', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  let available = false;
  const selector = {
    select() {
      if (!available)
        return {
          status: 'WAITING_FOR_RESOURCE',
          capability: 'IMPLEMENTATION',
          reason: 'NO_ELIGIBLE_RESOURCE',
        } as const;
      const profile = {
        capability: 'IMPLEMENTATION',
        phase: 'IMPLEMENT',
        modelFamily: 'gpt-5.6-luna',
        agentBackend: 'codex-acp',
        transport: 'PROVIDER_NATIVE',
        resourceId: 'chatgpt-business-primary',
        resourceTier: 'SUBSCRIPTION',
        modelRank: 30,
        resourceSequence: 120,
        resourceState: 'ACTIVE',
        selectionReason: 'STATIC_POLICY',
        bindingId: 'chatgpt-business-luna',
      } as const;
      return {
        status: 'SELECTED',
        capability: 'IMPLEMENTATION',
        profile,
        candidate: { profile, resource: {} as never, binding: {} as never },
      } as const;
    },
  };
  const automation = new PlanAutomationRuntime(
    seeded.repositories,
    runner,
    workspace,
    new StaticPlanAutomationPolicyResolver({
      resourceSelection: { includeProviderNativeProfiles: true },
      maxImplementationAttempts: 3,
      maxReviewAttempts: 2,
      maxInfrastructureAttempts: 2,
      maxRepairCycles: 3,
    }),
    undefined,
    selector,
  );

  const waiting = await automation.runPlan(seeded.plan.planId);
  assert.equal(waiting.code, 'WAITING_FOR_RESOURCE');
  assert.equal(
    seeded.repositories.plans.getPlan(seeded.plan.planId).status,
    'WAITING_FOR_RESOURCE',
  );
  const pending = seeded.repositories.plans.listWorkItems(seeded.plan.planId)[0]!;
  assert.equal(pending.status, 'PENDING');
  assert.equal(pending.wave, undefined);
  assert.equal(pending.integrationBaseRevision, undefined);
  assert.equal(seeded.repositories.executions.listByPlan(seeded.plan.planId).length, 0);

  available = true;
  const resumed = await automation.runPlan(seeded.plan.planId);
  assert.equal(resumed.code, 'IMPLEMENTATION_QUEUED');
  assert.equal(resumed.status, 'RUNNING');
  assert.equal(seeded.repositories.plans.getPlan(seeded.plan.planId).status, 'RUNNING');
  const executions = seeded.repositories.executions.listByPlan(seeded.plan.planId);
  assert.equal(executions.length, 1);
  assert.equal(
    executions[0]?.identity.workItemId,
    seeded.repositories.plans.listWorkItems(seeded.plan.planId)[0]?.workItemId,
  );
  assert.equal(
    seeded.repositories.resourceSelections.get(executions[0]!.identity.executionId)?.resourceId,
    'chatgpt-business-primary',
  );
  seeded.db.close();
});

test('explicit infrastructure reconcile reopens only the latest failed route for the whole running wave', async () => {
  const seeded = seed([
    { itemKey: 'left', parallelSafe: true, writeScopes: ['src/left/**'] },
    { itemKey: 'right', parallelSafe: true, writeScopes: ['src/right/**'] },
  ]);
  const workspace = new PlanWorktreeAutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  runner.implementationFailures = 2;
  const selector = retrySelector();
  const automation = new PlanAutomationRuntime(
    seeded.repositories,
    runner,
    workspace,
    new StaticPlanAutomationPolicyResolver({
      resourceSelection: { includeProviderNativeProfiles: true },
      maxImplementationAttempts: 3,
      maxReviewAttempts: 2,
      maxInfrastructureAttempts: 5,
      maxRepairCycles: 3,
      maxParallelWorkItems: 2,
    }),
    undefined,
    selector,
  );

  const first = await automation.runPlan(seeded.plan.planId);
  assert.equal(first.code, 'IMPLEMENTATION_WAVE_QUEUED');
  const waiting = await automation.runPlan(seeded.plan.planId);
  assert.equal(waiting.code, 'WAITING_FOR_RESOURCE');
  assert.equal(seeded.repositories.plans.getPlan(seeded.plan.planId).status, 'WAITING_FOR_RESOURCE');

  const items = seeded.repositories.plans.listWorkItems(seeded.plan.planId);
  const failedByItem = new Map(
    seeded.repositories.executions
      .listByPlan(seeded.plan.planId)
      .filter((execution) => execution.identity.phase === 'IMPLEMENT')
      .map((execution) => [execution.identity.workItemId!, execution]),
  );
  for (const item of items) {
    const failed = failedByItem.get(item.workItemId)!;
    let worktree = seeded.repositories.planWorktrees.create({
      worktreeId: 'worktree:' + item.workItemId,
      projectKey: seeded.plan.projectKey,
      rootPlanId: seeded.plan.planId,
      workItemId: item.workItemId,
      role: 'WORK_ITEM',
      repositoryPath: seeded.plan.repositoryPath,
      hostPath: '/managed/' + item.workItemId + '/repo',
      executionPath: '/workspace/' + item.workItemId + '/repo',
      baseRevision: item.integrationBaseRevision!,
    }).value!;
    worktree = seeded.repositories.planWorktrees.transition(worktree.worktreeId, worktree.version, 'READY').value!;
    seeded.repositories.planWorktrees.attachWriter(
      worktree.worktreeId,
      failed.identity.executionId,
      worktree.version,
    );
  }

  const recovered = await automation.reconcilePlan(seeded.plan.planId, 'retry-infrastructure');
  assert.equal(recovered.status, 'RUNNING');
  assert.equal(recovered.code, 'INFRASTRUCTURE_RECOVERY_WAVE_QUEUED');
  assert.equal(seeded.repositories.plans.getPlan(seeded.plan.planId).status, 'RUNNING');
  const implementations = seeded.repositories.executions
    .listByPlan(seeded.plan.planId)
    .filter((execution) => execution.identity.phase === 'IMPLEMENT');
  assert.equal(implementations.length, 4);
  const recoveries = implementations.filter((execution) => execution.identity.attempt === 2);
  assert.equal(recoveries.length, 2);
  for (const recovery of recoveries) {
    const previous = failedByItem.get(recovery.identity.workItemId!)!;
    assert.equal(recovery.identity.parentExecutionId, previous.identity.executionId);
    assert.equal(recovery.identity.sourceRevision, previous.identity.sourceRevision);
    assert.equal(recovery.identity.route, previous.identity.route);
  }
  assert.deepEqual(
    selector.calls.slice(-2).map((call) => call.priorAttempts),
    [[], []],
  );
  assert.equal(
    seeded.repositories.events
      .listByAggregate(seeded.plan.planId)
      .filter((event) => event.type === 'PLAN_INFRASTRUCTURE_RECOVERY_QUEUED').length,
    1,
  );
  const repeated = await automation.reconcilePlan(seeded.plan.planId, 'retry-infrastructure');
  assert.equal(repeated.code, 'PLAN_INFRASTRUCTURE_RECOVERY_NOT_WAITING');
  assert.equal(
    seeded.repositories.executions
      .listByPlan(seeded.plan.planId)
      .filter((execution) => execution.identity.phase === 'IMPLEMENT').length,
    4,
  );
  seeded.db.close();
});

test('infrastructure reconcile rejects a durable writer whose revision no longer matches the failed attempt', async () => {
  const seeded = seed();
  const workspace = new PlanWorktreeAutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  runner.implementationFailures = 1;
  const selector = retrySelector();
  const automation = new PlanAutomationRuntime(
    seeded.repositories,
    runner,
    workspace,
    new StaticPlanAutomationPolicyResolver({
      resourceSelection: { includeProviderNativeProfiles: true },
      maxImplementationAttempts: 3,
      maxReviewAttempts: 2,
      maxInfrastructureAttempts: 5,
      maxRepairCycles: 3,
    }),
    undefined,
    selector,
  );
  await automation.runPlan(seeded.plan.planId);
  const waiting = await automation.runPlan(seeded.plan.planId);
  assert.equal(waiting.code, 'WAITING_FOR_RESOURCE');
  const item = seeded.repositories.plans.listWorkItems(seeded.plan.planId)[0]!;
  const failed = seeded.repositories.executions.listByWorkItem(item.workItemId)[0]!;
  let worktree = seeded.repositories.planWorktrees.create({
    worktreeId: 'worktree:mismatch',
    projectKey: seeded.plan.projectKey,
    rootPlanId: seeded.plan.planId,
    workItemId: item.workItemId,
    role: 'WORK_ITEM',
    repositoryPath: seeded.plan.repositoryPath,
    hostPath: '/managed/mismatch/repo',
    executionPath: '/workspace/mismatch/repo',
    baseRevision: item.integrationBaseRevision!,
  }).value!;
  worktree = seeded.repositories.planWorktrees.transition(worktree.worktreeId, worktree.version, 'READY').value!;
  seeded.repositories.planWorktrees.updateRevision(worktree.worktreeId, worktree.version, 'different-sha');
  await assert.rejects(
    automation.reconcilePlan(seeded.plan.planId, 'retry-infrastructure'),
    (error: unknown) => error instanceof ForgeFlowError && error.code === 'PLAN_INFRASTRUCTURE_RECOVERY_WORKTREE_REVISION_MISMATCH',
  );
  assert.equal(seeded.repositories.executions.listByPlan(seeded.plan.planId).length, 1);
  assert.equal(seeded.repositories.plans.getPlan(seeded.plan.planId).status, 'WAITING_FOR_RESOURCE');
  assert.equal(failed.status, 'FAILED');
  seeded.db.close();
});

test('infrastructure reconcile never treats an arbitrary retryable product failure as infrastructure', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const selector = retrySelector();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  const automation = new PlanAutomationRuntime(
    seeded.repositories,
    runner,
    workspace,
    new StaticPlanAutomationPolicyResolver({
      resourceSelection: { includeProviderNativeProfiles: true },
      maxImplementationAttempts: 3,
      maxReviewAttempts: 2,
      maxInfrastructureAttempts: 5,
      maxRepairCycles: 3,
    }),
    undefined,
    selector,
  );
  const queued = await automation.runPlan(seeded.plan.planId);
  const execution = seeded.repositories.executions.get(queued.executionId!);
  seeded.repositories.executions.updateStatus(execution.identity.executionId, 'RUNNING');
  seeded.repositories.executions.recordResult(execution.identity.executionId, {
    status: 'FAILED',
    errorCode: 'PRODUCT_ASSERTION_FAILED',
    retryable: true,
  });
  seeded.repositories.plans.updateStatus(seeded.plan.planId, 'WAITING_FOR_RESOURCE');
  await assert.rejects(
    automation.reconcilePlan(seeded.plan.planId, 'retry-infrastructure'),
    (error: unknown) =>
      error instanceof ForgeFlowError &&
      error.code === 'PLAN_INFRASTRUCTURE_RECOVERY_FAILURE_NOT_INFRASTRUCTURE',
  );
  assert.equal(seeded.repositories.executions.listByPlan(seeded.plan.planId).length, 1);
  assert.equal(seeded.repositories.plans.getPlan(seeded.plan.planId).status, 'WAITING_FOR_RESOURCE');
  seeded.db.close();
});

test('infrastructure reconcile refuses to substitute a different route for the failed route being reopened', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  runner.implementationFailures = 1;
  let recoverySelection = false;
  const firstProfile = {
    capability: 'IMPLEMENTATION',
    phase: 'IMPLEMENT',
    modelFamily: 'deepseek-v4-flash',
    agentBackend: 'dsh-managed-coding',
    transport: 'LITELLM_MANAGED',
    resourceId: 'free-primary',
    resourceTier: 'FREE',
    modelRank: 10,
    resourceSequence: 10,
    resourceState: 'ACTIVE',
    selectionReason: 'STATIC_POLICY',
    bindingId: 'free-primary-deepseek',
  } as const;
  const otherProfile = {
    ...firstProfile,
    modelFamily: 'gpt-5.6-luna',
    resourceId: 'paid-secondary',
    resourceTier: 'SUBSCRIPTION',
    resourceSequence: 20,
    bindingId: 'paid-secondary-luna',
  } as const;
  const selector = {
    select() {
      const profile = recoverySelection ? otherProfile : firstProfile;
      return {
        status: 'SELECTED',
        capability: 'IMPLEMENTATION',
        profile,
        candidate: { profile, resource: {} as never, binding: {} as never },
      } as const;
    },
  };
  const automation = new PlanAutomationRuntime(
    seeded.repositories,
    runner,
    workspace,
    new StaticPlanAutomationPolicyResolver({
      resourceSelection: { includeProviderNativeProfiles: true },
      maxImplementationAttempts: 3,
      maxReviewAttempts: 2,
      maxInfrastructureAttempts: 5,
      maxRepairCycles: 3,
    }),
    undefined,
    selector,
  );
  const first = await automation.runPlan(seeded.plan.planId);
  await runner.runExecution(first.executionId!);
  seeded.repositories.plans.updateStatus(seeded.plan.planId, 'WAITING_FOR_RESOURCE');
  recoverySelection = true;
  const recovered = await automation.reconcilePlan(seeded.plan.planId, 'retry-infrastructure');
  assert.equal(recovered.code, 'INFRASTRUCTURE_RECOVERY_ROUTE_UNAVAILABLE');
  assert.equal(recovered.status, 'WAITING');
  assert.equal(seeded.repositories.executions.listByPlan(seeded.plan.planId).length, 1);
  assert.equal(seeded.repositories.plans.getPlan(seeded.plan.planId).status, 'WAITING_FOR_RESOURCE');
  seeded.db.close();
});

test('explicit finalization recovery preserves a committed sibling candidate and retries the empty sibling from base', async () => {
  const seeded = seed([
    { itemKey: 'left', parallelSafe: true, writeScopes: ['src/left/**'] },
    { itemKey: 'right', parallelSafe: true, writeScopes: ['src/right/**'] },
  ]);
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  const selector = retrySelector();
  const automation = new PlanAutomationRuntime(
    seeded.repositories,
    runner,
    workspace,
    new StaticPlanAutomationPolicyResolver({
      resourceSelection: { includeProviderNativeProfiles: true },
      maxImplementationAttempts: 3,
      maxReviewAttempts: 2,
      maxInfrastructureAttempts: 2,
      maxRepairCycles: 3,
      maxParallelWorkItems: 2,
    }),
    undefined,
    selector,
  );

  const queued = await automation.runPlan(seeded.plan.planId);
  assert.equal(queued.code, 'IMPLEMENTATION_WAVE_QUEUED');
  const originals = seeded.repositories.executions
    .listByPlan(seeded.plan.planId)
    .filter((execution) => execution.identity.phase === 'IMPLEMENT');
  assert.equal(originals.length, 2);
  const items = seeded.repositories.plans.listWorkItems(seeded.plan.planId);
  const byItem = new Map(items.map((item) => [item.workItemId, item]));

  for (const execution of originals) {
    const descriptor = await workspace.provision({
      executionId: execution.identity.executionId,
      planId: seeded.plan.planId,
      projectKey: seeded.plan.projectKey,
      workItemId: execution.identity.workItemId,
      repositoryPath: seeded.plan.repositoryPath,
      sourceRevision: execution.identity.sourceRevision!,
      phase: 'IMPLEMENT',
    });
    seeded.repositories.sessions.create({
      executionId: execution.identity.executionId,
      phase: 'IMPLEMENT',
      provider: 'failed-finalization-provider',
      workspace: descriptor,
      sourceRevision: execution.identity.sourceRevision!,
    });
    seeded.repositories.executions.updateStatus(execution.identity.executionId, 'RUNNING');
    seeded.repositories.executions.recordResult(execution.identity.executionId, {
      status: 'FAILED',
      errorCode: 'WORKSPACE_GIT_FAILED',
      retryable: true,
    });
    seeded.repositories.plans.updateWorkItemStatus(execution.identity.workItemId!, 'FAILED');
  }
  const left = items.find((item) => item.itemKey === 'left')!;
  const right = items.find((item) => item.itemKey === 'right')!;
  const leftExecution = originals.find(
    (execution) => execution.identity.workItemId === left.workItemId,
  )!;
  const rightExecution = originals.find(
    (execution) => execution.identity.workItemId === right.workItemId,
  )!;
  workspace.committedCandidates.set(leftExecution.identity.executionId, 'left-candidate-sha');
  workspace.committedCandidates.set(rightExecution.identity.executionId, 'base-sha');
  seeded.repositories.executions.updateStatus(rightExecution.identity.executionId, 'CANCELLED');
  seeded.repositories.plans.updateStatus(seeded.plan.planId, 'FAILED');

  const recovered = await automation.reconcilePlan(seeded.plan.planId, 'retry-finalization');
  assert.equal(recovered.code, 'FINALIZATION_RECOVERY_WAVE_QUEUED');
  assert.equal(seeded.repositories.plans.getPlan(seeded.plan.planId).status, 'RUNNING');
  assert.deepEqual(
    seeded.repositories.plans
      .listWorkItems(seeded.plan.planId)
      .filter((item) => item.wave === 1)
      .map((item) => item.status),
    ['RUNNING', 'RUNNING'],
  );

  const all = seeded.repositories.executions
    .listByPlan(seeded.plan.planId)
    .filter((execution) => execution.identity.phase === 'IMPLEMENT');
  assert.equal(all.length, 4);
  const recoveries = all.filter((execution) => execution.identity.attempt === 2);
  assert.equal(recoveries.length, 2);
  const recoveredLeft = recoveries.find(
    (execution) => execution.identity.workItemId === left.workItemId,
  )!;
  const recoveredRight = recoveries.find(
    (execution) => execution.identity.workItemId === right.workItemId,
  )!;
  assert.equal(recoveredLeft.identity.sourceRevision, 'left-candidate-sha');
  assert.match(recoveredLeft.objective, /previous writer already committed candidate revision left-candidate-sha/);
  assert.equal(recoveredRight.identity.sourceRevision, 'base-sha');
  assert.equal(recoveredRight.objective, byItem.get(right.workItemId)!.objective);
  assert.equal(recoveredLeft.identity.parentExecutionId, undefined);
  assert.equal(recoveredRight.identity.parentExecutionId, rightExecution.identity.executionId);
  assert.equal(leftExecution.status, 'QUEUED');
  assert.equal(
    seeded.repositories.executions.get(leftExecution.identity.executionId).status,
    'FAILED',
  );
  assert.equal(
    seeded.repositories.executions.get(rightExecution.identity.executionId).status,
    'CANCELLED',
  );
  assert.equal(
    seeded.repositories.executions.get(leftExecution.identity.executionId).errorCode,
    'WORKSPACE_GIT_FAILED',
  );
  assert.equal(
    seeded.repositories.executions.get(rightExecution.identity.executionId).errorCode,
    'WORKSPACE_GIT_FAILED',
  );

  for (const [original, recovery] of [
    [leftExecution, recoveredLeft],
    [rightExecution, recoveredRight],
  ] as const) {
    const before = seeded.repositories.resourceSelections.get(original.identity.executionId)!;
    const after = seeded.repositories.resourceSelections.get(recovery.identity.executionId)!;
    assert.equal(after.resourceId, before.resourceId);
    assert.equal(after.bindingId, before.bindingId);
    assert.equal(after.modelFamily, before.modelFamily);
  }

  const recoveryEvents = seeded.repositories.events
    .listByAggregate(seeded.plan.planId)
    .filter((event) => event.type === 'PLAN_FINALIZATION_RECOVERY_QUEUED');
  assert.equal(recoveryEvents.length, 1);
  const repeated = await automation.reconcilePlan(seeded.plan.planId, 'retry-finalization');
  assert.equal(repeated.code, 'PLAN_FINALIZATION_RECOVERY_NOT_FAILED');
  assert.equal(
    seeded.repositories.executions
      .listByPlan(seeded.plan.planId)
      .filter((execution) => execution.identity.phase === 'IMPLEMENT').length,
    4,
  );
  seeded.db.close();
});

test('finalization recovery preflight failure leaves the failed sibling wave untouched', async () => {
  const seeded = seed([
    { itemKey: 'left', parallelSafe: true, writeScopes: ['src/left/**'] },
    { itemKey: 'right', parallelSafe: true, writeScopes: ['src/right/**'] },
  ]);
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  const selector = retrySelector();
  const automation = new PlanAutomationRuntime(
    seeded.repositories,
    runner,
    workspace,
    new StaticPlanAutomationPolicyResolver({
      resourceSelection: { includeProviderNativeProfiles: true },
      maxImplementationAttempts: 3,
      maxReviewAttempts: 2,
      maxInfrastructureAttempts: 2,
      maxRepairCycles: 3,
      maxParallelWorkItems: 2,
    }),
    undefined,
    selector,
  );
  await automation.runPlan(seeded.plan.planId);
  const executions = seeded.repositories.executions.listByPlan(seeded.plan.planId);
  const items = seeded.repositories.plans.listWorkItems(seeded.plan.planId);
  for (const execution of executions) {
    const descriptor = await workspace.provision({
      executionId: execution.identity.executionId,
      planId: seeded.plan.planId,
      projectKey: seeded.plan.projectKey,
      workItemId: execution.identity.workItemId,
      repositoryPath: seeded.plan.repositoryPath,
      sourceRevision: execution.identity.sourceRevision!,
      phase: 'IMPLEMENT',
    });
    seeded.repositories.sessions.create({
      executionId: execution.identity.executionId,
      phase: 'IMPLEMENT',
      provider: 'failed-finalization-provider',
      workspace: descriptor,
      sourceRevision: execution.identity.sourceRevision!,
    });
    seeded.repositories.executions.updateStatus(execution.identity.executionId, 'RUNNING');
    seeded.repositories.executions.recordResult(execution.identity.executionId, {
      status: 'FAILED',
      errorCode: 'WORKSPACE_GIT_FAILED',
      retryable: true,
    });
    seeded.repositories.plans.updateWorkItemStatus(execution.identity.workItemId!, 'FAILED');
  }
  seeded.repositories.plans.updateStatus(seeded.plan.planId, 'FAILED');
  const originalInspector = workspace.inspectCommittedImplementation.bind(workspace);
  let calls = 0;
  workspace.inspectCommittedImplementation = async (descriptor) => {
    calls += 1;
    if (calls === 2) throw new ForgeFlowError('WORKSPACE_FINALIZATION_RECOVERY_DIRTY');
    return await originalInspector(descriptor);
  };

  await assert.rejects(
    () => automation.reconcilePlan(seeded.plan.planId, 'retry-finalization'),
    (error: unknown) => error instanceof ForgeFlowError && error.code === 'WORKSPACE_FINALIZATION_RECOVERY_DIRTY',
  );
  assert.equal(seeded.repositories.plans.getPlan(seeded.plan.planId).status, 'FAILED');
  assert.deepEqual(
    items.map((item) => seeded.repositories.plans.getWorkItem(item.workItemId).status),
    ['FAILED', 'FAILED'],
  );
  assert.equal(seeded.repositories.executions.listByPlan(seeded.plan.planId).length, 2);
  seeded.db.close();
});

test('failed sibling recovery is atomic when one target is no longer recoverable', () => {
  const seeded = seed([
    { itemKey: 'left', parallelSafe: true, writeScopes: ['src/left/**'] },
    { itemKey: 'right', parallelSafe: true, writeScopes: ['src/right/**'] },
  ]);
  const items = seeded.repositories.plans.listWorkItems(seeded.plan.planId);
  for (const item of items) {
    seeded.repositories.plans.updateWorkItemStatus(item.workItemId, 'RUNNING');
    seeded.repositories.plans.updateWorkItemStatus(item.workItemId, 'FAILED');
  }
  seeded.repositories.plans.updateStatus(seeded.plan.planId, 'RUNNING');
  seeded.repositories.plans.updateStatus(seeded.plan.planId, 'FAILED');
  seeded.repositories.plans.updateWorkItemStatus(items[1]!.workItemId, 'READY');

  assert.throws(
    () => seeded.repositories.plans.recoverFailedPlanWorkItems(
      seeded.plan.planId,
      items.map((item) => item.workItemId),
    ),
    (error: unknown) => error instanceof ForgeFlowError && error.code === 'PLAN_RECOVERY_WORK_ITEM_INVALID',
  );
  assert.equal(seeded.repositories.plans.getPlan(seeded.plan.planId).status, 'FAILED');
  assert.equal(seeded.repositories.plans.getWorkItem(items[0]!.workItemId).status, 'FAILED');
  assert.equal(seeded.repositories.plans.getWorkItem(items[1]!.workItemId).status, 'READY');
  seeded.db.close();
});

test('plan automation creates one stable first execution and completes only after exact independent review', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  const automation = runtime(seeded.repositories, runner, workspace);

  const first = await automation.runPlan(seeded.plan.planId);
  assert.equal(first.code, 'IMPLEMENTATION_QUEUED');
  const repeated = automation.createInitialExecution(
    seeded.repositories.plans.getPlan(seeded.plan.planId),
    seeded.repositories.plans.listWorkItems(seeded.plan.planId)[0]!,
  );
  assert.equal(repeated.identity.executionId, first.executionId);
  assert.equal(seeded.repositories.executions.listByPlan(seeded.plan.planId).length, 1);

  const results = await drive(automation, seeded.plan.planId);
  assert.equal(results.at(-1)?.code, 'PLAN_SUCCEEDED_LOCAL_ONLY');
  assert.equal(seeded.repositories.plans.getPlan(seeded.plan.planId).status, 'SUCCEEDED');
  assert.equal(
    seeded.repositories.plans.listWorkItems(seeded.plan.planId)[0]?.exactAcceptedRevision,
    'result-sha-1',
  );
  assert.equal(workspace.repositoryHead, 'result-sha-1');
  assert.equal(workspace.integrateCalls, 1);
  const executions = seeded.repositories.executions.listByPlan(seeded.plan.planId);
  assert.deepEqual(
    executions.map((execution) => execution.identity.phase),
    ['IMPLEMENT', 'REVIEW'],
  );
  assert.equal(seeded.repositories.reviews.listByPlan(seeded.plan.planId)[0]?.status, 'PASSED');
  seeded.db.close();
});

test('plan automation adopts a reviewed SHA already contained in a later canonical head without overwriting repository truth', async () => {
  const seeded = seed();
  const workspace = new AlreadyContainedAutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  const automation = runtime(seeded.repositories, runner, workspace);
  const results = await drive(automation, seeded.plan.planId);
  assert.equal(results.at(-1)?.code, 'PLAN_SUCCEEDED_LOCAL_ONLY');
  assert.equal(
    seeded.repositories.plans.getPlan(seeded.plan.planId).currentRevision,
    'result-sha-1',
  );
  assert.equal(workspace.repositoryHead, 'later-canonical-sha');
  assert.equal(workspace.integrateCalls, 1);
  assert.equal(
    seeded.repositories.plans.listWorkItems(seeded.plan.planId)[0]?.exactAcceptedRevision,
    'result-sha-1',
  );
  seeded.db.close();
});

test('plan automation requiring delivery never reports success when delivery is missing', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  const automation = runtime(seeded.repositories, runner, workspace, { requireDelivery: true });
  let result;
  for (let index = 0; index < 10; index += 1) {
    result = await automation.runPlan(seeded.plan.planId);
    if (result.code === 'PLAN_DELIVERY_REQUIRED') break;
  }
  assert.equal(result?.code, 'PLAN_DELIVERY_REQUIRED');
  assert.equal(result?.status, 'WAITING');
  assert.equal(seeded.repositories.plans.getPlan(seeded.plan.planId).status, 'RUNNING');
  assert.equal(seeded.repositories.plans.listWorkItems(seeded.plan.planId)[0]?.status, 'SUCCEEDED');
  seeded.db.close();
});

test('plan automation persists delivery progress and succeeds only after remote verification', async () => {
  const config: PlanDeliveryConfig = {
    remote: 'origin',
    branch: 'forgeflow/test-delivery',
    targetBranch: 'main',
    autoMerge: true,
    mergeMethod: 'merge',
    requiredChecks: ['CI'],
  };
  const seeded = seed([{ itemKey: 'first' }], config);
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  const delivery = new ScriptedDelivery();
  delivery.observations = [
    {
      status: 'CHECKS_PENDING',
      headSha: 'result-sha-1',
      pullRequestNumber: 42,
      pullRequestUrl: 'https://example.test/pull/42',
    },
    {
      status: 'VERIFIED',
      headSha: 'result-sha-1',
      pullRequestNumber: 42,
      pullRequestUrl: 'https://example.test/pull/42',
      mergeSha: 'merge-sha',
    },
  ];
  const automation = runtime(seeded.repositories, runner, workspace, {
    requireDelivery: true,
    delivery,
  });
  const results = await drive(automation, seeded.plan.planId, 20);
  assert.ok(results.some((result) => result.code === 'DELIVERY_CHECKS_PENDING'));
  assert.equal(results.at(-1)?.code, 'PLAN_DELIVERED');
  const plan = seeded.repositories.plans.getPlan(seeded.plan.planId);
  assert.equal(plan.status, 'SUCCEEDED');
  assert.equal(plan.delivery?.status, 'VERIFIED');
  assert.equal(plan.delivery?.pullRequestNumber, 42);
  assert.equal(plan.delivery?.mergeSha, 'merge-sha');
  assert.deepEqual(delivery.calls, ['result-sha-1', 'result-sha-1']);
  seeded.db.close();
});

test('required CI failures create chained delivery repairs from the latest durable delivery head', async () => {
  const config: PlanDeliveryConfig = {
    remote: 'origin',
    branch: 'forgeflow/delivery-repair-chain',
    targetBranch: 'main',
    autoMerge: true,
    mergeMethod: 'merge',
    requiredChecks: ['CI'],
  };
  const seeded = seed([{ itemKey: 'first' }], config);
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  const delivery = new ScriptedDelivery();
  delivery.observations = [
    {
      status: 'CHECKS_FAILED',
      headSha: 'result-sha-1',
      pullRequestNumber: 42,
      pullRequestUrl: 'https://example.test/pull/42',
      errorCode: 'DELIVERY_REQUIRED_CHECK_FAILED',
    },
    {
      status: 'CHECKS_FAILED',
      headSha: 'result-sha-2',
      pullRequestNumber: 42,
      pullRequestUrl: 'https://example.test/pull/42',
      errorCode: 'DELIVERY_REQUIRED_CHECK_FAILED',
    },
    {
      status: 'VERIFIED',
      headSha: 'result-sha-3',
      pullRequestNumber: 42,
      pullRequestUrl: 'https://example.test/pull/42',
      mergeSha: 'merge-sha-3',
    },
  ];
  const automation = runtime(seeded.repositories, runner, workspace, {
    requireDelivery: true,
    delivery,
  });

  let parentRepair: Awaited<ReturnType<PlanAutomationRuntime['runPlan']>> | undefined;
  for (let index = 0; index < 10; index += 1) {
    const result = await automation.runPlan(seeded.plan.planId);
    if (result.code === 'DELIVERY_REPAIR_QUEUED') {
      parentRepair = result;
      break;
    }
  }
  assert.ok(parentRepair?.childPlanId);
  const firstChildId = parentRepair.childPlanId;
  const parent = seeded.repositories.plans.getPlan(seeded.plan.planId);
  assert.equal(parent.delivery?.status, 'SUPERSEDED_PENDING_CHILD');
  assert.equal(parent.delivery?.headSha, 'result-sha-1');
  const firstChild = seeded.repositories.plans.getPlan(firstChildId);
  assert.equal(firstChild.baseRevision, 'result-sha-1');
  assert.equal(firstChild.status, 'READY');
  assert.equal(firstChild.delivery?.branch, config.branch);

  let childRepair: Awaited<ReturnType<PlanAutomationRuntime['runPlan']>> | undefined;
  for (let index = 0; index < 10; index += 1) {
    const result = await automation.runPlan(firstChildId);
    if (result.code === 'DELIVERY_REPAIR_QUEUED') {
      childRepair = result;
      break;
    }
  }
  assert.ok(childRepair?.childPlanId);
  const secondChildId = childRepair.childPlanId;
  const firstChildAfterFailure = seeded.repositories.plans.getPlan(firstChildId);
  assert.equal(firstChildAfterFailure.currentRevision, 'result-sha-2');
  assert.equal(firstChildAfterFailure.delivery?.headSha, 'result-sha-2');
  assert.equal(firstChildAfterFailure.delivery?.status, 'SUPERSEDED_PENDING_CHILD');
  assert.equal(seeded.repositories.plans.getPlan(secondChildId).baseRevision, 'result-sha-2');

  const secondChildResults = await drive(automation, secondChildId);
  assert.equal(secondChildResults.at(-1)?.code, 'PLAN_DELIVERED');
  assert.equal(seeded.repositories.plans.getPlan(secondChildId).currentRevision, 'result-sha-3');

  const firstFinished = await automation.runPlan(firstChildId);
  assert.equal(firstFinished.code, 'PLAN_DELIVERY_SUPERSEDED');
  assert.equal(seeded.repositories.plans.getPlan(firstChildId).delivery?.status, 'SUPERSEDED');
  const parentFinished = await automation.runPlan(seeded.plan.planId);
  assert.equal(parentFinished.code, 'PLAN_DELIVERY_SUPERSEDED');
  const finalParent = seeded.repositories.plans.getPlan(seeded.plan.planId);
  assert.equal(finalParent.status, 'SUCCEEDED');
  assert.equal(finalParent.delivery?.status, 'SUPERSEDED');
  assert.equal(finalParent.delivery?.mergeSha, 'merge-sha-3');
  seeded.db.close();
});

test('verified FOLLOW_UP child supersedes a stale parent delivery without another GitHub delivery attempt', async () => {
  const config: PlanDeliveryConfig = {
    remote: 'origin',
    branch: 'forgeflow/shared-delivery',
    targetBranch: 'main',
    autoMerge: true,
    mergeMethod: 'merge',
    requiredChecks: ['CI'],
  };
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  const localAutomation = runtime(seeded.repositories, runner, workspace);
  const localResults = await drive(localAutomation, seeded.plan.planId);
  assert.equal(localResults.at(-1)?.code, 'PLAN_SUCCEEDED_LOCAL_ONLY');
  const parent = seeded.repositories.plans.getPlan(seeded.plan.planId);
  assert.equal(parent.currentRevision, 'result-sha-1');

  seeded.repositories.plans.attachDelivery(parent.planId, config);
  seeded.repositories.plans.recordDeliveryObservation(parent.planId, {
    status: 'CHECKS_PENDING',
    headSha: parent.currentRevision,
    pullRequestNumber: 42,
    pullRequestUrl: 'https://example.test/pull/42',
  });
  const childId = 'plan-delivery-follow-up';
  seeded.repositories.plans.createChildPlan({
    parentPlanId: parent.planId,
    childPlanId: childId,
    repositoryPath: parent.repositoryPath,
    objective: 'repair delivery base and finish the same pull request',
    relation: 'FOLLOW_UP',
  });
  seeded.repositories.plans.attachDelivery(childId, config);
  seeded.repositories.plans.updateStatus(childId, 'READY');
  seeded.repositories.plans.updateStatus(childId, 'RUNNING');
  seeded.repositories.plans.advanceAcceptedRevision(
    childId,
    parent.currentRevision,
    'child-sha',
    'test-follow-up-accepted',
  );
  seeded.repositories.plans.recordDeliveryObservation(childId, {
    status: 'VERIFIED',
    headSha: 'child-sha',
    pullRequestNumber: 42,
    pullRequestUrl: 'https://example.test/pull/42',
    mergeSha: 'child-merge-sha',
  });
  seeded.repositories.plans.updateStatus(childId, 'SUCCEEDED');

  const delivery = new ScriptedDelivery();
  const automation = runtime(seeded.repositories, runner, workspace, {
    requireDelivery: true,
    delivery,
  });
  const result = await automation.runPlan(parent.planId);
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.code, 'PLAN_DELIVERY_SUPERSEDED');
  assert.deepEqual(delivery.calls, []);
  const durable = seeded.repositories.plans.getPlan(parent.planId);
  assert.equal(durable.delivery?.status, 'SUPERSEDED');
  assert.equal(durable.delivery?.supersededByPlanId, childId);
  assert.equal(durable.delivery?.headSha, 'result-sha-1');
  assert.equal(durable.delivery?.mergeSha, 'child-merge-sha');
  assert.equal(durable.delivery?.errorCode, undefined);
  assert.deepEqual(await automation.runOnce(), []);
  seeded.db.close();
});

test('verified recovery sibling supersedes an older delivery only when its exact revision descends from the stale head', async () => {
  const config: PlanDeliveryConfig = {
    remote: 'origin',
    branch: 'forgeflow/shared-recovery-delivery',
    targetBranch: 'main',
    autoMerge: true,
    mergeMethod: 'merge',
    requiredChecks: ['CI'],
  };
  const seeded = seed();
  const commonParent = seeded.repositories.plans.getPlan(seeded.plan.planId);

  const prepareChild = (
    childPlanId: string,
    revision: string,
    delivery: DeliveryObservation,
    terminal: boolean,
  ) => {
    seeded.repositories.plans.createChildPlan({
      parentPlanId: commonParent.planId,
      childPlanId,
      repositoryPath: commonParent.repositoryPath,
      objective: 'recover the same pull request',
      relation: 'FOLLOW_UP',
    });
    const graph = seeded.repositories.plans.createGraphVersion({
      planId: childPlanId,
      reason: 'sibling recovery graph',
    }).value!;
    const item = seeded.repositories.plans.appendGraphWorkItem({
      graphVersionId: graph.graphVersionId,
      itemKey: 'recover',
      title: 'recover',
      objective: 'recover exact delivery lineage',
      acceptanceCriteria: ['review passes'],
      dependencies: [],
    }).value!;
    seeded.repositories.plans.updateStatus(childPlanId, 'READY');
    seeded.repositories.plans.updateStatus(childPlanId, 'RUNNING');
    const child = seeded.repositories.plans.getPlan(childPlanId);
    seeded.repositories.plans.advanceAcceptedRevision(
      childPlanId,
      child.currentRevision,
      revision,
      'test sibling accepted revision',
    );
    seeded.repositories.plans.updateWorkItemStatus(item.workItemId, 'RUNNING');
    seeded.repositories.plans.updateWorkItemStatus(item.workItemId, 'SUCCEEDED');
    seeded.repositories.plans.attachDelivery(childPlanId, config);
    seeded.repositories.plans.recordDeliveryObservation(childPlanId, delivery);
    if (terminal) seeded.repositories.plans.updateStatus(childPlanId, 'SUCCEEDED');
  };

  prepareChild(
    'plan-stale-sibling',
    'stale-sha',
    {
      status: 'CHECKS_PENDING',
      headSha: 'stale-sha',
      pullRequestNumber: 165,
      pullRequestUrl: 'https://example.test/pull/165',
      errorCode: 'DELIVERY_PR_HEAD_STALE',
    },
    false,
  );
  prepareChild(
    'plan-verified-recovery-sibling',
    'recovery-sha',
    {
      status: 'VERIFIED',
      headSha: 'recovery-sha',
      pullRequestNumber: 165,
      pullRequestUrl: 'https://example.test/pull/165',
      mergeSha: 'recovery-merge-sha',
    },
    true,
  );

  const workspace = new AutomationWorkspace();
  workspace.ancestorPairs.add('stale-sha->recovery-sha');
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  const delivery = new ScriptedDelivery();
  const automation = runtime(seeded.repositories, runner, workspace, {
    requireDelivery: true,
    delivery,
  });

  const result = await automation.runPlan('plan-stale-sibling');
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.code, 'PLAN_DELIVERY_SUPERSEDED');
  assert.deepEqual(delivery.calls, []);
  const durable = seeded.repositories.plans.getPlan('plan-stale-sibling');
  assert.equal(durable.status, 'SUCCEEDED');
  assert.equal(durable.delivery?.status, 'SUPERSEDED');
  assert.equal(durable.delivery?.supersededByPlanId, 'plan-verified-recovery-sibling');
  assert.equal(durable.delivery?.mergeSha, 'recovery-merge-sha');
  assert.equal(durable.delivery?.errorCode, undefined);
  seeded.db.close();
});

test('recovery sibling cannot supersede a stale delivery without exact ancestry proof', async () => {
  const config: PlanDeliveryConfig = {
    remote: 'origin',
    branch: 'forgeflow/shared-recovery-delivery-no-ancestry',
    targetBranch: 'main',
    autoMerge: true,
    mergeMethod: 'merge',
    requiredChecks: ['CI'],
  };
  const seeded = seed();
  const commonParent = seeded.repositories.plans.getPlan(seeded.plan.planId);
  const createChild = (
    childPlanId: string,
    revision: string,
    status: 'CHECKS_PENDING' | 'VERIFIED',
  ) => {
    seeded.repositories.plans.createChildPlan({
      parentPlanId: commonParent.planId,
      childPlanId,
      repositoryPath: commonParent.repositoryPath,
      objective: 'same surface but unrelated revision',
      relation: 'FOLLOW_UP',
    });
    const graph = seeded.repositories.plans.createGraphVersion({
      planId: childPlanId,
      reason: 'graph',
    }).value!;
    const item = seeded.repositories.plans.appendGraphWorkItem({
      graphVersionId: graph.graphVersionId,
      itemKey: 'item',
      title: 'item',
      objective: 'item',
      acceptanceCriteria: ['done'],
      dependencies: [],
    }).value!;
    seeded.repositories.plans.updateStatus(childPlanId, 'READY');
    seeded.repositories.plans.updateStatus(childPlanId, 'RUNNING');
    const child = seeded.repositories.plans.getPlan(childPlanId);
    seeded.repositories.plans.advanceAcceptedRevision(
      childPlanId,
      child.currentRevision,
      revision,
      'test',
    );
    seeded.repositories.plans.updateWorkItemStatus(item.workItemId, 'RUNNING');
    seeded.repositories.plans.updateWorkItemStatus(item.workItemId, 'SUCCEEDED');
    seeded.repositories.plans.attachDelivery(childPlanId, config);
    seeded.repositories.plans.recordDeliveryObservation(childPlanId, {
      status,
      headSha: revision,
      pullRequestNumber: 166,
      pullRequestUrl: 'https://example.test/pull/166',
      ...(status === 'VERIFIED' ? { mergeSha: 'merge-unrelated' } : {}),
    });
    if (status === 'VERIFIED') seeded.repositories.plans.updateStatus(childPlanId, 'SUCCEEDED');
  };
  createChild('plan-stale-no-ancestry', 'stale-no-ancestry', 'CHECKS_PENDING');
  createChild('plan-recovery-no-ancestry', 'unrelated-recovery', 'VERIFIED');

  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  const delivery = new ScriptedDelivery();
  delivery.observations = [
    {
      status: 'CHECKS_PENDING',
      headSha: 'stale-no-ancestry',
      pullRequestNumber: 166,
      pullRequestUrl: 'https://example.test/pull/166',
    },
  ];
  const automation = runtime(seeded.repositories, runner, workspace, {
    requireDelivery: true,
    delivery,
  });
  const result = await automation.runPlan('plan-stale-no-ancestry');
  assert.equal(result.code, 'DELIVERY_CHECKS_PENDING');
  assert.equal(delivery.calls.length, 1);
  assert.equal(
    seeded.repositories.plans.getPlan('plan-stale-no-ancestry').delivery?.status,
    'CHECKS_PENDING',
  );
  seeded.db.close();
});

test('delivery supersession fails closed when the verified child does not share the parent delivery contract', async () => {
  const parentConfig: PlanDeliveryConfig = {
    remote: 'origin',
    branch: 'forgeflow/parent',
    targetBranch: 'main',
    autoMerge: true,
    mergeMethod: 'merge',
    requiredChecks: ['CI'],
  };
  const childConfig: PlanDeliveryConfig = { ...parentConfig, branch: 'forgeflow/unrelated-child' };
  const seeded = seed([], parentConfig);
  const parent = seeded.repositories.plans.getPlan(seeded.plan.planId);
  const childId = 'plan-unrelated-follow-up';
  seeded.repositories.plans.createChildPlan({
    parentPlanId: parent.planId,
    childPlanId: childId,
    repositoryPath: parent.repositoryPath,
    objective: 'unrelated follow-up',
    relation: 'FOLLOW_UP',
  });
  seeded.repositories.plans.attachDelivery(childId, childConfig);
  seeded.repositories.plans.updateStatus(childId, 'READY');
  seeded.repositories.plans.updateStatus(childId, 'RUNNING');
  seeded.repositories.plans.advanceAcceptedRevision(
    childId,
    parent.currentRevision,
    'child-sha',
    'test-child',
  );
  seeded.repositories.plans.recordDeliveryObservation(childId, {
    status: 'VERIFIED',
    headSha: 'child-sha',
    pullRequestNumber: 99,
    pullRequestUrl: 'https://example.test/pull/99',
    mergeSha: 'child-merge',
  });
  seeded.repositories.plans.updateStatus(childId, 'SUCCEEDED');
  assert.throws(
    () => seeded.repositories.plans.supersedeDelivery(parent.planId, childId),
    (error: unknown) =>
      error instanceof ForgeFlowError && error.code === 'DELIVERY_SUPERSEDING_CHILD_CONFIG_MISMATCH',
  );
  assert.equal(seeded.repositories.plans.getPlan(parent.planId).delivery?.status, 'PENDING');
  seeded.db.close();
});

test('plan automation switches from unavailable Luna to the next implementation route without duplicate work', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  runner.implementationFailures = 1;
  const automation = runtime(seeded.repositories, runner, workspace);
  const results = await drive(automation, seeded.plan.planId);
  assert.equal(results.at(-1)?.status, 'SUCCEEDED');
  assert.deepEqual(runner.implementationRoutes.slice(0, 2), [
    'gpt-5.6-luna',
    'implementation-efficient',
  ]);
  const implementations = seeded.repositories.executions
    .listByPlan(seeded.plan.planId)
    .filter((execution) => execution.identity.phase === 'IMPLEMENT');
  assert.equal(implementations.length, 2);
  assert.equal(
    implementations[1]?.identity.parentExecutionId,
    implementations[0]?.identity.executionId,
  );
  assert.equal(implementations[0]?.status, 'FAILED');
  assert.equal(implementations[1]?.status, 'SUCCEEDED');
  assert.deepEqual(runner.cleanupCalls, [implementations[0]!.identity.executionId]);
  assert.ok(
    seeded.repositories.evidence.find(
      implementations[0]!.identity.executionId,
      'RECOVERY',
      'provider-session-cleanup',
    ),
  );
  seeded.db.close();
});

test('plan automation turns review FAIL into a repair execution and independently re-reviews the repaired SHA', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  runner.reviewVerdicts = ['FAIL', 'PASS'];
  const automation = runtime(seeded.repositories, runner, workspace);
  const results = await drive(automation, seeded.plan.planId);
  assert.equal(results.at(-1)?.status, 'SUCCEEDED');
  const executions = seeded.repositories.executions.listByPlan(seeded.plan.planId);
  const implementation = executions.find((execution) => execution.identity.phase === 'IMPLEMENT')!;
  const repair = executions.find((execution) => execution.identity.phase === 'IMPLEMENT_FIX')!;
  assert.equal(repair.identity.parentExecutionId, implementation.identity.executionId);
  assert.equal(repair.identity.sourceRevision, implementation.resultRevision);
  assert.equal(repair.resultRevision, 'result-sha-2');
  const reviews = seeded.repositories.reviews.listByPlan(seeded.plan.planId);
  assert.deepEqual(
    reviews.map((review) => review.verdict),
    ['FAIL', 'PASS'],
  );
  assert.deepEqual(
    reviews.map((review) => review.sourceRevision),
    ['result-sha-1', 'result-sha-2'],
  );
  assert.equal(
    seeded.repositories.plans.listWorkItems(seeded.plan.planId)[0]?.exactAcceptedRevision,
    'result-sha-2',
  );
  seeded.db.close();
});

test('plan automation retries an INVALID review without creating a product repair execution', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  runner.reviewVerdicts = ['INVALID', 'PASS'];
  const automation = runtime(seeded.repositories, runner, workspace);
  const results = await drive(automation, seeded.plan.planId);
  assert.equal(results.at(-1)?.status, 'SUCCEEDED');
  assert.ok(results.some((result) => result.code === 'REVIEW_INVALID_RETRY_QUEUED'));
  const executions = seeded.repositories.executions.listByPlan(seeded.plan.planId);
  assert.equal(
    executions.filter((execution) => execution.identity.phase === 'IMPLEMENT_FIX').length,
    0,
  );
  assert.deepEqual(
    seeded.repositories.reviews.listByPlan(seeded.plan.planId).map((review) => review.verdict),
    ['INVALID', 'PASS'],
  );
  seeded.db.close();
});

test('explicit review reconciliation revives infrastructure-exhausted INVALID reviews at the same exact revision', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  runner.reviewVerdicts = ['INVALID', 'INVALID'];
  const automation = runtime(seeded.repositories, runner, workspace);
  const failed = await drive(automation, seeded.plan.planId);
  assert.equal(failed.at(-1)?.code, 'REVIEW_INFRASTRUCTURE_ATTEMPTS_EXHAUSTED');
  assert.equal(seeded.repositories.plans.getPlan(seeded.plan.planId).status, 'FAILED');

  runner.reviewVerdicts = ['PASS'];
  const recovered = await automation.reconcilePlan(seeded.plan.planId, 'retry-review');
  assert.equal(recovered.code, 'REVIEW_RECOVERY_QUEUED');
  const results = await drive(automation, seeded.plan.planId);
  assert.equal(results.at(-1)?.code, 'PLAN_SUCCEEDED_LOCAL_ONLY');
  const executions = seeded.repositories.executions.listByPlan(seeded.plan.planId);
  assert.equal(
    executions.filter((execution) => execution.identity.phase === 'IMPLEMENT_FIX').length,
    0,
  );
  const implementation = executions.find(
    (execution) => execution.identity.phase === 'IMPLEMENT' && execution.status === 'SUCCEEDED',
  )!;
  assert.ok(
    seeded.repositories.evidence.find(
      implementation.identity.executionId,
      'RECOVERY',
      'operator-review-recovery',
    ),
  );
  assert.equal(
    seeded.repositories.plans.listWorkItems(seeded.plan.planId)[0]?.exactAcceptedRevision,
    implementation.resultRevision,
  );
  seeded.db.close();
});

test('plan automation advances dependency-ready work sequentially on the accepted plan revision', async () => {
  const seeded = seed([{ itemKey: 'first' }, { itemKey: 'second', dependencies: ['first'] }]);
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  const automation = runtime(seeded.repositories, runner, workspace);
  const results = await drive(automation, seeded.plan.planId, 30);
  assert.equal(results.at(-1)?.status, 'SUCCEEDED');
  const items = seeded.repositories.plans.listWorkItems(seeded.plan.planId);
  assert.deepEqual(
    items.map((item) => item.status),
    ['SUCCEEDED', 'SUCCEEDED'],
  );
  assert.deepEqual(
    items.map((item) => item.exactAcceptedRevision),
    ['result-sha-1', 'result-sha-2'],
  );
  const implementations = seeded.repositories.executions
    .listByPlan(seeded.plan.planId)
    .filter((execution) => execution.identity.phase === 'IMPLEMENT');
  assert.equal(implementations[1]?.identity.sourceRevision, 'result-sha-1');
  assert.equal(workspace.integrateCalls, 2);
  seeded.db.close();
});

test('plan automation replays a completed Git fast-forward after a crash without integrating twice', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  const automation = runtime(seeded.repositories, runner, workspace);
  await automation.runPlan(seeded.plan.planId);
  await automation.runPlan(seeded.plan.planId);
  const reviewResult = await automation.runPlan(seeded.plan.planId);
  assert.equal(reviewResult.code, 'PLAN_SUCCEEDED_LOCAL_ONLY');
  assert.equal(workspace.integrateCalls, 1);

  // Reconstruct the pre-DB-write crash state in a second plan: Git already points to the accepted SHA.
  const replay = seed();
  const replayWorkspace = new AutomationWorkspace();
  const replayRunner = new ScriptedRunner(replay.repositories, replayWorkspace);
  const replayAutomation = runtime(replay.repositories, replayRunner, replayWorkspace);
  await replayAutomation.runPlan(replay.plan.planId);
  await replayAutomation.runPlan(replay.plan.planId);
  const candidate = replay.repositories.executions
    .listByPlan(replay.plan.planId)
    .find((execution) => execution.identity.phase === 'IMPLEMENT')!;
  replayWorkspace.repositoryHead = candidate.resultRevision!;
  const replayResult = await replayAutomation.runPlan(replay.plan.planId);
  assert.equal(replayResult.status, 'SUCCEEDED');
  assert.equal(replayWorkspace.integrateCalls, 0);
  assert.equal(
    replay.repositories.plans.getPlan(replay.plan.planId).currentRevision,
    candidate.resultRevision,
  );
  replay.db.close();
  seeded.db.close();
});

test('plan automation replays accepted-head integration dirt caused by a crash before durable revision CAS', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  const automation = runtime(seeded.repositories, runner, workspace);

  const queued = await automation.runPlan(seeded.plan.planId);
  await runner.runExecution(queued.executionId!);
  const reviewQueued = await automation.runPlan(seeded.plan.planId);
  await runner.runExecution(reviewQueued.executionId!);
  const candidate = seeded.repositories.executions
    .listByPlan(seeded.plan.planId)
    .find(
      (execution) => execution.identity.phase === 'IMPLEMENT' && execution.status === 'SUCCEEDED',
    )!;
  assert.ok(candidate.resultRevision);

  workspace.repositoryHead = candidate.resultRevision!;
  workspace.repositoryClean = false;
  const recovered = await automation.runPlan(seeded.plan.planId);
  assert.equal(recovered.status, 'SUCCEEDED');
  assert.equal(recovered.code, 'PLAN_SUCCEEDED_LOCAL_ONLY');
  assert.equal(workspace.integrateCalls, 1);
  assert.equal(workspace.repositoryClean, true);
  assert.equal(
    seeded.repositories.plans.getPlan(seeded.plan.planId).currentRevision,
    candidate.resultRevision,
  );
  assert.equal(
    seeded.repositories.plans.listWorkItems(seeded.plan.planId)[0]?.exactAcceptedRevision,
    candidate.resultRevision,
  );
  seeded.db.close();
});

test('plan automation surfaces an active worker failure instead of reporting false activity', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const failingRunner: ExecutionRunnerPort = {
    runExecution: async (executionId) => ({
      executionId,
      status: 'FAILED',
      code: 'WORKSPACE_GIT_COMMAND_FAILED',
    }),
  };
  const automation = runtime(seeded.repositories, failingRunner, workspace);
  const queued = await automation.runPlan(seeded.plan.planId);
  assert.equal(queued.code, 'IMPLEMENTATION_QUEUED');
  const failed = await automation.runPlan(seeded.plan.planId);
  assert.equal(failed.status, 'WAITING');
  assert.equal(failed.code, 'WORKSPACE_GIT_COMMAND_FAILED');
  assert.equal(seeded.repositories.executions.get(failed.executionId!).status, 'QUEUED');
  seeded.db.close();
});

test('plan reconcile recovers a historical non-retryable finalization failure without rewriting the failed execution', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const passiveRunner: ExecutionRunnerPort = {
    runExecution: async (executionId) => ({ executionId, status: 'RUNNING', code: 'RUNNING' }),
  };
  const automation = runtime(seeded.repositories, passiveRunner, workspace);
  const queued = await automation.runPlan(seeded.plan.planId);
  const failedExecutionId = queued.executionId!;
  const failedExecution = seeded.repositories.executions.get(failedExecutionId);
  const item = seeded.repositories.plans.getWorkItem(queued.workItemId!);
  seeded.repositories.executions.updateStatus(failedExecutionId, 'RUNNING');
  seeded.repositories.executions.recordResult(failedExecutionId, {
    status: 'FAILED',
    errorCode: 'WORKSPACE_DIRTY',
    retryable: false,
  });
  seeded.repositories.plans.updateWorkItemStatus(item.workItemId, 'FAILED');
  seeded.repositories.plans.updateStatus(seeded.plan.planId, 'FAILED');

  const reconciled = await automation.reconcilePlan(seeded.plan.planId, 'auto');
  assert.equal(reconciled.status, 'RUNNING');
  assert.equal(reconciled.code, 'FINALIZATION_RECOVERY_QUEUED');
  assert.notEqual(reconciled.executionId, failedExecutionId);
  assert.equal(seeded.repositories.plans.getPlan(seeded.plan.planId).status, 'RUNNING');
  assert.equal(seeded.repositories.plans.getWorkItem(item.workItemId).status, 'RUNNING');

  const historical = seeded.repositories.executions.get(failedExecutionId);
  assert.equal(historical.status, 'FAILED');
  assert.equal(historical.errorCode, 'WORKSPACE_DIRTY');
  assert.equal(historical.retryable, false);
  const recovery = seeded.repositories.executions.get(reconciled.executionId!);
  assert.equal(recovery.status, 'QUEUED');
  assert.equal(recovery.identity.phase, 'IMPLEMENT');
  assert.equal(recovery.identity.parentExecutionId, failedExecutionId);
  assert.equal(recovery.identity.sourceRevision, failedExecution.identity.sourceRevision);
  assert.equal(recovery.identity.route, failedExecution.identity.route);
  assert.equal(recovery.identity.attempt, failedExecution.identity.attempt + 1);

  const repeated = await automation.reconcilePlan(seeded.plan.planId, 'auto');
  assert.equal(repeated.executionId, recovery.identity.executionId);
  assert.equal(
    seeded.repositories.executions
      .listByWorkItem(item.workItemId)
      .filter((execution) => execution.identity.phase === 'IMPLEMENT').length,
    2,
  );
  seeded.db.close();
});

test('plan reconcile recovers after a crash that durably queued the retry before reviving plan state', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const passiveRunner: ExecutionRunnerPort = {
    runExecution: async (executionId) => ({ executionId, status: 'RUNNING', code: 'RUNNING' }),
  };
  const automation = runtime(seeded.repositories, passiveRunner, workspace);
  const queued = await automation.runPlan(seeded.plan.planId);
  const failedExecution = seeded.repositories.executions.get(queued.executionId!);
  const item = seeded.repositories.plans.getWorkItem(queued.workItemId!);
  seeded.repositories.executions.updateStatus(failedExecution.identity.executionId, 'RUNNING');
  seeded.repositories.executions.recordResult(failedExecution.identity.executionId, {
    status: 'FAILED',
    errorCode: 'WORKSPACE_DIRTY',
    retryable: false,
  });
  seeded.repositories.plans.updateWorkItemStatus(item.workItemId, 'FAILED');
  seeded.repositories.plans.updateStatus(seeded.plan.planId, 'FAILED');

  const crashRecovery = seeded.repositories.executions.create({
    idempotencyKey: 'simulated-crash-recovery',
    identity: {
      ...failedExecution.identity,
      executionId: 'execution-simulated-crash-recovery',
      parentExecutionId: failedExecution.identity.executionId,
      attempt: failedExecution.identity.attempt + 1,
    },
    objective: failedExecution.objective,
  }).value!;
  assert.equal(seeded.repositories.plans.getPlan(seeded.plan.planId).status, 'FAILED');
  assert.equal(seeded.repositories.plans.getWorkItem(item.workItemId).status, 'FAILED');

  const reconciled = await automation.reconcilePlan(seeded.plan.planId, 'auto');
  assert.equal(reconciled.code, 'RECOVERY_EXECUTION_ACTIVE');
  assert.equal(reconciled.executionId, crashRecovery.identity.executionId);
  assert.equal(seeded.repositories.plans.getPlan(seeded.plan.planId).status, 'RUNNING');
  assert.equal(seeded.repositories.plans.getWorkItem(item.workItemId).status, 'RUNNING');
  assert.equal(seeded.repositories.executions.listByWorkItem(item.workItemId).length, 2);
  seeded.db.close();
});

test('plan reconcile switches routes for a historical provider authentication failure even when legacy evidence marked it non-retryable', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const passiveRunner: ExecutionRunnerPort = {
    runExecution: async (executionId) => ({ executionId, status: 'RUNNING', code: 'RUNNING' }),
  };
  const automation = runtime(seeded.repositories, passiveRunner, workspace);
  const queued = await automation.runPlan(seeded.plan.planId);
  const executionId = queued.executionId!;
  const item = seeded.repositories.plans.getWorkItem(queued.workItemId!);
  seeded.repositories.executions.updateStatus(executionId, 'RUNNING');
  seeded.repositories.executions.recordResult(executionId, {
    status: 'FAILED',
    errorCode: 'LLMAuthenticationError: Invalid API key (HTTP 401)',
    retryable: false,
  });
  seeded.repositories.plans.updateWorkItemStatus(item.workItemId, 'FAILED');
  seeded.repositories.plans.updateStatus(seeded.plan.planId, 'FAILED');

  const result = await automation.reconcilePlan(seeded.plan.planId, 'auto');
  assert.equal(result.status, 'RUNNING');
  assert.equal(result.code, 'IMPLEMENTATION_RECOVERY_QUEUED');
  assert.notEqual(result.executionId, executionId);
  const recovery = seeded.repositories.executions.get(result.executionId!);
  assert.equal(recovery.identity.route, 'implementation-efficient');
  assert.equal(recovery.identity.sourceRevision, 'base-sha');
  assert.equal(seeded.repositories.plans.getPlan(seeded.plan.planId).status, 'RUNNING');
  seeded.db.close();
});

test('plan reconcile refuses unrelated non-retryable failures and preserves the failed plan', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const passiveRunner: ExecutionRunnerPort = {
    runExecution: async (executionId) => ({ executionId, status: 'RUNNING', code: 'RUNNING' }),
  };
  const automation = runtime(seeded.repositories, passiveRunner, workspace);
  const queued = await automation.runPlan(seeded.plan.planId);
  const executionId = queued.executionId!;
  const item = seeded.repositories.plans.getWorkItem(queued.workItemId!);
  seeded.repositories.executions.updateStatus(executionId, 'RUNNING');
  seeded.repositories.executions.recordResult(executionId, {
    status: 'FAILED',
    errorCode: 'WORKSPACE_RESULT_NOT_DESCENDANT',
    retryable: false,
  });
  seeded.repositories.plans.updateWorkItemStatus(item.workItemId, 'FAILED');
  seeded.repositories.plans.updateStatus(seeded.plan.planId, 'FAILED');

  const result = await automation.reconcilePlan(seeded.plan.planId, 'auto');
  assert.equal(result.status, 'FAILED');
  assert.equal(result.code, 'IMPLEMENTATION_NOT_RETRYABLE');
  assert.equal(seeded.repositories.plans.getPlan(seeded.plan.planId).status, 'FAILED');
  assert.equal(seeded.repositories.plans.getWorkItem(item.workItemId).status, 'FAILED');
  assert.equal(seeded.repositories.executions.listByWorkItem(item.workItemId).length, 1);
  seeded.db.close();
});

test('plan automation project allowlist prevents stale plans from becoming writers', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  let calls = 0;
  const runner: ExecutionRunnerPort = {
    runExecution: async (executionId) => {
      calls += 1;
      return { executionId, status: 'RUNNING', code: 'RUNNING' };
    },
  };
  const resolver = new StaticPlanAutomationPolicyResolver(
    {
      implementationRoutes: ['gpt-5.6-luna'],
      reviewRoutes: ['gpt-5.6-sol'],
    },
    {},
    ['project-beta', 'project-alpha', 'project-gamma'],
  );
  const automation = new PlanAutomationRuntime(seeded.repositories, runner, workspace, resolver);
  const result = await automation.runPlan(seeded.plan.planId);
  assert.equal(result.status, 'WAITING');
  assert.equal(result.code, 'PLAN_POLICY_UNAVAILABLE');
  assert.equal(calls, 0);
  assert.equal(seeded.repositories.executions.listByPlan(seeded.plan.planId).length, 0);
  seeded.db.close();
});

test('automation polling isolates one plan infrastructure exception and continues later plans', async () => {
  const seeded = seed();
  const secondPlan = seeded.repositories.plans.createPlan({
    idempotencyKey: 'automation-plan-second',
    projectKey: 'automation-project',
    objective: 'complete the second autonomous plan',
    repositoryPath: '/repositories/automation-project-second',
    baseRevision: 'base-sha',
  }).value!;
  const secondGraph = seeded.repositories.plans.createGraphVersion({
    planId: secondPlan.planId,
    reason: 'second automation graph',
  }).value!;
  seeded.repositories.plans.appendGraphWorkItem({
    graphVersionId: secondGraph.graphVersionId,
    itemKey: 'second',
    title: 'second',
    objective: 'complete second',
    acceptanceCriteria: ['tests pass'],
    dependencies: [],
  });
  seeded.repositories.plans.updateStatus(secondPlan.planId, 'READY');

  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  class FaultIsolatingRuntime extends PlanAutomationRuntime {
    override async runPlan(planId: string) {
      if (planId === seeded.plan.planId) throw new ForgeFlowError('WORKSPACE_GIT_COMMAND_FAILED');
      return { planId, status: 'RUNNING' as const, code: 'SECOND_PLAN_REACHED' };
    }
  }
  const automation = new FaultIsolatingRuntime(
    seeded.repositories,
    runner,
    workspace,
    new StaticPlanAutomationPolicyResolver({
      implementationRoutes: ['implementation-efficient'],
      reviewRoutes: ['review-glm'],
    }),
  );
  const results = await automation.runOnce();
  const byPlan = new Map(results.map((result) => [result.planId, result]));
  assert.deepEqual(
    [byPlan.get(seeded.plan.planId)?.status, byPlan.get(seeded.plan.planId)?.code],
    ['WAITING', 'WORKSPACE_GIT_COMMAND_FAILED'],
  );
  assert.deepEqual(
    [byPlan.get(secondPlan.planId)?.status, byPlan.get(secondPlan.planId)?.code],
    ['RUNNING', 'SECOND_PLAN_REACHED'],
  );
  seeded.db.close();
});

test('plan reconcile reuses the latest PASS reviewed candidate after an integration-era plan failure', async () => {
  const seeded = seed();
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  const automation = runtime(seeded.repositories, runner, workspace);

  const queued = await automation.runPlan(seeded.plan.planId);
  await runner.runExecution(queued.executionId!);
  const reviewQueued = await automation.runPlan(seeded.plan.planId);
  assert.equal(reviewQueued.code, 'REVIEW_QUEUED');
  await runner.runExecution(reviewQueued.executionId!);

  const review = seeded.repositories.reviews.listByPlan(seeded.plan.planId).at(-1)!;
  assert.equal(review.status, 'PASSED');
  const candidate = seeded.repositories.executions.get(review.implementationExecutionId);
  assert.equal(candidate.status, 'SUCCEEDED');
  assert.ok(candidate.resultRevision);

  const item = seeded.repositories.plans.listWorkItems(seeded.plan.planId)[0]!;
  seeded.repositories.plans.updateWorkItemStatus(item.workItemId, 'FAILED');
  seeded.repositories.plans.compareAndSetStatus(seeded.plan.planId, 'RUNNING', 'FAILED');

  const recovered = await automation.reconcilePlan(seeded.plan.planId, 'auto');
  assert.equal(recovered.status, 'SUCCEEDED');
  assert.equal(recovered.code, 'PLAN_SUCCEEDED_LOCAL_ONLY');
  assert.equal(workspace.repositoryHead, candidate.resultRevision);
  assert.equal(workspace.integrateCalls, 1);
  assert.equal(
    seeded.repositories.plans.getPlan(seeded.plan.planId).currentRevision,
    candidate.resultRevision,
  );
  assert.equal(
    seeded.repositories.plans.getWorkItem(item.workItemId).exactAcceptedRevision,
    candidate.resultRevision,
  );
  seeded.db.close();
});

test('parallel wave queues and runs two non-conflicting implementations from the same integration base before review', async () => {
  const seeded = seed([
    { itemKey: 'a', parallelSafe: true, writeScopes: ['src/a'] },
    { itemKey: 'b', parallelSafe: true, writeScopes: ['src/b'] },
  ]);
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  const automation = new PlanAutomationRuntime(
    seeded.repositories,
    runner,
    workspace,
    new StaticPlanAutomationPolicyResolver({
      implementationRoutes: ['gpt-5.6-luna'],
      reviewRoutes: ['gpt-5.6-sol'],
      maxImplementationAttempts: 3,
      maxReviewAttempts: 2,
      maxInfrastructureAttempts: 2,
      maxRepairCycles: 2,
      maxParallelWorkItems: 2,
      requireDelivery: false,
    }),
  );

  const queued = await automation.runPlan(seeded.plan.planId);
  assert.equal(queued.code, 'IMPLEMENTATION_WAVE_QUEUED');
  const initial = seeded.repositories.executions
    .listByPlan(seeded.plan.planId)
    .filter((execution) => execution.identity.phase === 'IMPLEMENT');
  assert.equal(initial.length, 2);
  assert.deepEqual(
    new Set(initial.map((execution) => execution.identity.sourceRevision)),
    new Set(['base-sha']),
  );
  const items = seeded.repositories.plans.listWorkItems(seeded.plan.planId);
  assert.deepEqual(new Set(items.map((item) => item.wave)), new Set([1]));
  assert.deepEqual(
    new Set(items.map((item) => item.integrationBaseRevision)),
    new Set(['base-sha']),
  );

  const advanced = await automation.runPlan(seeded.plan.planId);
  assert.equal(advanced.code, 'REVIEW_QUEUED');
  for (const execution of initial)
    assert.equal(runner.runCounts.get(execution.identity.executionId), 1);
  const durable = initial.map((execution) =>
    seeded.repositories.executions.get(execution.identity.executionId),
  );
  assert.ok(durable.every((execution) => execution.status === 'SUCCEEDED'));
  seeded.db.close();
});

test('parallel wave resource preflight leaves no durable half-wave and retries every sibling on the same base', async () => {
  const seeded = seed([
    { itemKey: 'a', parallelSafe: true, writeScopes: ['src/a'] },
    { itemKey: 'b', parallelSafe: true, writeScopes: ['src/b'] },
  ]);
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  let calls = 0;
  let failSecondPreflight = true;
  const profile = {
    capability: 'IMPLEMENTATION',
    phase: 'IMPLEMENT',
    modelFamily: 'gpt-5.6-luna',
    agentBackend: 'codex-acp',
    transport: 'PROVIDER_NATIVE',
    resourceId: 'implementation-primary',
    resourceTier: 'SUBSCRIPTION',
    modelRank: 10,
    resourceSequence: 10,
    resourceState: 'ACTIVE',
    selectionReason: 'STATIC_POLICY',
    bindingId: 'implementation-primary-luna',
  } as const;
  const selector = {
    select() {
      calls += 1;
      if (failSecondPreflight && calls === 2)
        return {
          status: 'WAITING_FOR_RESOURCE',
          capability: 'IMPLEMENTATION',
          reason: 'NO_ELIGIBLE_RESOURCE',
        } as const;
      return {
        status: 'SELECTED',
        capability: 'IMPLEMENTATION',
        profile,
        candidate: { profile, resource: {} as never, binding: {} as never },
      } as const;
    },
  };
  const automation = new PlanAutomationRuntime(
    seeded.repositories,
    runner,
    workspace,
    new StaticPlanAutomationPolicyResolver({
      resourceSelection: { includeProviderNativeProfiles: true },
      maxImplementationAttempts: 3,
      maxReviewAttempts: 2,
      maxInfrastructureAttempts: 2,
      maxRepairCycles: 2,
      maxParallelWorkItems: 2,
      requireDelivery: false,
    }),
    undefined,
    selector,
  );

  const waiting = await automation.runPlan(seeded.plan.planId);
  assert.equal(waiting.code, 'WAITING_FOR_RESOURCE');
  assert.equal(seeded.repositories.plans.getPlan(seeded.plan.planId).status, 'WAITING_FOR_RESOURCE');
  const afterWait = seeded.repositories.plans.listWorkItems(seeded.plan.planId);
  assert.deepEqual(new Set(afterWait.map((item) => item.status)), new Set(['PENDING']));
  assert.ok(afterWait.every((item) => item.wave === undefined));
  assert.ok(afterWait.every((item) => item.integrationBaseRevision === undefined));
  assert.equal(seeded.repositories.executions.listByPlan(seeded.plan.planId).length, 0);

  failSecondPreflight = false;
  const resumed = await automation.runPlan(seeded.plan.planId);
  assert.equal(resumed.code, 'IMPLEMENTATION_WAVE_QUEUED');
  assert.equal(seeded.repositories.plans.getPlan(seeded.plan.planId).status, 'RUNNING');
  const items = seeded.repositories.plans.listWorkItems(seeded.plan.planId);
  assert.deepEqual(new Set(items.map((item) => item.status)), new Set(['RUNNING']));
  assert.deepEqual(new Set(items.map((item) => item.wave)), new Set([1]));
  assert.deepEqual(
    new Set(items.map((item) => item.integrationBaseRevision)),
    new Set(['base-sha']),
  );
  const executions = seeded.repositories.executions
    .listByPlan(seeded.plan.planId)
    .filter((execution) => execution.identity.phase === 'IMPLEMENT');
  assert.equal(executions.length, 2);
  assert.deepEqual(
    new Set(executions.map((execution) => execution.identity.sourceRevision)),
    new Set(['base-sha']),
  );
  assert.ok(
    executions.every(
      (execution) =>
        seeded.repositories.resourceSelections.get(execution.identity.executionId)?.resourceId ===
        'implementation-primary',
    ),
  );
  assert.equal(calls, 4);
  seeded.db.close();
});

test('parallel wave drains every failed sibling before failing the Plan', async () => {
  const seeded = seed([
    { itemKey: 'a', parallelSafe: true, writeScopes: ['src/a'] },
    { itemKey: 'b', parallelSafe: true, writeScopes: ['src/b'] },
  ]);
  const workspace = new AutomationWorkspace();
  const runner = new ScriptedRunner(seeded.repositories, workspace);
  const automation = new PlanAutomationRuntime(
    seeded.repositories,
    runner,
    workspace,
    new StaticPlanAutomationPolicyResolver({
      implementationRoutes: ['gpt-5.6-luna'],
      reviewRoutes: ['gpt-5.6-sol'],
      maxImplementationAttempts: 3,
      maxReviewAttempts: 2,
      maxInfrastructureAttempts: 2,
      maxRepairCycles: 2,
      maxParallelWorkItems: 2,
      requireDelivery: false,
    }),
  );

  const queued = await automation.runPlan(seeded.plan.planId);
  assert.equal(queued.code, 'IMPLEMENTATION_WAVE_QUEUED');
  const executions = seeded.repositories.executions
    .listByPlan(seeded.plan.planId)
    .filter((execution) => execution.identity.phase === 'IMPLEMENT');
  assert.equal(executions.length, 2);
  for (const execution of executions) {
    seeded.repositories.executions.updateStatus(execution.identity.executionId, 'RUNNING');
    seeded.repositories.executions.recordResult(execution.identity.executionId, {
      status: 'FAILED',
      errorCode: 'PRODUCT_FAILURE',
      retryable: false,
    });
  }

  const failed = await automation.runPlan(seeded.plan.planId);
  assert.equal(failed.status, 'FAILED');
  assert.equal(seeded.repositories.plans.getPlan(seeded.plan.planId).status, 'FAILED');
  assert.deepEqual(
    new Set(seeded.repositories.plans.listWorkItems(seeded.plan.planId).map((item) => item.status)),
    new Set(['FAILED']),
  );
  seeded.db.close();
});
