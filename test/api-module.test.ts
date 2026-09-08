import assert from 'node:assert/strict';
import test from 'node:test';

import Fastify from 'fastify';

import { ForgeFlowError } from '../src/core/domain/errors.js';
import { registerApiModules, type ForgeFlowApiModule } from '../src/api/module.js';

test('API module registry registers versioned modules in explicit order', async () => {
  const app = Fastify({ logger: false });
  const observed: string[] = [];
  const modules: ForgeFlowApiModule[] = [
    { id: 'beta', apiVersion: 1, register: async () => void observed.push('beta') },
    { id: 'alpha', apiVersion: 1, register: async () => void observed.push('alpha') },
  ];
  try {
    const ids = await registerApiModules(app, modules);
    assert.deepEqual(observed, ['beta', 'alpha']);
    assert.deepEqual(ids, ['alpha', 'beta']);
  } finally {
    await app.close();
  }
});

test('API module registry fails closed on duplicate identities and unsupported versions', async () => {
  const app = Fastify({ logger: false });
  const noop = async () => {};
  try {
    await assert.rejects(
      registerApiModules(app, [
        { id: 'projects', apiVersion: 1, register: noop },
        { id: 'projects', apiVersion: 1, register: noop },
      ]),
      (error) => error instanceof ForgeFlowError && error.code === 'API_MODULE_DUPLICATE',
    );
    await assert.rejects(
      registerApiModules(app, [
        { id: 'future', apiVersion: 2 as 1, register: noop },
      ]),
      (error) => error instanceof ForgeFlowError && error.code === 'API_MODULE_VERSION_UNSUPPORTED',
    );
  } finally {
    await app.close();
  }
});
