import { ForgeFlowError, failClosed } from '../domain/errors.js';

export const AUTONOMOUS_ACCEPTANCE_EVENT = 'AUTONOMOUS_LIFECYCLE_ACCEPTANCE_ATTESTED';
export const AUTONOMOUS_ACCEPTANCE_REQUIRED_EXTERNAL_CHECKS = [
  'canonical-checkout-unchanged',
  'final-history-contains-candidates',
  'final-tree-verified',
  'openhands-conversations-absent',
  'plan-refs-absent',
  'provider-processes-absent',
] as const;

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface AutonomousAcceptanceSnapshot {
  release:
    | { status: 'HEALTHY'; sourceSha: string; artifactSha256: string }
    | { status: string; sourceSha?: string; artifactSha256?: string };
  expectedRelease: { sourceSha: string; artifactSha256: string };
  canonicalHead: string;
  externalChecks: readonly string[];
  plan: {
    planId: string;
    projectKey: string;
    baseRevision: string;
    currentRevision: string;
    status: string;
  };
  workItems: readonly {
    workItemId: string;
    itemKey: string;
    status: string;
    wave?: number;
    integrationBaseRevision?: string;
    exactAcceptedRevision?: string;
  }[];
  executions: readonly {
    executionId: string;
    workItemId?: string;
    phase: string;
    status: string;
    sourceRevision?: string;
    resultRevision?: string;
    createdAt: string;
  }[];
  reviews: readonly {
    reviewId: string;
    workItemId?: string;
    implementationExecutionId: string;
    reviewerExecutionId?: string;
    reviewedSha?: string;
    status: string;
    verdict?: string;
  }[];
  providerSessions: readonly {
    executionId: string;
    providerSessionId: string;
    cleanupProven: boolean;
  }[];
  worktrees: readonly { state: string }[];
  lease?: {
    activeRootPlanId?: string;
    committedRevision?: string;
    version: number;
  };
  activationFailureCount: number;
}

export interface AutonomousLifecycleAttestation {
  version: 1;
  sourceSha: string;
  artifactSha256: string;
  planId: string;
  projectKey: string;
  canonicalHead: string;
  logicalBaseRevision: string;
  finalRevision: string;
  wave: number;
  implementationStartDeltaMs: number;
  workItemIds: string[];
  acceptedRevisions: string[];
  implementationExecutionIds: string[];
  reviewerExecutionIds: string[];
  reviewIds: string[];
  providerSessionCount: number;
  worktreeCount: number;
  leaseVersion: number;
  activationFailureCount: 0;
  externalChecks: string[];
}

function requireSha(value: string, code: string): void {
  failClosed(SHA1.test(value), code);
}

export function releaseAcceptanceAggregateId(sourceSha: string): string {
  requireSha(sourceSha, 'RELEASE_ACCEPTANCE_SOURCE_SHA_INVALID');
  return 'release-acceptance:' + sourceSha;
}

