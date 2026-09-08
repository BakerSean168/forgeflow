import assert from 'node:assert/strict';
import test from 'node:test';

import { ForgeFlowError } from '../src/core/domain/errors.js';
import { httpStatusForForgeFlowError } from '../src/api/shared/errors.js';
import { bodyRecord, requiredText } from '../src/api/shared/input.js';

test('shared API error mapping preserves the public ForgeFlow status contract', () => {
  assert.equal(httpStatusForForgeFlowError(new ForgeFlowError('PROJECT_NOT_FOUND')), 404);
  assert.equal(httpStatusForForgeFlowError(new ForgeFlowError('RESOURCE_STATE_STALE')), 409);
  assert.equal(httpStatusForForgeFlowError(new ForgeFlowError('EXECUTION_RUNTIME_DISABLED')), 503);
  assert.equal(httpStatusForForgeFlowError(new ForgeFlowError('RESOURCE_STATE_INVALID')), 400);
});

test('shared API input validation remains fail-closed', () => {
  assert.deepEqual(bodyRecord({ value: 1 }), { value: 1 });
  assert.throws(() => bodyRecord([]), (error: unknown) =>
    error instanceof ForgeFlowError && error.code === 'REQUEST_BODY_INVALID',
  );
  assert.equal(requiredText('  value  ', 'VALUE_REQUIRED'), 'value');
  assert.throws(() => requiredText(' ', 'VALUE_REQUIRED'), (error: unknown) =>
    error instanceof ForgeFlowError && error.code === 'VALUE_REQUIRED',
  );
});
