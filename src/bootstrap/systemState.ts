import fs from 'node:fs';

import {
  AUTONOMOUS_ACCEPTANCE_EVENT,
  decodeAutonomousLifecycleAttestation,
  releaseAcceptanceAggregateId,
} from '../core/orchestration/releaseAcceptance.js';
import type { ForgeFlowRepositories } from '../core/persistence/repositories.js';

export type ReleaseProvenanceProjection =
  | { status: 'MISSING' | 'INVALID' | 'MISMATCH' }
  | {
      status: 'PENDING' | 'HEALTHY';
      version: 1;
      sourceSha: string;
      artifactSha256: string;
      releasedAt: string;
    };

export function readReleaseProvenance(file: string): ReleaseProvenanceProjection {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024)
      return { status: 'INVALID' };
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (
      value.version !== 1 ||
      (value.status !== 'PENDING' && value.status !== 'HEALTHY') ||
      typeof value.sourceSha !== 'string' ||
      !/^[0-9a-f]{40}$/.test(value.sourceSha) ||
      typeof value.artifactSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.artifactSha256) ||
      typeof value.releasedAt !== 'string' ||
      value.releasedAt.length > 64 ||
      !Number.isFinite(Date.parse(value.releasedAt))
    )
      return { status: 'INVALID' };
    return {
      status: value.status,
      version: 1,
      sourceSha: value.sourceSha,
      artifactSha256: value.artifactSha256,
      releasedAt: value.releasedAt,
    };
  } catch {
    return fs.existsSync(file) ? { status: 'INVALID' } : { status: 'MISSING' };
  }
}

export function bindReleaseProvenance(file: string): () => ReleaseProvenanceProjection {
  const boot = readReleaseProvenance(file);
  const valid = (value: ReleaseProvenanceProjection): value is Extract<
    ReleaseProvenanceProjection,
    { status: 'PENDING' | 'HEALTHY' }
  > => value.status === 'PENDING' || value.status === 'HEALTHY';
  return () => {
    const current = readReleaseProvenance(file);
    if (valid(boot) && valid(current)) {
      if (
        boot.sourceSha === current.sourceSha &&
        boot.artifactSha256 === current.artifactSha256 &&
        boot.releasedAt === current.releasedAt
      )
        return current;
      return { status: 'MISMATCH' };
    }
    if (!valid(boot) && !valid(current) && boot.status === current.status) return current;
    return { status: 'MISMATCH' };
  };
}

export type HostCacheMaintenanceProjection =
  | { status: 'DISABLED' | 'MISSING' | 'INVALID' }
  | {
      status: 'AVAILABLE';
      version: 1;
      checkedAt: string;
      action: string;
      reason: string;
      freeBytesBefore: number;
      freeBytesAfter: number;
      activeExecutions: number;
      triggerFreeBytes: number;
      targetFreeBytes: number;
      steps: string[];
    };

const HOST_CACHE_ACTIONS = new Set([
  'NOOP_CAPACITY_OK',
  'SKIPPED_RELEASE_ACTIVE',
  'SKIPPED_CONTROL_PLANE_UNAVAILABLE',
  'SKIPPED_ACTIVE_EXECUTION',
  'PRUNE_FAILED',
  'PRUNED_TARGET_REACHED',
  'PRUNED_PARTIAL',
  'CAPACITY_STILL_LOW',
]);
const HOST_CACHE_STEPS = new Set([
  'BUILDER_CACHE_OLDER_THAN_POLICY',
  'ALL_UNUSED_BUILDER_CACHE',
  'DANGLING_IMAGES',
  'OLD_UNUSED_IMAGES',
]);
const HOST_CACHE_REASONS = new Set([
  'FREE_SPACE_ABOVE_TRIGGER',
  'RELEASE_LOCK_HELD',
  'ACTIVE_EXECUTION_STATE_UNAVAILABLE',
  'FORGEFLOW_EXECUTION_RUNNING',
  'SAFE_RECLAIM_COMPLETED',
  'ABOVE_TRIGGER_BELOW_TARGET',
  'SAFE_RECLAIM_EXHAUSTED',
  ...HOST_CACHE_STEPS,
]);

export function readHostCacheMaintenance(file: string | undefined): HostCacheMaintenanceProjection {
  if (!file) return { status: 'DISABLED' };
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024)
      return { status: 'INVALID' };
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const numeric = [
      'freeBytesBefore',
      'freeBytesAfter',
      'activeExecutions',
      'triggerFreeBytes',
      'targetFreeBytes',
    ] as const;
    if (
      value.version !== 1 ||
      typeof value.checkedAt !== 'string' ||
      value.checkedAt.length > 64 ||
      !Number.isFinite(Date.parse(value.checkedAt)) ||
      typeof value.action !== 'string' ||
      !HOST_CACHE_ACTIONS.has(value.action) ||
      typeof value.reason !== 'string' ||
      !HOST_CACHE_REASONS.has(value.reason) ||
      !Array.isArray(value.steps) ||
      value.steps.some((item) => typeof item !== 'string' || !HOST_CACHE_STEPS.has(item)) ||
      numeric.some(
        (key) =>
          typeof value[key] !== 'number' ||
          !Number.isSafeInteger(value[key]) ||
          (value[key] as number) < 0,
      )
    )
      return { status: 'INVALID' };
    return {
      status: 'AVAILABLE',
      version: 1,
      checkedAt: value.checkedAt,
      action: value.action,
      reason: value.reason,
      freeBytesBefore: value.freeBytesBefore as number,
      freeBytesAfter: value.freeBytesAfter as number,
      activeExecutions: value.activeExecutions as number,
      triggerFreeBytes: value.triggerFreeBytes as number,
      targetFreeBytes: value.targetFreeBytes as number,
      steps: value.steps as string[],
    };
  } catch {
    return fs.existsSync(file) ? { status: 'INVALID' } : { status: 'MISSING' };
  }
}

export function createAutonomousLifecycleAcceptanceProjection(
  releaseProvenance: () => ReleaseProvenanceProjection,
  repositories: ForgeFlowRepositories,
) {
  return () => {
    const release = releaseProvenance();
    if (release.status !== 'HEALTHY')
      return { status: 'UNAVAILABLE' as const, releaseStatus: release.status };
    const aggregateId = releaseAcceptanceAggregateId(release.sourceSha);
    const candidates = repositories.events
      .listRecentByAggregate(aggregateId, 100)
      .filter((event) => event.type === AUTONOMOUS_ACCEPTANCE_EVENT)
      .reverse();
    for (const event of candidates) {
      try {
        const attestation = decodeAutonomousLifecycleAttestation(event.payload);
        if (attestation.artifactSha256 !== release.artifactSha256) continue;
        return {
          status: 'ATTESTED' as const,
          sourceSha: attestation.sourceSha,
          artifactSha256: attestation.artifactSha256,
          planId: attestation.planId,
          projectKey: attestation.projectKey,
          finalRevision: attestation.finalRevision,
          attestedAt: event.occurredAt,
        };
      } catch {
        return {
          status: 'INVALID' as const,
          sourceSha: release.sourceSha,
          artifactSha256: release.artifactSha256,
        };
      }
    }
    return {
      status: 'MISSING' as const,
      sourceSha: release.sourceSha,
      artifactSha256: release.artifactSha256,
    };
  };
}
