import { createHash, randomUUID } from 'node:crypto';

import { ForgeFlowError, failClosed } from '../domain/errors.js';
import {
  createExecutionResourceSelection,
  normalizeResourceFailure,
  type ExecutionResourceSelection,
  type ResourceStateOverrideSource,
} from '../domain/resourceRouting.js';
import type { ResourceSelectionExclusion, ResourceSelector } from '../orchestration/resourceSelector.js';
import type { EventStore } from '../persistence/eventStore.js';
import { parseSupervisorDecision } from './protocol.js';
import {
  extractOpenAICompatibleSupervisorDecision,
  normalizeSupervisorDecisionContent,
  openAICompatibleSupervisorRequest,
  SUPERVISOR_SYSTEM_PROMPT,
  type SupervisorDecisionClient,
  type SupervisorDecisionInput,
} from './runtime.js';

export interface SupervisorResourceFeedbackPort {
  success(selection: ExecutionResourceSelection, source?: ResourceStateOverrideSource): void;
  failure(
    selection: ExecutionResourceSelection,
    error: unknown,
    source?: ResourceStateOverrideSource,
  ): void;
}

class SupervisorProviderFailure extends Error {
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'SupervisorProviderFailure';
    this.statusCode = statusCode;
  }
}

async function boundedResponseText(response: Response, maximumBytes = 4_096): Promise<string> {
  if (!response.body) return (await response.text()).slice(0, maximumBytes);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let result = '';
  try {
    while (total < maximumBytes) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const remaining = maximumBytes - total;
      const slice = chunk.value.byteLength > remaining ? chunk.value.slice(0, remaining) : chunk.value;
      total += slice.byteLength;
      result += decoder.decode(slice, { stream: total < maximumBytes });
      if (slice.byteLength < chunk.value.byteLength) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The response is already bounded; cancellation is best effort.
    }
  }
  return result;
}

function providerFailureMessage(text: string, status: number): string {
  try {
    const payload = JSON.parse(text) as {
      error?: { message?: unknown };
      message?: unknown;
      detail?: unknown;
    };
    for (const value of [payload.error?.message, payload.message, payload.detail])
      if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 1_000);
  } catch {
    // A non-JSON provider body is still bounded below.
  }
  const bounded = text.trim().replace(/\s+/g, ' ').slice(0, 1_000);
  return bounded || 'Supervisor provider HTTP ' + status;
}

function openAIResponsesSupervisorRequest(
  model: string,
  input: SupervisorDecisionInput,
): Record<string, unknown> {
  return {
    model,
    instructions: SUPERVISOR_SYSTEM_PROMPT,
    input: JSON.stringify({
      conversationId: input.conversationId,
      supervisorId: input.supervisorId,
      planId: input.planId,
      projection: input.projection,
    }),
    text: { format: { type: 'json_object' } },
  };
}

function extractOpenAIResponsesSupervisorDecision(payload: unknown): string {
  const value = payload as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ type?: unknown; text?: unknown }> }>;
  };
  if (typeof value?.output_text === 'string')
    return normalizeSupervisorDecisionContent(value.output_text);
  for (const output of value?.output ?? [])
    for (const content of output.content ?? [])
      if (content.type === 'output_text' && typeof content.text === 'string')
        return normalizeSupervisorDecisionContent(content.text);
  throw new ForgeFlowError('SUPERVISOR_DECISION_INVALID');
}

export function supervisorDecisionContextDigest(input: SupervisorDecisionInput): string {
  const projection = input.projection;
  const recentEvents = projection.recentEvents.filter(
    (event) => !['SUPERVISOR', 'DECISION', 'ACTION'].includes(event.aggregateType),
  );
  const context = {
    plan: projection.plan,
    delivery: projection.delivery ?? null,
    graph: projection.graph,
    executions: projection.executions,
    reviews: projection.reviews,
    recentEvents,
  };
  return createHash('sha256').update(JSON.stringify(context)).digest('hex');
}

