import type { FastifyInstance } from 'fastify';

import type { ForgeFlowApiModule } from '../../module.js';
import { bodyRecord, requiredText } from '../../shared/input.js';
import { ForgeFlowError } from '../../../core/domain/errors.js';
import type { SystemApplication } from '../../../application/system/index.js';

export function createSystemApiModule(system: SystemApplication): ForgeFlowApiModule {
  return {
    id: 'system',
    apiVersion: 1,
    register: async (app: FastifyInstance) => {
      app.get('/api/health', async () => system.health());

      app.get('/api/v1/release-acceptance/autonomous-lifecycle', async () =>
        system.releaseAcceptance(),
      );

      app.post('/api/v1/release-acceptance/autonomous-lifecycle', async (request, reply) => {
        const body = bodyRecord(request.body);
        if (
          !Array.isArray(body.externalChecks) ||
          !body.externalChecks.every((value) => typeof value === 'string')
        )
          throw new ForgeFlowError('RELEASE_ACCEPTANCE_EXTERNAL_CHECKS_INCOMPLETE');
        const result = system.attestReleaseAcceptance({
          planId: requiredText(body.planId, 'RELEASE_ACCEPTANCE_PLAN_REQUIRED'),
          sourceSha: requiredText(body.sourceSha, 'RELEASE_ACCEPTANCE_SOURCE_SHA_INVALID'),
          artifactSha256: requiredText(
            body.artifactSha256,
            'RELEASE_ACCEPTANCE_ARTIFACT_SHA_INVALID',
          ),
          canonicalHead: requiredText(
            body.canonicalHead,
            'RELEASE_ACCEPTANCE_CANONICAL_SHA_INVALID',
          ),
          externalChecks: [...body.externalChecks],
        });
        if (result.created) reply.code(201);
        return {
          status: result.status,
          attestation: result.attestation,
          attestedAt: result.attestedAt,
        };
      });

      app.get('/api/v1/storage', async () => system.storage());
      app.post('/api/v1/storage/reconcile', async () => system.reconcileStorage());
      app.get('/api/v1/supervisor-admission', async () => system.supervisorAdmission());
      app.get('/api/v1/runtime-admission', async () => system.runtimeAdmission());
    },
  };
}
