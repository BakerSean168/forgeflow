import createClient from 'openapi-fetch';
import type { Client } from 'openapi-fetch';

import type { components, operations, paths } from './generated/schema.js';

export type { components, operations, paths } from './generated/schema.js';
export {
  FORGEFLOW_API_CONTRACT_SHA256,
  FORGEFLOW_API_CONTRACT_VERSION,
  FORGEFLOW_OPENAPI_SPEC_VERSION,
} from './generated/contract.js';

export interface ForgeFlowClientOptions {
  /** ForgeFlow control-plane origin, for example http://127.0.0.1:8420. */
  baseUrl: string;
  /** Optional default HTTP headers applied to every request. */
  headers?: HeadersInit;
  /** Optional fetch implementation for tests, runtimes, or custom transports. */
  fetch?: typeof globalThis.fetch;
}

export type ForgeFlowClient = Client<paths>;

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError('ForgeFlow client baseUrl is required');
  return trimmed.replace(/\/+$/, '');
}

export function createForgeFlowClient(options: ForgeFlowClientOptions): ForgeFlowClient {
  return createClient<paths>({
    baseUrl: normalizeBaseUrl(options.baseUrl),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

export type ForgeFlowComponents = components;
export type ForgeFlowOperations = operations;
