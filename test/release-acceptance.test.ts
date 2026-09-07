import assert from 'node:assert/strict';
import test from 'node:test';

import { ForgeFlowError } from '../src/core/domain/errors.js';
import {
  AUTONOMOUS_ACCEPTANCE_REQUIRED_EXTERNAL_CHECKS,
  releaseAcceptanceAggregateId,
  validateAutonomousLifecycleAcceptance,
  type AutonomousAcceptanceSnapshot,
} from '../src/core/orchestration/releaseAcceptance.js';

const sourceSha = '1'.repeat(40);
const artifactSha256 = '2'.repeat(64);
const base = '3'.repeat(40);
const acceptedA = '4'.repeat(40);
const acceptedB = '5'.repeat(40);
const finalRevision = '6'.repeat(40);

function snapshot(): AutonomousAcceptanceSnapshot {
  return {
    release: { status: 'HEALTHY', sourceSha, artifactSha256 },
    expectedRelease: { sourceSha, artifactSha256 },
    canonicalHead: '7'.repeat(40),
    externalChecks: [...AUTONOMOUS_ACCEPTANCE_REQUIRED_EXTERNAL_CHECKS],
    plan: {
      planId: 'plan-acceptance',
      projectKey: 'forgeflow-smoke',
      baseRevision: base,
      currentRevision: finalRevision,
      status: 'SUCCEEDED',
    },
    workItems: [
      {
        workItemId: 'work-a',
        itemKey: 'parallel-a',
        status: 'SUCCEEDED',
        wave: 1,
        integrationBaseRevision: base,
        exactAcceptedRevision: acceptedA,
      },
      {
        workItemId: 'work-b',
        itemKey: 'parallel-b',
        status: 'SUCCEEDED',
        wave: 1,
        integrationBaseRevision: base,
        exactAcceptedRevision: acceptedB,
      },
    ],
    executions: [
      {
        executionId: 'impl-a',
        workItemId: 'work-a',
        phase: 'IMPLEMENT',
        status: 'SUCCEEDED',
        sourceRevision: base,
        resultRevision: acceptedA,
        createdAt: '2026-09-07T04:00:00.000Z',
      },
      {
        executionId: 'impl-b',
        workItemId: 'work-b',
        phase: 'IMPLEMENT',
        status: 'SUCCEEDED',
        sourceRevision: base,
        resultRevision: acceptedB,
        createdAt: '2026-09-07T04:00:00.009Z',
      },
      {
        executionId: 'review-a',
        workItemId: 'work-a',
        phase: 'REVIEW',
        status: 'SUCCEEDED',
        sourceRevision: acceptedA,
        resultRevision: acceptedA,
        createdAt: '2026-09-07T04:01:00.000Z',
      },
      {
        executionId: 'review-b',
        workItemId: 'work-b',
        phase: 'REVIEW',
        status: 'SUCCEEDED',
        sourceRevision: acceptedB,
        resultRevision: acceptedB,
        createdAt: '2026-09-07T04:01:00.010Z',
      },
    ],
    reviews: [
      {
        reviewId: 'review-record-a',
        workItemId: 'work-a',
        implementationExecutionId: 'impl-a',
        reviewerExecutionId: 'review-a',
        reviewedSha: acceptedA,
        status: 'PASSED',
        verdict: 'PASS',
      },
      {
        reviewId: 'review-record-b',
        workItemId: 'work-b',
        implementationExecutionId: 'impl-b',
        reviewerExecutionId: 'review-b',
        reviewedSha: acceptedB,
        status: 'PASSED',
        verdict: 'PASS',
      },
    ],
    providerSessions: [
      { executionId: 'impl-a', providerSessionId: 'provider-impl-a', cleanupProven: true },
      { executionId: 'impl-b', providerSessionId: 'provider-impl-b', cleanupProven: true },
      { executionId: 'review-a', providerSessionId: 'provider-review-a', cleanupProven: true },
      { executionId: 'review-b', providerSessionId: 'provider-review-b', cleanupProven: true },
    ],
    worktrees: [
      { state: 'RETIRED' },
      { state: 'RETIRED' },
      { state: 'RETIRED' },
      { state: 'RETIRED' },
      { state: 'RETIRED' },
    ],
    lease: { committedRevision: finalRevision, version: 42 },
    activationFailureCount: 0,
  };
}

function code(error: unknown): string | undefined {
  return error instanceof ForgeFlowError ? error.code : undefined;
}

test('release acceptance binds one healthy release to a complete autonomous lifecycle proof', () => {
  const result = validateAutonomousLifecycleAcceptance(snapshot());
  assert.equal(result.sourceSha, sourceSha);
  assert.equal(result.artifactSha256, artifactSha256);
  assert.equal(result.planId, 'plan-acceptance');
  assert.equal(result.finalRevision, finalRevision);
  assert.equal(result.wave, 1);
  assert.equal(result.implementationStartDeltaMs, 9);
  assert.equal(result.providerSessionCount, 4);
  assert.equal(result.worktreeCount, 5);
  assert.equal(result.activationFailureCount, 0);
  assert.equal(releaseAcceptanceAggregateId(sourceSha), `release-acceptance:${sourceSha}`);
});

test('release acceptance refuses a release change during the real-provider smoke', () => {
  const value = snapshot();
  value.expectedRelease = { sourceSha: '8'.repeat(40), artifactSha256 };
  assert.throws(
    () => validateAutonomousLifecycleAcceptance(value),
    (error) => code(error) === 'RELEASE_ACCEPTANCE_RELEASE_CHANGED',
  );
});

test('release acceptance refuses missing provider cleanup proof', () => {
  const value = snapshot();
  value.providerSessions = value.providerSessions.map((session, index) =>
    index === 0 ? { ...session, cleanupProven: false } : session,
  );
  assert.throws(
    () => validateAutonomousLifecycleAcceptance(value),
    (error) => code(error) === 'RELEASE_ACCEPTANCE_PROVIDER_CLEANUP_INCOMPLETE',
  );
});

test('release acceptance refuses activation failure and incomplete external proof', () => {
  const activation = snapshot();
  activation.activationFailureCount = 1;
  assert.throws(
    () => validateAutonomousLifecycleAcceptance(activation),
    (error) => code(error) === 'RELEASE_ACCEPTANCE_ACTIVATION_FAILURE_OBSERVED',
  );

  const external = snapshot();
  external.externalChecks = ['canonical-checkout-unchanged'];
  assert.throws(
    () => validateAutonomousLifecycleAcceptance(external),
    (error) => code(error) === 'RELEASE_ACCEPTANCE_EXTERNAL_CHECKS_INCOMPLETE',
  );
});
