import { randomUUID } from 'node:crypto';

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

function selectionEventPayload(selection: ExecutionResourceSelection, attempt: number) {
  return {
    attempt,
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
    const priorAttempts: ResourceSelectionExclusion[] = [];
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
            ? 'SUPERVISOR_RESOURCE_UNAVAILABLE'
            : 'SUPERVISOR_RESOURCE_ATTEMPTS_EXHAUSTED',
        );
      const routeModel = selected.profile.routeModel;
      failClosed(Boolean(routeModel), 'SUPERVISOR_RESOURCE_ROUTE_REQUIRED');
      attempted += 1;
      const selection = createExecutionResourceSelection(
        ['supervisor', input.supervisorId, input.projection.supervisor.observationCursor, attempt].join(':'),
        selected.profile,
      );
      const provenance = selectionEventPayload(selection, attempt);
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

      let raw: string;
      try {
        const payload = await response.json();
        raw =
          selection.protocol === 'openai-responses'
            ? extractOpenAIResponsesSupervisorDecision(payload)
            : extractOpenAICompatibleSupervisorDecision(payload);
        parseSupervisorDecision(raw);
      } catch {
        this.append(input, 'SUPERVISOR_RESOURCE_FAILED', {
          ...provenance,
          failureClass: 'INVALID_DECISION',
        });
        continue;
      }

      this.resourceFeedback.success(selection, 'SUPERVISOR');
      this.append(input, 'SUPERVISOR_RESOURCE_SUCCEEDED', provenance);
      return raw;
    }
    throw new ForgeFlowError('SUPERVISOR_RESOURCE_ATTEMPTS_EXHAUSTED');
  }
}
