import type { FastifyPluginAsync } from 'fastify';

import type { ProjectRegistry } from '../../platform/projects/index.js';

export interface ProjectRoutesOptions {
  projects: ProjectRegistry;
}

const projectSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['projectKey', 'repositoryPath', 'tags', 'execution', 'improvement', 'source'],
  properties: {
    projectKey: { type: 'string' },
    repositoryPath: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    displayName: { type: 'string' },
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    execution: {
      type: 'object',
      additionalProperties: false,
      required: ['enabled', 'workspace', 'allowProviderNative', 'maxParallelWorkItems'],
      properties: {
        enabled: { type: 'boolean' },
        workspace: { type: 'string', enum: ['canonical-fast-forward', 'literal-worktree'] },
        allowProviderNative: { type: 'boolean' },
        maxParallelWorkItems: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
      },
    },
    improvement: {
      type: 'object',
      additionalProperties: false,
      required: ['enabled'],
      properties: { enabled: { type: 'boolean' } },
    },
    source: { type: 'string', enum: ['manifest', 'legacy-env'] },
  },
} as const;

function projection(project: ReturnType<ProjectRegistry['require']>) {
  return {
    projectKey: project.projectKey,
    repositoryPath: project.repositoryPath ?? null,
    ...(project.displayName ? { displayName: project.displayName } : {}),
    ...(project.description ? { description: project.description } : {}),
    tags: project.tags,
    execution: {
      enabled: project.execution.enabled,
      workspace: project.execution.workspace,
      allowProviderNative: project.execution.allowProviderNative,
      maxParallelWorkItems: project.execution.maxParallelWorkItems ?? null,
    },
    improvement: { enabled: project.improvement.enabled },
    source: project.source,
  };
}

export const projectRoutes: FastifyPluginAsync<ProjectRoutesOptions> = async (app, options) => {
  app.get(
    '/',
    {
      prefixTrailingSlash: 'no-slash',
      schema: {
        tags: ['Projects'],
        summary: 'List registered ForgeFlow projects',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items', 'count', 'source'],
            properties: {
              items: { type: 'array', items: projectSchema },
              count: { type: 'integer' },
              source: { type: 'string', enum: ['manifest', 'legacy-env', 'empty'] },
            },
          },
        },
      },
    },
    async () => {
      const items = options.projects.list().map(projection);
      return { items, count: items.length, source: options.projects.source() };
    },
  );

  app.get(
    '/:projectKey',
    {
      schema: {
        tags: ['Projects'],
        summary: 'Get one registered ForgeFlow project',
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['projectKey'],
          properties: { projectKey: { type: 'string', minLength: 1, maxLength: 128 } },
        },
        response: { 200: projectSchema },
      },
    },
    async (request) => {
      const { projectKey } = request.params as { projectKey: string };
      return projection(options.projects.require(projectKey));
    },
  );
};

export function createProjectApiModule(projects: ProjectRegistry) {
  return {
    id: 'projects',
    apiVersion: 1 as const,
    register: async (app: import('fastify').FastifyInstance) => {
      await app.register(projectRoutes, { prefix: '/api/v1/projects', projects });
    },
  };
}
