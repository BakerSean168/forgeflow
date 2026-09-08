import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LiteralWorktreeWorkspaceAdapter } from '../src/integrations/workspaces/index.js';
import { PlanWorktreeManager } from '../src/integrations/workspaces/index.js';
import { ForgeFlowError } from '../src/core/domain/errors.js';
import { openDatabase } from '../src/core/persistence/database.js';
import { createRepositories } from '../src/core/persistence/repositories.js';
import { REPOSITORY_COMPLETION_EVIDENCE_FILE } from '../src/core/orchestration/contracts.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeflow-literal-workspace-'));
  const repositoriesRoot = path.join(root, 'repositories');
  const repository = path.join(repositoriesRoot, 'project');
  const managed = path.join(root, 'managed');
  fs.mkdirSync(repository, { recursive: true });
  fs.mkdirSync(managed, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repository]);
  git(repository, ['config', 'user.name', 'Literal Test']);
  git(repository, ['config', 'user.email', 'literal@test.local']);
  fs.writeFileSync(path.join(repository, 'README.md'), 'base\n');
  git(repository, ['add', 'README.md']);
  git(repository, ['commit', '-m', 'chore: base']);
  const revision = git(repository, ['rev-parse', 'HEAD']);
  const db = openDatabase(path.join(root, 'forgeflow.sqlite'), { environment: 'test' });
  const repositories = createRepositories(db);
  const plan = repositories.plans.createPlan({
    planId: 'plan-literal',
    idempotencyKey: 'plan-literal',
    projectKey: 'literal',
    objective: 'literal worktree E2E',
    repositoryPath: repository,
    baseRevision: revision,
  }).value!;
  const graph = repositories.plans.createGraphVersion({
    planId: plan.planId,
    reason: 'graph',
  }).value!;
  const item = repositories.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId,
    itemKey: 'item',
    title: 'Item',
    objective: 'implement item',
    acceptanceCriteria: ['tests pass'],
    dependencies: [],
    parallelSafe: true,
    writeScopes: ['src/item.txt'],
  }).value!;
  repositories.projectPlans.scheduleRootPlan(plan.planId);
  repositories.plans.compareAndSetStatus(plan.planId, 'READY', 'RUNNING');
  repositories.plans.assignWorkItemWave(item.workItemId, 1, revision);
  const manager = new PlanWorktreeManager({
    repositories,
    allowedRepositoryRoots: [repositoriesRoot],
    managedHostRoot: managed,
    executionRoot: '/workspace',
  });
  const adapter = new LiteralWorktreeWorkspaceAdapter({
    repositories,
    manager,
    managedHostRoot: managed,
    executionRoot: '/workspace',
    workspaceUid: process.getuid?.() ?? 1000,
    workspaceGid: process.getgid?.() ?? 1000,
    minimumFreeBytes: 0,
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
    item,
    manager,
    adapter,
  };
}

function createExecution(
  value: ReturnType<typeof fixture>,
  executionId: string,
  phase: 'IMPLEMENT' | 'REVIEW',
  sourceRevision: string,
  parentExecutionId?: string,
) {
  return value.repositories.executions.create({
    executionId,
    idempotencyKey: executionId,
    identity: {
      executionId,
      planId: value.plan.planId,
      workItemId: value.item.workItemId,
      phase,
      ...(parentExecutionId ? { parentExecutionId } : {}),
      attempt: 1,
      route: phase === 'REVIEW' ? 'review' : 'implementation',
      sourceRevision,
    },
    objective: phase === 'REVIEW' ? 'review item' : 'implement item',
  }).value!;
}


function attachSession(
  value: ReturnType<typeof fixture>,
  executionId: string,
  workspace: import('../src/core/orchestration/contracts.js').WorkspaceDescriptor,
) {
  value.repositories.sessions.create({
    executionId,
    phase: 'IMPLEMENT',
    provider: 'fake-implementation',
    workspace,
    sourceRevision: workspace.sourceRevision,
  });
}

function implementationEvidence(
  executionId: string,
  sourceRevision: string,
  resultRevision: string,
  summary = 'implemented',
) {
  return {
    version: 1,
    executionId,
    phase: 'IMPLEMENT',
    sourceRevision,
    resultRevision,
    outcome: 'CHANGED',
    summary,
    tests: [{ command: 'test', status: 'PASS', exitCode: 0 }],
  } as const;
}

