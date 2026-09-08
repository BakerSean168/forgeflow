import type { FastifyInstance } from 'fastify';

import type { ForgeFlowApiModule } from '../../module.js';
import { planDeliveryConfig } from '../../shared/delivery.js';
import { bodyRecord, requiredText } from '../../shared/input.js';
import { ForgeFlowError } from '../../../core/domain/errors.js';
import { PLAN_STATUSES, type PlanStatus } from '../../../core/domain/plan.js';
import type { PlanApplication } from '../../../application/plans/index.js';
import { graphItems, integerInput } from './input.js';

export function createPlanApiModule(plans: PlanApplication): ForgeFlowApiModule {
  return {
    id: 'plans',
    apiVersion: 1,
    register: async (app: FastifyInstance) => {
      app.get('/api/v1/plans', async (request) => {
        const query = request.query as { limit?: string; status?: string; view?: string };
        const status = query.status;
        if (status && !(PLAN_STATUSES as readonly string[]).includes(status))
          throw new ForgeFlowError('PLAN_STATUS_INVALID');
        if (query.view && query.view !== 'full' && query.view !== 'summary')
          throw new ForgeFlowError('PLAN_LIST_VIEW_INVALID');
        return plans.list({
          limit: integerInput(query.limit, 100, 1, 1000, 'PLAN_LIST_LIMIT_INVALID'),
          ...(status ? { status: status as PlanStatus } : {}),
          ...(query.view ? { view: query.view as 'full' | 'summary' } : {}),
        });
      });

      app.get('/api/v1/projects/:projectKey/plan-queue', async (request) =>
        plans.queue(
          requiredText(
            (request.params as { projectKey?: string }).projectKey,
            'PLAN_PROJECT_REQUIRED',
          ),
        ),
      );

      app.post('/api/v1/plans/:planId/reprioritize', async (request) => {
        const planId = requiredText((request.params as { planId?: string }).planId, 'PLAN_ID_REQUIRED');
        const body = bodyRecord(request.body);
        return plans.reprioritize(
          planId,
          integerInput(body.priority, 0, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 'PROJECT_PLAN_PRIORITY_INVALID'),
        );
      });

      app.post('/api/v1/plans/:planId/cancel-queued', async (request) =>
        plans.cancelQueued(
          requiredText((request.params as { planId?: string }).planId, 'PLAN_ID_REQUIRED'),
        ),
      );

      app.post('/api/v1/plans/:planId/cancel', async (request) => {
        const planId = requiredText((request.params as { planId?: string }).planId, 'PLAN_ID_REQUIRED');
        const body = request.body === undefined ? {} : bodyRecord(request.body);
        return await plans.cancel(
          planId,
          requiredText(
            request.headers['idempotency-key'] ?? body.idempotencyKey,
            'PROJECT_PLAN_CANCEL_IDEMPOTENCY_REQUIRED',
          ),
          requiredText(body.reason, 'PROJECT_PLAN_CANCEL_REASON_INVALID'),
        );
      });

      app.post('/api/v1/plans', async (request, reply) => {
        const body = bodyRecord(request.body);
        const objective = requiredText(body.objective, 'PLAN_OBJECTIVE_REQUIRED');
        const result = await plans.createRoot({
          idempotencyKey: requiredText(
            request.headers['idempotency-key'] ?? body.idempotencyKey,
            'PLAN_IDEMPOTENCY_REQUIRED',
          ),
          projectKey: requiredText(body.projectKey, 'PLAN_PROJECT_REQUIRED'),
          objective,
          ...(typeof body.repositoryPath === 'string' && body.repositoryPath.trim()
            ? { requestedRepositoryPath: body.repositoryPath.trim() }
            : {}),
          baseRevision: requiredText(body.baseRevision, 'PLAN_BASE_REVISION_REQUIRED'),
          ...(planDeliveryConfig(body.delivery) ? { delivery: planDeliveryConfig(body.delivery)! } : {}),
          workItems: graphItems(body.workItems, { title: 'Complete objective', objective }),
          priority: integerInput(body.priority, 0, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 'PROJECT_PLAN_PRIORITY_INVALID'),
        });
        reply.code(result.created ? 201 : 200);
        return result.value;
      });

      app.post('/api/v1/plans/:planId/children', async (request, reply) => {
        const parentPlanId = requiredText(
          (request.params as { planId?: string }).planId,
          'PLAN_ID_REQUIRED',
        );
        const body = bodyRecord(request.body);
        const relation = requiredText(body.relation ?? 'FOLLOW_UP', 'CHILD_RELATION_INVALID');
        if (!['SYSTEM_REPAIR', 'INFRASTRUCTURE_REPAIR', 'FOLLOW_UP'].includes(relation))
          throw new ForgeFlowError('CHILD_RELATION_INVALID');
        const objective = requiredText(body.objective, 'CHILD_OBJECTIVE_REQUIRED');
        const delivery = planDeliveryConfig(body.delivery);
        const value = plans.createChild({
          parentPlanId,
          childPlanId: requiredText(body.childPlanId, 'CHILD_PLAN_ID_REQUIRED'),
          ...(typeof body.repositoryPath === 'string' && body.repositoryPath.trim()
            ? { repositoryPath: body.repositoryPath.trim() }
            : {}),
          objective,
          relation: relation as 'SYSTEM_REPAIR' | 'INFRASTRUCTURE_REPAIR' | 'FOLLOW_UP',
          ...(delivery ? { delivery } : {}),
          workItems: graphItems(body.workItems, { title: 'Complete child objective', objective }),
        });
        reply.code(201);
        return value;
      });

      app.post('/api/v1/plans/:planId/delivery', async (request, reply) => {
        const planId = requiredText((request.params as { planId?: string }).planId, 'PLAN_ID_REQUIRED');
        const config = planDeliveryConfig(request.body);
        if (!config) throw new ForgeFlowError('PLAN_DELIVERY_REQUIRED');
        const result = plans.attachDelivery(planId, config);
        reply.code(result.created ? 201 : 200);
        return result.value;
      });

      app.get('/api/v1/plans/:planId', async (request) =>
        plans.view(requiredText((request.params as { planId?: string }).planId, 'PLAN_ID_REQUIRED')),
      );

      app.post('/api/v1/plans/:planId/run', async (request) =>
        await plans.run(requiredText((request.params as { planId?: string }).planId, 'PLAN_ID_REQUIRED')),
      );

      app.post('/api/v1/plans/:planId/reconcile', async (request, reply) => {
        const planId = requiredText((request.params as { planId?: string }).planId, 'PLAN_ID_REQUIRED');
        const body = request.body === undefined ? {} : bodyRecord(request.body);
        const mode = body.mode === undefined ? 'auto' : requiredText(body.mode, 'PLAN_RECONCILE_MODE_INVALID');
        const result = await plans.reconcile(planId, mode);
        reply.code(202);
        return result;
      });
    },
  };
}
