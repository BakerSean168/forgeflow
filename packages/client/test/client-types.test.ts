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

type PlanCreateBody = ForgeFlowOperations['plansCreate']['requestBody']['content']['application/json'];
const minimalPlanCreateBody: PlanCreateBody = {
  projectKey: 'memoflow',
  objective: 'implement typed API client',
  baseRevision: 'deadbeef',
};
void minimalPlanCreateBody;

const planCreateWithLegacyPriority: PlanCreateBody = {
  ...minimalPlanCreateBody,
  priority: '10',
  workItems: [
    {
      itemKey: 'typed-client',
      title: 'Typed client',
      objective: 'Harden the contract',
      parallelSafe: true,
    },
  ],
};
void planCreateWithLegacyPriority;

type PlanListQuery = NonNullable<ForgeFlowOperations['plansList']['parameters']['query']>;
const planListQuery: PlanListQuery = { limit: '100', status: 'RUNNING', view: 'summary' };
void planListQuery;

// @ts-expect-error Plan status is closed over the documented durable status set.
const invalidPlanListQuery: PlanListQuery = { status: 'NOT_A_STATUS' };
void invalidPlanListQuery;

type ExecutionListQuery = NonNullable<ForgeFlowOperations['executionsList']['parameters']['query']>;
const executionListQuery: ExecutionListQuery = { planId: 'plan-example', status: 'RUNNING', view: 'dashboard' };
void executionListQuery;

// Optional legacy bodies remain optional in the generated client.
void client.POST('/api/v1/plans/{planId}/reconcile', {
  params: { path: { planId: 'plan-example' } },
});
void client.POST('/api/v1/executions/{executionId}/continue', {
  params: { path: { executionId: 'execution-example' } },
});
void client.POST('/api/v1/executions/{executionId}/replace-provider-session', {
  params: {
    path: { executionId: 'execution-example' },
    header: { 'idempotency-key': 'replacement-key' },
  },
});


type ImprovementListQuery = NonNullable<ForgeFlowOperations['improvementsList']['parameters']['query']>;
const improvementListQuery: ImprovementListQuery = {
  programId: 'forgeflow-maintenance',
  status: 'DISCOVERED',
  limit: '25',
};
void improvementListQuery;

// @ts-expect-error Improvement status is closed over the durable candidate state set.
const invalidImprovementStatus: ImprovementListQuery = { status: 'NOT_A_STATUS' };
void invalidImprovementStatus;

type ImprovementDiscoverBody = ForgeFlowOperations['improvementsDiscover']['requestBody']['content']['application/json'];
const improvementDiscoverBody: ImprovementDiscoverBody = {
  programId: 'forgeflow-maintenance',
  projectKey: 'forgeflow',
  autonomousScope: 'CONSERVATIVE',
  candidateRisk: 'LOW',
};
void improvementDiscoverBody;

// @ts-expect-error Discovery requires both the program and project authority.
const incompleteImprovementDiscoverBody: ImprovementDiscoverBody = { programId: 'forgeflow-maintenance' };
void incompleteImprovementDiscoverBody;

// Improvement adoption preserves the legacy absent-body path.
void client.POST('/api/v1/improvements/{candidateId}/adopt', {
  params: { path: { candidateId: 'candidate-example' } },
});
void client.POST('/api/v1/improvements/{candidateId}/adopt', {
  params: { path: { candidateId: 'candidate-example' } },
  body: null,
});

type SupervisorDecisionBody = ForgeFlowOperations['supervisorsDecide']['requestBody']['content']['application/json'];
const supervisorDecisionBody: SupervisorDecisionBody = {
  version: 1,
  planId: 'plan-example',
  supervisorId: 'supervisor-example',
  observationCursor: 3,
  projectionDigest: 'projection-digest',
  idempotencyKey: 'decision-key',
  preconditionSnapshot: {},
  action: {
    type: 'NO_ACTION',
    payload: { type: 'NO_ACTION', reason: 'No safe mutation is required.' },
  },
};
void supervisorDecisionBody;

const supervisorDecisionBodyStringVersion: SupervisorDecisionBody = {
  ...supervisorDecisionBody,
  version: 'FORGEFLOW_SUPERVISOR_DECISION_V1',
};
void supervisorDecisionBodyStringVersion;

const invalidSupervisorAction: SupervisorDecisionBody = {
  ...supervisorDecisionBody,
  action: {
    // @ts-expect-error Supervisor action types are generated from the core protocol vocabulary.
    type: 'RUN_ARBITRARY_SHELL',
    payload: {},
  },
};
void invalidSupervisorAction;

type SupervisorProjectionResponse = ForgeFlowOperations['supervisorsGetProjection']['responses'][200]['content']['application/json'];
declare const supervisorProjectionResponse: SupervisorProjectionResponse;
const allowedSupervisorAction:
  | 'NO_ACTION'
  | 'CREATE_EXECUTION'
  | 'CONTINUE_EXECUTION'
  | 'RETRY_EXECUTION'
  | 'SWITCH_ROUTE'
  | 'REQUEST_REVIEW'
  | 'CREATE_REPAIR'
  | 'REPLAN_REMAINDER'
  | 'CREATE_CHILD_PLAN'
  | 'PAUSE_FOR_RESOURCE'
  | 'PARK_EXTERNAL_GATE'
  | 'ESCALATE' = supervisorProjectionResponse.supervisor.allowedActions[0]!;
void allowedSupervisorAction;


// Stable operationId ergonomics are generated from the same OpenAPI authority.
void client.operations.projectsList();
void client.operations.projectsGet({
  params: { path: { projectKey: 'memoflow' } },
});
void client.operations.plansReconcile({
  params: { path: { planId: 'plan-example' } },
});
void client.operations.plansCreate({
  body: minimalPlanCreateBody,
});

// @ts-expect-error Semantic project lookup preserves the required generated path parameter.
void client.operations.projectsGet();

// @ts-expect-error Semantic Plan creation preserves the required generated request body.
void client.operations.plansCreate();

async function verifySemanticResponseTyping() {
  const result = await client.operations.resourcesList();
  if (result.data) {
    const count: number = result.data.count;
    const state: 'ACTIVE' | 'SUSPENDED' | 'DISABLED' = result.data.items[0]!.state;
    void count;
    void state;
  }
}
void verifySemanticResponseTyping;
