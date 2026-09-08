import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';

import type { KernelAssembly } from './applicationAssembly.js';
import type { ExecutionAutomationRuntime } from './executionRuntime.js';
import type { SupervisorRuntimeAssembly } from './supervisorRuntime.js';
import type { MaintenanceImprovementRuntime } from '../core/orchestration/maintenanceRuntime.js';
import type { ProjectPlanQueueRuntime } from '../core/orchestration/projectPlanQueueRuntime.js';
import type { ForgeFlowRepositories } from '../core/persistence/repositories.js';
import type { ProjectRegistry } from '../platform/projects/index.js';

export interface BuildControlPlaneOptions {
  env?: NodeJS.ProcessEnv;
  dbFile?: string;
  logger?: boolean;
  environment?: 'test' | 'development' | 'staging' | 'production';
  allowDataReset?: boolean;
  fetchImpl?: typeof fetch;
}

export interface ControlPlaneRuntime {
  app: FastifyInstance;
  db: DatabaseSync;
  dbFile: string;
  host: string;
  port: number;
  repositories: ForgeFlowRepositories;
  projects: ProjectRegistry;
  kernels: KernelAssembly;
  supervisor: Pick<
    SupervisorRuntimeAssembly,
    | 'actions'
    | 'openHands'
    | 'scheduler'
    | 'runtime'
    | 'directAdmission'
    | 'reconcileDirectAdmission'
    | 'reconcileReadiness'
  >;
  automation?: ExecutionAutomationRuntime;
  improvements: MaintenanceImprovementRuntime;
  projectPlanQueue?: ProjectPlanQueueRuntime;
  singleActivePlanEnabled: boolean;
  literalWorktreesEnabled: boolean;
}
