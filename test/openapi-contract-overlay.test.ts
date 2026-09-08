import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';

import { documentedOperationIds, openApiContractOverlay } from '../src/api/contracts/index.js';
import { registerOpenApi } from '../src/api/openapi.js';

test('legacy OpenAPI overlay is documentation-only and does not mutate runtime route schemas', () => {
  const runtimeSchema = { operationId: 'resourcesSetState' };
  const documented = openApiContractOverlay(runtimeSchema);
  assert.equal('body' in runtimeSchema, false);
  assert.notEqual(documented, runtimeSchema);
  assert.equal((documented.body as any).properties.state.type, 'string');
  assert.deepEqual((documented.body as any).required, ['state']);
});

test('Swagger transform documents Resource body while Fastify runtime remains unvalidated by the overlay', async () => {
  const app = Fastify({ logger: false });
  await registerOpenApi(app);
  app.post('/api/v1/resources/:resourceId/state', async (request) => ({ body: request.body }));
  await app.ready();
  try {
    const runtime = await app.inject({
      method: 'POST',
      url: '/api/v1/resources/example/state',
      payload: { state: 42, extra: true },
    });
    assert.equal(runtime.statusCode, 200);
    assert.deepEqual(runtime.json(), { body: { state: 42, extra: true } });

    const openapi = await app.inject({ method: 'GET', url: '/api/openapi.json' });
    assert.equal(openapi.statusCode, 200);
    const operation = openapi.json().paths['/api/v1/resources/{resourceId}/state'].post;
    assert.equal(operation.operationId, 'resourcesSetState');
    assert.equal(operation.requestBody.required, true);
    assert.equal(operation.requestBody.content['application/json'].schema.properties.state.type, 'string');
  } finally {
    await app.close();
  }
});

test('legacy schema-hardening overlay covers every non-Project V1 operation', () => {
  const ids = documentedOperationIds();
  assert.ok(ids.includes('systemHealth'));
  assert.ok(ids.includes('resourcesList'));
  assert.ok(ids.includes('resourcesSetState'));
  assert.ok(ids.includes('releaseAcceptanceRecordAutonomousLifecycle'));
  assert.ok(ids.includes('plansCreate'));
  assert.ok(ids.includes('executionsRun'));
  assert.ok(ids.includes('improvementsDiscover'));
  assert.ok(ids.includes('supervisorsDecide'));
  assert.equal(ids.length, 43);
});


test('final OpenAPI contract keeps legacy optional request bodies optional', async () => {
  const app = Fastify({ logger: false });
  await registerOpenApi(app);
  app.post('/api/v1/plans/:planId/reconcile', async () => ({ statusUrl: '/api/v1/plans/example' }));
  app.post('/api/v1/executions/:executionId/continue', async () => ({}));
  app.post('/api/v1/executions/:executionId/replace-provider-session', async () => ({}));
  app.post('/api/v1/improvements/:candidateId/adopt', async () => ({}));
  await app.ready();
  try {
    const openapi = (await app.inject({ method: 'GET', url: '/api/openapi.json' })).json();
    assert.equal(openapi.paths['/api/v1/plans/{planId}/reconcile'].post.requestBody.required, false);
    assert.equal(openapi.paths['/api/v1/executions/{executionId}/continue'].post.requestBody.required, false);
    assert.equal(
      openapi.paths['/api/v1/executions/{executionId}/replace-provider-session'].post.requestBody.required,
      false,
    );
    assert.equal(openapi.paths['/api/v1/improvements/{candidateId}/adopt'].post.requestBody.required, false);
  } finally {
    await app.close();
  }
});
