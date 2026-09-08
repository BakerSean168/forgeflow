import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AntigravityGitProvenanceError,
  resolveSourceCommonGitDir,
} from '../scripts/forgeflow-antigravity-git-provenance.mjs';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeflow-antigravity-git-'));
  const repository = path.join(root, 'repository');
  const linked = path.join(root, 'linked-control');
  fs.mkdirSync(repository, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repository]);
  git(repository, ['config', 'user.name', 'ForgeFlow Test']);
  git(repository, ['config', 'user.email', 'forgeflow-test@local']);
  fs.writeFileSync(path.join(repository, 'README.md'), '# source\n');
  git(repository, ['add', 'README.md']);
  git(repository, ['commit', '-m', 'chore: initialize']);
  git(repository, ['worktree', 'add', '--detach', linked, 'HEAD']);
  return { root, repository, linked };
}

function provenanceCode(error: unknown): string | undefined {
  return error instanceof AntigravityGitProvenanceError ? error.code : undefined;
}

test('Antigravity Git provenance accepts normal and linked control worktrees with one common dir', () => {
  const value = fixture();
  try {
    const expected = fs.realpathSync(path.join(value.repository, '.git'));
    assert.equal(resolveSourceCommonGitDir(value.repository), expected);
    assert.equal(resolveSourceCommonGitDir(value.linked), expected);

    const sourceGitfile = path.join(value.linked, '.git');
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(fs.readFileSync(sourceGitfile, 'utf8'));
    assert.ok(match);
    const admin = path.resolve(match[1]);
    assert.equal(
      path.resolve(fs.readFileSync(path.join(admin, 'gitdir'), 'utf8').trim()),
      sourceGitfile,
    );
    assert.equal(
      fs.realpathSync(path.resolve(admin, fs.readFileSync(path.join(admin, 'commondir'), 'utf8').trim())),
      expected,
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('Antigravity Git provenance rejects a linked source whose admin backlink is forged', () => {
  const value = fixture();
  try {
    const sourceGitfile = path.join(value.linked, '.git');
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(fs.readFileSync(sourceGitfile, 'utf8'));
    assert.ok(match);
    const admin = path.resolve(match[1]);
    fs.writeFileSync(path.join(admin, 'gitdir'), path.join(value.root, 'other', '.git') + '\n');
    assert.throws(
      () => resolveSourceCommonGitDir(value.linked),
      (error: unknown) => provenanceCode(error) === 'ANTIGRAVITY_UNIT_SOURCE_GITDIR_INVALID',
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('Antigravity Git provenance rejects symlinked source Git metadata', () => {
  const value = fixture();
  const fake = path.join(value.root, 'fake-source');
  fs.mkdirSync(fake);
  fs.symlinkSync(path.join(value.repository, '.git'), path.join(fake, '.git'));
  try {
    assert.throws(
      () => resolveSourceCommonGitDir(fake),
      (error: unknown) => provenanceCode(error) === 'ANTIGRAVITY_UNIT_SOURCE_GIT_INVALID',
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
