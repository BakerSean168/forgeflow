import type { DatabaseSync } from 'node:sqlite';

import { ForgeFlowError } from '../../core/domain/errors.js';
import type { SupervisorActionExecutor } from '../../core/supervisor/executor.js';
import { buildBoundedProjection } from '../../core/supervisor/projection.js';
import { parseSupervisorDecision } from '../../core/supervisor/protocol.js';

export class SupervisorApplication {
  constructor(
    private readonly db: DatabaseSync,
    private readonly actions: SupervisorActionExecutor,
  ) {}

  projection(supervisorId: string) {
    return buildBoundedProjection(this.db, supervisorId);
  }

  async executeDecision(supervisorId: string, body: Record<string, unknown>) {
    const projection = this.projection(supervisorId);
    const decision = parseSupervisorDecision(JSON.stringify(body));
    if (decision.supervisorId !== supervisorId)
      throw new ForgeFlowError('ACTION_SUPERVISOR_MISMATCH');
    return await this.actions.execute(decision, projection);
  }
}
