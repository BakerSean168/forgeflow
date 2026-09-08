import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ForgeFlowError } from '../../core/domain/errors.js';
import type { WorkspaceProviderPort } from '../../core/orchestration/contracts.js';
import type { ForgeFlowRepositories } from '../../core/persistence/repositories.js';
import { LocalGitWorkspaceAdapter } from './gitWorkspace.js';
import { LiteralWorktreeWorkspaceAdapter } from './literalWorktreeWorkspace.js';
import { PlanWorktreeManager } from './planWorktrees.js';
import { ProjectScopedWorkspaceAdapter } from './projectScopedWorkspace.js';

export interface WorkspaceIntegrationOptions {
  repositories: ForgeFlowRepositories;
  allowedRepositoryRoots: string[];
  managedHostRoot: string;
  executionRoot: string;
  literalProjectKeys: string[];
  workspaceUid: number;
  workspaceGid: number;
  commandTimeoutMs: number;
  maxBufferBytes: number;
  minimumFreeBytes: number;
  agentHarnessCtl: string;
  openHandsContainer: string;
  nodeEnv?: string;
}

export interface WorkspaceIntegrationAssembly {
  workspace: WorkspaceProviderPort;
  planWorktreeManager?: PlanWorktreeManager;
  workspaceUid: number;
  workspaceGid: number;
}

function assertOpenHandsGitCommonDirMounted(
  repositoryPath: string,
  container: string,
  commandTimeoutMs: number,
  maxBufferBytes: number,
): void {
  try {
    const rawCommon = execFileSync(
      '/usr/bin/git',
      ['-c', `safe.directory=${repositoryPath}`, '-C', repositoryPath, 'rev-parse', '--git-common-dir'],
      {
        encoding: 'utf8',
        timeout: commandTimeoutMs,
        maxBuffer: maxBufferBytes,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
    const common = fs.realpathSync(
      path.isAbsolute(rawCommon) ? rawCommon : path.resolve(repositoryPath, rawCommon),
    );
    const rawMounts = execFileSync(
      '/usr/bin/docker',
      ['inspect', container, '--format', '{{json .Mounts}}'],
      {
        encoding: 'utf8',
        timeout: commandTimeoutMs,
        maxBuffer: maxBufferBytes,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
    const mounts = JSON.parse(rawMounts) as Array<{
      Source?: unknown;
      Destination?: unknown;
      RW?: unknown;
    }>;
    if (
      !Array.isArray(mounts) ||
      !mounts.some(
        (mount) =>
          mount.Source === common && mount.Destination === common && mount.RW === true,
      )
    )
      throw new ForgeFlowError(
        'WORKTREE_OPENHANDS_COMMON_DIR_NOT_MOUNTED',
        'Literal worktrees require the canonical Git common directory mounted read-write at the same path inside OpenHands.',
      );
  } catch (error) {
    if (error instanceof ForgeFlowError) throw error;
    throw new ForgeFlowError(
      'WORKTREE_OPENHANDS_MOUNT_CHECK_FAILED',
      'Unable to verify the OpenHands Git common-directory mount.',
      error,
    );
  }
}

export function buildWorkspaceIntegrationAssembly(
  options: WorkspaceIntegrationOptions,
): WorkspaceIntegrationAssembly {
  const legacy = new LocalGitWorkspaceAdapter({
    allowedRepositoryRoots: options.allowedRepositoryRoots,
    managedHostRoot: options.managedHostRoot,
    executionRoot: options.executionRoot,
    commandTimeoutMs: options.commandTimeoutMs,
    maxBufferBytes: options.maxBufferBytes,
    minimumFreeBytes: options.minimumFreeBytes,
    workspaceUid: options.workspaceUid,
    workspaceGid: options.workspaceGid,
  });
  const manager =
    options.literalProjectKeys.length > 0
      ? new PlanWorktreeManager({
          repositories: options.repositories,
          allowedRepositoryRoots: options.allowedRepositoryRoots,
          managedHostRoot: options.managedHostRoot,
          executionRoot: options.executionRoot,
          commandTimeoutMs: options.commandTimeoutMs,
          maxBufferBytes: options.maxBufferBytes,
          projectAdmission: (repositoryPath) => {
            try {
              execFileSync(
                '/usr/bin/python3',
                [options.agentHarnessCtl, 'plan', repositoryPath, '--profile', 'openhands', '--json'],
                {
                  cwd: repositoryPath,
                  encoding: 'utf8',
                  timeout: options.commandTimeoutMs,
                  maxBuffer: options.maxBufferBytes,
                  stdio: ['ignore', 'pipe', 'pipe'],
                },
              );
            } catch (error) {
              throw new ForgeFlowError(
                'WORKTREE_AGENT_HARNESS_PROJECT_UNREGISTERED',
                'Literal worktree projects must resolve through Agent Harness before activation.',
                error,
              );
            }
            if (options.nodeEnv !== 'test')
              assertOpenHandsGitCommonDirMounted(
                repositoryPath,
                options.openHandsContainer,
                options.commandTimeoutMs,
                options.maxBufferBytes,
              );
          },
        })
      : undefined;
  const literal = manager
    ? new LiteralWorktreeWorkspaceAdapter({
        repositories: options.repositories,
        manager,
        managedHostRoot: options.managedHostRoot,
        executionRoot: options.executionRoot,
        workspaceUid: options.workspaceUid,
        workspaceGid: options.workspaceGid,
        minimumFreeBytes: options.minimumFreeBytes,
        commandTimeoutMs: options.commandTimeoutMs,
        maxBufferBytes: options.maxBufferBytes,
      })
    : undefined;
  const workspace: WorkspaceProviderPort = literal
    ? new ProjectScopedWorkspaceAdapter({
        repositories: options.repositories,
        legacy,
        literal,
        literalProjects: options.literalProjectKeys,
      })
    : legacy;
  return {
    workspace,
    ...(manager ? { planWorktreeManager: manager } : {}),
    workspaceUid: options.workspaceUid,
    workspaceGid: options.workspaceGid,
  };
}
