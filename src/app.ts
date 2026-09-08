import Fastify from 'fastify';

import { registerOpenApi } from './api/openapi.js';
import { registerApiErrorHandler } from './api/shared/errors.js';
import { registerApiModules } from './api/module.js';
import { createExecutionApiModule } from './api/v1/executions/index.js';
import { createImprovementApiModule } from './api/v1/improvements/index.js';
import { createPlanApiModule } from './api/v1/plans/index.js';
import { createProjectApiModule } from './api/v1/projects.js';
import { createResourceApiModule } from './api/v1/resources/index.js';
import { createSupervisorApiModule } from './api/v1/supervisors/index.js';
import { createSystemApiModule } from './api/v1/system/index.js';
import { buildApplicationAssembly, buildSupervisorActions, requireExecutionRuntime } from './bootstrap/applicationAssembly.js';
import { loadBootstrapConfig } from './bootstrap/config.js';
import type { BuildControlPlaneOptions, ControlPlaneRuntime } from './bootstrap/controlPlaneTypes.js';
import { buildExecutionAutomation } from './bootstrap/executionRuntime.js';
import { buildImprovementRuntime } from './bootstrap/improvementRuntime.js';
import { initializeProjectScheduling } from './bootstrap/projectScheduling.js';
import { buildSupervisorRuntime } from './bootstrap/supervisorRuntime.js';
import { bindReleaseProvenance, createAutonomousLifecycleAcceptanceProjection, readHostCacheMaintenance } from './bootstrap/systemState.js';
import { buildReconcilerAssembly } from './reconcilers/assembly.js';
import { RuntimeAdmissionReconciler } from './reconcilers/runtimeAdmission.js';
import { ForgeFlowError } from './core/domain/errors.js';
import {
  DeliveryKernel,
  ExecutionKernel,
  PlanKernel,
  RecoveryKernel,
  ReviewKernel,
  WorkGraphKernel,
} from './core/kernel/index.js';
import { ProjectPlanQueueRuntime } from './core/orchestration/projectPlanQueueRuntime.js';
import { bootstrapForgeFlow } from './core/persistence/bootstrap.js';
import { createRepositories } from './core/persistence/repositories.js';

export type { BuildControlPlaneOptions, ControlPlaneRuntime } from './bootstrap/controlPlaneTypes.js';

