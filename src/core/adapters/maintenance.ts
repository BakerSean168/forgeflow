import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { DuplicateKeyError, ForgeFlowError, failClosed } from '../domain/errors.js';
import { EventStore } from '../persistence/eventStore.js';
import { assertCurrentSchema, openDatabase, withTransaction } from '../persistence/database.js';

export interface MaintenanceProgram {
  programId: string;
  projectKey: string;
  repositoryPath?: string;
  /** Legacy route hints are retained for durable compatibility. Normal improvement Plans use Resource Selector policy. */
  implementationRoutes?: string[];
  reviewRoutes?: string[];
  autonomousScope: 'CONSERVATIVE' | 'STANDARD';
  autoMerge: boolean;
  enabled: boolean;
  failureCodePrefixes?: string[];
  failureThreshold?: number;
  recentExecutionLimit?: number;
  candidateRisk?: ImprovementCandidate['risk'];
}

export interface ImprovementCanaryAttestation {
  attestationId: string;
  candidateId: string;
  planId: string;
  sourceRevision: string;
  artifactSha256: string;
  result: 'PASSED' | 'FAILED';
  checks: string[];
  observedAt: string;
  createdAt: string;
}

export interface ImprovementSelfPromotionRequest {
  requestId: string;
  candidateId: string;
  planId: string;
  sourceRevision: string;
  artifactSha256: string;
  canaryAttestationId: string;
  requestedAt: string;
  createdAt: string;
}

export interface ImprovementSelfPromotion {
  promotionId: string;
  candidateId: string;
  planId: string;
  sourceRevision: string;
  artifactSha256: string;
  canaryAttestationId: string;
  releasedAt: string;
  createdAt: string;
}

export const IMPROVEMENT_DIAGNOSIS_CLASSIFICATIONS = [
  'PROCESS_DESIGN',
  'WORKSPACE_LIFECYCLE',
  'RESOURCE_ROUTING',
  'REVIEW_QUALITY',
  'DELIVERY_PIPELINE',
  'CONTRACT_TESTING',
  'RECOVERY_LOGIC',
  'UNKNOWN',
] as const;
export type ImprovementDiagnosisClassification =
  (typeof IMPROVEMENT_DIAGNOSIS_CLASSIFICATIONS)[number];

export const IMPROVEMENT_DIAGNOSIS_DISPOSITIONS = ['PROPOSE_REPAIR', 'NO_ACTION'] as const;
export type ImprovementDiagnosisDisposition =
  (typeof IMPROVEMENT_DIAGNOSIS_DISPOSITIONS)[number];

export const IMPROVEMENT_DIAGNOSIS_CONFIDENCES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type ImprovementDiagnosisConfidence = (typeof IMPROVEMENT_DIAGNOSIS_CONFIDENCES)[number];

export interface ImprovementDiagnosisProposal {
  version: 1;
  candidateId: string;
  programId: string;
  fingerprint: string;
  disposition: ImprovementDiagnosisDisposition;
  classification: ImprovementDiagnosisClassification;
  confidence: ImprovementDiagnosisConfidence;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  diagnosis: string;
  objective: string;
  acceptanceCriteria: string[];
  evidenceRefs: string[];
}

export interface ImprovementDiagnosisAttestation extends ImprovementDiagnosisProposal {
  diagnosisId: string;
  contextDigest: string;
  effectiveRisk: 'LOW' | 'MEDIUM' | 'HIGH';
  resourceId: string;
  bindingId?: string;
  modelFamily: string;
  routeModel: string;
  protocol: string;
  createdAt: string;
}

export interface ImprovementCandidate {
  candidateId: string;
  programId: string;
  fingerprint: string;
  title: string;
  evidence: string[];
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  status: 'DISCOVERED' | 'QUEUED' | 'ADOPTED' | 'REJECTED' | 'STALE' | 'COMPLETED';
  planId?: string;
  pullRequestId?: string;
}

interface ProgramRow {
  program_id: string;
  project_key: string;
  policy: string;
  status: string;
}

interface CandidateRow {
  candidate_id: string;
  program_id: string;
  fingerprint: string;
  title: string;
  evidence: string;
  risk: ImprovementCandidate['risk'];
  status: ImprovementCandidate['status'];
  plan_id: string | null;
  pull_request_id: string | null;
}

const CANDIDATE_RISKS = new Set<ImprovementCandidate['risk']>(['LOW', 'MEDIUM', 'HIGH']);
const DIAGNOSIS_CLASSIFICATIONS = new Set<ImprovementDiagnosisClassification>(
  IMPROVEMENT_DIAGNOSIS_CLASSIFICATIONS,
);
const DIAGNOSIS_DISPOSITIONS = new Set<ImprovementDiagnosisDisposition>(
  IMPROVEMENT_DIAGNOSIS_DISPOSITIONS,
);
const DIAGNOSIS_CONFIDENCES = new Set<ImprovementDiagnosisConfidence>(
  IMPROVEMENT_DIAGNOSIS_CONFIDENCES,
);
const CANDIDATE_STATUSES = new Set<ImprovementCandidate['status']>([
  'DISCOVERED',
  'QUEUED',
  'ADOPTED',
  'REJECTED',
  'STALE',
  'COMPLETED',
]);
const PROGRAM_SCOPES = new Set<MaintenanceProgram['autonomousScope']>(['CONSERVATIVE', 'STANDARD']);
const CANDIDATE_TRANSITIONS: Readonly<Record<ImprovementCandidate['status'], readonly ImprovementCandidate['status'][]>> = {
  DISCOVERED: ['QUEUED', 'ADOPTED', 'REJECTED', 'STALE'],
  QUEUED: ['ADOPTED', 'REJECTED', 'STALE'],
  ADOPTED: ['COMPLETED', 'STALE'],
  REJECTED: [],
  STALE: [],
  COMPLETED: [],
};

function decodeEvidence(value: string): string[] {
  try {
    const decoded = JSON.parse(value) as unknown;
    if (
      !Array.isArray(decoded) ||
      decoded.length === 0 ||
      !decoded.every((item) => typeof item === 'string' && item.trim().length > 0)
    ) {
      throw new Error('invalid evidence');
    }
    return decoded;
  } catch (error) {
    throw new ForgeFlowError(
      'CORRUPTED_CANDIDATE_EVIDENCE',
      'Candidate evidence is not a non-empty string array.',
      error,
    );
  }
}

