import assert from 'node:assert/strict';
import test from 'node:test';

import { ForgeFlowError } from '../src/core/domain/errors.js';
import type { Reconciler, ReconcilerClock } from '../src/reconcilers/contracts.js';
import { ReconcilerLifecycleManager } from '../src/reconcilers/lifecycle.js';

class FakeClock implements ReconcilerClock {
  readonly intervals: Array<{ callback: () => void; intervalMs: number; cleared: boolean }> = [];
  readonly immediates: Array<{ callback: () => void; cleared: boolean }> = [];

  setInterval(callback: () => void, intervalMs: number): unknown {
    const handle = { callback, intervalMs, cleared: false };
    this.intervals.push(handle);
    return handle;
  }
  clearInterval(handle: unknown): void {
    (handle as { cleared: boolean }).cleared = true;
  }
  setImmediate(callback: () => void): unknown {
    const handle = { callback, cleared: false };
    this.immediates.push(handle);
    return handle;
  }
  clearImmediate(handle: unknown): void {
    (handle as { cleared: boolean }).cleared = true;
  }
}

const logger = { error: () => undefined };

test('reconciler lifecycle validates identity and interval contracts', () => {
  const base: Reconciler = { id: 'a', enabled: true, reconcile: async () => undefined };
  assert.throws(
    () => new ReconcilerLifecycleManager([base, base], logger, new FakeClock()),
    (error: unknown) => error instanceof ForgeFlowError && error.code === 'RECONCILER_ID_DUPLICATE',
  );
  assert.throws(
    () =>
      new ReconcilerLifecycleManager(
        [{ ...base, id: 'bad', intervalMs: 0 }],
        logger,
        new FakeClock(),
      ),
    (error: unknown) => error instanceof ForgeFlowError && error.code === 'RECONCILER_INTERVAL_INVALID',
  );
});

test('lifecycle schedules only enabled reconcilers and keeps warmup distinct from interval reconcile', async () => {
  const clock = new FakeClock();
  const calls: string[] = [];
  const enabled: Reconciler = {
    id: 'enabled',
    enabled: true,
    intervalMs: 25,
    warmup: async () => void calls.push('warmup'),
    reconcile: async () => void calls.push('reconcile'),
  };
  const disabled: Reconciler = {
    id: 'disabled',
    enabled: false,
    intervalMs: 10,
    reconcile: async () => void calls.push('disabled'),
  };
  const lifecycle = new ReconcilerLifecycleManager([enabled, disabled], logger, clock);
  lifecycle.start();
  assert.equal(clock.immediates.length, 1);
  assert.equal(clock.intervals.length, 1);
  assert.equal(clock.intervals[0]?.intervalMs, 25);
  clock.immediates[0]?.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['warmup']);
  clock.intervals[0]?.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['warmup', 'reconcile']);
  await lifecycle.close();
});

test('manual reconciliation single-flights overlapping work and close disables future runs', async () => {
  const clock = new FakeClock();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  let closes = 0;
  const reconciler: Reconciler = {
    id: 'single',
    enabled: true,
    reconcile: async () => {
      calls += 1;
      await gate;
    },
    close: async () => {
      closes += 1;
    },
  };
  const lifecycle = new ReconcilerLifecycleManager([reconciler], logger, clock);
  lifecycle.start();
  const first = lifecycle.runNow('single');
  await new Promise((resolve) => setImmediate(resolve));
  const second = await lifecycle.runNow('single');
  assert.equal(second.status, 'SKIPPED_RUNNING');
  assert.equal(calls, 1);
  release();
  assert.equal((await first).status, 'COMPLETED');
  await lifecycle.close();
  assert.equal(closes, 1);
  assert.equal((await lifecycle.runNow('single')).status, 'SKIPPED_CLOSED');
});

test('close drains lifecycle-managed in-flight reconciliation before returning', async () => {
  const clock = new FakeClock();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const reconciler: Reconciler = {
    id: 'drain',
    enabled: true,
    reconcile: async () => {
      calls.push('run-start');
      await gate;
      calls.push('run-end');
    },
    close: async () => void calls.push('close-hook'),
  };
  const lifecycle = new ReconcilerLifecycleManager([reconciler], logger, clock);
  lifecycle.start();
  const running = lifecycle.runNow('drain');
  await new Promise((resolve) => setImmediate(resolve));
  let closed = false;
  const closing = lifecycle.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  assert.deepEqual(calls, ['run-start', 'close-hook']);
  release();
  await Promise.all([running, closing]);
  assert.equal(closed, true);
  assert.deepEqual(calls, ['run-start', 'close-hook', 'run-end']);
});
