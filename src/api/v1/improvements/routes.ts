import type { FastifyInstance } from 'fastify';

import type { ForgeFlowApiModule } from '../../module.js';
import { planDeliveryConfig } from '../../shared/delivery.js';
import { bodyRecord, requiredText } from '../../shared/input.js';
import { ForgeFlowError } from '../../../core/domain/errors.js';
import type {
  ImprovementApplication,
  ImprovementCandidateStatus,
} from '../../../application/improvements/index.js';
import { maintenanceProgramBody } from './input.js';

const CANDIDATE_STATUSES = new Set<ImprovementCandidateStatus>([
  'DISCOVERED',
  'QUEUED',
  'ADOPTED',
  'REJECTED',
  'STALE',
  'COMPLETED',
]);

function listLimit(value: string | undefined): number {
  if (value === undefined) return 100;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000)
    throw new ForgeFlowError('CANDIDATE_LIST_LIMIT_INVALID');
  return parsed;
}

function optionalPriority(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new ForgeFlowError('PROJECT_PLAN_PRIORITY_INVALID');
  return value;
}

export function createImprovementApiModule(improvements: ImprovementApplication): ForgeFlowApiModule {
  return {
    id: 'improvements',
    apiVersion: 1,
    register: async (app: FastifyInstance) => {
      app.get('/api/v1/maintenance/programs', async () => improvements.listPrograms());

      app.post('/api/v1/maintenance/programs/:programId/state', async (request) => {
        const programId = requiredText(
          (request.params as { programId?: string }).programId,
          'MAINTENANCE_PROGRAM_REQUIRED',
        );
        const body = bodyRecord(request.body);
        if (typeof body.enabled !== 'boolean')
          throw new ForgeFlowError('MAINTENANCE_PROGRAM_STATE_INVALID');
        return improvements.setProgramEnabled(programId, body.enabled);
      });

      app.get('/api/v1/improvements', async (request) => {
        const query = request.query as { programId?: string; status?: string; limit?: string };
        let status: ImprovementCandidateStatus | undefined;
        if (query.status) {
          if (!CANDIDATE_STATUSES.has(query.status as ImprovementCandidateStatus))
            throw new ForgeFlowError('CANDIDATE_STATUS_INVALID');
          status = query.status as ImprovementCandidateStatus;
        }
        return improvements.listCandidates({
          limit: listLimit(query.limit),
          ...(query.programId ? { programId: query.programId } : {}),
          ...(status ? { status } : {}),
        });
      });

      app.get('/api/v1/improvements/:candidateId', async (request) =>
        improvements.getCandidate(
          requiredText(
            (request.params as { candidateId?: string }).candidateId,
            'CANDIDATE_ID_REQUIRED',
          ),
        ),
      );

      app.post('/api/v1/improvements/discover', async (request) =>
        improvements.discover(maintenanceProgramBody(request.body)),
      );

      app.post('/api/v1/improvements/cycle', async () => improvements.runCycle());

      app.post('/api/v1/improvements/:candidateId/diagnose', async (request) =>
        improvements.diagnose(
          requiredText(
            (request.params as { candidateId?: string }).candidateId,
            'CANDIDATE_ID_REQUIRED',
          ),
        ),
      );

      app.post('/api/v1/improvements/:candidateId/adopt', async (request) => {
        const candidateId = requiredText(
          (request.params as { candidateId?: string }).candidateId,
          'CANDIDATE_ID_REQUIRED',
        );
        const body = request.body === undefined || request.body === null ? {} : bodyRecord(request.body);
        const priority = optionalPriority(body.priority);
        const delivery = body.delivery === undefined ? undefined : planDeliveryConfig(body.delivery);
        return improvements.adopt(candidateId, {
          ...(typeof body.repositoryPath === 'string' && body.repositoryPath.trim()
            ? { repositoryPath: body.repositoryPath.trim() }
            : {}),
          ...(typeof body.baseRevision === 'string' && body.baseRevision.trim()
            ? { baseRevision: body.baseRevision.trim() }
            : {}),
          ...(priority === undefined ? {} : { priority }),
          acknowledgeHighRisk: body.acknowledgeHighRisk === true,
          ...(delivery ? { delivery } : {}),
        });
      });

      app.post('/api/v1/improvements/:candidateId/reconcile', async (request) =>
        improvements.reconcile(
          requiredText(
            (request.params as { candidateId?: string }).candidateId,
            'CANDIDATE_ID_REQUIRED',
          ),
        ),
      );

      app.post('/api/v1/improvements/:candidateId/self-canary', async (request) =>
        improvements.runSelfCanary(
          requiredText(
            (request.params as { candidateId?: string }).candidateId,
            'CANDIDATE_ID_REQUIRED',
          ),
        ),
      );

      app.post('/api/v1/improvements/:candidateId/self-promote', async (request, reply) => {
        const result = improvements.requestSelfPromotion(
          requiredText(
            (request.params as { candidateId?: string }).candidateId,
            'CANDIDATE_ID_REQUIRED',
          ),
        );
        reply.code(202);
        return result;
      });

      app.post('/api/v1/improvements/:candidateId/reject', async (request) =>
        improvements.reject(
          requiredText(
            (request.params as { candidateId?: string }).candidateId,
            'CANDIDATE_ID_REQUIRED',
          ),
        ),
      );
    },
  };
}
