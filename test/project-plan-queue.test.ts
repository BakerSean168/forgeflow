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

test('SAFETY_HOLD root Plans keep the lease fenced without automatic lifecycle activation', async () => {
  const db = openDatabase(':memory:', { environment: 'test' });
  const repositories = createRepositories(db);
  const calls: string[] = [];
  const runtime = new ProjectPlanQueueRuntime(repositories, {
    activate: async (planId) => calls.push('activate:' + planId),
    retire: async (planId) => calls.push('retire:' + planId),
  });
  createRoot(repositories, 'plan-held');
  runtime.scheduleRootPlan('plan-held');
  repositories.plans.updateStatus('plan-held', 'SAFETY_HOLD');

  const result = await runtime.reconcile();

  assert.deepEqual(result, []);
  assert.deepEqual(calls, []);
  assert.equal(repositories.plans.getPlan('plan-held').status, 'SAFETY_HOLD');
  assert.equal(
    repositories.projectPlans.getLease('project-gamma')?.activeRootPlanId,
    'plan-held',
  );
  db.close();
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

test('operator cleanup of a terminal FAILED root preserves failure truth while releasing residual execution state and lease', async () => {
  const db = openDatabase(':memory:', { environment: 'test' });
  const repositories = createRepositories(db);
  const calls: string[] = [];
  const runtime = new ProjectPlanQueueRuntime(repositories, {
    retire: async (planId) => {
      calls.push('retire:' + planId);
      assert.equal(repositories.plans.getPlan(planId).status, 'FAILED');
    },
  });
  createRoot(repositories, 'plan-failed-cleanup');
  const graph = repositories.plans.createGraphVersion({
    planId: 'plan-failed-cleanup',
    reason: 'terminal failed cleanup fixture',
  }).value!;
  const item = repositories.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId,
    itemKey: 'failed-item',
    title: 'Failed item',
    objective: 'leave a failed writer that still needs cleanup',
    acceptanceCriteria: ['failure truth is preserved while resources are retired'],
    dependencies: [],
  }).value!;
  runtime.scheduleRootPlan('plan-failed-cleanup');
  repositories.plans.updateStatus('plan-failed-cleanup', 'RUNNING');
  repositories.plans.updateWorkItemStatus(item.workItemId, 'RUNNING');
  const execution = repositories.executions.create({
    idempotencyKey: 'terminal-failed-execution',
    identity: {
      executionId: 'terminal-failed-execution',
      planId: 'plan-failed-cleanup',
      workItemId: item.workItemId,
      phase: 'IMPLEMENT',
      attempt: 1,
      route: 'implementation',
      sourceRevision: 'base-sha',
    },
    objective: 'fail after creating residual workspace state',
  }).value!;
  repositories.executions.updateStatus(execution.identity.executionId, 'RUNNING');
  repositories.executions.recordResult(execution.identity.executionId, {
    status: 'FAILED',
    errorCode: 'WORKTREE_GIT_LINKAGE_VIOLATED',
    retryable: false,
  });
  repositories.plans.updateStatus('plan-failed-cleanup', 'FAILED');
  runtime.setExecutionCancellation({
    cancelExecution: async (executionId) => {
      calls.push('cancel:' + executionId);
      repositories.executions.updateStatus(executionId, 'CANCELLED');
      return { status: 'SUCCEEDED', code: 'EXECUTION_OPERATOR_CANCELLED' };
    },
  });

  const result = await runtime.cancelActive(
    'plan-failed-cleanup',
    'operator-clean-terminal-failed',
    'release residual resources without rewriting failed plan truth',
  );

  assert.equal(result.code, 'PROJECT_PLAN_FAILED_CLEANED_UP');
  assert.deepEqual(calls, ['cancel:terminal-failed-execution', 'retire:plan-failed-cleanup']);
  assert.equal(repositories.plans.getPlan('plan-failed-cleanup').status, 'FAILED');
  assert.equal(repositories.plans.getWorkItem(item.workItemId).status, 'CANCELLED');
  const cleanedExecution = repositories.executions.get(execution.identity.executionId);
  assert.equal(cleanedExecution.status, 'CANCELLED');
  assert.equal(cleanedExecution.errorCode, 'WORKTREE_GIT_LINKAGE_VIOLATED');
  assert.equal(
    repositories.projectPlans.getLease('project-gamma')?.activeRootPlanId,
    undefined,
  );
  const repeated = await runtime.cancelActive(
    'plan-failed-cleanup',
    'operator-clean-terminal-failed',
    'release residual resources without rewriting failed plan truth',
  );
  assert.equal(repeated.code, 'PROJECT_PLAN_FAILED_ALREADY_CLEANED_UP');
  db.close();
});

