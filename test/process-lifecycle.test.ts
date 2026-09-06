import assert from 'node:assert/strict';
import test from 'node:test';

import {
  installGracefulShutdown,
  type GracefulShutdownProcess,
} from '../src/processLifecycle.js';

class FakeProcess implements GracefulShutdownProcess {
  exitCode: string | number | null | undefined;
  private readonly listeners = new Map<'SIGTERM' | 'SIGINT', () => void>();

  once(signal: 'SIGTERM' | 'SIGINT', listener: () => void): void {
    this.listeners.set(signal, listener);
  }

  off(signal: 'SIGTERM' | 'SIGINT', listener: () => void): void {
    if (this.listeners.get(signal) === listener) this.listeners.delete(signal);
  }

  emit(signal: 'SIGTERM' | 'SIGINT'): void {
    const listener = this.listeners.get(signal);
    if (!listener) return;
    this.listeners.delete(signal);
    listener();
  }

  has(signal: 'SIGTERM' | 'SIGINT'): boolean {
    return this.listeners.has(signal);
  }
}

test('graceful shutdown turns SIGTERM/SIGINT into one idempotent async close', async () => {
  const fakeProcess = new FakeProcess();
  let closeCalls = 0;
  let release!: () => void;
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handle = installGracefulShutdown(
    async () => {
      closeCalls += 1;
      await closed;
    },
    fakeProcess,
  );

  fakeProcess.emit('SIGTERM');
  const concurrent = handle.shutdown('SIGINT');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeCalls, 1);
  release();
  await concurrent;
  assert.equal(closeCalls, 1);
  assert.equal(fakeProcess.exitCode, undefined);
  handle.uninstall();
  assert.equal(fakeProcess.has('SIGTERM'), false);
  assert.equal(fakeProcess.has('SIGINT'), false);
});

test('graceful shutdown reports close failure through process exit code without throwing from signal handler', async () => {
  const fakeProcess = new FakeProcess();
  const errors: Array<{ error: unknown; signal: string }> = [];
  const handle = installGracefulShutdown(
    async () => {
      throw new Error('close failed');
    },
    fakeProcess,
    (error, signal) => errors.push({ error, signal }),
  );

  await handle.shutdown('SIGTERM');
  assert.equal(fakeProcess.exitCode, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.signal, 'SIGTERM');
  assert.match(String(errors[0]?.error), /close failed/);
});
