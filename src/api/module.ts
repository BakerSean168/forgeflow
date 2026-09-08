import type { FastifyInstance } from 'fastify';

import { ForgeFlowError } from '../core/domain/errors.js';

export const FORGEFLOW_API_MODULE_VERSION = 1 as const;

export interface ForgeFlowApiModule {
  readonly id: string;
  readonly apiVersion: typeof FORGEFLOW_API_MODULE_VERSION;
  register(app: FastifyInstance): Promise<void>;
}

export async function registerApiModules(
  app: FastifyInstance,
  modules: readonly ForgeFlowApiModule[],
): Promise<readonly string[]> {
  const ids = new Set<string>();
  for (const module of modules) {
    if (!module.id.trim()) throw new ForgeFlowError('API_MODULE_ID_REQUIRED');
    if (module.apiVersion !== FORGEFLOW_API_MODULE_VERSION)
      throw new ForgeFlowError('API_MODULE_VERSION_UNSUPPORTED');
    if (ids.has(module.id)) throw new ForgeFlowError('API_MODULE_DUPLICATE');
    ids.add(module.id);
    await module.register(app);
  }
  return Object.freeze([...ids].sort());
}
