import type { PlanDeliveryConfig } from '../../core/domain/delivery.js';
import { ForgeFlowError } from '../../core/domain/errors.js';
import type { PlanStatus } from '../../core/domain/plan.js';
import type { PlanKernel } from '../../core/kernel/planKernel.js';
import type { WorkspaceProviderPort } from '../../core/orchestration/contracts.js';
import type { ProjectPlanQueueRuntime } from '../../core/orchestration/projectPlanQueueRuntime.js';
import type { ForgeFlowRepositories } from '../../core/persistence/repositories.js';
import type { ProjectRegistry } from '../../platform/projects/index.js';

export interface PlanGraphItemInput {
  itemKey: string;
  title: string;
  objective: string;
  dependencies: string[];
  acceptanceCriteria: string[];
  parallelSafe: boolean;
  writeScopes: string[];
  conflictKeys: string[];
}

export interface PlanWriteScopeAmendmentInput {
  itemKey: string;
  expectedWriteScopes: string[];
  writeScopes: string[];
  reason: string;
}

export interface PlanAutomationPort {
  workspace: WorkspaceProviderPort;
  literalWorktreeProjectKeys: string[];
  planWorktreeManager?: { ensurePlanActivated(planId: string): Promise<unknown> };
  plans: {
    runPlan(planId: string): Promise<unknown>;
    reconcilePlan(planId: string, mode?: string): Promise<unknown>;
  };
}

export interface PlanApplicationDependencies {
  repositories: ForgeFlowRepositories;
  planKernel: PlanKernel;
  projects: ProjectRegistry;
  projectPlanQueue?: ProjectPlanQueueRuntime;
  singleActivePlanEnabled: boolean;
  requireAutomation(): PlanAutomationPort;
  automation?: PlanAutomationPort;
  runtimeAdmission: { request(): Promise<void> };
}

export interface CreateRootPlanInput {
  idempotencyKey: string;
  projectKey: string;
  objective: string;
  requestedRepositoryPath?: string;
  baseRevision: string;
  delivery?: PlanDeliveryConfig;
  workItems: PlanGraphItemInput[];
  priority: number;
}

export interface CreateChildPlanInput {
  parentPlanId: string;
  childPlanId: string;
  repositoryPath?: string;
  objective: string;
  relation: 'SYSTEM_REPAIR' | 'INFRASTRUCTURE_REPAIR' | 'FOLLOW_UP';
  delivery?: PlanDeliveryConfig;
  workItems: PlanGraphItemInput[];
}

export class PlanApplication {
  constructor(private readonly dependencies: PlanApplicationDependencies) {}

  private async adoptIdleExternalProjectHead(input: {
    projectKey: string;
    repositoryPath: string;
    requestedBaseRevision: string;
  }): Promise<void> {
    if (!this.dependencies.singleActivePlanEnabled || !this.dependencies.projectPlanQueue) return;
    const lease = this.dependencies.repositories.projectPlans.getLease(input.projectKey);
    const committedRevision = lease?.committedRevision?.trim();
    if (!lease || lease.activeRootPlanId || !committedRevision) return;

    const workspace = this.dependencies.automation?.workspace;
    if (!workspace) return;
    const observation = await workspace.observeRepository(
      input.repositoryPath,
      input.requestedBaseRevision,
    );
    if (!observation.clean) throw new ForgeFlowError('PROJECT_PLAN_CANONICAL_REPOSITORY_DIRTY');
    if (!observation.commitExists) throw new ForgeFlowError('PROJECT_PLAN_BASE_REVISION_NOT_FOUND');
    if (observation.headRevision === committedRevision) {
      if (input.requestedBaseRevision !== committedRevision)
        throw new ForgeFlowError('PROJECT_PLAN_BASE_NOT_CANONICAL_HEAD');
      return;
    }
    if (observation.headRevision !== input.requestedBaseRevision)
      throw new ForgeFlowError('PROJECT_PLAN_EXTERNAL_HEAD_UNACKNOWLEDGED');
    if (!workspace.isRevisionAncestor)
      throw new ForgeFlowError('PROJECT_PLAN_EXTERNAL_HEAD_ANCESTRY_UNAVAILABLE');
    if (
      !(await workspace.isRevisionAncestor(
        input.repositoryPath,
        committedRevision,
        observation.headRevision,
      ))
    )
      throw new ForgeFlowError('PROJECT_PLAN_EXTERNAL_HEAD_DIVERGED');

    const adopted = this.dependencies.repositories.projectPlans.adoptIdleCommittedRevision({
      projectKey: input.projectKey,
      repositoryPath: input.repositoryPath,
      expectedVersion: lease.version,
      expectedCommittedRevision: committedRevision,
      nextCommittedRevision: observation.headRevision,
    });
    if (adopted.status === 'rejected')
      throw new ForgeFlowError(adopted.reason ?? 'PROJECT_PLAN_EXTERNAL_HEAD_ADOPTION_FAILED');
  }

