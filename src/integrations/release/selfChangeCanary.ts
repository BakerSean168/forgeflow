import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { ForgeFlowError, failClosed } from '../../core/domain/errors.js';

export interface SelfChangeCanaryInput {
  candidateId: string;
  planId: string;
  sourceRevision: string;
}

export interface SelfChangeCanaryResult {
  sourceRevision: string;
  artifactSha256: string;
  result: 'PASSED' | 'FAILED';
  checks: string[];
  observedAt: string;
}

export interface SelfChangeCanaryPort {
  run(input: SelfChangeCanaryInput): Promise<SelfChangeCanaryResult>;
}

export interface ExactShaSelfChangeCanaryOptions {
  repositoryPath: string;
  worktreeRoot: string;
  commandTimeoutMs?: number;
  npmCommand?: string;
  nodeCommand?: string;
}

function boundedError(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 500);
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 8_192) stderr += chunk.toString('utf8').slice(0, 8_192 - stderr.length);
    });
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    timer.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = boundedError(stderr);
      reject(
        new ForgeFlowError(
          killed ? 'IMPROVEMENT_CANARY_COMMAND_TIMEOUT' : 'IMPROVEMENT_CANARY_COMMAND_FAILED',
          detail || `Canary command failed (${command}, code=${String(code)}, signal=${String(signal)}).`,
        ),
      );
    });
  });
}

function exactDirectory(value: string, code: string): string {
  const resolved = path.resolve(value);
  failClosed(path.isAbsolute(resolved), code);
  const stat = fs.lstatSync(resolved);
  failClosed(stat.isDirectory() && !stat.isSymbolicLink(), code);
  return resolved;
}

export class ExactShaSelfChangeCanary implements SelfChangeCanaryPort {
  readonly repositoryPath: string;
  readonly worktreeRoot: string;
  readonly commandTimeoutMs: number;
  readonly npmCommand: string;
  readonly nodeCommand: string;

  constructor(options: ExactShaSelfChangeCanaryOptions) {
    this.repositoryPath = exactDirectory(
      options.repositoryPath,
      'IMPROVEMENT_SELF_REPOSITORY_INVALID',
    );
    this.worktreeRoot = path.resolve(options.worktreeRoot);
    failClosed(path.isAbsolute(this.worktreeRoot), 'IMPROVEMENT_CANARY_ROOT_INVALID');
    failClosed(
      this.worktreeRoot !== this.repositoryPath &&
        !this.worktreeRoot.startsWith(this.repositoryPath + path.sep),
      'IMPROVEMENT_CANARY_ROOT_INVALID',
    );
    this.commandTimeoutMs = options.commandTimeoutMs ?? 15 * 60_000;
    failClosed(
      Number.isInteger(this.commandTimeoutMs) &&
        this.commandTimeoutMs >= 30_000 &&
        this.commandTimeoutMs <= 60 * 60_000,
      'IMPROVEMENT_CANARY_TIMEOUT_INVALID',
    );
    this.npmCommand = options.npmCommand ?? 'npm';
    this.nodeCommand = options.nodeCommand ?? process.execPath;
  }

