import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { registerRequiredChildExtensions } from "pi-subagents/required-child-extensions";
import registerForgeFlowChildModelPolicy from "../extension/child-model-policy.js";
import registerForgeFlow from "../extension/index.js";

test("extension registers Pi lifecycle hooks and injects policy without a model call", () => {
  const handlers = new Map();
  const virtualModels = [];
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    registerVirtualModel(definition) {
      virtualModels.push(definition);
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

  const childExtensionPath = fileURLToPath(
    new URL("../extension/child-model-policy.js", import.meta.url)
  );
  assert.throws(
    () => registerRequiredChildExtensions({
      sessionId,
      extensions: [{ id: "duplicate-probe", path: childExtensionPath }]
    }),
    /already registered/
  );

  assert.doesNotThrow(() => handlers.get("session_shutdown")());

  const afterShutdown = registerRequiredChildExtensions({
    sessionId,
    extensions: [{ id: "post-shutdown-probe", path: childExtensionPath }]
  });
  afterShutdown.dispose();
});

test("child-only model policy extension registers only ForgeFlow virtual models", () => {
  const registrations = [];
  const handlers = [];
  registerForgeFlowChildModelPolicy({
    registerVirtualModel(definition) {
      registrations.push(definition);
    },
    on(...args) {
      handlers.push(args);
    }
  });

  assert.deepEqual(
    registrations.map(({ provider, id }) => `${provider}/${id}`),
    [
      "forgeflow/planner",
      "forgeflow/worker",
      "forgeflow/reviewer",
      "forgeflow/scout",
      "forgeflow/oracle"
    ]
  );
  assert.deepEqual(handlers, []);
});
