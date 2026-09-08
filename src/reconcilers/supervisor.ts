import type { ForgeFlowBootstrapConfig } from '../bootstrap/config.js';
import type { SupervisorRuntimeAssembly } from '../bootstrap/supervisorRuntime.js';
import type { ReconcileContext, Reconciler } from './contracts.js';

export interface SupervisorReconcilerLogger {
  info(data: unknown, message: string): void;
}

export class SupervisorReconciler implements Reconciler {
  readonly id = 'supervisor';
  readonly enabled: boolean;
  readonly intervalMs?: number;
  readonly warmup?: (context: ReconcileContext) => Promise<void>;

  constructor(
    private readonly supervisor: SupervisorRuntimeAssembly,
    config: ForgeFlowBootstrapConfig['supervisor'],
    private readonly logger: SupervisorReconcilerLogger,
  ) {
    this.enabled = supervisor.enabled || supervisor.directAdmissionEnabled;
    this.intervalMs = supervisor.enabled ? config.pollMs : undefined;
    if (supervisor.directAdmissionEnabled)
      this.warmup = async () => {
        const resourceWake = await this.reconcileReadiness();
        if (resourceWake.scheduledWakes > 0)
          logger.info(resourceWake, 'Supervisor admission warmup woke waiting supervisors');
      };
  }

  async reconcileDirectAdmission(): Promise<void> {
    await this.supervisor.reconcileDirectAdmission();
  }

  async reconcileReadiness(): Promise<{ becameAvailable: string[]; scheduledWakes: number }> {
    return await this.supervisor.reconcileReadiness();
  }

  async reconcile(_context: ReconcileContext): Promise<void> {
    if (!this.supervisor.enabled) return;
    const resourceWake = await this.reconcileReadiness();
    if (resourceWake.scheduledWakes > 0)
      this.logger.info(resourceWake, 'Supervisor admission woke waiting supervisors');
    const results = await this.supervisor.runtime.runOnce();
    for (const result of results)
      if (result.status !== 'SKIPPED')
        this.logger.info(
          { supervisorId: result.supervisorId, status: result.status, code: result.code },
          'supervisor runtime cycle',
        );
  }
}
