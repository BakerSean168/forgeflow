import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { classifySupplyFailure } from "./model-policy.js";

export const FORGEFLOW_USAGE_LOG_ENV = "FORGEFLOW_USAGE_LOG";
export const FORGEFLOW_USAGE_EVENT_VERSION = 1;
const VIRTUAL_MODEL_STATE_ENTRY = "pi.virtual-model-state";
const FORGEFLOW_PROVIDER = "forgeflow";

export function resolveUsageLogPath(env = process.env, home = homedir()) {
  const explicit = env[FORGEFLOW_USAGE_LOG_ENV]?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) {
      throw new Error(`${FORGEFLOW_USAGE_LOG_ENV} must be an absolute path.`);
    }
    return explicit;
  }
  return join(home, ".pi", "forgeflow-usage.jsonl");
}

function appendJsonLine(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Permissions can be owned by an external filesystem policy; logging is best-effort.
  }
}

function latestForgeFlowState(ctx) {
  let branch;
  try {
    branch = ctx?.sessionManager?.getBranch?.();
  } catch {
    return undefined;
  }
  if (!Array.isArray(branch)) return undefined;

  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (!entry || entry.type !== "custom" || entry.customType !== VIRTUAL_MODEL_STATE_ENTRY) continue;
    const data = entry.data;
    if (!data || data.provider !== FORGEFLOW_PROVIDER || typeof data.modelId !== "string") continue;
    const state = data.state && typeof data.state === "object" ? data.state : undefined;
    return { role: data.modelId, state };
  }
  return undefined;
}

function usageNumbers(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const cost = usage.cost && typeof usage.cost === "object" ? usage.cost : {};
  return {
    input: Number(usage.input ?? 0),
    output: Number(usage.output ?? 0),
    cacheRead: Number(usage.cacheRead ?? 0),
    cacheWrite: Number(usage.cacheWrite ?? 0),
    reasoning: usage.reasoning === undefined ? null : Number(usage.reasoning),
    totalTokens: Number(usage.totalTokens ?? 0),
    cost: {
      input: Number(cost.input ?? 0),
      output: Number(cost.output ?? 0),
      cacheRead: Number(cost.cacheRead ?? 0),
      cacheWrite: Number(cost.cacheWrite ?? 0),
      total: Number(cost.total ?? 0)
    }
  };
}

function sessionId(ctx) {
  try {
    return ctx?.sessionManager?.getSessionId?.() ?? null;
  } catch {
    return null;
  }
}

function baseEvent(type, ctx) {
  return {
    version: FORGEFLOW_USAGE_EVENT_VERSION,
    event: type,
    timestamp: new Date().toISOString(),
    sessionId: sessionId(ctx)
  };
}

export function createUsageRecorder(options = {}) {
  const path = options.path ?? resolveUsageLogPath(options.env ?? process.env, options.home ?? homedir());
  const append = options.append ?? ((value) => appendJsonLine(path, value));

  function recordDecision(decision, ctx) {
    if (!decision || typeof decision !== "object") return;
    append({
      ...baseEvent("route_decision", ctx),
      role: decision.role ?? null,
      routeId: decision.routeId ?? null,
      taskClass: decision.taskClass ?? null,
      logicalModel: decision.logicalModel ?? decision.model ?? null,
      supplyGroup: decision.supplyGroup ?? null,
      supplyId: decision.supplyId ?? null,
      supplyPriority: decision.supplyPriority ?? null,
      physicalModel: decision.model ?? null,
      thinkingLevel: decision.thinkingLevel ?? null,
      basis: decision.basis ?? null,
      failoverReason: decision.failoverReason ?? null,
      failedSupplyId: decision.failedSupplyId ?? null,
      failoverCount: decision.failoverCount ?? 0
    });
  }

  function recordMessage(event, ctx) {
    const message = event?.message;
    if (!message || message.role !== "assistant") return;
    const virtual = latestForgeFlowState(ctx);
    const state = virtual?.state;
    const physicalModel = `${message.provider}/${message.model}`;
    const stateMatches = state?.model === physicalModel;
    const usage = usageNumbers(message.usage);

    append({
      ...baseEvent("model_usage", ctx),
      role: stateMatches ? (state.role ?? virtual?.role ?? null) : null,
      routeId: stateMatches ? (state.routeId ?? null) : null,
      taskClass: stateMatches ? (state.taskClass ?? null) : null,
      logicalModel: stateMatches ? (state.logicalModel ?? message.model) : message.model,
      supplyGroup: stateMatches ? (state.supplyGroup ?? null) : null,
      supplyId: stateMatches ? (state.supplyId ?? null) : null,
      provider: message.provider,
      model: message.model,
      responseModel: message.responseModel ?? null,
      api: message.api ?? null,
      thinkingLevel: message.thinkingLevel ?? null,
      providerThinkingLevel: message.providerThinkingLevel ?? null,
      stopReason: message.stopReason ?? null,
      status: message.stopReason === "error" ? "failure" : message.stopReason === "aborted" ? "aborted" : "success",
      supplyFailureClass: message.stopReason === "error" ? (classifySupplyFailure(message) ?? null) : null,
      usage
    });
  }

  return { path, recordDecision, recordMessage };
}

export function readUsageEvents(path) {
  const text = readFileSync(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid ForgeFlow usage JSONL at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}