test('queue reconcile quiesces terminal FAILED residual state before retiring and handing off', async () => {
  const db = openDatabase(':memory:', { environment: 'test' });
  const repositories = createRepositories(db);
  const calls: string[] = [];
  const runtime = new ProjectPlanQueueRuntime(repositories, {
    activate: async (planId) => calls.push('activate:' + planId),
    retire: async (planId) => {
      calls.push('retire:' + planId);
      assert.equal(repositories.plans.getPlan(planId).status, 'FAILED');
    },
  });
  createRoot(repositories, 'plan-failed-reconcile');
  createRoot(repositories, 'plan-after-failed-reconcile');
  const graph = repositories.plans.createGraphVersion({
    planId: 'plan-failed-reconcile',
    reason: 'terminal failed reconcile fixture',
  }).value!;
  const item = repositories.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId,
    itemKey: 'failed-reconcile-item',
    title: 'Failed reconcile item',
    objective: 'prove autonomous terminal cleanup before handoff',
    acceptanceCriteria: ['next root activates only after residual state is quiescent'],
    dependencies: [],
  }).value!;
  runtime.scheduleRootPlan('plan-failed-reconcile');
  runtime.scheduleRootPlan('plan-after-failed-reconcile');
  repositories.plans.updateStatus('plan-failed-reconcile', 'RUNNING');
  repositories.plans.updateWorkItemStatus(item.workItemId, 'RUNNING');
  const execution = repositories.executions.create({
    idempotencyKey: 'terminal-failed-reconcile-execution',
    identity: {
      executionId: 'terminal-failed-reconcile-execution',
      planId: 'plan-failed-reconcile',
      workItemId: item.workItemId,
      phase: 'IMPLEMENT',
      attempt: 1,
      route: 'implementation',
      sourceRevision: 'base-sha',
    },
    objective: 'leave residual failed execution state',
  }).value!;
  repositories.executions.updateStatus(execution.identity.executionId, 'RUNNING');
  repositories.executions.recordResult(execution.identity.executionId, {
    status: 'FAILED',
    errorCode: 'WORKTREE_GIT_LINKAGE_VIOLATED',
    retryable: false,
  });
  repositories.plans.updateStatus('plan-failed-reconcile', 'FAILED');
  runtime.setExecutionCancellation({
    cancelExecution: async (executionId) => {
      calls.push('cancel:' + executionId);
      repositories.executions.updateStatus(executionId, 'CANCELLED');
      return { status: 'SUCCEEDED', code: 'EXECUTION_OPERATOR_CANCELLED' };
    },
  });

  const result = await runtime.reconcile();

  assert.equal(result[0]?.code, 'PROJECT_PLAN_FAILED_CLEANED_UP_HANDOFF');
  assert.equal(result[0]?.releasedPlanId, 'plan-failed-reconcile');
  assert.equal(result[0]?.activatedPlanId, 'plan-after-failed-reconcile');
  assert.deepEqual(calls, [
    'cancel:terminal-failed-reconcile-execution',
    'retire:plan-failed-reconcile',
    'activate:plan-after-failed-reconcile',
  ]);
  assert.equal(repositories.plans.getPlan('plan-failed-reconcile').status, 'FAILED');
  assert.equal(repositories.plans.getWorkItem(item.workItemId).status, 'CANCELLED');
  assert.equal(repositories.executions.get(execution.identity.executionId).status, 'CANCELLED');
  assert.equal(repositories.plans.getPlan('plan-after-failed-reconcile').status, 'READY');
  assert.equal(
    repositories.projectPlans.getLease('project-gamma')?.activeRootPlanId,
    'plan-after-failed-reconcile',
  );
  db.close();
});

