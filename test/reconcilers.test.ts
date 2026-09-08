import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExecutionAutomationRuntime } from '../src/bootstrap/executionRuntime.js';
import type { ImprovementRuntimeAssembly } from '../src/bootstrap/improvementRuntime.js';
import type { SupervisorRuntimeAssembly } from '../src/bootstrap/supervisorRuntime.js';
import type { ProjectPlanQueueRuntime } from '../src/core/orchestration/projectPlanQueueRuntime.js';
import type { ForgeFlowRepositories } from '../src/core/persistence/repositories.js';
import { ImprovementReconciler } from '../src/reconcilers/improvement.js';
import { PlanLifecycleReconciler } from '../src/reconcilers/planLifecycle.js';
import { ResourceLifecycleReconciler } from '../src/reconcilers/resourceLifecycle.js';
import { RuntimeAdmissionReconciler } from '../src/reconcilers/runtimeAdmission.js';
import { StorageMaintenanceReconciler } from '../src/reconcilers/storageMaintenance.js';
import { SupervisorReconciler } from '../src/reconcilers/supervisor.js';

const logger = {
  info: () => undefined,
  error: () => undefined,
  warn: () => undefined,
};

test('runtime-admission reconciler is the single-flight refresh and shutdown owner', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reconcileCalls = 0;
  let shutdownCalls = 0;
  const automation = {
    runtimeAdmissionEnabled: true,
    reconcileRuntimeAdmission: async () => {
      reconcileCalls += 1;
      await gate;
    },
    shutdownRuntimeAdmission: async () => {
      shutdownCalls += 1;
    },
  } as unknown as ExecutionAutomationRuntime;
  const reconciler = new RuntimeAdmissionReconciler(automation, logger);
  const first = reconciler.request();
  const second = reconciler.request();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reconcileCalls, 1);
  release();
  await Promise.all([first, second]);
  await reconciler.close();
  assert.equal(shutdownCalls, 1);
  await reconciler.request();
  assert.equal(reconcileCalls, 1);
});

test('storage reconciler single-flights workspace cleanup and exposes maintenance projections', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let pruneCalls = 0;
  const repositories = {
    executions: { listByStatuses: () => [{ identity: { executionId: 'exec-1' } }] },
    sessions: { getOptional: () => ({ workspace: { hostPath: '/tmp/ws' } }) },
  } as unknown as ForgeFlowRepositories;
  const automation = {
    workspace: {
      storageStatus: () => ({ lowCapacity: true, minimumFreeBytes: 1 }),
      pruneTerminalCaches: async () => {
        pruneCalls += 1;
        await gate;
        return { pruned: 1 };
      },
    },
  } as unknown as ExecutionAutomationRuntime;
  const reconciler = new StorageMaintenanceReconciler(
    repositories,
    automation,
    () => ({ status: 'AVAILABLE' }),
    logger,
  );
  assert.deepEqual(reconciler.hostCacheMaintenanceStatus(), { status: 'AVAILABLE' });
  const first = reconciler.runMaintenance();
  const second = reconciler.runMaintenance();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pruneCalls, 1);
  release();
  assert.deepEqual(await first, { pruned: 1 });
  assert.deepEqual(await second, { pruned: 1 });
});

test('supervisor reconciler keeps admission warmup separate from decision cycles', async () => {
  const calls: string[] = [];
  const supervisor = {
    enabled: true,
    directAdmissionEnabled: true,
    reconcileDirectAdmission: async () => void calls.push('direct'),
    reconcileReadiness: async () => {
      calls.push('readiness');
      return { becameAvailable: [], scheduledWakes: 0 };
    },
    runtime: {
      runOnce: async () => {
        calls.push('decide');
        return [];
      },
    },
  } as unknown as SupervisorRuntimeAssembly;
  const reconciler = new SupervisorReconciler(
    supervisor,
    { pollMs: 25 } as never,
    logger,
  );
  await reconciler.warmup?.({ trigger: 'WARMUP' });
  assert.deepEqual(calls, ['readiness']);
  await reconciler.reconcile({ trigger: 'INTERVAL' });
  assert.deepEqual(calls, ['readiness', 'readiness', 'decide']);
  await reconciler.reconcileDirectAdmission();
  assert.equal(calls.at(-1), 'direct');
});

