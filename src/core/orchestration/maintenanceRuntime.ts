import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import {
  MaintenanceCandidateRegistry,
  type ImprovementCanaryAttestation,
  type ImprovementCandidate,
  type ImprovementSelfPromotionRequest,
  type MaintenanceProgram,
} from '../adapters/maintenance.js';
import type {
  SelfChangeCanaryPort,
} from '../adapters/selfChangeCanary.js';
import type {
  SelfChangePromotionQueuePort,
} from '../adapters/selfChangePromotion.js';
import type { PlanDeliveryConfig } from '../domain/delivery.js';
import { ForgeFlowError, failClosed } from '../domain/errors.js';
import type { Plan } from '../domain/plan.js';
import type { PlanKernel } from '../kernel/planKernel.js';
import type { ForgeFlowRepositories } from '../persistence/repositories.js';
import type { ProjectPlanQueueRuntime } from './projectPlanQueueRuntime.js';

const DEFAULT_FAILURE_PREFIXES = Object.freeze([
  'BUILD_',
  'CONTRACT_',
  'DELIVERY_',
  'HARNESS_',
  'INTEGRATION_',
  'LINT_',
  'REVIEW_',
  'SCHEMA_',
  'TEST_',
  'TYPECHECK_',
  'WORKSPACE_',
]);

interface FailureObservationRow {
  execution_id: string;
  phase: string;
  error_code: string;
  plan_id: string;
  repository_path: string;
  updated_at: string;
}

export interface DiscoveredImprovement {
  candidate: ImprovementCandidate;
  mutation: 'created' | 'existing';
  observedCount: number;
  errorCode: string;
  phase: string;
}

export interface ImprovementAdoptionInput {
  repositoryPath?: string;
  baseRevision?: string;
  priority?: number;
  acknowledgeHighRisk?: boolean;
  delivery?: PlanDeliveryConfig;
}

export interface ImprovementAdoptionResult {
  candidate: ImprovementCandidate;
  plan: Plan;
  scheduling?: ReturnType<ProjectPlanQueueRuntime['scheduleRootPlan']>;
}

export interface ImprovementRuntimeOptions {
  discoveryEnabled: boolean;
  adoptionEnabled: boolean;
  autoAdoptLowRisk?: boolean;
  allowedProjectKeys: readonly string[];
  selfChangeEnabled?: boolean;
  selfPromotionEnabled?: boolean;
  selfAutoPromotionEnabled?: boolean;
  selfProjectKey?: string;
  selfRepositoryPath?: string;
}

export type ImprovementReleaseProvenance =
  | { status: 'MISSING' | 'INVALID' | 'MISMATCH' }
  | {
      status: 'PENDING' | 'HEALTHY';
      version: 1;
      sourceSha: string;
      artifactSha256: string;
      releasedAt: string;
    };

export class MaintenanceImprovementRuntime {
  readonly allowedProjects: ReadonlySet<string>;
  private readonly selfPromotionWakeKeys = new Set<string>();

  constructor(
    readonly db: DatabaseSync,
    readonly registry: MaintenanceCandidateRegistry,
    readonly repositories: ForgeFlowRepositories,
    readonly plans: PlanKernel,
    readonly projectPlanQueue: ProjectPlanQueueRuntime | undefined,
    readonly options: ImprovementRuntimeOptions,
    readonly selfCanary?: SelfChangeCanaryPort,
    readonly selfPromotionQueue?: SelfChangePromotionQueuePort,
    readonly releaseProvenance?: () => ImprovementReleaseProvenance,
  ) {
    this.allowedProjects = new Set(options.allowedProjectKeys);
  }

  private requireProject(projectKey: string): void {
    if (!this.allowedProjects.has(projectKey))
      throw new ForgeFlowError('IMPROVEMENT_PROJECT_NOT_ALLOWED');
  }

  private requireDiscovery(projectKey: string): void {
    if (!this.options.discoveryEnabled) throw new ForgeFlowError('IMPROVEMENT_DISCOVERY_DISABLED');
    this.requireProject(projectKey);
  }

