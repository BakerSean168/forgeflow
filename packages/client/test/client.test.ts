import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createForgeFlowClient } from '../src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('client requires a non-empty base URL and strips trailing slashes', async () => {
  assert.throws(() => createForgeFlowClient({ baseUrl: '   ' }), /baseUrl is required/);

  let observed: Request | undefined;
  const fetchMock: typeof fetch = async (input, init) => {
    observed = input instanceof Request ? input : new Request(input, init);
    return Response.json({ source: 'manifest', items: [], count: 0 });
  };
  const client = createForgeFlowClient({
    baseUrl: 'http://forgeflow.test///',
    fetch: fetchMock,
  });
  const result = await client.GET('/api/v1/projects');
  assert.equal(result.response.status, 200);
  assert.equal(observed?.url, 'http://forgeflow.test/api/v1/projects');
  assert.equal(observed?.method, 'GET');
});

test('client serializes typed path parameters and default headers through OpenAPI transport', async () => {
  let observed: Request | undefined;
  const fetchMock: typeof fetch = async (input, init) => {
    observed = input instanceof Request ? input : new Request(input, init);
    return Response.json({ project: { projectKey: 'memo flow' } });
  };
  const client = createForgeFlowClient({
    baseUrl: 'https://forgeflow.test',
    headers: { 'x-forgeflow-test': 'typed-client' },
    fetch: fetchMock,
  });

  await client.GET('/api/v1/projects/{projectKey}', {
    params: { path: { projectKey: 'memo flow' } },
  });

  assert.equal(observed?.url, 'https://forgeflow.test/api/v1/projects/memo%20flow');
  assert.equal(observed?.headers.get('x-forgeflow-test'), 'typed-client');
});

test('client package has no server-internal source dependency and generated schema names its authority', () => {
  const clientRoot = path.join(root, 'packages/client');
  const files = fs
    .readdirSync(path.join(clientRoot, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts'));
  for (const relative of files) {
    const source = fs.readFileSync(path.join(clientRoot, 'src', relative), 'utf8');
    assert.doesNotMatch(source, /(?:\.\.\/){2,}src\//);
    assert.doesNotMatch(source, /from ['"].*\/src\//);
  }
  const generated = fs.readFileSync(
    path.join(clientRoot, 'src/generated/schema.ts'),
    'utf8',
  );
  assert.match(generated, /GENERATED FILE — DO NOT EDIT/);
  assert.match(generated, /Source: api\/openapi\.v1\.json/);
});

test('built package self-reference resolves through declared exports', async () => {
  const packaged = await import('@forgeflow/client');
  assert.equal(typeof packaged.createForgeFlowClient, 'function');
});

test('generated contract provenance matches the committed OpenAPI artifact', async () => {
  const crypto = await import('node:crypto');
  const packaged = await import('@forgeflow/client');
  const bytes = fs.readFileSync(path.join(root, 'api/openapi.v1.json'));
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const source = JSON.parse(bytes.toString('utf8')) as {
    openapi: string;
    info: { version: string };
  };
  assert.equal(packaged.FORGEFLOW_API_CONTRACT_SHA256, sha);
  assert.equal(packaged.FORGEFLOW_API_CONTRACT_VERSION, source.info.version);
  assert.equal(packaged.FORGEFLOW_OPENAPI_SPEC_VERSION, source.openapi);
});