function validateCanaryAttestation(attestation: ImprovementCanaryAttestation): void {
  failClosed(attestation.attestationId.trim().length > 0, 'IMPROVEMENT_CANARY_ATTESTATION_ID_REQUIRED');
  failClosed(attestation.candidateId.trim().length > 0, 'CANDIDATE_ID_REQUIRED');
  failClosed(attestation.planId.trim().length > 0, 'CANDIDATE_PLAN_INPUT_INVALID');
  failClosed(/^[0-9a-f]{40}$/.test(attestation.sourceRevision), 'IMPROVEMENT_CANARY_REVISION_INVALID');
  failClosed(/^[0-9a-f]{64}$/.test(attestation.artifactSha256), 'IMPROVEMENT_CANARY_ARTIFACT_INVALID');
  failClosed(
    attestation.result === 'PASSED' || attestation.result === 'FAILED',
    'IMPROVEMENT_CANARY_RESULT_INVALID',
  );
  failClosed(
    Array.isArray(attestation.checks) &&
      attestation.checks.length > 0 &&
      attestation.checks.length <= 32 &&
      attestation.checks.every((item) => /^[A-Za-z0-9_.:/-]{1,200}$/.test(item)),
    'IMPROVEMENT_CANARY_CHECKS_INVALID',
  );
  failClosed(
    Number.isFinite(Date.parse(attestation.observedAt)) && Number.isFinite(Date.parse(attestation.createdAt)),
    'IMPROVEMENT_CANARY_TIME_INVALID',
  );
}

function canaryFromEvent(
  event: ReturnType<EventStore['get']> extends infer T ? Exclude<T, undefined> : never,
): ImprovementCanaryAttestation {
  if (event.type !== 'IMPROVEMENT_CANARY_ATTESTED' || event.aggregateType !== 'MAINTENANCE')
    throw new ForgeFlowError('CORRUPTED_IMPROVEMENT_CANARY_EVENT');
  const payload = event.payload as Record<string, unknown>;
  const attestation: ImprovementCanaryAttestation = {
    attestationId: event.eventId,
    candidateId: event.aggregateId,
    planId: String(payload.planId ?? ''),
    sourceRevision: String(payload.sourceRevision ?? ''),
    artifactSha256: String(payload.artifactSha256 ?? ''),
    result: payload.result as ImprovementCanaryAttestation['result'],
    checks: Array.isArray(payload.checks) ? payload.checks.map(String) : [],
    observedAt: String(payload.observedAt ?? ''),
    createdAt: event.occurredAt,
  };
  validateCanaryAttestation(attestation);
  return attestation;
}

function selfPromotionRequestFromEvent(
  event: ReturnType<EventStore['get']> extends infer T ? Exclude<T, undefined> : never,
): ImprovementSelfPromotionRequest {
  if (event.type !== 'IMPROVEMENT_SELF_PROMOTION_REQUESTED' || event.aggregateType !== 'MAINTENANCE')
    throw new ForgeFlowError('CORRUPTED_IMPROVEMENT_PROMOTION_REQUEST_EVENT');
  const payload = event.payload as Record<string, unknown>;
  const request: ImprovementSelfPromotionRequest = {
    requestId: event.eventId,
    candidateId: event.aggregateId,
    planId: String(payload.planId ?? ''),
    sourceRevision: String(payload.sourceRevision ?? ''),
    artifactSha256: String(payload.artifactSha256 ?? ''),
    canaryAttestationId: String(payload.canaryAttestationId ?? ''),
    requestedAt: String(payload.requestedAt ?? ''),
    createdAt: event.occurredAt,
  };
  failClosed(request.requestId.trim().length > 0, 'IMPROVEMENT_PROMOTION_REQUEST_ID_REQUIRED');
  failClosed(request.candidateId.trim().length > 0, 'CANDIDATE_ID_REQUIRED');
  failClosed(request.planId.trim().length > 0, 'CANDIDATE_PLAN_INPUT_INVALID');
  failClosed(/^[0-9a-f]{40}$/.test(request.sourceRevision), 'IMPROVEMENT_PROMOTION_REVISION_INVALID');
  failClosed(/^[0-9a-f]{64}$/.test(request.artifactSha256), 'IMPROVEMENT_PROMOTION_ARTIFACT_INVALID');
  failClosed(request.canaryAttestationId.trim().length > 0, 'IMPROVEMENT_PROMOTION_CANARY_REQUIRED');
  failClosed(
    Number.isFinite(Date.parse(request.requestedAt)) && Number.isFinite(Date.parse(request.createdAt)),
    'IMPROVEMENT_PROMOTION_TIME_INVALID',
  );
  return request;
}

function selfPromotionFromEvent(
  event: ReturnType<EventStore['get']> extends infer T ? Exclude<T, undefined> : never,
): ImprovementSelfPromotion {
  if (event.type !== 'IMPROVEMENT_SELF_PROMOTED' || event.aggregateType !== 'MAINTENANCE')
    throw new ForgeFlowError('CORRUPTED_IMPROVEMENT_PROMOTION_EVENT');
  const payload = event.payload as Record<string, unknown>;
  const promotion: ImprovementSelfPromotion = {
    promotionId: event.eventId,
    candidateId: event.aggregateId,
    planId: String(payload.planId ?? ''),
    sourceRevision: String(payload.sourceRevision ?? ''),
    artifactSha256: String(payload.artifactSha256 ?? ''),
    canaryAttestationId: String(payload.canaryAttestationId ?? ''),
    releasedAt: String(payload.releasedAt ?? ''),
    createdAt: event.occurredAt,
  };
  failClosed(promotion.promotionId.trim().length > 0, 'IMPROVEMENT_PROMOTION_ID_REQUIRED');
  failClosed(promotion.candidateId.trim().length > 0, 'CANDIDATE_ID_REQUIRED');
  failClosed(promotion.planId.trim().length > 0, 'CANDIDATE_PLAN_INPUT_INVALID');
  failClosed(/^[0-9a-f]{40}$/.test(promotion.sourceRevision), 'IMPROVEMENT_PROMOTION_REVISION_INVALID');
  failClosed(/^[0-9a-f]{64}$/.test(promotion.artifactSha256), 'IMPROVEMENT_PROMOTION_ARTIFACT_INVALID');
  failClosed(promotion.canaryAttestationId.trim().length > 0, 'IMPROVEMENT_PROMOTION_CANARY_REQUIRED');
  failClosed(
    Number.isFinite(Date.parse(promotion.releasedAt)) && Number.isFinite(Date.parse(promotion.createdAt)),
    'IMPROVEMENT_PROMOTION_TIME_INVALID',
  );
  return promotion;
}

function diagnosisText(value: string, code: string, maximum: number): string {
  failClosed(!/[\u0000-\u001f\u007f]/.test(value), code);
  const normalized = value.replace(/\s+/g, ' ').trim();
  failClosed(normalized.length > 0 && normalized.length <= maximum, code);
  return normalized;
}

function diagnosisStringList(
  values: string[],
  code: string,
  minimum: number,
  maximumItems: number,
  maximumText: number,
): string[] {
  failClosed(Array.isArray(values), code);
  const normalized = values.map((item) => diagnosisText(String(item), code, maximumText));
  failClosed(
    normalized.length >= minimum &&
      normalized.length <= maximumItems &&
      new Set(normalized).size === normalized.length,
    code,
  );
  return normalized;
}

