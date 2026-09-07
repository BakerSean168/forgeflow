#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const CONTROL_PLANE = (
  process.env.FORGEFLOW_AUTONOMOUS_SMOKE_CONTROL_PLANE ?? 'http://127.0.0.1:8420'
).replace(/\/$/, '');
const PROJECT_KEY = process.env.FORGEFLOW_AUTONOMOUS_SMOKE_PROJECT_KEY ?? 'forgeflow-smoke';
const REPOSITORY =
  process.env.FORGEFLOW_AUTONOMOUS_SMOKE_REPOSITORY ?? '/home/dev/projects/forgeflow-smoke';
const OPENHANDS_URL = (
  process.env.FORGEFLOW_OPENHANDS_URL ?? 'http://127.0.0.1:18420'
).replace(/\/$/, '');
const OPENHANDS_TOKEN = process.env.FORGEFLOW_OPENHANDS_TOKEN?.trim();
const OPENHANDS_CONTAINER = process.env.FORGEFLOW_OPENHANDS_CONTAINER ?? 'forgeflow-openhands';
const TIMEOUT_MS = integerEnv('FORGEFLOW_AUTONOMOUS_SMOKE_TIMEOUT_MS', 20 * 60_000, 60_000, 60 * 60_000);
const POLL_MS = integerEnv('FORGEFLOW_AUTONOMOUS_SMOKE_POLL_MS', 5_000, 1_000, 60_000);
const PARALLEL_START_MAX_DELTA_MS = integerEnv(
  'FORGEFLOW_AUTONOMOUS_SMOKE_PARALLEL_START_MAX_DELTA_MS',
  5_000,
  100,
  30_000,
);
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const stamp = `${Date.now()}-${process.pid}-${randomUUID().replaceAll('-', '').slice(0, 8)}`;
const safeStamp = stamp.replace(/[^A-Za-z0-9._-]/g, '-');
const fileA = `src/autonomous-smoke-${safeStamp}-a.js`;
const fileB = `src/autonomous-smoke-${safeStamp}-b.js`;
const valueA = `A-${safeStamp}`;
const valueB = `B-${safeStamp}`;
let planId;
let completed = false;
let canonicalHeadBefore;
let canonicalStatusBefore;
let baseRevision;
let lastProgressSignature = '';

function integerEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
}

function fail(code, details) {
  const error = new Error(code);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync(
    '/usr/bin/git',
    ['-c', `safe.directory=${REPOSITORY}`, '-C', REPOSITORY, ...args],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: '/nonexistent',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C.UTF-8',
      },
    },
  );
  if (result.status !== 0) {
    if (allowFailure) return '';
    fail('SMOKE_GIT_FAILED', {
      args,
      status: result.status,
      stderr: (result.stderr ?? '').trim().slice(0, 500),
    });
  }
  return (result.stdout ?? '').trim();
}

function gitSucceeds(args) {
  return spawnSync(
    '/usr/bin/git',
    ['-c', `safe.directory=${REPOSITORY}`, '-C', REPOSITORY, ...args],
    {
      stdio: 'ignore',
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: '/nonexistent',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C.UTF-8',
      },
    },
  ).status === 0;
}

async function api(path, init = {}) {
  const response = await fetch(CONTROL_PLANE + path, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    fail('SMOKE_CONTROL_PLANE_RESPONSE_INVALID', { path, status: response.status });
  }
  if (!response.ok)
    fail('SMOKE_CONTROL_PLANE_REQUEST_FAILED', {
      path,
      status: response.status,
      code: body?.error ?? body?.code ?? null,
    });
  return body;
}

async function openHandsConversationStatus(providerSessionId) {
  if (!OPENHANDS_TOKEN) fail('FORGEFLOW_OPENHANDS_TOKEN_REQUIRED');
  const response = await fetch(
    `${OPENHANDS_URL}/api/conversations/${encodeURIComponent(providerSessionId)}`,
    {
      headers: { 'X-Session-API-Key': OPENHANDS_TOKEN },
      signal: AbortSignal.timeout(10_000),
    },
  );
  await response.body?.cancel();
  return response.status;
}

