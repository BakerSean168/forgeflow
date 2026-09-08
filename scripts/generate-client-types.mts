import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import openapiTS, { astToString } from 'openapi-typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = path.join(root, 'api/openapi.v1.json');
const schemaOutput = path.join(root, 'packages/client/src/generated/schema.ts');
const contractOutput = path.join(root, 'packages/client/src/generated/contract.ts');
const check = process.argv.includes('--check');

const inputBytes = fs.readFileSync(input);
const source = JSON.parse(inputBytes.toString('utf8')) as {
  openapi?: unknown;
  info?: { version?: unknown };
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

const outputs = [
  [schemaOutput, schemaGenerated],
  [contractOutput, contractGenerated],
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
