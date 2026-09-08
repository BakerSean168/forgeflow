import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import openapiTS, { astToString } from 'openapi-typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = path.join(root, 'api/openapi.v1.json');
const schemaOutput = path.join(root, 'packages/client/src/generated/schema.ts');
const contractOutput = path.join(root, 'packages/client/src/generated/contract.ts');
const operationsOutput = path.join(root, 'packages/client/src/generated/operations.ts');
const check = process.argv.includes('--check');

const inputBytes = fs.readFileSync(input);
const source = JSON.parse(inputBytes.toString('utf8')) as {
  openapi?: unknown;
  info?: { version?: unknown };
  paths?: Record<string, Record<string, { operationId?: unknown } | unknown>>;
};
if (typeof source.openapi !== 'string' || typeof source.info?.version !== 'string') {
  throw new Error('ForgeFlow OpenAPI contract is missing openapi/info.version metadata');
}
const contractSha256 = createHash('sha256').update(inputBytes).digest('hex');

const ast = await openapiTS(pathToFileURL(input), {
  alphabetize: true,
  exportType: true,
  immutable: true,
});
const header = [
  '/* eslint-disable */',
  '/**',
  ' * GENERATED FILE — DO NOT EDIT.',
  ' * Source: api/openapi.v1.json',
  ' * Regenerate with: npm run client:generate',
  ' */',
  '',
].join('\n');
const schemaGenerated = header + astToString(ast).trimStart();
const contractGenerated = `${header}export const FORGEFLOW_OPENAPI_SPEC_VERSION = ${JSON.stringify(source.openapi)} as const;\nexport const FORGEFLOW_API_CONTRACT_VERSION = ${JSON.stringify(source.info.version)} as const;\nexport const FORGEFLOW_API_CONTRACT_SHA256 = ${JSON.stringify(contractSha256)} as const;\n`;

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const operationRoutes: Array<{ operationId: string; method: string; path: string }> = [];
const seenOperationIds = new Set<string>();
for (const [apiPath, pathItem] of Object.entries(source.paths ?? {})) {
  for (const [method, rawOperation] of Object.entries(pathItem ?? {})) {
    if (!HTTP_METHODS.has(method)) continue;
    if (rawOperation === null || typeof rawOperation !== 'object' || Array.isArray(rawOperation))
      throw new Error(`ForgeFlow OpenAPI operation ${method.toUpperCase()} ${apiPath} is invalid`);
    const operationId = (rawOperation as { operationId?: unknown }).operationId;
    if (typeof operationId !== 'string' || !operationId)
      throw new Error(`ForgeFlow OpenAPI operation ${method.toUpperCase()} ${apiPath} is missing operationId`);
    if (seenOperationIds.has(operationId))
      throw new Error(`ForgeFlow OpenAPI operationId is duplicated: ${operationId}`);
    seenOperationIds.add(operationId);
    operationRoutes.push({ operationId, method, path: apiPath });
  }
}
operationRoutes.sort((left, right) => left.operationId.localeCompare(right.operationId));
const operationRouteLines = operationRoutes
  .map(
    ({ operationId, method, path: apiPath }) =>
      `  ${JSON.stringify(operationId)}: { method: ${JSON.stringify(method)}, path: ${JSON.stringify(apiPath)} },`,
  )
  .join('\n');
const operationsGenerated = `${header}import type { operations, paths } from './schema.js';\n\nexport const FORGEFLOW_OPERATION_ROUTES = {\n${operationRouteLines}\n} as const satisfies Record<keyof operations, { readonly method: 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch' | 'trace'; readonly path: keyof paths }>;\n\nexport type ForgeFlowOperationId = keyof typeof FORGEFLOW_OPERATION_ROUTES;\nexport type ForgeFlowOperationRoutes = typeof FORGEFLOW_OPERATION_ROUTES;\n`;

const outputs = [
  [schemaOutput, schemaGenerated],
  [contractOutput, contractGenerated],
  [operationsOutput, operationsGenerated],
] as const;

if (check) {
  const drifted = outputs.filter(([file, generated]) =>
    !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== generated,
  );
  if (drifted.length > 0) {
    console.error(
      `ForgeFlow typed client contract drift detected: ${drifted
        .map(([file]) => path.relative(root, file))
        .join(', ')}. Run npm run client:generate.`,
    );
    process.exit(1);
  }
  console.log('ForgeFlow typed client contract is up to date');
} else {
  for (const [file, generated] of outputs) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, generated);
    console.log(path.relative(root, file));
  }
}
