import type { ForgeFlowRepositories } from '../../core/persistence/repositories.js';
import type { RuntimeAdmissionRecord } from '../../core/domain/resourceRouting.js';
import { ForgeFlowError } from '../../core/domain/errors.js';
import {
  AUTONOMOUS_ACCEPTANCE_EVENT,
  decodeAutonomousLifecycleAttestation,
  releaseAcceptanceAggregateId,
  validateAutonomousLifecycleAcceptance,
} from '../../core/orchestration/releaseAcceptance.js';
import { runtimeAdmissionPhase } from '../../core/orchestration/runtimeAdmission.js';

export interface HealthyReleaseProjection {
  status: 'HEALTHY';
  sourceSha: string;
  artifactSha256: string;
  [key: string]: unknown;
}

export type ReleaseProjection = HealthyReleaseProjection | { status: string; [key: string]: unknown };

export interface ReleaseAcceptanceInput {
  planId: string;
  sourceSha: string;
  artifactSha256: string;
  canonicalHead: string;
  externalChecks: string[];
}

export interface AdmissionProjectionItem {
  resourceId: string;
  bindingId: string;
  modelFamily: string;
  routeModel: string;
  protocol: string;
  ready: boolean;
  checkedAt: string;
  errorCode?: string;
}

export interface ExecutionSystemRuntime {
  resourceSelectorEnabled: boolean;
  resources: { listResources(): readonly unknown[] };
  runtimeAdmissionEnabled: boolean;
  runtimeAdmissionHasDemand(): boolean;
  runtimeAdmission: {
    summary(): Record<string, unknown>;
    list(): RuntimeAdmissionRecord[];
  };
  compatibilityImplementationRoutes: string[];
  compatibilityReviewRoutes: string[];
  implementationRoutes: string[];
  reviewRoutes: string[];
  automationProjectKeys: string[];
  literalWorktreeProjectKeys: string[];
  requireDelivery: boolean;
}

export interface SystemApplicationDependencies {
  dbFile: string;
  repositories: ForgeFlowRepositories;
  releaseProvenance(): ReleaseProjection;
  autonomousLifecycleAcceptanceProjection(): unknown;
  workspaceStorage(): unknown;
  hostCacheMaintenance(): unknown;
  reconcileWorkspaceStorage(): Promise<unknown>;
  singleActivePlanEnabled: boolean;
  literalWorktreesEnabled: boolean;
  projectPlanQueueEnabled: boolean;
  supervisorRuntimeEnabled: boolean;
  supervisorResourceSelectorEnabled: boolean;
  supervisorDirectAdmissionEnabled: boolean;
  supervisorDirectAdmissionHasDemand(): boolean;
  supervisorDirectAdmission: {
    summary(): Record<string, unknown>;
    list(): AdmissionProjectionItem[];
  };
  supervisorMaxResourceAttempts: number;
  improvementStatus(): unknown;
  executionRuntime?: ExecutionSystemRuntime;
  autonomousPollingEnabled: boolean;
}

function projectSupervisorAdmission(item: AdmissionProjectionItem) {
  return {
    resourceId: item.resourceId,
    bindingId: item.bindingId,
    modelFamily: item.modelFamily,
    routeModel: item.routeModel,
    protocol: item.protocol,
    ready: item.ready,
    checkedAt: item.checkedAt,
    errorCode: item.errorCode ?? null,
  };
}

function projectRuntimeAdmission(item: RuntimeAdmissionRecord) {
  return {
    phase: runtimeAdmissionPhase(item) ?? null,
    agentBackend: item.agentBackend,
    transport: item.transport,
    resourceId: item.resourceId,
    bindingId: item.bindingId,
    modelFamily: item.modelFamily,
    routeModel: item.routeModel,
    ready: item.ready,
    checkedAt: item.checkedAt,
    errorCode: item.errorCode ?? null,
  };
}

export class SystemApplication {
  constructor(private readonly dependencies: SystemApplicationDependencies) {}