function assertSafeDiagnosisProposalText(values: readonly string[]): void {
  const combined = values.join(' ');
  failClosed(
    !/(?:disable|skip|bypass|weaken|remove|turn\s+off).{0,50}(?:test|review|safety|gate|approval|policy)/i.test(
      combined,
    ),
    'IMPROVEMENT_DIAGNOSIS_UNSAFE_PROPOSAL',
  );
  failClosed(
    !/(?:password|api[_ -]?key|private[_ -]?key|bearer[_ -]?token|access[_ -]?token|credential|secret)/i.test(
      combined,
    ),
    'IMPROVEMENT_DIAGNOSIS_UNSAFE_PROPOSAL',
  );
}

function effectiveDiagnosisRisk(
  current: ImprovementCandidate['risk'],
  proposed: ImprovementCandidate['risk'],
): ImprovementCandidate['risk'] {
  const rank: Record<ImprovementCandidate['risk'], number> = { LOW: 1, MEDIUM: 2, HIGH: 3 };
  return rank[proposed] > rank[current] ? proposed : current;
}

function validateDiagnosisAttestation(attestation: ImprovementDiagnosisAttestation): void {
  failClosed(attestation.version === 1, 'IMPROVEMENT_DIAGNOSIS_VERSION_INVALID');
  for (const [value, code, maximum] of [
    [attestation.diagnosisId, 'IMPROVEMENT_DIAGNOSIS_ID_REQUIRED', 200],
    [attestation.candidateId, 'CANDIDATE_ID_REQUIRED', 200],
    [attestation.programId, 'MAINTENANCE_PROGRAM_REQUIRED', 200],
    [attestation.fingerprint, 'CANDIDATE_FINGERPRINT_KEY_INVALID', 64],
    [attestation.contextDigest, 'IMPROVEMENT_DIAGNOSIS_CONTEXT_INVALID', 64],
    [attestation.resourceId, 'IMPROVEMENT_DIAGNOSIS_RESOURCE_REQUIRED', 500],
    [attestation.modelFamily, 'IMPROVEMENT_DIAGNOSIS_MODEL_REQUIRED', 500],
    [attestation.routeModel, 'IMPROVEMENT_DIAGNOSIS_ROUTE_REQUIRED', 500],
    [attestation.protocol, 'IMPROVEMENT_DIAGNOSIS_PROTOCOL_REQUIRED', 200],
  ] as const)
    failClosed(
      value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value),
      code,
    );
  failClosed(/^[0-9a-f]{64}$/.test(attestation.fingerprint), 'CANDIDATE_FINGERPRINT_KEY_INVALID');
  failClosed(/^[0-9a-f]{64}$/.test(attestation.contextDigest), 'IMPROVEMENT_DIAGNOSIS_CONTEXT_INVALID');
  if (attestation.bindingId !== undefined)
    failClosed(
      attestation.bindingId.trim().length > 0 && attestation.bindingId.length <= 500,
      'IMPROVEMENT_DIAGNOSIS_BINDING_INVALID',
    );
  failClosed(
    DIAGNOSIS_DISPOSITIONS.has(attestation.disposition),
    'IMPROVEMENT_DIAGNOSIS_DISPOSITION_INVALID',
  );
  failClosed(
    DIAGNOSIS_CLASSIFICATIONS.has(attestation.classification),
    'IMPROVEMENT_DIAGNOSIS_CLASSIFICATION_INVALID',
  );
  failClosed(
    DIAGNOSIS_CONFIDENCES.has(attestation.confidence),
    'IMPROVEMENT_DIAGNOSIS_CONFIDENCE_INVALID',
  );
  failClosed(
    CANDIDATE_RISKS.has(attestation.risk) && CANDIDATE_RISKS.has(attestation.effectiveRisk),
    'CANDIDATE_RISK_INVALID',
  );
  diagnosisText(attestation.diagnosis, 'IMPROVEMENT_DIAGNOSIS_TEXT_INVALID', 1_500);
  if (attestation.disposition === 'PROPOSE_REPAIR') {
    diagnosisText(attestation.objective, 'IMPROVEMENT_DIAGNOSIS_OBJECTIVE_INVALID', 2_000);
    diagnosisStringList(
      attestation.acceptanceCriteria,
      'IMPROVEMENT_DIAGNOSIS_ACCEPTANCE_INVALID',
      2,
      8,
      500,
    );
    assertSafeDiagnosisProposalText([
      attestation.diagnosis,
      attestation.objective,
      ...attestation.acceptanceCriteria,
    ]);
  } else {
    failClosed(attestation.objective === '', 'IMPROVEMENT_DIAGNOSIS_NO_ACTION_OBJECTIVE');
    failClosed(
      attestation.acceptanceCriteria.length === 0,
      'IMPROVEMENT_DIAGNOSIS_NO_ACTION_ACCEPTANCE',
    );
  }
  diagnosisStringList(
    attestation.evidenceRefs,
    'IMPROVEMENT_DIAGNOSIS_EVIDENCE_INVALID',
    1,
    12,
    200,
  );
  failClosed(Number.isFinite(Date.parse(attestation.createdAt)), 'IMPROVEMENT_DIAGNOSIS_TIME_INVALID');
}

function diagnosisFromEvent(
  event: ReturnType<EventStore['get']> extends infer T ? Exclude<T, undefined> : never,
): ImprovementDiagnosisAttestation {
  if (event.type !== 'IMPROVEMENT_AI_DIAGNOSED' || event.aggregateType !== 'MAINTENANCE')
    throw new ForgeFlowError('CORRUPTED_IMPROVEMENT_DIAGNOSIS_EVENT');
  const payload = event.payload as Record<string, unknown>;
  const attestation: ImprovementDiagnosisAttestation = {
    diagnosisId: event.eventId,
    version: payload.version as 1,
    candidateId: event.aggregateId,
    programId: String(payload.programId ?? ''),
    fingerprint: String(payload.fingerprint ?? ''),
    contextDigest: String(payload.contextDigest ?? ''),
    disposition: payload.disposition as ImprovementDiagnosisDisposition,
    classification: payload.classification as ImprovementDiagnosisClassification,
    confidence: payload.confidence as ImprovementDiagnosisConfidence,
    risk: payload.risk as ImprovementCandidate['risk'],
    effectiveRisk: payload.effectiveRisk as ImprovementCandidate['risk'],
    diagnosis: String(payload.diagnosis ?? ''),
    objective: String(payload.objective ?? ''),
    acceptanceCriteria: Array.isArray(payload.acceptanceCriteria)
      ? payload.acceptanceCriteria.map(String)
      : [],
    evidenceRefs: Array.isArray(payload.evidenceRefs)
      ? payload.evidenceRefs.map(String)
      : [],
    resourceId: String(payload.resourceId ?? ''),
    ...(typeof payload.bindingId === 'string' ? { bindingId: payload.bindingId } : {}),
    modelFamily: String(payload.modelFamily ?? ''),
    routeModel: String(payload.routeModel ?? ''),
    protocol: String(payload.protocol ?? ''),
    createdAt: event.occurredAt,
  };
  validateDiagnosisAttestation(attestation);
  return attestation;
}

function normalizedStringList(values: string[] | undefined, code: string): string[] {
  if (!values) return [];
  failClosed(Array.isArray(values), code);
  const normalized = [...new Set(values.map((item) => item.trim()).filter(Boolean))].sort();
  failClosed(normalized.length === values.length, code);
  return normalized;
}

