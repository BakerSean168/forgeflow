import type { ForgeFlowRepositories } from '../../core/persistence/repositories.js';
import type {
  RepositoryObservation,
  WorkspaceCachePruneResult,
  WorkspaceCommittedCandidateSnapshot,
  WorkspaceCompletionSnapshot,
  WorkspaceDescriptor,
  WorkspaceProviderPort,
  WorkspaceProvisionInput,
  WorkspaceStorageStatus,
} from '../../core/orchestration/contracts.js';
import { ForgeFlowError, failClosed } from '../../core/domain/errors.js';
import { LiteralWorktreeWorkspaceAdapter } from './literalWorktreeWorkspace.js';

export class ProjectScopedWorkspaceAdapter implements WorkspaceProviderPort {
  readonly repositories: ForgeFlowRepositories;
  readonly legacy: WorkspaceProviderPort;
  readonly literal: LiteralWorktreeWorkspaceAdapter;
  readonly literalProjects: ReadonlySet<string>;

  constructor(input: {
    repositories: ForgeFlowRepositories;
    legacy: WorkspaceProviderPort;
    literal: LiteralWorktreeWorkspaceAdapter;
    literalProjects: Iterable<string>;
  }) {
    this.repositories = input.repositories;
    this.legacy = input.legacy;
    this.literal = input.literal;
    this.literalProjects = new Set(input.literalProjects);
    failClosed(this.literalProjects.size > 0, 'LITERAL_WORKTREE_PROJECTS_REQUIRED');
  }

  integrationStrategyFor(
    _planId: string,
    projectKey: string,
  ): 'CANONICAL_FAST_FORWARD' | 'PLAN_WORKTREE' {
    return this.literalProjects.has(projectKey) ? 'PLAN_WORKTREE' : 'CANONICAL_FAST_FORWARD';
  }

  async assertPlanSafety(planId: string): Promise<void> {
    const plan = this.repositories.plans.getPlan(planId);
    if (this.literalProjects.has(plan.projectKey)) await this.literal.assertPlanSafety(planId);
  }

  async deliveryWorkspace(planId: string): Promise<string | undefined> {
    const plan = this.repositories.plans.getPlan(planId);
    return this.literalProjects.has(plan.projectKey)
      ? await this.literal.deliveryWorkspace(planId)
      : undefined;
  }

  async observeRepository(
    repositoryPath: string,
    revision: string,
  ): Promise<RepositoryObservation> {
    return await this.legacy.observeRepository(repositoryPath, revision);
  }

  async isRevisionAncestor(
    repositoryPath: string,
    ancestorRevision: string,
    descendantRevision: string,
  ): Promise<boolean> {
    if (!this.legacy.isRevisionAncestor) throw new ForgeFlowError('WORKSPACE_ANCESTRY_CHECK_UNAVAILABLE');
    return await this.legacy.isRevisionAncestor(
      repositoryPath,
      ancestorRevision,
      descendantRevision,
    );
  }

  async provision(input: WorkspaceProvisionInput): Promise<WorkspaceDescriptor> {
    return this.literalProjects.has(input.projectKey ?? '')
      ? await this.literal.provision(input)
      : await this.legacy.provision(input);
  }

  hasCompletionEvidence(workspace: WorkspaceDescriptor): boolean {
    return this.isLiteral(workspace)
      ? this.literal.hasCompletionEvidence!(workspace)
      : (this.legacy.hasCompletionEvidence?.(workspace) ?? false);
  }

  async progressFingerprint(workspace: WorkspaceDescriptor): Promise<string> {
    const provider = this.isLiteral(workspace) ? this.literal : this.legacy;
    if (!provider.progressFingerprint)
      throw new ForgeFlowError('WORKSPACE_PROGRESS_FINGERPRINT_UNAVAILABLE');
    return await provider.progressFingerprint(workspace);
  }

