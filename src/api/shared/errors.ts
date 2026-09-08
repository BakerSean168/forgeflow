import type { FastifyInstance } from 'fastify';

import { ForgeFlowError } from '../../core/domain/errors.js';

export function httpStatusForForgeFlowError(error: ForgeFlowError): number {
  if (error.code.endsWith('_NOT_FOUND')) return 404;
  if (
    error.code.includes('STALE') ||
    error.code.includes('DUPLICATE') ||
    error.code.includes('CONFLICT') ||
    error.code.includes('ACTIVE')
  )
    return 409;
  if (error.code.includes('UNAVAILABLE') || error.code.includes('DISABLED')) return 503;
  return 400;
}

export function registerApiErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ForgeFlowError) {
      void reply.code(httpStatusForForgeFlowError(error)).send({
        error: error.code,
        message: error.message,
      });
      return;
    }
    void reply.code(500).send({
      error: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : String(error),
    });
  });
}
