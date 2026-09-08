import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { checkOpenApiCompatibility } from '../scripts/check-openapi-compat.mts';

const baseline = JSON.parse(fs.readFileSync('api/compat/openapi.v1.2.1.json', 'utf8')) as Record<string, any>;
const clone = () => structuredClone(baseline) as Record<string, any>;

function failures(mutator: (candidate: Record<string, any>) => void): string[] {
  const candidate = clone();
  mutator(candidate);
  return checkOpenApiCompatibility(baseline, candidate);
}

test('OpenAPI compatibility allows additive metadata, optional parameters and responses', () => {
  const candidate = clone();
  candidate.paths['/api/v1/plans'].get.operationId = 'plansList';
  candidate.paths['/api/v1/plans'].get.parameters ??= [];
  candidate.paths['/api/v1/plans'].get.parameters.push({
    in: 'query', name: 'cursor', required: false, schema: { type: 'string' },
  });
  candidate.paths['/api/v1/plans'].get.responses['206'] = { description: 'Partial Content' };
  candidate.paths['/api/v1/new-capability'] = { get: { responses: { '200': { description: 'OK' } } } };
  assert.deepEqual(checkOpenApiCompatibility(baseline, candidate), []);
});

test('OpenAPI compatibility rejects path and operation removal', () => {
  assert.match(failures((candidate) => delete candidate.paths['/api/v1/plans'])[0]!, /path removed/);
  assert.match(
    failures((candidate) => delete candidate.paths['/api/v1/plans/{planId}'].get)[0]!,
    /operation removed/,
  );
});

test('OpenAPI compatibility rejects required parameter strengthening', () => {
  const removed = failures((candidate) => {
    candidate.paths['/api/v1/plans/{planId}'].get.parameters = [];
  });
  assert.ok(removed.some((item) => item.includes('parameter removed: path:planId')));

  const added = failures((candidate) => {
    candidate.paths['/api/v1/plans'].get.parameters ??= [];
    candidate.paths['/api/v1/plans'].get.parameters.push({
      in: 'query', name: 'cursor', required: true, schema: { type: 'string' },
    });
  });
  assert.ok(added.some((item) => item.includes('new required parameter: query:cursor')));
});

test('OpenAPI compatibility rejects response status and media-type removal', () => {
  const status = failures((candidate) => {
    delete candidate.paths['/api/v1/projects'].get.responses['200'];
  });
  assert.ok(status.some((item) => item.includes('response status removed: 200')));

  const media = failures((candidate) => {
    delete candidate.paths['/api/v1/projects'].get.responses['200'].content['application/json'];
  });
  assert.ok(media.some((item) => item.includes('media type removed: application/json')));
});

test('OpenAPI compatibility rejects enum narrowing and response guarantee weakening', () => {
  const narrowed = failures((candidate) => {
    candidate.paths['/api/v1/projects/{projectKey}'].get.responses['200'].content['application/json']
      .schema.properties.execution.properties.workspace.enum = ['literal-worktree'];
  });
  assert.ok(narrowed.some((item) => item.includes('enum narrowed')));

  const weakened = failures((candidate) => {
    const schema = candidate.paths['/api/v1/projects/{projectKey}'].get.responses['200'].content['application/json'].schema;
    schema.required = schema.required.filter((value: string) => value !== 'projectKey');
  });
  assert.ok(weakened.some((item) => item.includes('required response property no longer guaranteed: projectKey')));
});
