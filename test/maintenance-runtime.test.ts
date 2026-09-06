import assert from 'node:assert/strict';
import test from 'node:test';

import { MaintenanceCandidateRegistry } from '../src/core/adapters/maintenance.js';
import { ForgeFlowError } from '../src/core/domain/errors.js';
import { PlanKernel } from '../src/core/kernel/planKernel.js';
import { MaintenanceImprovementRuntime } from '../src/core/orchestration/maintenanceRuntime.js';
import { ProjectPlanQueueRuntime } from '../src/core/orchestration/projectPlanQueueRuntime.js';
import { openDatabase } from '../src/core/persistence/database.js';
import { createRepositories } from '../src/core/persistence/repositories.js';

function setup(options: {
  discoveryEnabled?: boolean;
  adoptionEnabled?: boolean;
  allowedProjectKeys?: string[];
  selfChangeEnabled?: boolean;
  selfRepositoryPath?: string;
} = {}) {
  const db = openDatabase(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } });
  const repositories = createRepositories(db);
  const registry = new MaintenanceCandidateRegistry(db);
  const plans = new PlanKernel(repositories);
  const queue = new ProjectPlanQueueRuntime(repositories);
  const runtime = new MaintenanceImprovementRuntime(db, registry, repositories, plans, queue, {
    discoveryEnabled: options.discoveryEnabled ?? true,
    adoptionEnabled: options.adoptionEnabled ?? true,
    allowedProjectKeys: options.allowedProjectKeys ?? ['project-alpha'],
    selfChangeEnabled: options.selfChangeEnabled ?? false,
    selfProjectKey: 'forgeflow',
    selfRepositoryPath: options.selfRepositoryPath ?? '/srv/forgeflow',
  });
  return { db, repositories, registry, plans, queue, runtime };
}

function recordFailure(
  value: ReturnType<typeof setup>,
  index: number,
  errorCode: string,
  projectKey = 'project-alpha',
  repositoryPath = '/srv/project-alpha',
  phase: 'IMPLEMENT' | 'REVIEW' = 'IMPLEMENT',
) {
  const plan = value.repositories.plans.createPlan({
    idempotencyKey: `failure-plan-${projectKey}-${index}-${errorCode}`,
    projectKey,
    objective: 'historical failed work',
    repositoryPath,
    baseRevision: 'base-sha',
  }).value!;
  const executionId = `failure-execution-${projectKey}-${index}-${errorCode}`;
  value.repositories.executions.create({
    idempotencyKey: executionId,
    identity: {
      executionId,
      planId: plan.planId,
      phase,
      attempt: 1,
      route: 'test-route',
      sourceRevision: 'base-sha',
    },
    objective: 'exercise deterministic improvement discovery',
  });
  value.repositories.executions.updateStatus(executionId, 'RUNNING');
  value.repositories.executions.recordResult(executionId, {
    status: 'FAILED',
    errorCode,
    retryable: false,
  });
}

const program = () => ({
  programId: 'project-alpha-maintenance',
  projectKey: 'project-alpha',
  repositoryPath: '/srv/project-alpha',
  autonomousScope: 'CONSERVATIVE' as const,
  autoMerge: false,
  enabled: true,
  failureThreshold: 3,
  recentExecutionLimit: 100,
  candidateRisk: 'LOW' as const,
});

test('recurring local failures create one deterministic improvement candidate and ignore resource noise', () => {
  const value = setup();
  for (let index = 1; index <= 4; index += 1)
    recordFailure(value, index, 'TEST_REGRESSION_FAILED');
  for (let index = 1; index <= 5; index += 1)
    recordFailure(value, 20 + index, 'QUOTA_EXHAUSTED');

  const first = value.runtime.discover(program());
  assert.equal(first.length, 1);
  assert.equal(first[0]?.mutation, 'created');
  assert.equal(first[0]?.observedCount, 4);
  assert.equal(first[0]?.errorCode, 'TEST_REGRESSION_FAILED');
  assert.deepEqual(first[0]?.candidate.evidence, [
    'failure-code:TEST_REGRESSION_FAILED',
    'phase:IMPLEMENT',
    'threshold:3',
  ]);

  const second = value.runtime.discover(program());
  assert.equal(second.length, 1);
  assert.equal(second[0]?.mutation, 'existing');
  assert.equal(second[0]?.candidate.candidateId, first[0]?.candidate.candidateId);
  assert.equal(value.registry.list().length, 1);
  value.db.close();
});

