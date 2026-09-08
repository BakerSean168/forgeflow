import type { DeliveryAutomationPort } from '../../core/orchestration/contracts.js';
import { GitHubCliDeliveryAdapter } from './githubDelivery.js';

export interface DeliveryIntegrationOptions {
  allowedRepositoryRoots: string[];
  allowedWorkspaceRoots?: string[];
  commandTimeoutMs: number;
  maxBufferBytes: number;
}

export function buildDeliveryIntegration(
  options: DeliveryIntegrationOptions,
): DeliveryAutomationPort {
  return new GitHubCliDeliveryAdapter({
    allowedRepositoryRoots: options.allowedRepositoryRoots,
    allowedWorkspaceRoots: options.allowedWorkspaceRoots,
    commandTimeoutMs: options.commandTimeoutMs,
    maxBufferBytes: options.maxBufferBytes,
  });
}
