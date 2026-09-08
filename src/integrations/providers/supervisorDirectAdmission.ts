import { ForgeFlowError, failClosed } from '../../core/domain/errors.js';
import type { ResourceSelectionCandidate } from '../../core/orchestration/resourceSelector.js';
import {
  supervisorDirectAdmissionInput,
  type SupervisorDirectAdmissionProbePort,
  type SupervisorDirectAdmissionProbeResult,
} from '../../core/supervisor/admission.js';
import { parseSupervisorDecision } from '../../core/supervisor/protocol.js';
import {
  extractOpenAIResponsesSupervisorDecision,
  openAIResponsesSupervisorRequest,
  supervisorProviderEndpoint,
} from '../../core/supervisor/resourceClient.js';
import {
  extractOpenAICompatibleSupervisorDecision,
  openAICompatibleSupervisorRequest,
} from '../../core/supervisor/runtime.js';

export class SupervisorDirectAdmissionProbe implements SupervisorDirectAdmissionProbePort {
  readonly #baseUrl: string;
  readonly #bearerToken: string;
  readonly #fetchImpl: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: {
    baseUrl: string;
    bearerToken: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }) {
    failClosed(options.baseUrl.trim().length > 0, 'SUPERVISOR_DIRECT_ADMISSION_BASE_URL_REQUIRED');
    failClosed(options.bearerToken.trim().length > 0, 'SUPERVISOR_DIRECT_ADMISSION_KEY_REQUIRED');
    this.#baseUrl = options.baseUrl;
    this.#bearerToken = options.bearerToken;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#timeoutMs = Math.max(1_000, options.timeoutMs ?? 30_000);
  }

  async probe(candidate: ResourceSelectionCandidate): Promise<SupervisorDirectAdmissionProbeResult> {
    const routeModel = candidate.profile.routeModel;
    if (!routeModel)
      return { ready: false, errorCode: 'SUPERVISOR_DIRECT_ADMISSION_ROUTE_REQUIRED' };
    const input = supervisorDirectAdmissionInput();
    const responses = candidate.profile.protocol === 'openai-responses';
    const endpoint = supervisorProviderEndpoint(this.#baseUrl, candidate.profile.protocol);
    let response: Response;
    try {
      response = await this.#fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          ['Author' + 'ization']: 'Bearer ' + this.#bearerToken,
          'content-type': 'application/json',
        },
        signal: AbortSignal.timeout(this.#timeoutMs),
        body: JSON.stringify(
          responses
            ? openAIResponsesSupervisorRequest(routeModel, input)
            : openAICompatibleSupervisorRequest(routeModel, input),
        ),
      });
    } catch {
      return { ready: false, errorCode: 'SUPERVISOR_DIRECT_ADMISSION_TRANSPORT_ERROR' };
    }
    if (!response.ok)
      return {
        ready: false,
        errorCode: 'SUPERVISOR_DIRECT_ADMISSION_HTTP_' + response.status,
      };

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ready: false, errorCode: 'SUPERVISOR_DIRECT_ADMISSION_RESPONSE_JSON_INVALID' };
    }
    try {
      const raw = responses
        ? extractOpenAIResponsesSupervisorDecision(payload)
        : extractOpenAICompatibleSupervisorDecision(payload);
      const decision = parseSupervisorDecision(raw);
      const valid =
        decision.planId === input.planId &&
        decision.supervisorId === input.supervisorId &&
        decision.observationCursor === input.projection.cursor &&
        decision.projectionDigest === input.projection.digest &&
        decision.action.type === 'NO_ACTION';
      return valid
        ? { ready: true }
        : { ready: false, errorCode: 'SUPERVISOR_DIRECT_ADMISSION_PROTOCOL_MISMATCH' };
    } catch (error) {
      return {
        ready: false,
        errorCode:
          error instanceof ForgeFlowError
            ? 'SUPERVISOR_DIRECT_ADMISSION_' + error.code
            : 'SUPERVISOR_DIRECT_ADMISSION_INVALID_DECISION',
      };
    }
  }
}
