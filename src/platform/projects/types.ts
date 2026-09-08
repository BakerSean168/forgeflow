export const PROJECT_MANIFEST_VERSION = 1 as const;

export const PROJECT_WORKSPACE_MODES = ['canonical-fast-forward', 'literal-worktree'] as const;
export type ProjectWorkspaceMode = (typeof PROJECT_WORKSPACE_MODES)[number];

export interface ProjectExecutionConfig {
  enabled: boolean;
  workspace: ProjectWorkspaceMode;
  allowProviderNative: boolean;
  maxParallelWorkItems?: number;
}

export interface ProjectImprovementConfig {
  enabled: boolean;
}

export interface ForgeFlowProjectDefinition {
  projectKey: string;
  repositoryPath?: string;
  displayName?: string;
  description?: string;
  tags: string[];
  execution: ProjectExecutionConfig;
  improvement: ProjectImprovementConfig;
  source: 'manifest' | 'legacy-env';
}

export interface ForgeFlowProjectManifest {
  version: typeof PROJECT_MANIFEST_VERSION;
  projects: ForgeFlowProjectDefinition[];
}
