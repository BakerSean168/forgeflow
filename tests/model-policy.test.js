import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FORGEFLOW_MODEL_PROVIDER,
  FORGEFLOW_MODEL_ROLES,
  createRoleRouter,
  parseModelPolicy,
  registerForgeFlowVirtualModels,
  resolveModelPolicyPath
} from "../extension/model-policy.js";

test("model policy keeps physical model ids outside ForgeFlow code paths", () => {
  const policy = parseModelPolicy(JSON.stringify({
    version: 1,
    roles: {
      worker: { model: "litellm/gpt-fast", thinkingLevel: "low" },
      reviewer: {
        model: "newapi/reasoner/v2",
        defaultThinkingLevel: "high",
        minThinkingLevel: "medium",
        maxThinkingLevel: "xhigh"
      }
    }
  }));

  assert.deepEqual(policy.roles.worker, {
    provider: "litellm",
    id: "gpt-fast",
    thinkingLevel: "low"
  });
  assert.deepEqual(policy.roles.reviewer, {
    provider: "newapi",
    id: "reasoner/v2",
    defaultThinkingLevel: "high",
    minThinkingLevel: "medium",
    maxThinkingLevel: "xhigh"
  });
});

test("model policy fails closed on virtual recursion, unknown roles, and unqualified models", () => {
  assert.throws(
    () => parseModelPolicy(JSON.stringify({
      version: 1,
      roles: { worker: { model: "forgeflow/reviewer" } }
    }), "recursive.json"),
    /cannot route to another ForgeFlow virtual model/
  );

  assert.throws(
    () => parseModelPolicy(JSON.stringify({
      version: 1,
      roles: { unknown: { model: "litellm/model" } }
    }), "unknown.json"),
    /unknown role 'unknown'/
  );

  assert.throws(
    () => parseModelPolicy(JSON.stringify({
      version: 1,
      roles: { worker: { model: "unqualified" } }
    }), "bare.json"),
    /qualified physical model/
  );
});

test("adaptive thinking policy applies role floors, ceilings, and defaults", () => {
  const physical = { provider: "litellm", id: "reasoner-next" };
  const route = createRoleRouter("planner", {
    loadPolicy() {
      return {
        path: "/policy.json",
        policy: {
          version: 1,
          roles: {
            planner: {
              provider: "litellm",
              id: "reasoner-next",
              defaultThinkingLevel: "high",
              minThinkingLevel: "medium",
              maxThinkingLevel: "xhigh"
            }
          }
        }
      };
    }
  });
  const ctx = {
    cwd: "/repo",
    isProjectTrusted: () => true,
    modelRegistry: { find: () => physical }
  };

  assert.deepEqual(route({ reason: "user" }, ctx), { model: physical, thinkingLevel: "high" });
  assert.deepEqual(route({ reason: "user", thinkingLevel: "low" }, ctx), { model: physical, thinkingLevel: "medium" });
  assert.deepEqual(route({ reason: "user", thinkingLevel: "max" }, ctx), { model: physical, thinkingLevel: "xhigh" });
  assert.deepEqual(route({ reason: "user", thinkingLevel: "high" }, ctx), { model: physical, thinkingLevel: "high" });
});

test("model policy rejects invalid adaptive thinking envelopes", () => {
  assert.throws(
    () => parseModelPolicy(JSON.stringify({
      version: 1,
      roles: { worker: { model: "litellm/model", minThinkingLevel: "high", maxThinkingLevel: "low" } }
    }), "range.json"),
    /minThinkingLevel above maxThinkingLevel/
  );

  assert.throws(
    () => parseModelPolicy(JSON.stringify({
      version: 1,
      roles: { worker: { model: "litellm/model", thinkingLevel: "low", maxThinkingLevel: "high" } }
    }), "mixed.json"),
    /cannot combine legacy 'thinkingLevel'/
  );
});

test("role router resolves a fresh physical model for a user turn", () => {
  const physical = { provider: "litellm", id: "coder-next" };
  const route = createRoleRouter("worker", {
    loadPolicy() {
      return {
        path: "/policy.json",
        policy: {
          version: 1,
          roles: {
            worker: {
              provider: "litellm",
              id: "coder-next",
              thinkingLevel: "low"
            }
          }
        }
      };
    }
  });

  const result = route(
    { reason: "user", thinkingLevel: "high" },
    {
      cwd: "/repo",
      isProjectTrusted: () => true,
      modelRegistry: {
        find(provider, id) {
          assert.equal(provider, "litellm");
          assert.equal(id, "coder-next");
          return physical;
        }
      }
    }
  );

  assert.deepEqual(result, { model: physical, thinkingLevel: "low" });
});

