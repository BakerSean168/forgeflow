import assert from 'node:assert/strict';
import test from 'node:test';

import { ForgeFlowError } from '../src/core/domain/errors.js';
import { assertSafeEventPayload } from '../src/core/domain/events.js';

test('event payload safety rejects credential-like fields and cyclic values', () => {
  assert.throws(() => assertSafeEventPayload({ token: 'provider-token' }), (error: unknown) => error instanceof ForgeFlowError && error.code === 'UNSAFE_EVENT_PAYLOAD');
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => assertSafeEventPayload(cyclic), (error: unknown) => error instanceof ForgeFlowError && error.code === 'UNSAFE_EVENT_PAYLOAD');
});
