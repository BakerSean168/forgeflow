import { createHash } from 'node:crypto';

import type { ExecutionResourceSelection } from '../domain/resourceRouting.js';
import type { ImprovementCandidate, ImprovementDiagnosisProposal } from './registry.js';

export interface ImprovementDiagnosisObservation {
  evidenceRef: string;
  phase: string;
  errorCode: string;
  route: string;
  status: 'FAILED' | 'BLOCKED';
  retryable: boolean | null;
  updatedAt: string;
}

export interface ImprovementDiagnosisInput {
  candidateId: string;
  programId: string;
  fingerprint: string;
  projectKey: string;
  currentRisk: ImprovementCandidate['risk'];
  failurePattern: {
    phase: string;
    errorCode: string;
    observedCount: number;
  };
  observations: ImprovementDiagnosisObservation[];
}

export interface ImprovementDiagnosisResult {
  contextDigest: string;
  proposal: ImprovementDiagnosisProposal;
  selection: ExecutionResourceSelection;
}

export interface ImprovementDiagnosisClientPort {
  diagnose(input: ImprovementDiagnosisInput): Promise<ImprovementDiagnosisResult>;
}

export function improvementDiagnosisContextDigest(input: ImprovementDiagnosisInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        candidateId: input.candidateId,
        programId: input.programId,
        fingerprint: input.fingerprint,
        projectKey: input.projectKey,
        failurePattern: input.failurePattern,
        observations: input.observations,
      }),
    )
    .digest('hex');
}

export interface SelfChangeCanaryInput {
  candidateId: string;
  planId: string;
  sourceRevision: string;
}

export interface SelfChangeCanaryResult {
  sourceRevision: string;
  artifactSha256: string;
  result: 'PASSED' | 'FAILED';
  checks: string[];
  observedAt: string;
}

export interface SelfChangeCanaryPort {
  run(input: SelfChangeCanaryInput): Promise<SelfChangeCanaryResult>;
}

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