  async inspectCommittedImplementation(
    workspace: WorkspaceDescriptor,
  ): Promise<WorkspaceCommittedCandidateSnapshot> {
    if (!this.isLiteral(workspace) || !this.literal.inspectCommittedImplementation)
      throw new ForgeFlowError('WORKSPACE_FINALIZATION_RECOVERY_UNAVAILABLE');
    return await this.literal.inspectCommittedImplementation(workspace);
  }

  async prepareCancellationAccess(workspace: WorkspaceDescriptor): Promise<void> {
    const provider = this.isLiteral(workspace) ? this.literal : this.legacy;
    if (provider.prepareCancellationAccess) await provider.prepareCancellationAccess(workspace);
  }

  async abandonExecution(workspace: WorkspaceDescriptor): Promise<void> {
    const provider = this.isLiteral(workspace) ? this.literal : this.legacy;
    if (provider.abandonExecution) await provider.abandonExecution(workspace);
  }

  async preparePlanRetirement(planId: string): Promise<void> {
    const plan = this.repositories.plans.getPlan(planId);
    const provider = this.literalProjects.has(plan.projectKey) ? this.literal : this.legacy;
    if (provider.preparePlanRetirement) await provider.preparePlanRetirement(planId);
  }

  storageStatus(): WorkspaceStorageStatus {
    if (!this.legacy.storageStatus) throw new ForgeFlowError('WORKSPACE_STORAGE_STATUS_UNAVAILABLE');
    return this.legacy.storageStatus();
  }

  async pruneTerminalCaches(
    workspaces: readonly WorkspaceDescriptor[],
  ): Promise<WorkspaceCachePruneResult> {
    const literal: WorkspaceDescriptor[] = [];
    const legacy: WorkspaceDescriptor[] = [];
    for (const workspace of workspaces)
      (this.isLiteral(workspace) ? literal : legacy).push(workspace);
    const before = this.storageStatus();
    let workspacesScanned = 0;
    let cacheDirectoriesPruned = 0;
    if (legacy.length > 0 && this.legacy.pruneTerminalCaches) {
      const result = await this.legacy.pruneTerminalCaches(legacy);
      workspacesScanned += result.workspacesScanned;
      cacheDirectoriesPruned += result.cacheDirectoriesPruned;
    }
    if (literal.length > 0 && this.literal.pruneTerminalCaches) {
      const result = await this.literal.pruneTerminalCaches(literal);
      workspacesScanned += result.workspacesScanned;
      cacheDirectoriesPruned += result.cacheDirectoriesPruned;
    }
    const after = this.storageStatus();
    return {
      workspacesScanned,
      cacheDirectoriesPruned,
      freeBytesBefore: before.freeBytes,
      freeBytesAfter: after.freeBytes,
    };
  }

  async verifyImplementation(workspace: WorkspaceDescriptor): Promise<WorkspaceCompletionSnapshot> {
    return this.isLiteral(workspace)
      ? await this.literal.verifyImplementation(workspace)
      : await this.legacy.verifyImplementation(workspace);
  }

  async verifyReview(
    workspace: WorkspaceDescriptor,
    reviewedSha: string,
  ): Promise<WorkspaceCompletionSnapshot> {
    return this.isLiteral(workspace)
      ? await this.literal.verifyReview(workspace, reviewedSha)
      : await this.legacy.verifyReview(workspace, reviewedSha);
  }

  async integrateAcceptedRevision(input: {
    repositoryPath: string;
    expectedRevision: string;
    acceptedRevision: string;
    candidateWorkspace: WorkspaceDescriptor;
    planId?: string;
    workItemId?: string;
    integrationBaseRevision?: string;
  }): Promise<RepositoryObservation> {
    return this.isLiteral(input.candidateWorkspace)
      ? await this.literal.integrateAcceptedRevision(input)
      : await this.legacy.integrateAcceptedRevision(input);
  }

  private isLiteral(workspace: WorkspaceDescriptor): boolean {
    const worktree = this.repositories.planWorktrees.findByPath(workspace.hostPath);
    return Boolean(worktree);
  }
}
