import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ForgeFlowError, failClosed } from '../domain/errors.js';

export interface SelfChangePromotionRequest {
  version: 1;
  candidateId: string;
  planId: string;
  sourceRevision: string;
  artifactSha256: string;
  canaryAttestationId: string;
  requestedAt: string;
}

export interface SelfChangePromotionQueuePort {
  request(input: SelfChangePromotionRequest): SelfChangePromotionRequest;
  current(): SelfChangePromotionRequest | undefined;
}

function validate(value: SelfChangePromotionRequest): void {
  const identity = /^[A-Za-z0-9._:-]{1,200}$/;
  failClosed(value.version === 1, 'IMPROVEMENT_PROMOTION_REQUEST_VERSION_INVALID');
  failClosed(identity.test(value.candidateId), 'CANDIDATE_ID_REQUIRED');
  failClosed(identity.test(value.planId), 'CANDIDATE_PLAN_INPUT_INVALID');
  failClosed(/^[0-9a-f]{40}$/.test(value.sourceRevision), 'IMPROVEMENT_PROMOTION_REVISION_INVALID');
  failClosed(/^[0-9a-f]{64}$/.test(value.artifactSha256), 'IMPROVEMENT_PROMOTION_ARTIFACT_INVALID');
  failClosed(identity.test(value.canaryAttestationId), 'IMPROVEMENT_PROMOTION_CANARY_REQUIRED');
  failClosed(
    value.requestedAt.length <= 64 &&
      !/[\u0000-\u001f\u007f]/.test(value.requestedAt) &&
      Number.isFinite(Date.parse(value.requestedAt)),
    'IMPROVEMENT_PROMOTION_TIME_INVALID',
  );
}

function decode(raw: string): SelfChangePromotionRequest {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ForgeFlowError(
      'IMPROVEMENT_PROMOTION_REQUEST_CORRUPTED',
      'Self-promotion request is not valid JSON.',
      error,
    );
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ForgeFlowError('IMPROVEMENT_PROMOTION_REQUEST_CORRUPTED');
  const record = value as Record<string, unknown>;
  const request: SelfChangePromotionRequest = {
    version: record.version as 1,
    candidateId: String(record.candidateId ?? ''),
    planId: String(record.planId ?? ''),
    sourceRevision: String(record.sourceRevision ?? ''),
    artifactSha256: String(record.artifactSha256 ?? ''),
    canaryAttestationId: String(record.canaryAttestationId ?? ''),
    requestedAt: String(record.requestedAt ?? ''),
  };
  validate(request);
  return request;
}

export class FileSelfChangePromotionQueue implements SelfChangePromotionQueuePort {
  readonly requestFile: string;

  constructor(requestFile: string) {
    this.requestFile = path.resolve(requestFile);
    failClosed(path.isAbsolute(this.requestFile), 'IMPROVEMENT_PROMOTION_REQUEST_PATH_INVALID');
  }

  current(): SelfChangePromotionRequest | undefined {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(this.requestFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    failClosed(
      stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16 * 1024,
      'IMPROVEMENT_PROMOTION_REQUEST_CORRUPTED',
    );
    return decode(fs.readFileSync(this.requestFile, 'utf8'));
  }

  request(input: SelfChangePromotionRequest): SelfChangePromotionRequest {
    validate(input);
    const existing = this.current();
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(input)) {
        const now = new Date();
        fs.utimesSync(this.requestFile, now, now);
        return existing;
      }
      throw new ForgeFlowError('IMPROVEMENT_PROMOTION_REQUEST_CONFLICT');
    }

    const directory = path.dirname(this.requestFile);
    fs.mkdirSync(directory, { recursive: true, mode: 0o711 });
    const directoryStat = fs.lstatSync(directory);
    failClosed(
      directoryStat.isDirectory() && !directoryStat.isSymbolicLink(),
      'IMPROVEMENT_PROMOTION_REQUEST_PATH_INVALID',
    );
    const temp = this.requestFile + '.tmp-' + randomUUID();
    const descriptor = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify(input) + '\n', 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    try {
      fs.renameSync(temp, this.requestFile);
    } catch (error) {
      fs.rmSync(temp, { force: true });
      throw error;
    }
    return input;
  }
}
