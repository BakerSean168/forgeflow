import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ForgeFlowError } from '../src/core/domain/errors.js';
import {
  loadProjectManifest,
  projectRegistryFromLegacyEnv,
} from '../src/platform/projects/index.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeflow-project-registry-'));
  const allowed = path.join(root, 'repositories');
  const repoA = path.join(allowed, 'alpha');
  const repoB = path.join(allowed, 'beta');
  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(repoB, { recursive: true });
  return { root, allowed, repoA, repoB, manifest: path.join(root, 'projects.yaml') };
}

test('project manifest is a fail-closed declarative project registry', () => {
  const value = fixture();
  try {
    fs.writeFileSync(
      value.manifest,
      `version: 1
projects:
  - projectKey: alpha
    displayName: Alpha
    description: Primary product
    repositoryPath: ${value.repoA}
    tags: [product, typescript]
    execution:
      enabled: true
      workspace: literal-worktree
      allowProviderNative: true
      maxParallelWorkItems: 3
    improvement:
      enabled: false
  - projectKey: beta
    repositoryPath: ${value.repoB}
    execution:
      enabled: false
    improvement:
      enabled: true
`,
      { mode: 0o600 },
    );
    const registry = loadProjectManifest(value.manifest, [value.allowed]);
    assert.equal(registry.source(), 'manifest');
    assert.deepEqual(registry.automationProjectKeys(), ['alpha']);
    assert.deepEqual(registry.literalWorktreeProjectKeys(), ['alpha']);
    assert.deepEqual(registry.providerNativeProjectKeys(), ['alpha']);
    assert.deepEqual(registry.improvementProjectKeys(), ['beta']);
    assert.deepEqual(registry.require('alpha'), {
      projectKey: 'alpha',
      repositoryPath: value.repoA,
      displayName: 'Alpha',
      description: 'Primary product',
      tags: ['product', 'typescript'],
      execution: {
        enabled: true,
        workspace: 'literal-worktree',
        allowProviderNative: true,
        maxParallelWorkItems: 3,
      },
      improvement: { enabled: false },
      source: 'manifest',
    });
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('project manifest rejects repository escape and duplicate repository ownership', () => {
  const value = fixture();
  try {
    const outside = path.join(value.root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(
      value.manifest,
      `version: 1
projects:
  - projectKey: outside
    repositoryPath: ${outside}
    execution:
      enabled: true
`,
    );
    assert.throws(
      () => loadProjectManifest(value.manifest, [value.allowed]),
      (error) => error instanceof ForgeFlowError && error.code === 'PROJECT_REPOSITORY_OUTSIDE_ALLOWED_ROOT',
    );

    fs.writeFileSync(
      value.manifest,
      `version: 1
projects:
  - projectKey: alpha
    repositoryPath: ${value.repoA}
  - projectKey: beta
    repositoryPath: ${value.repoA}
`,
    );
    assert.throws(
      () => loadProjectManifest(value.manifest, [value.allowed]),
      (error) => error instanceof ForgeFlowError && error.code === 'PROJECT_REGISTRY_DUPLICATE_REPOSITORY',
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('legacy project environment remains a compatibility source', () => {
  const registry = projectRegistryFromLegacyEnv({
    FORGEFLOW_AUTOMATION_PROJECTS: 'alpha,beta',
    FORGEFLOW_LITERAL_WORKTREE_PROJECTS: 'alpha,beta',
    FORGEFLOW_LITERAL_WORKTREE_REPOSITORIES: '/repos/alpha,/repos/beta',
    FORGEFLOW_ANTIGRAVITY_PROJECTS: 'alpha',
    FORGEFLOW_IMPROVEMENT_PROJECTS: 'beta',
  });
  assert.equal(registry.source(), 'legacy-env');
  assert.deepEqual(registry.automationProjectKeys(), ['alpha', 'beta']);
  assert.deepEqual(registry.literalWorktreeProjectKeys(), ['alpha', 'beta']);
  assert.deepEqual(registry.providerNativeProjectKeys(), ['alpha']);
  assert.deepEqual(registry.improvementProjectKeys(), ['beta']);
  assert.equal(registry.require('alpha').repositoryPath, '/repos/alpha');
});

test('project manifest requires absolute repository paths', () => {
  const value = fixture();
  try {
    fs.writeFileSync(
      value.manifest,
      `version: 1
projects:
  - projectKey: relative
    repositoryPath: repositories/relative
`,
    );
    assert.throws(
      () => loadProjectManifest(value.manifest, [value.allowed]),
      (error) =>
        error instanceof ForgeFlowError && error.code === 'PROJECT_REPOSITORY_ABSOLUTE_REQUIRED',
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('project registry binds a project identity to its configured repository', () => {
  const value = fixture();
  try {
    fs.writeFileSync(
      value.manifest,
      `version: 1
projects:
  - projectKey: alpha
    repositoryPath: ${value.repoA}
    execution:
      enabled: true
`,
    );
    const registry = loadProjectManifest(value.manifest, [value.allowed]);
    assert.equal(registry.resolveRepository('alpha'), value.repoA);
    assert.equal(registry.resolveRepository('alpha', value.repoA), value.repoA);
    assert.throws(
      () => registry.resolveRepository('alpha', value.repoB),
      (error) => error instanceof ForgeFlowError && error.code === 'PROJECT_REPOSITORY_MISMATCH',
    );
    assert.throws(
      () => registry.resolveRepository('missing', value.repoB),
      (error) => error instanceof ForgeFlowError && error.code === 'PROJECT_NOT_FOUND',
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