test('operator cleanup does not reinterpret a SUCCEEDED terminal Plan as cancellation', async () => {
  const db = openDatabase(':memory:', { environment: 'test' });
  const repositories = createRepositories(db);
  const runtime = new ProjectPlanQueueRuntime(repositories, {
    retire: async () => undefined,
  });
  createRoot(repositories, 'plan-succeeded-cancel-refused');
  runtime.scheduleRootPlan('plan-succeeded-cancel-refused');
  finish(repositories, 'plan-succeeded-cancel-refused');

  await assert.rejects(
    () =>
      runtime.cancelActive(
        'plan-succeeded-cancel-refused',
        'operator-cancel-succeeded',
        'must not rewrite successful plan truth',
      ),
    (error: unknown) =>
      error instanceof ForgeFlowError && error.code === 'PROJECT_PLAN_CANCEL_TERMINAL',
  );
  assert.equal(repositories.plans.getPlan('plan-succeeded-cancel-refused').status, 'SUCCEEDED');
  assert.equal(
    repositories.projectPlans.getLease('project-gamma')?.activeRootPlanId,
    'plan-succeeded-cancel-refused',
  );
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

test('operator cancellation quiesces the active retry writer before historical failed attempts', async () => {
  const db = openDatabase(':memory:', { environment: 'test' });
  const repositories = createRepositories(db);
  const calls: string[] = [];
  const runtime = new ProjectPlanQueueRuntime(repositories, {
    retire: async () => undefined,
  });
  createRoot(repositories, 'plan-cancel-retry-order');
  const graph = repositories.plans.createGraphVersion({
    planId: 'plan-cancel-retry-order',
    reason: 'retry cancellation ordering fixture',
  }).value!;
  const item = repositories.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId,
    itemKey: 'retry-item',
    title: 'Retry item',
    objective: 'cancel the current writer before historical attempts',
    acceptanceCriteria: ['active retry is quiesced first'],
    dependencies: [],
  }).value!;
  runtime.scheduleRootPlan('plan-cancel-retry-order');
  repositories.plans.updateStatus('plan-cancel-retry-order', 'RUNNING');
  repositories.plans.updateWorkItemStatus(item.workItemId, 'RUNNING');
  const oldAttempt = repositories.executions.create({
    idempotencyKey: 'cancel-retry-old',
    identity: {
      executionId: 'cancel-retry-old',
      planId: 'plan-cancel-retry-order',
      workItemId: item.workItemId,
      phase: 'IMPLEMENT',
      attempt: 1,
      route: 'implementation-a',
      sourceRevision: 'base-sha',
    },
    objective: 'historical failed attempt',
  }).value!;
  repositories.executions.updateStatus(oldAttempt.identity.executionId, 'RUNNING');
  repositories.executions.recordResult(oldAttempt.identity.executionId, {
    status: 'FAILED',
    errorCode: 'WORKSPACE_IMPLEMENTATION_NOOP',
    retryable: true,
  });
  const retry = repositories.executions.create({
    idempotencyKey: 'cancel-retry-current',
    identity: {
      executionId: 'cancel-retry-current',
      planId: 'plan-cancel-retry-order',
      workItemId: item.workItemId,
      phase: 'IMPLEMENT',
      attempt: 2,
      route: 'implementation-b',
      sourceRevision: 'base-sha',
    },
    objective: 'current retry writer',
  }).value!;
  repositories.executions.updateStatus(retry.identity.executionId, 'RUNNING');
  runtime.setExecutionCancellation({
    cancelExecution: async (executionId) => {
      calls.push(executionId);
      repositories.executions.updateStatus(executionId, 'CANCELLED');
      return { status: 'SUCCEEDED', code: 'EXECUTION_OPERATOR_CANCELLED' };
    },
  });

  const result = await runtime.cancelActive(
    'plan-cancel-retry-order',
    'operator-cancel-retry-order',
    'cancel current retry before historical cleanup',
  );

  assert.equal(result.code, 'PROJECT_PLAN_CANCELLED');
  assert.deepEqual(calls, [retry.identity.executionId, oldAttempt.identity.executionId]);
  assert.equal(repositories.plans.getPlan('plan-cancel-retry-order').status, 'CANCELLED');
  assert.equal(repositories.projectPlans.getLease('project-gamma')?.activeRootPlanId, undefined);
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

test('operator root cancellation requires child cancellation, and child cancellation preserves the root lease', async () => {
  const db = openDatabase(':memory:', { environment: 'test' });
  const repositories = createRepositories(db);
  const runtime = new ProjectPlanQueueRuntime(repositories);
  createRoot(repositories, 'plan-cancel-parent');
  runtime.scheduleRootPlan('plan-cancel-parent');
  const child = repositories.plans.createChildPlan({
    parentPlanId: 'plan-cancel-parent',
    childPlanId: 'plan-cancel-child',
    repositoryPath: '/home/dev/projects/project-gamma',
    objective: 'active child',
    relation: 'FOLLOW_UP',
  }).plan;
  const graph = repositories.plans.createGraphVersion({
    planId: child.planId,
    reason: 'child cancel graph',
  }).value!;
  const item = repositories.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId,
    itemKey: 'child-item',
    title: 'Child item',
    objective: 'cancel child safely',
    acceptanceCriteria: ['root lease stays held'],
    dependencies: [],
  }).value!;
  repositories.plans.updateStatus(child.planId, 'READY');
  const childSupervisor = repositories.supervisors.create({ planId: child.planId }).value!;
  repositories.supervisors.updateStatus(childSupervisor.supervisorId, 'ACTIVE');

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

  const childCancelled = await runtime.cancelPlan(
    child.planId,
    'operator-cancel-child',
    'cancel child before root',
  );
  assert.equal(childCancelled.code, 'CHILD_PLAN_CANCELLED');
  assert.equal(childCancelled.rootPlanId, 'plan-cancel-parent');
  assert.deepEqual(childCancelled.cancelledWorkItemIds, [item.workItemId]);
  assert.equal(repositories.plans.getPlan(child.planId).status, 'CANCELLED');
  assert.equal(repositories.plans.getWorkItem(item.workItemId).status, 'CANCELLED');
  assert.equal(repositories.supervisors.getByPlanId(child.planId)?.status, 'CANCELLED');
  assert.equal(
    repositories.projectPlans.getLease('project-gamma')?.activeRootPlanId,
    'plan-cancel-parent',
  );
  const repeatedChild = await runtime.cancelPlan(
    child.planId,
    'operator-cancel-child',
    'cancel child before root',
  );
  assert.equal(repeatedChild.code, 'CHILD_PLAN_ALREADY_CANCELLED');

  const rootCancelled = await runtime.cancelActive(
    'plan-cancel-parent',
    'operator-cancel-parent',
    'child is now terminal',
  );
  assert.equal(rootCancelled.code, 'PROJECT_PLAN_CANCELLED');
  assert.equal(repositories.plans.getPlan('plan-cancel-parent').status, 'CANCELLED');
  assert.equal(
    repositories.projectPlans.getLease('project-gamma')?.activeRootPlanId,
    undefined,
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


test('Plan cancellation retries workspace cleanup for an already-CANCELLED execution before releasing the lease', async () => {
  const db = openDatabase(':memory:', { environment: 'test' });
  const repositories = createRepositories(db);
  const runtime = new ProjectPlanQueueRuntime(repositories);
  let cancellationCalls = 0;
  runtime.setExecutionCancellation({
    cancelExecution: async (executionId) => {
      cancellationCalls += 1;
      if (cancellationCalls === 1) {
        repositories.executions.updateStatus(executionId, 'CANCELLED');
        return { status: 'FAILED', code: 'WORKTREE_CANCEL_CLEANUP_FAILED' };
      }
      return { status: 'SUCCEEDED', code: 'EXECUTION_ALREADY_CANCELLED' };
    },
  });
  createRoot(repositories, 'plan-cancel-writer-retry');
  const graph = repositories.plans.createGraphVersion({
    planId: 'plan-cancel-writer-retry',
    reason: 'writer cleanup retry graph',
  }).value!;
  const item = repositories.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId,
    itemKey: 'writer-retry',
    title: 'Writer retry',
    objective: 'retry cancelled workspace cleanup',
    acceptanceCriteria: ['lease remains held until cleanup succeeds'],
    dependencies: [],
  }).value!;
  runtime.scheduleRootPlan('plan-cancel-writer-retry');
  const execution = repositories.executions.create({
    idempotencyKey: 'writer-cleanup-execution',
    identity: {
      executionId: 'writer-cleanup-execution',
      planId: 'plan-cancel-writer-retry',
      workItemId: item.workItemId,
      phase: 'IMPLEMENT',
      attempt: 1,
      route: 'implementation',
      sourceRevision: 'base-sha',
    },
    objective: 'writer cleanup retry',
  }).value!;

  await assert.rejects(
    runtime.cancelActive(
      'plan-cancel-writer-retry',
      'writer-cleanup-plan-cancel',
      'cancel with retryable workspace cleanup',
    ),
    (error: unknown) =>
      error instanceof ForgeFlowError && error.code === 'WORKTREE_CANCEL_CLEANUP_FAILED',
  );
  assert.equal(repositories.executions.get(execution.identity.executionId).status, 'CANCELLED');
  assert.equal(repositories.plans.getPlan('plan-cancel-writer-retry').status, 'SAFETY_HOLD');
  assert.equal(
    repositories.projectPlans.getLease('project-gamma')?.activeRootPlanId,
    'plan-cancel-writer-retry',
  );

  const recovered = await runtime.cancelActive(
    'plan-cancel-writer-retry',
    'writer-cleanup-plan-cancel',
    'cancel with retryable workspace cleanup',
  );
  assert.equal(cancellationCalls, 2);
  assert.equal(recovered.code, 'PROJECT_PLAN_CANCELLED');
  assert.deepEqual(recovered.cancelledExecutionIds, [execution.identity.executionId]);
  assert.equal(repositories.plans.getPlan('plan-cancel-writer-retry').status, 'CANCELLED');
  assert.equal(
    repositories.projectPlans.getLease('project-gamma')?.activeRootPlanId,
    undefined,
  );
  db.close();
});

test('child Plan cancellation closes non-passed Review state without releasing the root lease', async () => {
  const db = openDatabase(':memory:', { environment: 'test' });
  const repositories = createRepositories(db);
  const runtime = new ProjectPlanQueueRuntime(repositories);
  createRoot(repositories, 'plan-review-parent');
  runtime.scheduleRootPlan('plan-review-parent');
  const child = repositories.plans.createChildPlan({
    parentPlanId: 'plan-review-parent',
    childPlanId: 'plan-review-child',
    repositoryPath: '/home/dev/projects/project-gamma',
    objective: 'child with pending review',
    relation: 'FOLLOW_UP',
  }).plan;
  const graph = repositories.plans.createGraphVersion({
    planId: child.planId,
    reason: 'child review cancel graph',
  }).value!;
  const item = repositories.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId,
    itemKey: 'review-item',
    title: 'Review item',
    objective: 'cancel pending review',
    acceptanceCriteria: ['review becomes cancelled'],
    dependencies: [],
  }).value!;
  repositories.plans.updateStatus(child.planId, 'READY');
  repositories.plans.updateWorkItemStatus(item.workItemId, 'RUNNING');
  const implementation = repositories.executions.create({
    idempotencyKey: 'child-review-implementation',
    identity: {
      executionId: 'child-review-implementation',
      planId: child.planId,
      workItemId: item.workItemId,
      phase: 'IMPLEMENT',
      attempt: 1,
      route: 'implementation',
      sourceRevision: child.currentRevision,
    },
    objective: 'produce review candidate',
  }).value!;
  repositories.executions.updateStatus(implementation.identity.executionId, 'RUNNING');
  repositories.executions.recordResult(implementation.identity.executionId, {
    status: 'SUCCEEDED',
    resultRevision: 'child-reviewed-sha',
    resultSummary: 'implementation complete',
  });
  const review = repositories.reviews.create({
    idempotencyKey: 'child-review-pending',
    planId: child.planId,
    workItemId: item.workItemId,
    implementationExecutionId: implementation.identity.executionId,
    sourceRevision: 'child-reviewed-sha',
  }).value!;
  repositories.reviews.updateStatus(review.reviewId, 'RUNNING');

  const result = await runtime.cancelPlan(
    child.planId,
    'cancel-child-review',
    'operator cancels child while review is pending',
  );
  assert.equal(result.code, 'CHILD_PLAN_CANCELLED');
  assert.deepEqual(result.cancelledReviewIds, [review.reviewId]);
  assert.equal(repositories.reviews.getById(review.reviewId).status, 'CANCELLED');
  assert.equal(repositories.executions.get(implementation.identity.executionId).status, 'SUCCEEDED');
  assert.equal(repositories.plans.getWorkItem(item.workItemId).status, 'CANCELLED');
  assert.equal(
    repositories.projectPlans.getLease('project-gamma')?.activeRootPlanId,
    'plan-review-parent',
  );
  db.close();
});

