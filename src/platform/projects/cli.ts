import { loadProjectManifest } from './load.js';

function usage(): never {
  throw new Error(
    'usage: project manifest cli <file> <automation-projects|literal-projects|literal-repositories|write-paths|provider-native-projects|improvement-projects> [allowed-root ...]',
  );
}

const [file, query, ...allowedRoots] = process.argv.slice(2);
if (!file || !query) usage();
const registry = loadProjectManifest(file, allowedRoots);
const lines = (() => {
  switch (query) {
    case 'automation-projects':
      return registry.automationProjectKeys();
    case 'literal-projects':
      return registry.literalWorktreeProjectKeys();
    case 'literal-repositories':
      return registry
        .list()
        .filter(
          (project) =>
            project.execution.enabled && project.execution.workspace === 'literal-worktree',
        )
        .map((project) => project.repositoryPath)
        .filter((value): value is string => Boolean(value));
    case 'write-paths':
      return registry
        .list()
        .filter((project) => project.execution.enabled)
        .map((project) => project.repositoryPath)
        .filter((value): value is string => Boolean(value));
    case 'provider-native-projects':
      return registry.providerNativeProjectKeys();
    case 'improvement-projects':
      return registry.improvementProjectKeys();
    default:
      return usage();
  }
})();
for (const line of lines) process.stdout.write(line + '\n');
