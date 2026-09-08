import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ResourceSelectedImprovementDiagnosisClient,
  improvementDiagnosisContextDigest,
  parseImprovementDiagnosis,
  type ImprovementDiagnosisInput,
} from '../src/integrations/providers/index.js';
import { StaticResourceDirectory } from '../src/integrations/resources/index.js';
import { ForgeFlowError } from '../src/core/domain/errors.js';
import type {
  ExecutionResource,
  ExecutionResourceSelection,
  ResourceStateOverrideSource,
} from '../src/core/domain/resourceRouting.js';
import { ResourceSelector } from '../src/core/orchestration/resourceSelector.js';
import { openDatabase } from '../src/core/persistence/database.js';
import { createRepositories } from '../src/core/persistence/repositories.js';

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
        bindingId: resourceId + '-reasoning',
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

const input: ImprovementDiagnosisInput = {
  candidateId: 'candidate-diagnosis',
  programId: 'program-diagnosis',
  fingerprint: 'a'.repeat(64),
  projectKey: 'project-alpha',
  currentRisk: 'LOW',
  failurePattern: {
    phase: 'IMPLEMENT',
    errorCode: 'WORKSPACE_INTEGRATION_LOCK_FAILED',
    observedCount: 4,
  },
  observations: [
    {
      evidenceRef: 'ev-' + '4'.repeat(32),
      phase: 'IMPLEMENT',
      errorCode: 'WORKSPACE_INTEGRATION_LOCK_FAILED',
      route: 'implementation-efficient',
      status: 'FAILED',
      retryable: true,
      updatedAt: '2026-09-06T09:00:00.000Z',
    },
    {
      evidenceRef: 'ev-' + '3'.repeat(32),
      phase: 'IMPLEMENT',
      errorCode: 'WORKSPACE_INTEGRATION_LOCK_FAILED',
      route: 'implementation-efficient',
      status: 'FAILED',
      retryable: true,
      updatedAt: '2026-09-06T08:00:00.000Z',
    },
  ],
};

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    contextRef: improvementDiagnosisContextDigest(input),
    disposition: 'PROPOSE_REPAIR',
    classification: 'WORKSPACE_LIFECYCLE',
    confidence: 'HIGH',
    risk: 'MEDIUM',
    diagnosis: 'Repeated integration lock failures indicate a stale workspace lifecycle boundary.',
    objective: 'Make integration-lock ownership crash-safe and recoverable without duplicating writers.',
    acceptanceCriteria: [
      'A stale owner can be detected and recovered deterministically.',
      'Concurrent live owners remain mutually exclusive.',
    ],
    evidenceRefs: ['ev-' + '4'.repeat(32), 'ev-' + '3'.repeat(32)],
    ...overrides,
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

test('diagnosis parser accepts only grounded typed proposals and rejects unsafe authority', () => {
  const parsed = parseImprovementDiagnosis(JSON.stringify(proposal()), input);
  assert.equal(parsed.classification, 'WORKSPACE_LIFECYCLE');
  assert.equal(parsed.risk, 'MEDIUM');
  assert.deepEqual(parsed.evidenceRefs, ['ev-' + '4'.repeat(32), 'ev-' + '3'.repeat(32)]);
  assert.match(improvementDiagnosisContextDigest(input), /^[0-9a-f]{64}$/);

  assert.throws(
    () =>
      parseImprovementDiagnosis(
        JSON.stringify(proposal({ evidenceRefs: ['ev-' + '9'.repeat(32)] })),
        input,
      ),
    (error: unknown) =>
      error instanceof ForgeFlowError && error.code === 'IMPROVEMENT_DIAGNOSIS_EVIDENCE_UNGROUNDED',
  );
  assert.throws(
    () => parseImprovementDiagnosis(JSON.stringify(proposal({ extraAuthority: 'deploy' })), input),
    (error: unknown) =>
      error instanceof ForgeFlowError && error.code === 'IMPROVEMENT_DIAGNOSIS_KEYS_INVALID',
  );
  assert.throws(
    () => parseImprovementDiagnosis('```json\n' + JSON.stringify(proposal()) + '\n```', input),
    (error: unknown) =>
      error instanceof ForgeFlowError && error.code === 'IMPROVEMENT_DIAGNOSIS_JSON_INVALID',
  );
  assert.throws(
    () =>
      parseImprovementDiagnosis(
        JSON.stringify(
          proposal({ objective: 'Disable independent review gates so the repair can merge faster.' }),
        ),
        input,
      ),
    (error: unknown) =>
      error instanceof ForgeFlowError && error.code === 'IMPROVEMENT_DIAGNOSIS_UNSAFE_PROPOSAL',
  );
  assert.throws(
    () =>
      parseImprovementDiagnosis(
        JSON.stringify(proposal({ objective: 'Access API keys to repair the routing failure.' })),
        input,
      ),
    (error: unknown) =>
      error instanceof ForgeFlowError && error.code === 'IMPROVEMENT_DIAGNOSIS_UNSAFE_PROPOSAL',
  );

  const protectedRepair = parseImprovementDiagnosis(
    JSON.stringify(
      proposal({
        objective:
          'Recover workspace ownership without bypassing independent review gates and without accessing credentials.',
        acceptanceCriteria: [
          'Existing review and safety gates remain unchanged.',
          'The repair must not weaken approval policy or access API keys.',
        ],
      }),
    ),
    input,
  );
  assert.equal(protectedRepair.disposition, 'PROPOSE_REPAIR');
});