test('literal workspace completes implementation, exact-SHA review and Plan integration without touching canonical checkout', async () => {
  const value = fixture();
  const implementation = createExecution(value, 'exec-literal-impl', 'IMPLEMENT', value.revision);
  const workspace = await value.adapter.provision({
    executionId: implementation.identity.executionId,
    planId: value.plan.planId,
    projectKey: value.plan.projectKey,
    workItemId: value.item.workItemId,
    repositoryPath: value.repository,
    sourceRevision: value.revision,
    phase: 'IMPLEMENT',
  });
  assert.match(workspace.executionPath, /^\/workspace\/forgeflow\/plans\/literal\/plan-literal\/items\//);
  assert.equal(git(value.repository, ['rev-parse', 'HEAD']), value.revision);
  const gitfileStat = fs.lstatSync(path.join(workspace.hostPath, '.git'));
  assert.equal(gitfileStat.isFile(), true);
  assert.equal(gitfileStat.mode & 0o777, 0o444);
  assert.notEqual(fs.lstatSync(workspace.hostPath).mode & 0o1000, 0);
  fs.mkdirSync(path.join(workspace.hostPath, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace.hostPath, 'src/item.txt'), 'implemented\n');
  git(workspace.hostPath, ['add', 'src/item.txt']);
  git(workspace.hostPath, ['commit', '-m', 'feat: implement literal item']);
  const candidate = git(workspace.hostPath, ['rev-parse', 'HEAD']);
  fs.writeFileSync(
    path.join(workspace.hostPath, REPOSITORY_COMPLETION_EVIDENCE_FILE),
    JSON.stringify({
      version: 1,
      executionId: implementation.identity.executionId,
      phase: 'IMPLEMENT',
      sourceRevision: value.revision,
      resultRevision: candidate,
      outcome: 'CHANGED',
      summary: 'implemented',
      tests: [{ command: 'test', status: 'PASS', exitCode: 0 }],
    }) + '\n',
  );
  const completed = await value.adapter.verifyImplementation(workspace);
  assert.equal(completed.headRevision, candidate);
  assert.equal(
    value.repositories.planWorktrees.findForWorkItem(value.plan.planId, value.item.workItemId)
      ?.ownerExecutionId,
    undefined,
  );
  assert.equal(git(value.repository, ['rev-parse', 'HEAD']), value.revision);

  value.repositories.executions.updateStatus(implementation.identity.executionId, 'RUNNING');
  value.repositories.executions.recordResult(implementation.identity.executionId, {
    status: 'SUCCEEDED',
    resultRevision: candidate,
    resultSummary: 'implemented',
  });
  const reviewExecution = createExecution(
    value,
    'exec-literal-review',
    'REVIEW',
    candidate,
    implementation.identity.executionId,
  );
  const reviewWorkspace = await value.adapter.provision({
    executionId: reviewExecution.identity.executionId,
    planId: value.plan.planId,
    projectKey: value.plan.projectKey,
    workItemId: value.item.workItemId,
    repositoryPath: value.repository,
    sourceRevision: candidate,
    phase: 'REVIEW',
  });
  assert.equal(git(reviewWorkspace.hostPath, ['rev-parse', 'HEAD']), candidate);
  assert.equal(git(reviewWorkspace.hostPath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD');
  fs.writeFileSync(
    path.join(reviewWorkspace.hostPath, REPOSITORY_COMPLETION_EVIDENCE_FILE),
    JSON.stringify({
      version: 1,
      executionId: reviewExecution.identity.executionId,
      phase: 'REVIEW',
      reviewedSha: candidate,
      verdict: 'PASS',
      summary: 'review passed',
      findings: [],
      checks: [{ command: 'test', status: 'PASS', exitCode: 0 }],
    }) + '\n',
  );
  const reviewed = await value.adapter.verifyReview(reviewWorkspace, candidate);
  assert.equal(reviewed.evidence.phase, 'REVIEW');
  assert.equal(reviewed.evidence.verdict, 'PASS');

  // A provider can finish its turn just after controller-side evidence promotion and
  // recreate repository-local evidence. Integration must reject any differing replay,
  // while an exact revalidated duplicate may be pruned before the strict dirty gate.
  const repositoryEvidence = path.join(
    workspace.hostPath,
    REPOSITORY_COMPLETION_EVIDENCE_FILE,
  );
  const integrationInput = {
    repositoryPath: value.repository,
    expectedRevision: value.revision,
    acceptedRevision: candidate,
    candidateWorkspace: workspace,
    planId: value.plan.planId,
    workItemId: value.item.workItemId,
    integrationBaseRevision: value.revision,
  };
  fs.writeFileSync(
    repositoryEvidence,
    JSON.stringify({
      version: 1,
      executionId: implementation.identity.executionId,
      phase: 'IMPLEMENT',
      sourceRevision: value.revision,
      resultRevision: candidate,
      outcome: 'CHANGED',
      summary: 'different replay',
      tests: [{ command: 'test', status: 'PASS', exitCode: 0 }],
    }) + '\n',
  );
  await assert.rejects(
    () => value.adapter.integrateAcceptedRevision(integrationInput),
    (error: unknown) =>
      error instanceof ForgeFlowError && error.code === 'WORKSPACE_EVIDENCE_AMBIGUOUS',
  );
  assert.equal(fs.existsSync(repositoryEvidence), true);

  fs.writeFileSync(
    repositoryEvidence,
    JSON.stringify({
      version: 1,
      executionId: implementation.identity.executionId,
      phase: 'IMPLEMENT',
      sourceRevision: value.revision,
      resultRevision: candidate,
      outcome: 'CHANGED',
      summary: 'implemented',
      tests: [{ command: 'test', status: 'PASS', exitCode: 0 }],
    }) + '\n',
  );
  const integrated = await value.adapter.integrateAcceptedRevision(integrationInput);
  assert.notEqual(integrated.headRevision, value.revision);
  assert.equal(
    fs.readFileSync(path.join(integrated.rootPath, 'src/item.txt'), 'utf8'),
    'implemented\n',
  );
  assert.equal(git(value.repository, ['rev-parse', 'HEAD']), value.revision);
  assert.equal(fs.existsSync(path.join(value.repository, 'src/item.txt')), false);
  assert.equal(fs.existsSync(repositoryEvidence), false);

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});


test('terminal literal Plan retirement prunes only an exact durable implementation evidence replay', async () => {
  const value = fixture();
  const implementation = createExecution(
    value,
    'exec-terminal-retirement-residue',
    'IMPLEMENT',
    value.revision,
  );
  const workspace = await value.adapter.provision({
    executionId: implementation.identity.executionId,
    planId: value.plan.planId,
    projectKey: value.plan.projectKey,
    workItemId: value.item.workItemId,
    repositoryPath: value.repository,
    sourceRevision: value.revision,
    phase: 'IMPLEMENT',
  });
  attachSession(value, implementation.identity.executionId, workspace);
  fs.mkdirSync(path.join(workspace.hostPath, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace.hostPath, 'src/item.txt'), 'implemented\n');
  git(workspace.hostPath, ['add', 'src/item.txt']);
  git(workspace.hostPath, ['commit', '-m', 'feat: implement retirement evidence case']);
  const candidate = git(workspace.hostPath, ['rev-parse', 'HEAD']);
  const evidence = implementationEvidence(
    implementation.identity.executionId,
    value.revision,
    candidate,
  );
  const staged = path.join(workspace.hostPath, REPOSITORY_COMPLETION_EVIDENCE_FILE);
  fs.writeFileSync(staged, JSON.stringify(evidence) + '\n');
  await value.adapter.verifyImplementation(workspace);
  assert.equal(fs.existsSync(staged), false);

  value.repositories.executions.updateStatus(implementation.identity.executionId, 'RUNNING');
  value.repositories.executions.recordResult(implementation.identity.executionId, {
    status: 'SUCCEEDED',
    resultRevision: candidate,
    resultSummary: 'implemented',
  });
  fs.writeFileSync(staged, JSON.stringify(evidence) + '\n');
  value.repositories.plans.updateStatus(value.plan.planId, 'CANCELLED');

  await value.adapter.preparePlanRetirement(value.plan.planId);
  assert.equal(fs.existsSync(staged), false);
  await value.manager.retirePlan(value.plan.planId, process.getuid?.() ?? 1000);
  assert.ok(
    value.repositories.planWorktrees
      .listByPlan(value.plan.planId)
      .every((worktree) => worktree.state === 'RETIRED'),
  );
  assert.equal(git(value.repository, ['rev-parse', 'HEAD']), value.revision);
  assert.equal(git(value.repository, ['status', '--porcelain=v1']), '');

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('terminal literal Plan retirement rejects a differing evidence replay and live Plans cannot prune it', async () => {
  const value = fixture();
  const implementation = createExecution(
    value,
    'exec-terminal-retirement-tamper',
    'IMPLEMENT',
    value.revision,
  );
  const workspace = await value.adapter.provision({
    executionId: implementation.identity.executionId,
    planId: value.plan.planId,
    projectKey: value.plan.projectKey,
    workItemId: value.item.workItemId,
    repositoryPath: value.repository,
    sourceRevision: value.revision,
    phase: 'IMPLEMENT',
  });
  attachSession(value, implementation.identity.executionId, workspace);
  fs.mkdirSync(path.join(workspace.hostPath, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace.hostPath, 'src/item.txt'), 'implemented\n');
  git(workspace.hostPath, ['add', 'src/item.txt']);
  git(workspace.hostPath, ['commit', '-m', 'feat: implement retirement tamper case']);
  const candidate = git(workspace.hostPath, ['rev-parse', 'HEAD']);
  const durable = implementationEvidence(
    implementation.identity.executionId,
    value.revision,
    candidate,
  );
  const staged = path.join(workspace.hostPath, REPOSITORY_COMPLETION_EVIDENCE_FILE);
  fs.writeFileSync(staged, JSON.stringify(durable) + '\n');
  await value.adapter.verifyImplementation(workspace);
  value.repositories.executions.updateStatus(implementation.identity.executionId, 'RUNNING');
  value.repositories.executions.recordResult(implementation.identity.executionId, {
    status: 'SUCCEEDED',
    resultRevision: candidate,
    resultSummary: 'implemented',
  });
  fs.writeFileSync(
    staged,
    JSON.stringify(
      implementationEvidence(
        implementation.identity.executionId,
        value.revision,
        candidate,
        'tampered replay',
      ),
    ) + '\n',
  );

  await assert.rejects(
    () => value.adapter.preparePlanRetirement(value.plan.planId),
    (error: unknown) =>
      error instanceof ForgeFlowError && error.code === 'WORKSPACE_RETIREMENT_PLAN_NOT_TERMINAL',
  );
  assert.equal(fs.existsSync(staged), true);
  value.repositories.plans.updateStatus(value.plan.planId, 'CANCELLED');
  await assert.rejects(
    () => value.adapter.preparePlanRetirement(value.plan.planId),
    (error: unknown) =>
      error instanceof ForgeFlowError && error.code === 'WORKSPACE_EVIDENCE_AMBIGUOUS',
  );
  assert.equal(fs.existsSync(staged), true);

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('abandoning an already retired literal execution workspace is idempotent only for exact durable provenance', async () => {
  const value = fixture();
  const implementation = createExecution(
    value,
    'exec-retired-abandon-replay',
    'IMPLEMENT',
    value.revision,
  );
  const workspace = await value.adapter.provision({
    executionId: implementation.identity.executionId,
    planId: value.plan.planId,
    projectKey: value.plan.projectKey,
    workItemId: value.item.workItemId,
    repositoryPath: value.repository,
    sourceRevision: value.revision,
    phase: 'IMPLEMENT',
  });
  attachSession(value, implementation.identity.executionId, workspace);
  fs.mkdirSync(path.join(workspace.hostPath, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace.hostPath, 'src/item.txt'), 'implemented\n');
  git(workspace.hostPath, ['add', 'src/item.txt']);
  git(workspace.hostPath, ['commit', '-m', 'feat: implement retired abandon case']);
  const candidate = git(workspace.hostPath, ['rev-parse', 'HEAD']);
  fs.writeFileSync(
    path.join(workspace.hostPath, REPOSITORY_COMPLETION_EVIDENCE_FILE),
    JSON.stringify(
      implementationEvidence(implementation.identity.executionId, value.revision, candidate),
    ) + '\n',
  );
  await value.adapter.verifyImplementation(workspace);
  value.repositories.executions.updateStatus(implementation.identity.executionId, 'CANCELLED');
  const worktree = value.repositories.planWorktrees.findForWorkItem(
    value.plan.planId,
    value.item.workItemId,
  )!;
  await value.manager.retire(worktree.worktreeId);
  assert.equal(fs.existsSync(workspace.hostPath), false);
  assert.equal(value.repositories.planWorktrees.get(worktree.worktreeId).state, 'RETIRED');

  await value.adapter.abandonExecution(workspace);
  await assert.rejects(
    () =>
      value.adapter.abandonExecution({
        ...workspace,
        createdAt: '2099-01-01T00:00:00.000Z',
      }),
    (error: unknown) =>
      error instanceof ForgeFlowError && error.code === 'WORKTREE_RETIRED_WORKSPACE_MISMATCH',
  );

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('literal workspace rejects implementation commits outside the declared WorkItem write scope', async () => {
  const value = fixture();
  const implementation = createExecution(
    value,
    'exec-literal-out-of-scope',
    'IMPLEMENT',
    value.revision,
  );
  const workspace = await value.adapter.provision({
    executionId: implementation.identity.executionId,
    planId: value.plan.planId,
    projectKey: value.plan.projectKey,
    workItemId: value.item.workItemId,
    repositoryPath: value.repository,
    sourceRevision: value.revision,
    phase: 'IMPLEMENT',
  });
  fs.mkdirSync(path.join(workspace.hostPath, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace.hostPath, 'src/item.txt'), 'allowed\n');
  fs.writeFileSync(path.join(workspace.hostPath, 'README.md'), 'out of scope\n');
  git(workspace.hostPath, ['add', 'src/item.txt', 'README.md']);
  git(workspace.hostPath, ['commit', '-m', 'feat: mix scoped and unscoped changes']);
  const candidate = git(workspace.hostPath, ['rev-parse', 'HEAD']);
  fs.writeFileSync(
    path.join(workspace.hostPath, REPOSITORY_COMPLETION_EVIDENCE_FILE),
    JSON.stringify({
      version: 1,
      executionId: implementation.identity.executionId,
      phase: 'IMPLEMENT',
      sourceRevision: value.revision,
      resultRevision: candidate,
      outcome: 'CHANGED',
      summary: 'attempted out-of-scope change',
      tests: [{ command: 'test', status: 'PASS', exitCode: 0 }],
    }) + '\n',
  );

  await assert.rejects(
    () => value.adapter.verifyImplementation(workspace),
    (error: unknown) =>
      error instanceof ForgeFlowError && error.code === 'WORKSPACE_WRITE_SCOPE_VIOLATED',
  );
  assert.equal(
    value.repositories.planWorktrees.findForWorkItem(value.plan.planId, value.item.workItemId)
      ?.ownerExecutionId,
    implementation.identity.executionId,
  );
  assert.equal(git(value.repository, ['rev-parse', 'HEAD']), value.revision);

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('literal workspace fails closed when the shared-worktree gitfile is replaced', async () => {
  const value = fixture();
  const implementation = createExecution(value, 'exec-linkage-guard', 'IMPLEMENT', value.revision);
  const workspace = await value.adapter.provision({
    executionId: implementation.identity.executionId,
    planId: value.plan.planId,
    projectKey: value.plan.projectKey,
    workItemId: value.item.workItemId,
    repositoryPath: value.repository,
    sourceRevision: value.revision,
    phase: 'IMPLEMENT',
  });
  const gitfile = path.join(workspace.hostPath, '.git');
  fs.chmodSync(gitfile, 0o644);
  fs.rmSync(gitfile);
  fs.mkdirSync(gitfile);

  await assert.rejects(
    () => value.adapter.progressFingerprint(workspace),
    (error: unknown) =>
      error instanceof ForgeFlowError && error.code === 'WORKTREE_GIT_LINKAGE_VIOLATED',
  );

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('literal workspace retry reuses WorkItem path across Execution ids', async () => {
  const value = fixture();
  const first = createExecution(value, 'exec-literal-failed', 'IMPLEMENT', value.revision);
  const firstWorkspace = await value.adapter.provision({
    executionId: first.identity.executionId,
    planId: value.plan.planId,
    projectKey: value.plan.projectKey,
    workItemId: value.item.workItemId,
    repositoryPath: value.repository,
    sourceRevision: value.revision,
    phase: 'IMPLEMENT',
  });
  fs.writeFileSync(path.join(firstWorkspace.hostPath, 'dirty.txt'), 'unverified\n');
  value.repositories.executions.updateStatus(first.identity.executionId, 'RUNNING');
  value.repositories.executions.recordResult(first.identity.executionId, {
    status: 'FAILED',
    errorCode: 'PROVIDER_TRANSPORT_FAILED',
    retryable: true,
  });
  const retry = createExecution(value, 'exec-literal-retry', 'IMPLEMENT', value.revision);
  const retryWorkspace = await value.adapter.provision({
    executionId: retry.identity.executionId,
    planId: value.plan.planId,
    projectKey: value.plan.projectKey,
    workItemId: value.item.workItemId,
    repositoryPath: value.repository,
    sourceRevision: value.revision,
    phase: 'IMPLEMENT',
  });
  assert.equal(retryWorkspace.hostPath, firstWorkspace.hostPath);
  assert.notEqual(retryWorkspace.evidenceHostPath, firstWorkspace.evidenceHostPath);
  assert.equal(fs.existsSync(path.join(retryWorkspace.hostPath, 'dirty.txt')), false);
  assert.equal(
    value.repositories.planWorktrees.findForWorkItem(value.plan.planId, value.item.workItemId)
      ?.ownerExecutionId,
    retry.identity.executionId,
  );

  value.db.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});
