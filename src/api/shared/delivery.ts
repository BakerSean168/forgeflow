import type { PlanDeliveryConfig } from '../../core/domain/delivery.js';
import { ForgeFlowError } from '../../core/domain/errors.js';
import { bodyRecord, requiredText } from './input.js';

export function planDeliveryConfig(value: unknown): PlanDeliveryConfig | undefined {
  if (value === undefined || value === null) return undefined;
  const body = bodyRecord(value);
  if (typeof body.autoMerge !== 'boolean') throw new ForgeFlowError('DELIVERY_AUTO_MERGE_INVALID');
  const mergeMethod = requiredText(body.mergeMethod ?? 'merge', 'DELIVERY_MERGE_METHOD_INVALID');
  if (mergeMethod !== 'merge' && mergeMethod !== 'squash' && mergeMethod !== 'rebase')
    throw new ForgeFlowError('DELIVERY_MERGE_METHOD_INVALID');
  const requiredChecks =
    body.requiredChecks === undefined
      ? []
      : Array.isArray(body.requiredChecks)
        ? body.requiredChecks.map((item) => requiredText(item, 'DELIVERY_REQUIRED_CHECKS_INVALID'))
        : (() => {
            throw new ForgeFlowError('DELIVERY_REQUIRED_CHECKS_INVALID');
          })();
  return {
    remote: requiredText(body.remote ?? 'origin', 'DELIVERY_REMOTE_REQUIRED'),
    branch: requiredText(body.branch, 'DELIVERY_BRANCH_REQUIRED'),
    targetBranch: requiredText(body.targetBranch ?? 'main', 'DELIVERY_TARGET_BRANCH_REQUIRED'),
    autoMerge: body.autoMerge,
    mergeMethod,
    requiredChecks,
  };
}
