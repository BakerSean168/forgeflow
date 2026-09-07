import { createHash } from 'node:crypto';

import { isTerminalPlanStatus } from '../domain/plan.js';
import { ForgeFlowError } from '../domain/errors.js';
import type {
  RootPlanHandoffResult,
  RootPlanScheduleResult,
} from '../domain/projectPlanScheduling.js';
import type { ForgeFlowRepositories } from '../persistence/repositories.js';

export interface ProjectPlanLifecyclePort {
  activate(rootPlanId: string): Promise<void>;
  retire(rootPlanId: string): Promise<void>;
}

export interface ProjectPlanExecutionCancellationPort {
  cancelExecution(
    executionId: string,
    idempotencyKey: string,
    reason: string,
  ): Promise<{ status: string; code: string }>;
  cleanupProviderSession?(
    executionId: string,
    idempotencyKey: string,
    reason: string,
  ): Promise<{ status: string; code: string }>;
}

export interface ProjectPlanCancellationResult extends ProjectPlanQueueRuntimeResult {
  planId: string;
  cancelledExecutionIds: string[];
  rootPlanId: string;
  cancelledWorkItemIds: string[];
  cancelledReviewIds: string[];
  activationErrorCode?: string;
}

export interface ProjectPlanQueueRuntimeResult {
  projectKey: string;
  releasedPlanId?: string;
  activatedPlanId?: string;
  code: string;
}

export class ProjectPlanQueueRuntime {
  private lifecycle?: ProjectPlanLifecyclePort;
  private executionCancellation?: ProjectPlanExecutionCancellationPort;

  constructor(
    readonly repositories: ForgeFlowRepositories,
    lifecycle?: ProjectPlanLifecyclePort,
  ) {
    this.lifecycle = lifecycle;
  }

  setLifecycle(lifecycle: ProjectPlanLifecyclePort | undefined): void {
    this.lifecycle = lifecycle;
  }

  setExecutionCancellation(cancellation: ProjectPlanExecutionCancellationPort | undefined): void {
    this.executionCancellation = cancellation;
  }

  bootstrapExistingRootPlans(): void {
    const candidates = this.repositories.plans
      .listPlans({ limit: 1000 })
      .filter(
        (plan) =>
          !plan.parentPlanId &&
          !isTerminalPlanStatus(plan.status) &&
          plan.status !== 'DRAFT' &&
          plan.status !== 'QUEUED',
      );
    const byProject = new Map<string, typeof candidates>();
    for (const plan of candidates) {
      const current = byProject.get(plan.projectKey) ?? [];
      current.push(plan);
      byProject.set(plan.projectKey, current);
    }
    for (const [projectKey, plans] of byProject) {
      if (plans.length > 1) throw new ForgeFlowError('PROJECT_PLAN_MULTIPLE_ACTIVE_ROOTS');
      const plan = plans[0]!;
      const lease = this.repositories.projectPlans.getLease(projectKey);
      if (!lease) {
        const acquired = this.repositories.projectPlans.tryAcquire(projectKey, plan.planId, 0);
        if (acquired.status === 'rejected')
          throw new ForgeFlowError(acquired.reason ?? 'PROJECT_PLAN_BOOTSTRAP_FAILED');
      } else if (
        lease.repositoryPath !== plan.repositoryPath ||
        (lease.activeRootPlanId && lease.activeRootPlanId !== plan.planId)
      ) {
        throw new ForgeFlowError('PROJECT_PLAN_BOOTSTRAP_CONFLICT');
      } else if (!lease.activeRootPlanId) {
        const acquired = this.repositories.projectPlans.tryAcquire(
          projectKey,
          plan.planId,
          lease.version,
        );
        if (acquired.status === 'rejected')
          throw new ForgeFlowError(acquired.reason ?? 'PROJECT_PLAN_BOOTSTRAP_FAILED');
      }
      this.ensureSupervisorActive(plan.planId);
    }
  }

  scheduleRootPlan(planId: string, priority = 0): RootPlanScheduleResult {
    const result = this.repositories.projectPlans.scheduleRootPlan(planId, priority);
    if (result.status === 'ACTIVE') this.ensureSupervisorActive(planId);
    return result;
  }