export function validateAutonomousLifecycleAcceptance(
  snapshot: AutonomousAcceptanceSnapshot,
  options: { parallelStartMaxDeltaMs?: number } = {},
): AutonomousLifecycleAttestation {
  failClosed(snapshot.release.status === 'HEALTHY', 'RELEASE_ACCEPTANCE_RELEASE_NOT_HEALTHY');
  const release = snapshot.release as Extract<AutonomousAcceptanceSnapshot['release'], { status: 'HEALTHY' }>;
  requireSha(release.sourceSha, 'RELEASE_ACCEPTANCE_SOURCE_SHA_INVALID');
  failClosed(SHA256.test(release.artifactSha256), 'RELEASE_ACCEPTANCE_ARTIFACT_SHA_INVALID');
  failClosed(
    release.sourceSha === snapshot.expectedRelease.sourceSha &&
      release.artifactSha256 === snapshot.expectedRelease.artifactSha256,
    'RELEASE_ACCEPTANCE_RELEASE_CHANGED',
  );
  requireSha(snapshot.canonicalHead, 'RELEASE_ACCEPTANCE_CANONICAL_SHA_INVALID');
  failClosed(snapshot.plan.status === 'SUCCEEDED', 'RELEASE_ACCEPTANCE_PLAN_NOT_SUCCEEDED');
  failClosed(snapshot.workItems.length === 2, 'RELEASE_ACCEPTANCE_WORK_ITEM_COUNT_INVALID');
  failClosed(
    snapshot.activationFailureCount === 0,
    'RELEASE_ACCEPTANCE_ACTIVATION_FAILURE_OBSERVED',
  );

  const requiredExternal = new Set(AUTONOMOUS_ACCEPTANCE_REQUIRED_EXTERNAL_CHECKS);
  const providedExternal = new Set(snapshot.externalChecks);
  failClosed(
    providedExternal.size === snapshot.externalChecks.length &&
      [...requiredExternal].every((check) => providedExternal.has(check)) &&
      providedExternal.size === requiredExternal.size,
    'RELEASE_ACCEPTANCE_EXTERNAL_CHECKS_INCOMPLETE',
  );

  const waves = new Set(snapshot.workItems.map((item) => item.wave));
  const bases = new Set(snapshot.workItems.map((item) => item.integrationBaseRevision));
  failClosed(waves.size === 1 && Number.isInteger([...waves][0]) && Number([...waves][0]) > 0, 'RELEASE_ACCEPTANCE_PARALLEL_WAVE_INVALID');
  failClosed(
    bases.size === 1 && [...bases][0] === snapshot.plan.baseRevision,
    'RELEASE_ACCEPTANCE_PARALLEL_BASE_INVALID',
  );
  const wave = Number([...waves][0]);

  const acceptedRevisions: string[] = [];
  const implementationExecutionIds: string[] = [];
  const reviewerExecutionIds: string[] = [];
  const reviewIds: string[] = [];
  const firstImplementationStarts: number[] = [];

  for (const item of snapshot.workItems) {
    failClosed(item.status === 'SUCCEEDED', 'RELEASE_ACCEPTANCE_WORK_ITEM_NOT_SUCCEEDED');
    failClosed(Boolean(item.exactAcceptedRevision), 'RELEASE_ACCEPTANCE_ACCEPTED_REVISION_MISSING');
    const acceptedRevision = item.exactAcceptedRevision!;
    requireSha(acceptedRevision, 'RELEASE_ACCEPTANCE_ACCEPTED_REVISION_INVALID');
    const implementations = snapshot.executions
      .filter(
        (execution) =>
          execution.workItemId === item.workItemId && execution.phase === 'IMPLEMENT',
      )
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    failClosed(implementations.length > 0, 'RELEASE_ACCEPTANCE_IMPLEMENTATION_MISSING');
    const firstStart = Date.parse(implementations[0]!.createdAt);
    failClosed(Number.isFinite(firstStart), 'RELEASE_ACCEPTANCE_IMPLEMENTATION_TIME_INVALID');
    firstImplementationStarts.push(firstStart);
    const implementation = implementations.find(
      (execution) =>
        execution.status === 'SUCCEEDED' && execution.resultRevision === acceptedRevision,
    );
    failClosed(Boolean(implementation), 'RELEASE_ACCEPTANCE_ACCEPTED_IMPLEMENTATION_MISSING');
    failClosed(
      implementation!.sourceRevision === snapshot.plan.baseRevision,
      'RELEASE_ACCEPTANCE_IMPLEMENTATION_BASE_MISMATCH',
    );
    const review = snapshot.reviews.find(
      (candidate) =>
        candidate.workItemId === item.workItemId &&
        candidate.implementationExecutionId === implementation!.executionId &&
        candidate.status === 'PASSED' &&
        candidate.verdict === 'PASS' &&
        candidate.reviewedSha === acceptedRevision,
    );
    failClosed(Boolean(review?.reviewerExecutionId), 'RELEASE_ACCEPTANCE_EXACT_REVIEW_MISSING');
    failClosed(
      review!.reviewerExecutionId !== implementation!.executionId,
      'RELEASE_ACCEPTANCE_REVIEW_NOT_INDEPENDENT',
    );
    const reviewer = snapshot.executions.find(
      (execution) => execution.executionId === review!.reviewerExecutionId,
    );
    failClosed(
      Boolean(reviewer) &&
        reviewer!.phase === 'REVIEW' &&
        reviewer!.status === 'SUCCEEDED' &&
        reviewer!.sourceRevision === acceptedRevision &&
        reviewer!.resultRevision === acceptedRevision,
      'RELEASE_ACCEPTANCE_REVIEW_EXECUTION_INVALID',
    );
    acceptedRevisions.push(acceptedRevision);
    implementationExecutionIds.push(implementation!.executionId);
    reviewerExecutionIds.push(reviewer!.executionId);
    reviewIds.push(review!.reviewId);
  }

  const delta = Math.max(...firstImplementationStarts) - Math.min(...firstImplementationStarts);
  const maxDelta = options.parallelStartMaxDeltaMs ?? 5_000;
  failClosed(
    Number.isFinite(delta) && delta >= 0 && delta <= maxDelta,
    'RELEASE_ACCEPTANCE_PARALLEL_START_DELTA_EXCEEDED',
  );
  failClosed(
    snapshot.plan.currentRevision !== snapshot.plan.baseRevision,
    'RELEASE_ACCEPTANCE_FINAL_REVISION_NOT_ADVANCED',
  );
  requireSha(snapshot.plan.currentRevision, 'RELEASE_ACCEPTANCE_FINAL_REVISION_INVALID');
  failClosed(snapshot.worktrees.length > 0, 'RELEASE_ACCEPTANCE_WORKTREES_MISSING');
  failClosed(
    snapshot.worktrees.every((worktree) => worktree.state === 'RETIRED'),
    'RELEASE_ACCEPTANCE_WORKTREE_RETIREMENT_INCOMPLETE',
  );
  failClosed(Boolean(snapshot.lease), 'RELEASE_ACCEPTANCE_PROJECT_LEASE_MISSING');
  failClosed(!snapshot.lease!.activeRootPlanId, 'RELEASE_ACCEPTANCE_PROJECT_LEASE_ACTIVE');
  failClosed(
    snapshot.lease!.committedRevision === snapshot.plan.currentRevision,
    'RELEASE_ACCEPTANCE_PROJECT_HEAD_MISMATCH',
  );
  failClosed(
    Number.isInteger(snapshot.lease!.version) && snapshot.lease!.version > 0,
    'RELEASE_ACCEPTANCE_LEASE_VERSION_INVALID',
  );
  failClosed(snapshot.providerSessions.length >= 4, 'RELEASE_ACCEPTANCE_PROVIDER_SESSION_COUNT_TOO_LOW');
  failClosed(
    snapshot.providerSessions.every((session) => session.cleanupProven),
    'RELEASE_ACCEPTANCE_PROVIDER_CLEANUP_INCOMPLETE',
  );
  const providerExecutionIds = new Set(snapshot.providerSessions.map((session) => session.executionId));
  failClosed(
    [...implementationExecutionIds, ...reviewerExecutionIds].every((executionId) => providerExecutionIds.has(executionId)),
    'RELEASE_ACCEPTANCE_ACCEPTED_SESSION_MISSING',
  );

  return {
    version: 1,
    sourceSha: release.sourceSha,
    artifactSha256: release.artifactSha256,
    planId: snapshot.plan.planId,
    projectKey: snapshot.plan.projectKey,
    canonicalHead: snapshot.canonicalHead,
    logicalBaseRevision: snapshot.plan.baseRevision,
    finalRevision: snapshot.plan.currentRevision,
    wave,
    implementationStartDeltaMs: delta,
    workItemIds: snapshot.workItems.map((item) => item.workItemId).sort(),
    acceptedRevisions: acceptedRevisions.sort(),
    implementationExecutionIds: implementationExecutionIds.sort(),
    reviewerExecutionIds: reviewerExecutionIds.sort(),
    reviewIds: reviewIds.sort(),
    providerSessionCount: snapshot.providerSessions.length,
    worktreeCount: snapshot.worktrees.length,
    leaseVersion: snapshot.lease!.version,
    activationFailureCount: 0,
    externalChecks: [...requiredExternal].sort(),
  };
}

