import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { checkApiContractCoverage } from '../scripts/check-api-contract-coverage.mts';

const contract = JSON.parse(fs.readFileSync('api/openapi.v1.json', 'utf8')) as Record<string, any>;

function failures(mutator: (candidate: Record<string, any>) => void): string[] {
  const candidate = structuredClone(contract) as Record<string, any>;
  mutator(candidate);
  return checkApiContractCoverage(candidate);
}

test('hardened V1 contract covers all public operations and audited request bodies', () => {
  assert.deepEqual(checkApiContractCoverage(contract), []);
});

test('coverage fails when a response schema disappears', () => {
  const result = failures((candidate) => {
    delete candidate.paths['/api/v1/improvements'].get.responses['200'].content;
  });
  assert.ok(result.some((item) => item.includes('no documented 2xx application/json response schema')));
});

test('coverage fails when an audited body disappears or an optional body is strengthened', () => {
  const missing = failures((candidate) => {
    delete candidate.paths['/api/v1/supervisors/{supervisorId}/decisions'].post.requestBody;
  });
  assert.ok(missing.some((item) => item.includes('expected requestBody contract is missing')));

  const strengthened = failures((candidate) => {
    candidate.paths['/api/v1/improvements/{candidateId}/adopt'].post.requestBody.required = true;
  });
  assert.ok(strengthened.some((item) => item.includes('legacy-optional request body became required')));
});
