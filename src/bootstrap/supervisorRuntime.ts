import type { DatabaseSync } from 'node:sqlite';

import { HttpOpenHandsSupervisorClient, OpenHandsSupervisorAdapter } from '../core/adapters/openhands.js';
import { SupervisorDirectAdmissionProbe } from '../core/adapters/supervisorDirectAdmission.js';
import { ForgeFlowError } from '../core/domain/errors.js';
import { DEFAULT_AFFINITY_POLICY } from '../core/domain/resourceRouting.js';
import { ResourceSelector, selectExecutableProfile, type ResourceSelectionCandidate } from '../core/orchestration/resourceSelector.js';
import type { ForgeFlowRepositories } from '../core/persistence/repositories.js';
import {
  SupervisorDirectAdmissionRegistry,
  createSupervisorDirectAdmissionStatus,
  supervisorDirectAdmissionKey,
} from '../core/supervisor/admission.js';
import type { SupervisorActionExecutor } from '../core/supervisor/executor.js';
import { ResourceSelectedSupervisorDecisionClient } from '../core/supervisor/resourceClient.js';
import { SupervisorRuntime } from '../core/supervisor/runtime.js';
import { SupervisorWakeScheduler } from '../core/supervisor/scheduler.js';
import type { ForgeFlowBootstrapConfig } from './config.js';
import type { ExecutionAutomationRuntime } from './executionRuntime.js';

export interface SupervisorRuntimeAssembly {
  enabled: boolean;
  maxResourceAttempts: number;
  actions: SupervisorActionExecutor;
  openHands: OpenHandsSupervisorAdapter;
  scheduler: SupervisorWakeScheduler;
  runtime: SupervisorRuntime;
  directAdmission: SupervisorDirectAdmissionRegistry;
  directAdmissionEnabled: boolean;
  admissionHasDemand(): boolean;
  resourceSelectorEnabled: boolean;
  reasoningResourceSelector?: ResourceSelector;
  reconcileDirectAdmission(): Promise<void>;
  reconcileReadiness(): Promise<{ becameAvailable: string[]; scheduledWakes: number }>;
}

export interface BuildSupervisorRuntimeInput {
  db: DatabaseSync;
  repositories: ForgeFlowRepositories;
  config: ForgeFlowBootstrapConfig['supervisor'];
  automation?: ExecutionAutomationRuntime;
  actions: SupervisorActionExecutor;
  diagnosisEnabled: boolean;
  hasDiagnosisDemand(): boolean;
  fetchImpl: typeof fetch;
}