test('operator cancellation can retire a crash-recovered DRAFT child without releasing the root lease', async () => {
  const db = openDatabase(':memory:', { environment: 'test' });
  const repositories = createRepositories(db);
  const runtime = new ProjectPlanQueueRuntime(repositories);
  createRoot(repositories, 'plan-draft-child-parent');
  runtime.scheduleRootPlan('plan-draft-child-parent');
  const child = repositories.plans.createChildPlan({
    parentPlanId: 'plan-draft-child-parent',
    childPlanId: 'plan-crash-recovered-draft-child',
    repositoryPath: '/home/dev/projects/project-gamma',
    objective: 'simulate a crash between child creation and graph activation',
    relation: 'FOLLOW_UP',
  }).plan;
  assert.equal(child.status, 'DRAFT');
  assert.equal(repositories.supervisors.getByPlanId(child.planId), undefined);
  assert.equal(repositories.plans.listWorkItems(child.planId).length, 0);

  const result = await runtime.cancelPlan(
    child.planId,
    'cancel-crash-recovered-draft-child',
    'operator retires a partially-created child after restart',
  );
  assert.equal(result.code, 'CHILD_PLAN_CANCELLED');
  assert.equal(result.rootPlanId, 'plan-draft-child-parent');
  assert.deepEqual(result.cancelledExecutionIds, []);
  assert.deepEqual(result.cancelledReviewIds, []);
  assert.deepEqual(result.cancelledWorkItemIds, []);
  assert.equal(repositories.plans.getPlan(child.planId).status, 'CANCELLED');
  assert.equal(
    repositories.projectPlans.getLease('project-gamma')?.activeRootPlanId,
    'plan-draft-child-parent',
  );
  const events = repositories.events.listByAggregate(child.planId);
  assert.ok(
    events.some(
      (event) =>
        event.type === 'PROJECT_PLAN_CANCEL_REQUESTED' &&
        (event.payload as Record<string, unknown>).scope === 'CHILD',
    ),
  );
  db.close();
});