function normalizedProgram(program: MaintenanceProgram): MaintenanceProgram {
  failClosed(
    program.programId.trim().length > 0 && program.projectKey.trim().length > 0,
    'MAINTENANCE_PROGRAM_INVALID',
  );
  failClosed(PROGRAM_SCOPES.has(program.autonomousScope), 'MAINTENANCE_PROGRAM_SCOPE_INVALID');
  failClosed(typeof program.autoMerge === 'boolean' && typeof program.enabled === 'boolean', 'MAINTENANCE_PROGRAM_INVALID');
  if (program.repositoryPath !== undefined)
    failClosed(program.repositoryPath.trim().length > 0, 'MAINTENANCE_REPOSITORY_INVALID');
  const implementationRoutes = normalizedStringList(
    program.implementationRoutes,
    'MAINTENANCE_IMPLEMENTATION_ROUTE_INVALID',
  );
  const reviewRoutes = normalizedStringList(program.reviewRoutes, 'MAINTENANCE_REVIEW_ROUTE_INVALID');
  const failureCodePrefixes = normalizedStringList(
    program.failureCodePrefixes,
    'MAINTENANCE_FAILURE_PREFIX_INVALID',
  );
  const failureThreshold = program.failureThreshold ?? 3;
  const recentExecutionLimit = program.recentExecutionLimit ?? 200;
  failClosed(
    Number.isInteger(failureThreshold) && failureThreshold >= 2 && failureThreshold <= 100,
    'MAINTENANCE_FAILURE_THRESHOLD_INVALID',
  );
  failClosed(
    Number.isInteger(recentExecutionLimit) && recentExecutionLimit >= failureThreshold && recentExecutionLimit <= 5_000,
    'MAINTENANCE_EXECUTION_LIMIT_INVALID',
  );
  const candidateRisk = program.candidateRisk ?? 'LOW';
  failClosed(CANDIDATE_RISKS.has(candidateRisk), 'CANDIDATE_RISK_INVALID');
  return {
    programId: program.programId.trim(),
    projectKey: program.projectKey.trim(),
    ...(program.repositoryPath ? { repositoryPath: program.repositoryPath.trim() } : {}),
    ...(implementationRoutes.length > 0 ? { implementationRoutes } : {}),
    ...(reviewRoutes.length > 0 ? { reviewRoutes } : {}),
    autonomousScope: program.autonomousScope,
    autoMerge: program.autoMerge,
    enabled: program.enabled,
    ...(failureCodePrefixes.length > 0 ? { failureCodePrefixes } : {}),
    failureThreshold,
    recentExecutionLimit,
    candidateRisk,
  };
}

function programPolicy(program: MaintenanceProgram): string {
  const normalized = normalizedProgram(program);
  return JSON.stringify({
    repositoryPath: normalized.repositoryPath ?? null,
    implementationRoutes: normalized.implementationRoutes ?? [],
    reviewRoutes: normalized.reviewRoutes ?? [],
    autonomousScope: normalized.autonomousScope,
    autoMerge: normalized.autoMerge,
    failureCodePrefixes: normalized.failureCodePrefixes ?? [],
    failureThreshold: normalized.failureThreshold,
    recentExecutionLimit: normalized.recentExecutionLimit,
    candidateRisk: normalized.candidateRisk,
  });
}

function programFrom(row: ProgramRow): MaintenanceProgram {
  let policy: Record<string, unknown>;
  try {
    const decoded = JSON.parse(row.policy) as unknown;
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded))
      throw new Error('policy must be object');
    policy = decoded as Record<string, unknown>;
  } catch (error) {
    throw new ForgeFlowError('CORRUPTED_MAINTENANCE_POLICY', 'Maintenance policy is not a JSON object.', error);
  }
  const stringArray = (key: string): string[] => {
    const value = policy[key];
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
      throw new ForgeFlowError('CORRUPTED_MAINTENANCE_POLICY');
    return value;
  };
  if (policy.autonomousScope !== 'CONSERVATIVE' && policy.autonomousScope !== 'STANDARD')
    throw new ForgeFlowError('CORRUPTED_MAINTENANCE_POLICY');
  if (typeof policy.autoMerge !== 'boolean')
    throw new ForgeFlowError('CORRUPTED_MAINTENANCE_POLICY');
  if (
    policy.candidateRisk !== undefined &&
    policy.candidateRisk !== 'LOW' &&
    policy.candidateRisk !== 'MEDIUM' &&
    policy.candidateRisk !== 'HIGH'
  )
    throw new ForgeFlowError('CORRUPTED_MAINTENANCE_POLICY');
  if (policy.failureThreshold !== undefined && typeof policy.failureThreshold !== 'number')
    throw new ForgeFlowError('CORRUPTED_MAINTENANCE_POLICY');
  if (policy.recentExecutionLimit !== undefined && typeof policy.recentExecutionLimit !== 'number')
    throw new ForgeFlowError('CORRUPTED_MAINTENANCE_POLICY');
  if (row.status !== 'ACTIVE' && row.status !== 'DISABLED')
    throw new ForgeFlowError('CORRUPTED_MAINTENANCE_PROGRAM_STATE');
  return normalizedProgram({
    programId: row.program_id,
    projectKey: row.project_key,
    ...(typeof policy.repositoryPath === 'string' && policy.repositoryPath.trim()
      ? { repositoryPath: policy.repositoryPath }
      : policy.repositoryPath === null || policy.repositoryPath === undefined
        ? {}
        : (() => {
            throw new ForgeFlowError('CORRUPTED_MAINTENANCE_POLICY');
          })()),
    ...(stringArray('implementationRoutes').length > 0
      ? { implementationRoutes: stringArray('implementationRoutes') }
      : {}),
    ...(stringArray('reviewRoutes').length > 0 ? { reviewRoutes: stringArray('reviewRoutes') } : {}),
    autonomousScope: policy.autonomousScope,
    autoMerge: policy.autoMerge,
    enabled: row.status === 'ACTIVE',
    ...(stringArray('failureCodePrefixes').length > 0
      ? { failureCodePrefixes: stringArray('failureCodePrefixes') }
      : {}),
    failureThreshold: typeof policy.failureThreshold === 'number' ? policy.failureThreshold : 3,
    recentExecutionLimit:
      typeof policy.recentExecutionLimit === 'number' ? policy.recentExecutionLimit : 200,
    candidateRisk:
      policy.candidateRisk === 'MEDIUM' || policy.candidateRisk === 'HIGH'
        ? policy.candidateRisk
        : 'LOW',
  });
}

