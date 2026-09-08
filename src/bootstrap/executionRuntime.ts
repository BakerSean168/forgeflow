import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  AntigravityExecutionProvider,
  AntigravityReviewProvider,
} from '../core/adapters/antigravity.js';
import { LocalGitWorkspaceAdapter } from '../core/adapters/gitWorkspace.js';
import { LiteralWorktreeWorkspaceAdapter } from '../core/adapters/literalWorktreeWorkspace.js';
import { PlanWorktreeManager } from '../core/adapters/planWorktrees.js';
import { ProjectScopedWorkspaceAdapter } from '../core/adapters/projectScopedWorkspace.js';
import { GitHubCliDeliveryAdapter } from '../core/adapters/githubDelivery.js';
import {
  createOpenHandsProviderFactory,
  OpenHandsCodexBusinessReviewProvider,
  OpenHandsCodexManagedExecutionProvider,
  OpenHandsExecutionProvider,
  OpenHandsReviewProvider,
  type OpenHandsAgentBackend,
} from '../core/adapters/openHandsCoding.js';
import {
  CompositeResourceDirectory,
  LiteLlmResourceDirectory,
  LiteLlmResourceProbe,
  LiteLlmResourceStateEffect,
  ResourceLifecycleManager,
  ResourceStateService,
  StaticResourceDirectory,
  providerNativeResources,
  type ResourceProbePort,
} from '../core/adapters/resourceDirectory.js';
import { ForgeFlowError } from '../core/domain/errors.js';
import {
  DEFAULT_AFFINITY_POLICY,
  createExecutionResourceSelection,
  type ExecutionResource,
  type ExecutionResourceSelection,
} from '../core/domain/resourceRouting.js';
import { ExecutionWorker, type ExecutionWorkerRoute } from '../core/orchestration/executionWorker.js';
import type { ExecutionProviderPort, WorkspaceProviderPort } from '../core/orchestration/contracts.js';
import { PlanAutomationRuntime, StaticPlanAutomationPolicyResolver, type PlanAutomationPolicy } from '../core/orchestration/planAutomationRuntime.js';
import {
  ResourceSelector,
  selectExecutableProfile,
  type ResourceSelectionCandidate,
} from '../core/orchestration/resourceSelector.js';
import {
  RuntimeAdmissionRegistry,
  createRuntimeAdmissionStatus,
  requiresAcpRuntimeAdmission,
  runtimeAdmissionKey,
} from '../core/orchestration/runtimeAdmission.js';
import type { ForgeFlowRepositories } from '../core/persistence/repositories.js';
import type { ProjectRegistry } from '../platform/projects/index.js';
import type { ExecutionRuntimeConfig } from './config.js';