  async run(input: SelfChangeCanaryInput): Promise<SelfChangeCanaryResult> {
    failClosed(input.candidateId.trim().length > 0, 'CANDIDATE_ID_REQUIRED');
    failClosed(input.planId.trim().length > 0, 'CANDIDATE_PLAN_INPUT_INVALID');
    failClosed(/^[0-9a-f]{40}$/.test(input.sourceRevision), 'IMPROVEMENT_CANARY_REVISION_INVALID');

    const gitDir = path.join(this.repositoryPath, '.git');
    failClosed(fs.existsSync(gitDir), 'IMPROVEMENT_SELF_REPOSITORY_INVALID');
    fs.mkdirSync(this.worktreeRoot, { recursive: true, mode: 0o700 });
    const rootStat = fs.lstatSync(this.worktreeRoot);
    failClosed(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'IMPROVEMENT_CANARY_ROOT_INVALID');

    const identity = createHash('sha256')
      .update([input.candidateId, input.planId, input.sourceRevision].join('|'))
      .digest('hex')
      .slice(0, 24);
    const worktree = path.join(this.worktreeRoot, identity + '-' + randomUUID().slice(0, 8));
    const checks: string[] = [];
    let artifactSha256 = '';
    let failedCheck = '';

    const runCheck = async (name: string, command: string, args: string[]) => {
      try {
        await runCommand(command, args, worktree, this.commandTimeoutMs);
        checks.push(name);
      } catch (error) {
        failedCheck = name;
        throw error;
      }
    };

    try {
      await runCommand(
        '/usr/bin/git',
        ['-C', this.repositoryPath, 'cat-file', '-e', input.sourceRevision + '^{commit}'],
        this.repositoryPath,
        30_000,
      );
      await runCommand(
        '/usr/bin/git',
        ['-C', this.repositoryPath, 'worktree', 'add', '--detach', worktree, input.sourceRevision],
        this.repositoryPath,
        60_000,
      );
      const head = await this.readGit(worktree, ['rev-parse', '--verify', 'HEAD^{commit}']);
      failClosed(head === input.sourceRevision, 'IMPROVEMENT_CANARY_REVISION_MISMATCH');
      const status = await this.readGit(worktree, ['status', '--porcelain=v1']);
      failClosed(status === '', 'IMPROVEMENT_CANARY_WORKTREE_DIRTY');

      const canonicalModules = path.join(this.repositoryPath, 'node_modules');
      failClosed(
        fs.existsSync(canonicalModules) && fs.statSync(canonicalModules).isDirectory(),
        'IMPROVEMENT_CANARY_NODE_MODULES_MISSING',
      );
      fs.symlinkSync(canonicalModules, path.join(worktree, 'node_modules'), 'dir');

      await runCheck('build', this.npmCommand, ['run', 'build']);
      const digestScript = path.join(this.repositoryPath, 'scripts', 'artifact-digest.sh');
      failClosed(fs.existsSync(digestScript), 'IMPROVEMENT_CANARY_DIGEST_TOOL_MISSING');
      artifactSha256 = await this.readCommand(digestScript, [path.join(worktree, 'dist')], worktree);
      failClosed(/^[0-9a-f]{64}$/.test(artifactSha256), 'IMPROVEMENT_CANARY_ARTIFACT_INVALID');
      checks.push('artifact-digest');

      await runCheck('boundary', this.npmCommand, ['run', 'check:boundary']);
      await runCheck('typecheck', this.npmCommand, ['run', 'check-types']);
      await runCheck('tests', this.npmCommand, ['test']);
      const smoke = [
        "import { buildControlPlane } from './dist/app.js';",
        "const runtime = await buildControlPlane({ dbFile: ':memory:', environment: 'test', env: { NODE_ENV: 'test', FORGEFLOW_EXECUTION_RUNTIME_ENABLED: 'false', FORGEFLOW_RELEASE_PROVENANCE_FILE: '/tmp/forgeflow-canary-release-provenance-missing' } });",
        "try { const response = await runtime.app.inject({ method: 'GET', url: '/api/health' }); if (response.statusCode !== 200 || response.json().service !== 'forgeflow-control-plane') process.exitCode = 1; } finally { await runtime.app.close(); }",
      ].join('\n');
      await runCheck('artifact-smoke', this.nodeCommand, ['--input-type=module', '-e', smoke]);

      return {
        sourceRevision: input.sourceRevision,
        artifactSha256,
        result: 'PASSED',
        checks,
        observedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (!artifactSha256) throw error;
      return {
        sourceRevision: input.sourceRevision,
        artifactSha256,
        result: 'FAILED',
        checks: [...checks, 'failed:' + (failedCheck || 'verification')],
        observedAt: new Date().toISOString(),
      };
    } finally {
      try {
        await runCommand(
          '/usr/bin/git',
          ['-C', this.repositoryPath, 'worktree', 'remove', '--force', worktree],
          this.repositoryPath,
          60_000,
        );
      } catch {
        fs.rmSync(worktree, { recursive: true, force: true });
      }
      try {
        await runCommand(
          '/usr/bin/git',
          ['-C', this.repositoryPath, 'worktree', 'prune', '--expire', 'now'],
          this.repositoryPath,
          30_000,
        );
      } catch {
        // Stale worktree metadata remains fail-closed and can be pruned by the next run.
      }
    }
  }

  private async readGit(cwd: string, args: string[]): Promise<string> {
    return await this.readCommand('/usr/bin/git', ['-C', cwd, ...args], cwd);
  }

  private async readCommand(command: string, args: string[], cwd: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), this.commandTimeoutMs);
      timer.unref();
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < 8_192) stdout += chunk.toString('utf8').slice(0, 8_192 - stdout.length);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < 8_192) stderr += chunk.toString('utf8').slice(0, 8_192 - stderr.length);
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(
            new ForgeFlowError(
              'IMPROVEMENT_CANARY_COMMAND_FAILED',
              boundedError(stderr) || `Canary command failed (${command}, code=${String(code)}).`,
            ),
          );
          return;
        }
        resolve(stdout.trim());
      });
    });
  }
}
