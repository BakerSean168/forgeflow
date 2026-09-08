import type { FastifyInstance } from 'fastify';

import type { ForgeFlowApiModule } from '../../module.js';
import { bodyRecord, requiredText } from '../../shared/input.js';
import { ForgeFlowError } from '../../../core/domain/errors.js';
import type { ResourceState } from '../../../core/domain/resourceRouting.js';
import type { ResourceApplication } from '../../../application/resources/index.js';

function optionalExpectedVersion(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new ForgeFlowError('RESOURCE_OVERRIDE_VERSION_INVALID');
  return parsed;
}

export function createResourceApiModule(resources: ResourceApplication): ForgeFlowApiModule {
  return {
    id: 'resources',
    apiVersion: 1,
    register: async (app: FastifyInstance) => {
      app.get('/api/v1/resources', async () => resources.list());

      app.post('/api/v1/resources/:resourceId/state', async (request) => {
        const resourceId = requiredText(
          (request.params as { resourceId?: string }).resourceId,
          'RESOURCE_ID_REQUIRED',
        );
        const body = bodyRecord(request.body);
        const state = requiredText(body.state, 'RESOURCE_STATE_REQUIRED').toUpperCase();
        if (!['ACTIVE', 'SUSPENDED', 'DISABLED'].includes(state))
          throw new ForgeFlowError('RESOURCE_STATE_INVALID');
        return resources.setResourceState({
          resourceId,
          state: state as ResourceState,
          ...(typeof body.reason === 'string' && body.reason.trim()
            ? { reason: body.reason.trim() }
            : {}),
          ...(typeof body.suspendedUntil === 'string' && body.suspendedUntil.trim()
            ? { suspendedUntil: body.suspendedUntil.trim() }
            : {}),
          ...(optionalExpectedVersion(body.expectedVersion) === undefined
            ? {}
            : { expectedVersion: optionalExpectedVersion(body.expectedVersion)! }),
        });
      });

      app.post('/api/v1/resources/:resourceId/bindings/:bindingId/state', async (request) => {
        const params = request.params as { resourceId?: string; bindingId?: string };
        const resourceId = requiredText(params.resourceId, 'RESOURCE_ID_REQUIRED');
        const bindingId = requiredText(params.bindingId, 'RESOURCE_BINDING_ID_REQUIRED');
        const body = bodyRecord(request.body);
        const state = requiredText(body.state, 'RESOURCE_BINDING_STATE_REQUIRED').toUpperCase();
        if (state !== 'ACTIVE' && state !== 'DISABLED')
          throw new ForgeFlowError('RESOURCE_BINDING_STATE_INVALID');
        return resources.setBindingState({ resourceId, bindingId, state });
      });
    },
  };
}
