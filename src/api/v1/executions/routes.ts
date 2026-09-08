import type { FastifyInstance } from 'fastify';

import type { ForgeFlowApiModule } from '../../module.js';
import { bodyRecord, requiredText } from '../../shared/input.js';
import { ForgeFlowError } from '../../../core/domain/errors.js';
import { EXECUTION_STATUSES, type ExecutionStatus } from '../../../core/domain/execution.js';
import type { ExecutionApplication } from '../../../application/executions/index.js';

function listLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') return 100;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1000)
    throw new ForgeFlowError('EXECUTION_LIST_LIMIT_INVALID');
  return parsed;
}

export function createExecutionApiModule(executions: ExecutionApplication): ForgeFlowApiModule {
  return {
    id: 'executions',
    apiVersion: 1,
    register: async (app: FastifyInstance) => {
      app.get('/api/v1/executions', async (request) => {
        const query = request.query as {
          limit?: string;
          planId?: string;
          status?: string;
          view?: string;
        };
        if (query.status && !(EXECUTION_STATUSES as readonly string[]).includes(query.status))
          throw new ForgeFlowError('EXECUTION_STATUS_INVALID');
        if (query.view && query.view !== 'dashboard')
          throw new ForgeFlowError('EXECUTION_LIST_VIEW_INVALID');
        return await executions.list({
          limit: listLimit(query.limit),
          ...(query.planId
            ? { planId: requiredText(query.planId, 'EXECUTION_PLAN_REQUIRED') }
            : {}),
          ...(query.status ? { status: query.status as ExecutionStatus } : {}),
          ...(query.view ? { view: 'dashboard' as const } : {}),
        });
      });

      app.get('/api/v1/executions/:executionId', async (request) =>
        executions.get(
          requiredText(
            (request.params as { executionId?: string }).executionId,
            'EXECUTION_ID_REQUIRED',
          ),
        ),
      );

      app.post('/api/v1/executions/:executionId/run', async (request) =>
        await executions.run(
          requiredText(
            (request.params as { executionId?: string }).executionId,
            'EXECUTION_ID_REQUIRED',
          ),
        ),
      );

      app.post('/api/v1/executions/:executionId/continue', async (request) => {
        const executionId = requiredText(
          (request.params as { executionId?: string }).executionId,
          'EXECUTION_ID_REQUIRED',
        );
        const body = request.body === undefined ? {} : bodyRecord(request.body);
        const instruction =
          typeof body.instruction === 'string' && body.instruction.trim()
            ? body.instruction.trim()
            : undefined;
        if (body.interruptCurrent !== undefined && typeof body.interruptCurrent !== 'boolean')
          throw new ForgeFlowError('EXECUTION_CONTINUE_INTERRUPT_INVALID');
        return await executions.continue(executionId, instruction, body.interruptCurrent === true);
      });

      app.post('/api/v1/executions/:executionId/adopt-workspace', async (request) => {
        const executionId = requiredText(
          (request.params as { executionId?: string }).executionId,
          'EXECUTION_ID_REQUIRED',
        );
        const body = request.body === undefined ? {} : bodyRecord(request.body);
        return await executions.adoptWorkspace(
          executionId,
          requiredText(
            request.headers['idempotency-key'] ?? body.idempotencyKey,
            'OPERATOR_ADOPTION_IDEMPOTENCY_REQUIRED',
          ),
          requiredText(body.reason, 'OPERATOR_ADOPTION_REASON_INVALID'),
        );
      });

      app.post('/api/v1/executions/:executionId/abort-paused-provider', async (request) => {
        const executionId = requiredText(
          (request.params as { executionId?: string }).executionId,
          'EXECUTION_ID_REQUIRED',
        );
        const body = request.body === undefined ? {} : bodyRecord(request.body);
        return await executions.abortPausedProvider(
          executionId,
          requiredText(
            request.headers['idempotency-key'] ?? body.idempotencyKey,
            'PROVIDER_ABORT_IDEMPOTENCY_REQUIRED',
          ),
          requiredText(body.reason, 'PROVIDER_ABORT_REASON_INVALID'),
        );
      });

      app.post('/api/v1/executions/:executionId/provider-cleanup', async (request) => {
        const executionId = requiredText(
          (request.params as { executionId?: string }).executionId,
          'EXECUTION_ID_REQUIRED',
        );
        const body = request.body === undefined ? {} : bodyRecord(request.body);
        return await executions.cleanupProvider(
          executionId,
          requiredText(
            request.headers['idempotency-key'] ?? body.idempotencyKey,
            'PROVIDER_CLEANUP_IDEMPOTENCY_REQUIRED',
          ),
          requiredText(body.reason, 'PROVIDER_CLEANUP_REASON_INVALID'),
        );
      });

      app.post('/api/v1/executions/:executionId/replace-provider-session', async (request) => {
        const executionId = requiredText(
          (request.params as { executionId?: string }).executionId,
          'EXECUTION_ID_REQUIRED',
        );
        const body = request.body === undefined ? {} : bodyRecord(request.body);
        const instruction =
          typeof body.instruction === 'string' && body.instruction.trim()
            ? body.instruction.trim()
            : undefined;
        const reason =
          typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : undefined;
        return await executions.replaceProviderSession(
          executionId,
          requiredText(
            request.headers['idempotency-key'] ?? body.idempotencyKey,
            'PROVIDER_REPLACEMENT_IDEMPOTENCY_REQUIRED',
          ),
          instruction,
          reason,
        );
      });
    },
  };
}
