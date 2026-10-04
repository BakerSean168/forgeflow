import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createUsageRecorder, readUsageEvents, resolveUsageLogPath } from "../extension/usage.js";

test("usage recorder stores route decisions and assistant usage without secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "forgeflow-usage-"));
  const path = join(dir, "usage.jsonl");
  const recorder = createUsageRecorder({ path });
  const state = {
    decisionVersion: 2,
    policyVersion: 3,
    role: "worker",
    routeId: "frontier",
    taskClass: "implementation",
    logicalModel: "gpt-6.1-sol",
    supplyGroup: "gpt-6.1-sol",
    supplyId: "business-team",
    supplyPriority: 10,
    model: "openai-codex/gpt-6.1-sol",
    thinkingLevel: "medium",
    basis: "supply-priority"
  };
  const ctx = {
    sessionManager: {
      getSessionId: () => "session-1",
      getBranch: () => [{
        type: "custom",
        customType: "pi.virtual-model-state",
        data: { provider: "forgeflow", modelId: "worker", state }
      }]
    }
  };

  recorder.recordDecision(state, ctx);
  recorder.recordMessage({
    message: {
      role: "assistant",
      provider: "openai-codex",
      model: "gpt-6.1-sol",
      api: "openai-codex-responses",
      thinkingLevel: "medium",
      providerThinkingLevel: "medium",
      stopReason: "stop",
      usage: {
        input: 100,
        output: 20,
        cacheRead: 40,
        cacheWrite: 0,
        reasoning: 8,
        totalTokens: 120,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      }
    }
  }, ctx);

  const events = readUsageEvents(path);
  assert.equal(events.length, 2);
  assert.equal(events[0].event, "route_decision");
  assert.equal(events[0].supplyId, "business-team");
  assert.equal(events[1].event, "model_usage");
  assert.equal(events[1].role, "worker");
  assert.equal(events[1].supplyId, "business-team");
  assert.equal(events[1].usage.totalTokens, 120);
  assert.equal(events[1].usage.reasoning, 8);
  assert.equal(events[1].status, "success");
  assert.doesNotMatch(readFileSync(path, "utf8"), /api[_-]?key|authorization|bearer|errorMessage/i);
});

test("usage recorder does not attribute stale virtual state to a different physical model", () => {
  const dir = mkdtempSync(join(tmpdir(), "forgeflow-usage-"));
  const path = join(dir, "usage.jsonl");
  const recorder = createUsageRecorder({ path });
  const ctx = {
    sessionManager: {
      getSessionId: () => "session-2",
      getBranch: () => [{
        type: "custom",
        customType: "pi.virtual-model-state",
        data: {
          provider: "forgeflow",
          modelId: "worker",
          state: { role: "worker", model: "openai-codex/gpt-6.1-sol", supplyId: "business-team" }
        }
      }]
    }
  };

  recorder.recordMessage({
    message: {
      role: "assistant",
      provider: "litellm",
      model: "gpt-6-astra",
      api: "openai-responses",
      stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } }
    }
  }, ctx);

  const [event] = readUsageEvents(path);
  assert.equal(event.role, null);
  assert.equal(event.supplyId, null);
  assert.equal(event.model, "gpt-6-astra");
});

test("usage log override must be absolute", () => {
  assert.throws(
    () => resolveUsageLogPath({ FORGEFLOW_USAGE_LOG: "relative.jsonl" }, "/home/test"),
    /must be an absolute path/
  );
});
