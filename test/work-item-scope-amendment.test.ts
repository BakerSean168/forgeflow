import assert from 'node:assert/strict';
import test from 'node:test';

import { ForgeFlowError } from '../src/core/domain/errors.js';
import { openDatabase } from '../src/core/persistence/database.js';
import { createRepositories } from '../src/core/persistence/repositories.js';

function seed() {
  const db = openDatabase(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } });
  const repositories = createRepositories(db);
  const plan = repositories.plans.createPlan({
    planId: 'plan-scope-amendment',
    idempotencyKey: 'plan-scope-amendment',
    projectKey: 'project',
    objective: 'test bounded scope correction',
    repositoryPath: '/repo',
    baseRevision: 'base-sha',
  }).value!;
  const graph = repositories.plans.createGraphVersion({ planId: plan.planId, reason: 'initial' }).value!;
  const left = repositories.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId,
    itemKey: 'left',
    title: 'Left',
    objective: 'left work',
    acceptanceCriteria: ['pass'],
    dependencies: [],
    parallelSafe: true,
    writeScopes: ['src/left.ts'],
    conflictKeys: ['left'],
  }).value!;
  const right = repositories.plans.appendGraphWorkItem({
    graphVersionId: graph.graphVersionId,
    itemKey: 'right',
    title: 'Right',
    objective: 'right work',
    acceptanceCriteria: ['pass'],
    dependencies: [],
    parallelSafe: true,
    writeScopes: ['src/right.ts'],
    conflictKeys: ['right'],
  }).value!;
  repositories.plans.updateStatus(plan.planId, 'READY');
  repositories.plans.updateStatus(plan.planId, 'RUNNING');
  repositories.plans.assignWorkItemWave(left.workItemId, 1, 'base-sha');
  repositories.plans.assignWorkItemWave(right.workItemId, 1, 'base-sha');
  repositories.plans.updateWorkItemStatus(left.workItemId, 'RUNNING');
  repositories.plans.updateWorkItemStatus(right.workItemId, 'RUNNING');
  repositories.plans.updateWorkItemStatus(left.workItemId, 'FAILED');
  repositories.plans.updateWorkItemStatus(right.workItemId, 'FAILED');
  repositories.plans.updateStatus(plan.planId, 'FAILED');
  return { db, repositories, plan, left, right };
}

test('failed WorkItem write-scope amendment is audited, CAS-bound, additive and wave-safe', () => {
  const value = seed();
  const result = value.repositories.plans.amendFailedWorkItemWriteScopes(value.plan.planId, [
    {
      itemKey: 'left',
      expectedWriteScopes: ['src/left.ts'],
      writeScopes: ['src/left-helper.ts', 'src/left.ts'],
      reason: 'Align the durable scope with the authoritative implementation specification.',
    },
  ]);
  assert.deepEqual(result.workItems[0]?.writeScopes, ['src/left-helper.ts', 'src/left.ts']);
  const events = value.repositories.events.listByAggregate(value.left.workItemId);
  const amended = events.find((event) => event.type === 'WORK_ITEM_WRITE_SCOPES_AMENDED');
  assert.ok(amended);
  assert.deepEqual(amended.payload.from, ['src/left.ts']);
  assert.deepEqual(amended.payload.to, ['src/left-helper.ts', 'src/left.ts']);
  assert.equal(
    amended.payload.reason,
    'Align the durable scope with the authoritative implementation specification.',
  );
  value.db.close();
});

test('write-scope amendment rejects shrink, stale expected scope and same-wave overlap atomically', () => {
  for (const [expectedCode, amendment] of [
    [
      'WORK_ITEM_SCOPE_AMENDMENT_NOT_SUPERSET',
      {
        itemKey: 'left',
        expectedWriteScopes: ['src/left.ts'],
        writeScopes: ['src/other.ts'],
        reason: 'invalid shrink',
      },
    ],
    [
      'WORK_ITEM_SCOPE_AMENDMENT_STALE',
      {
        itemKey: 'left',
        expectedWriteScopes: ['src/stale.ts'],
        writeScopes: ['src/left-helper.ts', 'src/stale.ts'],
        reason: 'stale input',
      },
    ],
    [
      'WORK_ITEM_SCOPE_AMENDMENT_WAVE_CONFLICT',
      {
        itemKey: 'left',
        expectedWriteScopes: ['src/left.ts'],
        writeScopes: ['src/left.ts', 'src/right.ts'],
        reason: 'would overlap sibling',
      },
    ],
  ] as const) {
    const value = seed();
    assert.throws(
      () => value.repositories.plans.amendFailedWorkItemWriteScopes(value.plan.planId, [amendment]),
      (error: unknown) => error instanceof ForgeFlowError && error.code === expectedCode,
    );
    assert.deepEqual(
      value.repositories.plans.getWorkItem(value.left.workItemId).writeScopes,
      ['src/left.ts'],
    );
    assert.equal(
      value.repositories.events
        .listByAggregate(value.left.workItemId)
        .some((event) => event.type === 'WORK_ITEM_WRITE_SCOPES_AMENDED'),
      false,
    );
    value.db.close();
  }
});

test('write-scope amendment rejects an active execution and leaves durable scope unchanged', () => {
  const value = seed();
  value.repositories.executions.create({
    executionId: 'active-scope-execution',
    idempotencyKey: 'active-scope-execution',
    identity: {
      executionId: 'active-scope-execution',
      planId: value.plan.planId,
      workItemId: value.left.workItemId,
      phase: 'IMPLEMENT',
      attempt: 1,
      route: 'implementation',
      sourceRevision: 'base-sha',
    },
    objective: 'still active',
  });
  assert.throws(
    () =>
      value.repositories.plans.amendFailedWorkItemWriteScopes(value.plan.planId, [
        {
          itemKey: 'left',
          expectedWriteScopes: ['src/left.ts'],
          writeScopes: ['src/left-helper.ts', 'src/left.ts'],
          reason: 'must wait for terminal execution',
        },
      ]),
    (error: unknown) =>
      error instanceof ForgeFlowError && error.code === 'WORK_ITEM_SCOPE_AMENDMENT_EXECUTION_ACTIVE',
  );
  assert.deepEqual(value.repositories.plans.getWorkItem(value.left.workItemId).writeScopes, ['src/left.ts']);
  value.db.close();
});
