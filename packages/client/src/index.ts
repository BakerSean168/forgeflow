import createClient from 'openapi-fetch';
import type { Client, FetchOptions, FetchResponse } from 'openapi-fetch';

import type { components, operations, paths } from './generated/schema.js';
import { FORGEFLOW_OPERATION_ROUTES, type ForgeFlowOperationId } from './generated/operations.js';

export type { components, operations, paths } from './generated/schema.js';
export { FORGEFLOW_OPERATION_ROUTES } from './generated/operations.js';
export type { ForgeFlowOperationId, ForgeFlowOperationRoutes } from './generated/operations.js';
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

type RequiredKeys<T> = {
  [Key in keyof T]-?: {} extends Pick<T, Key> ? never : Key;
}[keyof T];

export type ForgeFlowOperationInit<OperationId extends ForgeFlowOperationId> =
  FetchOptions<operations[OperationId]>;

type ForgeFlowOperationArgs<
  OperationId extends ForgeFlowOperationId,
  Init extends ForgeFlowOperationInit<OperationId>,
> = RequiredKeys<ForgeFlowOperationInit<OperationId>> extends never ? [init?: Init] : [init: Init];

export type ForgeFlowOperationResponse<
  OperationId extends ForgeFlowOperationId,
  Init extends ForgeFlowOperationInit<OperationId>,
> = FetchResponse<operations[OperationId], Init, `${string}/${string}`>;

export type ForgeFlowOperationMethod<OperationId extends ForgeFlowOperationId> = <
  Init extends ForgeFlowOperationInit<OperationId> = ForgeFlowOperationInit<OperationId>,
>(
  ...args: ForgeFlowOperationArgs<OperationId, Init>
) => Promise<ForgeFlowOperationResponse<OperationId, Init>>;

export type ForgeFlowOperationMethods = {
  readonly [OperationId in ForgeFlowOperationId]: ForgeFlowOperationMethod<OperationId>;
};

export type ForgeFlowClient = Client<paths> & {
  /** Stable operationId-based methods generated from the committed OpenAPI contract. */
  readonly operations: ForgeFlowOperationMethods;
};

function createOperationMethods(client: Client<paths>): ForgeFlowOperationMethods {
  const request = client.request as unknown as (
    method: string,
    path: string,
    init?: unknown,
  ) => Promise<unknown>;
  const bound: Partial<Record<ForgeFlowOperationId, unknown>> = {};
  for (const operationId of Object.keys(FORGEFLOW_OPERATION_ROUTES) as ForgeFlowOperationId[]) {
    const route = FORGEFLOW_OPERATION_ROUTES[operationId];
    bound[operationId] = (init?: unknown) => request(route.method, route.path, init);
  }
  return bound as ForgeFlowOperationMethods;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError('ForgeFlow client baseUrl is required');
  return trimmed.replace(/\/+$/, '');
}

export function createForgeFlowClient(options: ForgeFlowClientOptions): ForgeFlowClient {
  const client = createClient<paths>({
    baseUrl: normalizeBaseUrl(options.baseUrl),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return Object.assign(client, { operations: createOperationMethods(client) });
}

export type ForgeFlowComponents = components;
export type ForgeFlowOperations = operations;