test('discovery is project-gated and does not persist a program when disabled or disallowed', () => {
  const disabled = setup({ discoveryEnabled: false });
  assert.throws(
    () => disabled.runtime.discover(program()),
    (error: unknown) => error instanceof ForgeFlowError && error.code === 'IMPROVEMENT_DISCOVERY_DISABLED',
  );
  assert.deepEqual(disabled.registry.listPrograms(), []);
  disabled.db.close();

  const disallowed = setup({ allowedProjectKeys: ['other-project'] });
  assert.throws(
    () => disallowed.runtime.discover(program()),
    (error: unknown) => error instanceof ForgeFlowError && error.code === 'IMPROVEMENT_PROJECT_NOT_ALLOWED',
  );
  assert.deepEqual(disallowed.registry.listPrograms(), []);
  disallowed.db.close();
});

test('explicit adoption creates a normal queued Plan with immutable candidate lineage and completion follows Plan truth', () => {
  const value = setup();
  for (let index = 1; index <= 3; index += 1)
    recordFailure(value, index, 'TEST_REGRESSION_FAILED');
  const candidate = value.runtime.discover(program())[0]!.candidate;

  const adopted = value.runtime.adopt(candidate.candidateId);
  assert.equal(adopted.candidate.status, 'ADOPTED');
  assert.equal(adopted.candidate.planId, adopted.plan.planId);
  assert.equal(adopted.plan.projectKey, 'project-alpha');
  assert.equal(adopted.plan.repositoryPath, '/srv/project-alpha');
  assert.equal(adopted.plan.status, 'READY');
  assert.equal(adopted.scheduling?.status, 'ACTIVE');
  const graph = value.repositories.plans.getActiveGraphVersion(adopted.plan.planId)!;
  const items = value.repositories.plans.listWorkItems(adopted.plan.planId, graph.graphVersionId);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.itemKey, 'improvement');
  assert.match(items[0]?.objective ?? '', /root cause/i);
  assert.ok(items[0]?.acceptanceCriteria.some((item) => /independent exact-revision review/.test(item)));
  assert.ok(value.repositories.supervisors.getByPlanId(adopted.plan.planId));

  const replay = value.runtime.adopt(candidate.candidateId);
  assert.equal(replay.plan.planId, adopted.plan.planId);
  assert.equal(replay.candidate.planId, adopted.plan.planId);

  value.repositories.plans.updateStatus(adopted.plan.planId, 'RUNNING');
  value.repositories.plans.updateStatus(adopted.plan.planId, 'SUCCEEDED');
  const completed = value.runtime.reconcile(candidate.candidateId);
  assert.equal(completed.status, 'COMPLETED');
  assert.throws(
    () => value.registry.transition(candidate.candidateId, 'ADOPTED'),
    (error: unknown) => error instanceof ForgeFlowError && error.code === 'CANDIDATE_TRANSITION_INVALID',
  );
  value.db.close();
});

test('self-change remains hard-disabled even when the ForgeFlow project is accidentally allowlisted', () => {
  const value = setup({
    allowedProjectKeys: ['forgeflow'],
    selfRepositoryPath: '/srv/forgeflow',
    selfChangeEnabled: false,
  });
  const selfProgram = {
    ...program(),
    programId: 'forgeflow-maintenance',
    projectKey: 'forgeflow',
    repositoryPath: '/srv/forgeflow',
  };
  value.registry.upsertProgram(selfProgram);
  const candidate = value.registry.create(selfProgram, {
    title: 'Do not self modify yet',
    evidence: ['failure-code:TEST_SELF_CHANGE'],
    risk: 'LOW',
  }).candidate;
  assert.throws(
    () => value.runtime.adopt(candidate.candidateId, { baseRevision: 'base-sha' }),
    (error: unknown) => error instanceof ForgeFlowError && error.code === 'IMPROVEMENT_SELF_CHANGE_DISABLED',
  );
  assert.equal(value.registry.get(candidate.candidateId).planId, undefined);
  value.db.close();
});

test('high-risk candidate needs explicit acknowledgement before a normal improvement Plan can be adopted', () => {
  const value = setup();
  const highRiskProgram = { ...program(), candidateRisk: 'HIGH' as const };
  value.registry.upsertProgram(highRiskProgram);
  const candidate = value.registry.create(highRiskProgram, {
    title: 'High risk correction',
    evidence: ['failure-code:SCHEMA_BREAKING_CHANGE'],
    risk: 'HIGH',
  }).candidate;
  assert.throws(
    () => value.runtime.adopt(candidate.candidateId, { baseRevision: 'base-sha' }),
    (error: unknown) => error instanceof ForgeFlowError && error.code === 'CANDIDATE_HIGH_RISK_ACK_REQUIRED',
  );
  const adopted = value.runtime.adopt(candidate.candidateId, {
    baseRevision: 'base-sha',
    acknowledgeHighRisk: true,
  });
  assert.equal(adopted.candidate.status, 'ADOPTED');
  value.db.close();
});