function fromRow(row: CandidateRow): ImprovementCandidate {
  if (!row.candidate_id.trim() || !row.program_id.trim() || !row.fingerprint.trim() || !row.title.trim()) {
    throw new ForgeFlowError('CORRUPTED_CANDIDATE_IDENTITY');
  }
  if (!CANDIDATE_RISKS.has(row.risk) || !CANDIDATE_STATUSES.has(row.status)) {
    throw new ForgeFlowError('CORRUPTED_CANDIDATE_STATE');
  }
  if (row.plan_id !== null && !row.plan_id.trim()) throw new ForgeFlowError('CORRUPTED_CANDIDATE_IDENTITY');
  if (row.pull_request_id !== null && !row.pull_request_id.trim()) throw new ForgeFlowError('CORRUPTED_CANDIDATE_IDENTITY');
  return {
    candidateId: row.candidate_id,
    programId: row.program_id,
    fingerprint: row.fingerprint,
    title: row.title,
    evidence: decodeEvidence(row.evidence),
    risk: row.risk,
    status: row.status,
    planId: row.plan_id ?? undefined,
    pullRequestId: row.pull_request_id ?? undefined,
  };
}

function normalizedEvidence(evidence: string[]): string[] {
  const values = evidence.map((item) => item.trim());
  failClosed(values.length > 0 && values.every((item) => item.length > 0), 'CANDIDATE_EVIDENCE_INVALID');
  return values;
}

export class MaintenanceCandidateRegistry {
  readonly events: EventStore;

  constructor(
    readonly db: DatabaseSync = openDatabase(':memory:', {
      environment: 'test',
      env: { NODE_ENV: 'test' },
    }),
  ) {
    assertCurrentSchema(this.db);
    this.events = new EventStore(this.db);
  }

  upsertProgram(program: MaintenanceProgram): MaintenanceProgram {
    const normalized = normalizedProgram(program);
    const policy = programPolicy(normalized);
    return withTransaction(this.db, () => {
      const now = new Date().toISOString();
      const durable = this.db
        .prepare('SELECT * FROM maintenance_programs WHERE program_id=?')
        .get(normalized.programId) as ProgramRow | undefined;
      if (durable) {
        const existing = programFrom(durable);
        if (
          durable.project_key !== normalized.projectKey ||
          programPolicy(existing) !== policy ||
          existing.enabled !== normalized.enabled
        )
          throw new ForgeFlowError('MAINTENANCE_PROGRAM_CONFLICT');
        return existing;
      }
      this.db
        .prepare(
          'INSERT INTO maintenance_programs(program_id,project_key,policy,status,created_at,updated_at) VALUES(?,?,?,?,?,?)',
        )
        .run(
          normalized.programId,
          normalized.projectKey,
          policy,
          normalized.enabled ? 'ACTIVE' : 'DISABLED',
          now,
          now,
        );
      this.events.appendInTransaction({
        eventId: randomUUID(),
        aggregateId: normalized.programId,
        aggregateType: 'MAINTENANCE',
        type: 'MAINTENANCE_PROGRAM_CREATED',
        payload: { projectKey: normalized.projectKey, enabled: normalized.enabled },
        occurredAt: now,
        correlationId: normalized.programId,
      });
      return this.getProgram(normalized.programId);
    });
  }

  getProgram(programId: string): MaintenanceProgram {
    const row = this.db
      .prepare('SELECT * FROM maintenance_programs WHERE program_id=?')
      .get(programId) as ProgramRow | undefined;
    if (!row) throw new ForgeFlowError('MAINTENANCE_PROGRAM_NOT_FOUND');
    return programFrom(row);
  }

  listPrograms(): MaintenanceProgram[] {
    return (
      this.db
        .prepare('SELECT * FROM maintenance_programs ORDER BY program_id')
        .all() as unknown as ProgramRow[]
    ).map(programFrom);
  }

  setProgramEnabled(programId: string, enabled: boolean): MaintenanceProgram {
    failClosed(programId.trim().length > 0, 'MAINTENANCE_PROGRAM_REQUIRED');
    failClosed(typeof enabled === 'boolean', 'MAINTENANCE_PROGRAM_STATE_INVALID');
    return withTransaction(this.db, () => {
      const current = this.getProgram(programId);
      if (current.enabled === enabled) return current;
      const from = current.enabled ? 'ACTIVE' : 'DISABLED';
      const to = enabled ? 'ACTIVE' : 'DISABLED';
      const now = new Date().toISOString();
      const result = this.db
        .prepare(
          'UPDATE maintenance_programs SET status=?,updated_at=? WHERE program_id=? AND status=?',
        )
        .run(to, now, programId, from);
      if (Number(result.changes) !== 1)
        throw new ForgeFlowError('MAINTENANCE_PROGRAM_STATE_STALE');
      this.events.appendInTransaction({
        eventId: randomUUID(),
        aggregateId: programId,
        aggregateType: 'MAINTENANCE',
        type: 'MAINTENANCE_PROGRAM_STATUS_CHANGED',
        payload: { from, to },
        occurredAt: now,
        correlationId: programId,
      });
      return this.getProgram(programId);
    });
  }

  create(
    program: MaintenanceProgram,
    input: {
      candidateId?: string;
      title: string;
      evidence: string[];
      risk: ImprovementCandidate['risk'];
      fingerprintKey?: string;
    },
  ): { status: 'created' | 'existing'; candidate: ImprovementCandidate } {
    const durableProgram = this.upsertProgram(program);
    failClosed(durableProgram.enabled, 'MAINTENANCE_PROGRAM_DISABLED');
    const title = input.title.trim();
    failClosed(title.length > 0, 'CANDIDATE_TITLE_REQUIRED');
    failClosed(CANDIDATE_RISKS.has(input.risk), 'CANDIDATE_RISK_INVALID');
    const evidence = normalizedEvidence(input.evidence);
    const fingerprintIdentity = input.fingerprintKey?.trim();
    if (input.fingerprintKey !== undefined)
      failClosed(Boolean(fingerprintIdentity), 'CANDIDATE_FINGERPRINT_KEY_INVALID');
    const fingerprint = createHash('sha256')
      .update(
        fingerprintIdentity
          ? [durableProgram.projectKey, fingerprintIdentity].join('|')
          : [durableProgram.projectKey, title, ...[...evidence].sort()].join('|'),
      )
      .digest('hex');

    return withTransaction(this.db, () => {
      const now = new Date().toISOString();
      const durable = this.db
        .prepare('SELECT * FROM improvement_candidates WHERE fingerprint=?')
        .get(fingerprint) as CandidateRow | undefined;
      if (durable) {
        const candidate = fromRow(durable);
        const same =
          candidate.programId === durableProgram.programId &&
          candidate.title === title &&
          candidate.risk === input.risk &&
          JSON.stringify(candidate.evidence) === JSON.stringify(evidence);
        if (!same) throw new DuplicateKeyError(fingerprint);
        return { status: 'existing', candidate };
      }

      const candidate: ImprovementCandidate = {
        candidateId: input.candidateId ?? 'candidate-' + fingerprint.slice(0, 20),
        programId: durableProgram.programId,
        fingerprint,
        title,
        evidence,
        risk: input.risk,
        status: 'DISCOVERED',
      };
      const idConflict = this.db
        .prepare('SELECT candidate_id FROM improvement_candidates WHERE candidate_id=?')
        .get(candidate.candidateId);
      if (idConflict) throw new DuplicateKeyError(candidate.candidateId);
      this.db
        .prepare(
          'INSERT INTO improvement_candidates(candidate_id,program_id,fingerprint,title,evidence,status,plan_id,pull_request_id,risk,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          candidate.candidateId,
          candidate.programId,
          candidate.fingerprint,
          candidate.title,
          JSON.stringify(candidate.evidence),
          candidate.status,
          null,
          null,
          candidate.risk,
          now,
          now,
        );
      this.events.appendInTransaction({
        eventId: randomUUID(),
        aggregateId: candidate.candidateId,
        aggregateType: 'MAINTENANCE',
        type: 'IMPROVEMENT_CANDIDATE_DISCOVERED',
        payload: {
          programId: candidate.programId,
          risk: candidate.risk,
          fingerprint: candidate.fingerprint,
        },
        occurredAt: now,
        correlationId: candidate.programId,
      });
      return { status: 'created', candidate };
    });
  }