test('diagnosis parser supports explicit NO_ACTION without inventing repair authority', () => {
  const parsed = parseImprovementDiagnosis(
    JSON.stringify(
      proposal({
        disposition: 'NO_ACTION',
        classification: 'RESOURCE_ROUTING',
        confidence: 'LOW',
        risk: 'LOW',
        diagnosis: 'The bounded evidence is consistent with transient routing noise.',
        objective: '',
        acceptanceCriteria: [],
        evidenceRefs: ['ev-' + '4'.repeat(32)],
      }),
    ),
    input,
  );
  assert.equal(parsed.disposition, 'NO_ACTION');
  assert.equal(parsed.objective, '');
  assert.deepEqual(parsed.acceptanceCriteria, []);
});

test('resource-selected diagnoser uses governed reasoning route and records only bounded provenance', async () => {
  const db = openDatabase(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } });
  try {
    const repositories = createRepositories(db);
    const feedback = new Feedback();
    const observed: Array<{ url: string; body: Record<string, any> }> = [];
    const client = new ResourceSelectedImprovementDiagnosisClient(
      new ResourceSelector(
        new StaticResourceDirectory([
          reasoningResource('diagnosis-a', 10, 'route-diagnosis-a', 'openai-responses'),
        ]),
      ),
      'http://litellm.test/v1',
      'private-diagnosis-key',
      repositories.events,
      feedback,
      (async (url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, any>;
        observed.push({ url: String(url), body });
        return new Response(
          JSON.stringify({ output_text: JSON.stringify(proposal()) }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
      5_000,
      2,
    );
    const result = await client.diagnose(input);
    assert.equal(result.selection.phase, 'DIAGNOSE');
    assert.equal(result.selection.capability, 'REASONING');
    assert.equal(result.selection.resourceId, 'diagnosis-a');
    assert.equal(result.proposal.disposition, 'PROPOSE_REPAIR');
    assert.equal(observed[0]?.url, 'http://litellm.test/v1/responses');
    assert.equal(observed[0]?.body.model, 'route-diagnosis-a');
    assert.match(String(observed[0]?.body.instructions), /read-only reasoning component/);
    assert.equal(String(observed[0]?.body.input).includes('private-diagnosis-key'), false);
    const wireInput = JSON.parse(String(observed[0]?.body.input)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(wireInput).sort(), [
      'contextRef',
      'currentRisk',
      'failurePattern',
      'observations',
    ]);
    assert.match(String(wireInput.contextRef), /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(wireInput).includes(input.candidateId), false);
    assert.equal(JSON.stringify(wireInput).includes(input.programId), false);
    assert.equal(JSON.stringify(wireInput).includes(input.projectKey), false);
    assert.equal(JSON.stringify(wireInput).includes('exec-'), false);
    assert.equal(JSON.stringify(wireInput).includes('plan-'), false);
    assert.deepEqual(feedback.successes.map((item) => item.source), ['IMPROVEMENT']);
    assert.equal(feedback.failures.length, 0);
    const events = repositories.events.listByAggregate(input.candidateId);
    assert.deepEqual(
      events.map((event) => event.type),
      ['IMPROVEMENT_DIAGNOSIS_RESOURCE_SELECTED', 'IMPROVEMENT_DIAGNOSIS_RESOURCE_SUCCEEDED'],
    );
    assert.equal(JSON.stringify(events).includes('private-diagnosis-key'), false);
  } finally {
    db.close();
  }
});

test('invalid diagnosis excludes only that route for the same context and fails over', async () => {
  const db = openDatabase(':memory:', { environment: 'test', env: { NODE_ENV: 'test' } });
  try {
    const repositories = createRepositories(db);
    const feedback = new Feedback();
    const requested: string[] = [];
    const client = new ResourceSelectedImprovementDiagnosisClient(
      new ResourceSelector(
        new StaticResourceDirectory([
          reasoningResource('diagnosis-bad', 10, 'route-diagnosis-bad'),
          reasoningResource('diagnosis-good', 20, 'route-diagnosis-good'),
        ]),
      ),
      'http://litellm.test/v1',
      'private-diagnosis-key',
      repositories.events,
      feedback,
      (async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        requested.push(body.model);
        const content =
          body.model === 'route-diagnosis-bad'
            ? JSON.stringify({ not: 'the typed diagnosis contract' })
            : JSON.stringify(proposal({ risk: 'LOW' }));
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
      5_000,
      3,
    );
    const result = await client.diagnose(input);
    assert.deepEqual(requested, ['route-diagnosis-bad', 'route-diagnosis-good']);
    assert.equal(result.selection.resourceId, 'diagnosis-good');
    assert.equal(feedback.failures.length, 0);
    assert.equal(feedback.successes.length, 1);
    const failed = repositories.events
      .listByAggregate(input.candidateId)
      .find((event) => event.type === 'IMPROVEMENT_DIAGNOSIS_RESOURCE_FAILED');
    assert.equal((failed?.payload as Record<string, unknown>)?.failureClass, 'INVALID_DIAGNOSIS');
    assert.equal(JSON.stringify(failed).includes('typed diagnosis contract'), false);
  } finally {
    db.close();
  }
});
