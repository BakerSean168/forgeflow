import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FORGEFLOW_API_OPERATIONS,
  openApiPath,
  operationIdForRoute,
} from '../src/api/operations.js';

test('API operation registry has stable unique ids and exact route identities', () => {
  assert.equal(FORGEFLOW_API_OPERATIONS.length, 45);
  assert.equal(new Set(FORGEFLOW_API_OPERATIONS.map((item) => item.operationId)).size, 45);
  assert.equal(
    new Set(FORGEFLOW_API_OPERATIONS.map((item) => `${item.method} ${item.route}`)).size,
    45,
  );
  assert.equal(operationIdForRoute('GET', '/api/v1/projects/'), 'projectsList');
  assert.equal(operationIdForRoute('HEAD', '/api/v1/projects'), undefined);
  assert.equal(openApiPath('/api/v1/resources/:resourceId/state'), '/api/v1/resources/{resourceId}/state');
});
