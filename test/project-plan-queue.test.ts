import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ForgeFlowError } from '../src/core/domain/errors.js';
import { ProjectPlanQueueRuntime } from '../src/core/orchestration/projectPlanQueueRuntime.js';
import { openDatabase, SCHEMA_VERSION } from '../src/core/persistence/database.js';
import { createRepositories } from '../src/core/persistence/repositories.js';

function createRoot(
  repositories: ReturnType<typeof createRepositories>,
  planId: string,
  projectKey = 'project-gamma',
  repositoryPath = '/home/dev/projects/project-gamma',
) {
  return repositories.plans.createPlan({
    planId,
    idempotencyKey: 'queue:' + planId,
    projectKey,
    objective: 'Execute ' + planId,
    repositoryPath,
    baseRevision: 'base-sha',
  }).value!;
}

function finish(repositories: ReturnType<typeof createRepositories>, planId: string): void {
  const plan = repositories.plans.getPlan(planId);
  if (plan.status === 'READY') repositories.plans.updateStatus(planId, 'RUNNING');
  repositories.plans.updateStatus(planId, 'SUCCEEDED');
}

test('single-active-plan scheduler keeps later root plans queued and hands off FIFO across restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeflow-plan-queue-'));
  const dbFile = path.join(root, 'forgeflow.sqlite');
  let db = openDatabase(dbFile, { environment: 'test' });
  let repositories = createRepositories(db);
  let runtime = new ProjectPlanQueueRuntime(repositories);

  createRoot(repositories, 'plan-a');
  createRoot(repositories, 'plan-b');
  createRoot(repositories, 'plan-c');

  const active = runtime.scheduleRootPlan('plan-a');
  const queuedB = runtime.scheduleRootPlan('plan-b');
  const queuedC = runtime.scheduleRootPlan('plan-c');
  assert.equal(active.status, 'ACTIVE');
  assert.equal(queuedB.status, 'QUEUED');
  assert.equal(queuedC.status, 'QUEUED');
  assert.equal(repositories.plans.getPlan('plan-a').status, 'READY');
  assert.equal(repositories.plans.getPlan('plan-b').status, 'QUEUED');
  assert.equal(repositories.plans.getPlan('plan-c').status, 'QUEUED');
  assert.equal(repositories.supervisors.getByPlanId('plan-a')?.status, 'ACTIVE');
  assert.equal(repositories.supervisors.getByPlanId('plan-b'), undefined);
  assert.equal(repositories.supervisors.getByPlanId('plan-c'), undefined);
  assert.deepEqual(
    repositories.projectPlans.listQueue('project-gamma').map((entry) => entry.planId),
    ['plan-b', 'plan-c'],
  );

  const leaseBeforeRestart = repositories.projectPlans.getLease('project-gamma')!;
  assert.equal(leaseBeforeRestart.activeRootPlanId, 'plan-a');
  db.close();

  db = openDatabase(dbFile, { environment: 'test' });
  repositories = createRepositories(db);
  runtime = new ProjectPlanQueueRuntime(repositories);
  assert.equal(repositories.projectPlans.getLease('project-gamma')?.activeRootPlanId, 'plan-a');

  const advancedA = repositories.plans.reconcileCurrentRevision(
    'plan-a',
    'base-sha',
    'head-a',
    'test accepted integration head',
  );
  assert.equal(advancedA.status, 'updated');
  finish(repositories, 'plan-a');
  const firstHandoff = await runtime.reconcile();
  assert.equal(firstHandoff[0]?.activatedPlanId, 'plan-b');
  assert.equal(repositories.projectPlans.getLease('project-gamma')?.activeRootPlanId, 'plan-b');
  assert.equal(repositories.projectPlans.getLease('project-gamma')?.committedRevision, 'head-a');
  assert.equal(repositories.plans.getPlan('plan-b').status, 'READY');
  assert.equal(repositories.plans.getPlan('plan-b').baseRevision, 'base-sha');
  assert.equal(repositories.plans.getPlan('plan-b').currentRevision, 'head-a');
  assert.equal(repositories.supervisors.getByPlanId('plan-a')?.status, 'CANCELLED');
  assert.equal(repositories.supervisors.getByPlanId('plan-b')?.status, 'ACTIVE');
  assert.equal(repositories.supervisors.getByPlanId('plan-c'), undefined);

  repositories.plans.reconcileCurrentRevision(
    'plan-b',
    'head-a',
    'head-b',
    'test second accepted integration head',
  );
  finish(repositories, 'plan-b');
  await runtime.reconcile();
  assert.equal(repositories.projectPlans.getLease('project-gamma')?.activeRootPlanId, 'plan-c');
  assert.equal(repositories.projectPlans.getLease('project-gamma')?.committedRevision, 'head-b');
  assert.equal(repositories.plans.getPlan('plan-c').status, 'READY');
  assert.equal(repositories.plans.getPlan('plan-c').baseRevision, 'base-sha');
  assert.equal(repositories.plans.getPlan('plan-c').currentRevision, 'head-b');
  assert.equal(repositories.supervisors.getByPlanId('plan-c')?.status, 'ACTIVE');

  finish(repositories, 'plan-c');
  await runtime.reconcile();
  const emptyLease = repositories.projectPlans.getLease('project-gamma')!;
  assert.equal(emptyLease.activeRootPlanId, undefined);
  assert.equal(emptyLease.committedRevision, 'head-b');
  assert.equal(repositories.projectPlans.listQueue('project-gamma').length, 0);

  createRoot(repositories, 'plan-d');
  const resumed = runtime.scheduleRootPlan('plan-d');
  assert.equal(resumed.status, 'ACTIVE');
  assert.equal(repositories.plans.getPlan('plan-d').baseRevision, 'base-sha');
  assert.equal(repositories.plans.getPlan('plan-d').currentRevision, 'head-b');
  assert.equal(repositories.projectPlans.getLease('project-gamma')?.committedRevision, 'head-b');
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('project lease is version fenced, repository bound and cannot be double acquired', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeflow-plan-fence-'));
  const dbFile = path.join(root, 'forgeflow.sqlite');
  const db1 = openDatabase(dbFile, { environment: 'test' });
  const r1 = createRepositories(db1);
  createRoot(r1, 'plan-a');
  createRoot(r1, 'plan-b');

  const db2 = openDatabase(dbFile, { environment: 'test' });
  const r2 = createRepositories(db2);
  const first = r1.projectPlans.tryAcquire('project-gamma', 'plan-a', 0);
  assert.equal(first.status, 'created');
  const stale = r2.projectPlans.tryAcquire('project-gamma', 'plan-b', 0);
  assert.equal(stale.status, 'rejected');
  assert.equal(stale.reason, 'STALE_VERSION');

  const lease = r1.projectPlans.getLease('project-gamma')!;
  const renewed = r1.projectPlans.renew('project-gamma', 'plan-a', lease.version);
  assert.equal(renewed.value?.version, lease.version + 1);
  const staleRenew = r2.projectPlans.renew('project-gamma', 'plan-a', lease.version);
  assert.equal(staleRenew.status, 'rejected');
  assert.equal(staleRenew.reason, 'STALE_VERSION');

  createRoot(r1, 'wrong-repo', 'project-gamma', '/home/dev/projects/other-project-gamma');
  assert.throws(
    () => r1.projectPlans.scheduleRootPlan('wrong-repo'),
    (error: unknown) =>
      error instanceof ForgeFlowError && error.code === 'PROJECT_PLAN_REPOSITORY_MISMATCH',
  );

  db2.close();
  db1.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('queued plan reprioritization is deterministic and cancellation provisions no supervisor', () => {
  const db = openDatabase(':memory:', { environment: 'test' });
  const repositories = createRepositories(db);
  const runtime = new ProjectPlanQueueRuntime(repositories);
  createRoot(repositories, 'plan-a');
  createRoot(repositories, 'plan-b');
  createRoot(repositories, 'plan-c');
  runtime.scheduleRootPlan('plan-a');
  runtime.scheduleRootPlan('plan-b');
  runtime.scheduleRootPlan('plan-c');

  repositories.projectPlans.reprioritize('plan-c', 10);
  assert.deepEqual(
    repositories.projectPlans.listQueue('project-gamma').map((entry) => entry.planId),
    ['plan-c', 'plan-b'],
  );
  runtime.cancelQueued('plan-c');
  assert.equal(repositories.plans.getPlan('plan-c').status, 'CANCELLED');
  assert.equal(repositories.supervisors.getByPlanId('plan-c'), undefined);
  assert.deepEqual(
    repositories.projectPlans.listQueue('project-gamma').map((entry) => entry.planId),
    ['plan-b'],
  );
  db.close();
});

test('schema v11 migrates the active logical project head into the durable lease', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeflow-plan-v11-head-'));
  const dbFile = path.join(root, 'forgeflow.sqlite');
  let db = openDatabase(dbFile, { environment: 'test' });
  let repositories = createRepositories(db);
  createRoot(repositories, 'plan-a');
  const runtime = new ProjectPlanQueueRuntime(repositories);
  runtime.scheduleRootPlan('plan-a');
  repositories.plans.reconcileCurrentRevision(
    'plan-a',
    'base-sha',
    'head-before-v12',
    'migration fixture',
  );
  db.exec('ALTER TABLE project_plan_leases DROP COLUMN committed_revision');
  db.prepare("UPDATE schema_meta SET schema_version=11 WHERE schema_id='forgeflow'").run();
  db.close();

  db = openDatabase(dbFile, { environment: 'production', env: { NODE_ENV: 'production' } });
  repositories = createRepositories(db);
  assert.equal(
    db.prepare("SELECT schema_version FROM schema_meta WHERE schema_id='forgeflow'").get()
      ?.schema_version,
    SCHEMA_VERSION,
  );
  assert.equal(repositories.projectPlans.getLease('project-gamma')?.activeRootPlanId, 'plan-a');
  assert.equal(
    repositories.projectPlans.getLease('project-gamma')?.committedRevision,
    'head-before-v12',
  );
  assert.equal(repositories.plans.getPlan('plan-a').currentRevision, 'head-before-v12');
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('schema v6 migrates additively to the single-active-plan scheduling schema', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeflow-plan-schema-'));
  const dbFile = path.join(root, 'forgeflow.sqlite');
  const current = openDatabase(dbFile, { environment: 'test' });
  current.exec('DROP TABLE project_plan_queue; DROP TABLE project_plan_leases;');
  current.prepare("UPDATE schema_meta SET schema_version=6 WHERE schema_id='forgeflow'").run();
  current.close();

  const migrated = openDatabase(dbFile, { environment: 'test' });
  assert.equal(
    migrated.prepare("SELECT schema_version FROM schema_meta WHERE schema_id='forgeflow'").get()
      ?.schema_version,
    SCHEMA_VERSION,
  );
  const tables = new Set(
    (
      migrated.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name),
  );
  assert.equal(tables.has('project_plan_leases'), true);
  assert.equal(tables.has('project_plan_queue'), true);
  migrated.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('terminal Plan cleanup must succeed before the project lease can hand off', async () => {
  const db = openDatabase(':memory:', { environment: 'test' });
  const repositories = createRepositories(db);
  const calls: string[] = [];
  let failCleanup = true;
  const runtime = new ProjectPlanQueueRuntime(repositories, {
    activate: async (planId) => {
      calls.push('activate:' + planId);
    },
    retire: async (planId) => {
      calls.push('retire:' + planId);
      if (failCleanup) throw new ForgeFlowError('WORKTREE_CLEANUP_BLOCKED');
    },
  });
  createRoot(repositories, 'plan-a');
  createRoot(repositories, 'plan-b');
  runtime.scheduleRootPlan('plan-a');
  runtime.scheduleRootPlan('plan-b');
  finish(repositories, 'plan-a');

  const blocked = await runtime.reconcile();
  assert.equal(blocked[0]?.code, 'WORKTREE_CLEANUP_BLOCKED');
  assert.equal(repositories.projectPlans.getLease('project-gamma')?.activeRootPlanId, 'plan-a');
  assert.equal(repositories.plans.getPlan('plan-b').status, 'QUEUED');
  assert.equal(repositories.supervisors.getByPlanId('plan-b'), undefined);

  failCleanup = false;
  const result = await runtime.reconcile();
  assert.equal(result[0]?.activatedPlanId, 'plan-b');
  assert.deepEqual(calls, ['retire:plan-a', 'retire:plan-a', 'activate:plan-b']);
  assert.equal(repositories.projectPlans.getLease('project-gamma')?.activeRootPlanId, 'plan-b');
  db.close();
});

test('operator cancellation retires an active root Plan and hands off only after cleanup', async () => {
  const db = openDatabase(':memory:', { environment: 'test' });
  const repositories = createRepositories(db);
  const calls: string[] = [];
  const runtime = new ProjectPlanQueueRuntime(repositories, {
    activate: async (planId) => calls.push('activate:' + planId),
    retire: async (planId) => calls.push('retire:' + planId),
  });
  createRoot(repositories, 'plan-cancel-a');
  createRoot(repositories, 'plan-cancel-b');
  const graph = repositories.plans.createGraphVersion({
    planId: 'plan-cancel-a',
    reason: 'operator cancel fixture',
  }).value!;
  const item = repositories.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId,
    itemKey: 'cancel-item',
    title: 'Cancel item',
    objective: 'remain harmless until cancellation',
    acceptanceCriteria: ['never execute after cancellation'],
    dependencies: [],
  }).value!;
  runtime.scheduleRootPlan('plan-cancel-a');
  runtime.scheduleRootPlan('plan-cancel-b');

  const result = await runtime.cancelActive(
    'plan-cancel-a',
    'operator-cancel-plan-a',
    'smoke validation complete',
  );

  assert.equal(result.code, 'PROJECT_PLAN_CANCELLED_HANDOFF');
  assert.equal(result.releasedPlanId, 'plan-cancel-a');
  assert.equal(result.activatedPlanId, 'plan-cancel-b');
  assert.deepEqual(result.cancelledExecutionIds, []);
  assert.deepEqual(result.cancelledWorkItemIds, [item.workItemId]);
  assert.deepEqual(calls, ['retire:plan-cancel-a', 'activate:plan-cancel-b']);
  assert.equal(repositories.plans.getPlan('plan-cancel-a').status, 'CANCELLED');
  assert.equal(repositories.plans.getWorkItem(item.workItemId).status, 'CANCELLED');
  assert.equal(repositories.supervisors.getByPlanId('plan-cancel-a')?.status, 'CANCELLED');
  assert.equal(repositories.plans.getPlan('plan-cancel-b').status, 'READY');
  assert.equal(repositories.supervisors.getByPlanId('plan-cancel-b')?.status, 'ACTIVE');
  assert.equal(
    repositories.projectPlans.getLease('project-gamma')?.activeRootPlanId,
    'plan-cancel-b',
  );
  const repeated = await runtime.cancelActive(
    'plan-cancel-a',
    'operator-cancel-plan-a',
    'smoke validation complete',
  );
  assert.equal(repeated.code, 'PROJECT_PLAN_ALREADY_CANCELLED');
  assert.equal(
    repositories.projectPlans.getLease('project-gamma')?.activeRootPlanId,
    'plan-cancel-b',
  );
  db.close();
});

test('operator cancellation holds the Plan and lease when an execution cannot be quiesced, then retries safely', async () => {
  const db = openDatabase(':memory:', { environment: 'test' });
  const repositories = createRepositories(db);
  const calls: string[] = [];
  let allowCancel = false;
  const runtime = new ProjectPlanQueueRuntime(repositories, {
    activate: async (planId) => calls.push('activate:' + planId),
    retire: async (planId) => calls.push('retire:' + planId),
  });
  runtime.setExecutionCancellation({
    cancelExecution: async (executionId) => {
      if (!allowCancel) return { status: 'WAITING', code: 'PROVIDER_CANCEL_NOT_QUIESCED' };
      repositories.executions.updateStatus(executionId, 'CANCELLED');
      return { status: 'SUCCEEDED', code: 'EXECUTION_OPERATOR_CANCELLED' };
    },
  });
  createRoot(repositories, 'plan-cancel-live');
  createRoot(repositories, 'plan-cancel-next');
  const graph = repositories.plans.createGraphVersion({
    planId: 'plan-cancel-live',
    reason: 'operator cancel live fixture',
  }).value!;
  const item = repositories.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId,
    itemKey: 'live-item',
    title: 'Live item',
    objective: 'exercise fail-closed cancellation',
    acceptanceCriteria: ['lease never releases while execution is live'],
    dependencies: [],
  }).value!;
  runtime.scheduleRootPlan('plan-cancel-live');
  runtime.scheduleRootPlan('plan-cancel-next');
  repositories.plans.updateWorkItemStatus(item.workItemId, 'RUNNING');
  const execution = repositories.executions.create({
    idempotencyKey: 'plan-cancel-live-execution',
    identity: {
      executionId: 'plan-cancel-live-execution',
      planId: 'plan-cancel-live',
      workItemId: item.workItemId,
      phase: 'IMPLEMENT',
      attempt: 1,
      route: 'implementation',
      sourceRevision: 'base-sha',
    },
    objective: 'live cancellation fixture',
  }).value!;

  await assert.rejects(
    runtime.cancelActive(
      'plan-cancel-live',
      'operator-cancel-live',
      'operator requested cancellation',
    ),
    (error: unknown) =>
      error instanceof ForgeFlowError && error.code === 'PROVIDER_CANCEL_NOT_QUIESCED',
  );
  assert.equal(repositories.plans.getPlan('plan-cancel-live').status, 'SAFETY_HOLD');
  assert.equal(repositories.supervisors.getByPlanId('plan-cancel-live')?.status, 'CANCELLED');
  assert.equal(repositories.executions.get(execution.identity.executionId).status, 'QUEUED');
  assert.equal(
    repositories.projectPlans.getLease('project-gamma')?.activeRootPlanId,
    'plan-cancel-live',
  );
  assert.equal(repositories.plans.getPlan('plan-cancel-next').status, 'QUEUED');
  assert.deepEqual(calls, []);

  allowCancel = true;
  const recovered = await runtime.cancelActive(
    'plan-cancel-live',
    'operator-cancel-live',
    'operator requested cancellation',
  );
  assert.equal(recovered.code, 'PROJECT_PLAN_CANCELLED_HANDOFF');
  assert.deepEqual(recovered.cancelledExecutionIds, [execution.identity.executionId]);
  assert.equal(repositories.plans.getPlan('plan-cancel-live').status, 'CANCELLED');
  assert.equal(repositories.plans.getWorkItem(item.workItemId).status, 'CANCELLED');
  assert.equal(repositories.plans.getPlan('plan-cancel-next').status, 'READY');
  assert.equal(
    repositories.projectPlans.getLease('project-gamma')?.activeRootPlanId,
    'plan-cancel-next',
  );
  assert.deepEqual(calls, ['retire:plan-cancel-live', 'activate:plan-cancel-next']);
  db.close();
});

