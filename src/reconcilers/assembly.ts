import type { ForgeFlowBootstrapConfig } from '../bootstrap/config.js';
import type { ExecutionAutomationRuntime } from '../bootstrap/executionRuntime.js';
import type { ImprovementRuntimeAssembly } from '../bootstrap/improvementRuntime.js';
import type { SupervisorRuntimeAssembly } from '../bootstrap/supervisorRuntime.js';
import type { ProjectPlanQueueRuntime } from '../core/orchestration/projectPlanQueueRuntime.js';
import type { ForgeFlowRepositories } from '../core/persistence/repositories.js';
import { ImprovementReconciler } from './improvement.js';
import { ReconcilerLifecycleManager } from './lifecycle.js';
import { PlanLifecycleReconciler } from './planLifecycle.js';
import { ResourceLifecycleReconciler } from './resourceLifecycle.js';
import { RuntimeAdmissionReconciler } from './runtimeAdmission.js';
import { StorageMaintenanceReconciler } from './storageMaintenance.js';
import { SupervisorReconciler } from './supervisor.js';

export interface ReconcilerAssemblyLogger {
  info(data: unknown, message: string): void;
  error(data: unknown, message: string): void;
  warn(data: unknown, message: string): void;
}

export interface ReconcilerAssembly {
  lifecycle: ReconcilerLifecycleManager;
  runtimeAdmission: RuntimeAdmissionReconciler;
  storage: StorageMaintenanceReconciler;
  supervisor: SupervisorReconciler;
  resources: ResourceLifecycleReconciler;
  improvement: ImprovementReconciler;
  plans: PlanLifecycleReconciler;
}

export function buildReconcilerAssembly(input: {
  config: ForgeFlowBootstrapConfig;
  repositories: ForgeFlowRepositories;
  automation?: ExecutionAutomationRuntime;
  runtimeAdmission: RuntimeAdmissionReconciler;
  projectPlanQueue?: ProjectPlanQueueRuntime;
  supervisor: SupervisorRuntimeAssembly;
  improvement: ImprovementRuntimeAssembly;
  hostCacheStatus(): unknown;
  logger: ReconcilerAssemblyLogger;
}): ReconcilerAssembly {
  const runtimeAdmission = input.runtimeAdmission;
  const storage = new StorageMaintenanceReconciler(
    input.repositories,
    input.automation,
    input.hostCacheStatus,
    input.logger,
  );
  const supervisor = new SupervisorReconciler(
    input.supervisor,
    input.config.supervisor,
    input.logger,
  );
  const resources = new ResourceLifecycleReconciler(
    input.automation,
    supervisor,
    runtimeAdmission,
    input.config.automation,
    input.logger,
  );
  const improvement = new ImprovementReconciler(
    input.improvement,
    input.config.improvement,
    input.logger,
  );
  const plans = new PlanLifecycleReconciler(
    input.automation,
    input.projectPlanQueue,
    storage,
    runtimeAdmission,
    input.config.automation,
    input.logger,
  );
  const lifecycle = new ReconcilerLifecycleManager(
    [runtimeAdmission, storage, supervisor, resources, improvement, plans],
    input.logger,
  );
  return { lifecycle, runtimeAdmission, storage, supervisor, resources, improvement, plans };
}
