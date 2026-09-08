import path from 'node:path';

import { ForgeFlowError } from '../../core/domain/errors.js';
import type { ForgeFlowProjectDefinition } from './types.js';

export class ProjectRegistry {
  readonly #projects: ReadonlyMap<string, ForgeFlowProjectDefinition>;

  constructor(projects: readonly ForgeFlowProjectDefinition[]) {
    const byKey = new Map<string, ForgeFlowProjectDefinition>();
    const repositories = new Map<string, string>();
    for (const project of projects) {
      if (byKey.has(project.projectKey)) throw new ForgeFlowError('PROJECT_REGISTRY_DUPLICATE_KEY');
      if (project.repositoryPath) {
        const existing = repositories.get(project.repositoryPath);
        if (existing && existing !== project.projectKey)
          throw new ForgeFlowError('PROJECT_REGISTRY_DUPLICATE_REPOSITORY');
        repositories.set(project.repositoryPath, project.projectKey);
      }
      byKey.set(
        project.projectKey,
        Object.freeze({
          ...project,
          tags: Object.freeze([...project.tags]) as string[],
          execution: Object.freeze({ ...project.execution }),
          improvement: Object.freeze({ ...project.improvement }),
        }),
      );
    }
    this.#projects = byKey;
  }

  list(): ForgeFlowProjectDefinition[] {
    return [...this.#projects.values()]
      .map((project) => ({ ...project, tags: [...project.tags], execution: { ...project.execution }, improvement: { ...project.improvement } }))
      .sort((left, right) => left.projectKey.localeCompare(right.projectKey));
  }

  get(projectKey: string): ForgeFlowProjectDefinition | undefined {
    const project = this.#projects.get(projectKey);
    return project
      ? { ...project, tags: [...project.tags], execution: { ...project.execution }, improvement: { ...project.improvement } }
      : undefined;
  }

  require(projectKey: string): ForgeFlowProjectDefinition {
    const project = this.get(projectKey);
    if (!project) throw new ForgeFlowError('PROJECT_NOT_FOUND');
    return project;
  }

  resolveRepository(projectKey: string, requested?: string): string | undefined {
    const project = this.get(projectKey);
    if (!project) {
      if (this.source() === 'manifest') throw new ForgeFlowError('PROJECT_NOT_FOUND');
      return requested;
    }
    if (!project.repositoryPath) return requested;
    if (requested && path.normalize(requested) !== path.normalize(project.repositoryPath))
      throw new ForgeFlowError('PROJECT_REPOSITORY_MISMATCH');
    return project.repositoryPath;
  }

  automationProjectKeys(): string[] {
    return this.list().filter((project) => project.execution.enabled).map((project) => project.projectKey);
  }

  literalWorktreeProjectKeys(): string[] {
    return this.list()
      .filter((project) => project.execution.enabled && project.execution.workspace === 'literal-worktree')
      .map((project) => project.projectKey);
  }

  providerNativeProjectKeys(): string[] {
    return this.list()
      .filter((project) => project.execution.enabled && project.execution.allowProviderNative)
      .map((project) => project.projectKey);
  }

  improvementProjectKeys(): string[] {
    return this.list().filter((project) => project.improvement.enabled).map((project) => project.projectKey);
  }

  source(): 'manifest' | 'legacy-env' | 'empty' {
    const sources = new Set(this.list().map((project) => project.source));
    if (sources.size === 0) return 'empty';
    return sources.has('manifest') ? 'manifest' : 'legacy-env';
  }
}