  async reconcile(): Promise<ProjectPlanQueueRuntimeResult[]> {
    const results: ProjectPlanQueueRuntimeResult[] = [];
    for (const lease of this.repositories.projectPlans.listLeases()) {
      try {
        const activePlanId = lease.activeRootPlanId;
        if (!activePlanId) {
          const claimed = this.repositories.projectPlans.claimNext(lease.projectKey, lease.version);
          if (claimed.status === 'updated' && claimed.value?.activeRootPlanId) {
            if (this.lifecycle) await this.lifecycle.activate(claimed.value.activeRootPlanId);
            this.ensureSupervisorActive(claimed.value.activeRootPlanId);
            results.push({
              projectKey: lease.projectKey,
              activatedPlanId: claimed.value.activeRootPlanId,
              code: 'PROJECT_PLAN_QUEUE_ACTIVATED',
            });
          }
          continue;
        }
        const plan = this.repositories.plans.getPlan(activePlanId);
        const failedTerminalCleanup = plan.status === 'FAILED';
        if (!isTerminalPlanStatus(plan.status)) {
          if (plan.status !== 'SAFETY_HOLD' && this.lifecycle)
            await this.lifecycle.activate(activePlanId);
          this.ensureSupervisorActive(activePlanId);
          continue;
        }
        const activeDescendant = this.firstNonTerminalDescendant(activePlanId);
        if (activeDescendant)
          throw new ForgeFlowError(
            'PROJECT_PLAN_TERMINAL_DESCENDANT_ACTIVE',
            'Terminal root Plan still has an active descendant: ' + activeDescendant,
          );
        if (failedTerminalCleanup)
          await this.quiescePlanContents(
            activePlanId,
            'terminal-failed-cleanup:' + activePlanId,
            'Clean residual execution and workspace state for a terminal FAILED Plan before lease release.',
          );
        await this.cleanupTerminalProviderSessions(
          activePlanId,
          'terminal-provider-cleanup:' + activePlanId,
          'Clean every terminal provider session before worktree retirement and project lease release.',
        );
        if (this.lifecycle) await this.lifecycle.retire(activePlanId);
        this.retireSupervisor(activePlanId);
        const handoff = this.repositories.projectPlans.releaseAndActivateNext(
          lease.projectKey,
          activePlanId,
          lease.version,
        );
        if (handoff.activatedPlanId) {
          if (this.lifecycle) await this.lifecycle.activate(handoff.activatedPlanId);
          this.ensureSupervisorActive(handoff.activatedPlanId);
        }
        const result = this.handoffResult(lease.projectKey, handoff);
        results.push(
          failedTerminalCleanup
            ? {
                ...result,
                code: handoff.activatedPlanId
                  ? 'PROJECT_PLAN_FAILED_CLEANED_UP_HANDOFF'
                  : 'PROJECT_PLAN_FAILED_CLEANED_UP',
              }
            : result,
        );
      } catch (error) {
        results.push({
          projectKey: lease.projectKey,
          code: error instanceof ForgeFlowError ? error.code : 'PROJECT_PLAN_LIFECYCLE_FAILED',
        });
      }
    }
    return results;
  }

  cancelQueued(planId: string): void {
    const result = this.repositories.projectPlans.cancelQueued(planId);
    if (result.status === 'rejected')
      throw new ForgeFlowError(result.reason ?? 'PROJECT_PLAN_QUEUE_CANCEL_FAILED');
  }

  async cancelPlan(
    planId: string,
    idempotencyKey: string,
    reason: string,
  ): Promise<ProjectPlanCancellationResult> {
    const plan = this.repositories.plans.getPlan(planId);
    return plan.parentPlanId
      ? await this.cancelChild(planId, idempotencyKey, reason)
      : await this.cancelActive(planId, idempotencyKey, reason);
  }

