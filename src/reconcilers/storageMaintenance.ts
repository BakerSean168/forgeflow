import type { ExecutionAutomationRuntime } from '../bootstrap/executionRuntime.js';
import type { ForgeFlowRepositories } from '../core/persistence/repositories.js';
import type { ReconcileContext, Reconciler } from './contracts.js';

export interface StorageMaintenanceLogger {
  warn(data: unknown, message: string): void;
}

export class StorageMaintenanceReconciler implements Reconciler {
  readonly id = 'storage-maintenance';
  readonly enabled: boolean;
  readonly intervalMs = undefined;
  private running?: Promise<unknown>;

  constructor(
    private readonly repositories: ForgeFlowRepositories,
    private readonly automation: ExecutionAutomationRuntime | undefined,
    private readonly hostCacheStatus: () => unknown,
    private readonly logger: StorageMaintenanceLogger,
  ) {
    this.enabled = Boolean(automation);
  }

  workspaceStatus(): unknown {
    return this.automation?.workspace.storageStatus?.() ?? null;
  }

  hostCacheMaintenanceStatus(): unknown {
    return this.hostCacheStatus();
  }

  async reconcile(context: ReconcileContext): Promise<void> {
    await this.runMaintenance(context);
  }

  async runMaintenance(_context: ReconcileContext = { trigger: 'MANUAL' }): Promise<unknown> {
    if (this.running) return await this.running;
    this.running = (async () => {
      if (!this.automation?.workspace.storageStatus || !this.automation.workspace.pruneTerminalCaches)
        return null;
      const before = this.automation.workspace.storageStatus();
      if (!before.lowCapacity) return null;
      const terminal = this.repositories.executions.listByStatuses(
        ['SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED'],
        1000,
      );
      const workspaces = terminal
        .map(
          (execution) => this.repositories.sessions.getOptional(execution.identity.executionId)?.workspace,
        )
        .filter((workspace): workspace is NonNullable<typeof workspace> => Boolean(workspace));
      const result = await this.automation.workspace.pruneTerminalCaches(workspaces);
      this.logger.warn(
        {
          ...result,
          minimumFreeBytes: before.minimumFreeBytes,
          terminalExecutions: terminal.length,
        },
        'workspace storage high-watermark cleanup',
      );
      return result;
    })();
    try {
      return await this.running;
    } finally {
      this.running = undefined;
    }
  }
}
