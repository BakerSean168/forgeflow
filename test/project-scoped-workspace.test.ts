import assert from 'node:assert/strict';
import test from 'node:test';

import { ProjectScopedWorkspaceAdapter } from '../src/core/adapters/projectScopedWorkspace.js';
import type { LiteralWorktreeWorkspaceAdapter } from '../src/core/adapters/literalWorktreeWorkspace.js';
import type { WorkspaceDescriptor, WorkspaceProviderPort } from '../src/core/orchestration/contracts.js';
import type { ForgeFlowRepositories } from '../src/core/persistence/repositories.js';

function descriptor(executionId: string, hostPath: string): WorkspaceDescriptor {
  return {
    executionId,
    hostPath,
    executionPath: hostPath.replace('/host/', '/workspace/'),
    evidenceHostPath: hostPath + '/evidence.json',
    evidenceExecutionPath: hostPath.replace('/host/', '/workspace/') + '/evidence.json',
    sourceRepositoryPath: '/repo/project',
    sourceRevision: 'a'.repeat(40),
    createdAt: '2026-09-07T00:00:00.000Z',
  };
}

function provider(onPrepare: () => void): WorkspaceProviderPort {
  return {
    observeRepository: async (repositoryPath, revision) => ({
      repositoryPath,
      rootPath: repositoryPath,
      headRevision: revision,
      clean: true,
      commitExists: true,
      observedAt: '2026-09-07T00:00:00.000Z',
    }),
    isRevisionAncestor: async () => true,
    provision: async (input) => descriptor(input.executionId, '/host/legacy/' + input.executionId),
    prepareCancellationAccess: async () => onPrepare(),
    verifyImplementation: async () => {
      throw new Error('not used');
    },
    verifyReview: async () => {
      throw new Error('not used');
    },
    integrateAcceptedRevision: async (input) => ({
      repositoryPath: input.repositoryPath,
      rootPath: input.repositoryPath,
      headRevision: input.acceptedRevision,
      clean: true,
      commitExists: true,
      observedAt: '2026-09-07T00:00:00.000Z',
    }),
  };
}

test('ProjectScopedWorkspaceAdapter forwards cancellation access to the selected workspace backend', async () => {
  let literalCalls = 0;
  let legacyCalls = 0;
  const literal = provider(() => {
    literalCalls += 1;
  });
  const legacy = provider(() => {
    legacyCalls += 1;
  });
  const repositories = {
    planWorktrees: {
      findByPath: (hostPath: string) => (hostPath.includes('/literal/') ? { worktreeId: 'wt-1' } : undefined),
    },
  } as unknown as ForgeFlowRepositories;
  const scoped = new ProjectScopedWorkspaceAdapter({
    repositories,
    legacy,
    literal: literal as unknown as LiteralWorktreeWorkspaceAdapter,
    literalProjects: ['project-literal'],
  });

  await scoped.prepareCancellationAccess(descriptor('exec-literal', '/host/literal/repo'));
  await scoped.prepareCancellationAccess(descriptor('exec-legacy', '/host/legacy/repo'));

  assert.equal(literalCalls, 1);
  assert.equal(legacyCalls, 1);
});