export function buildSupervisorRuntime(input: BuildSupervisorRuntimeInput): SupervisorRuntimeAssembly {
  const { db, repositories, config, automation, actions, fetchImpl } = input;
  const enabled = config.enabled;
  const maxResourceAttempts = config.maxResourceAttempts;
  if (enabled && config.hasRetiredStaticRoute)
    throw new ForgeFlowError('SUPERVISOR_STATIC_ROUTE_UNSUPPORTED');
  if (enabled && !automation?.resourceSelectorEnabled)
    throw new ForgeFlowError('SUPERVISOR_RESOURCE_SELECTOR_REQUIRED');

  const openHands = new OpenHandsSupervisorAdapter(
    config.openHandsUrl
      ? new HttpOpenHandsSupervisorClient(config.openHandsUrl, config.openHandsToken)
      : undefined,
  );
  const scheduler = new SupervisorWakeScheduler(repositories.supervisors, db);
  const directAdmission = new SupervisorDirectAdmissionRegistry();
  const directAdmissionEnabled =
    (enabled || input.diagnosisEnabled) && Boolean(automation?.resourceSelectorEnabled);
  if (directAdmissionEnabled)
    directAdmission.restore(repositories.supervisorDirectAdmissions.list());

  const directAdmissionReadyTtlMs = config.admissionReadyTtlMs;
  const directAdmissionFailureTtlMs = config.admissionFailureTtlMs;
  const directAdmissionProbe = directAdmissionEnabled
    ? new SupervisorDirectAdmissionProbe({
        baseUrl: config.directAdmission.baseUrl,
        bearerToken: config.directAdmission.apiKey,
        fetchImpl,
        timeoutMs: config.directAdmission.timeoutMs,
      })
    : undefined;

  const admissionCandidates = (): ResourceSelectionCandidate[] => {
    if (!automation?.resourceSelectorEnabled) return [];
    const values = new Map<string, ResourceSelectionCandidate>();
    const priorAttempts: Array<{ resourceId: string; bindingId?: string; modelFamily?: string }> = [];
    for (let index = 0; index < 100; index += 1) {
      const selected = selectExecutableProfile(automation.resources, {
        phase: 'SUPERVISE',
        includeProviderNativeProfiles: false,
        policy: {
          allowProviderNative: false,
          allowedTransports: ['LITELLM_MANAGED'],
          isAllowed: (candidate) => Boolean(candidate.profile.routeModel),
        },
        priorAttempts,
      });
      if (selected.status !== 'SELECTED') break;
      values.set(supervisorDirectAdmissionKey(selected.candidate), selected.candidate);
      priorAttempts.push({
        resourceId: selected.profile.resourceId,
        ...(selected.profile.bindingId ? { bindingId: selected.profile.bindingId } : {}),
        modelFamily: selected.profile.modelFamily,
      });
    }
    return [...values.values()];
  };

  const admissionHasDemand = (): boolean =>
    repositories.supervisors.hasNonTerminal() || input.hasDiagnosisDemand();
  let directAdmissionCycle: Promise<void> | undefined;
  const reconcileDirectAdmission = async (): Promise<void> => {
    if (!directAdmissionEnabled || !directAdmissionProbe) return;
    if (!admissionHasDemand()) return;
    if (directAdmissionCycle) return await directAdmissionCycle;
    directAdmissionCycle = (async () => {
      const candidates = admissionCandidates();
      const admissionKeys = candidates.map(supervisorDirectAdmissionKey);
      repositories.supervisorDirectAdmissions.retain(admissionKeys);
      directAdmission.retain(candidates);
      const now = Date.now();
      for (const candidate of candidates) {
        if (
          !directAdmission.isStale(
            candidate,
            now,
            directAdmissionReadyTtlMs,
            directAdmissionFailureTtlMs,
          )
        )
          continue;
        const result = await directAdmissionProbe.probe(candidate);
        const status = createSupervisorDirectAdmissionStatus(candidate, result);
        const persisted = repositories.supervisorDirectAdmissions.record(status);
        if (!persisted.value || persisted.status === 'rejected')
          throw new ForgeFlowError(persisted.reason ?? 'SUPERVISOR_ADMISSION_PERSIST_FAILED');
        directAdmission.restore([persisted.value]);
      }
    })();
    try {
      await directAdmissionCycle;
    } finally {
      directAdmissionCycle = undefined;
    }
  };

  const reasoningResourceSelector = directAdmissionEnabled
    ? new ResourceSelector(automation!.resources, DEFAULT_AFFINITY_POLICY, directAdmission)
    : undefined;
  const supervisorResourceSelector = enabled ? reasoningResourceSelector : undefined;
  const modelClient = enabled
    ? new ResourceSelectedSupervisorDecisionClient(
        supervisorResourceSelector!,
        config.reasoning.baseUrl,
        config.reasoning.apiKey,
        repositories.events,
        automation!.resourceState,
        fetchImpl,
        config.reasoning.timeoutMs,
        maxResourceAttempts,
      )
    : undefined;
  const runtime = new SupervisorRuntime(
    db,
    repositories.supervisors,
    scheduler,
    openHands,
    actions,
    modelClient,
  );

  const availableResourceIds = (): string[] =>
    automation
      ? automation.resources
          .listResources()
          .filter(
            (resource) =>
              selectExecutableProfile(
                [resource],
                {
                  phase: 'SUPERVISE',
                  includeProviderNativeProfiles: false,
                  policy: {
                    allowProviderNative: false,
                    allowedTransports: ['LITELLM_MANAGED'],
                    isAllowed: (candidate) => Boolean(candidate.profile.routeModel),
                  },
                },
                DEFAULT_AFFINITY_POLICY,
                directAdmission,
              ).status === 'SELECTED',
          )
          .map((resource) => resource.resourceId)
          .sort()
      : [];
  let lastAvailableResourceIds = new Set<string>();
  const reconcileResourceAvailability = () => {
    const current = new Set(availableResourceIds());
    const becameAvailable = [...current].filter((resourceId) => !lastAvailableResourceIds.has(resourceId));
    lastAvailableResourceIds = current;
    if (becameAvailable.length === 0) return { becameAvailable, scheduledWakes: 0 };
    if (repositories.supervisors.listByStatus('WAITING_FOR_RESOURCE').length === 0)
      return { becameAvailable, scheduledWakes: 0 };
    repositories.events.appendNew({
      aggregateId: 'supervisor-resource-availability',
      aggregateType: 'RESOURCE',
      type: 'SUPERVISOR_RESOURCE_AVAILABILITY_CHANGED',
      payload: { becameAvailable: [...becameAvailable].sort() },
      occurredAt: new Date().toISOString(),
      correlationId: 'supervisor-resource-availability',
    });
    const wakes = scheduler.scheduleWaitingForResource();
    return { becameAvailable, scheduledWakes: wakes.length };
  };
  const reconcileReadiness = async () => {
    await reconcileDirectAdmission();
    return reconcileResourceAvailability();
  };

  return {
    enabled,
    maxResourceAttempts,
    actions,
    openHands,
    scheduler,
    runtime,
    directAdmission,
    directAdmissionEnabled,
    admissionHasDemand,
    resourceSelectorEnabled: Boolean(modelClient),
    ...(reasoningResourceSelector ? { reasoningResourceSelector } : {}),
    reconcileDirectAdmission,
    reconcileReadiness,
  };
}
