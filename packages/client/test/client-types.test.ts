import { createForgeFlowClient, type ForgeFlowOperations } from '../src/index.js';

const client = createForgeFlowClient({ baseUrl: 'http://forgeflow.test' });

void client.GET('/api/v1/projects');
void client.GET('/api/v1/projects/{projectKey}', {
  params: { path: { projectKey: 'memoflow' } },
});
void client.GET('/api/v1/plans/{planId}', {
  params: { path: { planId: 'plan-example' } },
});

// @ts-expect-error Unknown routes are not part of the committed OpenAPI contract.
void client.GET('/api/v1/does-not-exist');

// @ts-expect-error Project lookup requires the generated path parameter.
void client.GET('/api/v1/projects/{projectKey}');


type ProjectsListOperation = ForgeFlowOperations['projectsList'];
type ProjectLookupOperation = ForgeFlowOperations['projectsGet'];
const projectsListOperation: ProjectsListOperation | undefined = undefined;
const projectLookupOperation: ProjectLookupOperation | undefined = undefined;
void projectsListOperation;
void projectLookupOperation;

// @ts-expect-error Semantic operation identities are closed over the generated registry.
type MissingOperation = ForgeFlowOperations['doesNotExist'];
