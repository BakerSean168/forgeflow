import { ForgeFlowError } from '../../core/domain/errors.js';

export function bodyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ForgeFlowError('REQUEST_BODY_INVALID');
  return value as Record<string, unknown>;
}

export function requiredText(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ForgeFlowError(code);
  return value.trim();
}
