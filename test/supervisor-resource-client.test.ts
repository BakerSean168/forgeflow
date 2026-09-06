import assert from 'node:assert/strict';
import test from 'node:test';

import { StaticResourceDirectory } from '../src/core/adapters/resourceDirectory.js';
import { ForgeFlowError } from '../src/core/domain/errors.js';
import type {
  ExecutionResource,
  ExecutionResourceSelection,
  ResourceStateOverrideSource,
} from '../src/core/domain/resourceRouting.js';
import { ResourceSelector } from '../src/core/orchestration/resourceSelector.js';
import { openDatabase } from '../src/core/persistence/database.js';
import { createRepositories } from '../src/core/persistence/repositories.js';
import { ResourceSelectedSupervisorDecisionClient } from '../src/core/supervisor/resourceClient.js';
import type { SupervisorDecisionInput } from '../src/core/supervisor/runtime.js';

function reasoningResource(
  resourceId: string,
  sequence: number,
  routeModel: string,
  protocol: 'openai-chat-completions' | 'openai-responses' = 'openai-chat-completions',
): ExecutionResource {
  return {
    resourceId,
    resourceTier: 'METERED',
    resourceSequence: sequence,
    state: 'ACTIVE',
    ready: true,
    commercialType: 'METERED',
    supplyOrigin: 'COMMERCIAL_RELAY',
    resourceLifecycle: 'RECURRING',
    bindings: [
      {
        bindingId: resourceId + '-sol',
        modelFamily: 'gpt-5.6-sol',
        transport: 'LITELLM_MANAGED',
        enabled: true,
        ready: true,
        agentBackend: 'codex-acp',
        routeModel,
        protocol,
      },
    ],
  };
}

const projection = {
  projectionVersion: 1 as const,
  plan: {
    planId: 'plan-supervisor-resource',
    projectKey: 'supervisor-resource',
    objective: 'exercise resource-selected supervisor',
    repositoryPath: '/repo',
    baseRevision: 'base',
    currentRevision: 'base',
    status: 'RUNNING' as const,
  },
  graph: { items: [] },
  executions: [],
  reviews: [],
  supervisor: {
    supervisorId: 'supervisor-resource',
    status: 'OBSERVING' as const,
    observationCursor: 7,
    allowedActions: ['NO_ACTION'],
  },
  recentEvents: [],
  cursor: 7,
  digest: 'projection-digest',
  truncated: false,
};

const input: SupervisorDecisionInput = {
  conversationId: 'conversation-resource',
  supervisorId: 'supervisor-resource',
  planId: 'plan-supervisor-resource',
  projection,
};

function decision(reason = 'nothing to change') {
  const idempotencyKey = 'decision-resource-' + reason.replace(/\s+/g, '-');
  return {
    version: 1,
    planId: input.planId,
    supervisorId: input.supervisorId,
    observationCursor: projection.supervisor.observationCursor,
    projectionDigest: projection.digest,
    idempotencyKey,
    preconditionSnapshot: {},
    action: {
      actionId: 'action-resource-' + reason.replace(/\s+/g, '-'),
      version: 1,
      type: 'NO_ACTION',
      planId: input.planId,
      supervisorId: input.supervisorId,
      observationCursor: projection.supervisor.observationCursor,
      projectionDigest: projection.digest,
      idempotencyKey,
      preconditionSnapshot: {},
      payload: { type: 'NO_ACTION', reason },
      status: 'PROPOSED',
    },
  };
}

class Feedback {
  successes: Array<{ selection: ExecutionResourceSelection; source?: ResourceStateOverrideSource }> = [];
  failures: Array<{
    selection: ExecutionResourceSelection;
    error: unknown;
    source?: ResourceStateOverrideSource;
  }> = [];

  success(selection: ExecutionResourceSelection, source?: ResourceStateOverrideSource): void {
    this.successes.push({ selection, source });
  }

  failure(
    selection: ExecutionResourceSelection,
    error: unknown,
    source?: ResourceStateOverrideSource,
  ): void {
    this.failures.push({ selection, error, source });
  }
}

