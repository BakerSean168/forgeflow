import { ForgeFlowError } from '../../../core/domain/errors.js';
import type { PlanGraphItemInput } from '../../../application/plans/index.js';
import { bodyRecord, requiredText } from '../../shared/input.js';

export function integerInput(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  code: string,
): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new ForgeFlowError(code);
  return parsed;
}

export function graphItems(
  value: unknown,
  fallback: { title: string; objective: string },
): PlanGraphItemInput[] {
  const raw = Array.isArray(value)
    ? value
    : [
        {
          itemKey: 'objective',
          title: fallback.title,
          objective: fallback.objective,
          dependencies: [],
          acceptanceCriteria: [],
        },
      ];
  return raw.map((item) => {
    const entry = bodyRecord(item);
    return {
      itemKey: requiredText(entry.itemKey, 'GRAPH_ITEM_KEY_REQUIRED'),
      title: requiredText(entry.title, 'GRAPH_TITLE_REQUIRED'),
      objective: requiredText(entry.objective, 'GRAPH_ITEM_OBJECTIVE_REQUIRED'),
      dependencies: Array.isArray(entry.dependencies)
        ? entry.dependencies.map((dependency) => requiredText(dependency, 'GRAPH_DEPENDENCY_INVALID'))
        : [],
      acceptanceCriteria: Array.isArray(entry.acceptanceCriteria)
        ? entry.acceptanceCriteria.map((criterion) => requiredText(criterion, 'GRAPH_ACCEPTANCE_INVALID'))
        : [],
      parallelSafe: entry.parallelSafe === true,
      writeScopes: Array.isArray(entry.writeScopes)
        ? entry.writeScopes.map((scope) => requiredText(scope, 'WORK_ITEM_WRITE_SCOPES_INVALID'))
        : [],
      conflictKeys: Array.isArray(entry.conflictKeys)
        ? entry.conflictKeys.map((key) => requiredText(key, 'WORK_ITEM_CONFLICT_KEYS_INVALID'))
        : [],
    };
  });
}