  get(candidateId: string): ImprovementCandidate {
    const row = this.db
      .prepare('SELECT * FROM improvement_candidates WHERE candidate_id=?')
      .get(candidateId) as CandidateRow | undefined;
    if (!row) throw new ForgeFlowError('CANDIDATE_NOT_FOUND');
    return fromRow(row);
  }

  list(input: { programId?: string; status?: ImprovementCandidate['status']; limit?: number } = {}): ImprovementCandidate[] {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 1_000));
    if (input.status !== undefined)
      failClosed(CANDIDATE_STATUSES.has(input.status), 'CANDIDATE_STATUS_INVALID');
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (input.programId) {
      clauses.push('program_id=?');
      values.push(input.programId);
    }
    if (input.status) {
      clauses.push('status=?');
      values.push(input.status);
    }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    return (
      this.db
        .prepare(
          'SELECT * FROM improvement_candidates' + where + ' ORDER BY updated_at DESC,candidate_id LIMIT ?',
        )
        .all(...values, limit) as unknown as CandidateRow[]
    ).map(fromRow);
  }

  transition(
    candidateId: string,
    next: ImprovementCandidate['status'],
  ): ImprovementCandidate {
    failClosed(CANDIDATE_STATUSES.has(next), 'CANDIDATE_STATUS_INVALID');
    return withTransaction(this.db, () => {
      const current = this.get(candidateId);
      if (current.status === next) return current;
      if (!CANDIDATE_TRANSITIONS[current.status].includes(next))
        throw new ForgeFlowError('CANDIDATE_TRANSITION_INVALID');
      const now = new Date().toISOString();
      const result = this.db
        .prepare('UPDATE improvement_candidates SET status=?,updated_at=? WHERE candidate_id=? AND status=?')
        .run(next, now, candidateId, current.status);
      if (Number(result.changes) !== 1) throw new ForgeFlowError('CANDIDATE_STATUS_STALE');
      this.events.appendInTransaction({
        eventId: randomUUID(),
        aggregateId: candidateId,
        aggregateType: 'MAINTENANCE',
        type: 'IMPROVEMENT_CANDIDATE_STATUS_CHANGED',
        payload: { from: current.status, to: next },
        occurredAt: now,
        correlationId: current.programId,
      });
      return this.get(candidateId);
    });
  }

  attachPlan(candidateId: string, planId: string): ImprovementCandidate {
    failClosed(
      candidateId.trim().length > 0 && planId.trim().length > 0,
      'CANDIDATE_PLAN_INPUT_INVALID',
    );
    return withTransaction(this.db, () => {
      const candidate = this.get(candidateId);
      if (candidate.planId === planId) return candidate;
      if (candidate.planId) throw new ForgeFlowError('CANDIDATE_PLAN_IMMUTABLE');
      if (candidate.status !== 'DISCOVERED' && candidate.status !== 'QUEUED')
        throw new ForgeFlowError('CANDIDATE_NOT_ADOPTABLE');
      if (!this.db.prepare('SELECT plan_id FROM plans WHERE plan_id=?').get(planId))
        throw new ForgeFlowError('PLAN_NOT_FOUND');
      const now = new Date().toISOString();
      const result = this.db
        .prepare(
          'UPDATE improvement_candidates SET plan_id=?,status=?,updated_at=? WHERE candidate_id=? AND plan_id IS NULL AND status=?',
        )
        .run(planId, 'ADOPTED', now, candidateId, candidate.status);
      if (Number(result.changes) !== 1) throw new ForgeFlowError('CANDIDATE_PLAN_STALE');
      this.events.appendInTransaction({
        eventId: randomUUID(),
        aggregateId: candidateId,
        aggregateType: 'MAINTENANCE',
        type: 'IMPROVEMENT_PLAN_ATTACHED',
        payload: { planId },
        occurredAt: now,
        correlationId: candidate.programId,
      });
      return this.get(candidateId);
    });
  }

  recordDiagnosis(
    candidateId: string,
    input: {
      contextDigest: string;
      proposal: ImprovementDiagnosisProposal;
      resourceId: string;
      bindingId?: string;
      modelFamily: string;
      routeModel: string;
      protocol: string;
    },
  ): ImprovementDiagnosisAttestation {
    const candidate = this.get(candidateId);
    failClosed(/^[0-9a-f]{64}$/.test(input.contextDigest), 'IMPROVEMENT_DIAGNOSIS_CONTEXT_INVALID');
    failClosed(input.proposal.version === 1, 'IMPROVEMENT_DIAGNOSIS_VERSION_INVALID');
    failClosed(input.proposal.candidateId === candidateId, 'IMPROVEMENT_DIAGNOSIS_CANDIDATE_MISMATCH');
    failClosed(input.proposal.programId === candidate.programId, 'IMPROVEMENT_DIAGNOSIS_PROGRAM_MISMATCH');
    failClosed(input.proposal.fingerprint === candidate.fingerprint, 'IMPROVEMENT_DIAGNOSIS_FINGERPRINT_MISMATCH');
    failClosed(CANDIDATE_RISKS.has(input.proposal.risk), 'CANDIDATE_RISK_INVALID');
    const effectiveRisk = effectiveDiagnosisRisk(candidate.risk, input.proposal.risk);
    const diagnosisId =
      'improvement-diagnosis-' +
      createHash('sha256').update(candidateId + '|' + input.contextDigest).digest('hex');
    const existing = this.events.get(diagnosisId);
    if (existing) return diagnosisFromEvent(existing);
    const now = new Date().toISOString();
    const attestation: ImprovementDiagnosisAttestation = {
      diagnosisId,
      ...input.proposal,
      contextDigest: input.contextDigest,
      effectiveRisk,
      resourceId: input.resourceId,
      ...(input.bindingId ? { bindingId: input.bindingId } : {}),
      modelFamily: input.modelFamily,
      routeModel: input.routeModel,
      protocol: input.protocol,
      createdAt: now,
    };
    validateDiagnosisAttestation(attestation);
    return withTransaction(this.db, () => {
      const latest = this.get(candidateId);
      if (latest.fingerprint !== candidate.fingerprint || latest.programId !== candidate.programId)
        throw new ForgeFlowError('IMPROVEMENT_DIAGNOSIS_CANDIDATE_STALE');
      const durableRisk = effectiveDiagnosisRisk(latest.risk, input.proposal.risk);
      if (durableRisk !== latest.risk) {
        const result = this.db
          .prepare(
            'UPDATE improvement_candidates SET risk=?,updated_at=? WHERE candidate_id=? AND risk=?',
          )
          .run(durableRisk, now, candidateId, latest.risk);
        if (Number(result.changes) !== 1)
          throw new ForgeFlowError('IMPROVEMENT_DIAGNOSIS_RISK_STALE');
      }
      const event = this.events.appendInTransaction({
        eventId: diagnosisId,
        aggregateId: candidateId,
        aggregateType: 'MAINTENANCE',
        type: 'IMPROVEMENT_AI_DIAGNOSED',
        payload: {
          version: 1,
          programId: attestation.programId,
          fingerprint: attestation.fingerprint,
          contextDigest: attestation.contextDigest,
          disposition: attestation.disposition,
          classification: attestation.classification,
          confidence: attestation.confidence,
          risk: attestation.risk,
          effectiveRisk: durableRisk,
          diagnosis: diagnosisText(
            attestation.diagnosis,
            'IMPROVEMENT_DIAGNOSIS_TEXT_INVALID',
            1_500,
          ),
          objective:
            attestation.disposition === 'PROPOSE_REPAIR'
              ? diagnosisText(
                  attestation.objective,
                  'IMPROVEMENT_DIAGNOSIS_OBJECTIVE_INVALID',
                  2_000,
                )
              : '',
          acceptanceCriteria:
            attestation.disposition === 'PROPOSE_REPAIR'
              ? diagnosisStringList(
                  attestation.acceptanceCriteria,
                  'IMPROVEMENT_DIAGNOSIS_ACCEPTANCE_INVALID',
                  2,
                  8,
                  500,
                )
              : [],
          evidenceRefs: diagnosisStringList(
            attestation.evidenceRefs,
            'IMPROVEMENT_DIAGNOSIS_EVIDENCE_INVALID',
            1,
            12,
            200,
          ),
          resourceId: attestation.resourceId,
          ...(attestation.bindingId ? { bindingId: attestation.bindingId } : {}),
          modelFamily: attestation.modelFamily,
          routeModel: attestation.routeModel,
          protocol: attestation.protocol,
        },
        occurredAt: now,
        correlationId: candidate.programId,
      });
      return diagnosisFromEvent(event);
    });
  }

  listDiagnoses(candidateId: string): ImprovementDiagnosisAttestation[] {
    this.get(candidateId);
    return this.events
      .listByAggregate(candidateId)
      .filter((event) => event.type === 'IMPROVEMENT_AI_DIAGNOSED')
      .map(diagnosisFromEvent);
  }

  latestDiagnosis(candidateId: string): ImprovementDiagnosisAttestation | undefined {
    return this.listDiagnoses(candidateId).at(-1);
  }

  recordCanary(
    candidateId: string,
    input: {
      idempotencyKey: string;
      planId: string;
      sourceRevision: string;
      artifactSha256: string;
      result: ImprovementCanaryAttestation['result'];
      checks: string[];
      observedAt?: string;
    },
  ): ImprovementCanaryAttestation {
    const candidate = this.get(candidateId);
    failClosed(
      input.idempotencyKey.trim().length > 0 && input.idempotencyKey.length <= 1_000,
      'IMPROVEMENT_CANARY_IDEMPOTENCY_REQUIRED',
    );
    const attestationId =
      'improvement-canary-' + createHash('sha256').update(input.idempotencyKey.trim()).digest('hex');
    const normalized = {
      planId: input.planId.trim(),
      sourceRevision: input.sourceRevision.trim(),
      artifactSha256: input.artifactSha256.trim(),
      result: input.result,
      checks: [...new Set(input.checks.map((item) => item.trim()))].sort(),
    };
    const existing = this.events.get(attestationId);
    if (existing) {
      const durable = canaryFromEvent(existing);
      if (
        durable.candidateId !== candidateId ||
        durable.planId !== normalized.planId ||
        durable.sourceRevision !== normalized.sourceRevision ||
        durable.artifactSha256 !== normalized.artifactSha256 ||
        durable.result !== normalized.result ||
        JSON.stringify(durable.checks) !== JSON.stringify(normalized.checks) ||
        (input.observedAt !== undefined && durable.observedAt !== input.observedAt)
      )
        throw new DuplicateKeyError(attestationId);
      return durable;
    }
    const now = new Date().toISOString();
    const attestation: ImprovementCanaryAttestation = {
      attestationId,
      candidateId,
      ...normalized,
      observedAt: input.observedAt ?? now,
      createdAt: now,
    };
    validateCanaryAttestation(attestation);
    failClosed(candidate.planId === attestation.planId, 'IMPROVEMENT_CANARY_PLAN_MISMATCH');
    const event = this.events.append({
      eventId: attestation.attestationId,
      aggregateId: candidateId,
      aggregateType: 'MAINTENANCE',
      type: 'IMPROVEMENT_CANARY_ATTESTED',
      payload: {
        planId: attestation.planId,
        sourceRevision: attestation.sourceRevision,
        artifactSha256: attestation.artifactSha256,
        result: attestation.result,
        checks: attestation.checks,
        observedAt: attestation.observedAt,
      },
      occurredAt: attestation.createdAt,
      correlationId: candidate.programId,
    });
    return canaryFromEvent(event);
  }

  listCanaryAttestations(candidateId: string): ImprovementCanaryAttestation[] {
    this.get(candidateId);
    return this.events
      .listByAggregate(candidateId)
      .filter((event) => event.type === 'IMPROVEMENT_CANARY_ATTESTED')
      .map(canaryFromEvent);
  }

  latestPassingCanary(
    candidateId: string,
    sourceRevision: string,
  ): ImprovementCanaryAttestation | undefined {
    return this.listCanaryAttestations(candidateId)
      .filter((item) => item.sourceRevision === sourceRevision && item.result === 'PASSED')
      .at(-1);
  }

  recordSelfPromotionRequest(
    candidateId: string,
    input: {
      planId: string;
      sourceRevision: string;
      artifactSha256: string;
      canaryAttestationId: string;
      requestedAt?: string;
    },
  ): ImprovementSelfPromotionRequest {
    const candidate = this.get(candidateId);
    failClosed(candidate.planId === input.planId, 'IMPROVEMENT_PROMOTION_PLAN_MISMATCH');
    failClosed(/^[0-9a-f]{40}$/.test(input.sourceRevision), 'IMPROVEMENT_PROMOTION_REVISION_INVALID');
    failClosed(/^[0-9a-f]{64}$/.test(input.artifactSha256), 'IMPROVEMENT_PROMOTION_ARTIFACT_INVALID');
    const canary = this.events.get(input.canaryAttestationId);
    if (!canary) throw new ForgeFlowError('IMPROVEMENT_PROMOTION_CANARY_NOT_FOUND');
    const attestation = canaryFromEvent(canary);
    failClosed(attestation.candidateId === candidateId, 'IMPROVEMENT_PROMOTION_CANARY_MISMATCH');
    failClosed(attestation.planId === input.planId, 'IMPROVEMENT_PROMOTION_CANARY_MISMATCH');
    failClosed(attestation.sourceRevision === input.sourceRevision, 'IMPROVEMENT_PROMOTION_CANARY_MISMATCH');
    failClosed(attestation.artifactSha256 === input.artifactSha256, 'IMPROVEMENT_PROMOTION_CANARY_MISMATCH');
    failClosed(attestation.result === 'PASSED', 'IMPROVEMENT_PROMOTION_CANARY_FAILED');
    const requestId =
      'improvement-promotion-request-' +
      createHash('sha256')
        .update([candidateId, input.planId, input.sourceRevision, input.artifactSha256, input.canaryAttestationId].join('|'))
        .digest('hex');
    const existing = this.events.get(requestId);
    if (existing) return selfPromotionRequestFromEvent(existing);
    const now = new Date().toISOString();
    const requestedAt = input.requestedAt ?? now;
    failClosed(Number.isFinite(Date.parse(requestedAt)), 'IMPROVEMENT_PROMOTION_TIME_INVALID');
    const event = this.events.append({
      eventId: requestId,
      aggregateId: candidateId,
      aggregateType: 'MAINTENANCE',
      type: 'IMPROVEMENT_SELF_PROMOTION_REQUESTED',
      payload: {
        planId: input.planId,
        sourceRevision: input.sourceRevision,
        artifactSha256: input.artifactSha256,
        canaryAttestationId: input.canaryAttestationId,
        requestedAt,
      },
      occurredAt: now,
      correlationId: candidate.programId,
    });
    return selfPromotionRequestFromEvent(event);
  }

  listSelfPromotionRequests(candidateId: string): ImprovementSelfPromotionRequest[] {
    this.get(candidateId);
    return this.events
      .listByAggregate(candidateId)
      .filter((event) => event.type === 'IMPROVEMENT_SELF_PROMOTION_REQUESTED')
      .map(selfPromotionRequestFromEvent);
  }

  latestSelfPromotionRequest(candidateId: string): ImprovementSelfPromotionRequest | undefined {
    return this.listSelfPromotionRequests(candidateId).at(-1);
  }

  recordSelfPromotion(
    candidateId: string,
    input: {
      planId: string;
      sourceRevision: string;
      artifactSha256: string;
      canaryAttestationId: string;
      releasedAt: string;
    },
  ): ImprovementSelfPromotion {
    const candidate = this.get(candidateId);
    failClosed(candidate.planId === input.planId, 'IMPROVEMENT_PROMOTION_PLAN_MISMATCH');
    failClosed(/^[0-9a-f]{40}$/.test(input.sourceRevision), 'IMPROVEMENT_PROMOTION_REVISION_INVALID');
    failClosed(/^[0-9a-f]{64}$/.test(input.artifactSha256), 'IMPROVEMENT_PROMOTION_ARTIFACT_INVALID');
    failClosed(Number.isFinite(Date.parse(input.releasedAt)), 'IMPROVEMENT_PROMOTION_TIME_INVALID');
    const request = this.latestSelfPromotionRequest(candidateId);
    if (
      !request ||
      request.planId !== input.planId ||
      request.sourceRevision !== input.sourceRevision ||
      request.artifactSha256 !== input.artifactSha256 ||
      request.canaryAttestationId !== input.canaryAttestationId
    )
      throw new ForgeFlowError('IMPROVEMENT_PROMOTION_REQUEST_MISMATCH');
    failClosed(
      Date.parse(input.releasedAt) >= Date.parse(request.requestedAt),
      'IMPROVEMENT_PROMOTION_TIME_INVALID',
    );
    const eventId =
      'improvement-promotion-' +
      createHash('sha256')
        .update([candidateId, input.planId, input.sourceRevision, input.artifactSha256, input.canaryAttestationId].join('|'))
        .digest('hex');
    const canary = this.events.get(input.canaryAttestationId);
    if (!canary) throw new ForgeFlowError('IMPROVEMENT_PROMOTION_CANARY_NOT_FOUND');
    const attestation = canaryFromEvent(canary);
    failClosed(attestation.candidateId === candidateId, 'IMPROVEMENT_PROMOTION_CANARY_MISMATCH');
    failClosed(attestation.planId === input.planId, 'IMPROVEMENT_PROMOTION_CANARY_MISMATCH');
    failClosed(attestation.sourceRevision === input.sourceRevision, 'IMPROVEMENT_PROMOTION_CANARY_MISMATCH');
    failClosed(attestation.artifactSha256 === input.artifactSha256, 'IMPROVEMENT_PROMOTION_CANARY_MISMATCH');
    failClosed(attestation.result === 'PASSED', 'IMPROVEMENT_PROMOTION_CANARY_FAILED');
    const existing = this.events.get(eventId);
    if (existing) return selfPromotionFromEvent(existing);
    const event = this.events.append({
      eventId,
      aggregateId: candidateId,
      aggregateType: 'MAINTENANCE',
      type: 'IMPROVEMENT_SELF_PROMOTED',
      payload: {
        planId: input.planId,
        sourceRevision: input.sourceRevision,
        artifactSha256: input.artifactSha256,
        canaryAttestationId: input.canaryAttestationId,
        releasedAt: input.releasedAt,
      },
      occurredAt: new Date().toISOString(),
      correlationId: candidate.programId,
    });
    return selfPromotionFromEvent(event);
  }

  listSelfPromotions(candidateId: string): ImprovementSelfPromotion[] {
    this.get(candidateId);
    return this.events
      .listByAggregate(candidateId)
      .filter((event) => event.type === 'IMPROVEMENT_SELF_PROMOTED')
      .map(selfPromotionFromEvent);
  }

  latestSelfPromotion(candidateId: string): ImprovementSelfPromotion | undefined {
    return this.listSelfPromotions(candidateId).at(-1);
  }

  attachPullRequest(candidateId: string, pullRequestId: string): ImprovementCandidate {
    failClosed(pullRequestId.trim().length > 0, 'CANDIDATE_PULL_REQUEST_INVALID');
    return withTransaction(this.db, () => {
      const current = this.get(candidateId);
      if (current.pullRequestId === pullRequestId) return current;
      if (current.pullRequestId) throw new ForgeFlowError('CANDIDATE_PULL_REQUEST_IMMUTABLE');
      const result = this.db
        .prepare(
          'UPDATE improvement_candidates SET pull_request_id=?,updated_at=? WHERE candidate_id=? AND pull_request_id IS NULL',
        )
        .run(pullRequestId, new Date().toISOString(), candidateId);
      if (Number(result.changes) !== 1) throw new ForgeFlowError('CANDIDATE_PULL_REQUEST_STALE');
      return this.get(candidateId);
    });
  }
}
