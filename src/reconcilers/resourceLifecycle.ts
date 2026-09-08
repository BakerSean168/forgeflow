import type { ForgeFlowBootstrapConfig } from '../bootstrap/config.js';
import type { ExecutionAutomationRuntime } from '../bootstrap/executionRuntime.js';
import type { SupervisorReconciler } from './supervisor.js';
import type { ReconcileContext, Reconciler } from './contracts.js';
import type { RuntimeAdmissionReconciler } from './runtimeAdmission.js';

export interface ResourceLifecycleLogger {
  info(data: unknown, message: string): void;
}

export class ResourceLifecycleReconciler implements Reconciler {
  readonly id = 'resource-lifecycle';
  readonly enabled: boolean;
  readonly intervalMs: number;

  constructor(
    private readonly automation: ExecutionAutomationRuntime | undefined,
    private readonly supervisor: SupervisorReconciler,
    private readonly runtimeAdmission: RuntimeAdmissionReconciler,
    config: ForgeFlowBootstrapConfig['automation'],
    private readonly logger: ResourceLifecycleLogger,
  ) {
    this.enabled = Boolean(automation?.resourceSelectorEnabled);
    this.intervalMs = config.resourceRefreshMs;
  }

  async reconcile(_context: ReconcileContext): Promise<void> {
    if (!this.automation) return;
    await this.automation.liteLlmResources.refresh();
    await this.automation.resourceLifecycle.reconcileOnce();
    const resourceWake = await this.supervisor.reconcileReadiness();
    if (resourceWake.scheduledWakes > 0)
      this.logger.info(resourceWake, 'resource availability woke waiting supervisors');
    await this.runtimeAdmission.request();
  }
}
