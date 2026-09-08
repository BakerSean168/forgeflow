import fs from 'node:fs';
import path from 'node:path';

import { buildControlPlane } from '../src/app.js';

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  return value;
}

const target = path.resolve('api/openapi.v1.json');
const check = process.argv.includes('--check');
const runtime = await buildControlPlane({
  dbFile: ':memory:',
  environment: 'test',
  logger: false,
  env: {
    NODE_ENV: 'test',
    FORGEFLOW_EXECUTION_RUNTIME_ENABLED: 'false',
  },
});
try {
  const response = await runtime.app.inject({ method: 'GET', url: '/api/openapi.json' });
  if (response.statusCode !== 200) throw new Error('OpenAPI generation failed with HTTP ' + response.statusCode);
  const rendered = JSON.stringify(sortValue(response.json()), null, 2) + '\n';
  if (check) {
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (current !== rendered) {
      console.error('OpenAPI contract drift detected. Run npm run api:spec and commit api/openapi.v1.json.');
      process.exitCode = 1;
    } else {
      console.log('ForgeFlow OpenAPI contract is up to date');
    }
  } else {
    fs.writeFileSync(target, rendered);
    console.log('Wrote ' + path.relative(process.cwd(), target));
  }
} finally {
  await runtime.app.close();
}
