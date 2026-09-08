import fs from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';

import { ForgeFlowError } from '../../core/domain/errors.js';
import { ProjectRegistry } from './registry.js';
import {
  PROJECT_MANIFEST_VERSION,
  PROJECT_WORKSPACE_MODES,
  type ForgeFlowProjectDefinition,
  type ProjectWorkspaceMode,
} from './types.js';

const PROJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ForgeFlowError(code);
  return value as Record<string, unknown>;
}

function text(value: unknown, code: string, maximum = 500): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maximum)
    throw new ForgeFlowError(code);
  return value.trim();
}

function optionalText(value: unknown, code: string, maximum = 500): string | undefined {
  return value === undefined || value === null ? undefined : text(value, code, maximum);
}

function boolean(value: unknown, fallback: boolean, code: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new ForgeFlowError(code);
  return value;
}

function stringList(value: unknown, code: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ForgeFlowError(code);
  const items = value.map((item) => text(item, code, 100));
  if (new Set(items).size !== items.length) throw new ForgeFlowError(code);
  return items;
}

function commaList(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(',').map((item) => item.trim()).filter(Boolean))];
}

function isInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function canonicalPath(value: string): string {
  const normalized = path.normalize(value);
  try {
    return fs.realpathSync(normalized);
  } catch {
    return normalized;
  }
}

function normalizeRepositoryPath(value: unknown, allowedRoots: readonly string[]): string {
  const raw = text(value, 'PROJECT_REPOSITORY_REQUIRED', 4096);
  if (!path.isAbsolute(raw)) throw new ForgeFlowError('PROJECT_REPOSITORY_ABSOLUTE_REQUIRED');
  const repositoryPath = canonicalPath(raw);
  if (
    allowedRoots.length > 0 &&
    !allowedRoots.some((root) => isInsideRoot(repositoryPath, canonicalPath(path.resolve(root))))
  )
    throw new ForgeFlowError('PROJECT_REPOSITORY_OUTSIDE_ALLOWED_ROOT');
  return repositoryPath;
}

function manifestProject(value: unknown, allowedRoots: readonly string[]): ForgeFlowProjectDefinition {
  const item = record(value, 'PROJECT_MANIFEST_PROJECT_INVALID');
  const projectKey = text(item.projectKey, 'PROJECT_KEY_REQUIRED', 128);
  if (!PROJECT_KEY.test(projectKey)) throw new ForgeFlowError('PROJECT_KEY_INVALID');
  const execution = record(item.execution ?? {}, 'PROJECT_EXECUTION_CONFIG_INVALID');
  const improvement = record(item.improvement ?? {}, 'PROJECT_IMPROVEMENT_CONFIG_INVALID');
  const workspaceValue = execution.workspace ?? 'canonical-fast-forward';
  if (typeof workspaceValue !== 'string' || !PROJECT_WORKSPACE_MODES.includes(workspaceValue as ProjectWorkspaceMode))
    throw new ForgeFlowError('PROJECT_WORKSPACE_MODE_INVALID');
  const maxParallelWorkItems = execution.maxParallelWorkItems;
  if (
    maxParallelWorkItems !== undefined &&
    (!Number.isInteger(maxParallelWorkItems) || Number(maxParallelWorkItems) < 1 || Number(maxParallelWorkItems) > 64)
  )
    throw new ForgeFlowError('PROJECT_PARALLELISM_INVALID');
  const enabled = boolean(execution.enabled, false, 'PROJECT_EXECUTION_ENABLED_INVALID');
  const repositoryPath = normalizeRepositoryPath(item.repositoryPath, allowedRoots);
  return {
    projectKey,
    repositoryPath,
    ...(optionalText(item.displayName, 'PROJECT_DISPLAY_NAME_INVALID', 200)
      ? { displayName: optionalText(item.displayName, 'PROJECT_DISPLAY_NAME_INVALID', 200)! }
      : {}),
    ...(optionalText(item.description, 'PROJECT_DESCRIPTION_INVALID', 1000)
      ? { description: optionalText(item.description, 'PROJECT_DESCRIPTION_INVALID', 1000)! }
      : {}),
    tags: stringList(item.tags, 'PROJECT_TAGS_INVALID'),
    execution: {
      enabled,
      workspace: workspaceValue as ProjectWorkspaceMode,
      allowProviderNative: boolean(
        execution.allowProviderNative,
        false,
        'PROJECT_PROVIDER_NATIVE_INVALID',
      ),
      ...(maxParallelWorkItems === undefined
        ? {}
        : { maxParallelWorkItems: Number(maxParallelWorkItems) }),
    },
    improvement: {
      enabled: boolean(improvement.enabled, false, 'PROJECT_IMPROVEMENT_ENABLED_INVALID'),
    },
    source: 'manifest',
  };
}

export function loadProjectManifest(file: string, allowedRoots: readonly string[]): ProjectRegistry {
  const resolved = path.resolve(file);
  let raw: unknown;
  try {
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
      throw new ForgeFlowError('PROJECT_MANIFEST_FILE_INVALID');
    raw = YAML.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    if (error instanceof ForgeFlowError) throw error;
    throw new ForgeFlowError('PROJECT_MANIFEST_READ_FAILED');
  }
  const root = record(raw, 'PROJECT_MANIFEST_INVALID');
  if (root.version !== PROJECT_MANIFEST_VERSION) throw new ForgeFlowError('PROJECT_MANIFEST_VERSION_UNSUPPORTED');
  if (!Array.isArray(root.projects)) throw new ForgeFlowError('PROJECT_MANIFEST_PROJECTS_INVALID');
  return new ProjectRegistry(root.projects.map((project) => manifestProject(project, allowedRoots)));
}

export function projectRegistryFromLegacyEnv(env: NodeJS.ProcessEnv): ProjectRegistry {
  const automation = commaList(env.FORGEFLOW_AUTOMATION_PROJECTS);
  const literal = commaList(env.FORGEFLOW_LITERAL_WORKTREE_PROJECTS);
  const providerNative = commaList(env.FORGEFLOW_ANTIGRAVITY_PROJECTS);
  const improvement = commaList(env.FORGEFLOW_IMPROVEMENT_PROJECTS);
  const repositoryValues = commaList(env.FORGEFLOW_LITERAL_WORKTREE_REPOSITORIES);
  const repositoryByProject = new Map<string, string>();
  if (literal.length === repositoryValues.length)
    literal.forEach((projectKey, index) => repositoryByProject.set(projectKey, path.resolve(repositoryValues[index]!)));
  const keys = [...new Set([...automation, ...literal, ...providerNative, ...improvement])];
  return new ProjectRegistry(
    keys.map((projectKey) => ({
      projectKey,
      ...(repositoryByProject.get(projectKey) ? { repositoryPath: repositoryByProject.get(projectKey)! } : {}),
      tags: [],
      execution: {
        enabled: automation.includes(projectKey),
        workspace: literal.includes(projectKey) ? 'literal-worktree' : 'canonical-fast-forward',
        allowProviderNative: providerNative.includes(projectKey),
      },
      improvement: { enabled: improvement.includes(projectKey) },
      source: 'legacy-env' as const,
    })),
  );
}

export function loadProjectRegistry(
  env: NodeJS.ProcessEnv,
  allowedRoots: readonly string[],
): ProjectRegistry {
  return env.FORGEFLOW_PROJECTS_FILE
    ? loadProjectManifest(env.FORGEFLOW_PROJECTS_FILE, allowedRoots)
    : projectRegistryFromLegacyEnv(env);
}
