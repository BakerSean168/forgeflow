import type { DeliveryAutomationPort } from '../../core/orchestration/contracts.js';
import { GitHubCliDeliveryAdapter } from './githubDelivery.js';

export interface DeliveryIntegrationOptions {
  allowedRepositoryRoots: string[];
  commandTimeoutMs: number;
  maxBufferBytes: number;
}

export function buildDeliveryIntegration(
  options: DeliveryIntegrationOptions,
): DeliveryAutomationPort {
  return new GitHubCliDeliveryAdapter({
    allowedRepositoryRoots: options.allowedRepositoryRoots,
    commandTimeoutMs: options.commandTimeoutMs,
    maxBufferBytes: options.maxBufferBytes,
  });
}
