import { ForgeFlowError } from '../core/domain/errors.js';
import type {
  ReconcileRunResult,
  ReconcileTrigger,
  Reconciler,
  ReconcilerClock,
  ReconcilerLogger,
} from './contracts.js';

const systemClock: ReconcilerClock = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setImmediate: (callback) => setImmediate(callback),
  clearImmediate: (handle) => clearImmediate(handle as ReturnType<typeof setImmediate>),
};

export class ReconcilerLifecycleManager {
  private readonly byId = new Map<string, Reconciler>();
  private readonly intervals = new Map<string, unknown>();
  private readonly warmups = new Map<string, unknown>();
  private readonly running = new Map<string, Promise<ReconcileRunResult>>();
  private started = false;
  private closed = false;

  constructor(
    reconcilers: readonly Reconciler[],
    private readonly logger: ReconcilerLogger,
    private readonly clock: ReconcilerClock = systemClock,
  ) {
    for (const reconciler of reconcilers) {
      if (!reconciler.id.trim()) throw new ForgeFlowError('RECONCILER_ID_REQUIRED');
      if (this.byId.has(reconciler.id)) throw new ForgeFlowError('RECONCILER_ID_DUPLICATE');
      if (
        reconciler.intervalMs !== undefined &&
        (!Number.isInteger(reconciler.intervalMs) || reconciler.intervalMs < 1)
      )
        throw new ForgeFlowError('RECONCILER_INTERVAL_INVALID');
      this.byId.set(reconciler.id, reconciler);
    }
  }

  start(): void {
    if (this.closed) throw new ForgeFlowError('RECONCILER_LIFECYCLE_CLOSED');
    if (this.started) return;
    this.started = true;
    for (const reconciler of this.byId.values()) {
      if (!reconciler.enabled) continue;
      if (reconciler.warmup) {
        const handle = this.clock.setImmediate(() => {
          this.warmups.delete(reconciler.id);
          void this.run(reconciler, 'WARMUP').catch((error) =>
            this.logger.error(this.errorProjection(error, reconciler.id, 'WARMUP'), 'reconciler warmup failed'),
          );
        });
        this.warmups.set(reconciler.id, handle);
      }
      if (reconciler.intervalMs !== undefined) {
        const handle = this.clock.setInterval(() => {
          void this.run(reconciler, 'INTERVAL').catch((error) =>
            this.logger.error(
              this.errorProjection(error, reconciler.id, 'INTERVAL'),
              'reconciler interval failed',
            ),
          );
        }, reconciler.intervalMs);
        this.intervals.set(reconciler.id, handle);
      }
    }
  }

  async runNow(reconcilerId: string): Promise<ReconcileRunResult> {
    const reconciler = this.byId.get(reconcilerId);
    if (!reconciler) throw new ForgeFlowError('RECONCILER_NOT_FOUND');
    return await this.run(reconciler, 'MANUAL');
  }

  private async run(reconciler: Reconciler, trigger: ReconcileTrigger): Promise<ReconcileRunResult> {
    if (this.closed)
      return { reconcilerId: reconciler.id, status: 'SKIPPED_CLOSED', trigger };
    if (!reconciler.enabled)
      return { reconcilerId: reconciler.id, status: 'SKIPPED_DISABLED', trigger };
    const active = this.running.get(reconciler.id);
    if (active)
      return { reconcilerId: reconciler.id, status: 'SKIPPED_RUNNING', trigger };

    const promise = (async (): Promise<ReconcileRunResult> => {
      if (trigger === 'WARMUP' && reconciler.warmup) await reconciler.warmup({ trigger });
      else await reconciler.reconcile({ trigger });
      return { reconcilerId: reconciler.id, status: 'COMPLETED', trigger };
    })();
    this.running.set(reconciler.id, promise);
    try {
      return await promise;
    } finally {
      if (this.running.get(reconciler.id) === promise) this.running.delete(reconciler.id);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const handle of this.intervals.values()) this.clock.clearInterval(handle);
    this.intervals.clear();
    for (const handle of this.warmups.values()) this.clock.clearImmediate(handle);
    this.warmups.clear();
    // Close hooks run first so capability-specific controllers can abort/stop remote work.
    // The DB owner closes only after every lifecycle-managed reconciliation that was already
    // in flight has settled; this prevents a shutdown-time use-after-close race.
    const inFlight = [...this.running.values()];
    for (const reconciler of this.byId.values()) if (reconciler.close) await reconciler.close();
    await Promise.allSettled(inFlight);
  }

  private errorProjection(error: unknown, reconcilerId: string, trigger: ReconcileTrigger) {
    return {
      reconcilerId,
      trigger,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
