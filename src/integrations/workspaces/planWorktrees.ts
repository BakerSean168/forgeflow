import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { ForgeFlowError, failClosed } from '../../core/domain/errors.js';
import { isTerminalPlanStatus } from '../../core/domain/plan.js';
import type { PlanWorktree, PlanWorktreeRole } from '../../core/domain/worktree.js';
import type { ForgeFlowRepositories } from '../../core/persistence/repositories.js';

const execFileAsync = promisify(execFile);
const MAX_ID_BYTES = 120;
const RETRYABLE_ACTIVATION_FAILURE_CODES = new Set([
  'WORKTREE_AGENT_HARNESS_PROJECT_UNREGISTERED',
  'WORKTREE_OPENHANDS_COMMON_DIR_NOT_MOUNTED',
  'WORKTREE_OPENHANDS_MOUNT_CHECK_FAILED',
  'WORKTREE_GIT_FAILED',
  'WORKTREE_SUBMODULE_INIT_FAILED',
  'WORKTREE_ACL_TOOL_MISSING',
  'WORKTREE_ACL_FAILED',
]);

interface GitWorktreeRecord {
  path: string;
  head: string;
  branch?: string;
  detached: boolean;
  lockedReason?: string;
}

interface RepositoryIdentity {
  uid: number;
  gid: number;
}

export interface PlanWorktreeManagerOptions {
  repositories: ForgeFlowRepositories;
  allowedRepositoryRoots: string[];
  managedHostRoot: string;
  executionRoot: string;
  commandTimeoutMs?: number;
  maxBufferBytes?: number;
  setfaclBinary?: string;
  projectAdmission?: (repositoryPath: string) => void | Promise<void>;
}

interface WorktreeRequest {
  projectKey: string;
  rootPlanId: string;
  repositoryPath: string;
  baseRevision: string;
}

export interface WorkItemWorktreeRequest extends WorktreeRequest {
  workItemId: string;
}

export interface ReviewWorktreeRequest extends WorktreeRequest {
  reviewId: string;
  reviewedSha: string;
}

export interface DeliveryRepairWorktreeRequest extends WorktreeRequest {
  repairId: string;
  deliveryHeadSha: string;
}

function inside(candidate: string, root: string): boolean {
  const value = path.resolve(candidate);
  const boundary = path.resolve(root);
  return value === boundary || value.startsWith(boundary + path.sep);
}

export function worktreeRefComponent(value: string): string {
  const source = value.trim();
  failClosed(source.length > 0, 'WORKTREE_REF_COMPONENT_REQUIRED');
  if (
    Buffer.byteLength(source, 'utf8') <= MAX_ID_BYTES &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(source) &&
    source !== '.' &&
    source !== '..' &&
    !source.endsWith('.lock') &&
    !source.includes('..')
  )
    return source;
  const encoded = 'x' + Buffer.from(source, 'utf8').toString('hex');
  failClosed(encoded.length <= 2 * MAX_ID_BYTES + 1, 'WORKTREE_REF_COMPONENT_TOO_LONG');
  return encoded;
}

function worktreeId(role: PlanWorktreeRole, rootPlanId: string, identity: string): string {
  return [
    'worktree',
    role.toLowerCase(),
    worktreeRefComponent(rootPlanId),
    worktreeRefComponent(identity),
  ].join(':');
}

export class PlanWorktreeManager {
  readonly repositories: ForgeFlowRepositories;
  readonly allowedRepositoryRoots: string[];
  readonly managedHostRoot: string;
  readonly executionRoot: string;
  readonly commandTimeoutMs: number;
  readonly maxBufferBytes: number;
  readonly setfaclBinary: string;
  readonly projectAdmission?: (repositoryPath: string) => void | Promise<void>;
  private readonly activationInFlight = new Map<string, Promise<PlanWorktree>>();

  constructor(options: PlanWorktreeManagerOptions) {
    failClosed(options.allowedRepositoryRoots.length > 0, 'WORKTREE_ALLOWED_ROOT_REQUIRED');
    this.repositories = options.repositories;
    this.allowedRepositoryRoots = options.allowedRepositoryRoots.map((root) =>
      fs.realpathSync(root),
    );
    this.managedHostRoot = fs.realpathSync(options.managedHostRoot);
    this.executionRoot = path.posix.resolve('/', options.executionRoot);
    this.commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
    this.maxBufferBytes = options.maxBufferBytes ?? 8 * 1024 * 1024;
    this.setfaclBinary = options.setfaclBinary ?? '/usr/bin/setfacl';
    this.projectAdmission = options.projectAdmission;
  }

  async ensurePlanActivated(rootPlanId: string): Promise<PlanWorktree> {
    const existing = this.activationInFlight.get(rootPlanId);
    if (existing) return await existing;
    const activation = this.activatePlan(rootPlanId);
    this.activationInFlight.set(rootPlanId, activation);
    try {
      return await activation;
    } finally {
      if (this.activationInFlight.get(rootPlanId) === activation)
        this.activationInFlight.delete(rootPlanId);
    }
  }

  private async activatePlan(rootPlanId: string): Promise<PlanWorktree> {
    const plan = this.repositories.plans.getPlan(rootPlanId);
    failClosed(!plan.parentPlanId, 'WORKTREE_ROOT_PLAN_REQUIRED');
    failClosed(
      plan.status === 'READY' ||
        plan.status === 'RUNNING' ||
        plan.status === 'WAITING_FOR_RESOURCE' ||
        plan.status === 'WAITING_FOR_SYSTEM_REPAIR' ||
        plan.status === 'WAITING_FOR_EXTERNAL_EVIDENCE',
      'WORKTREE_PLAN_NOT_ACTIVATABLE',
    );
    const lease = this.repositories.projectPlans.getLease(plan.projectKey);
    failClosed(lease?.activeRootPlanId === rootPlanId, 'WORKTREE_ACTIVE_PLAN_REQUIRED');
    failClosed(lease.repositoryPath === plan.repositoryPath, 'WORKTREE_REPOSITORY_MISMATCH');
    try {
      if (this.projectAdmission) await this.projectAdmission(plan.repositoryPath);
      await this.ensureProtectedRefSnapshot(rootPlanId);
      await this.assertProtectedRefsStable(rootPlanId);
      const existingIntegration = this.repositories.planWorktrees
        .listByPlan(plan.planId)
        .find((record) => record.role === 'INTEGRATION' && record.state !== 'RETIRED');
      const integration = await this.ensureIntegration({
        projectKey: plan.projectKey,
        rootPlanId: plan.planId,
        repositoryPath: plan.repositoryPath,
        baseRevision: existingIntegration?.baseRevision ?? plan.currentRevision,
      });
      this.recoverActivationWait(rootPlanId);
      return integration;
    } catch (error) {
      const code = error instanceof ForgeFlowError ? error.code : 'WORKTREE_PLAN_ACTIVATION_FAILED';
      const disposition = RETRYABLE_ACTIVATION_FAILURE_CODES.has(code)
        ? 'SYSTEM_REPAIR'
        : 'SAFETY_HOLD';
      this.recordActivationFailure(rootPlanId, code, disposition);
      if (disposition === 'SYSTEM_REPAIR') this.enterSystemRepairWait(rootPlanId);
      else this.enterSafetyHold(rootPlanId);
      throw error;
    }
  }

  async assertPlanSafety(rootPlanId: string): Promise<void> {
    await this.assertProtectedRefsStable(rootPlanId);
  }

