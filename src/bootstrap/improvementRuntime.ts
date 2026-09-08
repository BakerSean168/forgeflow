import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { ResourceSelectedImprovementDiagnosisClient } from '../core/adapters/improvementDiagnosis.js';
import { MaintenanceCandidateRegistry } from '../core/adapters/maintenance.js';
import { ResourceStateService } from '../core/adapters/resourceDirectory.js';
import { ExactShaSelfChangeCanary } from '../core/adapters/selfChangeCanary.js';
import { FileSelfChangePromotionQueue } from '../core/adapters/selfChangePromotion.js';
import { ForgeFlowError } from '../core/domain/errors.js';
import type { PlanKernel } from '../core/kernel/planKernel.js';
import {
  MaintenanceImprovementRuntime,
  type ImprovementReleaseProvenance,
} from '../core/orchestration/maintenanceRuntime.js';
import type { ProjectPlanQueueRuntime } from '../core/orchestration/projectPlanQueueRuntime.js';
import type { ResourceSelector } from '../core/orchestration/resourceSelector.js';
import type { ForgeFlowRepositories } from '../core/persistence/repositories.js';
import type { ProjectRegistry } from '../platform/projects/index.js';
import type { ForgeFlowBootstrapConfig } from './config.js';

export interface ImprovementRuntimeAssembly {
  enabled: boolean;
  aiDiagnosisEnabled: boolean;
  registry: MaintenanceCandidateRegistry;
  runtime: MaintenanceImprovementRuntime;
  configureDiagnosis(input: {
    reasoningResourceSelector?: ResourceSelector;
    resourceState?: ResourceStateService;
    fetchImpl: typeof fetch;
    reconcileDirectAdmission(): Promise<void>;
  }): void;
}

export interface BuildImprovementRuntimeInput {
  db: DatabaseSync;
  repositories: ForgeFlowRepositories;
  planKernel: PlanKernel;
  projectPlanQueue?: ProjectPlanQueueRuntime;
  projects: ProjectRegistry;
  config: ForgeFlowBootstrapConfig;
  releaseProvenance(): ImprovementReleaseProvenance;
}

export function buildImprovementRuntime(
  input: BuildImprovementRuntimeInput,
): ImprovementRuntimeAssembly {
  const { db, repositories, planKernel, projectPlanQueue, projects, config, releaseProvenance } = input;
  const settings = config.improvement;
  const allowedProjectKeys = projects.improvementProjectKeys();

  if (settings.aiDiagnosisEnabled && allowedProjectKeys.length === 0)
    throw new ForgeFlowError('IMPROVEMENT_AI_DIAGNOSIS_PROJECTS_REQUIRED');
  if (settings.aiDiagnosisEnabled && !config.execution.enabled)
    throw new ForgeFlowError('IMPROVEMENT_AI_DIAGNOSIS_EXECUTION_RUNTIME_REQUIRED');
  if (settings.aiDiagnosisEnabled && !config.execution.resourceSelectorEnabled)
    throw new ForgeFlowError('IMPROVEMENT_AI_DIAGNOSIS_RESOURCE_SELECTOR_REQUIRED');
  if (settings.selfPromotionEnabled && !settings.selfChangeEnabled)
    throw new ForgeFlowError('IMPROVEMENT_SELF_PROMOTION_REQUIRES_SELF_CHANGE');
  if (settings.selfAutoPromotionEnabled && !settings.selfPromotionEnabled)
    throw new ForgeFlowError('IMPROVEMENT_SELF_AUTO_PROMOTION_REQUIRES_PROMOTION');
  if (
    settings.selfPromotionEnabled &&
    config.environment === 'production' &&
    path.resolve(settings.selfPromotionRequestFile) !== '/var/lib/forgeflow/self-promotion-request.json'
  )
    throw new ForgeFlowError('IMPROVEMENT_SELF_PROMOTION_REQUEST_PATH_UNSUPPORTED');

  const registry = new MaintenanceCandidateRegistry(db);
  const selfCanary = settings.selfChangeEnabled
    ? new ExactShaSelfChangeCanary({
        repositoryPath: settings.selfRepositoryPath,
        worktreeRoot: settings.selfCanaryRoot,
        commandTimeoutMs: settings.selfCanaryTimeoutMs,
      })
    : undefined;
  const selfPromotionQueue = settings.selfPromotionEnabled
    ? new FileSelfChangePromotionQueue(settings.selfPromotionRequestFile)
    : undefined;
  const runtime = new MaintenanceImprovementRuntime(
    db,
    registry,
    repositories,
    planKernel,
    projectPlanQueue,
    {
      discoveryEnabled: settings.discoveryEnabled,
      adoptionEnabled: settings.adoptionEnabled,
      autoAdoptLowRisk: settings.autoAdoptLowRisk,
      allowedProjectKeys,
      selfChangeEnabled: settings.selfChangeEnabled,
      selfPromotionEnabled: settings.selfPromotionEnabled,
      selfAutoPromotionEnabled: settings.selfAutoPromotionEnabled,
      aiDiagnosisEnabled: settings.aiDiagnosisEnabled,
      aiDiagnosisMaxPerCycle: settings.aiDiagnosisMaxPerCycle,
      selfProjectKey: settings.selfProjectKey,
      selfRepositoryPath: settings.selfRepositoryPath,
    },
    selfCanary,
    selfPromotionQueue,
    releaseProvenance,
  );
  const enabled =
    settings.discoveryEnabled ||
    settings.adoptionEnabled ||
    settings.aiDiagnosisEnabled ||
    settings.selfPromotionEnabled;

  const configureDiagnosis: ImprovementRuntimeAssembly['configureDiagnosis'] = (diagnosis) => {
    if (!settings.aiDiagnosisEnabled) return;
    if (!diagnosis.reasoningResourceSelector || !diagnosis.resourceState)
      throw new ForgeFlowError('IMPROVEMENT_AI_DIAGNOSIS_RESOURCE_SELECTOR_REQUIRED');
    runtime.configureDiagnosisClient(
      new ResourceSelectedImprovementDiagnosisClient(
        diagnosis.reasoningResourceSelector,
        settings.diagnosis.baseUrl,
        settings.diagnosis.apiKey,
        repositories.events,
        diagnosis.resourceState,
        diagnosis.fetchImpl,
        settings.diagnosis.timeoutMs,
        settings.diagnosis.maxResourceAttempts,
        diagnosis.reconcileDirectAdmission,
      ),
    );
  };

  return {
    enabled,
    aiDiagnosisEnabled: settings.aiDiagnosisEnabled,
    registry,
    runtime,
    configureDiagnosis,
  };
}
