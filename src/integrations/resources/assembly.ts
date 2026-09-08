import fs from 'node:fs';
import path from 'node:path';

import type { ExecutionResource } from '../../core/domain/resourceRouting.js';
import type { ForgeFlowRepositories } from '../../core/persistence/repositories.js';
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
} from './resourceDirectory.js';

export interface ResourceIntegrationOptions {
  enabled: boolean;
  repositories: ForgeFlowRepositories;
  liteLlmAdminBaseUrl: string;
  liteLlmBaseUrl: string;
  liteLlmApiKey: string;
  adminEnvFile: string;
  adminKeyName: string;
  directoryTimeoutMs: number;
  probeTimeoutMs: number;
  fetchImpl: typeof fetch;
  businessEnabled: boolean;
  businessAuthFile: string;
  antigravityEnabled: boolean;
  antigravityBinary: string;
  antigravityHome: string;
}

export interface ResourceIntegrationAssembly {
  resources: CompositeResourceDirectory;
  liteLlmResources: LiteLlmResourceDirectory;
  resourceState: ResourceStateService;
  resourceStateEffect: LiteLlmResourceStateEffect;
  resourceLifecycle: ResourceLifecycleManager;
}

export async function buildResourceIntegrationAssembly(
  options: ResourceIntegrationOptions,
): Promise<ResourceIntegrationAssembly> {
  const liteLlmResources = new LiteLlmResourceDirectory({
    baseUrl: options.liteLlmAdminBaseUrl,
    envFile: options.adminEnvFile,
    keyName: options.adminKeyName,
    fetchImpl: options.fetchImpl,
    requestTimeoutMs: options.directoryTimeoutMs,
  });
  if (options.enabled) await liteLlmResources.refresh();

  const businessReady = options.businessEnabled && fs.existsSync(options.businessAuthFile);
  const antigravityAuthFile = path.join(
    options.antigravityHome,
    '.gemini/antigravity-cli/antigravity-oauth-token',
  );
  const antigravityReady =
    options.antigravityEnabled &&
    fs.existsSync(options.antigravityBinary) &&
    fs.existsSync(antigravityAuthFile);
  const nativeResources = new StaticResourceDirectory(
    providerNativeResources({
      businessEnabled: options.businessEnabled,
      businessReady,
      antigravityEnabled: options.antigravityEnabled,
      antigravityReady,
    }),
  );
  const sourceResources = new CompositeResourceDirectory([liteLlmResources, nativeResources]);
  const resources = new CompositeResourceDirectory(
    [liteLlmResources, nativeResources],
    options.repositories.resourceStateOverrides,
  );

  const resourceStateEffect = new LiteLlmResourceStateEffect({
    baseUrl: options.liteLlmAdminBaseUrl,
    envFile: options.adminEnvFile,
    keyName: options.adminKeyName,
    fetchImpl: options.fetchImpl,
    requestTimeoutMs: options.directoryTimeoutMs,
  });
  const resourceState = new ResourceStateService(
    resources,
    options.repositories.resourceStateOverrides,
    3,
    resourceStateEffect,
  );
  const liteLlmResourceProbe = new LiteLlmResourceProbe({
    baseUrl: options.liteLlmBaseUrl,
    bearerToken: options.liteLlmApiKey,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.probeTimeoutMs,
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
    options.repositories.resourceStateOverrides,
    resourceProbe,
    resourceStateEffect,
  );
  return { resources, liteLlmResources, resourceState, resourceStateEffect, resourceLifecycle };
}
