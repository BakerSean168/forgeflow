import assert from 'node:assert/strict';
import test from 'node:test';

import { ForgeFlowError } from '../src/core/domain/errors.js';
import { writeScopeAmendments } from '../src/api/v1/plans/input.js';

test('plan reconcile scope amendment input is explicit and bounded', () => {
  assert.deepEqual(
    writeScopeAmendments([
      {
        itemKey: 'DB-OPT-101',
        expectedWriteScopes: ['src/a.ts'],
        writeScopes: ['src/a.ts', 'src/b.ts'],
        reason: 'align with authoritative scope',
      },
    ]),
    [
      {
        itemKey: 'DB-OPT-101',
        expectedWriteScopes: ['src/a.ts'],
        writeScopes: ['src/a.ts', 'src/b.ts'],
        reason: 'align with authoritative scope',
      },
    ],
  );
  assert.deepEqual(writeScopeAmendments(undefined), []);
  assert.throws(
    () =>
      writeScopeAmendments([
        { itemKey: 'x', expectedWriteScopes: [], writeScopes: ['src/a.ts'], reason: 'invalid' },
      ]),
    (error: unknown) =>
      error instanceof ForgeFlowError &&
      error.code === 'WORK_ITEM_SCOPE_AMENDMENT_EXPECTED_SCOPES_INVALID',
  );
});
