import type { ForgeFlowBootstrapConfig } from '../bootstrap/config.js';
import type { ExecutionAutomationRuntime } from '../bootstrap/executionRuntime.js';
import type { ProjectPlanQueueRuntime } from '../core/orchestration/projectPlanQueueRuntime.js';
import type { ReconcileContext, Reconciler } from './contracts.js';
import type { RuntimeAdmissionReconciler } from './runtimeAdmission.js';
import type { StorageMaintenanceReconciler } from './storageMaintenance.js';

export interface PlanLifecycleLogger {
  info(data: unknown, message: string): void;
}

export class PlanLifecycleReconciler implements Reconciler {
  readonly id = 'plan-lifecycle';
  readonly enabled: boolean;
  readonly intervalMs: number;

  constructor(
    private readonly automation: ExecutionAutomationRuntime | undefined,
    private readonly projectPlanQueue: ProjectPlanQueueRuntime | undefined,
    private readonly storage: StorageMaintenanceReconciler,
    private readonly runtimeAdmission: RuntimeAdmissionReconciler,
    config: ForgeFlowBootstrapConfig['automation'],
    private readonly logger: PlanLifecycleLogger,
  ) {
    this.enabled = Boolean(automation && config.enabled);
    this.intervalMs = config.pollMs;
  }

  async reconcile(context: ReconcileContext): Promise<void> {
    if (!this.automation) return;
    await this.storage.reconcile(context);
    if (this.projectPlanQueue) await this.projectPlanQueue.reconcile();
    const results = await this.automation.plans.runOnce();
    // Admission refresh stays detached so slow standby probes cannot starve active execution heartbeats.
    this.runtimeAdmission.requestDetached();
    for (const result of results)
      if (result.status !== 'SKIPPED')
        this.logger.info(
          {
            planId: result.planId,
            workItemId: result.workItemId,
            executionId: result.executionId,
            status: result.status,
            code: result.code,
          },
          'plan automation cycle',
        );
  }
}