export function decodeAutonomousLifecycleAttestation(value: unknown): AutonomousLifecycleAttestation {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ForgeFlowError('RELEASE_ACCEPTANCE_EVENT_INVALID');
  const candidate = value as Record<string, unknown>;
  const stringArray = (key: string, exactLength?: number): string[] => {
    const raw = candidate[key];
    if (
      !Array.isArray(raw) ||
      !raw.every((item) => typeof item === 'string' && item.length > 0) ||
      (exactLength !== undefined && raw.length !== exactLength)
    )
      throw new ForgeFlowError('RELEASE_ACCEPTANCE_EVENT_INVALID');
    return raw as string[];
  };
  if (
    candidate.version !== 1 ||
    typeof candidate.sourceSha !== 'string' ||
    !SHA1.test(candidate.sourceSha) ||
    typeof candidate.artifactSha256 !== 'string' ||
    !SHA256.test(candidate.artifactSha256) ||
    typeof candidate.planId !== 'string' ||
    !candidate.planId ||
    typeof candidate.projectKey !== 'string' ||
    !candidate.projectKey ||
    typeof candidate.canonicalHead !== 'string' ||
    !SHA1.test(candidate.canonicalHead) ||
    typeof candidate.logicalBaseRevision !== 'string' ||
    !SHA1.test(candidate.logicalBaseRevision) ||
    typeof candidate.finalRevision !== 'string' ||
    !SHA1.test(candidate.finalRevision) ||
    !Number.isInteger(candidate.wave) ||
    Number(candidate.wave) <= 0 ||
    !Number.isInteger(candidate.implementationStartDeltaMs) ||
    Number(candidate.implementationStartDeltaMs) < 0 ||
    !Number.isInteger(candidate.providerSessionCount) ||
    Number(candidate.providerSessionCount) < 4 ||
    !Number.isInteger(candidate.worktreeCount) ||
    Number(candidate.worktreeCount) <= 0 ||
    !Number.isInteger(candidate.leaseVersion) ||
    Number(candidate.leaseVersion) <= 0 ||
    candidate.activationFailureCount !== 0
  )
    throw new ForgeFlowError('RELEASE_ACCEPTANCE_EVENT_INVALID');
  const workItemIds = stringArray('workItemIds', 2);
  const acceptedRevisions = stringArray('acceptedRevisions', 2);
  if (!acceptedRevisions.every((revision) => SHA1.test(revision)))
    throw new ForgeFlowError('RELEASE_ACCEPTANCE_EVENT_INVALID');
  const implementationExecutionIds = stringArray('implementationExecutionIds', 2);
  const reviewerExecutionIds = stringArray('reviewerExecutionIds', 2);
  const reviewIds = stringArray('reviewIds', 2);
  const externalChecks = stringArray('externalChecks');
  const requiredExternal = [...AUTONOMOUS_ACCEPTANCE_REQUIRED_EXTERNAL_CHECKS].sort();
  if (
    JSON.stringify([...new Set(externalChecks)].sort()) !== JSON.stringify(requiredExternal)
  )
    throw new ForgeFlowError('RELEASE_ACCEPTANCE_EVENT_INVALID');
  return {
    version: 1,
    sourceSha: candidate.sourceSha,
    artifactSha256: candidate.artifactSha256,
    planId: candidate.planId,
    projectKey: candidate.projectKey,
    canonicalHead: candidate.canonicalHead,
    logicalBaseRevision: candidate.logicalBaseRevision,
    finalRevision: candidate.finalRevision,
    wave: Number(candidate.wave),
    implementationStartDeltaMs: Number(candidate.implementationStartDeltaMs),
    workItemIds,
    acceptedRevisions,
    implementationExecutionIds,
    reviewerExecutionIds,
    reviewIds,
    providerSessionCount: Number(candidate.providerSessionCount),
    worktreeCount: Number(candidate.worktreeCount),
    leaseVersion: Number(candidate.leaseVersion),
    activationFailureCount: 0,
    externalChecks,
  };
}
