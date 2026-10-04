import assert from "node:assert/strict";
import test from "node:test";

import { registerRequiredChildExtensions } from "pi-subagents/required-child-extensions";
import registerForgeFlow from "../extension/index.js";

test("extension registers Pi lifecycle hooks and injects policy without a model call", () => {
  const handlers = new Map();
  const virtualModels = [];
  const runtimeAgentRequests = [];
  const disposedRuntimeAgents = [];
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    registerTool() {},
    registerVirtualModel(definition) {
      virtualModels.push(definition);
    },
    events: {
      emit(event, request) {
        if (event !== "pi-subagents:runtime-agent-register:v1") return;
        runtimeAgentRequests.push(request);
        request.result = {
          ok: true,
          registration: {
            dispose() {
              disposedRuntimeAgents.push(request.name);
            }
          }
        };
      }
    }
  };

  registerForgeFlow(pi);

  assert.equal(virtualModels.length, 5);
  assert.deepEqual(virtualModels.map(({ provider, id }) => `${provider}/${id}`), [
    "forgeflow/planner",
    "forgeflow/worker",
    "forgeflow/reviewer",
    "forgeflow/scout",
    "forgeflow/oracle"
  ]);
  assert.equal(typeof handlers.get("before_agent_start"), "function");
  assert.equal(typeof handlers.get("message_end"), "function");
  assert.equal(typeof handlers.get("session_start"), "function");
  assert.equal(typeof handlers.get("session_shutdown"), "function");

  const event = {
    prompt: "Migrate a legacy importer with retry semantics",
    systemPromptOptions: { sections: {} }
  };
  handlers.get("before_agent_start")(event);

  assert.match(event.systemPromptOptions.sections.forgeflow_policy, /ForgeFlow is a thin engineering-governance extension/);
  assert.match(event.systemPromptOptions.sections.forgeflow_policy, /INV-CUTOVER-001/);
  assert.match(event.systemPromptOptions.sections.forgeflow_policy, /INV-REPLAY-001/);

  const sessionId = "forgeflow-pi-native-test";
  assert.doesNotThrow(() => {
    handlers.get("session_start")(
      {},
      {
        cwd: process.cwd(),
        sessionManager: { getSessionId: () => sessionId }
      }
    );
  });

  assert.throws(
    () => registerRequiredChildExtensions({ sessionId, extensions: [] }),
    /already registered/
  );
  assert.deepEqual(
    runtimeAgentRequests.map(({ name }) => name),
    ["antigravity", "antigravity-writer"]
  );

  assert.doesNotThrow(() => handlers.get("session_shutdown")());
  assert.deepEqual(disposedRuntimeAgents, ["antigravity-writer", "antigravity"]);
  const afterShutdown = registerRequiredChildExtensions({ sessionId, extensions: [] });
  afterShutdown.dispose();
});