test('pre-active Plan can remain durably fenced in SAFETY_HOLD when cancellation cleanup fails', async () => {
  const db = openDatabase(':memory:', { environment: 'test' });
  const repositories = createRepositories(db);
  const runtime = new ProjectPlanQueueRuntime(repositories);
  runtime.setExecutionCancellation({
    cancelExecution: async () => ({
      status: 'WAITING',
      code: 'PROVIDER_CANCEL_NOT_QUIESCED',
    }),
  });
  createRoot(repositories, 'plan-preactive-parent');
  runtime.scheduleRootPlan('plan-preactive-parent');
  const child = repositories.plans.createChildPlan({
    parentPlanId: 'plan-preactive-parent',
    childPlanId: 'plan-preactive-child',
    repositoryPath: '/home/dev/projects/project-gamma',
    objective: 'exercise durable pre-active cancellation fencing',
    relation: 'FOLLOW_UP',
  }).plan;
  const graph = repositories.plans.createGraphVersion({
    planId: child.planId,
    reason: 'partial child graph before crash',
  }).value!;
  const item = repositories.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId,
    itemKey: 'partial-child-item',
    title: 'Partial child item',
    objective: 'remain fenced while cancellation cannot quiesce execution',
    acceptanceCriteria: ['status remains SAFETY_HOLD'],
    dependencies: [],
  }).value!;
  repositories.executions.create({
    idempotencyKey: 'partial-child-execution',
    identity: {
      executionId: 'partial-child-execution',
      planId: child.planId,
      workItemId: item.workItemId,
      phase: 'IMPLEMENT',
      attempt: 1,
      route: 'implementation',
      sourceRevision: child.currentRevision,
    },
    objective: 'partial execution fixture',
  });

  await assert.rejects(
    runtime.cancelPlan(
      child.planId,
      'cancel-preactive-child',
      'cancellation must fence before cleanup',
    ),
    (error: unknown) =>
      error instanceof ForgeFlowError && error.code === 'PROVIDER_CANCEL_NOT_QUIESCED',
  );
  assert.equal(repositories.plans.getPlan(child.planId).status, 'SAFETY_HOLD');
  assert.equal(
    repositories.projectPlans.getLease('project-gamma')?.activeRootPlanId,
    'plan-preactive-parent',
  );
  db.close();
});
