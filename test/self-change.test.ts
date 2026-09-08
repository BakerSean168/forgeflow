import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildControlPlane } from '../src/app.js';
import { ExactShaSelfChangeCanary } from '../src/integrations/release/index.js';
import {
  FileSelfChangePromotionQueue,
  type SelfChangePromotionRequest,
} from '../src/integrations/release/index.js';
import { ForgeFlowError } from '../src/core/domain/errors.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(cwd: string, args: string[]): string {
  return execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function createCanaryFixture(): {
  root: string;
  repository: string;
  canaryRoot: string;
  sourceRevision: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeflow-self-canary-'));
  const repository = path.join(root, 'repository');
  const canaryRoot = path.join(root, 'canaries');
  fs.mkdirSync(repository, { recursive: true });
  fs.mkdirSync(path.join(repository, 'node_modules'));
  fs.mkdirSync(path.join(repository, 'scripts'));
  fs.copyFileSync(
    path.join(projectRoot, 'scripts', 'artifact-digest.sh'),
    path.join(repository, 'scripts', 'artifact-digest.sh'),
  );
  fs.chmodSync(path.join(repository, 'scripts', 'artifact-digest.sh'), 0o755);
  fs.writeFileSync(
    path.join(repository, 'package.json'),
    JSON.stringify(
      {
        name: 'forgeflow-self-canary-fixture',
        private: true,
        type: 'module',
        scripts: {
          build: 'node build.mjs',
          'check:boundary': 'node -e ""',
          'check-types': 'node -e ""',
          test: 'node -e ""',
        },
      },
      null,
      2,
    ) + '\n',
  );
  fs.writeFileSync(
    path.join(repository, 'build.mjs'),
    [
      "import fs from 'node:fs';",
      "fs.rmSync('dist', { recursive: true, force: true });",
      "fs.mkdirSync('dist', { recursive: true });",
      "fs.writeFileSync('dist/app.js', `export async function buildControlPlane(){return {app:{async inject(){return {statusCode:200,json(){return {service:'forgeflow-control-plane'}}}},async close(){}}}}\\n`);",
    ].join('\n') + '\n',
  );
  execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', repository]);
  git(repository, ['add', 'package.json', 'build.mjs', 'scripts/artifact-digest.sh']);
  git(repository, [
    '-c',
    'user.name=ForgeFlow Test',
    '-c',
    'user.email=forgeflow-test@localhost',
    'commit',
    '-q',
    '-m',
    'chore: canary fixture',
  ]);
  return {
    root,
    repository,
    canaryRoot,
    sourceRevision: git(repository, ['rev-parse', 'HEAD']),
  };
}