  async cancelActive(
    planId: string,
    idempotencyKey: string,
    reason: string,
  ): Promise<ProjectPlanCancellationResult> {
    this.validateCancellationInput(idempotencyKey, reason);
    let plan = this.repositories.plans.getPlan(planId);
    if (plan.parentPlanId) throw new ForgeFlowError('PROJECT_PLAN_ROOT_REQUIRED');
    const lease = this.repositories.projectPlans.getLease(plan.projectKey);
    if (plan.status === 'CANCELLED' && (!lease || lease.activeRootPlanId !== planId)) {
      return {
        projectKey: plan.projectKey,
        planId,
        rootPlanId: planId,
        code: 'PROJECT_PLAN_ALREADY_CANCELLED',
        ...this.cancelledState(planId),
      };
    }
    if (plan.status === 'FAILED' && (!lease || lease.activeRootPlanId !== planId)) {
      return {
        projectKey: plan.projectKey,
        planId,
        rootPlanId: planId,
        code: 'PROJECT_PLAN_FAILED_ALREADY_CLEANED_UP',
        ...this.cancelledState(planId),
      };
    }
    if (!lease) throw new ForgeFlowError('PROJECT_PLAN_LEASE_NOT_FOUND');
    if (lease.activeRootPlanId !== planId)
      throw new ForgeFlowError('PROJECT_PLAN_LEASE_OWNER_MISMATCH');

    const activeDescendant = this.firstNonTerminalDescendant(planId);
    if (activeDescendant)
      throw new ForgeFlowError(
        'PROJECT_PLAN_CANCEL_DESCENDANT_ACTIVE',
        'Cancel descendant Plan first: ' + activeDescendant,
      );

    const failedTerminalCleanup = plan.status === 'FAILED';
    const quiesced = await this.quiescePlanContents(planId, idempotencyKey, reason);
    plan = this.repositories.plans.getPlan(planId);
    await this.cleanupTerminalProviderSessions(
      planId,
      'plan-terminal-provider-cleanup:' + idempotencyKey,
      'Clean terminal provider sessions before operator-triggered root retirement. ' + reason.trim(),
    );
    if (this.lifecycle) await this.lifecycle.retire(planId);

    const currentLease = this.repositories.projectPlans.getLease(plan.projectKey);
    if (!currentLease) throw new ForgeFlowError('PROJECT_PLAN_LEASE_NOT_FOUND');
    if (currentLease.activeRootPlanId !== planId)
      throw new ForgeFlowError('PROJECT_PLAN_LEASE_OWNER_MISMATCH');
    const handoff = this.repositories.projectPlans.releaseAndActivateNext(
      plan.projectKey,
      planId,
      currentLease.version,
    );

    let activationErrorCode: string | undefined;
    if (handoff.activatedPlanId) {
      try {
        if (this.lifecycle) await this.lifecycle.activate(handoff.activatedPlanId);
        this.ensureSupervisorActive(handoff.activatedPlanId);
      } catch (error) {
        activationErrorCode =
          error instanceof ForgeFlowError ? error.code : 'PROJECT_PLAN_ACTIVATION_FAILED';
      }
    }

    const completionCode = failedTerminalCleanup
      ? handoff.activatedPlanId
        ? 'PROJECT_PLAN_FAILED_CLEANED_UP_HANDOFF'
        : 'PROJECT_PLAN_FAILED_CLEANED_UP'
      : handoff.activatedPlanId
        ? 'PROJECT_PLAN_CANCELLED_HANDOFF'
        : 'PROJECT_PLAN_CANCELLED';
    return {
      ...this.handoffResult(plan.projectKey, handoff),
      planId,
      rootPlanId: planId,
      ...quiesced,
      ...(activationErrorCode
        ? {
            activationErrorCode,
            code: failedTerminalCleanup
              ? 'PROJECT_PLAN_FAILED_CLEANUP_NEXT_ACTIVATION_DEFERRED'
              : 'PROJECT_PLAN_CANCELLED_NEXT_ACTIVATION_DEFERRED',
          }
        : { code: completionCode }),
    };
  }

