import { isTerminalPlanStatus } from '../core/domain/plan.js';
import type { ProjectPlanQueueRuntime } from '../core/orchestration/projectPlanQueueRuntime.js';
import type { ForgeFlowRepositories } from '../core/persistence/repositories.js';
import type { ExecutionAutomationRuntime } from './executionRuntime.js';

export async function initializeProjectScheduling(input: {
  repositories: ForgeFlowRepositories;
  projectPlanQueue?: ProjectPlanQueueRuntime;
  automation?: ExecutionAutomationRuntime;
}): Promise<void> {
  const { repositories, projectPlanQueue, automation } = input;
  if (projectPlanQueue && automation) {
    projectPlanQueue.setExecutionCancellation({
      cancelExecution: async (executionId, idempotencyKey, reason) =>
        await automation.worker.cancelExecution(executionId, idempotencyKey, reason),
      cleanupProviderSession: async (executionId, idempotencyKey, reason) =>
        await automation.worker.cleanupProviderSession(executionId, idempotencyKey, reason),
    });
  }
  if (!projectPlanQueue) return;

  projectPlanQueue.bootstrapExistingRootPlans();
  if (!automation?.planWorktreeManager) return;
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