test('exact-SHA self-change canary builds, hashes, smoke-boots and removes its worktree', async () => {
  const value = createCanaryFixture();
  try {
    execFileSync('npm', ['run', 'build'], { cwd: value.repository, stdio: 'ignore' });
    const expectedDigest = execFileSync(
      path.join(value.repository, 'scripts', 'artifact-digest.sh'),
      [path.join(value.repository, 'dist')],
      { cwd: value.repository, encoding: 'utf8' },
    ).trim();
    const runner = new ExactShaSelfChangeCanary({
      repositoryPath: value.repository,
      worktreeRoot: value.canaryRoot,
      commandTimeoutMs: 60_000,
    });
    const result = await runner.run({
      candidateId: 'candidate-self-canary',
      planId: 'plan-self-canary',
      sourceRevision: value.sourceRevision,
    });
    assert.equal(result.result, 'PASSED');
    assert.equal(result.sourceRevision, value.sourceRevision);
    assert.equal(result.artifactSha256, expectedDigest);
    assert.deepEqual(result.checks, [
      'build',
      'artifact-digest',
      'boundary',
      'typecheck',
      'tests',
      'artifact-smoke',
    ]);
    assert.deepEqual(fs.readdirSync(value.canaryRoot), []);
    assert.equal(git(value.repository, ['worktree', 'list', '--porcelain']).includes(value.canaryRoot), false);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('exact-SHA self-change canary preserves artifact identity while reporting a failed verification gate', async () => {
  const value = createCanaryFixture();
  try {
    const packageFile = path.join(value.repository, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as Record<string, any>;
    pkg.scripts.test = 'node -e "process.exit(3)"';
    fs.writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + '\n');
    git(value.repository, ['add', 'package.json']);
    git(value.repository, [
      '-c',
      'user.name=ForgeFlow Test',
      '-c',
      'user.email=forgeflow-test@localhost',
      'commit',
      '-q',
      '-m',
      'test: fail canary verification',
    ]);
    const revision = git(value.repository, ['rev-parse', 'HEAD']);
    const runner = new ExactShaSelfChangeCanary({
      repositoryPath: value.repository,
      worktreeRoot: value.canaryRoot,
      commandTimeoutMs: 60_000,
    });
    const result = await runner.run({
      candidateId: 'candidate-self-canary-fail',
      planId: 'plan-self-canary-fail',
      sourceRevision: revision,
    });
    assert.equal(result.result, 'FAILED');
    assert.match(result.artifactSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(result.checks, [
      'build',
      'artifact-digest',
      'boundary',
      'typecheck',
      'failed:tests',
    ]);
    assert.deepEqual(fs.readdirSync(value.canaryRoot), []);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('self-promotion configuration fails closed before runtime boot', async () => {
  await assert.rejects(
    buildControlPlane({
      dbFile: ':memory:',
      environment: 'test',
      logger: false,
      env: {
        NODE_ENV: 'test',
        FORGEFLOW_LITELLM_BASE_URL: 'http://litellm.test/v1',
        FORGEFLOW_IMPROVEMENT_SELF_PROMOTION_ENABLED: 'true',
      },
    }),
    (error: unknown) =>
      error instanceof ForgeFlowError &&
      error.code === 'IMPROVEMENT_SELF_PROMOTION_REQUIRES_SELF_CHANGE',
  );
  await assert.rejects(
    buildControlPlane({
      dbFile: ':memory:',
      environment: 'test',
      logger: false,
      env: {
        NODE_ENV: 'test',
        FORGEFLOW_LITELLM_BASE_URL: 'http://litellm.test/v1',
        FORGEFLOW_IMPROVEMENT_SELF_AUTO_PROMOTION_ENABLED: 'true',
      },
    }),
    (error: unknown) =>
      error instanceof ForgeFlowError &&
      error.code === 'IMPROVEMENT_SELF_AUTO_PROMOTION_REQUIRES_PROMOTION',
  );
  await assert.rejects(
    buildControlPlane({
      dbFile: ':memory:',
      environment: 'production',
      logger: false,
      env: {
        NODE_ENV: 'production',
        FORGEFLOW_LITELLM_BASE_URL: 'http://litellm.test/v1',
        FORGEFLOW_IMPROVEMENT_SELF_CHANGE_ENABLED: 'true',
        FORGEFLOW_IMPROVEMENT_SELF_PROMOTION_ENABLED: 'true',
        FORGEFLOW_IMPROVEMENT_SELF_PROMOTION_REQUEST_FILE: '/tmp/unsupported-self-promotion.json',
      },
    }),
    (error: unknown) =>
      error instanceof ForgeFlowError &&
      error.code === 'IMPROVEMENT_SELF_PROMOTION_REQUEST_PATH_UNSUPPORTED',
  );
});

test('file self-promotion queue is atomic, replayable and rejects conflicting or unsafe requests', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeflow-self-promotion-'));
  try {
    const requestFile = path.join(root, 'request.json');
    const queue = new FileSelfChangePromotionQueue(requestFile);
    const request: SelfChangePromotionRequest = {
      version: 1,
      candidateId: 'candidate-safe',
      planId: 'plan-safe',
      sourceRevision: 'a'.repeat(40),
      artifactSha256: 'b'.repeat(64),
      canaryAttestationId: 'improvement-canary-' + 'c'.repeat(64),
      requestedAt: '2026-09-06T09:50:00.000Z',
    };
    assert.deepEqual(queue.request(request), request);
    assert.deepEqual(queue.current(), request);
    assert.equal(fs.statSync(requestFile).mode & 0o777, 0o600);
    assert.deepEqual(queue.request(request), request);
    assert.throws(
      () => queue.request({ ...request, artifactSha256: 'd'.repeat(64) }),
      (error: unknown) =>
        error instanceof ForgeFlowError && error.code === 'IMPROVEMENT_PROMOTION_REQUEST_CONFLICT',
    );

    fs.rmSync(requestFile);
    fs.symlinkSync(path.join(root, 'elsewhere.json'), requestFile);
    assert.throws(
      () => queue.current(),
      (error: unknown) =>
        error instanceof ForgeFlowError && error.code === 'IMPROVEMENT_PROMOTION_REQUEST_CORRUPTED',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
