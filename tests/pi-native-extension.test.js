import assert from "node:assert/strict";
import test from "node:test";

import registerForgeFlow from "../extension/index.js";

test("extension registers Pi lifecycle hooks and injects policy without a model call", () => {
  const handlers = new Map();
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    }
  };

  registerForgeFlow(pi);

  assert.equal(typeof handlers.get("before_agent_start"), "function");
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

  assert.doesNotThrow(() => {
    handlers.get("session_start")(
      {},
      {
        cwd: process.cwd(),
        sessionManager: { getSessionId: () => "forgeflow-pi-native-test" }
      }
    );
  });
  assert.doesNotThrow(() => handlers.get("session_shutdown")());
});