test('operator root cancellation refuses to orphan a non-terminal child Plan', async () => {
  const db = openDatabase(':memory:', { environment: 'test' });
  const repositories = createRepositories(db);
  const runtime = new ProjectPlanQueueRuntime(repositories);
  createRoot(repositories, 'plan-cancel-parent');
  runtime.scheduleRootPlan('plan-cancel-parent');
  repositories.plans.createChildPlan({
    parentPlanId: 'plan-cancel-parent',
    childPlanId: 'plan-cancel-child',
    repositoryPath: '/home/dev/projects/project-gamma',
    objective: 'active child',
    relation: 'FOLLOW_UP',
  });

  await assert.rejects(
    runtime.cancelActive(
      'plan-cancel-parent',
      'operator-cancel-parent',
      'must not orphan child work',
    ),
    (error: unknown) =>
      error instanceof ForgeFlowError && error.code === 'PROJECT_PLAN_CANCEL_DESCENDANT_ACTIVE',
  );
  assert.equal(repositories.plans.getPlan('plan-cancel-parent').status, 'READY');
  assert.equal(
    repositories.projectPlans.getLease('project-gamma')?.activeRootPlanId,
    'plan-cancel-parent',
  );
  db.close();
});

test('operator cancellation keeps the project lease when worktree retirement fails and resumes cleanup idempotently', async () => {
  const db = openDatabase(':memory:', { environment: 'test' });
  const repositories = createRepositories(db);
  const calls: string[] = [];
  let failRetire = true;
  const runtime = new ProjectPlanQueueRuntime(repositories, {
    activate: async (planId) => calls.push('activate:' + planId),
    retire: async (planId) => {
      calls.push('retire:' + planId);
      if (failRetire) throw new ForgeFlowError('WORKTREE_CLEANUP_BLOCKED');
    },
  });
  createRoot(repositories, 'plan-cancel-cleanup');
  createRoot(repositories, 'plan-cancel-after-cleanup');
  const graph = repositories.plans.createGraphVersion({
    planId: 'plan-cancel-cleanup',
    reason: 'cleanup failure cancellation fixture',
  }).value!;
  repositories.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId,
    itemKey: 'cleanup-item',
    title: 'Cleanup item',
    objective: 'prove lease fencing through cleanup failure',
    acceptanceCriteria: ['lease remains fenced'],
    dependencies: [],
  });
  runtime.scheduleRootPlan('plan-cancel-cleanup');
  runtime.scheduleRootPlan('plan-cancel-after-cleanup');

  await assert.rejects(
    runtime.cancelActive(
      'plan-cancel-cleanup',
      'operator-cancel-cleanup',
      'cancel despite cleanup needing retry',
    ),
    (error: unknown) =>
      error instanceof ForgeFlowError && error.code === 'WORKTREE_CLEANUP_BLOCKED',
  );
  assert.equal(repositories.plans.getPlan('plan-cancel-cleanup').status, 'CANCELLED');
  assert.equal(
    repositories.projectPlans.getLease('project-gamma')?.activeRootPlanId,
    'plan-cancel-cleanup',
  );
  assert.equal(repositories.plans.getPlan('plan-cancel-after-cleanup').status, 'QUEUED');
  assert.equal(repositories.supervisors.getByPlanId('plan-cancel-cleanup')?.status, 'CANCELLED');

  failRetire = false;
  const resumed = await runtime.cancelActive(
    'plan-cancel-cleanup',
    'operator-cancel-cleanup',
    'cancel despite cleanup needing retry',
  );
  assert.equal(resumed.code, 'PROJECT_PLAN_CANCELLED_HANDOFF');
  assert.equal(resumed.activatedPlanId, 'plan-cancel-after-cleanup');
  assert.equal(
    repositories.projectPlans.getLease('project-gamma')?.activeRootPlanId,
    'plan-cancel-after-cleanup',
  );
  assert.deepEqual(calls, [
    'retire:plan-cancel-cleanup',
    'retire:plan-cancel-cleanup',
    'activate:plan-cancel-after-cleanup',
  ]);
  db.close();
});
