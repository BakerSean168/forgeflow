export type ReconcileTrigger = 'WARMUP' | 'INTERVAL' | 'MANUAL';

export interface ReconcileContext {
  trigger: ReconcileTrigger;
}

export interface Reconciler {
  readonly id: string;
  readonly enabled: boolean;
  readonly intervalMs?: number;
  warmup?(context: ReconcileContext): Promise<void>;
  reconcile(context: ReconcileContext): Promise<void>;
  close?(): Promise<void>;
}

export interface ReconcilerLogger {
  error(data: unknown, message: string): void;
}

export interface ReconcilerClock {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
  setImmediate(callback: () => void): unknown;
  clearImmediate(handle: unknown): void;
}

export interface ReconcileRunResult {
  reconcilerId: string;
  status: 'COMPLETED' | 'SKIPPED_DISABLED' | 'SKIPPED_RUNNING' | 'SKIPPED_CLOSED';
  trigger: ReconcileTrigger;
}
