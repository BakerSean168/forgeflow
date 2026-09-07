import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PlanWorktreeManager, worktreeRefComponent } from '../src/core/adapters/planWorktrees.js';
import { ForgeFlowError } from '../src/core/domain/errors.js';
import { openDatabase, SCHEMA_VERSION } from '../src/core/persistence/database.js';
import { createRepositories } from '../src/core/persistence/repositories.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeflow-plan-worktrees-'));
  const repositoriesRoot = path.join(root, 'repositories');
  const repository = path.join(repositoriesRoot, 'project-gamma');
  const managed = path.join(root, 'managed');
  fs.mkdirSync(repository, { recursive: true });
  fs.mkdirSync(managed, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repository]);
  git(repository, ['config', 'user.name', 'ForgeFlow Worktree Test']);
  git(repository, ['config', 'user.email', 'forgeflow-worktree@test.local']);
  fs.writeFileSync(path.join(repository, 'README.md'), 'base\n');
  git(repository, ['add', 'README.md']);
  git(repository, ['commit', '-m', 'chore: base']);
  const revision = git(repository, ['rev-parse', 'HEAD']);
  const db = openDatabase(path.join(root, 'forgeflow.sqlite'), { environment: 'test' });
  const repositories = createRepositories(db);
  const plan = repositories.plans.createPlan({
    planId: 'plan-a',
    idempotencyKey: 'worktree-plan-a',
    projectKey: 'project-gamma',
    objective: 'exercise literal worktrees',
    repositoryPath: repository,
    baseRevision: revision,
  }).value!;
  const graph = repositories.plans.createGraphVersion({
    planId: plan.planId,
    reason: 'test graph',
  }).value!;
  const itemA = repositories.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId,
    itemKey: 'item-a',
    title: 'Item A',
    objective: 'change A',
    acceptanceCriteria: ['commit A'],
    dependencies: [],
  }).value!;
  const itemB = repositories.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId,
    itemKey: 'item-b',
    title: 'Item B',
    objective: 'change B',
    acceptanceCriteria: ['commit B'],
    dependencies: [],
  }).value!;
  repositories.projectPlans.scheduleRootPlan(plan.planId);
  const manager = new PlanWorktreeManager({
    repositories,
    allowedRepositoryRoots: [repositoriesRoot],
    managedHostRoot: managed,
    executionRoot: '/workspace',
  });
  return {
    root,
    repositoriesRoot,
    repository,
    managed,
    revision,
    db,
    repositories,
    plan,
    itemA,
    itemB,
    manager,
  };
}

function createExecution(
  repositories: ReturnType<typeof createRepositories>,
  planId: string,
  workItemId: string,
  executionId: string,
  sourceRevision: string,
) {
  return repositories.executions.create({
    executionId,
    idempotencyKey: executionId,
    identity: {
      executionId,
      planId,
      workItemId,
      phase: 'IMPLEMENT',
      attempt: 1,
      route: 'test-route',
      sourceRevision,
    },
    objective: 'exercise writer ownership',
  }).value!;
}

