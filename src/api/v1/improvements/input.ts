import { ForgeFlowError } from '../../../core/domain/errors.js';
import type { ImprovementProgramInput } from '../../../application/improvements/index.js';
import { bodyRecord, requiredText } from '../../shared/input.js';

function optionalTextArray(value: unknown, code: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ForgeFlowError(code);
  return value.map((item) => requiredText(item, code));
}

function integer(value: unknown, fallback: number, code: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new ForgeFlowError(code);
  return value;
}

export function maintenanceProgramBody(value: unknown): ImprovementProgramInput {
  const body = bodyRecord(value);
  const scope = body.autonomousScope ?? 'CONSERVATIVE';
  if (scope !== 'CONSERVATIVE' && scope !== 'STANDARD')
    throw new ForgeFlowError('MAINTENANCE_PROGRAM_SCOPE_INVALID');
  const risk = body.candidateRisk ?? 'LOW';
  if (risk !== 'LOW' && risk !== 'MEDIUM' && risk !== 'HIGH')
    throw new ForgeFlowError('CANDIDATE_RISK_INVALID');
  const implementationRoutes = optionalTextArray(
    body.implementationRoutes,
    'MAINTENANCE_IMPLEMENTATION_ROUTE_INVALID',
  );
  const reviewRoutes = optionalTextArray(body.reviewRoutes, 'MAINTENANCE_REVIEW_ROUTE_INVALID');
  const failureCodePrefixes = optionalTextArray(
    body.failureCodePrefixes,
    'MAINTENANCE_FAILURE_PREFIX_INVALID',
  );
  return {
    programId: requiredText(body.programId, 'MAINTENANCE_PROGRAM_REQUIRED'),
    projectKey: requiredText(body.projectKey, 'PLAN_PROJECT_REQUIRED'),
    ...(typeof body.repositoryPath === 'string' && body.repositoryPath.trim()
      ? { repositoryPath: body.repositoryPath.trim() }
      : {}),
    ...(implementationRoutes ? { implementationRoutes } : {}),
    ...(reviewRoutes ? { reviewRoutes } : {}),
    autonomousScope: scope,
    autoMerge: body.autoMerge === true,
    enabled: body.enabled !== false,
    ...(failureCodePrefixes ? { failureCodePrefixes } : {}),
    failureThreshold: integer(body.failureThreshold, 3, 'MAINTENANCE_FAILURE_THRESHOLD_INVALID'),
    recentExecutionLimit: integer(
      body.recentExecutionLimit,
      200,
      'MAINTENANCE_EXECUTION_LIMIT_INVALID',
    ),
    candidateRisk: risk,
  };
}
