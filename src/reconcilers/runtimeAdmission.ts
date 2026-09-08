import type { ExecutionAutomationRuntime } from '../bootstrap/executionRuntime.js';
import type { ReconcileContext, Reconciler } from './contracts.js';

export interface RuntimeAdmissionLogger {
  error(data: unknown, message: string): void;
  warn(data: unknown, message: string): void;
}

export class RuntimeAdmissionReconciler implements Reconciler {
  readonly id = 'runtime-admission';
  readonly enabled: boolean;
  readonly intervalMs = undefined;
  private running?: Promise<void>;
  private closed = false;

  constructor(
    private readonly automation: ExecutionAutomationRuntime | undefined,
    private readonly logger: RuntimeAdmissionLogger,
  ) {
    this.enabled = Boolean(automation?.runtimeAdmissionEnabled);
  }

  async warmup(_context: ReconcileContext): Promise<void> {
    await this.request();
  }

  async reconcile(_context: ReconcileContext): Promise<void> {
    await this.request();
  }

  async request(): Promise<void> {
    if (this.closed || !this.enabled || !this.automation) return;
    if (this.running) return await this.running;
    this.running = this.automation.reconcileRuntimeAdmission();
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }

  requestDetached(): void {
    void this.request().catch((error) =>
      this.logger.error(this.errorProjection(error), 'runtime admission cycle failed'),
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.automation) return;
    try {
      await this.automation.shutdownRuntimeAdmission();
    } catch (error) {
      this.logger.warn(this.errorProjection(error), 'runtime admission shutdown drain failed');
    }
    if (this.running) await Promise.allSettled([this.running]);
  }

  private errorProjection(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
