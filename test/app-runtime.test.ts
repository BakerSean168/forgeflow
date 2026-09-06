import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildControlPlane } from '../src/app.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function supervisorAdmissionResponse(
  input: string | URL | Request,
  init: RequestInit = {},
): Response | undefined {
  const url = String(input);
  if (!url.endsWith('/responses') && !url.endsWith('/chat/completions')) return undefined;
  let body: any;
  try {
    body = JSON.parse(String(init.body));
  } catch {
    return undefined;
  }
  const admissionPrompt =
    typeof body.instructions === 'string'
      ? body.instructions
      : Array.isArray(body.messages)
        ? body.messages.find((message: any) => message?.role === 'system')?.content
        : undefined;
  if (typeof admissionPrompt !== 'string' || !admissionPrompt.includes('Return exactly one JSON object'))
    return undefined;
  const decision = {
    version: 1,
    planId: 'plan-supervisor-direct-admission',
    supervisorId: 'supervisor-direct-admission',
    observationCursor: 1,
    projectionDigest: 'supervisor-direct-admission-projection-v1',
    idempotencyKey: 'app-runtime-direct-admission',
    preconditionSnapshot: {},
    action: {
      actionId: 'app-runtime-direct-admission-action',
      version: 1,
      type: 'NO_ACTION',
      planId: 'plan-supervisor-direct-admission',
      supervisorId: 'supervisor-direct-admission',
      observationCursor: 1,
      projectionDigest: 'supervisor-direct-admission-projection-v1',
      idempotencyKey: 'app-runtime-direct-admission',
      preconditionSnapshot: {},
      payload: { type: 'NO_ACTION', reason: 'direct admission healthy' },
      status: 'PROPOSED',
    },
  };
  const content = JSON.stringify(decision);
  return url.endsWith('/responses')
    ? new Response(
        JSON.stringify({
          output: [{ type: 'message', content: [{ type: 'output_text', text: content }] }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    : new Response(
        JSON.stringify({ choices: [{ message: { content } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeflow-app-'));
  const allowed = path.join(root, 'repositories');
  const repository = path.join(allowed, 'project');
  const managed = path.join(root, 'managed');
  fs.mkdirSync(repository, { recursive: true });
  fs.mkdirSync(managed, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repository]);
  git(repository, ['config', 'user.name', 'ForgeFlow Test']);
  git(repository, ['config', 'user.email', 'forgeflow-test@local']);
  fs.writeFileSync(path.join(repository, 'README.md'), '# App test\n');
  git(repository, ['add', 'README.md']);
  git(repository, ['commit', '-m', 'chore: initialize']);
  return { root, allowed, repository, managed, revision: git(repository, ['rev-parse', 'HEAD']) };
}

test('ForgeFlow runtime fails closed when execution automation is disabled', async () => {
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    environment: 'test',
    logger: false,
    env: { NODE_ENV: 'test', FORGEFLOW_EXECUTION_RUNTIME_ENABLED: 'false' },
  });
  const health = await runtime.app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().executionRuntime.enabled, false);
  assert.deepEqual(health.json().improvementRuntime, {
    discoveryEnabled: false,
    adoptionEnabled: false,
    autoAdoptLowRisk: false,
    selfChangeEnabled: false,
    allowedProjectKeys: [],
  });
  const run = await runtime.app.inject({ method: 'POST', url: '/api/v1/plans/missing/run' });
  assert.equal(run.statusCode, 503);
  assert.equal(run.json().error, 'EXECUTION_RUNTIME_DISABLED');
  await runtime.app.close();
});

test('Supervisor runtime refuses the retired static model route', async () => {
  await assert.rejects(
    () =>
      buildControlPlane({
        dbFile: ':memory:',
        environment: 'test',
        logger: false,
        env: {
          NODE_ENV: 'test',
          FORGEFLOW_EXECUTION_RUNTIME_ENABLED: 'false',
          FORGEFLOW_SUPERVISOR_RUNTIME_ENABLED: 'true',
          FORGEFLOW_SUPERVISOR_MODEL: 'gpt-5.6-sol',
        },
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'SUPERVISOR_STATIC_ROUTE_UNSUPPORTED',
  );
});

test('Supervisor runtime requires the governed Resource Selector', async () => {
  await assert.rejects(
    () =>
      buildControlPlane({
        dbFile: ':memory:',
        environment: 'test',
        logger: false,
        env: {
          NODE_ENV: 'test',
          FORGEFLOW_EXECUTION_RUNTIME_ENABLED: 'false',
          FORGEFLOW_SUPERVISOR_RUNTIME_ENABLED: 'true',
        },
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'SUPERVISOR_RESOURCE_SELECTOR_REQUIRED',
  );
});

test('ForgeFlow health exposes only validated host cache maintenance state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeflow-host-cache-state-'));
  const stateFile = path.join(root, 'host-cache-maintenance.json');
  try {
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        version: 1,
        checkedAt: '2026-09-05T08:00:00Z',
        action: 'PRUNED_TARGET_REACHED',
        reason: 'SAFE_RECLAIM_COMPLETED',
        freeBytesBefore: 12 * 1024 ** 3,
        freeBytesAfter: 26 * 1024 ** 3,
        activeExecutions: 0,
        triggerFreeBytes: 16 * 1024 ** 3,
        targetFreeBytes: 24 * 1024 ** 3,
        steps: ['BUILDER_CACHE_OLDER_THAN_POLICY'],
        ignoredUntrustedField: 'must-not-project',
      }),
    );
    const runtime = await buildControlPlane({
      dbFile: ':memory:',
      environment: 'test',
      logger: false,
      env: {
        NODE_ENV: 'test',
        FORGEFLOW_EXECUTION_RUNTIME_ENABLED: 'false',
        FORGEFLOW_HOST_CACHE_STATE_FILE: stateFile,
      },
    });
    try {
      const health = await runtime.app.inject({ method: 'GET', url: '/api/health' });
      assert.deepEqual(health.json().hostCacheMaintenance, {
        status: 'AVAILABLE',
        version: 1,
        checkedAt: '2026-09-05T08:00:00Z',
        action: 'PRUNED_TARGET_REACHED',
        reason: 'SAFE_RECLAIM_COMPLETED',
        freeBytesBefore: 12 * 1024 ** 3,
        freeBytesAfter: 26 * 1024 ** 3,
        activeExecutions: 0,
        triggerFreeBytes: 16 * 1024 ** 3,
        targetFreeBytes: 24 * 1024 ** 3,
        steps: ['BUILDER_CACHE_OLDER_THAN_POLICY'],
      });
      const storage = await runtime.app.inject({ method: 'GET', url: '/api/v1/storage' });
      assert.equal(storage.json().hostCacheMaintenance.status, 'AVAILABLE');
      fs.writeFileSync(stateFile, '{"version":1,"action":"UNTRUSTED"}\n');
      const invalid = await runtime.app.inject({ method: 'GET', url: '/api/health' });
      assert.deepEqual(invalid.json().hostCacheMaintenance, { status: 'INVALID' });
    } finally {
      await runtime.app.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ForgeFlow creates a durable first execution through the public plan runtime API', async () => {
  const value = fixture();
  let providerCalled = false;
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    environment: 'test',
    logger: false,
    fetchImpl: (async () => {
      providerCalled = true;
      throw new Error('provider should not launch in first plan cycle');
    }) as typeof fetch,
    env: {
      NODE_ENV: 'test',
      FORGEFLOW_EXECUTION_RUNTIME_ENABLED: 'true',
      FORGEFLOW_AUTOMATION_RUNTIME_ENABLED: 'false',
      FORGEFLOW_OPENHANDS_URL: 'http://openhands.test',
      FORGEFLOW_OPENHANDS_TOKEN: 'test-session-key',
      FORGEFLOW_LITELLM_API_KEY: 'test-litellm-key',
      FORGEFLOW_LITELLM_BASE_URL: 'http://litellm.test/v1',
      FORGEFLOW_ALLOWED_REPOSITORY_ROOTS: value.allowed,
      FORGEFLOW_WORKSPACE_HOST_ROOT: value.managed,
      FORGEFLOW_WORKSPACE_EXECUTION_ROOT: '/workspace',
      FORGEFLOW_AUTOMATION_PROJECTS: 'app-runtime-project',
      FORGEFLOW_WORKSPACE_UID: String(process.getuid?.() ?? 0),
      FORGEFLOW_WORKSPACE_GID: String(process.getgid?.() ?? 0),
    },
  });
  const health = await runtime.app.inject({ method: 'GET', url: '/api/health' });
  assert.deepEqual(health.json().executionRuntime, {
    enabled: true,
    autonomousPolling: false,
    resourceSelectorEnabled: false,
    resourceCount: 2,
    runtimeAdmission: {
      enabled: false,
      demandDriven: true,
      hasDemand: false,
      checked: 0,
      ready: 0,
      unready: 0,
      implementationReady: 0,
      reviewReady: 0,
      durableCache: { checked: 0, ready: 0, unready: 0 },
    },
    routingAuthority: 'LEGACY_ROUTE_LIST',
    compatibilityImplementationRoutes: ['gpt-5.6-luna'],
    compatibilityReviewRoutes: ['codex-business-review', 'gpt-5.6-sol'],
    implementationRoutes: ['gpt-5.6-luna'],
    reviewRoutes: ['codex-business-review', 'gpt-5.6-sol'],
    automationProjectKeys: ['app-runtime-project'],
    literalWorktreeProjectKeys: [],
    requireDelivery: true,
  });
  const created = await runtime.app.inject({
    method: 'POST',
    url: '/api/v1/plans',
    headers: { 'idempotency-key': 'app-runtime-plan' },
    payload: {
      projectKey: 'app-runtime-project',
      objective: 'exercise public execution creation',
      repositoryPath: value.repository,
      baseRevision: value.revision,
      workItems: [
        {
          itemKey: 'first',
          title: 'First',
          objective: 'Implement first item',
          dependencies: [],
          acceptanceCriteria: ['commit the change', 'pass review'],
        },
      ],
    },
  });
  assert.equal(created.statusCode, 201);
  const planId = created.json().plan.planId as string;
  const delivery = {
    remote: 'origin',
    branch: 'forgeflow/app-runtime-plan',
    targetBranch: 'main',
    autoMerge: false,
    mergeMethod: 'merge',
    requiredChecks: [],
  };
  const attached = await runtime.app.inject({
    method: 'POST',
    url: '/api/v1/plans/' + planId + '/delivery',
    payload: delivery,
  });
  assert.equal(attached.statusCode, 201);
  assert.equal(attached.json().delivery.status, 'PENDING');
  const attachedAgain = await runtime.app.inject({
    method: 'POST',
    url: '/api/v1/plans/' + planId + '/delivery',
    payload: delivery,
  });
  assert.equal(attachedAgain.statusCode, 200);
  const child = await runtime.app.inject({
    method: 'POST',
    url: '/api/v1/plans/' + planId + '/children',
    payload: {
      childPlanId: 'app-runtime-child',
      objective: 'repair a delivery base drift',
      relation: 'FOLLOW_UP',
      repositoryPath: value.repository,
      delivery: {
        remote: 'origin',
        branch: 'forgeflow/app-runtime-child',
        targetBranch: 'main',
        autoMerge: false,
        mergeMethod: 'merge',
        requiredChecks: [],
      },
      workItems: [
        {
          itemKey: 'repair',
          title: 'Repair delivery base',
          objective: 'merge the target base safely',
          dependencies: [],
          acceptanceCriteria: ['preserve parent behavior'],
        },
      ],
    },
  });
  assert.equal(child.statusCode, 201);
  assert.equal(child.json().plan.parentPlanId, planId);
  assert.equal(child.json().plan.status, 'READY');
  assert.equal(child.json().plan.delivery.status, 'PENDING');
  assert.equal(child.json().graph.items[0].itemKey, 'repair');
  const parentAfterChild = await runtime.app.inject({
    method: 'GET',
    url: '/api/v1/plans/' + planId,
  });
  assert.ok(parentAfterChild.json().plan.childPlanIds.includes('app-runtime-child'));

  const run = await runtime.app.inject({ method: 'POST', url: '/api/v1/plans/' + planId + '/run' });
  assert.equal(run.statusCode, 200);
  assert.equal(run.json().code, 'IMPLEMENTATION_QUEUED');
  assert.equal(providerCalled, false);
  const state = await runtime.app.inject({ method: 'GET', url: '/api/v1/plans/' + planId });
  assert.equal(state.statusCode, 200);
  const body = state.json();
  assert.equal(body.plan.status, 'RUNNING');
  assert.equal(body.delivery.status, 'PENDING');
  assert.equal(body.plan.delivery.status, 'PENDING');
  assert.equal(body.workItems[0].status, 'RUNNING');
  assert.equal(body.executions.length, 1);
  assert.equal(body.executions[0].identity.phase, 'IMPLEMENT');
  assert.equal(body.executions[0].identity.route, 'gpt-5.6-luna');
  assert.equal(body.executions[0].identity.sourceRevision, value.revision);
  assert.equal(body.executions[0].status, 'QUEUED');

  const plans = await runtime.app.inject({
    method: 'GET',
    url: '/api/v1/plans?status=RUNNING&limit=10',
  });
  assert.equal(plans.statusCode, 200);
  assert.equal(plans.json().count, 1);
  assert.equal(plans.json().items[0].plan.planId, planId);
  assert.equal(plans.json().items[0].workItems[0].itemKey, 'first');
  assert.equal(plans.json().items[0].executions.length, 1);

  const planSummaries = await runtime.app.inject({
    method: 'GET',
    url: '/api/v1/plans?view=summary',
  });
  assert.equal(planSummaries.statusCode, 200);
  assert.equal(planSummaries.json().items[0].executions.length, 1);
  assert.equal(planSummaries.json().items[0].sessions, undefined);
  assert.equal(planSummaries.json().items[0].reviews, undefined);
  assert.equal(planSummaries.json().items[0].supervisor, undefined);

  const executions = await runtime.app.inject({
    method: 'GET',
    url: '/api/v1/executions?planId=' + planId + '&status=QUEUED&limit=10',
  });
  assert.equal(executions.statusCode, 200);
  assert.equal(executions.json().count, 1);
  assert.equal(executions.json().items[0].identity.planId, planId);

  const invalidPlanStatus = await runtime.app.inject({
    method: 'GET',
    url: '/api/v1/plans?status=NOT_A_STATUS',
  });
  assert.equal(invalidPlanStatus.statusCode, 400);
  assert.equal(invalidPlanStatus.json().error, 'PLAN_STATUS_INVALID');

  const invalidExecutionStatus = await runtime.app.inject({
    method: 'GET',
    url: '/api/v1/executions?status=NOT_A_STATUS',
  });
  assert.equal(invalidExecutionStatus.statusCode, 400);
  assert.equal(invalidExecutionStatus.json().error, 'EXECUTION_STATUS_INVALID');

  const execution = await runtime.app.inject({
    method: 'GET',
    url: '/api/v1/executions/' + body.executions[0].identity.executionId,
  });
  assert.equal(execution.statusCode, 200);
  assert.equal(execution.json().session, undefined);

  const executionId = body.executions[0].identity.executionId as string;
  const workItemId = body.workItems[0].workItemId as string;
  runtime.repositories.executions.updateStatus(executionId, 'RUNNING');
  runtime.repositories.executions.recordResult(executionId, {
    status: 'FAILED',
    errorCode: 'WORKSPACE_DIRTY',
    retryable: false,
  });
  runtime.repositories.plans.updateWorkItemStatus(workItemId, 'FAILED');
  runtime.repositories.plans.updateStatus(planId, 'FAILED');

  const invalidReconcile = await runtime.app.inject({
    method: 'POST',
    url: '/api/v1/plans/' + planId + '/reconcile',
    payload: { mode: 'force' },
  });
  assert.equal(invalidReconcile.statusCode, 400);
  assert.equal(invalidReconcile.json().error, 'PLAN_RECONCILE_MODE_INVALID');

  const reconcile = await runtime.app.inject({
    method: 'POST',
    url: '/api/v1/plans/' + planId + '/reconcile',
    payload: { mode: 'auto' },
  });
  assert.equal(reconcile.statusCode, 202);
  assert.equal(reconcile.json().code, 'FINALIZATION_RECOVERY_QUEUED');
  assert.equal(reconcile.json().statusUrl, '/api/v1/plans/' + planId);
  assert.notEqual(reconcile.json().executionId, executionId);
  assert.equal(providerCalled, false);

  const recovered = await runtime.app.inject({ method: 'GET', url: '/api/v1/plans/' + planId });
  assert.equal(recovered.json().plan.status, 'RUNNING');
  assert.equal(recovered.json().workItems[0].status, 'RUNNING');
  assert.equal(recovered.json().executions.length, 2);
  assert.equal(recovered.json().executions[0].status, 'FAILED');
  assert.equal(recovered.json().executions[0].errorCode, 'WORKSPACE_DIRTY');
  assert.equal(recovered.json().executions[1].status, 'QUEUED');
  assert.equal(recovered.json().executions[1].identity.parentExecutionId, executionId);
  assert.equal(recovered.json().executions[1].identity.route, 'gpt-5.6-luna');
  await runtime.app.close();
});

test('ForgeFlow resource selector creates immutable execution provenance and resource controls gate later plans', async () => {
  const value = fixture();
  const adminEnv = path.join(value.root, 'litellm.env');
  fs.writeFileSync(adminEnv, 'LITELLM_MASTER_KEY=test-master-key\n');
  let providerCalled = false;
  let statePatchCalls = 0;
  let deploymentBlocked = false;
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/model/info')) {
      return new Response(
        JSON.stringify({
          data: [
            {
              model_name: 'route-free-deepseek-v4-flash',
              litellm_params: { litellm_credential_name: 'free-provider' },
              model_info: {
                id: 'deployment-free-deepseek',
                blocked: deploymentBlocked,
                metadata: {
                  automatic_core: true,
                  resource_id: 'free-provider',
                  resource_sequence: 101,
                  model_family: 'deepseek-v4-flash',
                  route_model: 'route-free-deepseek-v4-flash',
                  protocol: 'openai-chat-completions',
                  commercial_type: 'FREE',
                  supply_origin: 'COMMUNITY_RELAY',
                  resource_lifecycle: 'RECURRING',
                },
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/model/deployment-free-deepseek/update') && init.method === 'PATCH') {
      statePatchCalls += 1;
      const body = JSON.parse(String(init.body));
      assert.equal(typeof body.blocked, 'boolean');
      deploymentBlocked = body.blocked;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    providerCalled = true;
    throw new Error('provider should not launch while only creating an execution');
  }) as typeof fetch;
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    environment: 'test',
    logger: false,
    fetchImpl: fakeFetch,
    env: {
      NODE_ENV: 'test',
      FORGEFLOW_EXECUTION_RUNTIME_ENABLED: 'true',
      FORGEFLOW_AUTOMATION_RUNTIME_ENABLED: 'false',
      FORGEFLOW_RESOURCE_SELECTOR_ENABLED: 'true',
      FORGEFLOW_SUPERVISOR_RUNTIME_ENABLED: 'true',
      FORGEFLOW_SUPERVISOR_POLL_MS: '300000',
      // Deliberately conflicting legacy route lists prove selector mode never
      // reads or validates the rollback-only route authority.
      FORGEFLOW_IMPLEMENTATION_ROUTES: 'must-not-be-read',
      FORGEFLOW_REVIEW_ROUTES: 'must-not-be-read',
      FORGEFLOW_BUSINESS_RESOURCE_ENABLED: 'false',
      FORGEFLOW_OPENHANDS_URL: 'http://openhands.test',
      FORGEFLOW_OPENHANDS_TOKEN: 'test-session-key',
      FORGEFLOW_LITELLM_API_KEY: 'test-litellm-key',
      FORGEFLOW_LITELLM_BASE_URL: 'http://litellm.test/v1',
      FORGEFLOW_LITELLM_ADMIN_BASE_URL: 'http://litellm.test',
      FORGEFLOW_LITELLM_ADMIN_ENV_FILE: adminEnv,
      FORGEFLOW_ALLOWED_REPOSITORY_ROOTS: value.allowed,
      FORGEFLOW_WORKSPACE_HOST_ROOT: value.managed,
      FORGEFLOW_WORKSPACE_EXECUTION_ROOT: '/workspace',
      FORGEFLOW_AUTOMATION_PROJECTS: 'app-runtime-project',
      FORGEFLOW_WORKSPACE_UID: String(process.getuid?.() ?? 0),
      FORGEFLOW_WORKSPACE_GID: String(process.getgid?.() ?? 0),
    },
  });

  assert.equal(runtime.automation?.worker.requireResourceSelection, true);
  assert.equal(runtime.automation?.worker.routes.size, 0);
  assert.deepEqual(runtime.automation?.compatibilityImplementationRoutes, []);
  assert.deepEqual(runtime.automation?.compatibilityReviewRoutes, []);
  assert.deepEqual(runtime.automation?.implementationRoutes, [
    'deepseek-v4-flash',
    'glm-current',
    'gpt-5.6-luna',
  ]);
  assert.deepEqual(runtime.automation?.reviewRoutes, [
    'gpt-5.6-sol',
    'claude-opus-5',
    'claude-opus-4-8',
  ]);
  const selectorHealth = await runtime.app.inject({ method: 'GET', url: '/api/health' });
  assert.deepEqual(selectorHealth.json().supervisorRuntime, {
    enabled: true,
    resourceSelectorEnabled: true,
    readinessAuthority: 'DIRECT_PROTOCOL_ADMISSION_AND_FEEDBACK',
    resourceWakeMode: 'EVENT_DRIVEN_WITH_15M_FALLBACK',
    directAdmission: {
      enabled: true,
      demandDriven: true,
      hasDemand: false,
      checked: 0,
      ready: 0,
      unready: 0,
      durableCache: { checked: 0, ready: 0, unready: 0 },
    },
    maxResourceAttempts: 3,
  });
  const supervisorAdmission = await runtime.app.inject({
    method: 'GET',
    url: '/api/v1/supervisor-admission',
  });
  assert.equal(supervisorAdmission.statusCode, 200);
  assert.deepEqual(supervisorAdmission.json(), {
    enabled: true,
    demandDriven: true,
    hasDemand: false,
    summary: { checked: 0, ready: 0, unready: 0 },
    items: [],
    durableCache: {
      summary: { checked: 0, ready: 0, unready: 0 },
      items: [],
    },
  });
  assert.equal(JSON.stringify(supervisorAdmission.json()).includes('test-litellm-key'), false);

  assert.equal(selectorHealth.json().executionRuntime.routingAuthority, 'RESOURCE_SELECTOR');
  assert.deepEqual(selectorHealth.json().executionRuntime.compatibilityImplementationRoutes, []);
  assert.deepEqual(selectorHealth.json().executionRuntime.compatibilityReviewRoutes, []);

  const runtimeAdmissionInvalidations: Array<{ type: 'resource' | 'binding'; resourceId: string; bindingId?: string }> = [];
  const originalInvalidateResource = runtime.automation!.runtimeAdmission.invalidateResource.bind(
    runtime.automation!.runtimeAdmission,
  );
  const originalInvalidateBinding = runtime.automation!.runtimeAdmission.invalidateBinding.bind(
    runtime.automation!.runtimeAdmission,
  );
  runtime.automation!.runtimeAdmission.invalidateResource = (resourceId: string) => {
    runtimeAdmissionInvalidations.push({ type: 'resource', resourceId });
    return originalInvalidateResource(resourceId);
  };
  runtime.automation!.runtimeAdmission.invalidateBinding = (resourceId: string, bindingId: string) => {
    runtimeAdmissionInvalidations.push({ type: 'binding', resourceId, bindingId });
    return originalInvalidateBinding(resourceId, bindingId);
  };

  const resources = await runtime.app.inject({ method: 'GET', url: '/api/v1/resources' });
  assert.equal(resources.statusCode, 200);
  assert.equal(resources.json().count, 3);
  const free = resources.json().items.find((item: any) => item.resourceId === 'free-provider');
  assert.equal(free.resourceTier, 'FREE');
  assert.equal(free.resourceSequence, 101);
  assert.equal(free.modelBindings[0].agentBackend, 'dsh-acp');

  const createPlan = async (key: string) => {
    const created = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: { 'idempotency-key': key },
      payload: {
        projectKey: 'app-runtime-project',
        objective: 'exercise resource routing',
        repositoryPath: value.repository,
        baseRevision: value.revision,
        workItems: [
          {
            itemKey: 'first',
            title: 'First',
            objective: 'Implement first item',
            dependencies: [],
            acceptanceCriteria: ['commit the change'],
          },
        ],
      },
    });
    assert.equal(created.statusCode, 201);
    return created.json().plan.planId as string;
  };

  const planId = await createPlan('selector-plan');
  const run = await runtime.app.inject({ method: 'POST', url: `/api/v1/plans/${planId}/run` });
  assert.equal(run.statusCode, 200);
  assert.equal(run.json().code, 'IMPLEMENTATION_QUEUED');
  assert.equal(providerCalled, false);
  const state = await runtime.app.inject({ method: 'GET', url: `/api/v1/plans/${planId}` });
  const execution = state.json().executions[0];
  assert.match(execution.identity.route, /^resource:free-provider:/);
  assert.equal(execution.resourceSelection.resourceId, 'free-provider');
  assert.equal(execution.resourceSelection.modelFamily, 'deepseek-v4-flash');
  assert.equal(execution.resourceSelection.agentBackend, 'dsh-acp');
  assert.equal(execution.resourceSelection.routeModel, 'route-free-deepseek-v4-flash');

  const bindingDisabled = await runtime.app.inject({
    method: 'POST',
    url: '/api/v1/resources/free-provider/bindings/deployment-free-deepseek/state',
    payload: { state: 'DISABLED' },
  });
  assert.equal(bindingDisabled.statusCode, 200);
  assert.equal(bindingDisabled.json().resource.modelBindings[0].enabled, false);
  assert.deepEqual(runtimeAdmissionInvalidations.at(-1), {
    type: 'binding',
    resourceId: 'free-provider',
    bindingId: 'deployment-free-deepseek',
  });
  const bindingEnabled = await runtime.app.inject({
    method: 'POST',
    url: '/api/v1/resources/free-provider/bindings/deployment-free-deepseek/state',
    payload: { state: 'ACTIVE' },
  });
  assert.equal(bindingEnabled.statusCode, 200);
  assert.equal(bindingEnabled.json().resource.modelBindings[0].enabled, true);
  assert.deepEqual(runtimeAdmissionInvalidations.at(-1), {
    type: 'binding',
    resourceId: 'free-provider',
    bindingId: 'deployment-free-deepseek',
  });

  const disabled = await runtime.app.inject({
    method: 'POST',
    url: '/api/v1/resources/free-provider/state',
    payload: { state: 'DISABLED', reason: 'operator test', expectedVersion: 0 },
  });
  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.json().resource.state, 'DISABLED');
  assert.deepEqual(runtimeAdmissionInvalidations.at(-1), {
    type: 'resource',
    resourceId: 'free-provider',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(statePatchCalls, 3);
  assert.equal(deploymentBlocked, true);

  const waitingPlanId = await createPlan('selector-waiting-plan');
  const waiting = await runtime.app.inject({
    method: 'POST',
    url: `/api/v1/plans/${waitingPlanId}/run`,
  });
  assert.equal(waiting.statusCode, 200);
  assert.equal(waiting.json().code, 'WAITING_FOR_RESOURCE');
  const waitingState = await runtime.app.inject({
    method: 'GET',
    url: `/api/v1/plans/${waitingPlanId}`,
  });
  assert.equal(waitingState.json().plan.status, 'WAITING_FOR_RESOURCE');
  await runtime.app.close();
});

test('reasoning resource recovery wakes waiting Supervisors without implementation-only false positives', async () => {
  const value = fixture();
  const adminEnv = path.join(value.root, 'litellm-resource-wake.env');
  fs.writeFileSync(adminEnv, 'LITELLM_MASTER_KEY=test-master-key\n');
  let reasoningBlocked = true;
  let implementationBlocked = true;
  const modelInfo = () => ({
    data: [
      {
        model_name: 'route-resource-wake-sol',
        litellm_params: { litellm_credential_name: 'reasoning-provider' },
        model_info: {
          id: 'deployment-resource-wake-sol',
          blocked: reasoningBlocked,
          metadata: {
            automatic_core: true,
            resource_id: 'reasoning-provider',
            resource_sequence: 201,
            model_family: 'gpt-5.6-sol',
            route_model: 'route-resource-wake-sol',
            protocol: 'openai-chat-completions',
            commercial_type: 'METERED',
            supply_origin: 'COMMERCIAL_RELAY',
            resource_lifecycle: 'RECURRING',
          },
        },
      },
      {
        model_name: 'route-resource-wake-deepseek',
        litellm_params: { litellm_credential_name: 'implementation-provider' },
        model_info: {
          id: 'deployment-resource-wake-deepseek',
          blocked: implementationBlocked,
          metadata: {
            automatic_core: true,
            resource_id: 'implementation-provider',
            resource_sequence: 202,
            model_family: 'deepseek-v4-flash',
            route_model: 'route-resource-wake-deepseek',
            protocol: 'openai-chat-completions',
            commercial_type: 'METERED',
            supply_origin: 'COMMERCIAL_RELAY',
            resource_lifecycle: 'RECURRING',
          },
        },
      },
    ],
  });
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/model/info'))
      return new Response(JSON.stringify(modelInfo()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.includes('/model/deployment-resource-wake-sol/update')) {
      reasoningBlocked = Boolean((JSON.parse(String(init.body)) as { blocked: boolean }).blocked);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.includes('/model/deployment-resource-wake-deepseek/update')) {
      implementationBlocked = Boolean((JSON.parse(String(init.body)) as { blocked: boolean }).blocked);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    const admission = supervisorAdmissionResponse(input, init);
    if (admission) return admission;
    throw new Error('unexpected resource-wake fetch: ' + url);
  }) as typeof fetch;

  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    environment: 'test',
    logger: false,
    fetchImpl: fakeFetch,
    env: {
      NODE_ENV: 'test',
      FORGEFLOW_EXECUTION_RUNTIME_ENABLED: 'true',
      FORGEFLOW_AUTOMATION_RUNTIME_ENABLED: 'false',
      FORGEFLOW_RESOURCE_SELECTOR_ENABLED: 'true',
      FORGEFLOW_SUPERVISOR_RUNTIME_ENABLED: 'true',
      FORGEFLOW_SUPERVISOR_POLL_MS: '300000',
      FORGEFLOW_BUSINESS_RESOURCE_ENABLED: 'false',
      FORGEFLOW_OPENHANDS_URL: 'http://openhands.test',
      FORGEFLOW_OPENHANDS_TOKEN: 'test-session-key',
      FORGEFLOW_LITELLM_API_KEY: 'test-litellm-key',
      FORGEFLOW_LITELLM_BASE_URL: 'http://litellm.test/v1',
      FORGEFLOW_LITELLM_ADMIN_BASE_URL: 'http://litellm.test',
      FORGEFLOW_LITELLM_ADMIN_ENV_FILE: adminEnv,
      FORGEFLOW_ALLOWED_REPOSITORY_ROOTS: value.allowed,
      FORGEFLOW_WORKSPACE_HOST_ROOT: value.managed,
      FORGEFLOW_WORKSPACE_EXECUTION_ROOT: '/workspace',
      FORGEFLOW_AUTOMATION_PROJECTS: 'resource-wake-project',
      FORGEFLOW_WORKSPACE_UID: String(process.getuid?.() ?? 0),
      FORGEFLOW_WORKSPACE_GID: String(process.getgid?.() ?? 0),
    },
  });
  try {
    const plan = runtime.repositories.plans.createPlan({
      idempotencyKey: 'resource-wake-plan',
      projectKey: 'resource-wake-project',
      objective: 'wait for a reasoning resource',
      repositoryPath: value.repository,
      baseRevision: value.revision,
    }).value!;
    runtime.repositories.plans.updateStatus(plan.planId, 'READY');
    const supervisor = runtime.repositories.supervisors.create({ planId: plan.planId }).value!;
    runtime.repositories.supervisors.updateStatus(supervisor.supervisorId, 'ACTIVE');
    runtime.repositories.supervisors.updateStatus(supervisor.supervisorId, 'OBSERVING');
    runtime.repositories.supervisors.updateStatus(supervisor.supervisorId, 'DIAGNOSING');
    runtime.repositories.supervisors.updateStatus(supervisor.supervisorId, 'WAITING_FOR_RESOURCE');

    const implementation = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/resources/implementation-provider/bindings/deployment-resource-wake-deepseek/state',
      payload: { state: 'ACTIVE' },
    });
    assert.equal(implementation.statusCode, 200);
    assert.deepEqual(implementation.json().resourceWake, {
      becameAvailable: [],
      scheduledWakes: 0,
    });
    assert.deepEqual(runtime.supervisor.scheduler.drain(), []);

    const reasoning = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/resources/reasoning-provider/bindings/deployment-resource-wake-sol/state',
      payload: { state: 'ACTIVE' },
    });
    assert.equal(reasoning.statusCode, 200);
    assert.deepEqual(reasoning.json().resourceWake, {
      becameAvailable: ['reasoning-provider'],
      scheduledWakes: 1,
    });
    const wakes = runtime.supervisor.scheduler.drain();
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0]?.supervisorId, supervisor.supervisorId);
    assert.equal(wakes[0]?.reason, 'RESOURCE_TRANSITION');
    const availabilityEvents = runtime.repositories.events.listByAggregate(
      'supervisor-resource-availability',
    );
    assert.equal(availabilityEvents.at(-1)?.type, 'SUPERVISOR_RESOURCE_AVAILABILITY_CHANGED');
    assert.deepEqual(availabilityEvents.at(-1)?.payload, {
      becameAvailable: ['reasoning-provider'],
    });

    const duplicate = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/resources/reasoning-provider/bindings/deployment-resource-wake-sol/state',
      payload: { state: 'ACTIVE' },
    });
    assert.equal(duplicate.statusCode, 200);
    assert.deepEqual(duplicate.json().resourceWake, {
      becameAvailable: [],
      scheduledWakes: 0,
    });
    assert.deepEqual(runtime.supervisor.scheduler.drain(), []);
  } finally {
    await runtime.app.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('startup reconciles a recovered reasoning resource for a durable waiting Supervisor', async () => {
  const value = fixture();
  const dbFile = path.join(value.root, 'resource-wake-restart.sqlite');
  const adminEnv = path.join(value.root, 'litellm-resource-wake-restart.env');
  fs.writeFileSync(adminEnv, 'LITELLM_MASTER_KEY=test-master-key\n');
  let blocked = true;
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/model/info'))
      return new Response(
        JSON.stringify({
          data: [
            {
              model_name: 'route-restart-sol',
              litellm_params: { litellm_credential_name: 'restart-reasoning' },
              model_info: {
                id: 'deployment-restart-sol',
                blocked,
                metadata: {
                  automatic_core: true,
                  resource_id: 'restart-reasoning',
                  resource_sequence: 301,
                  model_family: 'gpt-5.6-sol',
                  route_model: 'route-restart-sol',
                  protocol: 'openai-chat-completions',
                  commercial_type: 'METERED',
                  supply_origin: 'COMMERCIAL_RELAY',
                  resource_lifecycle: 'RECURRING',
                },
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    if (url.includes('/model/deployment-restart-sol/update')) {
      blocked = Boolean((JSON.parse(String(init.body)) as { blocked: boolean }).blocked);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    const admission = supervisorAdmissionResponse(input, init);
    if (admission) return admission;
    throw new Error('unexpected resource-wake restart fetch: ' + url);
  }) as typeof fetch;
  const env = {
    NODE_ENV: 'test',
    FORGEFLOW_EXECUTION_RUNTIME_ENABLED: 'true',
    FORGEFLOW_AUTOMATION_RUNTIME_ENABLED: 'false',
    FORGEFLOW_RESOURCE_SELECTOR_ENABLED: 'true',
    FORGEFLOW_SUPERVISOR_RUNTIME_ENABLED: 'true',
    FORGEFLOW_SUPERVISOR_POLL_MS: '300000',
    FORGEFLOW_BUSINESS_RESOURCE_ENABLED: 'false',
    FORGEFLOW_OPENHANDS_URL: 'http://openhands.test',
    FORGEFLOW_OPENHANDS_TOKEN: 'test-session-key',
    FORGEFLOW_LITELLM_API_KEY: 'test-litellm-key',
    FORGEFLOW_LITELLM_BASE_URL: 'http://litellm.test/v1',
    FORGEFLOW_LITELLM_ADMIN_BASE_URL: 'http://litellm.test',
    FORGEFLOW_LITELLM_ADMIN_ENV_FILE: adminEnv,
    FORGEFLOW_ALLOWED_REPOSITORY_ROOTS: value.allowed,
    FORGEFLOW_WORKSPACE_HOST_ROOT: value.managed,
    FORGEFLOW_WORKSPACE_EXECUTION_ROOT: '/workspace',
    FORGEFLOW_AUTOMATION_PROJECTS: 'resource-wake-restart-project',
    FORGEFLOW_WORKSPACE_UID: String(process.getuid?.() ?? 0),
    FORGEFLOW_WORKSPACE_GID: String(process.getgid?.() ?? 0),
  };

  const first = await buildControlPlane({
    dbFile,
    environment: 'test',
    logger: false,
    fetchImpl: fakeFetch,
    env,
  });
  let supervisorId = '';
  try {
    const plan = first.repositories.plans.createPlan({
      idempotencyKey: 'resource-wake-restart-plan',
      projectKey: 'resource-wake-restart-project',
      objective: 'survive provider recovery across restart',
      repositoryPath: value.repository,
      baseRevision: value.revision,
    }).value!;
    first.repositories.plans.updateStatus(plan.planId, 'READY');
    const supervisor = first.repositories.supervisors.create({ planId: plan.planId }).value!;
    supervisorId = supervisor.supervisorId;
    first.repositories.supervisors.updateStatus(supervisorId, 'ACTIVE');
    first.repositories.supervisors.updateStatus(supervisorId, 'OBSERVING');
    first.repositories.supervisors.updateStatus(supervisorId, 'DIAGNOSING');
    first.repositories.supervisors.updateStatus(supervisorId, 'WAITING_FOR_RESOURCE');
  } finally {
    await first.app.close();
  }

  blocked = false;
  const second = await buildControlPlane({
    dbFile,
    environment: 'test',
    logger: false,
    fetchImpl: fakeFetch,
    env,
  });
  try {
    await second.supervisor.reconcileReadiness();
    const wakes = second.supervisor.scheduler.drain();
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0]?.supervisorId, supervisorId);
    assert.equal(wakes[0]?.reason, 'RESOURCE_TRANSITION');
    const events = second.repositories.events.listByAggregate('supervisor-resource-availability');
    assert.equal(events.at(-1)?.type, 'SUPERVISOR_RESOURCE_AVAILABILITY_CHANGED');
    assert.deepEqual(events.at(-1)?.payload, { becameAvailable: ['restart-reasoning'] });
  } finally {
    await second.app.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('Supervisor direct admission failure TTL survives control-plane restart without another paid probe', async () => {
  const value = fixture();
  const dbFile = path.join(value.root, 'supervisor-admission-restart.sqlite');
  const adminEnv = path.join(value.root, 'litellm-supervisor-admission-restart.env');
  fs.writeFileSync(adminEnv, 'LITELLM_MASTER_KEY=test-master-key\n');
  let admissionCalls = 0;
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/model/info'))
      return new Response(
        JSON.stringify({
          data: [
            {
              model_name: 'route-durable-admission-sol',
              litellm_params: { litellm_credential_name: 'durable-admission-provider' },
              model_info: {
                id: 'deployment-durable-admission-sol',
                blocked: false,
                metadata: {
                  automatic_core: true,
                  resource_id: 'durable-admission-provider',
                  resource_sequence: 401,
                  model_family: 'gpt-5.6-sol',
                  route_model: 'route-durable-admission-sol',
                  protocol: 'openai-responses',
                  commercial_type: 'METERED',
                  supply_origin: 'COMMERCIAL_RELAY',
                  resource_lifecycle: 'RECURRING',
                },
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    let body: any;
    try {
      body = JSON.parse(String(init.body));
    } catch {
      body = undefined;
    }
    if (
      url.endsWith('/responses') &&
      typeof body?.instructions === 'string' &&
      body.instructions.includes('Return exactly one JSON object')
    ) {
      admissionCalls += 1;
      return new Response('upstream unavailable with private diagnostic', { status: 502 });
    }
    throw new Error('unexpected durable-admission fetch: ' + url);
  }) as typeof fetch;
  const env = {
    NODE_ENV: 'test',
    FORGEFLOW_EXECUTION_RUNTIME_ENABLED: 'true',
    FORGEFLOW_AUTOMATION_RUNTIME_ENABLED: 'false',
    FORGEFLOW_RESOURCE_SELECTOR_ENABLED: 'true',
    FORGEFLOW_SUPERVISOR_RUNTIME_ENABLED: 'true',
    FORGEFLOW_SUPERVISOR_POLL_MS: '300000',
    FORGEFLOW_SUPERVISOR_ADMISSION_FAILURE_TTL_MS: '300000',
    FORGEFLOW_BUSINESS_RESOURCE_ENABLED: 'false',
    FORGEFLOW_OPENHANDS_URL: 'http://openhands.test',
    FORGEFLOW_OPENHANDS_TOKEN: 'test-session-key',
    FORGEFLOW_LITELLM_API_KEY: 'test-litellm-key',
    FORGEFLOW_LITELLM_BASE_URL: 'http://litellm.test/v1',
    FORGEFLOW_LITELLM_ADMIN_BASE_URL: 'http://litellm.test',
    FORGEFLOW_LITELLM_ADMIN_ENV_FILE: adminEnv,
    FORGEFLOW_ALLOWED_REPOSITORY_ROOTS: value.allowed,
    FORGEFLOW_WORKSPACE_HOST_ROOT: value.managed,
    FORGEFLOW_WORKSPACE_EXECUTION_ROOT: '/workspace',
    FORGEFLOW_AUTOMATION_PROJECTS: 'durable-admission-project',
    FORGEFLOW_WORKSPACE_UID: String(process.getuid?.() ?? 0),
    FORGEFLOW_WORKSPACE_GID: String(process.getgid?.() ?? 0),
  };

  const first = await buildControlPlane({
    dbFile,
    environment: 'test',
    logger: false,
    fetchImpl: fakeFetch,
    env,
  });
  try {
    await first.supervisor.reconcileReadiness();
    assert.equal(admissionCalls, 0);
    const idleHealth = await first.app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(idleHealth.json().supervisorRuntime.directAdmission.hasDemand, false);
    const demandPlan = first.repositories.plans.createPlan({
      idempotencyKey: 'durable-admission-demand-plan',
      projectKey: 'durable-admission-project',
      objective: 'create Supervisor admission demand',
      repositoryPath: value.repository,
      baseRevision: value.revision,
    }).value!;
    first.repositories.plans.updateStatus(demandPlan.planId, 'READY');
    const demandSupervisor = first.repositories.supervisors.create({
      planId: demandPlan.planId,
    }).value!;
    first.repositories.supervisors.updateStatus(demandSupervisor.supervisorId, 'ACTIVE');
    await first.supervisor.reconcileReadiness();
    assert.equal(admissionCalls, 1);
    const demandHealth = await first.app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(demandHealth.json().supervisorRuntime.directAdmission.hasDemand, true);
    assert.deepEqual(first.supervisor.directAdmission.summary(), {
      checked: 1,
      ready: 0,
      unready: 1,
    });
    const durable = first.repositories.supervisorDirectAdmissions.list();
    assert.equal(durable.length, 1);
    assert.equal(durable[0]?.errorCode, 'SUPERVISOR_DIRECT_ADMISSION_HTTP_502');
  } finally {
    await first.app.close();
  }

  const second = await buildControlPlane({
    dbFile,
    environment: 'test',
    logger: false,
    fetchImpl: fakeFetch,
    env,
  });
  try {
    assert.deepEqual(second.supervisor.directAdmission.summary(), {
      checked: 1,
      ready: 0,
      unready: 1,
    });
    await second.supervisor.reconcileReadiness();
    assert.equal(admissionCalls, 1);
    const endpoint = await second.app.inject({ method: 'GET', url: '/api/v1/supervisor-admission' });
    assert.equal(endpoint.statusCode, 200);
    assert.equal(endpoint.json().items[0].errorCode, 'SUPERVISOR_DIRECT_ADMISSION_HTTP_502');
    assert.equal(endpoint.json().durableCache.items[0].errorCode, 'SUPERVISOR_DIRECT_ADMISSION_HTTP_502');
    assert.deepEqual(endpoint.json().durableCache.summary, { checked: 1, ready: 0, unready: 1 });
    assert.equal(JSON.stringify(endpoint.json()).includes('private diagnostic'), false);
    assert.equal(JSON.stringify(endpoint.json()).includes('test-litellm-key'), false);
  } finally {
    await second.app.close();
  }

  const callsBeforeDisabledRead = admissionCalls;
  const disabled = await buildControlPlane({
    dbFile,
    environment: 'test',
    logger: false,
    fetchImpl: fakeFetch,
    env: { ...env, FORGEFLOW_SUPERVISOR_RUNTIME_ENABLED: 'false' },
  });
  try {
    const disabledHealth = await disabled.app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(disabledHealth.statusCode, 200);
    assert.deepEqual(disabledHealth.json().supervisorRuntime.directAdmission, {
      enabled: false,
      demandDriven: true,
      hasDemand: true,
      checked: 0,
      ready: 0,
      unready: 0,
      durableCache: { checked: 1, ready: 0, unready: 1 },
    });
    const endpoint = await disabled.app.inject({
      method: 'GET',
      url: '/api/v1/supervisor-admission',
    });
    assert.equal(endpoint.statusCode, 200);
    assert.equal(endpoint.json().enabled, false);
    assert.deepEqual(endpoint.json().summary, { checked: 0, ready: 0, unready: 0 });
    assert.deepEqual(endpoint.json().items, []);
    assert.deepEqual(endpoint.json().durableCache.summary, { checked: 1, ready: 0, unready: 1 });
    assert.equal(endpoint.json().durableCache.items[0].resourceId, 'durable-admission-provider');
    assert.equal(endpoint.json().durableCache.items[0].errorCode, 'SUPERVISOR_DIRECT_ADMISSION_HTTP_502');
    assert.equal('admissionKey' in endpoint.json().durableCache.items[0], false);
    assert.equal(JSON.stringify(endpoint.json()).includes('private diagnostic'), false);
    assert.equal(JSON.stringify(endpoint.json()).includes('test-litellm-key'), false);
    assert.equal(admissionCalls, callsBeforeDisabledRead);
  } finally {
    await disabled.app.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('selector-off rollback preserves durable selector provenance in the same durable database', async () => {
  const value = fixture();
  const dbFile = path.join(value.root, 'rollback.sqlite');
  const adminEnv = path.join(value.root, 'litellm.env');
  fs.writeFileSync(adminEnv, 'LITELLM_MASTER_KEY=test-master-key\n');
  const commonEnv = {
    NODE_ENV: 'test',
    FORGEFLOW_EXECUTION_RUNTIME_ENABLED: 'true',
    FORGEFLOW_AUTOMATION_RUNTIME_ENABLED: 'false',
    FORGEFLOW_OPENHANDS_URL: 'http://openhands.test',
    FORGEFLOW_OPENHANDS_TOKEN: 'test-session-key',
    FORGEFLOW_LITELLM_API_KEY: 'test-litellm-key',
    FORGEFLOW_LITELLM_BASE_URL: 'http://litellm.test/v1',
    FORGEFLOW_ALLOWED_REPOSITORY_ROOTS: value.allowed,
    FORGEFLOW_WORKSPACE_HOST_ROOT: value.managed,
    FORGEFLOW_WORKSPACE_EXECUTION_ROOT: '/workspace',
    FORGEFLOW_AUTOMATION_PROJECTS: 'rollback-project',
    FORGEFLOW_WORKSPACE_UID: String(process.getuid?.() ?? 0),
    FORGEFLOW_WORKSPACE_GID: String(process.getgid?.() ?? 0),
  };
  const selectorFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/model/info')) {
      return new Response(
        JSON.stringify({
          data: [
            {
              model_name: 'route-rollback-deepseek-v4-flash',
              litellm_params: { litellm_credential_name: 'rollback-free' },
              model_info: {
                id: 'deployment-rollback-deepseek',
                blocked: false,
                metadata: {
                  automatic_core: true,
                  resource_id: 'rollback-free',
                  resource_sequence: 77,
                  model_family: 'deepseek-v4-flash',
                  route_model: 'route-rollback-deepseek-v4-flash',
                  protocol: 'openai-chat-completions',
                  commercial_type: 'FREE',
                  supply_origin: 'COMMUNITY_RELAY',
                  resource_lifecycle: 'RECURRING',
                },
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected selector rollback fetch: ${url}`);
  }) as typeof fetch;

  try {
    const selectorRuntime = await buildControlPlane({
      dbFile,
      environment: 'test',
      logger: false,
      fetchImpl: selectorFetch,
      env: {
        ...commonEnv,
        FORGEFLOW_RESOURCE_SELECTOR_ENABLED: 'true',
        FORGEFLOW_BUSINESS_RESOURCE_ENABLED: 'false',
        FORGEFLOW_LITELLM_ADMIN_BASE_URL: 'http://litellm.test',
        FORGEFLOW_LITELLM_ADMIN_ENV_FILE: adminEnv,
      },
    });
    let planId = '';
    let executionId = '';
    try {
      const created = await selectorRuntime.app.inject({
        method: 'POST',
        url: '/api/v1/plans',
        headers: { 'idempotency-key': 'selector-rollback-plan' },
        payload: {
          projectKey: 'rollback-project',
          objective: 'prove selector rollback durability',
          repositoryPath: value.repository,
          baseRevision: value.revision,
          workItems: [
            {
              itemKey: 'first',
              title: 'First',
              objective: 'Create one immutable selector decision',
              dependencies: [],
              acceptanceCriteria: ['persist resource provenance'],
            },
          ],
        },
      });
      assert.equal(created.statusCode, 201);
      planId = created.json().plan.planId as string;
      const run = await selectorRuntime.app.inject({
        method: 'POST',
        url: `/api/v1/plans/${planId}/run`,
      });
      assert.equal(run.statusCode, 200);
      assert.equal(run.json().code, 'IMPLEMENTATION_QUEUED');
      const selected = await selectorRuntime.app.inject({
        method: 'GET',
        url: `/api/v1/plans/${planId}`,
      });
      executionId = selected.json().executions[0].identity.executionId as string;
      assert.equal(selected.json().executions[0].resourceSelection.resourceId, 'rollback-free');
      assert.equal(
        selected.json().executions[0].resourceSelection.routeModel,
        'route-rollback-deepseek-v4-flash',
      );
    } finally {
      await selectorRuntime.app.close();
    }

    const rollbackRuntime = await buildControlPlane({
      dbFile,
      environment: 'test',
      logger: false,
      fetchImpl: (async (input: string | URL | Request) => {
        throw new Error(`rollback startup must not require selector discovery: ${String(input)}`);
      }) as typeof fetch,
      env: {
        ...commonEnv,
        FORGEFLOW_RESOURCE_SELECTOR_ENABLED: 'false',
        FORGEFLOW_IMPLEMENTATION_ROUTES: 'gpt-5.6-luna',
        FORGEFLOW_REVIEW_ROUTES: 'gpt-5.6-sol',
      },
    });
    try {
      const health = await rollbackRuntime.app.inject({ method: 'GET', url: '/api/health' });
      assert.equal(health.json().executionRuntime.routingAuthority, 'LEGACY_ROUTE_LIST');
      assert.deepEqual(health.json().executionRuntime.compatibilityImplementationRoutes, [
        'gpt-5.6-luna',
      ]);
      assert.deepEqual(health.json().executionRuntime.compatibilityReviewRoutes, ['gpt-5.6-sol']);

      const restored = await rollbackRuntime.app.inject({
        method: 'GET',
        url: `/api/v1/plans/${planId}`,
      });
      assert.equal(restored.statusCode, 200);
      assert.equal(restored.json().plan.planId, planId);
      const execution = restored
        .json()
        .executions.find((item: any) => item.identity.executionId === executionId);
      assert.ok(execution);
      assert.equal(execution.resourceSelection.resourceId, 'rollback-free');
      assert.equal(execution.resourceSelection.modelFamily, 'deepseek-v4-flash');
      assert.equal(execution.resourceSelection.agentBackend, 'dsh-acp');
      assert.equal(execution.resourceSelection.routeModel, 'route-rollback-deepseek-v4-flash');
      assert.equal(
        rollbackRuntime.repositories.resourceSelections.require(executionId).resourceId,
        'rollback-free',
      );
    } finally {
      await rollbackRuntime.app.close();
    }
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('runtime admission is demand-driven, single-flights probes, and uses execution-shaped Harness workspaces', async () => {
  const value = fixture();
  const adminEnv = path.join(value.root, 'litellm.env');
  fs.writeFileSync(adminEnv, 'LITELLM_MASTER_KEY=test-master-key\n');
  let releaseProbe!: () => void;
  const probeBlocked = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  let providerRequests = 0;
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/model/info')) {
      return new Response(
        JSON.stringify({
          data: [
            {
              model_name: 'route-free-deepseek-v4-flash',
              litellm_params: { litellm_credential_name: 'free-provider' },
              model_info: {
                id: 'deployment-free-deepseek',
                blocked: false,
                metadata: {
                  automatic_core: true,
                  resource_id: 'free-provider',
                  resource_sequence: 101,
                  model_family: 'deepseek-v4-flash',
                  route_model: 'route-free-deepseek-v4-flash',
                  protocol: 'openai-chat-completions',
                  commercial_type: 'FREE',
                  supply_origin: 'COMMUNITY_RELAY',
                  resource_lifecycle: 'RECURRING',
                },
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    providerRequests += 1;
    if (url.endsWith('/api/conversations') && init.method === 'POST') {
      const payload = JSON.parse(String(init.body));
      const workingDir = String(payload.workspace?.working_dir ?? '');
      assert.match(
        workingDir,
        /^\/workspace\/forgeflow\/executions\/runtime-admission-[a-f0-9]{20}\/repo$/,
      );
      const probeId = workingDir.split('/').at(-2)!;
      const manifestPath = path.join(
        value.managed,
        'forgeflow',
        'executions',
        probeId,
        'repo',
        '.agent-harness.json',
      );
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert.equal(manifest.id, 'forgeflow-runtime-admission');
      await probeBlocked;
      throw new Error('intentional blocked runtime probe');
    }
    throw new Error('unexpected provider request: ' + url);
  }) as typeof fetch;

  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    environment: 'test',
    logger: false,
    fetchImpl: fakeFetch,
    env: {
      NODE_ENV: 'test',
      FORGEFLOW_EXECUTION_RUNTIME_ENABLED: 'true',
      FORGEFLOW_AUTOMATION_RUNTIME_ENABLED: 'false',
      FORGEFLOW_RESOURCE_SELECTOR_ENABLED: 'true',
      FORGEFLOW_RUNTIME_ADMISSION_ENABLED: 'true',
      FORGEFLOW_BUSINESS_RESOURCE_ENABLED: 'false',
      FORGEFLOW_OPENHANDS_URL: 'http://openhands.test',
      FORGEFLOW_OPENHANDS_TOKEN: 'test-session-key',
      FORGEFLOW_LITELLM_API_KEY: 'test-litellm-key',
      FORGEFLOW_LITELLM_BASE_URL: 'http://litellm.test/v1',
      FORGEFLOW_LITELLM_ADMIN_BASE_URL: 'http://litellm.test',
      FORGEFLOW_LITELLM_ADMIN_ENV_FILE: adminEnv,
      FORGEFLOW_ALLOWED_REPOSITORY_ROOTS: value.allowed,
      FORGEFLOW_WORKSPACE_HOST_ROOT: value.managed,
      FORGEFLOW_WORKSPACE_EXECUTION_ROOT: '/workspace',
      FORGEFLOW_AUTOMATION_PROJECTS: 'app-runtime-project',
      FORGEFLOW_WORKSPACE_UID: String(process.getuid?.() ?? 0),
      FORGEFLOW_WORKSPACE_GID: String(process.getgid?.() ?? 0),
      FORGEFLOW_RESOURCE_REFRESH_MS: '3600000',
    },
  });

  const health = await runtime.app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().executionRuntime.runtimeAdmission.enabled, true);
  assert.equal(health.json().executionRuntime.runtimeAdmission.demandDriven, true);
  assert.equal(health.json().executionRuntime.runtimeAdmission.hasDemand, false);
  assert.equal(health.json().executionRuntime.runtimeAdmission.checked, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(providerRequests, 0);
  await runtime.automation!.reconcileRuntimeAdmission();
  assert.equal(providerRequests, 0);

  const created = await runtime.app.inject({
    method: 'POST',
    url: '/api/v1/plans',
    headers: { 'idempotency-key': 'runtime-admission-demand-plan' },
    payload: {
      projectKey: 'app-runtime-project',
      objective: 'create ACP runtime admission demand',
      repositoryPath: value.repository,
      baseRevision: value.revision,
      workItems: [
        {
          itemKey: 'probe',
          title: 'Probe admission',
          objective: 'exercise demand-driven admission',
          dependencies: [],
          acceptanceCriteria: ['probe only when demanded'],
        },
      ],
    },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(runtime.automation!.runtimeAdmissionHasDemand(), true);

  const first = runtime.automation!.reconcileRuntimeAdmission();
  const second = runtime.automation!.reconcileRuntimeAdmission();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(providerRequests, 1);
  releaseProbe();
  await Promise.all([first, second]);
  assert.equal(providerRequests, 1);
  assert.equal(runtime.automation!.runtimeAdmission.summary().checked, 1);
  assert.equal(runtime.automation!.runtimeAdmission.summary().unready, 1);
  runtime.repositories.plans.updateStatus(created.json().plan.planId, 'CANCELLED');
  assert.equal(runtime.automation!.runtimeAdmissionHasDemand(), false);
  await runtime.automation!.reconcileRuntimeAdmission();
  assert.equal(providerRequests, 1);
  await runtime.app.close();
});

test('ACP runtime admission TTL survives restart without duplicate provider probes and stays read-only when disabled', async () => {
  const value = fixture();
  const dbFile = path.join(value.root, 'runtime-admission-restart.sqlite');
  const adminEnv = path.join(value.root, 'litellm-runtime-admission-restart.env');
  fs.writeFileSync(adminEnv, 'LITELLM_MASTER_KEY=test-master-key\n');
  let providerRequests = 0;
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/model/info')) {
      return new Response(
        JSON.stringify({
          data: [
            {
              model_name: 'route-durable-runtime-deepseek',
              litellm_params: { litellm_credential_name: 'durable-runtime-provider' },
              model_info: {
                id: 'deployment-durable-runtime-deepseek',
                blocked: false,
                metadata: {
                  automatic_core: true,
                  resource_id: 'durable-runtime-provider',
                  resource_sequence: 451,
                  model_family: 'deepseek-v4-flash',
                  route_model: 'route-durable-runtime-deepseek',
                  protocol: 'openai-chat-completions',
                  commercial_type: 'FREE',
                  supply_origin: 'COMMUNITY_RELAY',
                  resource_lifecycle: 'RECURRING',
                },
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.endsWith('/api/conversations') && init.method === 'POST') {
      providerRequests += 1;
      throw new Error('private runtime admission diagnostic');
    }
    throw new Error('unexpected runtime-admission restart fetch: ' + url);
  }) as typeof fetch;
  const env = {
    NODE_ENV: 'test',
    FORGEFLOW_EXECUTION_RUNTIME_ENABLED: 'true',
    FORGEFLOW_AUTOMATION_RUNTIME_ENABLED: 'false',
    FORGEFLOW_RESOURCE_SELECTOR_ENABLED: 'true',
    FORGEFLOW_RUNTIME_ADMISSION_ENABLED: 'true',
    FORGEFLOW_RUNTIME_ADMISSION_TTL_MS: '300000',
    FORGEFLOW_RUNTIME_ADMISSION_TRANSIENT_FAILURE_TTL_MS: '300000',
    FORGEFLOW_BUSINESS_RESOURCE_ENABLED: 'false',
    FORGEFLOW_OPENHANDS_URL: 'http://openhands.test',
    FORGEFLOW_OPENHANDS_TOKEN: 'test-session-key',
    FORGEFLOW_LITELLM_API_KEY: 'test-litellm-key',
    FORGEFLOW_LITELLM_BASE_URL: 'http://litellm.test/v1',
    FORGEFLOW_LITELLM_ADMIN_BASE_URL: 'http://litellm.test',
    FORGEFLOW_LITELLM_ADMIN_ENV_FILE: adminEnv,
    FORGEFLOW_ALLOWED_REPOSITORY_ROOTS: value.allowed,
    FORGEFLOW_WORKSPACE_HOST_ROOT: value.managed,
    FORGEFLOW_WORKSPACE_EXECUTION_ROOT: '/workspace',
    FORGEFLOW_AUTOMATION_PROJECTS: 'durable-runtime-project',
    FORGEFLOW_WORKSPACE_UID: String(process.getuid?.() ?? 0),
    FORGEFLOW_WORKSPACE_GID: String(process.getgid?.() ?? 0),
    FORGEFLOW_RESOURCE_REFRESH_MS: '3600000',
  };

  const first = await buildControlPlane({
    dbFile,
    environment: 'test',
    logger: false,
    fetchImpl: fakeFetch,
    env,
  });
  let errorCode = '';
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(providerRequests, 0);
    const created = await first.app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: { 'idempotency-key': 'durable-runtime-demand-plan' },
      payload: {
        projectKey: 'durable-runtime-project',
        objective: 'create durable ACP runtime admission demand',
        repositoryPath: value.repository,
        baseRevision: value.revision,
        workItems: [
          {
            itemKey: 'probe',
            title: 'Probe durable admission',
            objective: 'exercise durable ACP admission',
            dependencies: [],
            acceptanceCriteria: ['probe once inside TTL'],
          },
        ],
      },
    });
    assert.equal(created.statusCode, 201);
    await first.automation!.reconcileRuntimeAdmission();
    assert.equal(providerRequests, 1);
    const durable = first.repositories.runtimeAdmissions.list();
    assert.equal(durable.length, 1);
    assert.equal(durable[0]?.ready, false);
    errorCode = durable[0]?.errorCode ?? '';
    assert.ok(errorCode);
  } finally {
    await first.app.close();
  }

  const second = await buildControlPlane({
    dbFile,
    environment: 'test',
    logger: false,
    fetchImpl: fakeFetch,
    env,
  });
  try {
    assert.deepEqual(second.automation!.runtimeAdmission.summary(), {
      checked: 1,
      ready: 0,
      unready: 1,
      implementationReady: 0,
      reviewReady: 0,
    });
    await second.automation!.reconcileRuntimeAdmission();
    assert.equal(providerRequests, 1);
    const endpoint = await second.app.inject({ method: 'GET', url: '/api/v1/runtime-admission' });
    assert.equal(endpoint.statusCode, 200);
    assert.equal(endpoint.json().items[0].errorCode, errorCode);
    assert.equal(endpoint.json().durableCache.items[0].errorCode, errorCode);
    assert.deepEqual(endpoint.json().durableCache.summary, { checked: 1, ready: 0, unready: 1 });
    assert.equal(JSON.stringify(endpoint.json()).includes('private runtime admission diagnostic'), false);
    assert.equal(JSON.stringify(endpoint.json()).includes('test-litellm-key'), false);
  } finally {
    await second.app.close();
  }

  const callsBeforeDisabledRead = providerRequests;
  const disabled = await buildControlPlane({
    dbFile,
    environment: 'test',
    logger: false,
    fetchImpl: fakeFetch,
    env: { ...env, FORGEFLOW_RUNTIME_ADMISSION_ENABLED: 'false' },
  });
  try {
    const endpoint = await disabled.app.inject({ method: 'GET', url: '/api/v1/runtime-admission' });
    assert.equal(endpoint.statusCode, 200);
    assert.equal(endpoint.json().enabled, false);
    assert.deepEqual(endpoint.json().summary, {
      checked: 0,
      ready: 0,
      unready: 0,
      implementationReady: 0,
      reviewReady: 0,
    });
    assert.deepEqual(endpoint.json().items, []);
    assert.deepEqual(endpoint.json().durableCache.summary, { checked: 1, ready: 0, unready: 1 });
    assert.equal(endpoint.json().durableCache.items[0].resourceId, 'durable-runtime-provider');
    assert.equal(endpoint.json().durableCache.items[0].errorCode, errorCode);
    assert.equal('admissionKey' in endpoint.json().durableCache.items[0], false);
    assert.equal(providerRequests, callsBeforeDisabledRead);
  } finally {
    await disabled.app.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('single-active-plan API queues later root tasks without supervisor or execution activity and hands off atomically', async () => {
  const value = fixture();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    environment: 'test',
    logger: false,
    env: {
      NODE_ENV: 'test',
      FORGEFLOW_EXECUTION_RUNTIME_ENABLED: 'false',
      FORGEFLOW_SINGLE_ACTIVE_PLAN_ENABLED: 'true',
      FORGEFLOW_LITERAL_WORKTREES_ENABLED: 'false',
    },
  });

  const createRoot = async (key: string, objective: string) => {
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: { 'idempotency-key': key },
      payload: {
        projectKey: 'project-gamma',
        objective,
        repositoryPath: value.repository,
        baseRevision: value.revision,
        workItems: [
          {
            itemKey: 'objective',
            title: objective,
            objective,
            dependencies: [],
            acceptanceCriteria: ['complete safely'],
          },
        ],
      },
    });
    assert.equal(response.statusCode, 201);
    return response.json();
  };

  const first = await createRoot('single-active-a', 'active root task');
  const second = await createRoot('single-active-b', 'queued root task');
  const firstPlanId = first.plan.planId as string;
  const secondPlanId = second.plan.planId as string;

  assert.equal(first.plan.status, 'READY');
  assert.equal(first.scheduling.status, 'ACTIVE');
  assert.equal(first.supervisor.status, 'ACTIVE');
  assert.equal(second.plan.status, 'QUEUED');
  assert.equal(second.scheduling.status, 'QUEUED');
  assert.equal(second.supervisor, null);
  assert.equal(runtime.repositories.executions.listByPlan(secondPlanId).length, 0);
  assert.equal(runtime.repositories.supervisors.getByPlanId(secondPlanId), undefined);

  const health = await runtime.app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().planScheduling.singleActivePlanEnabled, true);
  assert.equal(health.json().planScheduling.literalWorktreesEnabled, false);
  assert.equal(health.json().planScheduling.leases[0].activeRootPlanId, firstPlanId);
  assert.equal(health.json().planScheduling.leases[0].queuedPlans, 1);

  const queue = await runtime.app.inject({
    method: 'GET',
    url: '/api/v1/projects/project-gamma/plan-queue',
  });
  assert.equal(queue.statusCode, 200);
  assert.equal(queue.json().lease.activeRootPlanId, firstPlanId);
  assert.deepEqual(
    queue.json().items.map((item: { planId: string }) => item.planId),
    [secondPlanId],
  );

  runtime.repositories.plans.updateStatus(firstPlanId, 'RUNNING');
  runtime.repositories.plans.updateStatus(firstPlanId, 'SUCCEEDED');
  const handoff = await runtime.projectPlanQueue!.reconcile();
  assert.equal(handoff[0]?.releasedPlanId, firstPlanId);
  assert.equal(handoff[0]?.activatedPlanId, secondPlanId);
  assert.equal(runtime.repositories.plans.getPlan(secondPlanId).status, 'READY');
  assert.equal(runtime.repositories.supervisors.getByPlanId(firstPlanId)?.status, 'CANCELLED');
  assert.equal(runtime.repositories.supervisors.getByPlanId(secondPlanId)?.status, 'ACTIVE');
  assert.equal(runtime.repositories.executions.listByPlan(secondPlanId).length, 0);

  const after = await runtime.app.inject({
    method: 'GET',
    url: '/api/v1/projects/project-gamma/plan-queue',
  });
  assert.equal(after.json().lease.activeRootPlanId, secondPlanId);
  assert.equal(after.json().items.length, 0);
  await runtime.app.close();
});

test('Improvement API discovers repeated failures and adopts them only as an ordinary queued Plan', async () => {
  const value = fixture();
  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    environment: 'test',
    logger: false,
    env: {
      NODE_ENV: 'test',
      FORGEFLOW_EXECUTION_RUNTIME_ENABLED: 'false',
      FORGEFLOW_SINGLE_ACTIVE_PLAN_ENABLED: 'true',
      FORGEFLOW_IMPROVEMENT_DISCOVERY_ENABLED: 'true',
      FORGEFLOW_IMPROVEMENT_ADOPTION_ENABLED: 'true',
      FORGEFLOW_IMPROVEMENT_PROJECTS: 'improvement-api',
      FORGEFLOW_IMPROVEMENT_SELF_CHANGE_ENABLED: 'false',
      FORGEFLOW_IMPROVEMENT_CYCLE_MS: '300000',
    },
  });
  const health = await runtime.app.inject({ method: 'GET', url: '/api/health' });
  assert.deepEqual(health.json().improvementRuntime, {
    discoveryEnabled: true,
    adoptionEnabled: true,
    autoAdoptLowRisk: false,
    selfChangeEnabled: false,
    allowedProjectKeys: ['improvement-api'],
  });

  for (let index = 1; index <= 3; index += 1) {
    const plan = runtime.repositories.plans.createPlan({
      idempotencyKey: 'improvement-history-plan-' + index,
      projectKey: 'improvement-api',
      objective: 'historical failure',
      repositoryPath: value.repository,
      baseRevision: value.revision,
    }).value!;
    const executionId = 'improvement-history-execution-' + index;
    runtime.repositories.executions.create({
      idempotencyKey: executionId,
      identity: {
        executionId,
        planId: plan.planId,
        phase: 'IMPLEMENT',
        attempt: 1,
        route: 'historical-route',
        sourceRevision: value.revision,
      },
      objective: 'historical failure',
    });
    runtime.repositories.executions.updateStatus(executionId, 'RUNNING');
    runtime.repositories.executions.recordResult(executionId, {
      status: 'FAILED',
      errorCode: 'TEST_API_REGRESSION',
      retryable: false,
    });
  }

  const discovery = await runtime.app.inject({
    method: 'POST',
    url: '/api/v1/improvements/discover',
    payload: {
      programId: 'improvement-api-program',
      projectKey: 'improvement-api',
      repositoryPath: value.repository,
      autonomousScope: 'CONSERVATIVE',
      autoMerge: false,
      failureThreshold: 3,
      recentExecutionLimit: 100,
      candidateRisk: 'LOW',
    },
  });
  assert.equal(discovery.statusCode, 200);
  assert.equal(discovery.json().count, 1);
  assert.equal(discovery.json().items[0].errorCode, 'TEST_API_REGRESSION');
  const candidateId = discovery.json().items[0].candidate.candidateId as string;

  const disabled = await runtime.app.inject({
    method: 'POST',
    url: '/api/v1/maintenance/programs/improvement-api-program/state',
    payload: { enabled: false },
  });
  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.json().program.enabled, false);
  const blockedAdoption = await runtime.app.inject({
    method: 'POST',
    url: '/api/v1/improvements/' + candidateId + '/adopt',
    payload: {},
  });
  assert.equal(blockedAdoption.statusCode, 503);
  assert.equal(blockedAdoption.json().error, 'MAINTENANCE_PROGRAM_DISABLED');
  const enabled = await runtime.app.inject({
    method: 'POST',
    url: '/api/v1/maintenance/programs/improvement-api-program/state',
    payload: { enabled: true },
  });
  assert.equal(enabled.statusCode, 200);
  assert.equal(enabled.json().program.enabled, true);

  const adopted = await runtime.app.inject({
    method: 'POST',
    url: '/api/v1/improvements/' + candidateId + '/adopt',
    payload: {},
  });
  assert.equal(adopted.statusCode, 200);
  assert.equal(adopted.json().candidate.status, 'ADOPTED');
  assert.equal(adopted.json().plan.projectKey, 'improvement-api');
  assert.equal(adopted.json().plan.status, 'READY');
  assert.equal(adopted.json().scheduling.status, 'ACTIVE');
  const improvementPlanId = adopted.json().plan.planId as string;
  assert.equal(runtime.repositories.executions.listByPlan(improvementPlanId).length, 0);
  assert.ok(runtime.repositories.supervisors.getByPlanId(improvementPlanId));

  const detail = await runtime.app.inject({
    method: 'GET',
    url: '/api/v1/improvements/' + candidateId,
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().candidate.planId, improvementPlanId);
  assert.equal(detail.json().plan.workItems.length, 1);

  runtime.repositories.plans.updateStatus(improvementPlanId, 'RUNNING');
  runtime.repositories.plans.updateStatus(improvementPlanId, 'SUCCEEDED');
  const reconciled = await runtime.app.inject({
    method: 'POST',
    url: '/api/v1/improvements/' + candidateId + '/reconcile',
  });
  assert.equal(reconciled.statusCode, 200);
  assert.equal(reconciled.json().candidate.status, 'COMPLETED');
  await runtime.app.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('literal worktree canary is project-scoped and keeps legacy projects on isolated clones', async () => {
  const value = fixture();
  const harnessctl = path.join(value.root, 'fake-harnessctl.py');
  fs.writeFileSync(
    harnessctl,
    [
      'import pathlib, sys',
      'project = pathlib.Path(sys.argv[2])',
      "manifest = project / '.agent-harness.json'",
      'sys.exit(0 if manifest.is_file() else 3)',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(value.repository, '.agent-harness.json'),
    JSON.stringify({
      version: 1,
      id: 'literal-project',
      sharedMcpProfile: 'common',
      packs: [],
      capabilities: [],
    }) + '\n',
  );
  git(value.repository, ['add', '.agent-harness.json']);
  git(value.repository, ['commit', '-m', 'chore: register literal harness']);
  const literalRevision = git(value.repository, ['rev-parse', 'HEAD']);
  const legacyRepository = path.join(value.allowed, 'legacy-project');
  fs.mkdirSync(legacyRepository, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', legacyRepository]);
  git(legacyRepository, ['config', 'user.name', 'ForgeFlow Test']);
  git(legacyRepository, ['config', 'user.email', 'forgeflow-test@local']);
  fs.writeFileSync(path.join(legacyRepository, 'README.md'), '# Legacy\n');
  git(legacyRepository, ['add', 'README.md']);
  git(legacyRepository, ['commit', '-m', 'chore: initialize legacy']);
  const legacyRevision = git(legacyRepository, ['rev-parse', 'HEAD']);

  const runtime = await buildControlPlane({
    dbFile: ':memory:',
    environment: 'test',
    logger: false,
    fetchImpl: (async () => {
      throw new Error('provider should not be called');
    }) as typeof fetch,
    env: {
      NODE_ENV: 'test',
      FORGEFLOW_EXECUTION_RUNTIME_ENABLED: 'true',
      FORGEFLOW_AUTOMATION_RUNTIME_ENABLED: 'false',
      FORGEFLOW_SINGLE_ACTIVE_PLAN_ENABLED: 'true',
      FORGEFLOW_LITERAL_WORKTREES_ENABLED: 'true',
      FORGEFLOW_LITERAL_WORKTREE_PROJECTS: 'literal-project',
      FORGEFLOW_AGENT_HARNESS_CTL: harnessctl,
      FORGEFLOW_MAX_PARALLEL_WORK_ITEMS: '2',
      FORGEFLOW_OPENHANDS_URL: 'http://openhands.test',
      FORGEFLOW_OPENHANDS_TOKEN: 'test-session-key',
      FORGEFLOW_LITELLM_API_KEY: 'test-litellm-key',
      FORGEFLOW_LITELLM_BASE_URL: 'http://litellm.test/v1',
      FORGEFLOW_ALLOWED_REPOSITORY_ROOTS: value.allowed,
      FORGEFLOW_WORKSPACE_HOST_ROOT: value.managed,
      FORGEFLOW_WORKSPACE_EXECUTION_ROOT: '/workspace',
      FORGEFLOW_AUTOMATION_PROJECTS: 'literal-project,legacy-project',
      FORGEFLOW_WORKSPACE_UID: String(process.getuid?.() ?? 1000),
      FORGEFLOW_WORKSPACE_GID: String(process.getgid?.() ?? 1000),
    },
  });

  const create = async (
    key: string,
    projectKey: string,
    repositoryPath: string,
    baseRevision: string,
  ) => {
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: { 'idempotency-key': key },
      payload: {
        projectKey,
        objective: 'canary ' + projectKey,
        repositoryPath,
        baseRevision,
        workItems: [
          {
            itemKey: 'first',
            title: 'First',
            objective: 'implement',
            dependencies: [],
            acceptanceCriteria: ['pass'],
            parallelSafe: true,
            writeScopes: ['src/' + projectKey],
          },
        ],
      },
    });
    assert.equal(response.statusCode, 201);
    return response.json();
  };

  const literal = await create(
    'literal-plan',
    'literal-project',
    value.repository,
    literalRevision,
  );
  const legacy = await create('legacy-plan', 'legacy-project', legacyRepository, legacyRevision);
  assert.deepEqual(runtime.automation?.literalWorktreeProjectKeys, ['literal-project']);
  assert.equal(runtime.automation?.policy.resolve('literal-project')?.maxParallelWorkItems, 2);
  assert.equal(runtime.automation?.policy.resolve('legacy-project')?.maxParallelWorkItems, 1);

  const provision = async (body: any, executionId: string, sourceRevision: string) => {
    const planId = body.plan.planId as string;
    const workItemId = body.graph.items[0].workItemId as string;
    runtime.repositories.executions.create({
      executionId,
      idempotencyKey: executionId,
      identity: {
        executionId,
        planId,
        workItemId,
        phase: 'IMPLEMENT',
        attempt: 1,
        route: 'gpt-5.6-luna',
        sourceRevision,
      },
      objective: 'implement',
    });
    return await runtime.automation!.workspace.provision({
      executionId,
      planId,
      projectKey: body.plan.projectKey,
      workItemId,
      repositoryPath: body.plan.repositoryPath,
      sourceRevision,
      phase: 'IMPLEMENT',
    });
  };
  const literalWorkspace = await provision(literal, 'exec-literal-canary', literalRevision);
  const legacyWorkspace = await provision(legacy, 'exec-legacy-canary', legacyRevision);
  assert.match(literalWorkspace.executionPath, /^\/workspace\/forgeflow\/plans\/literal-project\//);
  assert.equal(legacyWorkspace.executionPath, '/workspace/forgeflow/executions/exec-legacy-canary/repo');
  assert.equal(git(value.repository, ['rev-parse', 'HEAD']), literalRevision);
  assert.equal(git(legacyRepository, ['rev-parse', 'HEAD']), legacyRevision);

  await runtime.app.close();
  fs.rmSync(value.root, { recursive: true, force: true });
});

test('active Plan operator cancel is public, idempotent, and hands off the project lease', async () => {
  const value = fixture();
  const runtime = await buildControlPlane({
    dbFile: path.join(value.root, 'operator-cancel.sqlite'),
    environment: 'test',
    logger: false,
    env: {
      NODE_ENV: 'test',
      FORGEFLOW_EXECUTION_RUNTIME_ENABLED: 'false',
      FORGEFLOW_SINGLE_ACTIVE_PLAN_ENABLED: 'true',
    },
  });
  const create = async (key: string, objective: string) => {
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: { 'idempotency-key': key },
      payload: {
        projectKey: 'operator-cancel-project',
        objective,
        repositoryPath: value.repository,
        baseRevision: value.revision,
        workItems: [
          {
            itemKey: 'only',
            title: 'Only item',
            objective,
            dependencies: [],
            acceptanceCriteria: ['remain bounded'],
          },
        ],
      },
    });
    assert.equal(response.statusCode, 201);
    return response.json().plan.planId as string;
  };

  try {
    const activePlanId = await create('operator-cancel-active', 'active cancellation target');
    const queuedPlanId = await create('operator-cancel-queued', 'next queued target');
    const before = await runtime.app.inject({
      method: 'GET',
      url: '/api/v1/projects/operator-cancel-project/plan-queue',
    });
    assert.equal(before.statusCode, 200);
    assert.equal(before.json().lease.activeRootPlanId, activePlanId);
    assert.equal(before.json().items[0].planId, queuedPlanId);

    const cancelled = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/plans/' + encodeURIComponent(activePlanId) + '/cancel',
      headers: { 'idempotency-key': 'operator-cancel-request-1' },
      payload: { reason: 'smoke validation finished' },
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().code, 'PROJECT_PLAN_CANCELLED_HANDOFF');
    assert.equal(cancelled.json().plan.status, 'CANCELLED');
    assert.equal(cancelled.json().activatedPlanId, queuedPlanId);
    assert.equal(cancelled.json().lease.activeRootPlanId, queuedPlanId);
    const activeView = await runtime.app.inject({
      method: 'GET',
      url: '/api/v1/plans/' + encodeURIComponent(activePlanId),
    });
    assert.equal(activeView.json().workItems[0].status, 'CANCELLED');
    assert.equal(activeView.json().supervisor.status, 'CANCELLED');
    const queuedView = await runtime.app.inject({
      method: 'GET',
      url: '/api/v1/plans/' + encodeURIComponent(queuedPlanId),
    });
    assert.equal(queuedView.json().plan.status, 'READY');
    assert.equal(queuedView.json().supervisor.status, 'ACTIVE');

    const repeated = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/plans/' + encodeURIComponent(activePlanId) + '/cancel',
      headers: { 'idempotency-key': 'operator-cancel-request-1' },
      payload: { reason: 'smoke validation finished' },
    });
    assert.equal(repeated.statusCode, 200);
    assert.equal(repeated.json().code, 'PROJECT_PLAN_ALREADY_CANCELLED');
    assert.equal(repeated.json().lease.activeRootPlanId, queuedPlanId);
  } finally {
    await runtime.app.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('public Plan cancel supports child-first cancellation without releasing the root lease early', async () => {
  const value = fixture();
  const runtime = await buildControlPlane({
    dbFile: path.join(value.root, 'operator-child-cancel.sqlite'),
    environment: 'test',
    logger: false,
    env: {
      NODE_ENV: 'test',
      FORGEFLOW_EXECUTION_RUNTIME_ENABLED: 'false',
      FORGEFLOW_SINGLE_ACTIVE_PLAN_ENABLED: 'true',
    },
  });
  try {
    const rootResponse = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: { 'idempotency-key': 'operator-child-root' },
      payload: {
        projectKey: 'operator-child-project',
        objective: 'root cancellation fixture',
        repositoryPath: value.repository,
        baseRevision: value.revision,
        workItems: [
          {
            itemKey: 'root',
            title: 'Root item',
            objective: 'remain cancellable',
            dependencies: [],
            acceptanceCriteria: ['cancel safely'],
          },
        ],
      },
    });
    assert.equal(rootResponse.statusCode, 201);
    const rootPlanId = rootResponse.json().plan.planId as string;

    const childResponse = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/plans/' + encodeURIComponent(rootPlanId) + '/children',
      payload: {
        childPlanId: 'operator-child-plan',
        relation: 'FOLLOW_UP',
        objective: 'child cancellation fixture',
        workItems: [
          {
            itemKey: 'child',
            title: 'Child item',
            objective: 'cancel before the root',
            dependencies: [],
            acceptanceCriteria: ['preserve root lease'],
          },
        ],
      },
    });
    assert.equal(childResponse.statusCode, 201);
    const childPlanId = childResponse.json().plan.planId as string;

    const blockedRoot = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/plans/' + encodeURIComponent(rootPlanId) + '/cancel',
      headers: { 'idempotency-key': 'cancel-root-before-child' },
      payload: { reason: 'must cancel child first' },
    });
    assert.equal(blockedRoot.statusCode, 409);
    assert.equal(blockedRoot.json().error, 'PROJECT_PLAN_CANCEL_DESCENDANT_ACTIVE');

    const childCancelled = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/plans/' + encodeURIComponent(childPlanId) + '/cancel',
      headers: { 'idempotency-key': 'cancel-child-first' },
      payload: { reason: 'operator cancels child before root' },
    });
    assert.equal(childCancelled.statusCode, 200);
    assert.equal(childCancelled.json().code, 'CHILD_PLAN_CANCELLED');
    assert.equal(childCancelled.json().rootPlanId, rootPlanId);
    assert.equal(childCancelled.json().plan.status, 'CANCELLED');
    assert.equal(childCancelled.json().lease.activeRootPlanId, rootPlanId);
    const childView = await runtime.app.inject({
      method: 'GET',
      url: '/api/v1/plans/' + encodeURIComponent(childPlanId),
    });
    assert.equal(childView.json().supervisor.status, 'CANCELLED');
    assert.equal(childView.json().workItems[0].status, 'CANCELLED');

    const rootCancelled = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/plans/' + encodeURIComponent(rootPlanId) + '/cancel',
      headers: { 'idempotency-key': 'cancel-root-after-child' },
      payload: { reason: 'child is terminal, retire root' },
    });
    assert.equal(rootCancelled.statusCode, 200);
    assert.equal(rootCancelled.json().code, 'PROJECT_PLAN_CANCELLED');
    assert.equal(rootCancelled.json().plan.status, 'CANCELLED');
    assert.equal(rootCancelled.json().lease.activeRootPlanId, undefined);
  } finally {
    await runtime.app.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