export async function buildControlPlane(
  options: BuildControlPlaneOptions = {},
): Promise<ControlPlaneRuntime> {
  const { config, projects } = loadBootstrapConfig(options.env, {
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.dbFile ? { dbFile: options.dbFile } : {}),
    ...(options.allowDataReset === undefined ? {} : { allowDataReset: options.allowDataReset }),
  });
  const releaseProvenance = bindReleaseProvenance(
    config.release.provenanceFile,
  );
  const boot = bootstrapForgeFlow({
    ...(config.database.file ? { dbFile: config.database.file } : {}),
    env: {},
    environment: config.environment,
    allowDataReset: config.database.allowDataReset,
  });
  const db = boot.db;
  const repositories = createRepositories(db);
  const app = Fastify({ logger: options.logger ?? true });
  const singleActivePlanEnabled = config.scheduling.singleActivePlanEnabled;
  const literalWorktreesEnabled = config.scheduling.literalWorktreesEnabled;
  if (literalWorktreesEnabled && !singleActivePlanEnabled)
    throw new ForgeFlowError('LITERAL_WORKTREES_REQUIRE_SINGLE_ACTIVE_PLAN');
  const projectPlanQueue = singleActivePlanEnabled
    ? new ProjectPlanQueueRuntime(repositories)
    : undefined;
  const autonomousLifecycleAcceptanceProjection =
    createAutonomousLifecycleAcceptanceProjection(releaseProvenance, repositories);

  const kernels = {
    plan: new PlanKernel(repositories),
    graph: new WorkGraphKernel(repositories),
    execution: new ExecutionKernel(repositories),
    review: new ReviewKernel(repositories),
    recovery: new RecoveryKernel(repositories),
    delivery: new DeliveryKernel(),
  };
  const improvement = buildImprovementRuntime({
    db,
    repositories,
    planKernel: kernels.plan,
    ...(projectPlanQueue ? { projectPlanQueue } : {}),
    projects,
    config,
    releaseProvenance,
  });
  const automation = await buildExecutionAutomation(
    config.execution,
    repositories,
    options.fetchImpl ?? fetch,
    projects,
  );
  const runtimeAdmission = new RuntimeAdmissionReconciler(automation, app.log);
  await initializeProjectScheduling({
    repositories,
    ...(projectPlanQueue ? { projectPlanQueue } : {}),
    ...(automation ? { automation } : {}),
  });
  const requireAutomation = requireExecutionRuntime(automation);
  const supervisorActions = buildSupervisorActions({ repositories, kernels, requireAutomation, runtimeAdmission });
  const supervisor = buildSupervisorRuntime({
    db,
    repositories,
    config: config.supervisor,
    ...(automation ? { automation } : {}),
    actions: supervisorActions,
    diagnosisEnabled: improvement.aiDiagnosisEnabled,
    hasDiagnosisDemand: () => improvement.runtime.hasDiagnosisDemand(),
    fetchImpl: options.fetchImpl ?? fetch,
  });
  registerApiErrorHandler(app);
  await registerOpenApi(app);

  const reconcilers = buildReconcilerAssembly({
    config,
    repositories,
    ...(automation ? { automation } : {}),
    runtimeAdmission,
    ...(projectPlanQueue ? { projectPlanQueue } : {}),
    supervisor,
    improvement,
    hostCacheStatus: () => readHostCacheMaintenance(config.release.hostCacheStateFile),
    logger: app.log,
  });
  improvement.configureDiagnosis({
    reasoningResourceSelector: supervisor.reasoningResourceSelector,
    resourceState: automation?.resourceState,
    fetchImpl: options.fetchImpl ?? fetch,
    reconcileDirectAdmission: () => reconcilers.supervisor.reconcileDirectAdmission(),
  });

  const applications = buildApplicationAssembly({
    db,
    dbFile: boot.dbFile,
    repositories,
    projects,
    kernels,
    ...(projectPlanQueue ? { projectPlanQueue } : {}),
    ...(automation ? { automation } : {}),
    supervisor,
    supervisorReconciler: reconcilers.supervisor,
    supervisorActions,
    improvement,
    runtimeAdmission: reconcilers.runtimeAdmission,
    storage: reconcilers.storage,
    config,
    releaseProvenance,
    autonomousLifecycleAcceptanceProjection,
    fetchImpl: options.fetchImpl ?? fetch,
  });
  await registerApiModules(app, [
    createSystemApiModule(applications.system),
    createProjectApiModule(projects),
    createResourceApiModule(applications.resource),
    createImprovementApiModule(applications.improvement),
    createPlanApiModule(applications.plan),
    createExecutionApiModule(applications.execution),
    createSupervisorApiModule(applications.supervisor),
  ]);

  reconcilers.lifecycle.start();

  app.addHook('onClose', async () => {
    await reconcilers.lifecycle.close();
    db.close();
  });

  const { host, port } = config.server;
  return {
    app,
    db,
    dbFile: boot.dbFile,
    host,
    port,
    repositories,
    projects,
    kernels,
    supervisor: {
      actions: supervisorActions,
      openHands: supervisor.openHands,
      scheduler: supervisor.scheduler,
      runtime: supervisor.runtime,
      directAdmission: supervisor.directAdmission,
      reconcileDirectAdmission: () => reconcilers.supervisor.reconcileDirectAdmission(),
      reconcileReadiness: () => reconcilers.supervisor.reconcileReadiness(),
    },
    improvements: improvement.runtime,
    ...(automation ? { automation } : {}),
    ...(projectPlanQueue ? { projectPlanQueue } : {}),
    singleActivePlanEnabled,
    literalWorktreesEnabled,
  };
}
