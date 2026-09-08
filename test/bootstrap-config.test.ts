import assert from 'node:assert/strict';
import test from 'node:test';

import { loadBootstrapConfig } from '../src/bootstrap/config.js';
import { ForgeFlowError } from '../src/core/domain/errors.js';

test('bootstrap config keeps disabled execution feature validation lazy', () => {
  const processEnv = { PATH: '/probe/path', SENTINEL: 'host-only' };
  const { config } = loadBootstrapConfig(
    {
      NODE_ENV: 'test',
      FORGEFLOW_EXECUTION_RUNTIME_ENABLED: 'false',
      FORGEFLOW_WORKSPACE_UID: 'not-an-integer',
    },
    { environment: 'test', processEnv },
  );

  assert.equal(config.execution.enabled, false);
  assert.equal(config.execution.childProcessEnv, processEnv);
  assert.throws(
    () => config.execution.workspace.uid,
    (error: unknown) => error instanceof ForgeFlowError && error.code === 'WORKSPACE_OWNER_INVALID',
  );
  assert.throws(
    () => config.execution.openHands.baseUrl,
    (error: unknown) => error instanceof ForgeFlowError && error.code === 'OPENHANDS_BASE_URL_REQUIRED',
  );
});

test('bootstrap config parses unconditional control-plane settings with legacy defaults', () => {
  const { config, projects } = loadBootstrapConfig(
    { NODE_ENV: 'test', FORGEFLOW_EXECUTION_RUNTIME_ENABLED: 'false' },
    { environment: 'test', dbFile: ':memory:' },
  );

  assert.equal(config.environment, 'test');
  assert.equal(config.database.file, ':memory:');
  assert.equal(config.server.host, '127.0.0.1');
  assert.equal(config.server.port, 8420);
  assert.equal(config.supervisor.maxResourceAttempts, 3);
  assert.equal(config.supervisor.admissionReadyTtlMs, 15 * 60_000);
  assert.equal(config.improvement.aiDiagnosisMaxPerCycle, 2);
  assert.equal(config.telemetry.baseUrl, 'http://127.0.0.1:4000');
  assert.equal(projects.list().length, 0);
});

test('bootstrap config preserves source-env data-reset authorization without leaking raw env downstream', () => {
  const { config } = loadBootstrapConfig(
    {
      NODE_ENV: 'development',
      FORGEFLOW_EXECUTION_RUNTIME_ENABLED: 'false',
      FORGEFLOW_ALLOW_DATA_RESET: 'true',
      FORGEFLOW_DB: '/tmp/forgeflow-config-test.sqlite',
    },
    { environment: 'development' },
  );

  assert.equal(config.database.allowDataReset, true);
  assert.equal(config.database.file, '/tmp/forgeflow-config-test.sqlite');
});
