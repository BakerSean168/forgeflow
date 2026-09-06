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