function selectionEventPayload(
  selection: ExecutionResourceSelection,
  attempt: number,
  input: SupervisorDecisionInput,
) {
  return {
    attempt,
    observationCursor: input.projection.cursor,
    projectionDigest: input.projection.digest,
    decisionContextDigest: supervisorDecisionContextDigest(input),
    resourceId: selection.resourceId,
    resourceTier: selection.resourceTier,
    modelFamily: selection.modelFamily,
    agentBackend: selection.agentBackend,
    transport: selection.transport,
    ...(selection.bindingId ? { bindingId: selection.bindingId } : {}),
    ...(selection.routeModel ? { routeModel: selection.routeModel } : {}),
    ...(selection.protocol ? { protocol: selection.protocol } : {}),
  };
}

export class ResourceSelectedSupervisorDecisionClient implements SupervisorDecisionClient {
  constructor(
    readonly selector: ResourceSelector,
    readonly baseUrl: string,
    readonly bearerToken: string,
    readonly events: EventStore,
    readonly resourceFeedback: SupervisorResourceFeedbackPort,
    readonly fetchImpl: typeof fetch = fetch,
    readonly timeoutMs = 60_000,
    readonly maxAttempts = 3,
  ) {
    failClosed(baseUrl.trim().length > 0, 'SUPERVISOR_RESOURCE_BASE_URL_REQUIRED');
    failClosed(bearerToken.trim().length > 0, 'SUPERVISOR_RESOURCE_KEY_REQUIRED');
    failClosed(
      Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 20,
      'SUPERVISOR_RESOURCE_ATTEMPT_LIMIT_INVALID',
    );
  }

  private append(
    input: SupervisorDecisionInput,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    this.events.append({
      eventId: randomUUID(),
      aggregateId: input.supervisorId,
      aggregateType: 'SUPERVISOR',
      type,
      payload,
      occurredAt: new Date().toISOString(),
      correlationId: input.planId,
    });
  }

