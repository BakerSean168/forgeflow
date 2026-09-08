import fs from 'node:fs';

import {
  OPTIONAL_REQUEST_BODY_OPERATION_IDS,
  REQUEST_BODY_OPERATION_IDS,
  documentedOperationIds,
} from '../src/api/contracts/index.js';
import { FORGEFLOW_API_OPERATIONS, openApiPath, type ForgeFlowApiOperationId } from '../src/api/operations.js';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'] as const;
const NATIVE_SCHEMA_OPERATION_IDS = Object.freeze(
  new Set<ForgeFlowApiOperationId>(['projectsList', 'projectsGet']),
);

type JsonRecord = Record<string, unknown>;
function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

export function checkApiContractCoverage(document: unknown): string[] {
  const root = record(document);
  if (!root) return ['OpenAPI document must be an object'];
  const failures: string[] = [];
  const paths = record(root.paths) ?? {};
  const operationById = new Map<string, { key: string; operation: JsonRecord }>();

  for (const [pathName, pathItemValue] of Object.entries(paths)) {
    const pathItem = record(pathItemValue);
    if (!pathItem) continue;
    for (const method of HTTP_METHODS) {
      const operation = record(pathItem[method]);
      if (!operation) continue;
      const operationId = operation.operationId;
      const key = `${method.toUpperCase()} ${pathName}`;
      if (typeof operationId !== 'string' || !operationId) {
        failures.push(`${key}: operationId missing`);
        continue;
      }
      operationById.set(operationId, { key, operation });
      const responses = record(operation.responses) ?? {};
      const jsonResponse = Object.entries(responses).some(([status, responseValue]) => {
        if (!/^2\d\d$/.test(status)) return false;
        const response = record(responseValue);
        const content = record(response?.content);
        return Boolean(record(content?.['application/json'])?.schema);
      });
      if (!jsonResponse) failures.push(`${key}: no documented 2xx application/json response schema`);
    }
  }

  const covered = new Set<ForgeFlowApiOperationId>([
    ...documentedOperationIds(),
    ...NATIVE_SCHEMA_OPERATION_IDS,
  ]);
  for (const expected of FORGEFLOW_API_OPERATIONS) {
    const key = `${expected.method} ${openApiPath(expected.route)}`;
    const found = operationById.get(expected.operationId);
    if (!found) {
      failures.push(`${key}: operation ${expected.operationId} missing from generated contract`);
      continue;
    }
    if (!covered.has(expected.operationId))
      failures.push(`${key}: operation ${expected.operationId} has no explicit contract owner`);

    const requestBody = record(found.operation.requestBody);
    const expectsBody = REQUEST_BODY_OPERATION_IDS.has(expected.operationId);
    if (expectsBody && !requestBody)
      failures.push(`${key}: expected requestBody contract is missing`);
    if (!expectsBody && requestBody)
      failures.push(`${key}: unexpected requestBody contract; update the audited request-body set`);
    if (requestBody) {
      const optional = OPTIONAL_REQUEST_BODY_OPERATION_IDS.has(expected.operationId);
      if (optional && requestBody.required !== false)
        failures.push(`${key}: legacy-optional request body became required`);
      if (!optional && requestBody.required !== true)
        failures.push(`${key}: required request body is not documented as required`);
      const content = record(requestBody.content);
      if (!record(content?.['application/json'])?.schema)
        failures.push(`${key}: requestBody lacks application/json schema`);
    }
  }

  for (const operationId of covered)
    if (!FORGEFLOW_API_OPERATIONS.some((operation) => operation.operationId === operationId))
      failures.push(`contract owner has orphan operationId ${operationId}`);

  if (documentedOperationIds().length !== 43)
    failures.push(`legacy/documentation overlay coverage must remain 43 operations, found ${documentedOperationIds().length}`);
  if (NATIVE_SCHEMA_OPERATION_IDS.size !== 2)
    failures.push(`native schema-first coverage must remain 2 operations, found ${NATIVE_SCHEMA_OPERATION_IDS.size}`);
  if (REQUEST_BODY_OPERATION_IDS.size !== 18)
    failures.push(`audited requestBody operation set must remain 18, found ${REQUEST_BODY_OPERATION_IDS.size}`);
  if (OPTIONAL_REQUEST_BODY_OPERATION_IDS.size !== 4)
    failures.push(`legacy-optional requestBody set must remain 4, found ${OPTIONAL_REQUEST_BODY_OPERATION_IDS.size}`);

  return failures;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const document = JSON.parse(fs.readFileSync('api/openapi.v1.json', 'utf8')) as unknown;
  const failures = checkApiContractCoverage(document);
  if (failures.length) {
    console.error('ForgeFlow API contract coverage check failed:\n' + failures.map((item) => `- ${item}`).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('ForgeFlow API contract coverage OK (45/45 operations; 18 bodies; 4 optional bodies)');
  }
}
