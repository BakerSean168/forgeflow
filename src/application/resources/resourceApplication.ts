import type { ForgeFlowRepositories } from '../../core/persistence/repositories.js';
import { ForgeFlowError } from '../../core/domain/errors.js';
import {
  DEFAULT_AFFINITY_POLICY,
  type ExecutionResource,
  type ResourceState,
} from '../../core/domain/resourceRouting.js';

export interface ResourceRuntimePort {
  resourceSelectorEnabled: boolean;
  resources: { listResources(): readonly ExecutionResource[] };
  liteLlmResources: { refresh(): Promise<unknown> };
  resourceState: {
    manual(
      resourceId: string,
      state: ResourceState,
      options: {
        reason?: string;
        suspendedUntil?: string;
        expectedVersion?: number;
      },
    ): { status: string; reason?: string };
  };
  resourceStateEffect: {
    applyBinding?: (
      resource: ExecutionResource,
      binding: ExecutionResource['bindings'][number],
      state: 'ACTIVE' | 'DISABLED',
    ) => Promise<unknown>;
  };
  runtimeAdmission: {
    invalidateResource(resourceId: string): void;
    invalidateBinding(resourceId: string, bindingId: string): void;
  };
}

export interface ResourceApplicationDependencies {
  repositories: ForgeFlowRepositories;
  requireRuntime(): ResourceRuntimePort;
  invalidateSupervisorResource(resourceId: string): void;
  runtimeAdmission: { request(): Promise<void> };
  reconcileSupervisorReadiness(): Promise<{ becameAvailable: string[]; scheduledWakes: number }>;
}

export interface ResourceStateChangeInput {
  resourceId: string;
  state: ResourceState;
  reason?: string;
  suspendedUntil?: string;
  expectedVersion?: number;
}

export interface BindingStateChangeInput {
  resourceId: string;
  bindingId: string;
  state: 'ACTIVE' | 'DISABLED';
}

const affinityEntries = [
  ...DEFAULT_AFFINITY_POLICY.capabilities.IMPLEMENTATION,
  ...DEFAULT_AFFINITY_POLICY.capabilities.REASONING,
  ...(DEFAULT_AFFINITY_POLICY.providerNativeProfiles ?? []),
];

export class ResourceApplication {
  constructor(private readonly dependencies: ResourceApplicationDependencies) {}

  async list() {
    const runtime = this.dependencies.requireRuntime();
    if (runtime.resourceSelectorEnabled) await runtime.liteLlmResources.refresh();
    const resources = runtime.resources.listResources();
    return { items: resources.map((resource) => this.project(resource)), count: resources.length };
  }

  async setResourceState(input: ResourceStateChangeInput) {
    const runtime = this.dependencies.requireRuntime();
    const resource = this.requireResource(runtime, input.resourceId);
    const result = runtime.resourceState.manual(input.resourceId, input.state, {
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.suspendedUntil ? { suspendedUntil: input.suspendedUntil } : {}),
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
    });
    if (result.status === 'rejected')
      throw new ForgeFlowError(result.reason ?? 'STALE_RESOURCE_STATE');

    this.dependencies.invalidateSupervisorResource(input.resourceId);
    this.dependencies.repositories.runtimeAdmissions.invalidateResource(input.resourceId);
    runtime.runtimeAdmission.invalidateResource(input.resourceId);
    await this.dependencies.runtimeAdmission.request();
    const resourceWake = await this.dependencies.reconcileSupervisorReadiness();
    return {
      resource: this.project(this.requireResource(runtime, input.resourceId)),
      mutation: result.status,
      resourceWake,
    };
  }

  async setBindingState(input: BindingStateChangeInput) {
    const runtime = this.dependencies.requireRuntime();
    const resource = this.requireResource(runtime, input.resourceId);
    const binding = resource.bindings.find((item) => item.bindingId === input.bindingId);
    if (!binding) throw new ForgeFlowError('RESOURCE_BINDING_NOT_FOUND');
    if (!runtime.resourceStateEffect.applyBinding || !binding.deploymentId)
      throw new ForgeFlowError('RESOURCE_BINDING_STATE_UNSUPPORTED');

    await runtime.resourceStateEffect.applyBinding(resource, binding, input.state);
    await runtime.liteLlmResources.refresh();
    this.dependencies.invalidateSupervisorResource(input.resourceId);
    this.dependencies.repositories.runtimeAdmissions.invalidateBinding(input.resourceId, input.bindingId);
    runtime.runtimeAdmission.invalidateBinding(input.resourceId, input.bindingId);
    await this.dependencies.runtimeAdmission.request();
    const resourceWake = await this.dependencies.reconcileSupervisorReadiness();
    return {
      resource: this.project(this.requireResource(runtime, input.resourceId)),
      bindingId: input.bindingId,
      state: input.state,
      resourceWake,
    };
  }

  private requireResource(runtime: ResourceRuntimePort, resourceId: string): ExecutionResource {
    const resource = runtime.resources.listResources().find((item) => item.resourceId === resourceId);
    if (!resource) throw new ForgeFlowError('RESOURCE_NOT_FOUND');
    return resource;
  }

  private project(resource: ExecutionResource) {
    const override = this.dependencies.repositories.resourceStateOverrides.get(resource.resourceId);
    return {
      resourceId: resource.resourceId,
      displayName: resource.displayName ?? resource.providerId ?? resource.resourceId,
      providerKey: resource.providerId ?? null,
      resourceTier: resource.resourceTier,
      resourceSequence: resource.resourceSequence,
      state: resource.state,
      transport: resource.bindings[0]?.transport ?? 'LITELLM_MANAGED',
      modelBindings: resource.bindings.map((binding) => {
        const affinity = affinityEntries.find(
          (item) =>
            item.modelFamily === binding.modelFamily &&
            (!binding.agentBackend || item.agentBackend === binding.agentBackend),
        );
        return {
          modelFamily: binding.modelFamily,
          capability: affinity?.capability ?? null,
          agentBackend: binding.agentBackend ?? affinity?.agentBackend ?? null,
          modelRank: affinity?.modelRank ?? null,
          enabled: binding.enabled,
          ready: binding.ready,
          deploymentId: binding.deploymentId ?? null,
          routeModel: binding.routeModel ?? null,
          protocol: binding.protocol ?? null,
        };
      }),
      lastNormalizedFailure: override?.reasonClass
        ? {
            reasonClass: override.reasonClass,
            sanitizedReason: override.sanitizedReason ?? null,
            changedAt: override.updatedAt,
            source: override.source,
          }
        : null,
      suspendedUntil: override?.suspendedUntil ?? null,
      version: override?.version ?? 0,
    };
  }
}