  private durableInvalidDecisionExclusions(
    input: SupervisorDecisionInput,
  ): ResourceSelectionExclusion[] {
    const values = new Map<string, ResourceSelectionExclusion>();
    const decisionContextDigest = supervisorDecisionContextDigest(input);
    for (const event of this.events.listRecentByAggregate(input.supervisorId, 500)) {
      if (event.type !== 'SUPERVISOR_RESOURCE_FAILED') continue;
      const payload =
        event.payload !== null && typeof event.payload === 'object' && !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>)
          : {};
      if (
        payload.failureClass !== 'INVALID_DECISION' ||
        payload.decisionContextDigest !== decisionContextDigest ||
        typeof payload.resourceId !== 'string' ||
        typeof payload.modelFamily !== 'string'
      )
        continue;
      const value: ResourceSelectionExclusion = {
        resourceId: payload.resourceId,
        modelFamily: payload.modelFamily,
        ...(typeof payload.bindingId === 'string' ? { bindingId: payload.bindingId } : {}),
      };
      values.set(
        [value.resourceId, value.bindingId ?? '', value.modelFamily ?? ''].join('|'),
        value,
      );
    }
    return [...values.values()];
  }

  private appendInvalidDecision(
    input: SupervisorDecisionInput,
    provenance: Record<string, unknown>,
    failureStage: 'RESPONSE_JSON' | 'RESPONSE_EXTRACT' | 'PROTOCOL_VALIDATE',
    error: unknown,
  ): void {
    const failureCode =
      error instanceof ForgeFlowError
        ? error.code
        : failureStage === 'RESPONSE_JSON'
          ? 'SUPERVISOR_RESPONSE_JSON_INVALID'
          : 'SUPERVISOR_DECISION_INVALID';
    this.append(input, 'SUPERVISOR_RESOURCE_FAILED', {
      ...provenance,
      failureClass: 'INVALID_DECISION',
      failureStage,
      failureCode,
    });
  }

  private async request(
    selection: ExecutionResourceSelection,
    input: SupervisorDecisionInput,
  ): Promise<Response> {
    const base = this.baseUrl.replace(/\/$/, '');
    const responses = selection.protocol === 'openai-responses';
    const endpoint =
      base +
      (this.baseUrl.endsWith('/v1')
        ? responses
          ? '/responses'
          : '/chat/completions'
        : responses
          ? '/v1/responses'
          : '/v1/chat/completions');
    return await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: Object.fromEntries([
        ['content-type', 'application/json'],
        ['authorization', 'Bearer ' + this.bearerToken],
      ]),
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify(
        responses
          ? openAIResponsesSupervisorRequest(selection.routeModel!, input)
          : openAICompatibleSupervisorRequest(selection.routeModel!, input),
      ),
    });
  }

  async decide(input: SupervisorDecisionInput): Promise<string> {
    const priorAttempts = this.durableInvalidDecisionExclusions(input);
    const durableInvalidDecisionCount = priorAttempts.length;
    let attempted = 0;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const selected = this.selector.select({
        phase: 'SUPERVISE',
        includeProviderNativeProfiles: false,
        policy: {
          allowProviderNative: false,
          allowedTransports: ['LITELLM_MANAGED'],
          isAllowed: (candidate) => Boolean(candidate.profile.routeModel),
        },
        priorAttempts,
      });
      if (selected.status !== 'SELECTED')
        throw new ForgeFlowError(
          attempted === 0
            ? durableInvalidDecisionCount > 0
              ? 'SUPERVISOR_RESOURCE_DECISION_QUALITY_EXHAUSTED'
              : 'SUPERVISOR_RESOURCE_UNAVAILABLE'
            : 'SUPERVISOR_RESOURCE_ATTEMPTS_EXHAUSTED',
        );
      const routeModel = selected.profile.routeModel;
      failClosed(Boolean(routeModel), 'SUPERVISOR_RESOURCE_ROUTE_REQUIRED');
      attempted += 1;
      const selection = createExecutionResourceSelection(
        ['supervisor', input.supervisorId, input.projection.supervisor.observationCursor, attempt].join(':'),
        selected.profile,
      );
      const provenance = selectionEventPayload(selection, attempt, input);
      this.append(input, 'SUPERVISOR_RESOURCE_SELECTED', provenance);
      priorAttempts.push({
        resourceId: selection.resourceId,
        ...(selection.bindingId ? { bindingId: selection.bindingId } : {}),
        modelFamily: selection.modelFamily,
      });

      let response: Response;
      try {
        response = await this.request(selection, input);
      } catch (error) {
        const failure = normalizeResourceFailure(error);
        this.resourceFeedback.failure(selection, error, 'SUPERVISOR');
        this.append(input, 'SUPERVISOR_RESOURCE_FAILED', {
          ...provenance,
          failureClass: failure.failureClass,
          ...(failure.statusCode === undefined ? {} : { statusCode: failure.statusCode }),
        });
        continue;
      }

      if (!response.ok) {
        const providerFailure = new SupervisorProviderFailure(
          providerFailureMessage(await boundedResponseText(response), response.status),
          response.status,
        );
        const failure = normalizeResourceFailure(providerFailure);
        this.resourceFeedback.failure(selection, providerFailure, 'SUPERVISOR');
        this.append(input, 'SUPERVISOR_RESOURCE_FAILED', {
          ...provenance,
          failureClass: failure.failureClass,
          ...(failure.statusCode === undefined ? {} : { statusCode: failure.statusCode }),
        });
        continue;
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        this.appendInvalidDecision(input, provenance, 'RESPONSE_JSON', error);
        continue;
      }

      let raw: string;
      try {
        raw =
          selection.protocol === 'openai-responses'
            ? extractOpenAIResponsesSupervisorDecision(payload)
            : extractOpenAICompatibleSupervisorDecision(payload);
      } catch (error) {
        this.appendInvalidDecision(input, provenance, 'RESPONSE_EXTRACT', error);
        continue;
      }

      try {
        parseSupervisorDecision(raw);
      } catch (error) {
        this.appendInvalidDecision(input, provenance, 'PROTOCOL_VALIDATE', error);
        continue;
      }

      this.resourceFeedback.success(selection, 'SUPERVISOR');
      this.append(input, 'SUPERVISOR_RESOURCE_SUCCEEDED', provenance);
      return raw;
    }
    throw new ForgeFlowError('SUPERVISOR_RESOURCE_ATTEMPTS_EXHAUSTED');
  }
}
