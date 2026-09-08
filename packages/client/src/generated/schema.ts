/* eslint-disable */
/**
 * GENERATED FILE — DO NOT EDIT.
 * Source: api/openapi.v1.json
 * Regenerate with: npm run client:generate
 */
export type paths = {
    readonly "/api/health": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["systemHealth"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/executions": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["executionsList"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/executions/{executionId}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["executionsGet"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/executions/{executionId}/abort-paused-provider": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["executionsAbortPausedProvider"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/executions/{executionId}/adopt-workspace": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["executionsAdoptWorkspace"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/executions/{executionId}/continue": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["executionsContinue"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/executions/{executionId}/provider-cleanup": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["executionsProviderCleanup"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/executions/{executionId}/replace-provider-session": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["executionsReplaceProviderSession"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/executions/{executionId}/run": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["executionsRun"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/improvements": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["improvementsList"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/improvements/{candidateId}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["improvementsGet"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/improvements/{candidateId}/adopt": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["improvementsAdopt"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/improvements/{candidateId}/diagnose": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["improvementsDiagnose"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/improvements/{candidateId}/reconcile": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["improvementsReconcile"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/improvements/{candidateId}/reject": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["improvementsReject"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/improvements/{candidateId}/self-canary": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["improvementsSelfCanary"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/improvements/{candidateId}/self-promote": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["improvementsSelfPromote"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/improvements/cycle": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["improvementsRunCycle"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/improvements/discover": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["improvementsDiscover"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/maintenance/programs": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["maintenanceProgramsList"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/maintenance/programs/{programId}/state": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["maintenanceProgramsSetState"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/plans": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["plansList"];
        readonly put?: never;
        readonly post: operations["plansCreate"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/plans/{planId}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["plansGet"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/plans/{planId}/cancel": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["plansCancel"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/plans/{planId}/cancel-queued": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["plansCancelQueued"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/plans/{planId}/children": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["plansCreateChild"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/plans/{planId}/delivery": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["plansAttachDelivery"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/plans/{planId}/reconcile": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["plansReconcile"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/plans/{planId}/reprioritize": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["plansReprioritize"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/plans/{planId}/run": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["plansRun"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/projects": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** List registered ForgeFlow projects */
        readonly get: operations["projectsList"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/projects/{projectKey}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /** Get one registered ForgeFlow project */
        readonly get: operations["projectsGet"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/projects/{projectKey}/plan-queue": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["projectsGetPlanQueue"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/release-acceptance/autonomous-lifecycle": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["releaseAcceptanceGetAutonomousLifecycle"];
        readonly put?: never;
        readonly post: operations["releaseAcceptanceRecordAutonomousLifecycle"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/resources": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["resourcesList"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/resources/{resourceId}/bindings/{bindingId}/state": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["resourcesSetBindingState"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/resources/{resourceId}/state": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["resourcesSetState"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/runtime-admission": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["runtimeAdmissionGet"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/storage": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["storageGet"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/storage/reconcile": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["storageReconcile"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/supervisor-admission": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["supervisorAdmissionGet"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/supervisors/{supervisorId}/decisions": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["supervisorsDecide"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/supervisors/{supervisorId}/projection": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["supervisorsGetProjection"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
};
export type webhooks = Record<string, never>;
export type components = {
    schemas: never;
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
};
export type $defs = Record<string, never>;
export interface operations {
    readonly systemHealth: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        /** @enum {integer} */
                        readonly apiVersion: 1;
                        readonly autonomousLifecycleAcceptance: {
                            readonly [key: string]: unknown;
                        };
                        readonly database?: string;
                        readonly executionRuntime: {
                            readonly [key: string]: unknown;
                        };
                        readonly hostCacheMaintenance: {
                            readonly [key: string]: unknown;
                        };
                        readonly improvementRuntime: {
                            readonly [key: string]: unknown;
                        };
                        /** @enum {string} */
                        readonly mode: "autonomous-engineering";
                        readonly planScheduling: {
                            readonly [key: string]: unknown;
                        };
                        readonly releaseProvenance: {
                            readonly [key: string]: unknown;
                        };
                        /** @enum {string} */
                        readonly service: "forgeflow-control-plane";
                        /** @enum {string} */
                        readonly status: "ok";
                        readonly supervisorRuntime: {
                            readonly [key: string]: unknown;
                        };
                        readonly workspaceStorage: {
                            readonly [key: string]: unknown;
                        } | null;
                    } & {
                        readonly [key: string]: unknown;
                    };
                };
            };
        };
    };
    readonly executionsList: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly executionsGet: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly executionId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly executionsAbortPausedProvider: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly executionId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly executionsAdoptWorkspace: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly executionId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly executionsContinue: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly executionId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly executionsProviderCleanup: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly executionId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly executionsReplaceProviderSession: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly executionId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly executionsRun: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly executionId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly improvementsList: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly improvementsGet: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly candidateId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly improvementsAdopt: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly candidateId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly improvementsDiagnose: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly candidateId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly improvementsReconcile: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly candidateId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly improvementsReject: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly candidateId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly improvementsSelfCanary: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly candidateId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly improvementsSelfPromote: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly candidateId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly improvementsRunCycle: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly improvementsDiscover: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly maintenanceProgramsList: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly maintenanceProgramsSetState: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly programId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly plansList: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly plansCreate: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly plansGet: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly planId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly plansCancel: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly planId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly plansCancelQueued: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly planId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly plansCreateChild: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly planId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly plansAttachDelivery: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly planId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly plansReconcile: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly planId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly plansReprioritize: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly planId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly plansRun: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly planId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly projectsList: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        readonly count: number;
                        readonly items: readonly {
                            readonly description?: string;
                            readonly displayName?: string;
                            readonly execution: {
                                readonly allowProviderNative: boolean;
                                readonly enabled: boolean;
                                readonly maxParallelWorkItems: number | null;
                                /** @enum {string} */
                                readonly workspace: "canonical-fast-forward" | "literal-worktree";
                            };
                            readonly improvement: {
                                readonly enabled: boolean;
                            };
                            readonly projectKey: string;
                            readonly repositoryPath: string | null;
                            /** @enum {string} */
                            readonly source: "manifest" | "legacy-env";
                            readonly tags: readonly string[];
                        }[];
                        /** @enum {string} */
                        readonly source: "manifest" | "legacy-env" | "empty";
                    };
                };
            };
        };
    };
    readonly projectsGet: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly projectKey: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        readonly description?: string;
                        readonly displayName?: string;
                        readonly execution: {
                            readonly allowProviderNative: boolean;
                            readonly enabled: boolean;
                            readonly maxParallelWorkItems: number | null;
                            /** @enum {string} */
                            readonly workspace: "canonical-fast-forward" | "literal-worktree";
                        };
                        readonly improvement: {
                            readonly enabled: boolean;
                        };
                        readonly projectKey: string;
                        readonly repositoryPath: string | null;
                        /** @enum {string} */
                        readonly source: "manifest" | "legacy-env";
                        readonly tags: readonly string[];
                    };
                };
            };
        };
    };
    readonly projectsGetPlanQueue: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly projectKey: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly releaseAcceptanceGetAutonomousLifecycle: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        readonly [key: string]: unknown;
                    };
                };
            };
        };
    };
    readonly releaseAcceptanceRecordAutonomousLifecycle: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody: {
            readonly content: {
                readonly "application/json": {
                    readonly artifactSha256: string;
                    readonly canonicalHead: string;
                    readonly externalChecks: readonly string[];
                    readonly planId: string;
                    readonly sourceSha: string;
                } & {
                    readonly [key: string]: unknown;
                };
            };
        };
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        readonly attestation: {
                            readonly [key: string]: unknown;
                        };
                        readonly attestedAt: string;
                        /** @enum {string} */
                        readonly status: "ATTESTED";
                    };
                };
            };
            /** @description Default Response */
            readonly 201: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        readonly attestation: {
                            readonly [key: string]: unknown;
                        };
                        readonly attestedAt: string;
                        /** @enum {string} */
                        readonly status: "ATTESTED";
                    };
                };
            };
        };
    };
    readonly resourcesList: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        readonly count: number;
                        readonly items: readonly {
                            readonly displayName: string;
                            readonly lastNormalizedFailure: {
                                readonly changedAt: string;
                                readonly reasonClass: string;
                                readonly sanitizedReason: string | null;
                                readonly source: string;
                            } | null;
                            readonly modelBindings: readonly {
                                readonly agentBackend: string | null;
                                readonly capability: string | null;
                                readonly deploymentId: string | null;
                                readonly enabled: boolean;
                                readonly modelFamily: string;
                                readonly modelRank: number | null;
                                readonly protocol: string | null;
                                readonly ready: boolean;
                                readonly routeModel: string | null;
                            }[];
                            readonly providerKey: string | null;
                            readonly resourceId: string;
                            readonly resourceSequence: number;
                            /** @enum {string} */
                            readonly resourceTier: "PROMOTIONAL" | "FREE" | "SUBSCRIPTION" | "METERED" | "OTHER";
                            /** @enum {string} */
                            readonly state: "ACTIVE" | "SUSPENDED" | "DISABLED";
                            readonly suspendedUntil: string | null;
                            /** @enum {string} */
                            readonly transport: "LITELLM_MANAGED" | "PROVIDER_NATIVE";
                            readonly version: number;
                        }[];
                    };
                };
            };
        };
    };
    readonly resourcesSetBindingState: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly bindingId: string;
                readonly resourceId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody: {
            readonly content: {
                readonly "application/json": {
                    readonly state: string;
                } & {
                    readonly [key: string]: unknown;
                };
            };
        };
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        readonly bindingId: string;
                        readonly resource: {
                            readonly displayName: string;
                            readonly lastNormalizedFailure: {
                                readonly changedAt: string;
                                readonly reasonClass: string;
                                readonly sanitizedReason: string | null;
                                readonly source: string;
                            } | null;
                            readonly modelBindings: readonly {
                                readonly agentBackend: string | null;
                                readonly capability: string | null;
                                readonly deploymentId: string | null;
                                readonly enabled: boolean;
                                readonly modelFamily: string;
                                readonly modelRank: number | null;
                                readonly protocol: string | null;
                                readonly ready: boolean;
                                readonly routeModel: string | null;
                            }[];
                            readonly providerKey: string | null;
                            readonly resourceId: string;
                            readonly resourceSequence: number;
                            /** @enum {string} */
                            readonly resourceTier: "PROMOTIONAL" | "FREE" | "SUBSCRIPTION" | "METERED" | "OTHER";
                            /** @enum {string} */
                            readonly state: "ACTIVE" | "SUSPENDED" | "DISABLED";
                            readonly suspendedUntil: string | null;
                            /** @enum {string} */
                            readonly transport: "LITELLM_MANAGED" | "PROVIDER_NATIVE";
                            readonly version: number;
                        };
                        readonly resourceWake: {
                            readonly becameAvailable: readonly string[];
                            readonly scheduledWakes: number;
                        };
                        /** @enum {string} */
                        readonly state: "ACTIVE" | "DISABLED";
                    };
                };
            };
        };
    };
    readonly resourcesSetState: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly resourceId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody: {
            readonly content: {
                readonly "application/json": {
                    readonly expectedVersion?: number | string | null;
                    readonly reason?: string;
                    readonly state: string;
                    readonly suspendedUntil?: string;
                } & {
                    readonly [key: string]: unknown;
                };
            };
        };
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        readonly mutation: string;
                        readonly resource: {
                            readonly displayName: string;
                            readonly lastNormalizedFailure: {
                                readonly changedAt: string;
                                readonly reasonClass: string;
                                readonly sanitizedReason: string | null;
                                readonly source: string;
                            } | null;
                            readonly modelBindings: readonly {
                                readonly agentBackend: string | null;
                                readonly capability: string | null;
                                readonly deploymentId: string | null;
                                readonly enabled: boolean;
                                readonly modelFamily: string;
                                readonly modelRank: number | null;
                                readonly protocol: string | null;
                                readonly ready: boolean;
                                readonly routeModel: string | null;
                            }[];
                            readonly providerKey: string | null;
                            readonly resourceId: string;
                            readonly resourceSequence: number;
                            /** @enum {string} */
                            readonly resourceTier: "PROMOTIONAL" | "FREE" | "SUBSCRIPTION" | "METERED" | "OTHER";
                            /** @enum {string} */
                            readonly state: "ACTIVE" | "SUSPENDED" | "DISABLED";
                            readonly suspendedUntil: string | null;
                            /** @enum {string} */
                            readonly transport: "LITELLM_MANAGED" | "PROVIDER_NATIVE";
                            readonly version: number;
                        };
                        readonly resourceWake: {
                            readonly becameAvailable: readonly string[];
                            readonly scheduledWakes: number;
                        };
                    };
                };
            };
        };
    };
    readonly runtimeAdmissionGet: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        readonly demandDriven: boolean;
                        readonly durableCache: {
                            readonly items: readonly {
                                readonly agentBackend: string;
                                readonly bindingId: string;
                                readonly checkedAt: string;
                                readonly errorCode: string | null;
                                readonly modelFamily: string;
                                readonly phase: string | null;
                                readonly ready: boolean;
                                readonly resourceId: string;
                                readonly routeModel: string;
                                /** @enum {string} */
                                readonly transport: "LITELLM_MANAGED" | "PROVIDER_NATIVE";
                            }[];
                            readonly summary: {
                                readonly checked?: number;
                                readonly implementationReady?: number;
                                readonly ready?: number;
                                readonly reviewReady?: number;
                                readonly unready?: number;
                            } & {
                                readonly [key: string]: unknown;
                            };
                        };
                        readonly enabled: boolean;
                        readonly hasDemand: boolean;
                        readonly items: readonly {
                            readonly agentBackend: string;
                            readonly bindingId: string;
                            readonly checkedAt: string;
                            readonly errorCode: string | null;
                            readonly modelFamily: string;
                            readonly phase: string | null;
                            readonly ready: boolean;
                            readonly resourceId: string;
                            readonly routeModel: string;
                            /** @enum {string} */
                            readonly transport: "LITELLM_MANAGED" | "PROVIDER_NATIVE";
                        }[];
                        readonly summary: {
                            readonly checked?: number;
                            readonly implementationReady?: number;
                            readonly ready?: number;
                            readonly reviewReady?: number;
                            readonly unready?: number;
                        } & {
                            readonly [key: string]: unknown;
                        };
                    };
                };
            };
        };
    };
    readonly storageGet: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        readonly hostCacheMaintenance: {
                            readonly [key: string]: unknown;
                        };
                        readonly storage: {
                            readonly [key: string]: unknown;
                        } | null;
                    };
                };
            };
        };
    };
    readonly storageReconcile: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        readonly cleanup: {
                            readonly [key: string]: unknown;
                        } | null;
                        readonly hostCacheMaintenance: {
                            readonly [key: string]: unknown;
                        };
                        readonly storage: {
                            readonly [key: string]: unknown;
                        } | null;
                    };
                };
            };
        };
    };
    readonly supervisorAdmissionGet: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": {
                        readonly demandDriven: boolean;
                        readonly durableCache: {
                            readonly items: readonly {
                                readonly bindingId: string;
                                readonly checkedAt: string;
                                readonly errorCode: string | null;
                                readonly modelFamily: string;
                                readonly protocol: string;
                                readonly ready: boolean;
                                readonly resourceId: string;
                                readonly routeModel: string;
                            }[];
                            readonly summary: {
                                readonly checked?: number;
                                readonly implementationReady?: number;
                                readonly ready?: number;
                                readonly reviewReady?: number;
                                readonly unready?: number;
                            } & {
                                readonly [key: string]: unknown;
                            };
                        };
                        readonly enabled: boolean;
                        readonly hasDemand: boolean;
                        readonly items: readonly {
                            readonly bindingId: string;
                            readonly checkedAt: string;
                            readonly errorCode: string | null;
                            readonly modelFamily: string;
                            readonly protocol: string;
                            readonly ready: boolean;
                            readonly resourceId: string;
                            readonly routeModel: string;
                        }[];
                        readonly summary: {
                            readonly checked?: number;
                            readonly implementationReady?: number;
                            readonly ready?: number;
                            readonly reviewReady?: number;
                            readonly unready?: number;
                        } & {
                            readonly [key: string]: unknown;
                        };
                    };
                };
            };
        };
    };
    readonly supervisorsDecide: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly supervisorId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readonly supervisorsGetProjection: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly supervisorId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Default Response */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
}
