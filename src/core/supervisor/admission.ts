import { failClosed } from '../domain/errors.js';
import {
  validateSupervisorDirectAdmissionRecord,
  type SupervisorDirectAdmissionRecord,
} from '../domain/supervisor.js';
import type {
  ResourceCandidateReadinessPort,
  ResourceSelectionCandidate,
} from '../orchestration/resourceSelector.js';
import type { SupervisorDecisionInput } from './runtime.js';

export type SupervisorDirectAdmissionStatus = SupervisorDirectAdmissionRecord;

export interface SupervisorDirectAdmissionProbeResult {
  ready: boolean;
  errorCode?: string;
}

export interface SupervisorDirectAdmissionProbePort {
  probe(candidate: ResourceSelectionCandidate): Promise<SupervisorDirectAdmissionProbeResult>;
}

export function supervisorDirectAdmissionKey(candidate: ResourceSelectionCandidate): string {
  return [
    candidate.profile.resourceId,
    candidate.profile.bindingId ?? candidate.binding.bindingId,
    candidate.profile.modelFamily,
    candidate.profile.routeModel ?? '',
    candidate.profile.protocol ?? 'openai-chat-completions',
  ].join('|');
}

export function createSupervisorDirectAdmissionStatus(
  candidate: ResourceSelectionCandidate,
  input: { ready: boolean; checkedAt?: string; errorCode?: string },
): SupervisorDirectAdmissionStatus {
  const routeModel = candidate.profile.routeModel;
  failClosed(Boolean(routeModel), 'SUPERVISOR_DIRECT_ADMISSION_ROUTE_REQUIRED');
  const protocol = candidate.profile.protocol ?? 'openai-chat-completions';
  failClosed(
    protocol === 'openai-chat-completions' || protocol === 'openai-responses',
    'SUPERVISOR_ADMISSION_PROTOCOL_INVALID',
  );
  const status: SupervisorDirectAdmissionStatus = {
    admissionKey: supervisorDirectAdmissionKey(candidate),
    resourceId: candidate.profile.resourceId,
    bindingId: candidate.profile.bindingId ?? candidate.binding.bindingId,
    modelFamily: candidate.profile.modelFamily,
    routeModel: routeModel!,
    protocol,
    ready: input.ready,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    ...(input.errorCode ? { errorCode: input.errorCode.slice(0, 500) } : {}),
  };
  validateSupervisorDirectAdmissionRecord(status);
  return status;
}

export class SupervisorDirectAdmissionRegistry implements ResourceCandidateReadinessPort {
  private readonly statuses = new Map<string, SupervisorDirectAdmissionStatus>();

  isReady(candidate: ResourceSelectionCandidate): boolean {
    return this.statuses.get(supervisorDirectAdmissionKey(candidate))?.ready === true;
  }

  get(candidate: ResourceSelectionCandidate): SupervisorDirectAdmissionStatus | undefined {
    return this.statuses.get(supervisorDirectAdmissionKey(candidate));
  }

  record(
    candidate: ResourceSelectionCandidate,
    input: { ready: boolean; checkedAt?: string; errorCode?: string },
  ): SupervisorDirectAdmissionStatus {
    const status = createSupervisorDirectAdmissionStatus(candidate, input);
    this.restore([status]);
    return status;
  }

  restore(records: readonly SupervisorDirectAdmissionStatus[]): void {
    for (const record of records) {
      validateSupervisorDirectAdmissionRecord(record);
      this.statuses.set(record.admissionKey, record);
    }
  }

  isStale(
    candidate: ResourceSelectionCandidate,
    nowMs: number,
    readyTtlMs: number,
    failureTtlMs: number,
  ): boolean {
    const status = this.get(candidate);
    if (!status) return true;
    const checkedAt = Date.parse(status.checkedAt);
    if (!Number.isFinite(checkedAt)) return true;
    return nowMs - checkedAt >= (status.ready ? readyTtlMs : failureTtlMs);
  }

  retain(candidates: readonly ResourceSelectionCandidate[]): void {
    const active = new Set(candidates.map(supervisorDirectAdmissionKey));
    for (const key of this.statuses.keys()) if (!active.has(key)) this.statuses.delete(key);
  }

  invalidateResource(resourceId: string): void {
    for (const [key, status] of this.statuses)
      if (status.resourceId === resourceId) this.statuses.delete(key);
  }

  list(): SupervisorDirectAdmissionStatus[] {
    return [...this.statuses.values()].sort((a, b) => a.admissionKey.localeCompare(b.admissionKey));
  }

  summary(): { checked: number; ready: number; unready: number } {
    const values = this.list();
    return {
      checked: values.length,
      ready: values.filter((item) => item.ready).length,
      unready: values.filter((item) => !item.ready).length,
    };
  }
}

export function supervisorDirectAdmissionInput(): SupervisorDecisionInput {
  const planId = 'plan-supervisor-direct-admission';
  const supervisorId = 'supervisor-direct-admission';
  const digest = 'supervisor-direct-admission-projection-v1';
  return {
    conversationId: 'conversation-supervisor-direct-admission',
    supervisorId,
    planId,
    projection: {
      projectionVersion: 1,
      plan: {
        planId,
        projectKey: 'supervisor-direct-admission',
        objective: 'Validate the direct Supervisor typed-decision transport. Do not perform work.',
        repositoryPath: '/probe',
        baseRevision: 'probe',
        currentRevision: 'probe',
        status: 'RUNNING',
      },
      graph: { items: [] },
      executions: [],
      reviews: [],
      supervisor: {
        supervisorId,
        status: 'OBSERVING',
        observationCursor: 1,
        allowedActions: ['NO_ACTION'],
      },
      recentEvents: [],
      cursor: 1,
      digest,
      truncated: false,
    },
  };
}