  private executionProjection(execution: ReturnType<ForgeFlowRepositories['executions']['get']>) {
    return {
      ...execution,
      resourceSelection:
        this.dependencies.repositories.resourceSelections.get(execution.identity.executionId) ?? null,
    };
  }

  view(planId: string) {
    const repositories = this.dependencies.repositories;
    const plan = repositories.plans.getPlan(planId);
    const graph = repositories.plans.getActiveGraphVersion(planId);
    return {
      plan,
      delivery: plan.delivery ?? null,
      graph,
      workItems: graph ? repositories.plans.listWorkItems(planId, graph.graphVersionId) : [],
      executions: repositories.executions.listByPlan(planId).map((execution) => this.executionProjection(execution)),
      reviews: repositories.reviews.listByPlan(planId),
      sessions: repositories.sessions.listByPlan(planId),
      worktrees: repositories.planWorktrees.listByPlan(planId),
      activationEvents: repositories.events
        .listRecentByAggregate(planId, 500)
        .filter((event) => event.type.startsWith('PLAN_ACTIVATION_')),
      supervisor: repositories.supervisors.getByPlanId(planId),
    };
  }

  list(input: { limit: number; status?: PlanStatus; view?: 'full' | 'summary' }) {
    const repositories = this.dependencies.repositories;
    const plans = repositories.plans.listPlans({
      limit: input.limit,
      ...(input.status ? { status: input.status } : {}),
    });
    const items =
      input.view === 'summary'
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
                .map((execution) => this.executionProjection(execution)),
            };
          })
        : plans.map((plan) => this.view(plan.planId));
    return { items, count: items.length };
  }

  queue(projectKey: string) {
    this.requireProjectPlanQueue();
    const repositories = this.dependencies.repositories;
    return {
      projectKey,
      lease: repositories.projectPlans.getLease(projectKey) ?? null,
      items: repositories.projectPlans.listQueue(projectKey),
    };
  }

  reprioritize(planId: string, priority: number) {
    this.requireProjectPlanQueue();
    const result = this.dependencies.repositories.projectPlans.reprioritize(planId, priority);
    if (result.status === 'rejected')
      throw new ForgeFlowError(result.reason ?? 'PROJECT_PLAN_REPRIORITIZE_FAILED');
    return { queueEntry: result.value, mutation: result.status };
  }

  cancelQueued(planId: string) {
    const runtime = this.requireProjectPlanQueue();
    runtime.cancelQueued(planId);
    return {
      plan: this.dependencies.repositories.plans.getPlan(planId),
      queueEntry: this.dependencies.repositories.projectPlans.getQueueEntry(planId) ?? null,
    };
  }

  async cancel(planId: string, idempotencyKey: string, reason: string) {
    const runtime = this.requireProjectPlanQueue();
    const result = await runtime.cancelPlan(planId, idempotencyKey, reason);
    const plan = this.dependencies.repositories.plans.getPlan(planId);
    return {
      ...result,
      plan,
      lease: this.dependencies.repositories.projectPlans.getLease(plan.projectKey) ?? null,
    };
  }

  async createRoot(input: CreateRootPlanInput) {
    const repositories = this.dependencies.repositories;
    const repositoryPath = this.dependencies.projects.resolveRepository(
      input.projectKey,
      input.requestedRepositoryPath,
    );
    if (!repositoryPath) throw new ForgeFlowError('PLAN_REPOSITORY_REQUIRED');
    await this.adoptIdleExternalProjectHead({
      projectKey: input.projectKey,
      repositoryPath,
      requestedBaseRevision: input.baseRevision,
    });
    const planResult = this.dependencies.planKernel.createPlan({
      idempotencyKey: input.idempotencyKey,
      projectKey: input.projectKey,
      objective: input.objective,
      repositoryPath,
      baseRevision: input.baseRevision,
      ...(input.delivery ? { delivery: input.delivery } : {}),
    });
    const plan = planResult.value;
    if (!plan) throw new ForgeFlowError('PLAN_CREATE_FAILED');
    const graph = this.dependencies.planKernel.ensureReadyGraph(plan.planId, input.workItems, {
      activate: !this.dependencies.singleActivePlanEnabled,
    });
    const scheduling = this.dependencies.projectPlanQueue
      ? this.dependencies.projectPlanQueue.scheduleRootPlan(plan.planId, input.priority)
      : undefined;
    if (
      scheduling?.status === 'ACTIVE' &&
      this.dependencies.automation?.planWorktreeManager &&
      this.dependencies.automation.literalWorktreeProjectKeys.includes(plan.projectKey)
    )
      await this.dependencies.automation.planWorktreeManager.ensurePlanActivated(plan.planId);

    let supervisor = repositories.supervisors.getByPlanId(plan.planId);
    if (!this.dependencies.projectPlanQueue) {
      supervisor = supervisor ?? repositories.supervisors.create({ planId: plan.planId }).value;
      if (!supervisor) throw new ForgeFlowError('SUPERVISOR_CREATE_FAILED');
      if (supervisor.status === 'CREATED')
        repositories.supervisors.updateStatus(supervisor.supervisorId, 'ACTIVE');
      supervisor = repositories.supervisors.getById(supervisor.supervisorId);
    } else if (scheduling?.status === 'ACTIVE') {
      supervisor = repositories.supervisors.getByPlanId(plan.planId);
    }

    return {
      created: planResult.status === 'created',
      value: {
        plan: repositories.plans.getPlan(plan.planId),
        graph,
        supervisor: supervisor ?? null,
        ...(scheduling ? { scheduling } : {}),
      },
    };
  }

  createChild(input: CreateChildPlanInput) {
    const repositories = this.dependencies.repositories;
    const parent = repositories.plans.getPlan(input.parentPlanId);
    const child = this.dependencies.planKernel.createChildPlan({
      parentPlanId: input.parentPlanId,
      childPlanId: input.childPlanId,
      repositoryPath: input.repositoryPath ?? parent.repositoryPath,
      objective: input.objective,
      relation: input.relation,
    });
    const graph = this.dependencies.planKernel.ensureReadyGraph(child.plan.planId, input.workItems);
    if (input.delivery) repositories.plans.attachDelivery(child.plan.planId, input.delivery);
    let supervisor = repositories.supervisors.getByPlanId(child.plan.planId);
    if (!supervisor) {
      supervisor = repositories.supervisors.create({ planId: child.plan.planId }).value;
      if (!supervisor) throw new ForgeFlowError('SUPERVISOR_CREATE_FAILED');
      if (supervisor.status === 'CREATED')
        repositories.supervisors.updateStatus(supervisor.supervisorId, 'ACTIVE');
    }
    return {
      plan: repositories.plans.getPlan(child.plan.planId),
      graph,
      relationshipId: child.relationshipId,
      supervisor: repositories.supervisors.getByPlanId(child.plan.planId),
      statusUrl: '/api/v1/plans/' + encodeURIComponent(child.plan.planId),
    };
  }

  attachDelivery(planId: string, config: PlanDeliveryConfig) {
    const result = this.dependencies.repositories.plans.attachDelivery(planId, config);
    return {
      created: result.status === 'created',
      value: {
        planId,
        delivery: result.value,
        statusUrl: '/api/v1/plans/' + encodeURIComponent(planId),
      },
    };
  }

  async run(planId: string) {
    const runtime = this.dependencies.requireAutomation();
    await this.dependencies.runtimeAdmission.request();
    return await runtime.plans.runPlan(planId);
  }

  async reconcile(
    planId: string,
    mode: string,
    scopeAmendments: PlanWriteScopeAmendmentInput[] = [],
  ) {
    if (scopeAmendments.length > 0 && mode !== 'retry-finalization' && mode !== 'retry_finalization')
      throw new ForgeFlowError('WORK_ITEM_SCOPE_AMENDMENT_MODE_INVALID');
    const amended =
      scopeAmendments.length > 0
        ? this.dependencies.repositories.plans.amendFailedWorkItemWriteScopes(planId, scopeAmendments)
        : undefined;
    const runtime = this.dependencies.requireAutomation();
    await this.dependencies.runtimeAdmission.request();
    const result = await runtime.plans.reconcilePlan(planId, mode);
    return {
      ...(result as Record<string, unknown>),
      ...(amended
        ? {
            scopeAmendments: amended.workItems.map((item) => ({
              itemKey: item.itemKey,
              writeScopes: item.writeScopes,
            })),
          }
        : {}),
      statusUrl: '/api/v1/plans/' + encodeURIComponent(planId),
    };
  }

  private requireProjectPlanQueue(): ProjectPlanQueueRuntime {
    if (!this.dependencies.projectPlanQueue) throw new ForgeFlowError('PROJECT_PLAN_QUEUE_DISABLED');
    return this.dependencies.projectPlanQueue;
  }
}