function providerProcessesForPlan(currentPlanId) {
  const output = execFileSync(
    '/usr/bin/docker',
    [
      'exec',
      OPENHANDS_CONTAINER,
      'sh',
      '-lc',
      "ps -eo pid,ppid,etime,args | grep -E 'zcode|dsh|codex' | grep -v grep || true",
    ],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  );
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes(currentPlanId));
}

function planRefLines(currentPlanId) {
  return git([
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    `refs/heads/forgeflow/${currentPlanId}/`,
    `refs/forgeflow/${currentPlanId}/`,
    `refs/forgeflow/archive/${currentPlanId}/`,
  ])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function executionId(execution) {
  return execution?.identity?.executionId;
}

function executionWorkItemId(execution) {
  return execution?.identity?.workItemId;
}

function executionPhase(execution) {
  return execution?.identity?.phase;
}

function firstImplementationByItem(executions, workItemId) {
  return executions
    .filter(
      (execution) =>
        executionWorkItemId(execution) === workItemId && executionPhase(execution) === 'IMPLEMENT',
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
}

function acceptedImplementation(executions, item) {
  return executions.find(
    (execution) =>
      executionWorkItemId(execution) === item.workItemId &&
      ['IMPLEMENT', 'IMPLEMENT_FIX'].includes(executionPhase(execution)) &&
      execution.status === 'SUCCEEDED' &&
      execution.resultRevision === item.exactAcceptedRevision,
  );
}

async function cleanupProof(executionIdValue) {
  const detail = await api(`/api/v1/executions/${encodeURIComponent(executionIdValue)}`);
  return detail.evidence?.find(
    (entry) =>
      entry.kind === 'RECOVERY' &&
      (entry.name === 'provider-session-cleanup' ||
        entry.name === 'operator-provider-cancellation-cleanup'),
  );
}

async function bestEffortCancel(reason) {
  if (!planId) return;
  try {
    const queue = await api(`/api/v1/projects/${encodeURIComponent(PROJECT_KEY)}/plan-queue`);
    const view = await api(`/api/v1/plans/${encodeURIComponent(planId)}`);
    if (queue.lease?.activeRootPlanId !== planId && TERMINAL.has(view.plan?.status)) return;
    await api(`/api/v1/plans/${encodeURIComponent(planId)}/cancel`, {
      method: 'POST',
      headers: { 'idempotency-key': `autonomous-smoke-cleanup-${safeStamp}` },
      body: JSON.stringify({ reason }),
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        status: 'CLEANUP_WARNING',
        planId,
        code: error?.code ?? error?.message ?? 'SMOKE_CLEANUP_FAILED',
      }),
    );
  }
}

function progress(view, queue) {
  const signature = JSON.stringify({
    plan: view.plan?.status,
    revision: view.plan?.currentRevision,
    items: (view.workItems ?? []).map((item) => [item.itemKey, item.status, item.wave]),
    executions: (view.executions ?? []).map((execution) => [
      executionId(execution),
      executionPhase(execution),
      execution.status,
      execution.errorCode ?? null,
    ]),
    reviews: (view.reviews ?? []).map((review) => [review.reviewId, review.status, review.verdict]),
    worktrees: (view.worktrees ?? []).map((worktree) => [
      worktree.role,
      worktree.workItemId ?? null,
      worktree.state,
    ]),
    activeLease: queue.lease?.activeRootPlanId ?? null,
  });
  if (signature === lastProgressSignature) return;
  lastProgressSignature = signature;
  console.log(
    JSON.stringify({
      status: 'PROGRESS',
      planId,
      planStatus: view.plan?.status,
      currentRevision: view.plan?.currentRevision,
      workItems: (view.workItems ?? []).map((item) => ({
        itemKey: item.itemKey,
        status: item.status,
        wave: item.wave ?? null,
        acceptedRevision: item.exactAcceptedRevision ?? null,
      })),
      executions: (view.executions ?? []).map((execution) => ({
        executionId: executionId(execution),
        phase: executionPhase(execution),
        workItemId: executionWorkItemId(execution),
        attempt: execution.identity?.attempt,
        status: execution.status,
        errorCode: execution.errorCode ?? null,
      })),
      reviews: (view.reviews ?? []).map((review) => ({
        reviewId: review.reviewId,
        workItemId: review.workItemId,
        status: review.status,
        verdict: review.verdict ?? null,
      })),
      worktrees: (view.worktrees ?? []).map((worktree) => ({
        role: worktree.role,
        workItemId: worktree.workItemId ?? null,
        state: worktree.state,
      })),
      activeLease: queue.lease?.activeRootPlanId ?? null,
    }),
  );
}

async function main() {
  if (!OPENHANDS_TOKEN) fail('FORGEFLOW_OPENHANDS_TOKEN_REQUIRED');
  const health = await api('/api/health');
  if (health.status !== 'ok') fail('SMOKE_FORGEFLOW_UNHEALTHY');
  if (health.executionRuntime?.autonomousPolling !== true)
    fail('SMOKE_AUTONOMOUS_POLLING_REQUIRED');
  if (health.planScheduling?.literalWorktreesEnabled !== true)
    fail('SMOKE_LITERAL_WORKTREES_REQUIRED');
  const improvement = health.improvementRuntime ?? {};
  if (
    improvement.selfChangeEnabled ||
    improvement.selfPromotionEnabled ||
    improvement.selfAutoPromotionEnabled ||
    improvement.aiDiagnosisEnabled
  )
    fail('SMOKE_UNSAFE_IMPROVEMENT_MODE_ENABLED');

  const queueBefore = await api(`/api/v1/projects/${encodeURIComponent(PROJECT_KEY)}/plan-queue`);
  if (!queueBefore.lease) fail('SMOKE_PROJECT_LEASE_MISSING');
  if (queueBefore.lease.activeRootPlanId) fail('SMOKE_PROJECT_ALREADY_ACTIVE');
  if (queueBefore.items?.length) fail('SMOKE_PROJECT_QUEUE_NOT_EMPTY');
  if (queueBefore.lease.repositoryPath !== REPOSITORY) fail('SMOKE_REPOSITORY_MISMATCH');
  baseRevision = queueBefore.lease.committedRevision;
  if (!baseRevision || !gitSucceeds(['cat-file', '-e', `${baseRevision}^{commit}`]))
    fail('SMOKE_LOGICAL_BASE_UNAVAILABLE');

  canonicalHeadBefore = git(['rev-parse', '--verify', 'HEAD^{commit}']);
  canonicalStatusBefore = git(['status', '--porcelain=v1', '--untracked-files=all']);
  if (canonicalStatusBefore) fail('SMOKE_CANONICAL_REPOSITORY_DIRTY');

  const created = await api('/api/v1/plans', {
    method: 'POST',
    headers: { 'idempotency-key': `autonomous-lifecycle-smoke-${safeStamp}` },
    body: JSON.stringify({
      projectKey: PROJECT_KEY,
      objective:
        'Production real-provider acceptance: run two independent parallel implementations, exact-SHA independent reviews, serial integration, terminal provider cleanup, worktree retirement, and project lease release.',
      repositoryPath: REPOSITORY,
      baseRevision,
      workItems: [
        {
          itemKey: 'parallel-a',
          title: `Autonomous lifecycle smoke A ${safeStamp}`,
          objective: `Create ${fileA} exporting const autonomousSmokeA = '${valueA}'. Do not modify any other tracked file. Run npm test and a direct Node import check before reporting completion.`,
          dependencies: [],
          acceptanceCriteria: [
            `${fileA} exists and exports const autonomousSmokeA with value ${valueA}`,
            `No tracked file outside ${fileA} is changed`,
            'npm test passes',
            'A direct Node import check passes',
          ],
          parallelSafe: true,
          writeScopes: [fileA],
          conflictKeys: [],
        },
        {
          itemKey: 'parallel-b',
          title: `Autonomous lifecycle smoke B ${safeStamp}`,
          objective: `Create ${fileB} exporting const autonomousSmokeB = '${valueB}'. Do not modify any other tracked file. Run npm test and a direct Node import check before reporting completion.`,
          dependencies: [],
          acceptanceCriteria: [
            `${fileB} exists and exports const autonomousSmokeB with value ${valueB}`,
            `No tracked file outside ${fileB} is changed`,
            'npm test passes',
            'A direct Node import check passes',
          ],
          parallelSafe: true,
          writeScopes: [fileB],
          conflictKeys: [],
        },
      ],
    }),
  });
  planId = created.plan?.planId;
  if (!planId) fail('SMOKE_PLAN_ID_MISSING');

  const deadline = Date.now() + TIMEOUT_MS;
  let finalView;
  let finalQueue;
  while (Date.now() < deadline) {
    const view = await api(`/api/v1/plans/${encodeURIComponent(planId)}`);
    const queue = await api(`/api/v1/projects/${encodeURIComponent(PROJECT_KEY)}/plan-queue`);
    progress(view, queue);
    if (view.plan?.status === 'FAILED' || view.plan?.status === 'CANCELLED')
      fail('SMOKE_PLAN_TERMINAL_FAILURE', { status: view.plan.status });
    const worktrees = view.worktrees ?? [];
    const providerSessions = (view.sessions ?? []).filter((session) => session.providerSessionId);
    const terminalCleanupVisible =
      view.plan?.status === 'SUCCEEDED' &&
      worktrees.length > 0 &&
      worktrees.every((worktree) => worktree.state === 'RETIRED') &&
      queue.lease?.activeRootPlanId !== planId &&
      queue.lease?.committedRevision === view.plan?.currentRevision;
    if (terminalCleanupVisible && providerSessions.length > 0) {
      finalView = view;
      finalQueue = queue;
      break;
    }
    await sleep(POLL_MS);
  }
  if (!finalView || !finalQueue) fail('SMOKE_TIMEOUT');

  const items = finalView.workItems ?? [];
  if (items.length !== 2) fail('SMOKE_WORK_ITEM_COUNT_INVALID', { count: items.length });
  if (!items.every((item) => item.status === 'SUCCEEDED')) fail('SMOKE_WORK_ITEMS_NOT_SUCCEEDED');
  const waves = new Set(items.map((item) => item.wave));
  const bases = new Set(items.map((item) => item.integrationBaseRevision));
  if (waves.size !== 1 || ![...waves][0]) fail('SMOKE_PARALLEL_WAVE_MISSING');
  if (bases.size !== 1 || [...bases][0] !== baseRevision) fail('SMOKE_PARALLEL_BASE_MISMATCH');

  const executions = finalView.executions ?? [];
  const firstImplementations = items.map((item) => firstImplementationByItem(executions, item.workItemId));
  if (firstImplementations.some((execution) => !execution)) fail('SMOKE_PARALLEL_EXECUTION_MISSING');
  const startTimes = firstImplementations.map((execution) => Date.parse(execution.createdAt));
  const startDeltaMs = Math.max(...startTimes) - Math.min(...startTimes);
  if (!Number.isFinite(startDeltaMs) || startDeltaMs > PARALLEL_START_MAX_DELTA_MS)
    fail('SMOKE_PARALLEL_START_DELTA_EXCEEDED', { startDeltaMs });
  if (!firstImplementations.every((execution) => execution.identity.sourceRevision === baseRevision))
    fail('SMOKE_PARALLEL_SOURCE_REVISION_MISMATCH');

  const accepted = items.map((item) => {
    if (!item.exactAcceptedRevision) fail('SMOKE_ACCEPTED_REVISION_MISSING', { itemKey: item.itemKey });
    const implementation = acceptedImplementation(executions, item);
    if (!implementation)
      fail('SMOKE_ACCEPTED_IMPLEMENTATION_MISSING', {
        itemKey: item.itemKey,
        acceptedRevision: item.exactAcceptedRevision,
      });
    const review = (finalView.reviews ?? []).find(
      (candidate) =>
        candidate.workItemId === item.workItemId &&
        candidate.status === 'PASSED' &&
        candidate.verdict === 'PASS' &&
        candidate.reviewedSha === item.exactAcceptedRevision &&
        candidate.implementationExecutionId === executionId(implementation),
    );
    if (!review) fail('SMOKE_EXACT_REVIEW_MISSING', { itemKey: item.itemKey });
    if (!review.reviewerExecutionId || review.reviewerExecutionId === review.implementationExecutionId)
      fail('SMOKE_REVIEW_NOT_INDEPENDENT', { itemKey: item.itemKey });
    const reviewer = executions.find(
      (execution) => executionId(execution) === review.reviewerExecutionId,
    );
    if (
      !reviewer ||
      executionPhase(reviewer) !== 'REVIEW' ||
      reviewer.status !== 'SUCCEEDED' ||
      reviewer.identity.sourceRevision !== item.exactAcceptedRevision ||
      reviewer.resultRevision !== item.exactAcceptedRevision
    )
      fail('SMOKE_REVIEW_EXECUTION_INVALID', { itemKey: item.itemKey });
    return { item, implementation, review, reviewer };
  });

  const sessions = finalView.sessions ?? [];
  const sessionByExecution = new Map(sessions.map((session) => [session.executionId, session]));
  const implementationSessions = accepted.map(({ implementation }) =>
    sessionByExecution.get(executionId(implementation)),
  );
  if (implementationSessions.some((session) => !session?.providerSessionId))
    fail('SMOKE_IMPLEMENTATION_PROVIDER_SESSION_MISSING');
  if (new Set(implementationSessions.map((session) => session.providerSessionId)).size !== 2)
    fail('SMOKE_IMPLEMENTATION_PROVIDER_SESSION_NOT_INDEPENDENT');
  if (new Set(implementationSessions.map((session) => session.workspace?.hostPath)).size !== 2)
    fail('SMOKE_IMPLEMENTATION_WORKSPACE_NOT_INDEPENDENT');

  const finalRevision = finalView.plan.currentRevision;
  if (!finalRevision || finalRevision === baseRevision) fail('SMOKE_FINAL_REVISION_NOT_ADVANCED');
  const candidateRevisions = accepted.map(({ item }) => item.exactAcceptedRevision);
  if (candidateRevisions.some((candidate) => candidate === finalRevision))
    fail('SMOKE_SERIAL_INTEGRATION_NOT_COMBINED');
  if (!gitSucceeds(['merge-base', '--is-ancestor', baseRevision, finalRevision]))
    fail('SMOKE_FINAL_REVISION_NOT_DESCENDANT_OF_BASE');
  for (const candidate of candidateRevisions)
    if (!gitSucceeds(['merge-base', '--is-ancestor', candidate, finalRevision]))
      fail('SMOKE_FINAL_REVISION_MISSING_CANDIDATE', { candidate, finalRevision });
  if (git(['show', `${finalRevision}:${fileA}`]) !== `export const autonomousSmokeA = '${valueA}';`)
    fail('SMOKE_FINAL_TREE_A_INVALID');
  if (git(['show', `${finalRevision}:${fileB}`]) !== `export const autonomousSmokeB = '${valueB}';`)
    fail('SMOKE_FINAL_TREE_B_INVALID');

  if (!finalView.worktrees?.length || !finalView.worktrees.every((worktree) => worktree.state === 'RETIRED'))
    fail('SMOKE_WORKTREE_RETIREMENT_INCOMPLETE');
  if (finalQueue.lease?.activeRootPlanId) fail('SMOKE_PROJECT_LEASE_NOT_RELEASED');
  if (finalQueue.lease?.committedRevision !== finalRevision)
    fail('SMOKE_PROJECT_LOGICAL_HEAD_MISMATCH');
  if ((finalView.activationEvents ?? []).some((event) => event.type === 'PLAN_ACTIVATION_FAILED'))
    fail('SMOKE_PLAN_ACTIVATION_FAILURE_OBSERVED', { events: finalView.activationEvents });

  const providerSessions = sessions.filter((session) => session.providerSessionId);
  if (providerSessions.length < 4) fail('SMOKE_PROVIDER_SESSION_COUNT_TOO_LOW', { count: providerSessions.length });
  const cleanupProofs = [];
  for (const session of providerSessions) {
    const proof = await cleanupProof(session.executionId);
    if (!proof)
      fail('SMOKE_PROVIDER_CLEANUP_PROOF_MISSING', {
        executionId: session.executionId,
        providerSessionId: session.providerSessionId,
      });
    cleanupProofs.push({
      executionId: session.executionId,
      providerSessionId: session.providerSessionId,
      evidenceName: proof.name,
    });
    const status = await openHandsConversationStatus(session.providerSessionId);
    if (status !== 404)
      fail('SMOKE_OPENHANDS_CONVERSATION_STILL_PRESENT', {
        executionId: session.executionId,
        providerSessionId: session.providerSessionId,
        status,
      });
  }

  const leakedProcesses = providerProcessesForPlan(planId);
  if (leakedProcesses.length > 0)
    fail('SMOKE_PROVIDER_PROCESS_LEAK', { count: leakedProcesses.length, leakedProcesses });
  const refs = planRefLines(planId);
  if (refs.length > 0) fail('SMOKE_PLAN_REFS_REMAIN', { refs });
  const canonicalHeadAfter = git(['rev-parse', '--verify', 'HEAD^{commit}']);
  const canonicalStatusAfter = git(['status', '--porcelain=v1', '--untracked-files=all']);
  if (canonicalHeadAfter !== canonicalHeadBefore || canonicalStatusAfter !== canonicalStatusBefore)
    fail('SMOKE_CANONICAL_REPOSITORY_MUTATED', {
      before: canonicalHeadBefore,
      after: canonicalHeadAfter,
      statusAfter: canonicalStatusAfter,
    });

  completed = true;
  console.log(
    JSON.stringify(
      {
        status: 'PASSED',
        planId,
        projectKey: PROJECT_KEY,
        canonicalHead: canonicalHeadBefore,
        logicalBaseRevision: baseRevision,
        finalRevision,
        wave: [...waves][0],
        implementationStartDeltaMs: startDeltaMs,
        workItems: accepted.map(({ item, implementation, review, reviewer }) => ({
          itemKey: item.itemKey,
          workItemId: item.workItemId,
          acceptedRevision: item.exactAcceptedRevision,
          implementationExecutionId: executionId(implementation),
          implementationRoute: implementation.identity.route,
          reviewerExecutionId: executionId(reviewer),
          reviewerRoute: reviewer.identity.route,
          reviewId: review.reviewId,
        })),
        providerCleanupProofs: cleanupProofs,
        worktreesRetired: finalView.worktrees.length,
        leaseVersion: finalQueue.lease?.version,
        activationFailureCount: (finalView.activationEvents ?? []).filter(
          (event) => event.type === 'PLAN_ACTIVATION_FAILED',
        ).length,
      },
      null,
      2,
    ),
  );
}

try {
  await main();
} catch (error) {
  console.error(
    JSON.stringify(
      {
        status: 'FAILED',
        planId: planId ?? null,
        code: error?.code ?? error?.message ?? 'AUTONOMOUS_LIFECYCLE_SMOKE_FAILED',
        details: error?.details ?? null,
      },
      null,
      2,
    ),
  );
  process.exitCode = 2;
} finally {
  if (!completed)
    await bestEffortCancel(
      'Autonomous lifecycle smoke failed or timed out; retire all provider/worktree resources without changing canonical repository truth.',
    );
}
