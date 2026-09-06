import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import {
  MaintenanceCandidateRegistry,
  type ImprovementCandidate,
  type MaintenanceProgram,
} from '../adapters/maintenance.js';
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
  allowedProjectKeys: readonly string[];
  selfChangeEnabled?: boolean;
  selfProjectKey?: string;
  selfRepositoryPath?: string;
}

export class MaintenanceImprovementRuntime {
  readonly allowedProjects: ReadonlySet<string>;

  constructor(
    readonly db: DatabaseSync,
    readonly registry: MaintenanceCandidateRegistry,
    readonly repositories: ForgeFlowRepositories,
    readonly plans: PlanKernel,
    readonly projectPlanQueue: ProjectPlanQueueRuntime | undefined,
    readonly options: ImprovementRuntimeOptions,
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

  private requireAdoption(projectKey: string, repositoryPath: string): void {
    if (!this.options.adoptionEnabled) throw new ForgeFlowError('IMPROVEMENT_ADOPTION_DISABLED');
    this.requireProject(projectKey);
    const selfProject = this.options.selfProjectKey ?? 'forgeflow';
    const selfRepository = this.options.selfRepositoryPath
      ? path.resolve(this.options.selfRepositoryPath)
      : undefined;
    const isSelf =
      projectKey === selfProject ||
      (selfRepository !== undefined && path.resolve(repositoryPath) === selfRepository);
    if (isSelf && this.options.selfChangeEnabled !== true)
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

  adopt(candidateId: string, input: ImprovementAdoptionInput = {}): ImprovementAdoptionResult {
    const candidate = this.registry.get(candidateId);
    if (candidate.status !== 'DISCOVERED' && candidate.status !== 'QUEUED' && candidate.status !== 'ADOPTED')
      throw new ForgeFlowError('CANDIDATE_NOT_ADOPTABLE');
    const program = this.registry.getProgram(candidate.programId);
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
    const plan = this.repositories.plans.getPlan(candidate.planId);
    if (plan.delivery?.pullRequestNumber && !candidate.pullRequestId) {
      candidate = this.registry.attachPullRequest(
        candidate.candidateId,
        String(plan.delivery.pullRequestNumber),
      );
    }
    if (candidate.status === 'ADOPTED' && plan.status === 'SUCCEEDED')
      return this.registry.transition(candidate.candidateId, 'COMPLETED');
    if (candidate.status === 'ADOPTED' && plan.status === 'CANCELLED')
      return this.registry.transition(candidate.candidateId, 'STALE');
    return candidate;
  }

  reconcileAll(limit = 100): ImprovementCandidate[] {
    return this.registry
      .list({ status: 'ADOPTED', limit })
      .map((candidate) => this.reconcile(candidate.candidateId));
  }

  status(): {
    discoveryEnabled: boolean;
    adoptionEnabled: boolean;
    selfChangeEnabled: boolean;
    allowedProjectKeys: string[];
  } {
    return {
      discoveryEnabled: this.options.discoveryEnabled,
      adoptionEnabled: this.options.adoptionEnabled,
      selfChangeEnabled: this.options.selfChangeEnabled === true,
      allowedProjectKeys: [...this.allowedProjects].sort(),
    };
  }
}