  health() {
    const d = this.dependencies;
    const automation = d.executionRuntime;
    return {
      status: 'ok',
      service: 'forgeflow-control-plane',
      apiVersion: 1,
      mode: 'autonomous-engineering',
      database: d.dbFile,
      releaseProvenance: d.releaseProvenance(),
      autonomousLifecycleAcceptance: d.autonomousLifecycleAcceptanceProjection(),
      workspaceStorage: d.workspaceStorage(),
      hostCacheMaintenance: d.hostCacheMaintenance(),
      planScheduling: {
        singleActivePlanEnabled: d.singleActivePlanEnabled,
        literalWorktreesEnabled: d.literalWorktreesEnabled,
        leases: d.projectPlanQueueEnabled
          ? d.repositories.projectPlans.listLeases().map((lease) => ({
              ...lease,
              queuedPlans: d.repositories.projectPlans.listQueue(lease.projectKey).length,
            }))
          : [],
      },
      supervisorRuntime: {
        enabled: d.supervisorRuntimeEnabled,
        resourceSelectorEnabled: d.supervisorResourceSelectorEnabled,
        readinessAuthority: d.supervisorRuntimeEnabled
          ? 'DIRECT_PROTOCOL_ADMISSION_AND_FEEDBACK'
          : 'DISABLED',
        resourceWakeMode: 'EVENT_DRIVEN_WITH_15M_FALLBACK',
        directAdmission: {
          enabled: d.supervisorDirectAdmissionEnabled,
          demandDriven: true,
          hasDemand: d.supervisorDirectAdmissionHasDemand(),
          ...d.supervisorDirectAdmission.summary(),
          durableCache: this.durableSupervisorAdmissionSummary(),
        },
        maxResourceAttempts: d.supervisorMaxResourceAttempts,
      },
      improvementRuntime: d.improvementStatus(),
      executionRuntime: automation
        ? {
            enabled: true,
            autonomousPolling: d.autonomousPollingEnabled,
            resourceSelectorEnabled: automation.resourceSelectorEnabled,
            resourceCount: automation.resources.listResources().length,
            runtimeAdmission: {
              enabled: automation.runtimeAdmissionEnabled,
              demandDriven: true,
              hasDemand: automation.runtimeAdmissionHasDemand(),
              ...automation.runtimeAdmission.summary(),
              durableCache: this.durableRuntimeAdmissionSummary(),
            },
            routingAuthority: automation.resourceSelectorEnabled
              ? 'RESOURCE_SELECTOR'
              : 'LEGACY_ROUTE_LIST',
            compatibilityImplementationRoutes: automation.compatibilityImplementationRoutes,
            compatibilityReviewRoutes: automation.compatibilityReviewRoutes,
            implementationRoutes: automation.implementationRoutes,
            reviewRoutes: automation.reviewRoutes,
            automationProjectKeys: automation.automationProjectKeys,
            literalWorktreeProjectKeys: automation.literalWorktreeProjectKeys,
            requireDelivery: automation.requireDelivery,
          }
        : {
            enabled: false,
            autonomousPolling: false,
            resourceSelectorEnabled: false,
            resourceCount: 0,
            runtimeAdmission: {
              enabled: false,
              demandDriven: true,
              hasDemand: false,
              checked: 0,
              ready: 0,
              unready: 0,
              implementationReady: 0,
              reviewReady: 0,
              durableCache: { checked: 0, ready: 0, unready: 0 },
            },
            routingAuthority: 'LEGACY_ROUTE_LIST',
            compatibilityImplementationRoutes: [],
            compatibilityReviewRoutes: [],
            implementationRoutes: [],
            reviewRoutes: [],
            automationProjectKeys: [],
            literalWorktreeProjectKeys: [],
            requireDelivery: false,
          },
    };
  }

  releaseAcceptance() {
    return this.dependencies.autonomousLifecycleAcceptanceProjection();
  }

