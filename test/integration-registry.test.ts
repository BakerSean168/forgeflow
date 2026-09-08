import assert from 'node:assert/strict';
import test from 'node:test';

import { ForgeFlowError } from '../src/core/domain/errors.js';
import { CapabilityRegistry } from '../src/integrations/registry.js';

test('capability registry rejects duplicate ids and unsupported or ambiguous matches', () => {
  const duplicate = new CapabilityRegistry<string, string>();
  duplicate.register({ id: 'one', supports: () => true, create: () => 'one' });
  assert.throws(
    () => duplicate.register({ id: 'one', supports: () => false, create: () => 'two' }),
    (error: unknown) => error instanceof ForgeFlowError && error.code === 'INTEGRATION_ID_DUPLICATE',
  );

  const unsupported = new CapabilityRegistry<string, string>();
  unsupported.register({ id: 'none', supports: () => false, create: () => 'none' });
  assert.throws(
    () => unsupported.resolve('x'),
    (error: unknown) => error instanceof ForgeFlowError && error.code === 'INTEGRATION_CAPABILITY_UNSUPPORTED',
  );

  const ambiguous = new CapabilityRegistry<string, string>();
  ambiguous.register({ id: 'a', supports: () => true, create: () => 'a' });
  ambiguous.register({ id: 'b', supports: () => true, create: () => 'b' });
  assert.throws(
    () => ambiguous.resolve('x'),
    (error: unknown) => error instanceof ForgeFlowError && error.code === 'INTEGRATION_CAPABILITY_AMBIGUOUS',
  );
});

test('capability registry resolves exactly one implementation and exposes stable ids', () => {
  const registry = new CapabilityRegistry<number, string>();
  registry.register({ id: 'odd', supports: (value) => value % 2 === 1, create: () => 'odd' });
  registry.register({ id: 'even', supports: (value) => value % 2 === 0, create: () => 'even' });
  assert.equal(registry.resolve(2), 'even');
  assert.equal(registry.resolve(3), 'odd');
  assert.deepEqual(registry.ids(), ['even', 'odd']);
});