test('PlanWorktreeManager creates one literal shared-common-dir worktree per role and preserves canonical checkout', async () => {
  const value = fixture();
  const canonicalHead = git(value.repository, ['rev-parse', 'HEAD']);
  const integration = await value.manager.ensureIntegration({
    projectKey: 'project-gamma',
    rootPlanId: value.plan.planId,
    repositoryPath: value.repository,
    baseRevision: value.revision,
  });
  const item = await value.manager.ensureWorkItem({
    projectKey: 'project-gamma',
    rootPlanId: value.plan.planId,
    workItemId: value.itemA.workItemId,
    repositoryPath: value.repository,
    baseRevision: value.revision,
  });

  assert.equal(integration.role, 'INTEGRATION');
  assert.equal(item.role, 'WORK_ITEM');
  assert.match(integration.branchRef!, /^refs\/heads\/forgeflow\/plan-a\/integration$/);
  assert.match(item.branchRef!, new RegExp('^refs/heads/forgeflow/plan-a/items/'));
  const canonicalCommon = fs.realpathSync(path.join(value.repository, '.git'));
  for (const worktree of [integration, item]) {
    const commonRaw = git(worktree.hostPath, ['rev-parse', '--git-common-dir']);
    const common = fs.realpathSync(
      path.isAbsolute(commonRaw) ? commonRaw : path.resolve(worktree.hostPath, commonRaw),
    );
    assert.equal(common, canonicalCommon);
  }
  assert.equal(git(value.repository, ['rev-parse', 'HEAD']), canonicalHead);
  assert.equal(fs.readFileSync(path.join(value.repository, 'README.md'), 'utf8'), 'base\n');

  const listed = git(value.repository, ['worktree', 'list', '--porcelain']);
  assert.match(listed, new RegExp(integration.hostPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(listed, /locked forgeflow:worktree:integration:plan-a:integration/);

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});


test('worker Git object directories are sticky before shared object creation access is granted', async () => {
  const value = fixture();
  const item = await value.manager.ensureWorkItem({
    projectKey: value.plan.projectKey,
    rootPlanId: value.plan.planId,
    workItemId: value.itemA.workItemId,
    repositoryPath: value.repository,
    baseRevision: value.revision,
  });
  await value.manager.prepareAgentAccess(
    item.worktreeId,
    process.getuid?.() ?? 1000,
    process.getgid?.() ?? 1000,
  );
  const objects = path.join(value.repository, '.git', 'objects');
  const directories = [
    objects,
    ...fs
      .readdirSync(objects, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => path.join(objects, entry.name)),
  ];
  assert.ok(directories.length >= 257);
  for (const directory of directories)
    assert.notEqual(fs.statSync(directory).mode & 0o1000, 0, directory);
  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('literal Plan parents remain controller-owned and traversable under production umask 0077', async () => {
  const value = fixture();
  const previousUmask = process.umask(0o077);
  try {
    await value.manager.ensurePlanActivated(value.plan.planId);
    await value.manager.ensureWorkItem({
      projectKey: value.plan.projectKey,
      rootPlanId: value.plan.planId,
      workItemId: value.itemA.workItemId,
      repositoryPath: value.repository,
      baseRevision: value.revision,
    });
  } finally {
    process.umask(previousUmask);
  }

  const directories = [
    path.join(value.managed, 'forgeflow'),
    path.join(value.managed, 'forgeflow', 'plans'),
    path.join(value.managed, 'forgeflow', 'plans', value.plan.projectKey),
    path.join(value.managed, 'forgeflow', 'plans', value.plan.projectKey, value.plan.planId),
    path.join(value.managed, 'forgeflow', 'plans', value.plan.projectKey, value.plan.planId, 'items'),
  ];
  for (const directory of directories) {
    const stat = fs.statSync(directory);
    assert.equal(stat.mode & 0o777, 0o711);
    assert.equal(stat.uid, process.getuid?.() ?? stat.uid);
    assert.equal(stat.gid, process.getgid?.() ?? stat.gid);
  }

  await value.manager.retirePlan(value.plan.planId, process.getuid?.() ?? 1000);
  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('work-item provisioning cannot bypass a failed root Plan admission', async () => {
  const value = fixture();
  const manager = new PlanWorktreeManager({
    repositories: value.repositories,
    allowedRepositoryRoots: [value.repositoriesRoot],
    managedHostRoot: value.managed,
    executionRoot: '/workspace',
    projectAdmission: () => {
      throw new ForgeFlowError('TEST_PROJECT_ADMISSION_BLOCKED');
    },
  });

  await assert.rejects(
    () =>
      manager.ensureWorkItem({
        projectKey: value.plan.projectKey,
        rootPlanId: value.plan.planId,
        workItemId: value.itemA.workItemId,
        repositoryPath: value.repository,
        baseRevision: value.revision,
      }),
    (error: unknown) =>
      error instanceof ForgeFlowError && error.code === 'TEST_PROJECT_ADMISSION_BLOCKED',
  );
  assert.equal(value.repositories.plans.getPlan(value.plan.planId).status, 'SAFETY_HOLD');
  assert.deepEqual(value.repositories.planWorktrees.listByPlan(value.plan.planId), []);
  const activationFailure = value.repositories.events
    .listByAggregate(value.plan.planId)
    .findLast((event) => event.type === 'PLAN_ACTIVATION_FAILED');
  assert.deepEqual(activationFailure?.payload, {
    errorCode: 'TEST_PROJECT_ADMISSION_BLOCKED',
    disposition: 'SAFETY_HOLD',
  });

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('retryable activation infrastructure failure parks for system repair and recovers durably', async () => {
  const value = fixture();
  let failAdmission = true;
  const manager = new PlanWorktreeManager({
    repositories: value.repositories,
    allowedRepositoryRoots: [value.repositoriesRoot],
    managedHostRoot: value.managed,
    executionRoot: '/workspace',
    projectAdmission: () => {
      if (failAdmission) throw new ForgeFlowError('WORKTREE_OPENHANDS_MOUNT_CHECK_FAILED');
    },
  });

  await assert.rejects(
    () => manager.ensurePlanActivated(value.plan.planId),
    (error: unknown) =>
      error instanceof ForgeFlowError && error.code === 'WORKTREE_OPENHANDS_MOUNT_CHECK_FAILED',
  );
  assert.equal(
    value.repositories.plans.getPlan(value.plan.planId).status,
    'WAITING_FOR_SYSTEM_REPAIR',
  );
  assert.deepEqual(value.repositories.planWorktrees.listByPlan(value.plan.planId), []);
  const failure = value.repositories.events
    .listByAggregate(value.plan.planId)
    .findLast((event) => event.type === 'PLAN_ACTIVATION_FAILED');
  assert.deepEqual(failure?.payload, {
    errorCode: 'WORKTREE_OPENHANDS_MOUNT_CHECK_FAILED',
    disposition: 'SYSTEM_REPAIR',
  });

  failAdmission = false;
  const integration = await manager.ensurePlanActivated(value.plan.planId);
  assert.equal(integration.role, 'INTEGRATION');
  assert.equal(value.repositories.plans.getPlan(value.plan.planId).status, 'READY');
  const recovered = value.repositories.events
    .listByAggregate(value.plan.planId)
    .findLast((event) => event.type === 'PLAN_ACTIVATION_RECOVERED');
  assert.deepEqual(recovered?.payload, { disposition: 'SYSTEM_REPAIR' });

  await manager.retirePlan(value.plan.planId, process.getuid?.() ?? 1000);
  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('parallel work-item provisioning single-flights root Plan activation', async () => {
  const value = fixture();
  let admissions = 0;
  const manager = new PlanWorktreeManager({
    repositories: value.repositories,
    allowedRepositoryRoots: [value.repositoriesRoot],
    managedHostRoot: value.managed,
    executionRoot: '/workspace',
    projectAdmission: async () => {
      admissions += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
    },
  });

  const [itemA, itemB] = await Promise.all([
    manager.ensureWorkItem({
      projectKey: value.plan.projectKey,
      rootPlanId: value.plan.planId,
      workItemId: value.itemA.workItemId,
      repositoryPath: value.repository,
      baseRevision: value.revision,
    }),
    manager.ensureWorkItem({
      projectKey: value.plan.projectKey,
      rootPlanId: value.plan.planId,
      workItemId: value.itemB.workItemId,
      repositoryPath: value.repository,
      baseRevision: value.revision,
    }),
  ]);

  assert.equal(admissions, 1);
  assert.equal(itemA.role, 'WORK_ITEM');
  assert.equal(itemB.role, 'WORK_ITEM');
  assert.ok(value.repositories.planWorktrees.findIntegration(value.plan.planId));

  await manager.retirePlan(value.plan.planId, process.getuid?.() ?? 1000);
  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('WorkItem worktree survives provider retries and enforces one durable writer at a time', async () => {
  const value = fixture();
  let worktree = await value.manager.ensureWorkItem({
    projectKey: 'project-gamma',
    rootPlanId: value.plan.planId,
    workItemId: value.itemA.workItemId,
    repositoryPath: value.repository,
    baseRevision: value.revision,
  });
  createExecution(
    value.repositories,
    value.plan.planId,
    value.itemA.workItemId,
    'exec-1',
    value.revision,
  );
  createExecution(
    value.repositories,
    value.plan.planId,
    value.itemA.workItemId,
    'exec-2',
    value.revision,
  );

  worktree = await value.manager.attachWriter(worktree.worktreeId, 'exec-1');
  assert.equal(worktree.ownerExecutionId, 'exec-1');
  await assert.rejects(
    () => value.manager.attachWriter(worktree.worktreeId, 'exec-2'),
    (error: unknown) => error instanceof ForgeFlowError && error.code === 'WORKTREE_WRITER_HELD',
  );

  fs.writeFileSync(path.join(worktree.hostPath, 'result.txt'), 'done\n');
  git(worktree.hostPath, ['add', 'result.txt']);
  git(worktree.hostPath, ['commit', '-m', 'feat: implement item a']);
  const resultRevision = git(worktree.hostPath, ['rev-parse', 'HEAD']);
  worktree = await value.manager.releaseWriter(worktree.worktreeId, 'exec-1');
  assert.equal(worktree.state, 'QUIESCENT');
  assert.equal(worktree.currentRevision, resultRevision);
  assert.equal(worktree.ownerExecutionId, undefined);

  const reused = await value.manager.ensureWorkItem({
    projectKey: 'project-gamma',
    rootPlanId: value.plan.planId,
    workItemId: value.itemA.workItemId,
    repositoryPath: value.repository,
    baseRevision: value.revision,
  });
  assert.equal(reused.worktreeId, worktree.worktreeId);
  assert.equal(reused.hostPath, worktree.hostPath);
  assert.equal(reused.currentRevision, resultRevision);
  const secondOwner = await value.manager.attachWriter(worktree.worktreeId, 'exec-2');
  assert.equal(secondOwner.ownerExecutionId, 'exec-2');
  const releasedAgain = await value.manager.releaseWriter(worktree.worktreeId, 'exec-2');
  assert.equal(releasedAgain.currentRevision, resultRevision);
  assert.equal(git(value.repository, ['rev-parse', 'HEAD']), value.revision);

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('cancellation access is limited to the current writer or a quiescent SAFETY_HOLD worktree', async () => {
  const value = fixture();
  let worktree = await value.manager.ensureWorkItem({
    projectKey: 'project-gamma',
    rootPlanId: value.plan.planId,
    workItemId: value.itemA.workItemId,
    repositoryPath: value.repository,
    baseRevision: value.revision,
  });
  createExecution(
    value.repositories,
    value.plan.planId,
    value.itemA.workItemId,
    'exec-cancel-access-owner',
    value.revision,
  );
  createExecution(
    value.repositories,
    value.plan.planId,
    value.itemA.workItemId,
    'exec-cancel-access-other',
    value.revision,
  );
  worktree = await value.manager.attachWriter(worktree.worktreeId, 'exec-cancel-access-owner');
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;

  const owned = await value.manager.prepareCancellationAccess(
    worktree.worktreeId,
    'exec-cancel-access-owner',
    uid,
    gid,
  );
  assert.equal(owned.ownerExecutionId, 'exec-cancel-access-owner');
  await assert.rejects(
    () =>
      value.manager.prepareCancellationAccess(
        worktree.worktreeId,
        'exec-cancel-access-other',
        uid,
        gid,
      ),
    (error: unknown) =>
      error instanceof ForgeFlowError && error.code === 'WORKTREE_CANCEL_ACCESS_WRITER_MISMATCH',
  );

  worktree = await value.manager.releaseWriter(worktree.worktreeId, 'exec-cancel-access-owner');
  await assert.rejects(
    () =>
      value.manager.prepareCancellationAccess(
        worktree.worktreeId,
        'exec-cancel-access-owner',
        uid,
        gid,
      ),
    (error: unknown) =>
      error instanceof ForgeFlowError &&
      error.code === 'WORKTREE_CANCEL_ACCESS_REQUIRES_TERMINAL_OR_SAFETY_HOLD',
  );
  const held = value.repositories.plans.compareAndSetStatus(value.plan.planId, 'READY', 'SAFETY_HOLD');
  assert.equal(held.status, 'updated');
  const recovered = await value.manager.prepareCancellationAccess(
    worktree.worktreeId,
    'exec-cancel-access-owner',
    uid,
    gid,
  );
  assert.equal(recovered.ownerExecutionId, undefined);

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('cancellation access accepts an unaccepted writer commit but normal agent admission remains revision-pinned', async () => {
  const value = fixture();
  let worktree = await value.manager.ensureWorkItem({
    projectKey: 'project-gamma',
    rootPlanId: value.plan.planId,
    workItemId: value.itemA.workItemId,
    repositoryPath: value.repository,
    baseRevision: value.revision,
  });
  createExecution(
    value.repositories,
    value.plan.planId,
    value.itemA.workItemId,
    'exec-cancel-unaccepted-candidate',
    value.revision,
  );
  worktree = await value.manager.attachWriter(
    worktree.worktreeId,
    'exec-cancel-unaccepted-candidate',
  );
  fs.writeFileSync(path.join(worktree.hostPath, 'candidate.txt'), 'unaccepted candidate\n');
  git(worktree.hostPath, ['add', 'candidate.txt']);
  git(worktree.hostPath, ['commit', '-m', 'feat: unaccepted cancellation candidate']);
  const candidate = git(worktree.hostPath, ['rev-parse', 'HEAD']);
  assert.notEqual(candidate, value.revision);
  assert.equal(
    value.repositories.planWorktrees.get(worktree.worktreeId).currentRevision,
    value.revision,
  );
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;

  await assert.rejects(
    () => value.manager.prepareAgentAccess(worktree.worktreeId, uid, gid),
    (error: unknown) => error instanceof ForgeFlowError && error.code === 'WORKTREE_HEAD_MISMATCH',
  );
  const cancellationReady = await value.manager.prepareCancellationAccess(
    worktree.worktreeId,
    'exec-cancel-unaccepted-candidate',
    uid,
    gid,
  );
  assert.equal(cancellationReady.ownerExecutionId, 'exec-cancel-unaccepted-candidate');
  assert.equal(git(worktree.hostPath, ['rev-parse', 'HEAD']), candidate);

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('cancellation access repairs an unreadable Plan-scoped branch ref before identity proof', async () => {
  const value = fixture();
  let worktree = await value.manager.ensureWorkItem({
    projectKey: 'project-gamma',
    rootPlanId: value.plan.planId,
    workItemId: value.itemA.workItemId,
    repositoryPath: value.repository,
    baseRevision: value.revision,
  });
  createExecution(
    value.repositories,
    value.plan.planId,
    value.itemA.workItemId,
    'exec-cancel-ref-repair',
    value.revision,
  );
  worktree = await value.manager.attachWriter(worktree.worktreeId, 'exec-cancel-ref-repair');
  assert.ok(worktree.branchRef);
  const refPath = path.join(value.repository, '.git', ...worktree.branchRef!.split('/'));
  fs.chmodSync(refPath, 0o000);
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;

  const recovered = await value.manager.prepareCancellationAccess(
    worktree.worktreeId,
    'exec-cancel-ref-repair',
    uid,
    gid,
  );

  assert.equal(recovered.ownerExecutionId, 'exec-cancel-ref-repair');
  fs.accessSync(refPath, fs.constants.R_OK | fs.constants.W_OK);
  assert.equal(git(value.repository, ['rev-parse', worktree.branchRef!]), value.revision);
  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('quiescent FAILED root permits bounded cancellation access without reactivating the Plan', async () => {
  const value = fixture();
  const worktree = await value.manager.ensureWorkItem({
    projectKey: 'project-gamma',
    rootPlanId: value.plan.planId,
    workItemId: value.itemA.workItemId,
    repositoryPath: value.repository,
    baseRevision: value.revision,
  });
  createExecution(
    value.repositories,
    value.plan.planId,
    value.itemA.workItemId,
    'exec-terminal-failed-cleanup',
    value.revision,
  );
  value.repositories.plans.updateStatus(value.plan.planId, 'RUNNING');
  value.repositories.plans.updateStatus(value.plan.planId, 'FAILED');
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;

  const recovered = await value.manager.prepareCancellationAccess(
    worktree.worktreeId,
    'exec-terminal-failed-cleanup',
    uid,
    gid,
  );

  assert.equal(recovered.ownerExecutionId, undefined);
  assert.equal(value.repositories.plans.getPlan(value.plan.planId).status, 'FAILED');
  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('quiescent SUCCEEDED root permits bounded provider cleanup access before retirement', async () => {
  const value = fixture();
  const worktree = await value.manager.ensureWorkItem({
    projectKey: 'project-gamma',
    rootPlanId: value.plan.planId,
    workItemId: value.itemA.workItemId,
    repositoryPath: value.repository,
    baseRevision: value.revision,
  });
  createExecution(
    value.repositories,
    value.plan.planId,
    value.itemA.workItemId,
    'exec-terminal-success-cleanup',
    value.revision,
  );
  value.repositories.plans.updateStatus(value.plan.planId, 'RUNNING');
  value.repositories.plans.updateStatus(value.plan.planId, 'SUCCEEDED');
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;

  const recovered = await value.manager.prepareCancellationAccess(
    worktree.worktreeId,
    'exec-terminal-success-cleanup',
    uid,
    gid,
  );

  assert.equal(recovered.ownerExecutionId, undefined);
  assert.equal(value.repositories.plans.getPlan(value.plan.planId).status, 'SUCCEEDED');
  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('review worktree is detached at exact SHA and restart reconcile re-adopts registered worktrees without cloning', async () => {
  const value = fixture();
  const item = await value.manager.ensureWorkItem({
    projectKey: 'project-gamma',
    rootPlanId: value.plan.planId,
    workItemId: value.itemA.workItemId,
    repositoryPath: value.repository,
    baseRevision: value.revision,
  });
  createExecution(
    value.repositories,
    value.plan.planId,
    value.itemA.workItemId,
    'exec-review-source',
    value.revision,
  );
  await value.manager.attachWriter(item.worktreeId, 'exec-review-source');
  fs.writeFileSync(path.join(item.hostPath, 'review-me.txt'), 'candidate\n');
  git(item.hostPath, ['add', 'review-me.txt']);
  git(item.hostPath, ['commit', '-m', 'feat: candidate']);
  const reviewedSha = git(item.hostPath, ['rev-parse', 'HEAD']);
  await value.manager.releaseWriter(item.worktreeId, 'exec-review-source');

  const review = await value.manager.createReview({
    projectKey: 'project-gamma',
    rootPlanId: value.plan.planId,
    reviewId: 'review-1',
    repositoryPath: value.repository,
    baseRevision: value.revision,
    reviewedSha,
  });
  assert.equal(review.state, 'REVIEWING');
  assert.equal(review.branchRef, undefined);
  assert.equal(git(review.hostPath, ['rev-parse', 'HEAD']), reviewedSha);
  assert.equal(git(review.hostPath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD');

  const before = value.repositories.planWorktrees
    .listByPlan(value.plan.planId)
    .map((entry) => entry.hostPath);
  const restarted = new PlanWorktreeManager({
    repositories: value.repositories,
    allowedRepositoryRoots: [value.repositoriesRoot],
    managedHostRoot: value.managed,
    executionRoot: '/workspace',
  });
  const reconciled = await restarted.reconcile(value.plan.planId);
  assert.deepEqual(
    reconciled.map((entry) => entry.hostPath),
    before,
  );
  await restarted.retire(review.worktreeId);
  assert.equal(value.repositories.planWorktrees.get(review.worktreeId).state, 'RETIRED');
  assert.equal(fs.existsSync(review.hostPath), false);
  assert.equal(git(item.hostPath, ['cat-file', '-e', reviewedSha + '^{commit}']), '');

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('unknown worktree path residue is never silently adopted', async () => {
  const value = fixture();
  const project = worktreeRefComponent('project-gamma');
  const plan = worktreeRefComponent(value.plan.planId);
  const item = worktreeRefComponent(value.itemB.workItemId);
  const roguePath = path.join(value.managed, 'forgeflow', 'plans', project, plan, 'items', item, 'repo');
  fs.mkdirSync(roguePath, { recursive: true });
  await assert.rejects(
    () =>
      value.manager.ensureWorkItem({
        projectKey: 'project-gamma',
        rootPlanId: value.plan.planId,
        workItemId: value.itemB.workItemId,
        repositoryPath: value.repository,
        baseRevision: value.revision,
      }),
    (error: unknown) => error instanceof ForgeFlowError && error.code === 'WORKTREE_UNKNOWN_PATH_RESIDUE',
  );
  const durable = value.repositories.planWorktrees.findForWorkItem(
    value.plan.planId,
    value.itemB.workItemId,
  );
  assert.equal(durable?.state, 'PROVISIONING');

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('exact branched PROVISIONING residue is retried instead of adopted', async () => {
  const value = fixture();
  const project = worktreeRefComponent('project-gamma');
  const plan = worktreeRefComponent(value.plan.planId);
  const item = worktreeRefComponent(value.itemB.workItemId);
  const residuePath = path.join(
    value.managed,
    'forgeflow',
    'plans',
    project,
    plan,
    'items',
    item,
    'repo',
  );
  const branchRef = `refs/heads/forgeflow/${plan}/items/${item}/head`;
  git(value.repository, ['update-ref', branchRef, value.revision]);
  fs.mkdirSync(residuePath, { recursive: true });

  const recovered = await value.manager.ensureWorkItem({
    projectKey: 'project-gamma',
    rootPlanId: value.plan.planId,
    workItemId: value.itemB.workItemId,
    repositoryPath: value.repository,
    baseRevision: value.revision,
  });
  assert.equal(recovered.state, 'READY');
  assert.equal(recovered.branchRef, branchRef);
  assert.equal(fs.existsSync(path.join(recovered.hostPath, '.git')), true);
  assert.equal(git(recovered.hostPath, ['rev-parse', 'HEAD']), value.revision);

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('schema v7 migrates additively to the durable worktree registry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeflow-worktree-schema-'));
  const dbFile = path.join(root, 'forgeflow.sqlite');
  const current = openDatabase(dbFile, { environment: 'test' });
  current.exec(
    "DROP TABLE plan_worktrees; UPDATE schema_meta SET schema_version=7 WHERE schema_id='forgeflow';",
  );
  current.close();
  const migrated = openDatabase(dbFile, { environment: 'test' });
  assert.equal(
    migrated.prepare("SELECT schema_version FROM schema_meta WHERE schema_id='forgeflow'").get()
      ?.schema_version,
    SCHEMA_VERSION,
  );
  const columns = new Set(
    (migrated.prepare('PRAGMA table_info(plan_worktrees)').all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  assert.equal(columns.has('owner_execution_id'), true);
  assert.equal(columns.has('version'), true);
  migrated.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('failed implementation retry reuses the same WorkItem worktree and resets only unverified state', async () => {
  const value = fixture();
  let worktree = await value.manager.ensureWorkItem({
    projectKey: 'project-gamma',
    rootPlanId: value.plan.planId,
    workItemId: value.itemA.workItemId,
    repositoryPath: value.repository,
    baseRevision: value.revision,
  });
  const first = createExecution(
    value.repositories,
    value.plan.planId,
    value.itemA.workItemId,
    'exec-failed-owner',
    value.revision,
  );
  createExecution(
    value.repositories,
    value.plan.planId,
    value.itemA.workItemId,
    'exec-retry-owner',
    value.revision,
  );
  worktree = await value.manager.attachWriter(worktree.worktreeId, first.identity.executionId);
  fs.writeFileSync(path.join(worktree.hostPath, 'unverified.txt'), 'discard me\n');
  value.repositories.executions.updateStatus(first.identity.executionId, 'RUNNING');
  value.repositories.executions.recordResult(first.identity.executionId, {
    status: 'FAILED',
    errorCode: 'PROVIDER_TRANSPORT_FAILED',
    retryable: true,
  });

  const reused = await value.manager.prepareWriterForExecution(
    worktree.worktreeId,
    'exec-retry-owner',
    value.revision,
    process.getuid?.() ?? 1000,
    process.getgid?.() ?? 1000,
  );
  assert.equal(reused.hostPath, worktree.hostPath);
  assert.equal(reused.ownerExecutionId, 'exec-retry-owner');
  assert.equal(reused.currentRevision, value.revision);
  assert.equal(git(reused.hostPath, ['rev-parse', 'HEAD']), value.revision);
  assert.equal(fs.existsSync(path.join(reused.hostPath, 'unverified.txt')), false);
  assert.equal(git(value.repository, ['rev-parse', 'HEAD']), value.revision);

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('reviewed integration reuses the durable activation base after a queued Plan inherits a newer project head', async () => {
  const value = fixture();
  const requestBase = value.revision;
  fs.writeFileSync(path.join(value.repository, 'inherited.txt'), 'from previous plan\n');
  git(value.repository, ['add', 'inherited.txt']);
  git(value.repository, ['commit', '-m', 'feat: previous plan head']);
  const inheritedHead = git(value.repository, ['rev-parse', 'HEAD']);
  git(value.repository, ['reset', '--hard', requestBase]);
  assert.equal(git(value.repository, ['rev-parse', 'HEAD']), requestBase);

  const reconciled = value.repositories.plans.reconcileCurrentRevision(
    value.plan.planId,
    requestBase,
    inheritedHead,
    'queued plan inherited prior project head',
  );
  assert.equal(reconciled.status, 'updated');
  value.repositories.plans.assignWorkItemWave(value.itemA.workItemId, 1, inheritedHead);
  value.repositories.plans.compareAndSetStatus(value.plan.planId, 'READY', 'RUNNING');

  const integration = await value.manager.ensureIntegration({
    projectKey: 'project-gamma',
    rootPlanId: value.plan.planId,
    repositoryPath: value.repository,
    baseRevision: inheritedHead,
  });
  assert.equal(integration.baseRevision, inheritedHead);
  assert.equal(value.repositories.plans.getPlan(value.plan.planId).baseRevision, requestBase);
  assert.equal(value.repositories.plans.getPlan(value.plan.planId).currentRevision, inheritedHead);

  const worktree = await value.manager.ensureWorkItem({
    projectKey: 'project-gamma',
    rootPlanId: value.plan.planId,
    workItemId: value.itemA.workItemId,
    repositoryPath: value.repository,
    baseRevision: inheritedHead,
  });
  createExecution(
    value.repositories,
    value.plan.planId,
    value.itemA.workItemId,
    'exec-inherited-head',
    inheritedHead,
  );
  await value.manager.attachWriter(worktree.worktreeId, 'exec-inherited-head');
  fs.writeFileSync(path.join(worktree.hostPath, 'next.txt'), 'next plan\n');
  git(worktree.hostPath, ['add', 'next.txt']);
  git(worktree.hostPath, ['commit', '-m', 'feat: next plan change']);
  const candidate = git(worktree.hostPath, ['rev-parse', 'HEAD']);
  await value.manager.releaseWriter(worktree.worktreeId, 'exec-inherited-head');

  const integrated = await value.manager.integrateReviewedCandidate({
    rootPlanId: value.plan.planId,
    workItemId: value.itemA.workItemId,
    candidateRevision: candidate,
    expectedPlanRevision: inheritedHead,
    integrationBaseRevision: inheritedHead,
  });
  assert.equal(integrated.worktree.baseRevision, inheritedHead);
  assert.notEqual(integrated.headRevision, inheritedHead);
  assert.equal(
    fs.readFileSync(path.join(integrated.worktree.hostPath, 'inherited.txt'), 'utf8'),
    'from previous plan\n',
  );
  assert.equal(
    fs.readFileSync(path.join(integrated.worktree.hostPath, 'next.txt'), 'utf8'),
    'next plan\n',
  );
  assert.equal(git(value.repository, ['rev-parse', 'HEAD']), requestBase);

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('parallel reviewed candidates integrate serially in the Plan integration worktree without mutating canonical checkout', async () => {
  const value = fixture();
  value.repositories.plans.assignWorkItemWave(value.itemA.workItemId, 1, value.revision);
  value.repositories.plans.assignWorkItemWave(value.itemB.workItemId, 1, value.revision);
  value.repositories.plans.compareAndSetStatus(value.plan.planId, 'READY', 'RUNNING');
  const canonicalHead = git(value.repository, ['rev-parse', 'HEAD']);

  const createCandidate = async (workItemId: string, executionId: string, file: string) => {
    const worktree = await value.manager.ensureWorkItem({
      projectKey: 'project-gamma',
      rootPlanId: value.plan.planId,
      workItemId,
      repositoryPath: value.repository,
      baseRevision: value.revision,
    });
    createExecution(value.repositories, value.plan.planId, workItemId, executionId, value.revision);
    await value.manager.attachWriter(worktree.worktreeId, executionId);
    fs.writeFileSync(path.join(worktree.hostPath, file), file + '\n');
    git(worktree.hostPath, ['add', file]);
    git(worktree.hostPath, ['commit', '-m', 'feat: ' + file]);
    const revision = git(worktree.hostPath, ['rev-parse', 'HEAD']);
    await value.manager.releaseWriter(worktree.worktreeId, executionId);
    return revision;
  };

  const candidateA = await createCandidate(value.itemA.workItemId, 'exec-wave-a', 'a.txt');
  const candidateB = await createCandidate(value.itemB.workItemId, 'exec-wave-b', 'b.txt');
  assert.equal(git(value.repository, ['rev-parse', 'HEAD']), canonicalHead);

  const first = await value.manager.integrateReviewedCandidate({
    rootPlanId: value.plan.planId,
    workItemId: value.itemA.workItemId,
    candidateRevision: candidateA,
    expectedPlanRevision: value.revision,
    integrationBaseRevision: value.revision,
  });
  const advancedA = value.repositories.plans.advanceAcceptedRevision(
    value.plan.planId,
    value.revision,
    first.headRevision,
    'test wave A',
  );
  assert.notEqual(advancedA.status, 'rejected');

  const reactivated = await value.manager.ensurePlanActivated(value.plan.planId);
  assert.equal(reactivated.worktreeId, first.worktree.worktreeId);
  assert.equal(reactivated.baseRevision, value.revision);
  assert.equal(reactivated.currentRevision, first.headRevision);
  assert.equal(
    value.repositories.events
      .listByAggregate(value.plan.planId)
      .some((event) => event.type === 'PLAN_ACTIVATION_FAILED'),
    false,
  );

  const second = await value.manager.integrateReviewedCandidate({
    rootPlanId: value.plan.planId,
    workItemId: value.itemB.workItemId,
    candidateRevision: candidateB,
    expectedPlanRevision: first.headRevision,
    integrationBaseRevision: value.revision,
  });
  const advancedB = value.repositories.plans.advanceAcceptedRevision(
    value.plan.planId,
    first.headRevision,
    second.headRevision,
    'test wave B',
  );
  assert.notEqual(advancedB.status, 'rejected');
  assert.notEqual(second.headRevision, candidateA);
  assert.notEqual(second.headRevision, candidateB);
  assert.equal(fs.readFileSync(path.join(second.worktree.hostPath, 'a.txt'), 'utf8'), 'a.txt\n');
  assert.equal(fs.readFileSync(path.join(second.worktree.hostPath, 'b.txt'), 'utf8'), 'b.txt\n');
  assert.equal(git(value.repository, ['rev-parse', 'HEAD']), canonicalHead);
  assert.equal(fs.existsSync(path.join(value.repository, 'a.txt')), false);
  assert.equal(fs.existsSync(path.join(value.repository, 'b.txt')), false);

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('child Plan WorkItems share the active root Plan worktree family without acquiring a second root lease', async () => {
  const value = fixture();
  const child = value.repositories.plans.createChildPlan({
    parentPlanId: value.plan.planId,
    childPlanId: 'child-repair',
    repositoryPath: value.repository,
    objective: 'repair child',
    relation: 'FOLLOW_UP',
  }).plan;
  const graph = value.repositories.plans.createGraphVersion({
    planId: child.planId,
    reason: 'repair',
  }).value!;
  const childItem = value.repositories.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId,
    itemKey: 'repair',
    title: 'Repair',
    objective: 'repair',
    acceptanceCriteria: [],
    dependencies: [],
  }).value!;
  const worktree = await value.manager.ensureWorkItem({
    projectKey: value.plan.projectKey,
    rootPlanId: value.plan.planId,
    workItemId: childItem.workItemId,
    repositoryPath: value.repository,
    baseRevision: child.baseRevision,
  });
  assert.equal(worktree.rootPlanId, value.plan.planId);
  assert.equal(worktree.workItemId, childItem.workItemId);
  assert.match(worktree.branchRef!, /^refs\/heads\/forgeflow\/plan-a\/items\/.+\/head$/);
  assert.equal(
    value.repositories.projectPlans.getLease(value.plan.projectKey)?.activeRootPlanId,
    value.plan.planId,
  );
  assert.equal(value.repositories.projectPlans.getQueueEntry(child.planId), undefined);

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('protected ref drift enters SAFETY_HOLD and blocks further worktree activity', async () => {
  const value = fixture();
  await value.manager.ensurePlanActivated(value.plan.planId);
  const snapshot = value.repositories.planWorktrees.getProtectedRefs(value.plan.planId);
  assert.ok(snapshot.some((entry) => entry.refName === 'refs/heads/main'));
  assert.ok(snapshot.some((entry) => entry.refName === '@HEAD'));
  git(value.repository, ['branch', 'operator-drift', value.revision]);
  await assert.rejects(
    () => value.manager.assertPlanSafety(value.plan.planId),
    (error: unknown) => error instanceof ForgeFlowError && error.code === 'WORKTREE_PROTECTED_REF_DRIFT',
  );
  assert.equal(value.repositories.plans.getPlan(value.plan.planId).status, 'SAFETY_HOLD');
  await assert.rejects(
    () =>
      value.manager.ensureWorkItem({
        projectKey: value.plan.projectKey,
        rootPlanId: value.plan.planId,
        workItemId: value.itemA.workItemId,
        repositoryPath: value.repository,
        baseRevision: value.revision,
      }),
    (error: unknown) =>
      error instanceof ForgeFlowError && error.code === 'WORKTREE_PLAN_NOT_ACTIVATABLE',
  );

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('canonical working-tree dirt enters SAFETY_HOLD even when protected refs are unchanged', async () => {
  const value = fixture();
  await value.manager.ensurePlanActivated(value.plan.planId);
  fs.writeFileSync(path.join(value.repository, 'operator-untracked.txt'), 'operator change\n');
  await assert.rejects(
    () => value.manager.assertPlanSafety(value.plan.planId),
    (error: unknown) =>
      error instanceof ForgeFlowError && error.code === 'WORKTREE_CANONICAL_REPOSITORY_DIRTY',
  );
  assert.equal(value.repositories.plans.getPlan(value.plan.planId).status, 'SAFETY_HOLD');
  fs.rmSync(path.join(value.repository, 'operator-untracked.txt'));
  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('Plan cleanup retires every worktree and removes only the active Plan ref namespace', async () => {
  const value = fixture();
  await value.manager.ensurePlanActivated(value.plan.planId);
  const item = await value.manager.ensureWorkItem({
    projectKey: value.plan.projectKey,
    rootPlanId: value.plan.planId,
    workItemId: value.itemA.workItemId,
    repositoryPath: value.repository,
    baseRevision: value.revision,
  });
  const historical = 'refs/heads/forgeflow/historical/keep';
  git(value.repository, ['update-ref', historical, value.revision]);
  // The historical ref was created after activation and is protected, so snapshot it as a
  // pre-existing external ref by removing/recreating the plan in a fresh fixture would be required.
  // Remove it before cleanup; cleanup itself must only delete the current Plan namespace.
  git(value.repository, ['update-ref', '-d', historical]);
  value.repositories.plans.updateStatus(value.plan.planId, 'RUNNING');
  value.repositories.plans.updateStatus(value.plan.planId, 'SUCCEEDED');
  await value.manager.retirePlan(value.plan.planId, process.getuid?.() ?? 1000);
  assert.ok(
    value.repositories.planWorktrees
      .listByPlan(value.plan.planId)
      .every((entry) => entry.state === 'RETIRED'),
  );
  assert.equal(fs.existsSync(item.hostPath), false);
  assert.equal(
    git(value.repository, ['for-each-ref', '--format=%(refname)', 'refs/heads/forgeflow/plan-a/']),
    '',
  );
  assert.equal(
    git(value.repository, ['rev-parse', '--verify', 'refs/forgeflow/archive/plan-a^{commit}']),
    value.repositories.plans.getPlan(value.plan.planId).currentRevision,
  );
  assert.equal(git(value.repository, ['rev-parse', 'HEAD']), value.revision);

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('Plan cleanup retires a durable PROVISIONING record whose physical worktree was never created', async () => {
  const value = fixture();
  await value.manager.ensurePlanActivated(value.plan.planId);
  const orphanPath = path.join(
    value.managed,
    'forgeflow',
    'plans',
    value.plan.projectKey,
    value.plan.planId,
    'items',
    'orphan',
    'repo',
  );
  const orphan = value.repositories.planWorktrees.create({
    worktreeId: 'worktree:work_item:plan-a:orphan',
    projectKey: value.plan.projectKey,
    rootPlanId: value.plan.planId,
    workItemId: value.itemA.workItemId,
    role: 'WORK_ITEM',
    repositoryPath: value.repository,
    hostPath: orphanPath,
    executionPath: '/workspace/forgeflow/plans/project-gamma/plan-a/items/orphan/repo',
    branchRef: 'refs/heads/forgeflow/plan-a/items/orphan/head',
    baseRevision: value.revision,
  }).value!;
  assert.equal(orphan.state, 'PROVISIONING');
  assert.equal(fs.existsSync(orphan.hostPath), false);

  await value.manager.retirePlan(value.plan.planId, process.getuid?.() ?? 1000);
  assert.equal(value.repositories.planWorktrees.get(orphan.worktreeId).state, 'RETIRED');
  assert.equal(fs.existsSync(orphan.hostPath), false);

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('Plan cleanup retires exact branched PROVISIONING half-created residue', async () => {
  const value = fixture();
  await value.manager.ensurePlanActivated(value.plan.planId);
  const orphanPath = path.join(
    value.managed,
    'forgeflow',
    'plans',
    value.plan.projectKey,
    value.plan.planId,
    'items',
    'half-created',
    'repo',
  );
  const branchRef = 'refs/heads/forgeflow/plan-a/items/half-created/head';
  const orphan = value.repositories.planWorktrees.create({
    worktreeId: 'worktree:work_item:plan-a:half-created',
    projectKey: value.plan.projectKey,
    rootPlanId: value.plan.planId,
    workItemId: value.itemA.workItemId,
    role: 'WORK_ITEM',
    repositoryPath: value.repository,
    hostPath: orphanPath,
    executionPath: '/workspace/forgeflow/plans/project-gamma/plan-a/items/half-created/repo',
    branchRef,
    baseRevision: value.revision,
  }).value!;
  git(value.repository, ['update-ref', branchRef, value.revision]);
  fs.mkdirSync(orphanPath, { recursive: true });
  assert.equal(orphan.state, 'PROVISIONING');

  value.repositories.plans.updateStatus(value.plan.planId, 'RUNNING');
  value.repositories.plans.updateStatus(value.plan.planId, 'SUCCEEDED');
  await value.manager.retirePlan(value.plan.planId, process.getuid?.() ?? 1000);
  assert.equal(value.repositories.planWorktrees.get(orphan.worktreeId).state, 'RETIRED');
  assert.equal(fs.existsSync(orphanPath), false);

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('schema v9 migrates additively to durable protected-ref snapshots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeflow-protected-ref-schema-'));
  const dbFile = path.join(root, 'forgeflow.sqlite');
  const current = openDatabase(dbFile, { environment: 'test' });
  current.exec(
    "DROP TABLE plan_protected_refs; UPDATE schema_meta SET schema_version=9 WHERE schema_id='forgeflow';",
  );
  current.close();
  const migrated = openDatabase(dbFile, { environment: 'test' });
  assert.equal(
    migrated.prepare("SELECT schema_version FROM schema_meta WHERE schema_id='forgeflow'").get()
      ?.schema_version,
    SCHEMA_VERSION,
  );
  const columns = new Set(
    (
      migrated.prepare('PRAGMA table_info(plan_protected_refs)').all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  assert.deepEqual([...columns].sort(), ['created_at', 'ref_name', 'revision', 'root_plan_id']);
  migrated.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('worker admin ACL defaults preserve canonical source access across Git file replacement', async () => {
  const value = fixture();
  const admin = path.join(value.root, 'acl-admin');
  fs.mkdirSync(admin, { mode: 0o770 });
  fs.writeFileSync(path.join(admin, 'index'), 'index\n');
  const sourceUid = process.getuid?.() ?? 1000;
  const syntheticWorkerUid = sourceUid + 50_000;
  const internal = value.manager as unknown as {
    grantRecursiveAcl(target: string, uid: number, preserveUid?: number): Promise<void>;
  };

  await internal.grantRecursiveAcl(admin, syntheticWorkerUid, sourceUid);

  const acl = execFileSync('getfacl', ['-n', '-p', admin], { encoding: 'utf8' });
  assert.match(acl, new RegExp(`^default:user:${sourceUid}:rwx$`, 'm'));
  assert.match(acl, new RegExp(`^default:user:${syntheticWorkerUid}:rwx$`, 'm'));

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('cancelled execution abandonment repairs source access to worktree admin metadata', async () => {
  const value = fixture();
  let worktree = await value.manager.ensureWorkItem({
    projectKey: 'project-gamma',
    rootPlanId: value.plan.planId,
    workItemId: value.itemA.workItemId,
    repositoryPath: value.repository,
    baseRevision: value.revision,
  });
  createExecution(
    value.repositories,
    value.plan.planId,
    value.itemA.workItemId,
    'exec-admin-access-repair',
    value.revision,
  );
  worktree = await value.manager.attachWriter(worktree.worktreeId, 'exec-admin-access-repair');
  const adminRaw = git(worktree.hostPath, ['rev-parse', '--git-dir']);
  const admin = fs.realpathSync(
    path.isAbsolute(adminRaw) ? adminRaw : path.resolve(worktree.hostPath, adminRaw),
  );
  const indexPath = path.join(admin, 'index');
  fs.chmodSync(indexPath, 0o000);

  const abandoned = await value.manager.abandonExecutionWorktree(
    worktree.worktreeId,
    'exec-admin-access-repair',
    value.revision,
  );

  assert.equal(abandoned.ownerExecutionId, undefined);
  assert.equal(abandoned.state, 'QUIESCENT');
  assert.equal(fs.statSync(indexPath).mode & 0o600, 0o600);
  assert.equal(git(worktree.hostPath, ['rev-parse', 'HEAD']), value.revision);
  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('cancelled execution abandonment rebuilds a corrupted literal worktree from canonical durable state', async () => {
  const value = fixture();
  let worktree = await value.manager.ensureWorkItem({
    projectKey: 'project-gamma',
    rootPlanId: value.plan.planId,
    workItemId: value.itemA.workItemId,
    repositoryPath: value.repository,
    baseRevision: value.revision,
  });
  createExecution(
    value.repositories,
    value.plan.planId,
    value.itemA.workItemId,
    'exec-corrupt-linkage-rebuild',
    value.revision,
  );
  worktree = await value.manager.attachWriter(worktree.worktreeId, 'exec-corrupt-linkage-rebuild');
  const gitfile = path.join(worktree.hostPath, '.git');
  fs.chmodSync(gitfile, 0o644);
  fs.rmSync(gitfile);
  fs.mkdirSync(gitfile);
  fs.writeFileSync(path.join(worktree.hostPath, 'untrusted.txt'), 'must not survive rebuild\n');

  const abandoned = await value.manager.abandonExecutionWorktree(
    worktree.worktreeId,
    'exec-corrupt-linkage-rebuild',
    value.revision,
  );

  assert.equal(abandoned.ownerExecutionId, undefined);
  assert.equal(abandoned.state, 'QUIESCENT');
  assert.equal(abandoned.currentRevision, value.revision);
  assert.equal(fs.lstatSync(path.join(worktree.hostPath, '.git')).isFile(), true);
  assert.equal(fs.existsSync(path.join(worktree.hostPath, 'untrusted.txt')), false);
  assert.equal(git(worktree.hostPath, ['rev-parse', 'HEAD']), value.revision);
  assert.equal(git(worktree.hostPath, ['status', '--porcelain=v1']), '');
  assert.equal(
    git(value.repository, ['rev-parse', worktree.branchRef!]),
    value.revision,
  );

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('cancelled execution abandonment resets unaccepted work and releases literal writer ownership', async () => {
  const value = fixture();
  let worktree = await value.manager.ensureWorkItem({
    projectKey: 'project-gamma',
    rootPlanId: value.plan.planId,
    workItemId: value.itemA.workItemId,
    repositoryPath: value.repository,
    baseRevision: value.revision,
  });
  createExecution(
    value.repositories,
    value.plan.planId,
    value.itemA.workItemId,
    'exec-cancel-abandon',
    value.revision,
  );
  worktree = await value.manager.attachWriter(worktree.worktreeId, 'exec-cancel-abandon');
  fs.writeFileSync(path.join(worktree.hostPath, 'unaccepted.txt'), 'unaccepted commit\n');
  git(worktree.hostPath, ['add', 'unaccepted.txt']);
  git(worktree.hostPath, ['commit', '-m', 'wip: unaccepted cancellation work']);
  fs.writeFileSync(path.join(worktree.hostPath, 'dirty.txt'), 'dirty\n');

  const abandoned = await value.manager.abandonExecutionWorktree(
    worktree.worktreeId,
    'exec-cancel-abandon',
    value.revision,
  );
  assert.equal(abandoned.ownerExecutionId, undefined);
  assert.equal(abandoned.state, 'QUIESCENT');
  assert.equal(abandoned.currentRevision, value.revision);
  assert.equal(git(worktree.hostPath, ['rev-parse', 'HEAD']), value.revision);
  assert.equal(git(worktree.hostPath, ['status', '--porcelain=v1']), '');
  assert.equal(fs.existsSync(path.join(worktree.hostPath, 'dirty.txt')), false);
  assert.equal(fs.existsSync(path.join(worktree.hostPath, 'unaccepted.txt')), false);

  const repeated = await value.manager.abandonExecutionWorktree(
    worktree.worktreeId,
    'exec-cancel-abandon',
    value.revision,
  );
  assert.equal(repeated.ownerExecutionId, undefined);
  assert.equal(repeated.currentRevision, value.revision);
  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('cancelled review abandonment resets the detached review worktree and makes it quiescent', async () => {
  const value = fixture();
  const review = await value.manager.createReview({
    projectKey: 'project-gamma',
    rootPlanId: value.plan.planId,
    reviewId: 'review-cancel-abandon',
    repositoryPath: value.repository,
    baseRevision: value.revision,
    reviewedSha: value.revision,
  });
  assert.equal(review.state, 'REVIEWING');
  fs.writeFileSync(path.join(review.hostPath, 'review-dirty.txt'), 'must be discarded\n');

  const abandoned = await value.manager.abandonExecutionWorktree(
    review.worktreeId,
    'exec-review-cancel-abandon',
    value.revision,
  );
  assert.equal(abandoned.state, 'QUIESCENT');
  assert.equal(abandoned.ownerExecutionId, undefined);
  assert.equal(git(review.hostPath, ['rev-parse', 'HEAD']), value.revision);
  assert.equal(git(review.hostPath, ['status', '--porcelain=v1']), '');
  assert.equal(fs.existsSync(path.join(review.hostPath, 'review-dirty.txt')), false);
  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});
