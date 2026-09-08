import type { FastifyInstance } from 'fastify';

import type { ForgeFlowApiModule } from '../../module.js';
import { bodyRecord, requiredText } from '../../shared/input.js';
import type { SupervisorApplication } from '../../../application/supervisors/index.js';

export function createSupervisorApiModule(supervisors: SupervisorApplication): ForgeFlowApiModule {
  return {
    id: 'supervisors',
    apiVersion: 1,
    register: async (app: FastifyInstance) => {
      app.get('/api/v1/supervisors/:supervisorId/projection', async (request) =>
        supervisors.projection(
          requiredText(
            (request.params as { supervisorId?: string }).supervisorId,
            'SUPERVISOR_ID_REQUIRED',
          ),
        ),
      );

      app.post('/api/v1/supervisors/:supervisorId/decisions', async (request) => {
        const supervisorId = requiredText(
          (request.params as { supervisorId?: string }).supervisorId,
          'SUPERVISOR_ID_REQUIRED',
        );
        return await supervisors.executeDecision(supervisorId, bodyRecord(request.body));
      });
    },
  };
}