  async cancelChild(
    planId: string,
    idempotencyKey: string,
    reason: string,
  ): Promise<ProjectPlanCancellationResult> {
    this.validateCancellationInput(idempotencyKey, reason);
    const plan = this.repositories.plans.getPlan(planId);
    if (!plan.parentPlanId) throw new ForgeFlowError('CHILD_PLAN_REQUIRED');
    const rootPlanId = this.rootPlanIdFor(planId);
    const root = this.repositories.plans.getPlan(rootPlanId);
    if (root.projectKey !== plan.projectKey || root.repositoryPath !== plan.repositoryPath)
      throw new ForgeFlowError('CHILD_PLAN_SCOPE_MISMATCH');
    const lease = this.repositories.projectPlans.getLease(root.projectKey);
    if (!lease || lease.activeRootPlanId !== rootPlanId)
      throw new ForgeFlowError('CHILD_PLAN_ROOT_LEASE_REQUIRED');
    if (plan.status === 'CANCELLED') {
      await this.cleanupTerminalProviderSessions(
        planId,
        'child-terminal-provider-cleanup:' + idempotencyKey,
        'Retry terminal child provider cleanup after child cancellation. ' + reason.trim(),
      );
      return {
        projectKey: plan.projectKey,
        planId,
        rootPlanId,
        code: 'CHILD_PLAN_ALREADY_CANCELLED',
        ...this.cancelledState(planId),
      };
    }
    const activeDescendant = this.firstNonTerminalDescendant(planId);
    if (activeDescendant)
      throw new ForgeFlowError(
        'PROJECT_PLAN_CANCEL_DESCENDANT_ACTIVE',
        'Cancel descendant Plan first: ' + activeDescendant,
      );
    const failedTerminalCleanup = plan.status === 'FAILED';
    const quiesced = await this.quiescePlanContents(planId, idempotencyKey, reason);
    await this.cleanupTerminalProviderSessions(
      planId,
      'child-terminal-provider-cleanup:' + idempotencyKey,
      'Clean terminal child provider sessions after child cancellation. ' + reason.trim(),
    );
    return {
      projectKey: plan.projectKey,
      planId,
      rootPlanId,
      code: failedTerminalCleanup ? 'CHILD_PLAN_FAILED_CLEANED_UP' : 'CHILD_PLAN_CANCELLED',
      ...quiesced,
    };
  }

  private validateCancellationInput(idempotencyKey: string, reason: string): void {
    if (!idempotencyKey.trim() || idempotencyKey.length > 1_000)
      throw new ForgeFlowError('PROJECT_PLAN_CANCEL_IDEMPOTENCY_REQUIRED');
    if (!reason.trim() || reason.length > 2_000)
      throw new ForgeFlowError('PROJECT_PLAN_CANCEL_REASON_INVALID');
  }

  private cancelledState(planId: string): {
    cancelledExecutionIds: string[];
    cancelledWorkItemIds: string[];
    cancelledReviewIds: string[];
  } {
    return {
      cancelledExecutionIds: this.repositories.executions
        .listByPlan(planId)
        .filter((execution) => execution.status === 'CANCELLED')
        .map((execution) => execution.identity.executionId)
        .sort(),
      cancelledWorkItemIds: this.repositories.plans
        .listWorkItems(planId)
        .filter((item) => item.status === 'CANCELLED')
        .map((item) => item.workItemId)
        .sort(),
      cancelledReviewIds: this.repositories.reviews
        .listByPlan(planId)
        .filter((review) => review.status === 'CANCELLED')
        .map((review) => review.reviewId)
        .sort(),
    };
  }

  private async cleanupTerminalProviderSessions(
    planId: string,
    idempotencyKey: string,
    reason: string,
  ): Promise<void> {
    const planIds = this.planSubtreeIds(planId);
    const pending = planIds.flatMap((currentPlanId) =>
      this.repositories.executions.listByPlan(currentPlanId).filter((execution) => {
        const session = this.repositories.sessions.getOptional(execution.identity.executionId);
        if (!session?.providerSessionId) return false;
        return !(
          this.repositories.evidence.find(
            execution.identity.executionId,
            'RECOVERY',
            'provider-session-cleanup',
          ) ||
          this.repositories.evidence.find(
            execution.identity.executionId,
            'RECOVERY',
            'operator-provider-cancellation-cleanup',
          )
        );
      }),
    );
    if (pending.length === 0) return;
    if (!this.executionCancellation?.cleanupProviderSession)
      throw new ForgeFlowError('PROJECT_PLAN_PROVIDER_CLEANUP_RUNTIME_REQUIRED');
    const digest = createHash('sha256').update(idempotencyKey.trim()).digest('hex').slice(0, 32);
    for (const execution of pending) {
      const result = await this.executionCancellation.cleanupProviderSession(
        execution.identity.executionId,
        'provider-cleanup:' + digest + ':' + execution.identity.executionId,
        reason.trim(),
      );
      if (result.status !== 'SUCCEEDED')
        throw new ForgeFlowError(result.code || 'PROJECT_PLAN_PROVIDER_CLEANUP_FAILED');
    }
    const remaining = planIds.flatMap((currentPlanId) =>
      this.repositories.executions.listByPlan(currentPlanId).filter((execution) => {
        const session = this.repositories.sessions.getOptional(execution.identity.executionId);
        if (!session?.providerSessionId) return false;
        return !(
          this.repositories.evidence.find(
            execution.identity.executionId,
            'RECOVERY',
            'provider-session-cleanup',
          ) ||
          this.repositories.evidence.find(
            execution.identity.executionId,
            'RECOVERY',
            'operator-provider-cancellation-cleanup',
          )
        );
      }),
    );
    if (remaining.length > 0) throw new ForgeFlowError('PROJECT_PLAN_PROVIDER_CLEANUP_INCOMPLETE');
  }