test('resource reconciler refreshes directory, lifecycle, Supervisor readiness, then runtime admission', async () => {
  const calls: string[] = [];
  const automation = {
    resourceSelectorEnabled: true,
    liteLlmResources: { refresh: async () => void calls.push('directory') },
    resourceLifecycle: { reconcileOnce: async () => void calls.push('resource-lifecycle') },
  } as unknown as ExecutionAutomationRuntime;
  const supervisor = {
    reconcileReadiness: async () => {
      calls.push('supervisor');
      return { becameAvailable: [], scheduledWakes: 0 };
    },
  } as unknown as SupervisorReconciler;
  const runtimeAdmission = {
    request: async () => void calls.push('admission'),
  } as unknown as RuntimeAdmissionReconciler;
  const reconciler = new ResourceLifecycleReconciler(
    automation,
    supervisor,
    runtimeAdmission,
    { resourceRefreshMs: 50 } as never,
    logger,
  );
  await reconciler.reconcile({ trigger: 'INTERVAL' });
  assert.deepEqual(calls, ['directory', 'resource-lifecycle', 'supervisor', 'admission']);
});

test('improvement reconciler uses the same bounded cycle for warmup and interval execution', async () => {
  let calls = 0;
  const result = {
    programs: [],
    reconciledCandidateIds: [],
    diagnosis: { diagnosedCandidateIds: [], adoptedPlanIds: [], errors: [] },
    selfPromotion: { requestedCandidateIds: [], errors: [] },
  };
  const improvement = {
    enabled: true,
    runtime: { runAutonomousCycle: async () => (calls += 1, result) },
  } as unknown as ImprovementRuntimeAssembly;
  const reconciler = new ImprovementReconciler(
    improvement,
    { cycleMs: 100 } as never,
    logger,
  );
  await reconciler.warmup({ trigger: 'WARMUP' });
  await reconciler.reconcile({ trigger: 'INTERVAL' });
  assert.equal(calls, 2);
});

test('plan reconciler preserves maintenance and queue ordering while detaching admission refresh', async () => {
  const calls: string[] = [];
  const automation = {
    plans: {
      runOnce: async () => {
        calls.push('plans');
        return [];
      },
    },
  } as unknown as ExecutionAutomationRuntime;
  const queue = { reconcile: async () => { calls.push('queue'); return []; } } as unknown as ProjectPlanQueueRuntime;
  const storage = {
    reconcile: async () => void calls.push('storage'),
  } as unknown as StorageMaintenanceReconciler;
  const runtimeAdmission = {
    requestDetached: () => void calls.push('admission-detached'),
  } as unknown as RuntimeAdmissionReconciler;
  const reconciler = new PlanLifecycleReconciler(
    automation,
    queue,
    storage,
    runtimeAdmission,
    { enabled: true, pollMs: 5 } as never,
    logger,
  );
  await reconciler.reconcile({ trigger: 'INTERVAL' });
  assert.deepEqual(calls, ['storage', 'queue', 'plans', 'admission-detached']);
});


test('plan reconciler surfaces terminal queue cleanup failures instead of silently retrying them', async () => {
  const errors: Array<{ data: unknown; message: string }> = [];
  const observedLogger = {
    info: () => undefined,
    error: (data: unknown, message: string) => void errors.push({ data, message }),
  };
  const automation = {
    plans: { runOnce: async () => [] },
  } as unknown as ExecutionAutomationRuntime;
  const queue = {
    reconcile: async () => [
      {
        projectKey: 'forgeflow-smoke',
        code: 'WORKSPACE_EVIDENCE_AMBIGUOUS',
        failure: true as const,
      },
    ],
  } as unknown as ProjectPlanQueueRuntime;
  const storage = { reconcile: async () => undefined } as unknown as StorageMaintenanceReconciler;
  const runtimeAdmission = {
    requestDetached: () => undefined,
  } as unknown as RuntimeAdmissionReconciler;
  const reconciler = new PlanLifecycleReconciler(
    automation,
    queue,
    storage,
    runtimeAdmission,
    { enabled: true, pollMs: 5 } as never,
    observedLogger,
  );

  await reconciler.reconcile({ trigger: 'INTERVAL' });
  assert.deepEqual(errors, [
    {
      data: { projectKey: 'forgeflow-smoke', code: 'WORKSPACE_EVIDENCE_AMBIGUOUS' },
      message: 'project Plan queue reconciliation failed',
    },
  ]);
});
