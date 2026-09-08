import { ForgeFlowError } from '../core/domain/errors.js';

export interface CapabilityAdapter<TInput, TOutput> {
  readonly id: string;
  supports(input: TInput): boolean;
  create(input: TInput): TOutput;
}

export class CapabilityRegistry<TInput, TOutput> {
  private readonly adapters = new Map<string, CapabilityAdapter<TInput, TOutput>>();

  register(adapter: CapabilityAdapter<TInput, TOutput>): void {
    if (!adapter.id.trim()) throw new ForgeFlowError('INTEGRATION_ID_REQUIRED');
    if (this.adapters.has(adapter.id)) throw new ForgeFlowError('INTEGRATION_ID_DUPLICATE');
    this.adapters.set(adapter.id, adapter);
  }

  resolve(input: TInput): TOutput {
    const matches = [...this.adapters.values()].filter((adapter) => adapter.supports(input));
    if (matches.length === 0) throw new ForgeFlowError('INTEGRATION_CAPABILITY_UNSUPPORTED');
    if (matches.length > 1) throw new ForgeFlowError('INTEGRATION_CAPABILITY_AMBIGUOUS');
    return matches[0]!.create(input);
  }

  ids(): string[] {
    return [...this.adapters.keys()].sort();
  }
}
