import type { ProjectPlanQueueRuntime } from '../core/orchestration/projectPlanQueueRuntime.js';
import type { ForgeFlowBootstrapConfig } from './config.js';
import type { ExecutionAutomationRuntime } from './executionRuntime.js';
import type { ImprovementRuntimeAssembly } from './improvementRuntime.js';
import type { SupervisorRuntimeAssembly } from './supervisorRuntime.js';

export interface RuntimeLifecycleLogger {
  info(data: unknown, message: string): void;
  error(data: unknown, message: string): void;
  warn(data: unknown, message: string): void;
}

export interface RuntimeLifecycle {
  close(): Promise<void>;
}

function errorProjection(error: unknown) {
  return { error: error instanceof Error ? error.message : String(error) };
}

export function startRuntimeLifecycle(input: {
  config: ForgeFlowBootstrapConfig;
  automation?: ExecutionAutomationRuntime;
  projectPlanQueue?: ProjectPlanQueueRuntime;
  supervisor: SupervisorRuntimeAssembly;
  improvement: ImprovementRuntimeAssembly;
  runWorkspaceStorageMaintenance(): Promise<unknown>;
  logger: RuntimeLifecycleLogger;
}): RuntimeLifecycle {
  const { config, automation, projectPlanQueue, supervisor, improvement, logger } = input;

  const supervisorInterval = supervisor.enabled
    ? setInterval(() => {
        void supervisor
          .reconcileReadiness()
          .then((resourceWake) => {
            if (resourceWake.scheduledWakes > 0)
              logger.info(resourceWake, 'Supervisor admission woke waiting supervisors');
            return supervisor.runtime.runOnce();
          })
          .then((results) => {
            for (const result of results)
              if (result.status !== 'SKIPPED')
                logger.info(
                  {
                    supervisorId: result.supervisorId,
                    status: result.status,
                    code: result.code,
                  },
                  'supervisor runtime cycle',
                );
          })
          .catch((error) => logger.error(errorProjection(error), 'supervisor runtime cycle failed'));
      }, config.supervisor.pollMs)
    : undefined;

  if (supervisor.directAdmissionEnabled) {
    setImmediate(() => {
      void supervisor
        .reconcileReadiness()
        .then((resourceWake) => {
          if (resourceWake.scheduledWakes > 0)
            logger.info(resourceWake, 'Supervisor admission warmup woke waiting supervisors');
        })
        .catch((error) => logger.error(errorProjection(error), 'Supervisor direct admission warmup failed'));
    });
  }

  if (automation?.runtimeAdmissionEnabled) {
    setImmediate(() => {
      void automation
        .reconcileRuntimeAdmission()
        .catch((error) => logger.error(errorProjection(error), 'runtime admission warmup failed'));
    });
  }

  let resourceCycleRunning = false;
  const resourceInterval = automation?.resourceSelectorEnabled
    ? setInterval(() => {
        if (resourceCycleRunning) return;
        resourceCycleRunning = true;
        void automation.liteLlmResources
          .refresh()
          .then(() => automation.resourceLifecycle.reconcileOnce())
          .then(() => supervisor.reconcileReadiness())
          .then((resourceWake) => {
            if (resourceWake.scheduledWakes > 0)
              logger.info(resourceWake, 'resource availability woke waiting supervisors');
          })
          .then(() => automation.reconcileRuntimeAdmission())
          .catch((error) => logger.error(errorProjection(error), 'resource directory cycle failed'))
          .finally(() => {
            resourceCycleRunning = false;
          });
      }, config.automation.resourceRefreshMs)
    : undefined;

  let improvementCycleRunning = false;
  const runImprovementCycle = () => {
    if (improvementCycleRunning) return;
    improvementCycleRunning = true;
    void improvement.runtime
      .runAutonomousCycle()
      .then((result) => {
        if (
          result.programs.length > 0 ||
          result.reconciledCandidateIds.length > 0 ||
          result.diagnosis.diagnosedCandidateIds.length > 0 ||
          result.diagnosis.adoptedPlanIds.length > 0 ||
          result.diagnosis.errors.length > 0 ||
          result.selfPromotion.requestedCandidateIds.length > 0 ||
          result.selfPromotion.errors.length > 0
        )
          logger.info(
            {
              reconciledCandidates: result.reconciledCandidateIds.length,
              programs: result.programs.map((program) => ({
                programId: program.programId,
                projectKey: program.projectKey,
                discovered: program.discovered,
                created: program.created,
                adoptedPlans: program.adoptedPlanIds.length,
                errors: program.errors,
              })),
              diagnosis: result.diagnosis,
              selfPromotion: result.selfPromotion,
            },
            'improvement cycle',
          );
      })
      .catch((error) => logger.error(errorProjection(error), 'improvement cycle failed'))
      .finally(() => {
        improvementCycleRunning = false;
      });
  };
  if (improvement.enabled) setImmediate(runImprovementCycle);
  const improvementInterval = improvement.enabled
    ? setInterval(runImprovementCycle, config.improvement.cycleMs)
    : undefined;

  let automationCycleRunning = false;
  const automationInterval = automation && config.automation.enabled
    ? setInterval(() => {
        if (automationCycleRunning) return;
        automationCycleRunning = true;
        void input
          .runWorkspaceStorageMaintenance()
          .then(async () => {
            if (projectPlanQueue) await projectPlanQueue.reconcile();
            const results = await automation.plans.runOnce();
            // Admission refresh is deliberately detached from active execution heartbeats.
            void automation
              .reconcileRuntimeAdmission()
              .catch((error) => logger.error(errorProjection(error), 'runtime admission cycle failed'));
            return results;
          })
          .then((results) => {
            for (const result of results)
              if (result.status !== 'SKIPPED')
                logger.info(
                  {
                    planId: result.planId,
                    workItemId: result.workItemId,
                    executionId: result.executionId,
                    status: result.status,
                    code: result.code,
                  },
                  'plan automation cycle',
                );
          })
          .catch((error) => logger.error(errorProjection(error), 'plan automation cycle failed'))
          .finally(() => {
            automationCycleRunning = false;
          });
      }, config.automation.pollMs)
    : undefined;

  return {
    close: async () => {
      if (supervisorInterval) clearInterval(supervisorInterval);
      if (resourceInterval) clearInterval(resourceInterval);
      if (improvementInterval) clearInterval(improvementInterval);
      if (automationInterval) clearInterval(automationInterval);
      if (automation) {
        try {
          await automation.shutdownRuntimeAdmission();
        } catch (error) {
          logger.warn(errorProjection(error), 'runtime admission shutdown drain failed');
        }
      }
    },
  };
}