  attestReleaseAcceptance(input: ReleaseAcceptanceInput) {
    const repositories = this.dependencies.repositories;
    const plan = repositories.plans.getPlan(input.planId);
    const workItems = repositories.plans.listWorkItems(input.planId);
    const executions = repositories.executions.listByPlan(input.planId);
    const reviews = repositories.reviews.listByPlan(input.planId);
    const sessions = repositories.sessions.listByPlan(input.planId);
    const worktrees = repositories.planWorktrees.listByPlan(input.planId);
    const activationFailureCount = repositories.events
      .listRecentByAggregate(input.planId, 5_000)
      .filter((event) => event.type === 'PLAN_ACTIVATION_FAILED').length;
    const release = this.dependencies.releaseProvenance();
    const attestation = validateAutonomousLifecycleAcceptance({
      release:
        release.status === 'HEALTHY' &&
        typeof release.sourceSha === 'string' &&
        typeof release.artifactSha256 === 'string'
          ? {
              status: 'HEALTHY',
              sourceSha: release.sourceSha,
              artifactSha256: release.artifactSha256,
            }
          : { status: release.status },
      expectedRelease: { sourceSha: input.sourceSha, artifactSha256: input.artifactSha256 },
      canonicalHead: input.canonicalHead,
      externalChecks: input.externalChecks,
      plan: {
        planId: plan.planId,
        projectKey: plan.projectKey,
        baseRevision: plan.baseRevision,
        currentRevision: plan.currentRevision,
        status: plan.status,
      },
      workItems: workItems.map((item) => ({
        workItemId: item.workItemId,
        itemKey: item.itemKey,
        status: item.status,
        ...(item.wave ? { wave: item.wave } : {}),
        ...(item.integrationBaseRevision
          ? { integrationBaseRevision: item.integrationBaseRevision }
          : {}),
        ...(item.exactAcceptedRevision
          ? { exactAcceptedRevision: item.exactAcceptedRevision }
          : {}),
      })),
      executions: executions.map((execution) => ({
        executionId: execution.identity.executionId,
        ...(execution.identity.workItemId ? { workItemId: execution.identity.workItemId } : {}),
        phase: execution.identity.phase,
        status: execution.status,
        ...(execution.identity.sourceRevision
          ? { sourceRevision: execution.identity.sourceRevision }
          : {}),
        ...(execution.resultRevision ? { resultRevision: execution.resultRevision } : {}),
        createdAt: execution.createdAt,
      })),
      reviews: reviews.map((review) => ({
        reviewId: review.reviewId,
        workItemId: review.workItemId,
        implementationExecutionId: review.implementationExecutionId,
        ...(review.reviewerExecutionId ? { reviewerExecutionId: review.reviewerExecutionId } : {}),
        ...(review.reviewedSha ? { reviewedSha: review.reviewedSha } : {}),
        status: review.status,
        ...(review.verdict ? { verdict: review.verdict } : {}),
      })),
      providerSessions: sessions
        .filter((session) => Boolean(session.providerSessionId))
        .map((session) => ({
          executionId: session.executionId,
          providerSessionId: session.providerSessionId!,
          cleanupProven: Boolean(
            repositories.evidence.find(session.executionId, 'RECOVERY', 'provider-session-cleanup') ||
              repositories.evidence.find(
                session.executionId,
                'RECOVERY',
                'operator-provider-cancellation-cleanup',
              ),
          ),
        })),
      worktrees: worktrees.map((worktree) => ({ state: worktree.state })),
      lease: repositories.projectPlans.getLease(plan.projectKey),
      activationFailureCount,
    });

    const aggregateId = releaseAcceptanceAggregateId(attestation.sourceSha);
    const prior = repositories.events
      .listRecentByAggregate(aggregateId, 100)
      .filter((event) => event.type === AUTONOMOUS_ACCEPTANCE_EVENT)
      .find((event) => {
        try {
          return decodeAutonomousLifecycleAttestation(event.payload).planId === attestation.planId;
        } catch {
          return false;
        }
      });
    if (prior) {
      const existing = decodeAutonomousLifecycleAttestation(prior.payload);
      if (JSON.stringify(existing) !== JSON.stringify(attestation))
        throw new ForgeFlowError('RELEASE_ACCEPTANCE_ATTESTATION_CONFLICT');
      return { created: false, status: 'ATTESTED' as const, attestation: existing, attestedAt: prior.occurredAt };
    }

    const event = repositories.events.appendNew({
      aggregateId,
      aggregateType: 'MAINTENANCE',
      type: AUTONOMOUS_ACCEPTANCE_EVENT,
      payload: attestation,
      occurredAt: new Date().toISOString(),
      correlationId: plan.planId,
    });
    return { created: true, status: 'ATTESTED' as const, attestation, attestedAt: event.occurredAt };
  }

  storage() {
    return {
      storage: this.dependencies.workspaceStorage(),
      hostCacheMaintenance: this.dependencies.hostCacheMaintenance(),
    };
  }

  async reconcileStorage() {
    return {
      storage: this.dependencies.workspaceStorage(),
      hostCacheMaintenance: this.dependencies.hostCacheMaintenance(),
      cleanup: await this.dependencies.reconcileWorkspaceStorage(),
    };
  }

  supervisorAdmission() {
    const d = this.dependencies;
    const durableItems = d.repositories.supervisorDirectAdmissions.list();
    return {
      enabled: d.supervisorDirectAdmissionEnabled,
      demandDriven: true,
      hasDemand: d.repositories.supervisors.hasNonTerminal(),
      summary: d.supervisorDirectAdmission.summary(),
      items: d.supervisorDirectAdmission.list().map(projectSupervisorAdmission),
      durableCache: {
        summary: this.durableSupervisorAdmissionSummary(),
        items: durableItems.map(projectSupervisorAdmission),
      },
    };
  }

  runtimeAdmission() {
    const runtime = this.dependencies.executionRuntime;
    if (!runtime) throw new ForgeFlowError('EXECUTION_RUNTIME_DISABLED');
    const durableItems = this.dependencies.repositories.runtimeAdmissions.list();
    return {
      enabled: runtime.runtimeAdmissionEnabled,
      demandDriven: true,
      hasDemand: runtime.runtimeAdmissionHasDemand(),
      summary: runtime.runtimeAdmission.summary(),
      items: runtime.runtimeAdmission.list().map(projectRuntimeAdmission),
      durableCache: {
        summary: this.durableRuntimeAdmissionSummary(),
        items: durableItems.map(projectRuntimeAdmission),
      },
    };
  }

  private durableSupervisorAdmissionSummary() {
    const items = this.dependencies.repositories.supervisorDirectAdmissions.list();
    return {
      checked: items.length,
      ready: items.filter((item) => item.ready).length,
      unready: items.filter((item) => !item.ready).length,
    };
  }

  private durableRuntimeAdmissionSummary() {
    const items = this.dependencies.repositories.runtimeAdmissions.list();
    return {
      checked: items.length,
      ready: items.filter((item) => item.ready).length,
      unready: items.filter((item) => !item.ready).length,
    };
  }
}
