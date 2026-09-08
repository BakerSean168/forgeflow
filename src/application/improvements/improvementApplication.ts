import type { PlanDeliveryConfig } from '../../core/domain/delivery.js';
import type {
  ImprovementCandidate,
  MaintenanceProgram,
  MaintenanceCandidateRegistry,
} from '../../core/adapters/maintenance.js';
import type { MaintenanceImprovementRuntime } from '../../core/orchestration/maintenanceRuntime.js';

export type ImprovementProgramInput = MaintenanceProgram;
export type ImprovementCandidateStatus = ImprovementCandidate['status'];

export interface ImprovementAdoptionRequest {
  repositoryPath?: string;
  baseRevision?: string;
  priority?: number;
  acknowledgeHighRisk: boolean;
  delivery?: PlanDeliveryConfig;
}

export class ImprovementApplication {
  constructor(
    private readonly registry: MaintenanceCandidateRegistry,
    private readonly runtime: MaintenanceImprovementRuntime,
    private readonly planView: (planId: string) => unknown,
  ) {}

  listPrograms() {
    return { items: this.registry.listPrograms() };
  }

  setProgramEnabled(programId: string, enabled: boolean) {
    return { program: this.registry.setProgramEnabled(programId, enabled) };
  }

  listCandidates(input: {
    limit: number;
    programId?: string;
    status?: ImprovementCandidateStatus;
  }) {
    const items = this.registry.list(input);
    return { items, count: items.length, runtime: this.runtime.status() };
  }

  getCandidate(candidateId: string) {
    const candidate = this.registry.get(candidateId);
    return {
      candidate,
      program: this.registry.getProgram(candidate.programId),
      plan: candidate.planId ? this.planView(candidate.planId) : null,
      diagnoses: this.registry.listDiagnoses(candidateId),
      selfChange: this.runtime.selfChangeProjection(candidateId),
    };
  }

  discover(program: ImprovementProgramInput) {
    const items = this.runtime.discover(program);
    return {
      program: this.registry.getProgram(program.programId),
      items,
      count: items.length,
    };
  }

  runCycle() {
    return this.runtime.runAutonomousCycle();
  }

  async diagnose(candidateId: string) {
    return { diagnosis: await this.runtime.diagnoseCandidate(candidateId) };
  }

  adopt(candidateId: string, request: ImprovementAdoptionRequest) {
    return this.runtime.adopt(candidateId, {
      ...(request.repositoryPath ? { repositoryPath: request.repositoryPath } : {}),
      ...(request.baseRevision ? { baseRevision: request.baseRevision } : {}),
      ...(request.priority === undefined ? {} : { priority: request.priority }),
      acknowledgeHighRisk: request.acknowledgeHighRisk,
      ...(request.delivery ? { delivery: request.delivery } : {}),
    });
  }

  reconcile(candidateId: string) {
    return { candidate: this.runtime.reconcile(candidateId) };
  }

  async runSelfCanary(candidateId: string) {
    const canary = await this.runtime.runSelfCanary(candidateId);
    return { canary, selfChange: this.runtime.selfChangeProjection(candidateId) };
  }

  requestSelfPromotion(candidateId: string) {
    const promotionRequest = this.runtime.requestSelfPromotion(candidateId);
    return {
      promotionRequest,
      selfChange: this.runtime.selfChangeProjection(candidateId),
    };
  }

  reject(candidateId: string) {
    return { candidate: this.registry.transition(candidateId, 'REJECTED') };
  }
}