test("role router rejects a virtual model returned by the physical registry lookup", () => {
  const route = createRoleRouter("worker", {
    loadPolicy() {
      return {
        path: "/policy.json",
        policy: {
          version: 1,
          roles: {
            worker: {
              provider: "router",
              id: "nested",
              thinkingLevel: "low"
            }
          }
        }
      };
    }
  });

  assert.throws(
    () => route(
      { reason: "user", thinkingLevel: "high" },
      {
        cwd: "/repo",
        isProjectTrusted: () => true,
        modelRegistry: {
          find() {
            return { provider: "router", id: "nested", api: "pi-virtual" };
          }
        }
      }
    ),
    /must resolve directly to a physical model/
  );
});

test("role router keeps continuations and retries on the physical turn model", () => {
  let loads = 0;
  const route = createRoleRouter("worker", {
    loadPolicy() {
      loads += 1;
      throw new Error("policy should not be loaded for sticky routes");
    }
  });
  const previous = { provider: "litellm", id: "coder-a" };
  const failed = { provider: "newapi", id: "coder-b" };

  assert.deepEqual(
    route(
      { reason: "continuation", thinkingLevel: "high", previous: { model: previous, thinkingLevel: "medium" } },
      { cwd: "/repo", isProjectTrusted: () => true }
    ),
    { model: previous, thinkingLevel: "medium" }
  );

  assert.deepEqual(
    route(
      { reason: "retry", thinkingLevel: "high", failed: { model: failed, thinkingLevel: "low" } },
      { cwd: "/repo", isProjectTrusted: () => true }
    ),
    { model: failed, thinkingLevel: "low" }
  );

  assert.equal(loads, 0);
});

test("explicit model policy path is authoritative", () => {
  const root = mkdtempSync(join(tmpdir(), "forgeflow-model-policy-env-"));
  const project = join(root, "project");
  const home = join(root, "home");
  mkdirSync(join(project, ".pi"), { recursive: true });
  mkdirSync(join(home, ".pi"), { recursive: true });
  writeFileSync(join(project, ".pi", "forgeflow-models.json"), "{}\n");
  writeFileSync(join(home, ".pi", "forgeflow-models.json"), "{}\n");

  assert.throws(
    () => resolveModelPolicyPath(project, { FORGEFLOW_MODEL_POLICY: "operator-policy.json" }, home, { allowProject: true }),
    /FORGEFLOW_MODEL_POLICY must be an absolute path/
  );

  const explicit = join(project, "operator-policy.json");
  writeFileSync(explicit, "{}\n");
  assert.equal(
    resolveModelPolicyPath(project, { FORGEFLOW_MODEL_POLICY: explicit }, home, { allowProject: false }),
    explicit
  );
});

test("project model policy is ignored when the Pi project is untrusted", () => {
  const root = mkdtempSync(join(tmpdir(), "forgeflow-model-policy-"));
  const project = join(root, "project");
  const home = join(root, "home");
  mkdirSync(join(project, ".pi"), { recursive: true });
  mkdirSync(join(home, ".pi"), { recursive: true });
  writeFileSync(join(project, ".pi", "forgeflow-models.json"), "{}\n");
  writeFileSync(join(home, ".pi", "forgeflow-models.json"), "{}\n");

  assert.equal(
    resolveModelPolicyPath(project, {}, home, { allowProject: true }),
    join(project, ".pi", "forgeflow-models.json")
  );
  assert.equal(
    resolveModelPolicyPath(project, {}, home, { allowProject: false }),
    join(home, ".pi", "forgeflow-models.json")
  );
});

test("ForgeFlow registers stable logical roles as Pi virtual models", () => {
  const registrations = [];
  registerForgeFlowVirtualModels({
    registerVirtualModel(definition) {
      registrations.push(definition);
    }
  }, {
    loadPolicy() {
      throw new Error("not used during registration");
    }
  });

  assert.deepEqual(
    registrations.map(({ provider, id }) => [provider, id]),
    FORGEFLOW_MODEL_ROLES.map((role) => [FORGEFLOW_MODEL_PROVIDER, role])
  );
  for (const registration of registrations) {
    assert.equal(typeof registration.route, "function");
  }
});
