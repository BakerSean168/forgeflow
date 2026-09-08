import type { ExecutionResourceSelection } from '../../core/domain/resourceRouting.js';
import { ForgeFlowError } from '../../core/domain/errors.js';
import type { ExecutionProviderPort } from '../../core/orchestration/contracts.js';
import { CapabilityRegistry } from '../registry.js';
import {
  AntigravityExecutionProvider,
  AntigravityReviewProvider,
  type AntigravityProviderOptions,
} from './antigravity.js';
import {
  createOpenHandsProviderFactory,
  type OpenHandsAgentBackend,
  type OpenHandsProviderFactoryOptions,
} from './openHandsCoding.js';

export interface ExecutionProviderIntegrationOptions {
  openHands: OpenHandsProviderFactoryOptions;
  antigravity: Omit<AntigravityProviderOptions, 'model'>;
}

export function createExecutionProviderIntegrationRegistry(
  options: ExecutionProviderIntegrationOptions,
): CapabilityRegistry<ExecutionResourceSelection, ExecutionProviderPort> {
  const registry = new CapabilityRegistry<ExecutionResourceSelection, ExecutionProviderPort>();
  const openHandsFactory = createOpenHandsProviderFactory(options.openHands);

  registry.register({
    id: 'antigravity',
    supports: (selection) =>
      selection.agentBackend === 'antigravity-worker' || selection.agentBackend === 'antigravity-review',
    create: (selection) => {
      const providerOptions = { ...options.antigravity, model: selection.modelFamily };
      return selection.agentBackend === 'antigravity-review'
        ? new AntigravityReviewProvider(providerOptions)
        : new AntigravityExecutionProvider(providerOptions);
    },
  });

  registry.register({
    id: 'openhands',
    supports: (selection) =>
      selection.agentBackend !== 'antigravity-worker' &&
      selection.agentBackend !== 'antigravity-review',
    create: (selection) => {
      if (!['IMPLEMENT', 'IMPLEMENT_FIX', 'REVIEW'].includes(selection.phase))
        throw new ForgeFlowError('EXECUTION_RESOURCE_SELECTION_PHASE_UNSUPPORTED');
      return openHandsFactory({
        backend: selection.agentBackend as OpenHandsAgentBackend,
        model: selection.routeModel ?? selection.modelFamily,
        modelFamily: selection.modelFamily,
        transport: selection.transport,
        phase: selection.phase as 'IMPLEMENT' | 'IMPLEMENT_FIX' | 'REVIEW',
        capability: selection.capability,
        resourceId: selection.resourceId,
      });
    },
  });

  return registry;
}

/** Compatibility-only selector-off route construction. New executions use the governed capability registry above. */
export function createLegacyOpenHandsRouteProvider(
  options: OpenHandsProviderFactoryOptions,
  input: { role: 'IMPLEMENTATION' | 'REVIEW'; route: string; model: string },
): ExecutionProviderPort {
  const factory = createOpenHandsProviderFactory(options);
  if (input.role === 'IMPLEMENTATION') {
    return factory({
      backend: input.model === 'gpt-5.6-luna' ? 'codex-acp' : 'openhands-builtin',
      model: input.model,
      modelFamily: input.model,
      transport: 'LITELLM_MANAGED',
      phase: 'IMPLEMENT',
      capability: 'IMPLEMENTATION',
      resourceId: 'legacy-selector-off',
    });
  }
  return factory({
    backend: input.route === 'codex-business-review' ? 'codex-acp' : 'openhands-builtin',
    model: input.model,
    modelFamily: input.model,
    transport: input.route === 'codex-business-review' ? 'PROVIDER_NATIVE' : 'LITELLM_MANAGED',
    phase: 'REVIEW',
    capability: 'REASONING',
    resourceId: 'legacy-selector-off',
  });
}