  async retirePlan(rootPlanId: string, agentUid: number): Promise<void> {
    await this.assertProtectedRefsStable(rootPlanId);
    const records = this.repositories.planWorktrees.listByPlan(rootPlanId);
    failClosed(
      records.every((record) => !record.ownerExecutionId),
      'WORKTREE_PLAN_WRITER_HELD',
    );
    const order: Record<PlanWorktreeRole, number> = {
      REVIEW: 0,
      WORK_ITEM: 1,
      DELIVERY_REPAIR: 2,
      INTEGRATION: 3,
    };
    for (const record of [...records].sort((left, right) => order[left.role] - order[right.role])) {
      if (record.state !== 'RETIRED') await this.retire(record.worktreeId);
    }
    if (records.length > 0) await this.revokePlanAgentAccess(rootPlanId, agentUid);
    const plan = this.repositories.plans.getPlan(rootPlanId);
    await this.archivePlanFamilyRefs(plan.planId);
    const prefix = 'refs/heads/forgeflow/' + worktreeRefComponent(rootPlanId) + '/';
    const refs = await this.git(plan.repositoryPath, [
      'for-each-ref',
      '--format=%(refname)',
      prefix,
    ]);
    for (const ref of refs
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean)) {
      failClosed(ref.startsWith(prefix), 'WORKTREE_BRANCH_NAMESPACE_INVALID');
      await this.git(plan.repositoryPath, ['update-ref', '-d', ref]);
    }
  }

  async ensureIntegration(input: WorktreeRequest): Promise<PlanWorktree> {
    const branchRef = this.planBranch(input.rootPlanId, 'integration');
    return await this.ensureBranched({
      ...input,
      role: 'INTEGRATION',
      identity: 'integration',
      relativePath: ['integration', 'repo'],
      branchRef,
    });
  }

  async ensureWorkItem(input: WorkItemWorktreeRequest): Promise<PlanWorktree> {
    await this.ensurePlanActivated(input.rootPlanId);
    const item = this.repositories.plans.getWorkItem(input.workItemId);
    failClosed(
      this.rootPlanIdFor(item.planId) === input.rootPlanId,
      'WORKTREE_WORK_ITEM_PLAN_MISMATCH',
    );
    const itemComponent = worktreeRefComponent(input.workItemId);
    return await this.ensureBranched({
      ...input,
      role: 'WORK_ITEM',
      identity: input.workItemId,
      workItemId: input.workItemId,
      relativePath: ['items', itemComponent, 'repo'],
      branchRef: this.planBranch(input.rootPlanId, 'items/' + itemComponent + '/head'),
    });
  }

  async ensureDeliveryRepair(input: DeliveryRepairWorktreeRequest): Promise<PlanWorktree> {
    await this.ensurePlanActivated(input.rootPlanId);
    const repairComponent = worktreeRefComponent(input.repairId);
    return await this.ensureBranched({
      ...input,
      baseRevision: input.deliveryHeadSha,
      role: 'DELIVERY_REPAIR',
      identity: input.repairId,
      relativePath: ['repairs', repairComponent, 'repo'],
      branchRef: this.planBranch(input.rootPlanId, 'repairs/' + repairComponent + '/head'),
    });
  }

  async createReview(input: ReviewWorktreeRequest): Promise<PlanWorktree> {
    await this.ensurePlanActivated(input.rootPlanId);
    this.assertActivePlan(input);
    const repositoryPath = await this.repositoryRoot(input.repositoryPath);
    await this.ensureProtectedRefSnapshot(input.rootPlanId);
    await this.assertProtectedRefsStable(input.rootPlanId);
    const reviewComponent = worktreeRefComponent(input.reviewId);
    const paths = this.paths(input.projectKey, input.rootPlanId, [
      'reviews',
      reviewComponent,
      'repo',
    ]);
    const id = worktreeId('REVIEW', input.rootPlanId, input.reviewId);
    await this.assertCommit(repositoryPath, input.reviewedSha);
    const record = this.repositories.planWorktrees.create({
      worktreeId: id,
      projectKey: input.projectKey,
      rootPlanId: input.rootPlanId,
      role: 'REVIEW',
      repositoryPath,
      hostPath: paths.hostPath,
      executionPath: paths.executionPath,
      baseRevision: input.reviewedSha,
    }).value!;
    if (record.state === 'REVIEWING' || record.state === 'QUIESCENT') {
      await this.verifyRegistered(record, input.reviewedSha, undefined, true);
      return record;
    }
    if (record.state !== 'PROVISIONING') throw new ForgeFlowError('WORKTREE_STATE_NOT_RECOVERABLE');
    await this.createPhysicalWorktree(record, input.reviewedSha, undefined, true);
    const current = this.repositories.planWorktrees.get(id);
    const transitioned = this.repositories.planWorktrees.transition(
      id,
      current.version,
      'REVIEWING',
    );
    if (!transitioned.value || transitioned.status === 'rejected')
      throw new ForgeFlowError(transitioned.reason ?? 'WORKTREE_STATE_STALE');
    return transitioned.value;
  }

  async prepareAgentAccess(
    worktreeIdValue: string,
    uid: number,
    gid: number,
  ): Promise<PlanWorktree> {
    failClosed(
      Number.isInteger(uid) && uid > 0 && Number.isInteger(gid) && gid > 0,
      'WORKTREE_AGENT_IDENTITY_INVALID',
    );
    const current = this.repositories.planWorktrees.get(worktreeIdValue);
    await this.ensurePlanActivated(current.rootPlanId);
    failClosed(current.role !== 'INTEGRATION', 'WORKTREE_INTEGRATION_CONTROLLER_ONLY');
    // A worker Git process may atomically replace admin files such as index. Restore
    // canonical source access before proving linkage, then re-grant bounded worker
    // access with source-continuity defaults for future replacements.
    await this.restoreWorktreeAdminSourceAccess(current);
    await this.restoreWorktreeRefSourceAccess(current);
    await this.verifyRegistered(
      current,
      current.currentRevision,
      current.branchRef,
      current.role === 'REVIEW',
    );
    return await this.grantAgentFilesystemAccess(current, uid, gid);
  }

  async prepareFinalizationInspection(
    worktreeIdValue: string,
    executionId: string,
    expectedSourceRevision: string,
  ): Promise<PlanWorktree> {
    failClosed(executionId.trim().length > 0, 'EXECUTION_ID_REQUIRED');
    failClosed(expectedSourceRevision.trim().length > 0, 'WORKTREE_CURRENT_REVISION_REQUIRED');
    const current = this.repositories.planWorktrees.get(worktreeIdValue);
    const rootPlan = this.repositories.plans.getPlan(current.rootPlanId);
    const execution = this.repositories.executions.get(executionId);
    failClosed(rootPlan.status === 'FAILED', 'WORKTREE_FINALIZATION_RECOVERY_PLAN_NOT_FAILED');
    failClosed(
      current.role === 'WORK_ITEM' || current.role === 'DELIVERY_REPAIR',
      'WORKTREE_FINALIZATION_RECOVERY_ROLE_INVALID',
    );
    failClosed(current.ownerExecutionId === executionId, 'WORKTREE_FINALIZATION_RECOVERY_OWNER_MISMATCH');
    failClosed(
      execution.status === 'FAILED' || execution.status === 'BLOCKED' || execution.status === 'CANCELLED',
      'WORKTREE_FINALIZATION_RECOVERY_EXECUTION_NOT_TERMINAL',
    );
    failClosed(
      execution.identity.sourceRevision === expectedSourceRevision,
      'WORKTREE_FINALIZATION_RECOVERY_SOURCE_MISMATCH',
    );
    failClosed(
      this.rootPlanIdFor(execution.identity.planId) === current.rootPlanId,
      'WORKTREE_FINALIZATION_RECOVERY_PLAN_MISMATCH',
    );
    await this.assertProtectedRefsStable(current.rootPlanId);
    await this.restoreWorktreeAdminSourceAccess(current);
    await this.restoreWorktreeRefSourceAccess(current);
    await this.verifyRegistered(current, undefined, current.branchRef, false);
    await this.initializePinnedSubmodules(current, true);
    await this.verifyRegistered(current, undefined, current.branchRef, false);
    return this.repositories.planWorktrees.get(current.worktreeId);
  }

  async prepareCancellationAccess(
    worktreeIdValue: string,
    executionId: string,
    uid: number,
    gid: number,
  ): Promise<PlanWorktree> {
    failClosed(executionId.trim().length > 0, 'EXECUTION_ID_REQUIRED');
    failClosed(
      Number.isInteger(uid) && uid > 0 && Number.isInteger(gid) && gid > 0,
      'WORKTREE_AGENT_IDENTITY_INVALID',
    );
    const current = this.repositories.planWorktrees.get(worktreeIdValue);
    const rootPlan = this.repositories.plans.getPlan(current.rootPlanId);
    const execution = this.repositories.executions.get(executionId);
    const executionPlan = this.repositories.plans.getPlan(execution.identity.planId);
    failClosed(
      this.rootPlanIdFor(executionPlan.planId) === current.rootPlanId,
      'WORKTREE_CANCEL_ACCESS_PLAN_MISMATCH',
    );
    if (current.ownerExecutionId)
      failClosed(
        current.ownerExecutionId === executionId,
        'WORKTREE_CANCEL_ACCESS_WRITER_MISMATCH',
      );
    else
      failClosed(
        rootPlan.status === 'SAFETY_HOLD' ||
          isTerminalPlanStatus(rootPlan.status) ||
          isTerminalPlanStatus(executionPlan.status),
        'WORKTREE_CANCEL_ACCESS_REQUIRES_TERMINAL_OR_SAFETY_HOLD',
      );
    failClosed(current.role !== 'INTEGRATION', 'WORKTREE_INTEGRATION_CONTROLLER_ONLY');
    // Cancellation may be the first controller operation after a worker-created
    // admin-file replacement. The ownership/terminal fence above proves which
    // durable execution may touch this worktree. An unaccepted candidate commit is
    // expected here, so prove canonical registry/branch/common-dir identity without
    // requiring HEAD to equal the durable accepted revision; abandonExecution owns
    // the later exact reset back to the execution source revision.
    await this.restoreWorktreeAdminSourceAccess(current);
    await this.restoreWorktreeRefSourceAccess(current);
    await this.verifyRegistered(current, undefined, current.branchRef, current.role === 'REVIEW');
    return await this.grantAgentFilesystemAccess(current, uid, gid);
  }

  private async grantAgentFilesystemAccess(
    current: PlanWorktree,
    uid: number,
    gid: number,
  ): Promise<PlanWorktree> {
    const submodulePaths = await this.verifyPinnedSubmodules(current);
    this.chownTreeNoFollow(current.hostPath, uid, gid);
    const common = await this.canonicalCommonDir(current.repositoryPath);
    const source = fs.statSync(common);
    const objects = path.join(common, 'objects');
    this.ensureObjectDirectories(objects, source.uid, source.gid);
    this.hardenSharedObjectDirectories(objects);
    if (source.uid !== uid) {
      failClosed(fs.existsSync(this.setfaclBinary), 'WORKTREE_ACL_TOOL_MISSING');
      const commonMode = fs.statSync(common).mode & 0o7777;
      fs.chmodSync(common, commonMode | 0o1000);
      await this.execAcl(['-m', `u:${uid}:rwx`, '--', common]);
      await this.grantObjectStoreAcl(objects, uid);
      const { admin } = this.worktreeGitfileIdentity(current, common);
      await this.grantTraverseAcl(common, admin, uid);
      await this.grantRecursiveAcl(admin, uid, source.uid);
      if (current.branchRef) {
        const plan = worktreeRefComponent(current.rootPlanId);
        const allowedPrefix = 'refs/heads/forgeflow/' + plan + '/';
        failClosed(
          current.branchRef.startsWith(allowedPrefix),
          'WORKTREE_BRANCH_NAMESPACE_INVALID',
        );
        const refPath = path.join(common, ...current.branchRef.split('/'));
        const refParent = path.dirname(refPath);
        failClosed(
          fs.existsSync(refPath) && fs.existsSync(refParent),
          'WORKTREE_PLAN_REF_NAMESPACE_MISSING',
        );
        await this.grantTraverseAcl(common, refParent, uid);
        await this.grantRecursiveAcl(refParent, uid, source.uid);
        const logPath = path.join(common, 'logs', ...current.branchRef.split('/'));
        const logParent = path.dirname(logPath);
        if (fs.existsSync(logParent)) {
          await this.grantTraverseAcl(common, logParent, uid);
          await this.grantRecursiveAcl(logParent, uid, source.uid);
        }
      }
    }
    await this.protectSubmoduleIdentities(
      current,
      submodulePaths,
      uid,
      common,
      source.uid,
      source.gid,
    );
    await this.protectWorktreeIdentity(current, uid, common, source.uid, source.gid);
    return this.repositories.planWorktrees.get(current.worktreeId);
  }

  async assertExecutionWorktreeLinked(worktreeIdValue: string): Promise<void> {
    const current = this.repositories.planWorktrees.get(worktreeIdValue);
    failClosed(current.role !== 'INTEGRATION', 'WORKTREE_INTEGRATION_CONTROLLER_ONLY');
    const common = await this.canonicalCommonDir(current.repositoryPath);
    this.worktreeGitfileIdentity(current, common);
    const listed = await this.worktreeAt(current.repositoryPath, current.hostPath);
    failClosed(Boolean(listed), 'WORKTREE_GIT_LINKAGE_VIOLATED');
    if (current.role === 'REVIEW')
      failClosed(listed!.detached && !listed!.branch, 'WORKTREE_GIT_LINKAGE_VIOLATED');
    else failClosed(listed!.branch === current.branchRef, 'WORKTREE_GIT_LINKAGE_VIOLATED');
  }

  async prepareWriterForExecution(
    worktreeIdValue: string,
    executionId: string,
    expectedRevision: string,
    uid: number,
    gid: number,
  ): Promise<PlanWorktree> {
    failClosed(expectedRevision.trim().length > 0, 'WORKTREE_CURRENT_REVISION_REQUIRED');
    let current = this.repositories.planWorktrees.get(worktreeIdValue);
    await this.ensurePlanActivated(current.rootPlanId);
    failClosed(
      current.role === 'WORK_ITEM' || current.role === 'DELIVERY_REPAIR',
      'WORKTREE_MODEL_WRITER_ROLE_INVALID',
    );
    await this.assertCommit(current.repositoryPath, expectedRevision);

    if (current.ownerExecutionId && current.ownerExecutionId !== executionId) {
      const previous = this.repositories.executions.get(current.ownerExecutionId);
      const terminalFailure =
        previous.status === 'FAILED' ||
        previous.status === 'BLOCKED' ||
        previous.status === 'CANCELLED';
      const exactSucceeded =
        previous.status === 'SUCCEEDED' && previous.resultRevision === expectedRevision;
      failClosed(terminalFailure || exactSucceeded, 'WORKTREE_PREVIOUS_WRITER_ACTIVE');
      await this.resetWorktreeToRevision(current, expectedRevision);
      const released = this.repositories.planWorktrees.releaseWriter(
        current.worktreeId,
        current.ownerExecutionId,
        current.version,
        expectedRevision,
      );
      if (!released.value || released.status === 'rejected')
        throw new ForgeFlowError(released.reason ?? 'WORKTREE_WRITER_RELEASE_FAILED');
      current = released.value;
    }

    if (current.ownerExecutionId === executionId) {
      await this.prepareAgentAccess(current.worktreeId, uid, gid);
      return this.repositories.planWorktrees.get(current.worktreeId);
    }

    const actualHead = await this.gitInWorktree(current.repositoryPath, current.hostPath, [
      'rev-parse',
      '--verify',
      'HEAD^{commit}',
    ]);
    if (actualHead !== expectedRevision) {
      failClosed(
        current.state === 'READY' || current.state === 'QUIESCENT',
        'WORKTREE_RETRY_STATE_INVALID',
      );
      await this.resetWorktreeToRevision(current, expectedRevision);
      current = this.repositories.planWorktrees.get(current.worktreeId);
      const updated = this.repositories.planWorktrees.updateRevision(
        current.worktreeId,
        current.version,
        expectedRevision,
      );
      if (!updated.value || updated.status === 'rejected')
        throw new ForgeFlowError(updated.reason ?? 'WORKTREE_REVISION_UPDATE_FAILED');
      current = updated.value;
    } else if (current.currentRevision !== expectedRevision) {
      const updated = this.repositories.planWorktrees.updateRevision(
        current.worktreeId,
        current.version,
        expectedRevision,
      );
      if (!updated.value || updated.status === 'rejected')
        throw new ForgeFlowError(updated.reason ?? 'WORKTREE_REVISION_UPDATE_FAILED');
      current = updated.value;
    }

    await this.prepareAgentAccess(current.worktreeId, uid, gid);
    return await this.attachWriter(current.worktreeId, executionId);
  }

  async integrateReviewedCandidate(input: {
    rootPlanId: string;
    workItemId: string;
    candidateRevision: string;
    expectedPlanRevision: string;
    integrationBaseRevision: string;
  }): Promise<{ worktree: PlanWorktree; headRevision: string }> {
    const plan = this.repositories.plans.getPlan(input.rootPlanId);
    await this.assertProtectedRefsStable(plan.planId);
    const item = this.repositories.plans.getWorkItem(input.workItemId);
    failClosed(this.rootPlanIdFor(item.planId) === plan.planId, 'WORKTREE_WORK_ITEM_PLAN_MISMATCH');
    failClosed(
      item.integrationBaseRevision === input.integrationBaseRevision,
      'WORK_ITEM_WAVE_PROVENANCE_MISMATCH',
    );
    failClosed(
      plan.currentRevision === input.expectedPlanRevision,
      'WORKTREE_INTEGRATION_STALE_HEAD',
    );
    await this.assertCommit(plan.repositoryPath, input.candidateRevision);
    await this.assertCommit(plan.repositoryPath, input.integrationBaseRevision);
    const candidate = this.repositories.planWorktrees.findForWorkItem(plan.planId, item.workItemId);
    failClosed(Boolean(candidate), 'WORKTREE_CANDIDATE_MISSING');
    failClosed(!candidate!.ownerExecutionId, 'WORKTREE_WRITER_HELD');
    const candidateHead = await this.gitInWorktree(plan.repositoryPath, candidate!.hostPath, [
      'rev-parse',
      '--verify',
      'HEAD^{commit}',
    ]);
    failClosed(candidateHead === input.candidateRevision, 'WORKTREE_ACCEPTED_REVISION_NOT_PINNED');
    failClosed(
      (await this.gitStatus(plan.repositoryPath, candidate!.hostPath)).length === 0,
      'WORKTREE_ACCEPTED_REVISION_DIRTY',
    );
    failClosed(
      await this.gitSucceeds(plan.repositoryPath, [
        'merge-base',
        '--is-ancestor',
        input.integrationBaseRevision,
        input.candidateRevision,
      ]),
      'WORKTREE_ACCEPTED_REVISION_NOT_DESCENDANT',
    );

    const existingIntegration = this.repositories.planWorktrees
      .listByPlan(plan.planId)
      .find((record) => record.role === 'INTEGRATION' && record.state !== 'RETIRED');
    let integration = await this.ensureIntegration({
      projectKey: plan.projectKey,
      rootPlanId: plan.planId,
      repositoryPath: plan.repositoryPath,
      baseRevision: existingIntegration?.baseRevision ?? input.expectedPlanRevision,
    });
    failClosed(!integration.ownerExecutionId, 'WORKTREE_INTEGRATION_CONTROLLER_ONLY');
    const status = await this.gitStatus(plan.repositoryPath, integration.hostPath);
    failClosed(status.length === 0, 'WORKTREE_INTEGRATION_DIRTY');
    const before = await this.gitInWorktree(plan.repositoryPath, integration.hostPath, [
      'rev-parse',
      '--verify',
      'HEAD^{commit}',
    ]);
    failClosed(before === input.expectedPlanRevision, 'WORKTREE_INTEGRATION_STALE_HEAD');
    if (
      await this.gitSucceedsInWorktree(plan.repositoryPath, integration.hostPath, [
        'merge-base',
        '--is-ancestor',
        input.candidateRevision,
        before,
      ])
    ) {
      return { worktree: integration, headRevision: before };
    }

    try {
      await this.gitAsSourceInWorktree(plan.repositoryPath, integration.hostPath, [
        '-c',
        'user.name=ForgeFlow Controller',
        '-c',
        'user.email=forgeflow@localhost',
        'merge',
        '--no-ff',
        '--no-edit',
        '-m',
        'chore(forgeflow): integrate ' + worktreeRefComponent(item.itemKey),
        input.candidateRevision,
      ]);
    } catch (error) {
      await this.gitAsSourceInWorktree(
        plan.repositoryPath,
        integration.hostPath,
        ['merge', '--abort'],
        true,
      );
      throw new ForgeFlowError(
        'WORKTREE_INTEGRATION_CONFLICT',
        'Reviewed work-item integration conflicted.',
        error,
      );
    }
    failClosed(
      (await this.gitStatus(plan.repositoryPath, integration.hostPath)).length === 0,
      'WORKTREE_INTEGRATION_DIRTY',
    );
    const headRevision = await this.gitInWorktree(plan.repositoryPath, integration.hostPath, [
      'rev-parse',
      '--verify',
      'HEAD^{commit}',
    ]);
    integration = this.repositories.planWorktrees.get(integration.worktreeId);
    const updated = this.repositories.planWorktrees.updateRevision(
      integration.worktreeId,
      integration.version,
      headRevision,
    );
    if (!updated.value || updated.status === 'rejected')
      throw new ForgeFlowError(updated.reason ?? 'WORKTREE_REVISION_UPDATE_FAILED');
    return { worktree: updated.value, headRevision };
  }

  async revokePlanAgentAccess(rootPlanId: string, uid: number): Promise<void> {
    const records = this.repositories.planWorktrees.listByPlan(rootPlanId);
    failClosed(records.length > 0, 'WORKTREE_PLAN_REGISTRY_EMPTY');
    failClosed(
      records.every((record) => record.state === 'RETIRED'),
      'WORKTREE_PLAN_STILL_ACTIVE',
    );
    const repositoryPath = records[0]!.repositoryPath;
    failClosed(
      records.every((record) => record.repositoryPath === repositoryPath),
      'WORKTREE_REPOSITORY_MISMATCH',
    );
    const common = await this.canonicalCommonDir(repositoryPath);
    const source = fs.statSync(common);
    if (source.uid === uid || !fs.existsSync(this.setfaclBinary)) return;
    await this.execAcl(['-x', `u:${uid}`, '--', common], true);
    await this.revokeObjectStoreAcl(path.join(common, 'objects'), uid);
    for (const candidate of [
      path.join(common, 'worktrees'),
      path.join(common, 'refs'),
      path.join(common, 'refs', 'heads'),
      path.join(common, 'refs', 'heads', 'forgeflow'),
      path.join(common, 'logs'),
      path.join(common, 'logs', 'refs'),
      path.join(common, 'logs', 'refs', 'heads'),
      path.join(common, 'logs', 'refs', 'heads', 'forgeflow'),
    ]) {
      if (fs.existsSync(candidate)) await this.execAcl(['-x', `u:${uid}`, '--', candidate], true);
    }
    const plan = worktreeRefComponent(rootPlanId);
    for (const candidate of [
      path.join(common, 'refs', 'heads', 'forgeflow', plan),
      path.join(common, 'logs', 'refs', 'heads', 'forgeflow', plan),
    ]) {
      if (fs.existsSync(candidate)) await this.revokeRecursiveAcl(candidate, uid);
    }
  }

  async attachWriter(worktreeIdValue: string, executionId: string): Promise<PlanWorktree> {
    const current = this.repositories.planWorktrees.get(worktreeIdValue);
    failClosed(
      current.role !== 'REVIEW' && current.role !== 'INTEGRATION',
      'WORKTREE_MODEL_WRITER_ROLE_INVALID',
    );
    await this.verifyRegistered(current, current.currentRevision, current.branchRef, false);
    const status = await this.gitStatus(current.repositoryPath, current.hostPath);
    failClosed(status.length === 0, 'WORKTREE_DIRTY_BEFORE_WRITER');
    const result = this.repositories.planWorktrees.attachWriter(
      worktreeIdValue,
      executionId,
      current.version,
    );
    if (!result.value || result.status === 'rejected')
      throw new ForgeFlowError(result.reason ?? 'WORKTREE_WRITER_ATTACH_FAILED');
    return result.value;
  }

  async releaseWriter(worktreeIdValue: string, executionId: string): Promise<PlanWorktree> {
    const current = this.repositories.planWorktrees.get(worktreeIdValue);
    await this.assertProtectedRefsStable(current.rootPlanId);
    failClosed(current.ownerExecutionId === executionId, 'WORKTREE_WRITER_OWNER_MISMATCH');
    const head = await this.gitInWorktree(current.repositoryPath, current.hostPath, [
      'rev-parse',
      '--verify',
      'HEAD^{commit}',
    ]);
    const status = await this.gitStatus(current.repositoryPath, current.hostPath);
    failClosed(status.length === 0, 'WORKTREE_DIRTY_ON_RELEASE');
    const result = this.repositories.planWorktrees.releaseWriter(
      worktreeIdValue,
      executionId,
      current.version,
      head,
    );
    if (!result.value || result.status === 'rejected')
      throw new ForgeFlowError(result.reason ?? 'WORKTREE_WRITER_RELEASE_FAILED');
    return result.value;
  }

  async abandonExecutionWorktree(
    worktreeIdValue: string,
    executionId: string,
    expectedRevision: string,
  ): Promise<PlanWorktree> {
    failClosed(expectedRevision.trim().length > 0, 'WORKTREE_CURRENT_REVISION_REQUIRED');
    let current = this.repositories.planWorktrees.get(worktreeIdValue);
    await this.assertProtectedRefsStable(current.rootPlanId);
    await this.assertCommit(current.repositoryPath, expectedRevision);

    if (current.role === 'REVIEW') {
      failClosed(!current.ownerExecutionId, 'WORKTREE_REVIEW_WRITER_FORBIDDEN');
      await this.resetWorktreeToRevision(current, expectedRevision);
      current = this.repositories.planWorktrees.get(worktreeIdValue);
      if (current.state === 'REVIEWING') {
        const transitioned = this.repositories.planWorktrees.transition(
          worktreeIdValue,
          current.version,
          'QUIESCENT',
        );
        if (!transitioned.value || transitioned.status === 'rejected')
          throw new ForgeFlowError(transitioned.reason ?? 'WORKTREE_STATE_STALE');
        return transitioned.value;
      }
      failClosed(
        current.state === 'QUIESCENT' || current.state === 'RETIRED',
        'WORKTREE_REVIEW_CANCEL_STATE_INVALID',
      );
      return current;
    }

    failClosed(
      current.role === 'WORK_ITEM' || current.role === 'DELIVERY_REPAIR',
      'WORKTREE_CANCEL_ROLE_INVALID',
    );
    if (!current.ownerExecutionId) return current;
    failClosed(current.ownerExecutionId === executionId, 'WORKTREE_WRITER_OWNER_MISMATCH');
    await this.resetWorktreeToRevision(current, expectedRevision);
    current = this.repositories.planWorktrees.get(worktreeIdValue);
    const released = this.repositories.planWorktrees.releaseWriter(
      worktreeIdValue,
      executionId,
      current.version,
      expectedRevision,
    );
    if (!released.value || released.status === 'rejected')
      throw new ForgeFlowError(released.reason ?? 'WORKTREE_WRITER_RELEASE_FAILED');
    return released.value;
  }

  async markIntegrated(worktreeIdValue: string): Promise<PlanWorktree> {
    const current = this.repositories.planWorktrees.get(worktreeIdValue);
    failClosed(!current.ownerExecutionId, 'WORKTREE_WRITER_HELD');
    const next =
      current.state === 'READY' || current.state === 'QUIESCENT' ? 'INTEGRATED' : current.state;
    if (next === current.state) return current;
    const result = this.repositories.planWorktrees.transition(
      worktreeIdValue,
      current.version,
      next,
    );
    if (!result.value || result.status === 'rejected')
      throw new ForgeFlowError(result.reason ?? 'WORKTREE_STATE_STALE');
    return result.value;
  }

  async retire(worktreeIdValue: string): Promise<PlanWorktree> {
    let current = this.repositories.planWorktrees.get(worktreeIdValue);
    await this.assertProtectedRefsStable(current.rootPlanId);
    failClosed(!current.ownerExecutionId, 'WORKTREE_WRITER_HELD');
    if (current.state === 'RETIRED') return current;
    const listed = await this.worktreeAt(current.repositoryPath, current.hostPath);
    if (listed) {
      try {
        await this.restoreWorktreeAdminSourceAccess(current);
      } catch (error) {
        if (!(error instanceof ForgeFlowError) || error.code !== 'WORKTREE_GIT_LINKAGE_VIOLATED')
          throw error;
        await this.rebuildCorruptedWorktree(current, current.currentRevision);
      }
      await this.verifyRegistered(
        current,
        current.currentRevision,
        current.branchRef,
        current.role === 'REVIEW',
        false,
      );
      failClosed(
        (await this.gitStatus(current.repositoryPath, current.hostPath)).length === 0,
        'WORKTREE_DIRTY_ON_RETIRE',
      );
      const sourceIdentity = this.repositoryIdentity(current.repositoryPath);
      if (fs.existsSync(current.hostPath))
        this.chownTreeNoFollow(current.hostPath, sourceIdentity.uid, sourceIdentity.gid);
      await this.git(current.repositoryPath, ['worktree', 'unlock', '--', current.hostPath], true);
      await this.git(current.repositoryPath, ['worktree', 'remove', '--force', '--', current.hostPath]);
      await this.git(current.repositoryPath, ['worktree', 'prune', '--expire', 'now']);
      failClosed(!fs.existsSync(current.hostPath), 'WORKTREE_REMOVE_INCOMPLETE');
    } else {
      if (current.state === 'PROVISIONING' && fs.existsSync(current.hostPath)) {
        const recovered = await this.removeRecoverableProvisioningResidue(
          current,
          current.currentRevision,
          current.branchRef,
        );
        failClosed(recovered, 'WORKTREE_REGISTRY_FILESYSTEM_MISSING');
      }
      failClosed(
        current.state === 'PROVISIONING' && !fs.existsSync(current.hostPath),
        'WORKTREE_REGISTRY_FILESYSTEM_MISSING',
      );
    }
    const parent = path.dirname(current.hostPath);
    for (const runtimeState of ['.agent-harness', '.executions', '.forgeflow-controller']) {
      const candidate = path.join(parent, runtimeState);
      if (fs.existsSync(candidate)) fs.rmSync(candidate, { recursive: true, force: true });
    }
    current = this.repositories.planWorktrees.get(worktreeIdValue);
    if (current.state === 'PROVISIONING') {
      const failed = this.repositories.planWorktrees.transition(
        worktreeIdValue,
        current.version,
        'FAILED',
      );
      if (!failed.value || failed.status === 'rejected')
        throw new ForgeFlowError(failed.reason ?? 'WORKTREE_STATE_STALE');
      current = failed.value;
    }
    const result = this.repositories.planWorktrees.transition(
      worktreeIdValue,
      current.version,
      'RETIRED',
    );
    if (!result.value || result.status === 'rejected')
      throw new ForgeFlowError(result.reason ?? 'WORKTREE_STATE_STALE');
    return result.value;
  }

  async reconcile(rootPlanId: string): Promise<PlanWorktree[]> {
    await this.assertProtectedRefsStable(rootPlanId);
    const records = this.repositories.planWorktrees.listByPlan(rootPlanId);
    for (const record of records) {
      if (record.state === 'RETIRED') continue;
      await this.verifyRegistered(
        record,
        record.currentRevision,
        record.branchRef,
        record.role === 'REVIEW',
      );
    }
    return records;
  }

  private async ensureBranched(
    input: WorktreeRequest & {
      role: Exclude<PlanWorktreeRole, 'REVIEW'>;
      identity: string;
      workItemId?: string;
      relativePath: string[];
      branchRef: string;
    },
  ): Promise<PlanWorktree> {
    this.assertActivePlan(input);
    const repositoryPath = await this.repositoryRoot(input.repositoryPath);
    await this.ensureProtectedRefSnapshot(input.rootPlanId);
    await this.assertProtectedRefsStable(input.rootPlanId);
    await this.assertCommit(repositoryPath, input.baseRevision);
    const paths = this.paths(input.projectKey, input.rootPlanId, input.relativePath);
    const id = worktreeId(input.role, input.rootPlanId, input.identity);
    const existingByPath = this.repositories.planWorktrees.findByPath(paths.hostPath);
    if (existingByPath && existingByPath.worktreeId !== id)
      throw new ForgeFlowError('WORKTREE_PATH_CONFLICT');
    const result = this.repositories.planWorktrees.create({
      worktreeId: id,
      projectKey: input.projectKey,
      rootPlanId: input.rootPlanId,
      ...(input.workItemId ? { workItemId: input.workItemId } : {}),
      role: input.role,
      repositoryPath,
      hostPath: paths.hostPath,
      executionPath: paths.executionPath,
      branchRef: input.branchRef,
      baseRevision: input.baseRevision,
    });
    const record = result.value!;
    if (record.state === 'READY' || record.state === 'QUIESCENT' || record.state === 'INTEGRATED') {
      await this.verifyRegistered(record, record.currentRevision, record.branchRef, false);
      return record;
    }
    if (record.state === 'WRITER_ATTACHED') {
      await this.verifyRegistered(record, record.currentRevision, record.branchRef, false);
      return record;
    }
    if (record.state !== 'PROVISIONING') throw new ForgeFlowError('WORKTREE_STATE_NOT_RECOVERABLE');
    await this.createPhysicalWorktree(record, input.baseRevision, input.branchRef, false);
    const current = this.repositories.planWorktrees.get(id);
    const transitioned = this.repositories.planWorktrees.transition(id, current.version, 'READY');
    if (!transitioned.value || transitioned.status === 'rejected')
      throw new ForgeFlowError(transitioned.reason ?? 'WORKTREE_STATE_STALE');
    return transitioned.value;
  }

  private async ensureProtectedRefSnapshot(rootPlanId: string): Promise<void> {
    const existing = this.repositories.planWorktrees.getProtectedRefs(rootPlanId);
    if (existing.length > 0) return;
    const entries = await this.currentProtectedRefs(rootPlanId);
    this.repositories.planWorktrees.createProtectedRefs(rootPlanId, entries);
  }

  private async assertProtectedRefsStable(rootPlanId: string): Promise<void> {
    const plan = this.repositories.plans.getPlan(rootPlanId);
    const canonicalStatus = await this.git(plan.repositoryPath, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]);
    if (canonicalStatus.length > 0) {
      this.enterSafetyHold(rootPlanId);
      throw new ForgeFlowError(
        'WORKTREE_CANONICAL_REPOSITORY_DIRTY',
        'Canonical repository changed while a literal-worktree Plan owns the project.',
      );
    }
    const expected = this.repositories.planWorktrees
      .getProtectedRefs(rootPlanId)
      .map(({ refName, revision }) => ({ refName, revision }));
    failClosed(expected.length > 0, 'WORKTREE_PROTECTED_REF_SNAPSHOT_MISSING');
    const actual = await this.currentProtectedRefs(rootPlanId);
    if (JSON.stringify(expected) === JSON.stringify(actual)) return;
    this.enterSafetyHold(rootPlanId);
    throw new ForgeFlowError(
      'WORKTREE_PROTECTED_REF_DRIFT',
      'Protected Git refs changed outside the active ForgeFlow Plan namespace.',
    );
  }

  private recordActivationFailure(
    rootPlanId: string,
    errorCode: string,
    disposition: 'SYSTEM_REPAIR' | 'SAFETY_HOLD',
  ): void {
    try {
      this.repositories.events.appendNew({
        aggregateId: rootPlanId,
        aggregateType: 'PLAN',
        type: 'PLAN_ACTIVATION_FAILED',
        payload: { errorCode, disposition },
        occurredAt: new Date().toISOString(),
        correlationId: rootPlanId,
      });
    } catch {
      // Preserve the primary activation failure even if audit persistence is unavailable.
    }
  }

  private enterSystemRepairWait(rootPlanId: string): void {
    const plan = this.repositories.plans.getPlan(rootPlanId);
    if (plan.status === 'WAITING_FOR_SYSTEM_REPAIR') return;
    if (
      plan.status === 'READY' ||
      plan.status === 'RUNNING' ||
      plan.status === 'WAITING_FOR_RESOURCE' ||
      plan.status === 'WAITING_FOR_EXTERNAL_EVIDENCE'
    ) {
      try {
        this.repositories.plans.updateStatus(rootPlanId, 'WAITING_FOR_SYSTEM_REPAIR');
      } catch {
        // Preserve the primary infrastructure activation failure.
      }
    }
  }

  private recoverActivationWait(rootPlanId: string): void {
    const plan = this.repositories.plans.getPlan(rootPlanId);
    if (plan.status !== 'WAITING_FOR_SYSTEM_REPAIR') return;
    const hasNonTerminalChild = plan.childPlanIds.some((childPlanId) =>
      !isTerminalPlanStatus(this.repositories.plans.getPlan(childPlanId).status),
    );
    if (hasNonTerminalChild) return;
    try {
      this.repositories.plans.updateStatus(rootPlanId, 'READY');
      this.repositories.events.appendNew({
        aggregateId: rootPlanId,
        aggregateType: 'PLAN',
        type: 'PLAN_ACTIVATION_RECOVERED',
        payload: { disposition: 'SYSTEM_REPAIR' },
        occurredAt: new Date().toISOString(),
        correlationId: rootPlanId,
      });
    } catch {
      // Keep the Plan parked if recovery cannot be durably recorded.
    }
  }

  private enterSafetyHold(rootPlanId: string): void {
    const plan = this.repositories.plans.getPlan(rootPlanId);
    if (
      plan.status === 'READY' ||
      plan.status === 'RUNNING' ||
      plan.status === 'WAITING_FOR_RESOURCE' ||
      plan.status === 'WAITING_FOR_SYSTEM_REPAIR' ||
      plan.status === 'WAITING_FOR_EXTERNAL_EVIDENCE'
    ) {
      try {
        this.repositories.plans.updateStatus(rootPlanId, 'SAFETY_HOLD');
      } catch {
        // Preserve the primary repository safety violation.
      }
    }
  }

  private async archivePlanFamilyRefs(rootPlanId: string): Promise<void> {
    const queue = [rootPlanId];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const planId = queue.shift()!;
      if (visited.has(planId)) throw new ForgeFlowError('PARENT_CHILD_CYCLE');
      visited.add(planId);
      const plan = this.repositories.plans.getPlan(planId);
      queue.push(...plan.childPlanIds);
      await this.assertCommit(plan.repositoryPath, plan.currentRevision);
      const archiveRef = 'refs/forgeflow/archive/' + worktreeRefComponent(plan.planId);
      const existing = await this.git(
        plan.repositoryPath,
        ['rev-parse', '--verify', archiveRef + '^{commit}'],
        true,
      );
      if (existing) {
        failClosed(existing === plan.currentRevision, 'WORKTREE_ARCHIVE_REF_CONFLICT');
      } else {
        await this.git(plan.repositoryPath, ['update-ref', archiveRef, plan.currentRevision]);
      }
    }
  }

  private async currentProtectedRefs(
    rootPlanId: string,
  ): Promise<Array<{ refName: string; revision: string }>> {
    const plan = this.repositories.plans.getPlan(rootPlanId);
    failClosed(!plan.parentPlanId, 'WORKTREE_ROOT_PLAN_REQUIRED');
    const planPrefix = 'refs/heads/forgeflow/' + worktreeRefComponent(rootPlanId) + '/';
    const deliveryRef = plan.delivery?.branch
      ? plan.delivery.branch.startsWith('refs/heads/')
        ? plan.delivery.branch
        : 'refs/heads/' + plan.delivery.branch
      : undefined;
    const raw = await this.git(plan.repositoryPath, [
      'for-each-ref',
      '--format=%(refname)%09%(objectname)',
      'refs/heads',
      'refs/tags',
    ]);
    const entries: Array<{ refName: string; revision: string }> = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue;
      const separator = line.indexOf('\t');
      failClosed(separator > 0, 'WORKTREE_PROTECTED_REF_SNAPSHOT_INVALID');
      const refName = line.slice(0, separator);
      const revision = line.slice(separator + 1);
      if (refName.startsWith(planPrefix) || refName === deliveryRef) continue;
      entries.push({ refName, revision });
    }
    const head = await this.git(plan.repositoryPath, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const symref = await this.git(plan.repositoryPath, ['symbolic-ref', '--quiet', 'HEAD'], true);
    entries.push({ refName: '@HEAD', revision: head });
    entries.push({ refName: '@HEAD_SYMREF', revision: symref || '<DETACHED>' });
    return entries.sort((left, right) => left.refName.localeCompare(right.refName));
  }

  private rootPlanIdFor(planId: string): string {
    let plan = this.repositories.plans.getPlan(planId);
    const visited = new Set<string>();
    while (plan.parentPlanId) {
      if (visited.has(plan.planId)) throw new ForgeFlowError('PARENT_CHILD_CYCLE');
      visited.add(plan.planId);
      plan = this.repositories.plans.getPlan(plan.parentPlanId);
    }
    return plan.planId;
  }

  private assertActivePlan(input: WorktreeRequest): void {
    const plan = this.repositories.plans.getPlan(input.rootPlanId);
    failClosed(!plan.parentPlanId, 'WORKTREE_ROOT_PLAN_REQUIRED');
    failClosed(plan.projectKey === input.projectKey, 'WORKTREE_PROJECT_MISMATCH');
    const lease = this.repositories.projectPlans.getLease(input.projectKey);
    failClosed(lease?.activeRootPlanId === input.rootPlanId, 'WORKTREE_ACTIVE_PLAN_REQUIRED');
    failClosed(lease.repositoryPath === plan.repositoryPath, 'WORKTREE_REPOSITORY_MISMATCH');
  }

  private async repositoryRoot(repositoryPath: string): Promise<string> {
    const resolved = fs.realpathSync(repositoryPath);
    failClosed(
      this.allowedRepositoryRoots.some((root) => inside(resolved, root)),
      'WORKTREE_REPOSITORY_NOT_ALLOWED',
    );
    const root = await this.git(resolved, ['rev-parse', '--show-toplevel']);
    const canonical = fs.realpathSync(root);
    failClosed(canonical === resolved, 'WORKTREE_REPOSITORY_ROOT_MISMATCH');
    return canonical;
  }

  private async assertCommit(repositoryPath: string, revision: string): Promise<void> {
    failClosed(revision.trim().length > 0 && revision.length <= 200, 'WORKTREE_REVISION_REQUIRED');
    if (!(await this.gitSucceeds(repositoryPath, ['cat-file', '-e', revision + '^{commit}'])))
      throw new ForgeFlowError('WORKTREE_REVISION_MISSING', 'Git revision is unavailable.');
  }

  private paths(projectKey: string, rootPlanId: string, relativePath: string[]) {
    const project = worktreeRefComponent(projectKey);
    const plan = worktreeRefComponent(rootPlanId);
    const relative = ['forgeflow', 'plans', project, plan, ...relativePath];
    const hostPath = path.join(this.managedHostRoot, ...relative);
    const executionPath = path.posix.join(this.executionRoot, ...relative);
    failClosed(inside(hostPath, this.managedHostRoot), 'WORKTREE_PATH_NOT_ALLOWED');
    return { hostPath, executionPath };
  }

  private planBranch(rootPlanId: string, suffix: string): string {
    return 'refs/heads/forgeflow/' + worktreeRefComponent(rootPlanId) + '/' + suffix;
  }

  private async createPhysicalWorktree(
    record: PlanWorktree,
    revision: string,
    branchRef: string | undefined,
    detached: boolean,
  ): Promise<void> {
    await this.ensurePlanDirectory(record);
    const listed = await this.worktreeAt(record.repositoryPath, record.hostPath);
    if (listed) {
      await this.verifyRegistered(record, revision, branchRef, detached);
      await this.initializePinnedSubmodules(record, false);
      return;
    }
    if (fs.existsSync(record.hostPath)) {
      const recovered = await this.removeRecoverableProvisioningResidue(
        record,
        revision,
        branchRef,
      );
      if (!recovered) throw new ForgeFlowError('WORKTREE_UNKNOWN_PATH_RESIDUE');
    }
    if (branchRef) {
      const branchExists = await this.gitSucceeds(record.repositoryPath, [
        'show-ref',
        '--verify',
        '--quiet',
        branchRef,
      ]);
      const shortBranch = branchRef.replace(/^refs\/heads\//, '');
      if (branchExists) {
        const branchHead = await this.git(record.repositoryPath, [
          'rev-parse',
          '--verify',
          branchRef + '^{commit}',
        ]);
        failClosed(branchHead === revision, 'WORKTREE_BRANCH_BASE_CONFLICT');
        await this.git(record.repositoryPath, [
          'worktree',
          'add',
          '--lock',
          '--reason',
          'forgeflow:' + record.worktreeId,
          '--',
          record.hostPath,
          shortBranch,
        ]);
      } else {
        await this.git(record.repositoryPath, [
          'worktree',
          'add',
          '--lock',
          '--reason',
          'forgeflow:' + record.worktreeId,
          '-b',
          shortBranch,
          '--',
          record.hostPath,
          revision,
        ]);
      }
    } else {
      await this.git(record.repositoryPath, [
        'worktree',
        'add',
        '--lock',
        '--reason',
        'forgeflow:' + record.worktreeId,
        '--detach',
        '--',
        record.hostPath,
        revision,
      ]);
    }
    await this.initializePinnedSubmodules(record, false);
    await this.verifyRegistered(record, revision, branchRef, detached);
  }

  private async removeRecoverableProvisioningResidue(
    record: PlanWorktree,
    revision: string,
    branchRef: string | undefined,
  ): Promise<boolean> {
    if (record.state !== 'PROVISIONING' || !branchRef || !fs.existsSync(record.hostPath))
      return false;
    const stat = fs.lstatSync(record.hostPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const source = this.repositoryIdentity(record.repositoryPath);
    if (stat.uid !== source.uid || stat.gid !== source.gid) return false;
    if (fs.readdirSync(record.hostPath).length !== 0) return false;
    const branchExists = await this.gitSucceeds(record.repositoryPath, [
      'show-ref',
      '--verify',
      '--quiet',
      branchRef,
    ]);
    if (!branchExists) return false;
    const branchHead = await this.git(record.repositoryPath, [
      'rev-parse',
      '--verify',
      branchRef + '^{commit}',
    ]);
    if (branchHead !== revision) return false;
    fs.rmdirSync(record.hostPath);
    await this.git(record.repositoryPath, ['worktree', 'prune', '--expire', 'now']);
    return true;
  }

  private async ensurePlanDirectory(record: PlanWorktree): Promise<void> {
    this.ensureManagedPlanParents(record);
    const roleRoot = path.dirname(record.hostPath);
    fs.mkdirSync(roleRoot, { recursive: true, mode: 0o755 });
    const identity = this.repositoryIdentity(record.repositoryPath);
    const stat = fs.lstatSync(roleRoot);
    failClosed(stat.isDirectory() && !stat.isSymbolicLink(), 'WORKTREE_PARENT_UNSAFE');
    fs.chownSync(roleRoot, identity.uid, identity.gid);
    fs.chmodSync(roleRoot, 0o755);
  }

  private ensureManagedPlanParents(record: PlanWorktree): void {
    const managerUid = process.getuid?.();
    const managerGid = process.getgid?.();
    const project = worktreeRefComponent(record.projectKey);
    const plan = worktreeRefComponent(record.rootPlanId);
    const planRoot = path.join(this.managedHostRoot, 'forgeflow', 'plans', project, plan);
    const roleRoot = path.dirname(record.hostPath);
    failClosed(roleRoot === planRoot || inside(roleRoot, planRoot), 'WORKTREE_PARENT_UNSAFE');
    const directories = [
      path.join(this.managedHostRoot, 'forgeflow'),
      path.join(this.managedHostRoot, 'forgeflow', 'plans'),
      path.join(this.managedHostRoot, 'forgeflow', 'plans', project),
      planRoot,
    ];
    const roleNamespace = path.relative(planRoot, roleRoot).split(path.sep).filter(Boolean);
    let namespaceParent = planRoot;
    for (const component of roleNamespace.slice(0, -1)) {
      namespaceParent = path.join(namespaceParent, component);
      directories.push(namespaceParent);
    }
    for (const directory of directories) {
      failClosed(inside(directory, this.managedHostRoot), 'WORKTREE_PARENT_UNSAFE');
      fs.mkdirSync(directory, { recursive: true, mode: 0o711 });
      const stat = fs.lstatSync(directory);
      failClosed(stat.isDirectory() && !stat.isSymbolicLink(), 'WORKTREE_PARENT_UNSAFE');
      if (
        managerUid !== undefined &&
        managerGid !== undefined &&
        (stat.uid !== managerUid || stat.gid !== managerGid)
      ) {
        if (managerUid !== 0) throw new ForgeFlowError('WORKTREE_MANAGED_PARENT_OWNER_INVALID');
        fs.chownSync(directory, managerUid, managerGid);
      }
      fs.chmodSync(directory, 0o711);
    }
  }

  private async verifyRegistered(
    record: PlanWorktree,
    expectedHead: string | undefined,
    expectedBranch: string | undefined,
    detached: boolean,
    requireLock = true,
  ): Promise<void> {
    const listed = await this.worktreeAt(record.repositoryPath, record.hostPath);
    failClosed(Boolean(listed), 'WORKTREE_REGISTRY_FILESYSTEM_MISSING');
    if (expectedHead !== undefined)
      failClosed(listed!.head === expectedHead, 'WORKTREE_HEAD_MISMATCH');
    if (detached) failClosed(listed!.detached && !listed!.branch, 'WORKTREE_REVIEW_NOT_DETACHED');
    else failClosed(listed!.branch === expectedBranch, 'WORKTREE_BRANCH_MISMATCH');
    if (requireLock)
      failClosed(
        listed!.lockedReason === 'forgeflow:' + record.worktreeId,
        'WORKTREE_LOCK_MISMATCH',
      );
    const common = await this.gitInWorktree(record.repositoryPath, record.hostPath, [
      'rev-parse',
      '--git-common-dir',
    ]);
    const canonicalCommon = await this.git(record.repositoryPath, [
      'rev-parse',
      '--git-common-dir',
    ]);
    const commonReal = fs.realpathSync(
      path.isAbsolute(common) ? common : path.resolve(record.hostPath, common),
    );
    const canonicalReal = fs.realpathSync(
      path.isAbsolute(canonicalCommon)
        ? canonicalCommon
        : path.resolve(record.repositoryPath, canonicalCommon),
    );
    failClosed(commonReal === canonicalReal, 'WORKTREE_COMMON_DIR_MISMATCH');
  }

  private async worktreeAt(
    repositoryPath: string,
    targetPath: string,
  ): Promise<GitWorktreeRecord | undefined> {
    const output = await this.git(repositoryPath, ['worktree', 'list', '--porcelain']);
    const records = parseWorktreeList(output);
    const target = path.resolve(targetPath);
    return records.find((item) => path.resolve(item.path) === target);
  }

  private async canonicalCommonDir(repositoryPath: string): Promise<string> {
    const raw = await this.git(repositoryPath, ['rev-parse', '--git-common-dir']);
    const resolved = fs.realpathSync(
      path.isAbsolute(raw) ? raw : path.resolve(repositoryPath, raw),
    );
    failClosed(
      this.allowedRepositoryRoots.some((root) => inside(resolved, root)) &&
        path.basename(resolved) === '.git',
      'WORKTREE_COMMON_DIR_UNSAFE',
    );
    return resolved;
  }

  private ensureObjectDirectories(objects: string, uid: number, gid: number): void {
    failClosed(
      fs.existsSync(objects) && fs.lstatSync(objects).isDirectory(),
      'WORKTREE_OBJECT_STORE_UNSAFE',
    );
    for (let value = 0; value < 256; value += 1) {
      const directory = path.join(objects, value.toString(16).padStart(2, '0'));
      if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { mode: 0o775 });
        fs.chownSync(directory, uid, gid);
        fs.chmodSync(directory, 0o775);
      } else {
        const stat = fs.lstatSync(directory);
        failClosed(stat.isDirectory() && !stat.isSymbolicLink(), 'WORKTREE_OBJECT_STORE_UNSAFE');
      }
    }
  }

  private hardenSharedObjectDirectories(objects: string): void {
    for (const directory of this.objectDirectories(objects)) {
      const stat = fs.lstatSync(directory);
      const mode = stat.mode & 0o7777;
      if ((mode & 0o1000) === 0) fs.chmodSync(directory, mode | 0o1000);
    }
  }

  private objectDirectories(objects: string): string[] {
    const result: string[] = [];
    const visit = (directory: string): void => {
      const stat = fs.lstatSync(directory);
      failClosed(stat.isDirectory() && !stat.isSymbolicLink(), 'WORKTREE_OBJECT_STORE_UNSAFE');
      result.push(directory);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new ForgeFlowError('WORKTREE_OBJECT_STORE_UNSAFE');
        if (entry.isDirectory()) visit(path.join(directory, entry.name));
      }
    };
    visit(objects);
    return result;
  }

  private chownTreeNoFollow(target: string, uid: number, gid: number): void {
    const stat = fs.lstatSync(target);
    fs.lchownSync(target, uid, gid);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    for (const entry of fs.readdirSync(target))
      this.chownTreeNoFollow(path.join(target, entry), uid, gid);
  }

  private restoreSourceTreeNoFollow(target: string, uid: number, gid: number): void {
    const stat = fs.lstatSync(target);
    fs.lchownSync(target, uid, gid);
    if (stat.isSymbolicLink()) return;
    const mode = stat.mode & 0o7777;
    fs.chmodSync(target, mode | (stat.isDirectory() ? 0o700 : 0o600));
    if (!stat.isDirectory()) return;
    for (const entry of fs.readdirSync(target))
      this.restoreSourceTreeNoFollow(path.join(target, entry), uid, gid);
  }

  private async restoreWorktreeAdminSourceAccess(worktree: PlanWorktree): Promise<void> {
    const common = await this.canonicalCommonDir(worktree.repositoryPath);
    const { admin } = this.worktreeGitfileIdentity(worktree, common);
    const identity = this.repositoryIdentity(worktree.repositoryPath);
    this.restoreSourceTreeNoFollow(admin, identity.uid, identity.gid);
  }

  private async restoreWorktreeRefSourceAccess(worktree: PlanWorktree): Promise<void> {
    if (!worktree.branchRef) return;
    const common = await this.canonicalCommonDir(worktree.repositoryPath);
    const plan = worktreeRefComponent(worktree.rootPlanId);
    const allowedPrefix = 'refs/heads/forgeflow/' + plan + '/';
    failClosed(worktree.branchRef.startsWith(allowedPrefix), 'WORKTREE_BRANCH_NAMESPACE_INVALID');
    const identity = this.repositoryIdentity(worktree.repositoryPath);
    const refParent = path.dirname(path.join(common, ...worktree.branchRef.split('/')));
    if (fs.existsSync(refParent))
      this.restoreSourceTreeNoFollow(refParent, identity.uid, identity.gid);
    const logParent = path.dirname(
      path.join(common, 'logs', ...worktree.branchRef.split('/')),
    );
    if (fs.existsSync(logParent))
      this.restoreSourceTreeNoFollow(logParent, identity.uid, identity.gid);
  }

  private async rebuildCorruptedWorktree(
    worktree: PlanWorktree,
    expectedRevision: string,
  ): Promise<void> {
    failClosed(
      inside(worktree.hostPath, this.managedHostRoot) &&
        path.resolve(worktree.hostPath) !== path.resolve(this.managedHostRoot),
      'WORKTREE_RECOVERY_PATH_UNSAFE',
    );
    await this.assertCommit(worktree.repositoryPath, expectedRevision);
    const listed = await this.worktreeAt(worktree.repositoryPath, worktree.hostPath);
    failClosed(Boolean(listed), 'WORKTREE_REGISTRY_FILESYSTEM_MISSING');
    if (worktree.role === 'REVIEW') {
      failClosed(listed!.detached && !listed!.branch, 'WORKTREE_GIT_LINKAGE_VIOLATED');
      failClosed(listed!.head === expectedRevision, 'WORKTREE_GIT_LINKAGE_VIOLATED');
    } else {
      failClosed(listed!.branch === worktree.branchRef, 'WORKTREE_GIT_LINKAGE_VIOLATED');
    }
    failClosed(
      listed!.lockedReason === 'forgeflow:' + worktree.worktreeId,
      'WORKTREE_LOCK_MISMATCH',
    );

    const parent = path.dirname(worktree.hostPath);
    const managedReal = fs.realpathSync(this.managedHostRoot);
    const parentReal = fs.realpathSync(parent);
    failClosed(inside(parentReal, managedReal), 'WORKTREE_RECOVERY_PATH_UNSAFE');
    if (fs.existsSync(worktree.hostPath)) {
      const stat = fs.lstatSync(worktree.hostPath);
      failClosed(stat.isDirectory() && !stat.isSymbolicLink(), 'WORKTREE_RECOVERY_PATH_UNSAFE');
      const identity = this.repositoryIdentity(worktree.repositoryPath);
      this.chownTreeNoFollow(worktree.hostPath, identity.uid, identity.gid);
      await this.git(worktree.repositoryPath, ['worktree', 'unlock', '--', worktree.hostPath]);
      fs.rmSync(worktree.hostPath, { recursive: true, force: true });
    }
    await this.git(worktree.repositoryPath, ['worktree', 'prune', '--expire', 'now']);
    failClosed(
      !(await this.worktreeAt(worktree.repositoryPath, worktree.hostPath)),
      'WORKTREE_RECOVERY_REGISTRY_STALE',
    );
    if (worktree.branchRef)
      await this.git(worktree.repositoryPath, ['update-ref', worktree.branchRef, expectedRevision]);
    await this.createPhysicalWorktree(
      worktree,
      expectedRevision,
      worktree.branchRef,
      worktree.role === 'REVIEW',
    );
  }

  private validateSubmodulePath(worktree: PlanWorktree, value: string): string {
    const normalized = value.trim().replace(/\\/g, '/');
    failClosed(
      normalized.length > 0 &&
        normalized.length <= 1_000 &&
        !path.posix.isAbsolute(normalized) &&
        !normalized.split('/').includes('..'),
      'WORKTREE_SUBMODULE_METADATA_INVALID',
    );
    const target = path.resolve(worktree.hostPath, ...normalized.split('/'));
    failClosed(
      target !== path.resolve(worktree.hostPath) && inside(target, worktree.hostPath),
      'WORKTREE_SUBMODULE_METADATA_INVALID',
    );
    return normalized;
  }

  private async configuredSubmodulePaths(worktree: PlanWorktree): Promise<string[]> {
    const raw = await this.gitAsSourceInWorktree(worktree.repositoryPath, worktree.hostPath, [
      'ls-tree',
      '-r',
      '-z',
      '--full-tree',
      'HEAD',
    ]);
    const result: string[] = [];
    const seen = new Set<string>();
    for (const record of raw.split('\0')) {
      if (!record) continue;
      const separator = record.indexOf('\t');
      failClosed(separator > 0, 'WORKTREE_SUBMODULE_METADATA_INVALID');
      const metadata = record.slice(0, separator).split(/\s+/);
      if (metadata[0] !== '160000') continue;
      failClosed(metadata[1] === 'commit' && Boolean(metadata[2]), 'WORKTREE_SUBMODULE_METADATA_INVALID');
      const submodulePath = this.validateSubmodulePath(worktree, record.slice(separator + 1));
      failClosed(!seen.has(submodulePath), 'WORKTREE_SUBMODULE_METADATA_INVALID');
      seen.add(submodulePath);
      result.push(submodulePath);
    }
    if (result.length === 0) return [];
    const gitmodules = path.join(worktree.hostPath, '.gitmodules');
    const stat = fs.lstatSync(gitmodules, { throwIfNoEntry: false });
    failClosed(Boolean(stat?.isFile()) && !stat!.isSymbolicLink(), 'WORKTREE_SUBMODULE_METADATA_INVALID');
    const tracked = await this.gitSucceedsInWorktree(worktree.repositoryPath, worktree.hostPath, [
      'cat-file',
      '-e',
      'HEAD:.gitmodules',
    ]);
    failClosed(tracked, 'WORKTREE_SUBMODULE_METADATA_INVALID');
    return result.sort();
  }

  private async verifyPinnedSubmodules(worktree: PlanWorktree): Promise<string[]> {
    const configured = await this.configuredSubmodulePaths(worktree);
    if (configured.length === 0) return [];
    let raw: string;
    try {
      raw = await this.gitInWorktree(worktree.repositoryPath, worktree.hostPath, [
        'submodule',
        'status',
        '--recursive',
      ]);
    } catch (error) {
      throw new ForgeFlowError(
        'WORKTREE_SUBMODULE_GIT_LINKAGE_VIOLATED',
        'Unable to verify the pinned submodule tree.',
        error,
      );
    }
    const paths: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const normalized = line.trimStart();
      failClosed(!/^[+\-U]/.test(normalized), 'WORKTREE_SUBMODULE_REVISION_MISMATCH');
      const match = /^([0-9a-f]{40,64})\s+(.+?)(?:\s+\(.+\))?$/.exec(normalized);
      failClosed(Boolean(match?.[2]), 'WORKTREE_SUBMODULE_STATUS_INVALID');
      const submodulePath = this.validateSubmodulePath(worktree, match![2]!);
      const root = path.resolve(worktree.hostPath, ...submodulePath.split('/'));
      const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
      failClosed(Boolean(rootStat?.isDirectory()) && !rootStat!.isSymbolicLink(), 'WORKTREE_SUBMODULE_GIT_LINKAGE_VIOLATED');
      const gitfile = path.join(root, '.git');
      const gitfileStat = fs.lstatSync(gitfile, { throwIfNoEntry: false });
      failClosed(Boolean(gitfileStat?.isFile()) && !gitfileStat!.isSymbolicLink(), 'WORKTREE_SUBMODULE_GIT_LINKAGE_VIOLATED');
      paths.push(submodulePath);
    }
    for (const configuredPath of configured)
      failClosed(paths.includes(configuredPath), 'WORKTREE_SUBMODULE_REVISION_MISMATCH');
    return [...new Set(paths)].sort();
  }

  private async initializePinnedSubmodules(
    worktree: PlanWorktree,
    repairExisting: boolean,
  ): Promise<string[]> {
    const configured = await this.configuredSubmodulePaths(worktree);
    if (configured.length === 0) return [];
    if (repairExisting) {
      const common = await this.canonicalCommonDir(worktree.repositoryPath);
      const { admin } = this.worktreeGitfileIdentity(worktree, common);
      const modulesRoot = path.join(admin, 'modules');
      for (const submodulePath of configured) {
        const root = path.resolve(worktree.hostPath, ...submodulePath.split('/'));
        if (fs.existsSync(root)) {
          const stat = fs.lstatSync(root);
          failClosed(stat.isDirectory() && !stat.isSymbolicLink(), 'WORKTREE_SUBMODULE_REPAIR_PATH_UNSAFE');
          fs.rmSync(root, { recursive: true, force: true });
        }
        const adminPath = path.resolve(modulesRoot, ...submodulePath.split('/'));
        failClosed(inside(adminPath, modulesRoot), 'WORKTREE_SUBMODULE_REPAIR_PATH_UNSAFE');
        if (fs.existsSync(adminPath)) {
          const stat = fs.lstatSync(adminPath);
          failClosed(stat.isDirectory() && !stat.isSymbolicLink(), 'WORKTREE_SUBMODULE_REPAIR_PATH_UNSAFE');
          fs.rmSync(adminPath, { recursive: true, force: true });
        }
      }
    }
    try {
      await this.gitAsSourceInWorktree(worktree.repositoryPath, worktree.hostPath, [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'update',
        '--init',
        '--recursive',
        '--force',
      ]);
    } catch (error) {
      throw new ForgeFlowError(
        'WORKTREE_SUBMODULE_INIT_FAILED',
        'Unable to initialize the exact submodule revisions for this literal worktree.',
        error,
      );
    }
    return await this.verifyPinnedSubmodules(worktree);
  }

  private submoduleGitfileIdentity(
    worktree: PlanWorktree,
    submodulePath: string,
    mainAdmin: string,
  ): { root: string; gitfile: string; admin: string } {
    const normalized = this.validateSubmodulePath(worktree, submodulePath);
    const root = path.resolve(worktree.hostPath, ...normalized.split('/'));
    const gitfile = path.join(root, '.git');
    const stat = fs.lstatSync(gitfile, { throwIfNoEntry: false });
    failClosed(Boolean(stat?.isFile()) && !stat!.isSymbolicLink(), 'WORKTREE_SUBMODULE_GIT_LINKAGE_VIOLATED');
    const content = fs.readFileSync(gitfile, 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/i.exec(content);
    failClosed(Boolean(match?.[1]), 'WORKTREE_SUBMODULE_GIT_LINKAGE_VIOLATED');
    const candidate = path.isAbsolute(match![1]!)
      ? match![1]!
      : path.resolve(root, match![1]!);
    let admin: string;
    let modulesRoot: string;
    try {
      admin = fs.realpathSync(candidate);
      modulesRoot = fs.realpathSync(path.join(mainAdmin, 'modules'));
    } catch {
      throw new ForgeFlowError('WORKTREE_SUBMODULE_GIT_LINKAGE_VIOLATED');
    }
    failClosed(admin !== modulesRoot && inside(admin, modulesRoot), 'WORKTREE_SUBMODULE_GIT_LINKAGE_VIOLATED');
    return { root, gitfile, admin };
  }

  private async protectSubmoduleIdentities(
    worktree: PlanWorktree,
    submodulePaths: readonly string[],
    uid: number,
    common: string,
    sourceUid: number,
    sourceGid: number,
  ): Promise<void> {
    if (submodulePaths.length === 0) return;
    const { admin: mainAdmin } = this.worktreeGitfileIdentity(worktree, common);
    for (const submodulePath of submodulePaths) {
      const { root, gitfile } = this.submoduleGitfileIdentity(worktree, submodulePath, mainAdmin);
      fs.lchownSync(root, sourceUid, sourceGid);
      fs.chmodSync(root, 0o1750);
      fs.lchownSync(gitfile, sourceUid, sourceGid);
      fs.chmodSync(gitfile, 0o444);
      if (sourceUid !== uid) await this.execAcl(['-m', `u:${uid}:rwx`, '--', root]);
    }
  }

  private worktreeGitfileIdentity(
    worktree: PlanWorktree,
    common: string,
  ): { gitfile: string; admin: string } {
    const gitfile = path.join(worktree.hostPath, '.git');
    const stat = fs.lstatSync(gitfile, { throwIfNoEntry: false });
    failClosed(Boolean(stat?.isFile()) && !stat!.isSymbolicLink(), 'WORKTREE_GIT_LINKAGE_VIOLATED');
    const content = fs.readFileSync(gitfile, 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/i.exec(content);
    failClosed(Boolean(match?.[1]), 'WORKTREE_GIT_LINKAGE_VIOLATED');
    const candidate = path.isAbsolute(match![1]!)
      ? match![1]!
      : path.resolve(worktree.hostPath, match![1]!);
    let admin: string;
    let worktreesRoot: string;
    try {
      admin = fs.realpathSync(candidate);
      worktreesRoot = fs.realpathSync(path.join(common, 'worktrees'));
    } catch {
      throw new ForgeFlowError('WORKTREE_GIT_LINKAGE_VIOLATED');
    }
    failClosed(admin !== worktreesRoot && inside(admin, worktreesRoot), 'WORKTREE_GIT_LINKAGE_VIOLATED');
    return { gitfile, admin };
  }

  private async protectWorktreeIdentity(
    worktree: PlanWorktree,
    uid: number,
    common: string,
    sourceUid: number,
    sourceGid: number,
  ): Promise<void> {
    const { gitfile } = this.worktreeGitfileIdentity(worktree, common);
    const root = fs.lstatSync(worktree.hostPath);
    failClosed(root.isDirectory() && !root.isSymbolicLink(), 'WORKTREE_PARENT_UNSAFE');
    fs.lchownSync(worktree.hostPath, sourceUid, sourceGid);
    fs.chmodSync(worktree.hostPath, 0o1750);
    fs.lchownSync(gitfile, sourceUid, sourceGid);
    fs.chmodSync(gitfile, 0o444);
    if (sourceUid !== uid) await this.execAcl(['-m', `u:${uid}:rwx`, '--', worktree.hostPath]);
  }

  private async grantTraverseAcl(base: string, target: string, uid: number): Promise<void> {
    failClosed(target === base || inside(target, base), 'WORKTREE_ACL_TARGET_UNSAFE');
    const relative = path.relative(base, target).split(path.sep).filter(Boolean);
    let current = base;
    for (const component of relative.slice(0, -1)) {
      current = path.join(current, component);
      const stat = fs.lstatSync(current);
      failClosed(stat.isDirectory() && !stat.isSymbolicLink(), 'WORKTREE_ACL_TARGET_UNSAFE');
      await this.execAcl(['-m', `u:${uid}:--x`, '--', current]);
    }
  }

  private async grantRecursiveAcl(
    target: string,
    uid: number,
    preserveUid?: number,
  ): Promise<void> {
    await this.execAcl(['-R', '-m', `u:${uid}:rwX`, '--', target]);
    if (preserveUid !== undefined && preserveUid !== uid)
      await this.execAcl(['-R', '-m', `u:${preserveUid}:rwX`, '--', target]);
    const directories: string[] = [];
    const visit = (directory: string): void => {
      const stat = fs.lstatSync(directory);
      failClosed(stat.isDirectory() && !stat.isSymbolicLink(), 'WORKTREE_ACL_TARGET_UNSAFE');
      directories.push(directory);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new ForgeFlowError('WORKTREE_ACL_TARGET_UNSAFE');
        if (entry.isDirectory()) visit(path.join(directory, entry.name));
      }
    };
    visit(target);
    await this.grantDirectoryAcl(directories, uid, true);
    if (preserveUid !== undefined && preserveUid !== uid)
      await this.grantDirectoryAcl(directories, preserveUid, true);
  }

  private async grantObjectStoreAcl(objects: string, uid: number): Promise<void> {
    const directories = this.objectDirectories(objects);
    // Existing loose and packed Git objects may be owner-only (for example pack/*.pack,
    // pack/*.idx and pack/*.rev). A literal-worktree worker must be able to read the
    // immutable object graph behind HEAD, but it never needs write access to existing
    // object files. Directory write/default ACLs remain necessary so Git can add new
    // loose objects without granting the worker mutation authority over old objects.
    await this.execAcl(['-R', '-m', `u:${uid}:rX`, '--', objects]);
    await this.grantDirectoryAcl(directories, uid, true);
  }

  private async grantDirectoryAcl(
    directories: string[],
    uid: number,
    includeAccess = true,
  ): Promise<void> {
    for (let index = 0; index < directories.length; index += 80) {
      const chunk = directories.slice(index, index + 80);
      if (includeAccess) await this.execAcl(['-m', `u:${uid}:rwx`, '--', ...chunk]);
      await this.execAcl(['-m', `d:u:${uid}:rwx`, '--', ...chunk]);
    }
  }

  private async revokeObjectStoreAcl(objects: string, uid: number): Promise<void> {
    const directories = this.objectDirectories(objects);
    // Remove access ACLs from both files and directories, including existing pack files,
    // then remove the default ACLs installed on directories for newly-created objects.
    // Revocation is fail-closed: a Plan cannot finish cleanup while worker access remains.
    await this.execAcl(['-R', '-x', `u:${uid}`, '--', objects]);
    for (let index = 0; index < directories.length; index += 80) {
      await this.execAcl(['-x', `d:u:${uid}`, '--', ...directories.slice(index, index + 80)]);
    }
  }

  private async revokeRecursiveAcl(target: string, uid: number): Promise<void> {
    await this.execAcl(['-R', '-x', `u:${uid}`, '--', target], true);
    const directories = this.directoryTree(target);
    await this.revokeDirectoryAcl(directories, uid);
  }

  private async revokeDirectoryAcl(directories: string[], uid: number): Promise<void> {
    for (let index = 0; index < directories.length; index += 80) {
      const chunk = directories.slice(index, index + 80);
      await this.execAcl(['-x', `u:${uid}`, '--', ...chunk], true);
      await this.execAcl(['-x', `d:u:${uid}`, '--', ...chunk], true);
    }
  }

  private directoryTree(target: string): string[] {
    const result: string[] = [];
    const visit = (directory: string): void => {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      result.push(directory);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) visit(path.join(directory, entry.name));
      }
    };
    visit(target);
    return result;
  }

  private async execAcl(args: string[], allowFailure = false): Promise<void> {
    try {
      await execFileAsync(this.setfaclBinary, args, {
        encoding: 'utf8',
        timeout: this.commandTimeoutMs,
        maxBuffer: this.maxBufferBytes,
      });
    } catch (error) {
      if (allowFailure) return;
      throw new ForgeFlowError('WORKTREE_ACL_FAILED', 'Unable to scope Git ACLs for the worker.', error);
    }
  }

  private async resetWorktreeToRevision(
    worktree: PlanWorktree,
    expectedRevision: string,
  ): Promise<void> {
    const identity = this.repositoryIdentity(worktree.repositoryPath);
    try {
      await this.restoreWorktreeAdminSourceAccess(worktree);
    } catch (error) {
      if (!(error instanceof ForgeFlowError) || error.code !== 'WORKTREE_GIT_LINKAGE_VIOLATED')
        throw error;
      await this.rebuildCorruptedWorktree(worktree, expectedRevision);
      return;
    }
    if (fs.existsSync(worktree.hostPath))
      this.chownTreeNoFollow(worktree.hostPath, identity.uid, identity.gid);
    await this.gitAsSourceInWorktree(worktree.repositoryPath, worktree.hostPath, [
      'reset',
      '--hard',
      expectedRevision,
    ]);
    await this.initializePinnedSubmodules(worktree, true);
    await this.gitAsSourceInWorktree(worktree.repositoryPath, worktree.hostPath, ['clean', '-ffd']);
    const head = await this.gitInWorktree(worktree.repositoryPath, worktree.hostPath, [
      'rev-parse',
      '--verify',
      'HEAD^{commit}',
    ]);
    failClosed(head === expectedRevision, 'WORKTREE_RESET_REVISION_MISMATCH');
    failClosed(
      (await this.gitStatus(worktree.repositoryPath, worktree.hostPath)).length === 0,
      'WORKTREE_RESET_DIRTY',
    );
  }

  private async gitAsSourceInWorktree(
    repositoryPath: string,
    worktreePath: string,
    args: string[],
    allowFailure = false,
  ): Promise<string> {
    return await this.git(
      repositoryPath,
      ['-c', 'safe.directory=' + worktreePath, '-C', worktreePath, ...args],
      allowFailure,
      true,
    );
  }

  private async gitSucceedsInWorktree(
    repositoryPath: string,
    worktreePath: string,
    args: string[],
  ): Promise<boolean> {
    try {
      await this.gitAsSourceInWorktree(repositoryPath, worktreePath, args);
      return true;
    } catch {
      return false;
    }
  }

  private async gitStatus(repositoryPath: string, worktreePath: string): Promise<string> {
    return await this.gitInWorktree(repositoryPath, worktreePath, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]);
  }

  private async gitInWorktree(
    repositoryPath: string,
    worktreePath: string,
    args: string[],
  ): Promise<string> {
    return await this.git(repositoryPath, ['-C', worktreePath, ...args], false, true, worktreePath);
  }

  private repositoryIdentity(repositoryPath: string): RepositoryIdentity {
    const stat = fs.statSync(repositoryPath);
    failClosed(stat.isDirectory(), 'WORKTREE_REPOSITORY_PATH_INVALID');
    return { uid: stat.uid, gid: stat.gid };
  }

  private gitArgs(repositoryPath: string, args: string[]): string[] {
    return [
      '-c',
      'safe.directory=' + repositoryPath,
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-C',
      repositoryPath,
      ...args,
    ];
  }

  private async git(
    repositoryPath: string,
    args: string[],
    allowFailure = false,
    argsContainCwd = false,
    safeWorktreePath?: string,
  ): Promise<string> {
    const invocation = argsContainCwd
      ? [
          '-c',
          'safe.directory=' + repositoryPath,
          ...(safeWorktreePath ? ['-c', 'safe.directory=' + safeWorktreePath] : []),
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          ...args,
        ]
      : this.gitArgs(repositoryPath, args);
    const identity = this.repositoryIdentity(repositoryPath);
    const runAsSource = safeWorktreePath === undefined;
    try {
      const { stdout } = await execFileAsync('git', invocation, {
        encoding: 'utf8',
        timeout: this.commandTimeoutMs,
        maxBuffer: this.maxBufferBytes,
        ...(runAsSource && typeof process.getuid === 'function' && process.getuid() === 0
          ? { uid: identity.uid, gid: identity.gid }
          : {}),
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: '/nonexistent',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
          LC_ALL: 'C.UTF-8',
          ...(safeWorktreePath ? { GIT_OPTIONAL_LOCKS: '0' } : {}),
        },
      });
      return stdout.trim();
    } catch (error) {
      if (allowFailure) return '';
      throw new ForgeFlowError('WORKTREE_GIT_FAILED', 'Git worktree operation failed.', error);
    }
  }

  private async gitSucceeds(repositoryPath: string, args: string[]): Promise<boolean> {
    try {
      await this.git(repositoryPath, args);
      return true;
    } catch {
      return false;
    }
  }
}

export function parseWorktreeList(output: string): GitWorktreeRecord[] {
  const records: GitWorktreeRecord[] = [];
  let current: Partial<GitWorktreeRecord> | undefined;
  const flush = () => {
    if (current?.path && current.head) {
      records.push({
        path: current.path,
        head: current.head,
        ...(current.branch ? { branch: current.branch } : {}),
        detached: current.detached === true,
        ...(current.lockedReason ? { lockedReason: current.lockedReason } : {}),
      });
    }
    current = undefined;
  };
  for (const line of output.split(/\r?\n/)) {
    if (!line) {
      flush();
      continue;
    }
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'worktree') {
      flush();
      current = { path: value, detached: false };
    } else if (!current) {
      continue;
    } else if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value;
    else if (key === 'detached') current.detached = true;
    else if (key === 'locked') current.lockedReason = value;
  }
  flush();
  return records;
}