export interface ExecutionAutomationRuntime {
  workspace: WorkspaceProviderPort;
  planWorktreeManager?: PlanWorktreeManager;
  workspaceUid: number;
  worker: ExecutionWorker;
  plans: PlanAutomationRuntime;
  policy: StaticPlanAutomationPolicyResolver;
  compatibilityImplementationRoutes: string[];
  compatibilityReviewRoutes: string[];
  implementationRoutes: string[];
  reviewRoutes: string[];
  automationProjectKeys: string[];
  literalWorktreeProjectKeys: string[];
  requireDelivery: boolean;
  routeModels: Record<string, string>;
  resourceSelectorEnabled: boolean;
  resources: CompositeResourceDirectory;
  liteLlmResources: LiteLlmResourceDirectory;
  resourceSelector: ResourceSelector;
  resourceState: ResourceStateService;
  resourceStateEffect: LiteLlmResourceStateEffect;
  resourceLifecycle: ResourceLifecycleManager;
  runtimeAdmissionEnabled: boolean;
  runtimeAdmission: RuntimeAdmissionRegistry;
  runtimeAdmissionHasDemand: () => boolean;
  reconcileRuntimeAdmission: () => Promise<void>;
  shutdownRuntimeAdmission: () => Promise<void>;
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
export async function buildExecutionAutomation(
  config: ExecutionRuntimeConfig,
  repositories: ForgeFlowRepositories,
  fetchImpl: typeof fetch,
  projects: ProjectRegistry,
): Promise<ExecutionAutomationRuntime | undefined> {
  if (!config.enabled) return undefined;
  const openHandsUrl = config.openHands.baseUrl;
  const sessionApiKey = config.openHands.sessionApiKey;
  const liteLlmApiKey = config.openHands.liteLlmApiKey;
  const liteLlmBaseUrl = config.openHands.liteLlmBaseUrl;
  const allowedRepositoryRoots = config.allowedRepositoryRoots;
  if (allowedRepositoryRoots.length === 0) throw new ForgeFlowError('WORKSPACE_ALLOWED_ROOT_REQUIRED');
  const managedHostRoot = config.workspace.managedHostRoot;
  const executionRoot = config.workspace.executionRoot;
  const automationProjectKeys = projects.automationProjectKeys();
  const literalWorktreesEnabled = config.literalWorktreesEnabled;
  const configuredLiteralProjects = projects.literalWorktreeProjectKeys();
  if (projects.source() === 'manifest' && configuredLiteralProjects.length > 0 && !literalWorktreesEnabled)
    throw new ForgeFlowError('PROJECT_MANIFEST_LITERAL_WORKTREES_DISABLED');
  const literalWorktreeProjectKeys = literalWorktreesEnabled ? configuredLiteralProjects : [];
  if (literalWorktreesEnabled && literalWorktreeProjectKeys.length === 0)
    throw new ForgeFlowError('LITERAL_WORKTREE_PROJECTS_REQUIRED');
  if (
    automationProjectKeys.length > 0 &&
    literalWorktreeProjectKeys.some((projectKey) => !automationProjectKeys.includes(projectKey))
  )
    throw new ForgeFlowError('LITERAL_WORKTREE_PROJECT_NOT_AUTOMATED');
  const resourceSelectorEnabled = config.resourceSelectorEnabled;
  // Selector-enabled ForgeFlow never reads the legacy route ladders. They remain only
  // as an explicit rollback path when the selector gate is disabled. This keeps
  // exactly one routing authority for every newly-created execution.
  const implementationSpecs = resourceSelectorEnabled
    ? []
    : config.legacyRoutes.implementation;
  const reviewSpecs = resourceSelectorEnabled
    ? []
    : config.legacyRoutes.review;
  const compatibilityImplementationRoutes = implementationSpecs.map((item) => item.route);
  const compatibilityReviewRoutes = reviewSpecs.map((item) => item.route);
  if (compatibilityImplementationRoutes.some((route) => compatibilityReviewRoutes.includes(route)))
    throw new ForgeFlowError('EXECUTION_ROUTE_ROLE_CONFLICT');
  const implementationRoutes = resourceSelectorEnabled
    ? DEFAULT_AFFINITY_POLICY.capabilities.IMPLEMENTATION.map((item) => item.modelFamily)
    : compatibilityImplementationRoutes;
  const reviewRoutes = resourceSelectorEnabled
    ? DEFAULT_AFFINITY_POLICY.capabilities.REASONING.map((item) => item.modelFamily)
    : compatibilityReviewRoutes;

  const common = {
    baseUrl: openHandsUrl,
    sessionApiKey,
    liteLlmApiKey,
    liteLlmBaseUrl,
    fetchImpl,
    requestTimeoutMs: config.openHands.requestTimeoutMs,
    llmTimeoutSeconds: config.openHands.llmTimeoutSeconds,
    maxIterations: config.openHands.maxIterations,
  };
  const liteLlmAdminBaseUrl = config.resources.liteLlmAdminBaseUrl;
  const liteLlmResources = new LiteLlmResourceDirectory({
    baseUrl: liteLlmAdminBaseUrl,
    envFile: config.resources.adminEnvFile,
    keyName: config.resources.adminKeyName,
    fetchImpl,
    requestTimeoutMs: config.resources.directoryTimeoutMs,
  });
  if (resourceSelectorEnabled) await liteLlmResources.refresh();

  const businessAuthFile =
    config.resources.businessAuthFile;
  const businessEnabled = config.resources.businessEnabled;
  const businessReady = businessEnabled && fs.existsSync(businessAuthFile);
  const antigravityBinary =
    config.antigravity.binary;
  const antigravityHome =
    config.antigravity.home;
  const antigravityAuthFile = path.join(
    antigravityHome,
    '.gemini/antigravity-cli/antigravity-oauth-token',
  );
  const antigravityEnabled = config.resources.antigravityEnabled;
  const antigravityReady =
    antigravityEnabled && fs.existsSync(antigravityBinary) && fs.existsSync(antigravityAuthFile);
  const nativeResources = new StaticResourceDirectory(
    providerNativeResources({
      businessEnabled,
      businessReady,
      antigravityEnabled,
      antigravityReady,
    }),
  );
  const sourceResources = new CompositeResourceDirectory([liteLlmResources, nativeResources]);
  const resources = new CompositeResourceDirectory(
    [liteLlmResources, nativeResources],
    repositories.resourceStateOverrides,
  );
  const runtimeAdmissionEnabled =
    config.runtimeAdmission.enabled;
  const runtimeAdmissionTtlMs = config.runtimeAdmission.ttlMs;
  const runtimeAdmissionTransientFailureTtlMs = config.runtimeAdmission.transientFailureTtlMs;
  const runtimeAdmission = new RuntimeAdmissionRegistry();
  if (runtimeAdmissionEnabled) runtimeAdmission.restore(repositories.runtimeAdmissions.list());
  const runtimeAdmissionHasDemand = (): boolean => {
    if (repositories.executions.listByStatuses(['QUEUED', 'RUNNING'], 1).length > 0) return true;
    return (['READY', 'RUNNING', 'WAITING_FOR_RESOURCE'] as const).some(
      (status) => repositories.plans.listPlans({ status, limit: 1 }).length > 0,
    );
  };
  const resourceStateEffect = new LiteLlmResourceStateEffect({
    baseUrl: liteLlmAdminBaseUrl,
    envFile: config.resources.adminEnvFile,
    keyName: config.resources.adminKeyName,
    fetchImpl,
    requestTimeoutMs: config.resources.directoryTimeoutMs,
  });
  const resourceState = new ResourceStateService(
    resources,
    repositories.resourceStateOverrides,
    3,
    resourceStateEffect,
  );
  const liteLlmResourceProbe = new LiteLlmResourceProbe({
    baseUrl: liteLlmBaseUrl,
    bearerToken: liteLlmApiKey,
    fetchImpl,
    timeoutMs: config.resources.probeTimeoutMs,
  });
  const resourceProbe: ResourceProbePort = {
    probe: async (resource: ExecutionResource): Promise<boolean> => {
      if (resource.resourceId === 'chatgpt-business-primary') return businessReady;
      if (resource.resourceId === 'antigravity-primary') return antigravityReady;
      return await liteLlmResourceProbe.probe(resource);
    },
  };
  const resourceLifecycle = new ResourceLifecycleManager(
    sourceResources,
    repositories.resourceStateOverrides,
    resourceProbe,
    resourceStateEffect,
  );
  const routes: ExecutionWorkerRoute[] = [
    ...implementationSpecs.map(({ route, model }) => ({
      route,
      provider:
        model === 'gpt-5.6-luna'
          ? new OpenHandsCodexManagedExecutionProvider({ ...common, implementationModel: model })
          : new OpenHandsExecutionProvider({ ...common, implementationModel: model }),
    })),
    ...reviewSpecs.map(({ route, model }) => ({
      route,
      provider:
        route === 'codex-business-review'
          ? new OpenHandsCodexBusinessReviewProvider({ ...common, reviewModel: model })
          : new OpenHandsReviewProvider({ ...common, reviewModel: model }),
    })),
  ];
  const workspaceUid = config.workspace.uid;
  const workspaceGid = config.workspace.gid;
  const gitTimeoutMs = config.workspace.gitTimeoutMs;
  const gitMaxBufferBytes = config.workspace.gitMaxBufferBytes;
  const workspaceMinimumFreeBytes = config.workspace.minimumFreeBytes;
  const legacyWorkspace = new LocalGitWorkspaceAdapter({
    allowedRepositoryRoots,
    managedHostRoot,
    executionRoot,
    commandTimeoutMs: gitTimeoutMs,
    maxBufferBytes: gitMaxBufferBytes,
    minimumFreeBytes: workspaceMinimumFreeBytes,
    workspaceUid,
    workspaceGid,
  });
  const planWorktreeManager =
    literalWorktreeProjectKeys.length > 0
      ? new PlanWorktreeManager({
          repositories,
          allowedRepositoryRoots,
          managedHostRoot,
          executionRoot,
          commandTimeoutMs: gitTimeoutMs,
          maxBufferBytes: gitMaxBufferBytes,
          projectAdmission: (repositoryPath) => {
            const harnessctl =
              config.workspace.agentHarnessCtl;
            try {
              execFileSync(
                '/usr/bin/python3',
                [harnessctl, 'plan', repositoryPath, '--profile', 'openhands', '--json'],
                {
                  cwd: repositoryPath,
                  encoding: 'utf8',
                  timeout: gitTimeoutMs,
                  maxBuffer: gitMaxBufferBytes,
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
            if (config.nodeEnv !== 'test')
              assertOpenHandsGitCommonDirMounted(
                repositoryPath,
                config.openHands.container,
                gitTimeoutMs,
                gitMaxBufferBytes,
              );
          },
        })
      : undefined;
  const literalWorkspace = planWorktreeManager
    ? new LiteralWorktreeWorkspaceAdapter({
        repositories,
        manager: planWorktreeManager,
        managedHostRoot,
        executionRoot,
        workspaceUid,
        workspaceGid,
        minimumFreeBytes: workspaceMinimumFreeBytes,
        commandTimeoutMs: gitTimeoutMs,
        maxBufferBytes: gitMaxBufferBytes,
      })
    : undefined;
  const workspace: WorkspaceProviderPort = literalWorkspace
    ? new ProjectScopedWorkspaceAdapter({
        repositories,
        legacy: legacyWorkspace,
        literal: literalWorkspace,
        literalProjects: literalWorktreeProjectKeys,
      })
    : legacyWorkspace;
  const openHandsProviderFactory = createOpenHandsProviderFactory(common);
  const antigravityBase = {
    binary: antigravityBinary,
    stateRoot:
      config.antigravity.stateRoot,
    workspaceHostRoot: managedHostRoot,
    home: antigravityHome,
    uid: config.antigravity.uid,
    gid: config.antigravity.gid,
    authUid: config.antigravity.authUid,
    authGid: config.antigravity.authGid,
    workspaceGid,
    user: config.antigravity.user,
    printTimeout:
      config.antigravity.printTimeout,
    sandboxWrapper:
      config.antigravity.sandboxWrapper,
    systemdUnitTemplate:
      config.antigravity.systemdUnitTemplate,
  };
  const providerFactory = (selection: ExecutionResourceSelection): ExecutionProviderPort => {
    if (
      selection.agentBackend === 'antigravity-worker' ||
      selection.agentBackend === 'antigravity-review'
    ) {
      const options = { ...antigravityBase, model: selection.modelFamily };
      return selection.agentBackend === 'antigravity-review'
        ? new AntigravityReviewProvider(options)
        : new AntigravityExecutionProvider(options);
    }
    if (!['IMPLEMENT', 'IMPLEMENT_FIX', 'REVIEW'].includes(selection.phase))
      throw new ForgeFlowError('EXECUTION_RESOURCE_SELECTION_PHASE_UNSUPPORTED');
    return openHandsProviderFactory({
      backend: selection.agentBackend as OpenHandsAgentBackend,
      model: selection.routeModel ?? selection.modelFamily,
      modelFamily: selection.modelFamily,
      transport: selection.transport,
      phase: selection.phase as 'IMPLEMENT' | 'IMPLEMENT_FIX' | 'REVIEW',
      capability: selection.capability,
      resourceId: selection.resourceId,
    });
  };
  const admissionCandidates = (): ResourceSelectionCandidate[] => {
    const selected = new Map<string, ResourceSelectionCandidate>();
    for (const phase of ['IMPLEMENT', 'REVIEW'] as const) {
      const priorAttempts: Array<{ resourceId: string; bindingId?: string; modelFamily?: string }> =
        [];
      for (let index = 0; index < 100; index += 1) {
        const result = selectExecutableProfile(resources, {
          phase,
          includeProviderNativeProfiles: true,
          policy: {
            allowProviderNative: true,
            allowedPolicyKeys: ['provider-native-trusted-input'],
          },
          priorAttempts,
        });
        if (result.status !== 'SELECTED') break;
        selected.set(runtimeAdmissionKey(result.candidate), result.candidate);
        priorAttempts.push({
          resourceId: result.profile.resourceId,
          ...(result.profile.bindingId ? { bindingId: result.profile.bindingId } : {}),
          modelFamily: result.profile.modelFamily,
        });
      }
    }
    return [...selected.values()].filter(requiresAcpRuntimeAdmission);
  };

  const createAdmissionWorkspace = (_candidate: ResourceSelectionCandidate, probeId: string) => {
    const executionsRoot = path.join(managedHostRoot, 'forgeflow', 'executions');
    const root = path.join(executionsRoot, probeId);
    const repository = path.join(root, 'repo');
    fs.mkdirSync(executionsRoot, { recursive: true, mode: 0o755 });
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { mode: 0o750 });
    fs.chownSync(root, workspaceUid, workspaceGid);
    fs.mkdirSync(repository, { mode: 0o750 });
    fs.chownSync(repository, workspaceUid, workspaceGid);
    const git = (args: string[]) =>
      execFileSync('/usr/bin/git', ['-C', repository, ...args], {
        encoding: 'utf8',
        uid: workspaceUid,
        gid: workspaceGid,
        env: { ...config.childProcessEnv, HOME: '/tmp' },
      }).trim();
    git(['init', '-q', '-b', 'main']);
    const readme = path.join(repository, 'README.md');
    fs.writeFileSync(readme, '# ForgeFlow runtime admission probe\n');
    fs.chownSync(readme, workspaceUid, workspaceGid);
    const harnessManifest = path.join(repository, '.agent-harness.json');
    fs.writeFileSync(
      harnessManifest,
      JSON.stringify(
        {
          version: 1,
          id: 'forgeflow-runtime-admission',
          sharedMcpProfile: 'common',
          packs: [],
          capabilities: [],
        },
        null,
        2,
      ) + '\n',
      { mode: 0o640 },
    );
    fs.chownSync(harnessManifest, workspaceUid, workspaceGid);
    git(['add', 'README.md', '.agent-harness.json']);
    git([
      '-c',
      'user.name=ForgeFlow Runtime Probe',
      '-c',
      'user.email=forgeflow-runtime-probe@localhost',
      'commit',
      '-q',
      '-m',
      'chore: runtime admission probe',
    ]);
    const sourceRevision = git(['rev-parse', '--verify', 'HEAD^{commit}']);
    const executionPath = path.join(executionRoot, 'forgeflow', 'executions', probeId, 'repo');
    return {
      root,
      sourceRevision,
      workspace: {
        executionId: probeId,
        hostPath: repository,
        executionPath,
        evidenceHostPath: path.join(root, 'completion-evidence.json'),
        evidenceExecutionPath: path.join(
          executionRoot,
          'forgeflow',
          'executions',
          probeId,
          'completion-evidence.json',
        ),
        sourceRepositoryPath: repository,
        sourceRevision,
        createdAt: new Date().toISOString(),
      },
      git,
    };
  };

  const pruneAdmissionWorkspaces = (probeGroupId: string, currentRoot: string): number => {
    const executionsRoot = path.join(managedHostRoot, 'forgeflow', 'executions');
    if (!fs.existsSync(executionsRoot)) return 0;
    let removed = 0;
    for (const entry of fs.readdirSync(executionsRoot, { withFileTypes: true })) {
      if (entry.name !== probeGroupId && !entry.name.startsWith(probeGroupId + '-')) continue;
      const candidate = path.join(executionsRoot, entry.name);
      if (candidate === currentRoot) continue;
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new ForgeFlowError('RUNTIME_ADMISSION_STALE_WORKSPACE_UNSAFE');
      fs.rmSync(candidate, { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  };

  const recordRuntimeAdmission = (
    candidate: ResourceSelectionCandidate,
    input: { ready: boolean; checkedAt?: string; errorCode?: string },
  ) => {
    const status = createRuntimeAdmissionStatus(candidate, input);
    const persisted = repositories.runtimeAdmissions.record(status);
    if (!persisted.value || persisted.status === 'rejected')
      throw new ForgeFlowError(persisted.reason ?? 'RUNTIME_ADMISSION_STALE');
    runtimeAdmission.restore([persisted.value]);
    return persisted.value;
  };

  const probeAdmissionCandidate = async (
    candidate: ResourceSelectionCandidate,
    signal?: AbortSignal,
  ): Promise<void> => {
    const key = runtimeAdmissionKey(candidate);
    const probeGroupId =
      'runtime-admission-' + createHash('sha256').update(key).digest('hex').slice(0, 20);
    const probeId = probeGroupId + '-' + randomUUID().slice(0, 8);
    let probeRoot: string | undefined;
    try {
      const prepared = createAdmissionWorkspace(candidate, probeId);
      probeRoot = prepared.root;
      const provider = providerFactory(
        createExecutionResourceSelection(probeId, candidate.profile, new Date().toISOString()),
      );
      if (!provider.probeRuntime) throw new ForgeFlowError('RUNTIME_ADMISSION_PROBE_UNSUPPORTED');
      const result = await provider.probeRuntime({
        probeId,
        probeGroupId,
        workspace: prepared.workspace,
        sourceRevision: prepared.sourceRevision,
        signal,
      });
      // probeRuntime returning means its stable-group OpenHands cleanup completed.
      // Only then is it safe to remove crash residue from older attempts, including
      // the pre-attempt-id deterministic directory used by older ForgeFlow builds.
      pruneAdmissionWorkspaces(probeGroupId, prepared.root);
      const clean = prepared.git(['status', '--porcelain=v1']) === '';
      const head = prepared.git(['rev-parse', '--verify', 'HEAD^{commit}']);
      const ready = result.ready && clean && head === prepared.sourceRevision;
      recordRuntimeAdmission(candidate, {
        ready,
        ...(!ready
          ? {
              errorCode:
                result.errorCode ??
                (!clean
                  ? 'RUNTIME_PROBE_WORKSPACE_DIRTY'
                  : head !== prepared.sourceRevision
                    ? 'RUNTIME_PROBE_HEAD_DRIFT'
                    : 'RUNTIME_ADMISSION_PROBE_FAILED'),
            }
          : {}),
      });
    } catch (error) {
      if (signal?.aborted) return;
      recordRuntimeAdmission(candidate, {
        ready: false,
        errorCode: error instanceof ForgeFlowError ? error.code : 'RUNTIME_ADMISSION_PROBE_FAILED',
      });
    } finally {
      if (probeRoot) fs.rmSync(probeRoot, { recursive: true, force: true });
    }
  };

  let runtimeAdmissionCycle: Promise<void> | undefined;
  let runtimeAdmissionAbortController: AbortController | undefined;
  let runtimeAdmissionShuttingDown = false;
  const reconcileRuntimeAdmission = async (): Promise<void> => {
    if (!runtimeAdmissionEnabled || runtimeAdmissionShuttingDown) return;
    const candidates = admissionCandidates();
    runtimeAdmission.retain(candidates);
    repositories.runtimeAdmissions.retain(candidates.map(runtimeAdmissionKey));
    if (!runtimeAdmissionHasDemand()) return;
    if (runtimeAdmissionCycle) return await runtimeAdmissionCycle;
    const abortController = new AbortController();
    runtimeAdmissionAbortController = abortController;
    runtimeAdmissionCycle = (async () => {
      const now = Date.now();
      const queue = candidates.filter((candidate) =>
        runtimeAdmission.isStale(
          candidate,
          now,
          runtimeAdmissionTtlMs,
          runtimeAdmissionTransientFailureTtlMs,
        ),
      );
      // Admission is a readiness gate, not a startup dependency or throughput path.
      // Probe serially so provider-native OAuth homes and ACP runtime caches are never
      // mutated concurrently by sibling probes. The selector fails closed until a
      // candidate has a positive admission record.
      for (const candidate of queue) {
        if (abortController.signal.aborted) break;
        await probeAdmissionCandidate(candidate, abortController.signal);
      }
    })();
    try {
      await runtimeAdmissionCycle;
    } finally {
      if (runtimeAdmissionAbortController === abortController)
        runtimeAdmissionAbortController = undefined;
      runtimeAdmissionCycle = undefined;
    }
  };
  const shutdownRuntimeAdmission = async (): Promise<void> => {
    runtimeAdmissionShuttingDown = true;
    runtimeAdmissionAbortController?.abort();
    if (runtimeAdmissionCycle) await runtimeAdmissionCycle;
  };

  const resourceSelector = new ResourceSelector(
    resources,
    DEFAULT_AFFINITY_POLICY,
    runtimeAdmissionEnabled ? runtimeAdmission : undefined,
  );
  const worker = new ExecutionWorker(repositories, workspace, routes, {
    leaseTtlMs: config.worker.leaseTtlMs,
    maxExecutionsPerCycle: config.worker.maxExecutionsPerCycle,
    meaningfulProgressTimeoutMs: config.worker.meaningfulProgressTimeoutMs,
    providerOnlyProgressTimeoutMs: config.worker.providerOnlyProgressTimeoutMs,
    opportunisticMeaningfulProgressTimeoutMs: config.worker.opportunisticMeaningfulProgressTimeoutMs,
    maxStallRecoveries: config.worker.maxStallRecoveries,
    opportunisticMaxStallRecoveries: config.worker.opportunisticMaxStallRecoveries,
    ...(resourceSelectorEnabled
      ? {
          providerFactory,
          resourceFeedback: resourceState,
          requireResourceSelection: true,
        }
      : {}),
  });
  const maxParallelWorkItems = config.planPolicy.maxParallelWorkItems;
  const defaultPolicy: PlanAutomationPolicy = {
    ...(resourceSelectorEnabled
      ? {}
      : {
          implementationRoutes: compatibilityImplementationRoutes,
          reviewRoutes: compatibilityReviewRoutes,
        }),
    resourceSelection: {
      includeProviderNativeProfiles: false,
    },
    requireDelivery: config.planPolicy.requireDelivery,
    maxImplementationAttempts: config.planPolicy.maxImplementationAttempts,
    maxReviewAttempts: config.planPolicy.maxReviewAttempts,
    maxRepairCycles: config.planPolicy.maxRepairCycles,
    maxParallelWorkItems: 1,
  };
  const antigravityProjectKeys = new Set(projects.providerNativeProjectKeys());
  const literalProjectSet = new Set(literalWorktreeProjectKeys);
  const policyOverrides = Object.fromEntries(
    automationProjectKeys
      .filter(
        (projectKey) =>
          literalProjectSet.has(projectKey) ||
          (antigravityEnabled && antigravityProjectKeys.has(projectKey)),
      )
      .map((projectKey) => [
        projectKey,
        {
          ...defaultPolicy,
          maxParallelWorkItems: literalProjectSet.has(projectKey)
            ? Math.min(
                maxParallelWorkItems,
                projects.get(projectKey)?.execution.maxParallelWorkItems ?? maxParallelWorkItems,
              )
            : 1,
          ...(antigravityEnabled && antigravityProjectKeys.has(projectKey)
            ? {
                resourceSelection: {
                  includeProviderNativeProfiles: true,
                  allowedPolicyKeys: ['provider-native-trusted-input'],
                },
              }
            : {}),
        } satisfies PlanAutomationPolicy,
      ]),
  );
  const policy = new StaticPlanAutomationPolicyResolver(
    defaultPolicy,
    policyOverrides,
    automationProjectKeys.length > 0 ? automationProjectKeys : undefined,
  );
  const delivery = new GitHubCliDeliveryAdapter({
    allowedRepositoryRoots,
    allowedWorkspaceRoots: [managedHostRoot],
    commandTimeoutMs: config.delivery.commandTimeoutMs,
    maxBufferBytes: config.delivery.maxBufferBytes,
  });
  const plans = new PlanAutomationRuntime(
    repositories,
    worker,
    workspace,
    policy,
    delivery,
    resourceSelectorEnabled ? resourceSelector : undefined,
  );
  return {
    workspace,
    ...(planWorktreeManager ? { planWorktreeManager } : {}),
    workspaceUid,
    worker,
    plans,
    policy,
    compatibilityImplementationRoutes,
    compatibilityReviewRoutes,
    implementationRoutes,
    reviewRoutes,
    automationProjectKeys,
    literalWorktreeProjectKeys,
    requireDelivery: defaultPolicy.requireDelivery === true,
    routeModels: Object.fromEntries(
      [...implementationSpecs, ...reviewSpecs].map(({ route, model }) => [route, model]),
    ),
    resourceSelectorEnabled,
    resources,
    liteLlmResources,
    resourceSelector,
    resourceState,
    resourceStateEffect,
    resourceLifecycle,
    runtimeAdmissionEnabled,
    runtimeAdmission,
    runtimeAdmissionHasDemand,
    reconcileRuntimeAdmission,
    shutdownRuntimeAdmission,
  };
}

