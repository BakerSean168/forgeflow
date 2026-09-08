import type { ForgeFlowBootstrapConfig } from '../bootstrap/config.js';
import type { ImprovementRuntimeAssembly } from '../bootstrap/improvementRuntime.js';
import type { ReconcileContext, Reconciler } from './contracts.js';

export interface ImprovementReconcilerLogger {
  info(data: unknown, message: string): void;
}

export class ImprovementReconciler implements Reconciler {
  readonly id = 'improvement';
  readonly enabled: boolean;
  readonly intervalMs: number;

  constructor(
    private readonly improvement: ImprovementRuntimeAssembly,
    config: ForgeFlowBootstrapConfig['improvement'],
    private readonly logger: ImprovementReconcilerLogger,
  ) {
    this.enabled = improvement.enabled;
    this.intervalMs = config.cycleMs;
  }

  async warmup(context: ReconcileContext): Promise<void> {
    await this.reconcile(context);
  }

  async reconcile(_context: ReconcileContext): Promise<void> {
    if (!this.enabled) return;
    const result = await this.improvement.runtime.runAutonomousCycle();
    if (
      result.programs.length > 0 ||
      result.reconciledCandidateIds.length > 0 ||
      result.diagnosis.diagnosedCandidateIds.length > 0 ||
      result.diagnosis.adoptedPlanIds.length > 0 ||
      result.diagnosis.errors.length > 0 ||
      result.selfPromotion.requestedCandidateIds.length > 0 ||
      result.selfPromotion.errors.length > 0
    )
      this.logger.info(
        {
          reconciledCandidates: result.reconciledCandidateIds.length,
          programs: result.programs.map((program) => ({
            programId: program.programId,
            projectKey: program.projectKey,
            discovered: program.discovered,
            created: program.created,
            adoptedPlans: program.adoptedPlanIds.length,
            errors: program.errors,
          })),
          diagnosis: result.diagnosis,
          selfPromotion: result.selfPromotion,
        },
        'improvement cycle',
      );
  }
}