  private isSelfTarget(projectKey: string, repositoryPath: string): boolean {
    const selfProject = this.options.selfProjectKey ?? 'forgeflow';
    const selfRepository = this.options.selfRepositoryPath
      ? path.resolve(this.options.selfRepositoryPath)
      : undefined;
    return (
      projectKey === selfProject ||
      (selfRepository !== undefined && path.resolve(repositoryPath) === selfRepository)
    );
  }

  private requireAdoption(projectKey: string, repositoryPath: string): void {
    if (!this.options.adoptionEnabled) throw new ForgeFlowError('IMPROVEMENT_ADOPTION_DISABLED');
    this.requireProject(projectKey);
    if (this.isSelfTarget(projectKey, repositoryPath) && this.options.selfChangeEnabled !== true)
      throw new ForgeFlowError('IMPROVEMENT_SELF_CHANGE_DISABLED');
  }

  discover(programInput: MaintenanceProgram): DiscoveredImprovement[] {
    this.requireDiscovery(programInput.projectKey.trim());
    const program = this.registry.upsertProgram(programInput);
    failClosed(program.enabled, 'MAINTENANCE_PROGRAM_DISABLED');
    const threshold = program.failureThreshold ?? 3;
    const limit = program.recentExecutionLimit ?? 200;
    const prefixes =
      program.failureCodePrefixes && program.failureCodePrefixes.length > 0
        ? program.failureCodePrefixes
        : DEFAULT_FAILURE_PREFIXES;
    const rows = this.db
      .prepare(
        `SELECT executions.execution_id,executions.phase,executions.error_code,executions.plan_id,
                executions.updated_at,plans.repository_path
           FROM executions
           JOIN plans ON plans.plan_id=executions.plan_id
          WHERE plans.project_key=?
            AND executions.status IN ('FAILED','BLOCKED')
            AND executions.error_code IS NOT NULL
          ORDER BY executions.updated_at DESC,executions.execution_id DESC
          LIMIT ?`,
      )
      .all(program.projectKey, limit) as unknown as FailureObservationRow[];
    const groups = new Map<string, FailureObservationRow[]>();
    for (const row of rows) {
      const code = row.error_code.trim();
      if (!code || !prefixes.some((prefix) => code.startsWith(prefix))) continue;
      const key = row.phase + '\u0000' + code;
      const current = groups.get(key) ?? [];
      current.push(row);
      groups.set(key, current);
    }
    const results: DiscoveredImprovement[] = [];
    for (const [key, observations] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (observations.length < threshold) continue;
      const [phase, errorCode] = key.split('\u0000');
      if (!phase || !errorCode) continue;
      const evidence = [
        'failure-code:' + errorCode,
        'phase:' + phase,
        'threshold:' + String(threshold),
      ];
      const created = this.registry.create(program, {
        title: 'Repeated ' + phase + ' failure: ' + errorCode,
        evidence,
        risk: program.candidateRisk ?? 'LOW',
        fingerprintKey: 'recurring-failure:' + phase + ':' + errorCode,
      });
      results.push({
        candidate: created.candidate,
        mutation: created.status,
        observedCount: observations.length,
        errorCode,
        phase,
      });
    }
    return results;
  }