function fixture(resources: ExecutionResource[], fetchImpl: typeof fetch, maxAttempts = 3) {
  const db = openDatabase(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } });
  const repositories = createRepositories(db);
  const feedback = new Feedback();
  const client = new ResourceSelectedSupervisorDecisionClient(
    new ResourceSelector(new StaticResourceDirectory(resources)),
    'http://litellm.test/v1',
    'private-test-key',
    repositories.events,
    feedback,
    fetchImpl,
    5_000,
    maxAttempts,
  );
  return { db, repositories, feedback, client };
}

test('Supervisor selects a governed reasoning route instead of a static model alias', async () => {
  const requestedModels: string[] = [];
  const value = fixture(
    [reasoningResource('reasoning-a', 10, 'route-reasoning-a')],
    (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      requestedModels.push(body.model);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision()) } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  );
  const raw = await value.client.decide(input);
  assert.equal(JSON.parse(raw).action.payload.reason, 'nothing to change');
  assert.deepEqual(requestedModels, ['route-reasoning-a']);
  assert.equal(value.feedback.failures.length, 0);
  assert.equal(value.feedback.successes[0]?.selection.phase, 'SUPERVISE');
  assert.equal(value.feedback.successes[0]?.source, 'SUPERVISOR');
  assert.deepEqual(
    value.repositories.events.listByAggregate(input.supervisorId).map((event) => event.type),
    ['SUPERVISOR_RESOURCE_SELECTED', 'SUPERVISOR_RESOURCE_SUCCEEDED'],
  );
  value.db.close();
});

test('Supervisor honors an OpenAI Responses reasoning binding through the governed route', async () => {
  const observed: Array<{ url: string; model: string; instructions?: string }> = [];
  const value = fixture(
    [reasoningResource('responses-reasoning', 10, 'route-responses-sol', 'openai-responses')],
    (async (url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string; instructions?: string };
      observed.push({ url: String(url), model: body.model, instructions: body.instructions });
      return new Response(
        JSON.stringify({
          output: [
            {
              type: 'message',
              content: [
                { type: 'output_text', text: JSON.stringify(decision('responses route worked')) },
              ],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch,
  );
  const raw = await value.client.decide(input);
  assert.equal(JSON.parse(raw).action.payload.reason, 'responses route worked');
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.url, 'http://litellm.test/v1/responses');
  assert.equal(observed[0]?.model, 'route-responses-sol');
  assert.match(observed[0]?.instructions ?? '', /Return exactly one JSON object/);
  assert.equal(value.feedback.successes[0]?.selection.protocol, 'openai-responses');
  value.db.close();
});

test('Supervisor fails over after quota exhaustion and persists only normalized provenance', async () => {
  const requestedModels: string[] = [];
  const value = fixture(
    [
      reasoningResource('reasoning-a', 10, 'route-reasoning-a'),
      reasoningResource('reasoning-b', 20, 'route-reasoning-b'),
    ],
    (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      requestedModels.push(body.model);
      if (body.model === 'route-reasoning-a')
        return new Response(
          JSON.stringify({
            error: {
              message:
                'Unable to reserve quota. Remaining balance: $0.001; required amount: $0.010 request-id-private',
            },
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        );
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision('failover worked')) } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch,
  );
  const raw = await value.client.decide(input);
  assert.equal(JSON.parse(raw).action.payload.reason, 'failover worked');
  assert.deepEqual(requestedModels, ['route-reasoning-a', 'route-reasoning-b']);
  assert.equal(value.feedback.failures.length, 1);
  assert.equal(value.feedback.failures[0]?.source, 'SUPERVISOR');
  assert.equal(value.feedback.successes[0]?.source, 'SUPERVISOR');
  const events = value.repositories.events.listByAggregate(input.supervisorId);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'SUPERVISOR_RESOURCE_SELECTED',
      'SUPERVISOR_RESOURCE_FAILED',
      'SUPERVISOR_RESOURCE_SELECTED',
      'SUPERVISOR_RESOURCE_SUCCEEDED',
    ],
  );
  const failed = events.find((event) => event.type === 'SUPERVISOR_RESOURCE_FAILED');
  assert.equal(failed?.payload.failureClass, 'QUOTA_EXHAUSTED');
  assert.equal(failed?.payload.statusCode, 403);
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes('Remaining balance'), false);
  assert.equal(serialized.includes('request-id-private'), false);
  assert.equal(serialized.includes('private-test-key'), false);
  value.db.close();
});

test('Supervisor retries malformed decisions without poisoning resource health and stays bounded', async () => {
  const value = fixture(
    [
      reasoningResource('reasoning-a', 10, 'route-reasoning-a'),
      reasoningResource('reasoning-b', 20, 'route-reasoning-b'),
    ],
    (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      if (body.model === 'route-reasoning-a')
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"not":"a decision"}' } }] }), {
          status: 200,
        });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision('valid second decision')) } }] }), {
        status: 200,
      });
    }) as typeof fetch,
    2,
  );
  const raw = await value.client.decide(input);
  assert.equal(JSON.parse(raw).action.payload.reason, 'valid second decision');
  assert.equal(value.feedback.failures.length, 0);
  assert.equal(value.feedback.successes.length, 1);
  const failures = value.repositories.events
    .listByAggregate(input.supervisorId)
    .filter((event) => event.type === 'SUPERVISOR_RESOURCE_FAILED');
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.payload.failureClass, 'INVALID_DECISION');
  assert.equal(failures[0]?.payload.failureStage, 'PROTOCOL_VALIDATE');
  assert.equal(failures[0]?.payload.failureCode, 'DECISION_VERSION_UNSUPPORTED');
  assert.equal(failures[0]?.payload.projectionDigest, input.projection.digest);
  assert.equal(failures[0]?.payload.observationCursor, input.projection.cursor);
  value.db.close();
});

