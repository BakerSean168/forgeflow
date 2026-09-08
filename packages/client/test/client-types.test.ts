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

type ResourceStateBody = ForgeFlowOperations['resourcesSetState']['requestBody']['content']['application/json'];
const legacyCompatibleResourceState: ResourceStateBody = {
  state: 'disabled',
  expectedVersion: '0',
  extraLegacyField: true,
};
void legacyCompatibleResourceState;

type ReleaseAcceptanceBody = ForgeFlowOperations['releaseAcceptanceRecordAutonomousLifecycle']['requestBody']['content']['application/json'];
const releaseAcceptanceBody: ReleaseAcceptanceBody = {
  planId: 'plan-example',
  sourceSha: 'source-sha',
  artifactSha256: 'artifact-sha',
  canonicalHead: 'canonical-head',
  externalChecks: ['provider-cleanup'],
};
void releaseAcceptanceBody;

// @ts-expect-error Release attestation requires the external evidence list documented by the runtime contract.
const incompleteReleaseAcceptanceBody: ReleaseAcceptanceBody = {
  planId: 'plan-example',
  sourceSha: 'source-sha',
  artifactSha256: 'artifact-sha',
  canonicalHead: 'canonical-head',
};
void incompleteReleaseAcceptanceBody;

type ResourceListResponse = ForgeFlowOperations['resourcesList']['responses'][200]['content']['application/json'];
declare const resourceListResponse: ResourceListResponse;
const resourceCount: number = resourceListResponse.count;
const resourceState: 'ACTIVE' | 'SUSPENDED' | 'DISABLED' = resourceListResponse.items[0]!.state;
void resourceCount;
void resourceState;