  private latestKnownRevision(projectKey: string, repositoryPath: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT current_revision
           FROM plans
          WHERE project_key=? AND repository_path=?
          ORDER BY updated_at DESC,plan_id DESC
          LIMIT 1`,
      )
      .get(projectKey, repositoryPath) as { current_revision: string } | undefined;
    return row?.current_revision;
  }

  private selfContext(candidateId: string): {
    candidate: ImprovementCandidate;
    program: MaintenanceProgram;
    plan: Plan;
  } {
    const candidate = this.registry.get(candidateId);
    if (!candidate.planId) throw new ForgeFlowError('IMPROVEMENT_SELF_PLAN_REQUIRED');
    const program = this.registry.getProgram(candidate.programId);
    const plan = this.repositories.plans.getPlan(candidate.planId);
    if (!this.isSelfTarget(program.projectKey, plan.repositoryPath))
      throw new ForgeFlowError('IMPROVEMENT_NOT_SELF_CHANGE');
    if (this.options.selfChangeEnabled !== true)
      throw new ForgeFlowError('IMPROVEMENT_SELF_CHANGE_DISABLED');
    if (plan.projectKey !== program.projectKey)
      throw new ForgeFlowError('IMPROVEMENT_PLAN_PROJECT_MISMATCH');
    return { candidate, program, plan };
  }

  async runSelfCanary(candidateId: string): Promise<ImprovementCanaryAttestation> {
    const { candidate, plan } = this.selfContext(candidateId);
    if (candidate.status !== 'ADOPTED') throw new ForgeFlowError('CANDIDATE_NOT_ADOPTED');
    if (plan.status !== 'SUCCEEDED') throw new ForgeFlowError('IMPROVEMENT_SELF_PLAN_NOT_SUCCEEDED');
    if (!this.selfCanary) throw new ForgeFlowError('IMPROVEMENT_SELF_CANARY_UNAVAILABLE');
    failClosed(/^[0-9a-f]{40}$/.test(plan.currentRevision), 'IMPROVEMENT_CANARY_REVISION_INVALID');
    const existing = this.registry.latestPassingCanary(candidateId, plan.currentRevision);
    if (existing) return existing;
    const result = await this.selfCanary.run({
      candidateId,
      planId: plan.planId,
      sourceRevision: plan.currentRevision,
    });
    failClosed(
      result.sourceRevision === plan.currentRevision,
      'IMPROVEMENT_CANARY_REVISION_MISMATCH',
    );
    const key = [
      'self-canary',
      candidateId,
      plan.planId,
      result.sourceRevision,
      result.artifactSha256,
      result.result,
      ...result.checks,
    ].join('|');
    return this.registry.recordCanary(candidateId, {
      idempotencyKey: key,
      planId: plan.planId,
      sourceRevision: result.sourceRevision,
      artifactSha256: result.artifactSha256,
      result: result.result,
      checks: result.checks,
      observedAt: result.observedAt,
    });
  }

  requestSelfPromotion(candidateId: string): ImprovementSelfPromotionRequest {
    if (this.options.selfPromotionEnabled !== true)
      throw new ForgeFlowError('IMPROVEMENT_SELF_PROMOTION_DISABLED');
    const { candidate, plan } = this.selfContext(candidateId);
    if (candidate.status !== 'ADOPTED') throw new ForgeFlowError('CANDIDATE_NOT_ADOPTED');
    if (plan.status !== 'SUCCEEDED') throw new ForgeFlowError('IMPROVEMENT_SELF_PLAN_NOT_SUCCEEDED');
    if (!this.selfPromotionQueue)
      throw new ForgeFlowError('IMPROVEMENT_SELF_PROMOTION_UNAVAILABLE');
    const canary = this.registry.latestPassingCanary(candidateId, plan.currentRevision);
    if (!canary) throw new ForgeFlowError('IMPROVEMENT_SELF_CANARY_REQUIRED');
    const request = this.registry.recordSelfPromotionRequest(candidateId, {
      planId: plan.planId,
      sourceRevision: plan.currentRevision,
      artifactSha256: canary.artifactSha256,
      canaryAttestationId: canary.attestationId,
    });
    this.selfPromotionQueue.request({
      version: 1,
      candidateId,
      planId: request.planId,
      sourceRevision: request.sourceRevision,
      artifactSha256: request.artifactSha256,
      canaryAttestationId: request.canaryAttestationId,
      requestedAt: request.requestedAt,
    });
    this.selfPromotionWakeKeys.add(candidateId + '|' + request.sourceRevision);
    return request;
  }

  selfChangeProjection(candidateId: string): {
    selfChange: boolean;
    selfPromotionEnabled: boolean;
    canaries: ImprovementCanaryAttestation[];
    promotionRequest: ImprovementSelfPromotionRequest | null;
    promotion: ReturnType<MaintenanceCandidateRegistry['latestSelfPromotion']> | null;
    releaseProvenance: ImprovementReleaseProvenance | null;
  } {
    const candidate = this.registry.get(candidateId);
    const program = this.registry.getProgram(candidate.programId);
    const plan = candidate.planId ? this.repositories.plans.getPlan(candidate.planId) : undefined;
    const selfChange = Boolean(plan && this.isSelfTarget(program.projectKey, plan.repositoryPath));
    return {
      selfChange,
      selfPromotionEnabled: this.options.selfPromotionEnabled === true,
      canaries: selfChange ? this.registry.listCanaryAttestations(candidateId) : [],
      promotionRequest: selfChange ? (this.registry.latestSelfPromotionRequest(candidateId) ?? null) : null,
      promotion: selfChange ? (this.registry.latestSelfPromotion(candidateId) ?? null) : null,
      releaseProvenance: selfChange && this.releaseProvenance ? this.releaseProvenance() : null,
    };
  }

  adopt(candidateId: string, input: ImprovementAdoptionInput = {}): ImprovementAdoptionResult {
    const candidate = this.registry.get(candidateId);
    if (candidate.status !== 'DISCOVERED' && candidate.status !== 'QUEUED' && candidate.status !== 'ADOPTED')
      throw new ForgeFlowError('CANDIDATE_NOT_ADOPTABLE');
    const program = this.registry.getProgram(candidate.programId);
    failClosed(program.enabled, 'MAINTENANCE_PROGRAM_DISABLED');
    const existingPlan = candidate.planId
      ? this.repositories.plans.getPlan(candidate.planId)
      : undefined;
    const lease = this.repositories.projectPlans.getLease(program.projectKey);
    const repositoryPath =
      existingPlan?.repositoryPath ||
      input.repositoryPath?.trim() ||
      program.repositoryPath?.trim() ||
      lease?.repositoryPath;
    if (!repositoryPath) throw new ForgeFlowError('IMPROVEMENT_REPOSITORY_REQUIRED');
    if (program.repositoryPath && path.resolve(program.repositoryPath) !== path.resolve(repositoryPath))
      throw new ForgeFlowError('IMPROVEMENT_REPOSITORY_MISMATCH');
    if (lease && path.resolve(lease.repositoryPath) !== path.resolve(repositoryPath))
      throw new ForgeFlowError('IMPROVEMENT_REPOSITORY_MISMATCH');
    this.requireAdoption(program.projectKey, repositoryPath);
    if (existingPlan) {
      if (existingPlan.projectKey !== program.projectKey)
        throw new ForgeFlowError('IMPROVEMENT_PLAN_PROJECT_MISMATCH');
      const scheduling = this.projectPlanQueue
        ? this.projectPlanQueue.scheduleRootPlan(existingPlan.planId, input.priority ?? 0)
        : undefined;
      return {
        candidate,
        plan: this.repositories.plans.getPlan(existingPlan.planId),
        ...(scheduling ? { scheduling } : {}),
      };
    }
    if (candidate.risk === 'HIGH' && input.acknowledgeHighRisk !== true)
      throw new ForgeFlowError('CANDIDATE_HIGH_RISK_ACK_REQUIRED');
    const baseRevision =
      input.baseRevision?.trim() ||
      lease?.committedRevision ||
      this.latestKnownRevision(program.projectKey, repositoryPath);
    if (!baseRevision) throw new ForgeFlowError('IMPROVEMENT_BASE_REVISION_REQUIRED');
    const objective = [
      'Resolve improvement candidate: ' + candidate.title + '.',
      'Evidence: ' + candidate.evidence.join('; ') + '.',
      'Establish the root cause, implement the smallest durable correction, and add regression coverage.',
      'Preserve unrelated behavior and do not weaken existing safety, review, test, or delivery gates.',
    ].join(' ');
    const planResult = this.plans.createPlan({
      idempotencyKey: 'improvement:' + candidate.candidateId,
      projectKey: program.projectKey,
      objective,
      repositoryPath,
      baseRevision,
      ...(input.delivery ? { delivery: input.delivery } : {}),
    });
    const plan = planResult.value;
    if (!plan) throw new ForgeFlowError('IMPROVEMENT_PLAN_CREATE_FAILED');
    this.plans.ensureReadyGraph(
      plan.planId,
      [
        {
          itemKey: 'improvement',
          title: candidate.title,
          objective,
          dependencies: [],
          acceptanceCriteria: [
            'root cause is addressed rather than masked',
            'regression coverage demonstrates the failure is fixed',
            'existing project verification remains passing',
            'independent exact-revision review accepts the resulting change',
          ],
          parallelSafe: false,
          writeScopes: [],
          conflictKeys: ['maintenance:' + candidate.fingerprint],
        },
      ],
      { activate: !this.projectPlanQueue },
    );
    const scheduling = this.projectPlanQueue
      ? this.projectPlanQueue.scheduleRootPlan(plan.planId, input.priority ?? 0)
      : undefined;
    const attached = candidate.planId
      ? this.registry.get(candidate.candidateId)
      : this.registry.attachPlan(candidate.candidateId, plan.planId);
    if (attached.planId !== plan.planId) throw new ForgeFlowError('CANDIDATE_PLAN_IMMUTABLE');
    return {
      candidate: attached,
      plan: this.repositories.plans.getPlan(plan.planId),
      ...(scheduling ? { scheduling } : {}),
    };
  }

  reconcile(candidateId: string): ImprovementCandidate {
    let candidate = this.registry.get(candidateId);
    if (!candidate.planId) return candidate;
    const program = this.registry.getProgram(candidate.programId);
    const plan = this.repositories.plans.getPlan(candidate.planId);
    if (plan.delivery?.pullRequestNumber && !candidate.pullRequestId) {
      candidate = this.registry.attachPullRequest(
        candidate.candidateId,
        String(plan.delivery.pullRequestNumber),
      );
    }
    if (candidate.status === 'ADOPTED' && plan.status === 'SUCCEEDED') {
      if (!this.isSelfTarget(program.projectKey, plan.repositoryPath))
        return this.registry.transition(candidate.candidateId, 'COMPLETED');
      const promotion = this.registry.latestSelfPromotion(candidateId);
      if (
        promotion &&
        promotion.planId === plan.planId &&
        promotion.sourceRevision === plan.currentRevision
      )
        return this.registry.transition(candidate.candidateId, 'COMPLETED');
      const request = this.registry.latestSelfPromotionRequest(candidateId);
      const release = this.releaseProvenance?.();
      if (
        request &&
        request.planId === plan.planId &&
        request.sourceRevision === plan.currentRevision &&
        release?.status === 'HEALTHY' &&
        release.sourceSha === request.sourceRevision &&
        release.artifactSha256 === request.artifactSha256
      ) {
        this.registry.recordSelfPromotion(candidateId, {
          planId: request.planId,
          sourceRevision: request.sourceRevision,
          artifactSha256: request.artifactSha256,
          canaryAttestationId: request.canaryAttestationId,
          releasedAt: release.releasedAt,
        });
        return this.registry.transition(candidate.candidateId, 'COMPLETED');
      }
      return candidate;
    }
    if (candidate.status === 'ADOPTED' && plan.status === 'CANCELLED')
      return this.registry.transition(candidate.candidateId, 'STALE');
    return candidate;
  }

  reconcileAll(limit = 100): ImprovementCandidate[] {
    return this.registry
      .list({ status: 'ADOPTED', limit })
      .map((candidate) => this.reconcile(candidate.candidateId));
  }

  runCycle(): {
    reconciledCandidateIds: string[];
    programs: Array<{
      programId: string;
      projectKey: string;
      discovered: number;
      created: number;
      adoptedPlanIds: string[];
      errors: string[];
    }>;
  } {
    const reconciledCandidateIds = this.reconcileAll().map((candidate) => candidate.candidateId);
    if (!this.options.discoveryEnabled) return { reconciledCandidateIds, programs: [] };
    const programs = [];
    for (const program of this.registry.listPrograms().slice(0, 100)) {
      if (!program.enabled || !this.allowedProjects.has(program.projectKey)) continue;
      const result = {
        programId: program.programId,
        projectKey: program.projectKey,
        discovered: 0,
        created: 0,
        adoptedPlanIds: [] as string[],
        errors: [] as string[],
      };
      try {
        const discovered = this.discover(program);
        result.discovered = discovered.length;
        result.created = discovered.filter((item) => item.mutation === 'created').length;
        if (
          this.options.autoAdoptLowRisk === true &&
          this.options.adoptionEnabled &&
          program.autonomousScope === 'STANDARD'
        ) {
          for (const item of discovered) {
            if (item.candidate.risk !== 'LOW' || item.candidate.status !== 'DISCOVERED') continue;
            try {
              const adopted = this.adopt(item.candidate.candidateId);
              result.adoptedPlanIds.push(adopted.plan.planId);
            } catch (error) {
              result.errors.push(
                error instanceof ForgeFlowError ? error.code : 'IMPROVEMENT_AUTO_ADOPT_FAILED',
              );
            }
          }
        }
      } catch (error) {
        result.errors.push(
          error instanceof ForgeFlowError ? error.code : 'IMPROVEMENT_DISCOVERY_FAILED',
        );
      }
      programs.push(result);
    }
    return { reconciledCandidateIds, programs };
  }

  async runAutonomousCycle(): Promise<
    ReturnType<MaintenanceImprovementRuntime['runCycle']> & {
      selfPromotion: {
        enabled: boolean;
        requestedCandidateIds: string[];
        errors: Array<{ candidateId: string; code: string }>;
      };
    }
  > {
    const base = this.runCycle();
    const selfPromotion = {
      enabled: this.options.selfAutoPromotionEnabled === true,
      requestedCandidateIds: [] as string[],
      errors: [] as Array<{ candidateId: string; code: string }>,
    };
    if (!selfPromotion.enabled) return { ...base, selfPromotion };
    for (const candidate of this.registry.list({ status: 'ADOPTED', limit: 100 })) {
      if (!candidate.planId) continue;
      const program = this.registry.getProgram(candidate.programId);
      const plan = this.repositories.plans.getPlan(candidate.planId);
      if (!this.isSelfTarget(program.projectKey, plan.repositoryPath) || plan.status !== 'SUCCEEDED')
        continue;
      const existing = this.registry.latestSelfPromotionRequest(candidate.candidateId);
      if (existing?.sourceRevision === plan.currentRevision) {
        const wakeKey = candidate.candidateId + '|' + existing.sourceRevision;
        if (this.selfPromotionWakeKeys.has(wakeKey)) continue;
        try {
          if (!this.selfPromotionQueue)
            throw new ForgeFlowError('IMPROVEMENT_SELF_PROMOTION_UNAVAILABLE');
          this.selfPromotionQueue.request({
            version: 1,
            candidateId: candidate.candidateId,
            planId: existing.planId,
            sourceRevision: existing.sourceRevision,
            artifactSha256: existing.artifactSha256,
            canaryAttestationId: existing.canaryAttestationId,
            requestedAt: existing.requestedAt,
          });
          this.selfPromotionWakeKeys.add(wakeKey);
        } catch (error) {
          selfPromotion.errors.push({
            candidateId: candidate.candidateId,
            code: error instanceof ForgeFlowError ? error.code : 'IMPROVEMENT_SELF_PROMOTION_FAILED',
          });
        }
        continue;
      }
      try {
        const canary = await this.runSelfCanary(candidate.candidateId);
        if (canary.result !== 'PASSED')
          throw new ForgeFlowError('IMPROVEMENT_SELF_CANARY_FAILED');
        this.requestSelfPromotion(candidate.candidateId);
        selfPromotion.requestedCandidateIds.push(candidate.candidateId);
        // A promotion request may immediately restart this control plane through
        // the systemd path unit. Emit at most one live-release request per cycle.
        break;
      } catch (error) {
        selfPromotion.errors.push({
          candidateId: candidate.candidateId,
          code: error instanceof ForgeFlowError ? error.code : 'IMPROVEMENT_SELF_PROMOTION_FAILED',
        });
      }
    }
    return { ...base, selfPromotion };
  }

  status(): {
    discoveryEnabled: boolean;
    adoptionEnabled: boolean;
    autoAdoptLowRisk: boolean;
    selfChangeEnabled: boolean;
    selfPromotionEnabled: boolean;
    selfAutoPromotionEnabled: boolean;
    allowedProjectKeys: string[];
  } {
    return {
      discoveryEnabled: this.options.discoveryEnabled,
      adoptionEnabled: this.options.adoptionEnabled,
      autoAdoptLowRisk: this.options.autoAdoptLowRisk === true,
      selfChangeEnabled: this.options.selfChangeEnabled === true,
      selfPromotionEnabled: this.options.selfPromotionEnabled === true,
      selfAutoPromotionEnabled: this.options.selfAutoPromotionEnabled === true,
      allowedProjectKeys: [...this.allowedProjects].sort(),
    };
  }
}