test('Supervisor durably excludes a malformed resource for the unchanged projection across wakes', async () => {
  let calls = 0;
  const value = fixture(
    [reasoningResource('reasoning-invalid', 10, 'route-reasoning-invalid')],
    (async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{\"not\":\"a decision\"}' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
    3,
  );
  await assert.rejects(
    () => value.client.decide(input),
    (error: unknown) =>
      error instanceof ForgeFlowError && error.code === 'SUPERVISOR_RESOURCE_ATTEMPTS_EXHAUSTED',
  );
  assert.equal(calls, 1);
  await assert.rejects(
    () => value.client.decide(input),
    (error: unknown) =>
      error instanceof ForgeFlowError &&
      error.code === 'SUPERVISOR_RESOURCE_DECISION_QUALITY_EXHAUSTED',
  );
  assert.equal(calls, 1);
  const failed = value.repositories.events
    .listByAggregate(input.supervisorId)
    .filter((event) => event.type === 'SUPERVISOR_RESOURCE_FAILED');
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.payload.failureStage, 'PROTOCOL_VALIDATE');
  assert.equal(failed[0]?.payload.failureCode, 'DECISION_VERSION_UNSUPPORTED');
  value.db.close();
});

test('Supervisor records response-shape failures without persisting provider bodies', async () => {
  const value = fixture(
    [reasoningResource('reasoning-shape', 10, 'route-reasoning-shape', 'openai-responses')],
    (async () =>
      new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'private-provider-body' }] }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
    1,
  );
  await assert.rejects(() => value.client.decide(input), ForgeFlowError);
  const failed = value.repositories.events
    .listByAggregate(input.supervisorId)
    .find((event) => event.type === 'SUPERVISOR_RESOURCE_FAILED');
  assert.equal(failed?.payload.failureClass, 'INVALID_DECISION');
  assert.equal(failed?.payload.failureStage, 'RESPONSE_EXTRACT');
  assert.equal(failed?.payload.failureCode, 'SUPERVISOR_DECISION_INVALID');
  assert.equal(JSON.stringify(failed).includes('private-provider-body'), false);
  value.db.close();
});

test('Supervisor stops after the bounded set of eligible resources is exhausted', async () => {
  let calls = 0;
  const value = fixture(
    [reasoningResource('reasoning-a', 10, 'route-reasoning-a')],
    (async () => {
      calls += 1;
      return new Response('busy', { status: 503 });
    }) as typeof fetch,
    3,
  );
  await assert.rejects(
    () => value.client.decide(input),
    (error: unknown) =>
      error instanceof ForgeFlowError && error.code === 'SUPERVISOR_RESOURCE_ATTEMPTS_EXHAUSTED',
  );
  assert.equal(calls, 1);
  assert.equal(value.feedback.failures.length, 1);
  value.db.close();
});