  private planSubtreeIds(planId: string): string[] {
    const result: string[] = [];
    const stack = [planId];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const current = stack.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      result.push(current);
      stack.push(...this.repositories.relationships.getChildren(current));
    }
    return result;
  }

  private async quiescePlanContents(
    planId: string,
    idempotencyKey: string,
    reason: string,
  ): Promise<{
    cancelledExecutionIds: string[];
    cancelledWorkItemIds: string[];
    cancelledReviewIds: string[];
  }> {
    let plan = this.repositories.plans.getPlan(planId);
    const rootPlanId = this.rootPlanIdFor(planId);
    const preserveFailedPlan = plan.status === 'FAILED';
    if (plan.status !== 'CANCELLED' && !preserveFailedPlan) {
      if (isTerminalPlanStatus(plan.status))
        throw new ForgeFlowError('PROJECT_PLAN_CANCEL_TERMINAL');
      if (plan.status !== 'SAFETY_HOLD') {
        const held = this.repositories.plans.compareAndSetStatus(
          plan.planId,
          plan.status,
          'SAFETY_HOLD',
        );
        if (held.status === 'rejected')
          throw new ForgeFlowError(held.reason ?? 'PROJECT_PLAN_CANCEL_STALE');
        this.repositories.events.appendNew({
          aggregateId: plan.planId,
          aggregateType: 'PLAN',
          type: 'PROJECT_PLAN_CANCEL_REQUESTED',
          payload: {
            reason: reason.trim(),
            scope: plan.planId === rootPlanId ? 'ROOT' : 'CHILD',
            rootPlanId,
            idempotencyDigest: createHash('sha256').update(idempotencyKey.trim()).digest('hex'),
          },
          occurredAt: new Date().toISOString(),
          correlationId: plan.planId,
        });
        plan = this.repositories.plans.getPlan(plan.planId);
      }
    }

    this.retireSupervisor(planId);
    const cancellationDigest = createHash('sha256')
      .update(idempotencyKey.trim())
      .digest('hex')
      .slice(0, 32);
    const settledExecutions = new Set<string>();
    const cancelledExecutionIds = new Set<string>();
    for (let round = 0; round < 3; round += 1) {
      const pending = this.repositories.executions
        .listByPlan(planId)
        .filter(
          (execution) =>
            execution.status !== 'SUCCEEDED' &&
            !settledExecutions.has(execution.identity.executionId),
        )
        .sort((left, right) => {
          const leftActive = left.status === 'QUEUED' || left.status === 'RUNNING' ? 0 : 1;
          const rightActive = right.status === 'QUEUED' || right.status === 'RUNNING' ? 0 : 1;
          if (leftActive !== rightActive) return leftActive - rightActive;
          if (left.identity.workItemId === right.identity.workItemId)
            return right.identity.attempt - left.identity.attempt;
          return right.createdAt.localeCompare(left.createdAt);
        });
      if (pending.length === 0) break;
      if (!this.executionCancellation)
        throw new ForgeFlowError('PROJECT_PLAN_CANCEL_EXECUTION_RUNTIME_REQUIRED');
      for (const execution of pending) {
        const result = await this.executionCancellation.cancelExecution(
          execution.identity.executionId,
          'plan-cancel:' + cancellationDigest + ':' + execution.identity.executionId,
          reason.trim(),
        );
        const durable = this.repositories.executions.get(execution.identity.executionId);
        if (durable.status === 'CANCELLED') {
          if (result.status !== 'SUCCEEDED')
            throw new ForgeFlowError(result.code || 'PROJECT_PLAN_CANCEL_EXECUTION_CLEANUP_FAILED');
          settledExecutions.add(durable.identity.executionId);
          cancelledExecutionIds.add(durable.identity.executionId);
          continue;
        }
        if (durable.status === 'SUCCEEDED') {
          settledExecutions.add(durable.identity.executionId);
          continue;
        }
        throw new ForgeFlowError(result.code || 'PROJECT_PLAN_CANCEL_EXECUTION_FAILED');
      }
    }
    const unsettled = this.repositories.executions
      .listByPlan(planId)
      .filter(
        (execution) =>
          execution.status !== 'SUCCEEDED' &&
          !settledExecutions.has(execution.identity.executionId),
      );
    if (unsettled.length > 0) throw new ForgeFlowError('PROJECT_PLAN_CANCEL_EXECUTIONS_ACTIVE');

    const cancelledReviewIds: string[] = [];
    for (const review of this.repositories.reviews.listByPlan(planId)) {
      if (review.status === 'PASSED' || review.status === 'CANCELLED') continue;
      this.repositories.reviews.updateStatus(review.reviewId, 'CANCELLED');
      cancelledReviewIds.push(review.reviewId);
    }

    const cancelledWorkItemIds: string[] = [];
    for (const item of this.repositories.plans.listWorkItems(planId)) {
      if (item.status === 'SUCCEEDED' || item.status === 'CANCELLED' || item.status === 'SUPERSEDED')
        continue;
      this.repositories.plans.updateWorkItemStatus(item.workItemId, 'CANCELLED');
      cancelledWorkItemIds.push(item.workItemId);
    }

    plan = this.repositories.plans.getPlan(planId);
    if (preserveFailedPlan) {
      if (plan.status !== 'FAILED') throw new ForgeFlowError('PROJECT_PLAN_FAILED_CLEANUP_STALE');
    } else if (plan.status !== 'CANCELLED') {
      if (plan.status !== 'SAFETY_HOLD') throw new ForgeFlowError('PROJECT_PLAN_CANCEL_STALE');
      const cancelled = this.repositories.plans.compareAndSetStatus(
        plan.planId,
        'SAFETY_HOLD',
        'CANCELLED',
      );
      if (cancelled.status === 'rejected')
        throw new ForgeFlowError(cancelled.reason ?? 'PROJECT_PLAN_CANCEL_STALE');
    }
    return {
      cancelledExecutionIds: [...cancelledExecutionIds].sort(),
      cancelledWorkItemIds: cancelledWorkItemIds.sort(),
      cancelledReviewIds: cancelledReviewIds.sort(),
    };
  }

  private rootPlanIdFor(planId: string): string {
    let current = this.repositories.plans.getPlan(planId);
    const seen = new Set<string>();
    while (current.parentPlanId) {
      if (seen.has(current.planId)) throw new ForgeFlowError('CHILD_PLAN_CYCLE_DETECTED');
      seen.add(current.planId);
      current = this.repositories.plans.getPlan(current.parentPlanId);
    }
    return current.planId;
  }

  private firstNonTerminalDescendant(planId: string): string | undefined {
    const stack = [...this.repositories.relationships.getChildren(planId)];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const childPlanId = stack.shift()!;
      if (seen.has(childPlanId)) continue;
      seen.add(childPlanId);
      const child = this.repositories.plans.getPlan(childPlanId);
      if (!isTerminalPlanStatus(child.status)) return childPlanId;
      stack.push(...this.repositories.relationships.getChildren(childPlanId));
    }
    return undefined;
  }

  private handoffResult(
    projectKey: string,
    handoff: RootPlanHandoffResult,
  ): ProjectPlanQueueRuntimeResult {
    return {
      projectKey,
      releasedPlanId: handoff.releasedPlanId,
      ...(handoff.activatedPlanId ? { activatedPlanId: handoff.activatedPlanId } : {}),
      code: handoff.activatedPlanId
        ? 'PROJECT_PLAN_HANDOFF_ACTIVATED'
        : 'PROJECT_PLAN_LEASE_RELEASED',
    };
  }

  private ensureSupervisorActive(planId: string): void {
    let supervisor = this.repositories.supervisors.getByPlanId(planId);
    if (!supervisor) {
      supervisor = this.repositories.supervisors.create({ planId }).value;
      if (!supervisor) throw new ForgeFlowError('SUPERVISOR_CREATE_FAILED');
    }
    if (supervisor.status === 'CREATED') {
      this.repositories.supervisors.updateStatus(supervisor.supervisorId, 'ACTIVE');
    }
  }

  private retireSupervisor(planId: string): void {
    const supervisor = this.repositories.supervisors.getByPlanId(planId);
    if (!supervisor || supervisor.status === 'COMPLETED' || supervisor.status === 'CANCELLED')
      return;
    this.repositories.supervisors.updateStatus(supervisor.supervisorId, 'CANCELLED');
  }
}
