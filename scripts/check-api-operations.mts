import fs from 'node:fs';

import { FORGEFLOW_API_OPERATIONS, openApiPath } from '../src/api/operations.js';

const document = JSON.parse(fs.readFileSync('api/openapi.v1.json', 'utf8')) as {
  paths?: Record<string, Record<string, { operationId?: string }>>;
};
const methods = new Set(['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace']);
const expected = new Map(
  FORGEFLOW_API_OPERATIONS.map((operation) => [
    `${operation.method} ${openApiPath(operation.route)}`,
    operation.operationId,
  ]),
);
const seenIds = new Map<string, string>();
const failures: string[] = [];
let operationCount = 0;

for (const [pathName, pathItem] of Object.entries(document.paths ?? {})) {
  for (const [rawMethod, operation] of Object.entries(pathItem)) {
    const method = rawMethod.toLowerCase();
    if (!methods.has(method)) continue;
    operationCount++;
    const key = `${method.toUpperCase()} ${pathName}`;
    const expectedId = expected.get(key);
    if (!expectedId) {
      failures.push(`${key}: public operation is missing from FORGEFLOW_API_OPERATIONS`);
      continue;
    }
    if (!operation.operationId) failures.push(`${key}: generated OpenAPI operationId missing`);
    else if (operation.operationId !== expectedId)
      failures.push(`${key}: expected operationId ${expectedId}, found ${operation.operationId}`);
    if (operation.operationId) {
      const prior = seenIds.get(operation.operationId);
      if (prior) failures.push(`${key}: duplicate operationId ${operation.operationId}; already used by ${prior}`);
      else seenIds.set(operation.operationId, key);
    }
    expected.delete(key);
  }
}
for (const [key, operationId] of expected)
  failures.push(`${key}: registry operation ${operationId} has no generated OpenAPI operation`);

if (failures.length) {
  console.error('ForgeFlow API operation registry check failed:\n' + failures.map((item) => `- ${item}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`ForgeFlow API operation registry OK (${operationCount} operations, ${seenIds.size} unique operationIds)`);
}
