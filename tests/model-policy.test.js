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

test("v2 model policy parses deterministic multi-model routes", () => {
  const policy = parseModelPolicy(JSON.stringify({
    version: 2,
    roles: {
      worker: {
        defaultRoute: "fast",
        defaultTaskClass: "mechanical",
        routes: [
          {
            id: "fast",
            model: "litellm/deepseek-v4-flash",
            taskClasses: ["mechanical", "implementation"],
            defaultThinkingLevel: "low",
            minThinkingLevel: "minimal",
            maxThinkingLevel: "low"
          },
          {
            id: "standard",
            model: "litellm/gpt-6-astra",
            taskClasses: ["implementation", "debug"],
            defaultThinkingLevel: "medium",
            minThinkingLevel: "medium",
            maxThinkingLevel: "medium"
          }
        ]
      }
    }
  }), "v2.json");

  assert.equal(policy.version, 2);
  assert.equal(policy.roles.worker.defaultRoute, "fast");
  assert.equal(policy.roles.worker.defaultTaskClass, "mechanical");
  assert.deepEqual(
    policy.roles.worker.routes.map((route) => route.routeId),
    ["fast", "standard"]
  );
  assert.equal(policy.roles.worker.routes[1].provider, "litellm");
  assert.equal(policy.roles.worker.routes[1].id, "gpt-6-astra");
});

test("v2 router selects a physical model by effort and records the decision in router state", () => {
  const deepseek = { provider: "litellm", id: "deepseek-v4-flash", api: "openai-completions" };
  const astra = { provider: "litellm", id: "gpt-6-astra", api: "openai-responses" };
  const models = new Map([
    ["litellm/deepseek-v4-flash", deepseek],
    ["litellm/gpt-6-astra", astra]
  ]);
  const route = createRoleRouter("worker", {
    loadPolicy() {
      return {
        path: "/policy-v2.json",
        policy: parseModelPolicy(JSON.stringify({
          version: 2,
          roles: {
            worker: {
              defaultRoute: "fast",
              defaultTaskClass: "mechanical",
              routes: [
                {
                  id: "fast",
                  model: "litellm/deepseek-v4-flash",
                  taskClasses: ["mechanical", "implementation"],
                  minThinkingLevel: "minimal",
                  maxThinkingLevel: "low"
                },
                {
                  id: "standard",
                  model: "litellm/gpt-6-astra",
                  taskClasses: ["implementation", "debug"],
                  minThinkingLevel: "medium",
                  maxThinkingLevel: "medium"
                }
              ]
            }
          }
        }))
      };
    }
  });
  const ctx = {
    cwd: "/repo",
    isProjectTrusted: () => true,
    modelRegistry: {
      find(provider, id) {
        return models.get(`${provider}/${id}`);
      }
    }
  };

  const low = route({ reason: "user", thinkingLevel: "low", messages: [] }, ctx);
  assert.equal(low.model, deepseek);
  assert.equal(low.thinkingLevel, "low");
  assert.deepEqual(low.state, {
    decisionVersion: 1,
    policyVersion: 2,
    role: "worker",
    routeId: "fast",
    taskClass: "mechanical",
    model: "litellm/deepseek-v4-flash",
    thinkingLevel: "low",
    basis: "effort-envelope"
  });

  const medium = route({ reason: "user", thinkingLevel: "medium", messages: [] }, ctx);
  assert.equal(medium.model, astra);
  assert.equal(medium.thinkingLevel, "medium");
  assert.equal(medium.state.routeId, "standard");
});

test("explicit task-class marker overrides the cheap route and clamps effort inside the selected route", () => {
  const deepseek = { provider: "litellm", id: "deepseek-v4-flash", api: "openai-completions" };
  const astra = { provider: "litellm", id: "gpt-6-astra", api: "openai-responses" };
  const route = createRoleRouter("worker", {
    loadPolicy() {
      return {
        path: "/policy-v2.json",
        policy: parseModelPolicy(JSON.stringify({
          version: 2,
          roles: {
            worker: {
              defaultRoute: "fast",
              routes: [
                {
                  id: "fast",
                  model: "litellm/deepseek-v4-flash",
                  taskClasses: ["mechanical", "implementation"],
                  minThinkingLevel: "minimal",
                  maxThinkingLevel: "low"
                },
                {
                  id: "standard",
                  model: "litellm/gpt-6-astra",
                  taskClasses: ["implementation", "debug"],
                  minThinkingLevel: "medium",
                  maxThinkingLevel: "medium"
                }
              ]
            }
          }
        }))
      };
    }
  });
  const ctx = {
    cwd: "/repo",
    isProjectTrusted: () => true,
    modelRegistry: {
      find(provider, id) {
        if (`${provider}/${id}` === "litellm/deepseek-v4-flash") return deepseek;
        if (`${provider}/${id}` === "litellm/gpt-6-astra") return astra;
      }
    }
  };

  const result = route({
    reason: "user",
    thinkingLevel: "low",
    messages: [{ role: "user", content: [{ type: "text", text: "[[forgeflow:task=debug]] fix the race" }] }]
  }, ctx);

  assert.equal(result.model, astra);
  assert.equal(result.thinkingLevel, "medium");
  assert.equal(result.state.taskClass, "debug");
  assert.equal(result.state.basis, "explicit-task-class");
});

test("v2 router can select a different Oracle model for product judgement", () => {
  const sol = { provider: "litellm", id: "gpt-6.1-sol", api: "openai-completions" };
  const opus = { provider: "litellm", id: "claude-opus-5-5", api: "openai-responses" };
  const route = createRoleRouter("oracle", {
    loadPolicy() {
      return {
        path: "/policy-v2.json",
        policy: parseModelPolicy(JSON.stringify({
          version: 2,
          roles: {
            oracle: {
              defaultRoute: "reasoning",
              defaultTaskClass: "root-cause",
              routes: [
                {
                  id: "reasoning",
                  model: "litellm/gpt-6.1-sol",
                  taskClasses: ["root-cause", "architecture"],
                  minThinkingLevel: "high",
                  maxThinkingLevel: "xhigh"
                },
                {
                  id: "product",
                  model: "litellm/claude-opus-5-5",
                  taskClasses: ["product-judgment"],
                  minThinkingLevel: "high",
                  maxThinkingLevel: "xhigh"
                }
              ]
            }
          }
        }))
      };
    }
  });
  const ctx = {
    cwd: "/repo",
    isProjectTrusted: () => true,
    modelRegistry: {
      find(provider, id) {
        if (`${provider}/${id}` === "litellm/gpt-6.1-sol") return sol;
        if (`${provider}/${id}` === "litellm/claude-opus-5-5") return opus;
      }
    }
  };

  const result = route({
    reason: "user",
    thinkingLevel: "high",
    messages: [{ role: "user", content: "[[forgeflow:task=product-judgment]] choose the better UX tradeoff" }]
  }, ctx);
  assert.equal(result.model, opus);
  assert.equal(result.state.routeId, "product");
});

test("v2 route selection skips an unavailable candidate but does not cross an explicit task-class boundary", () => {
  const fallback = { provider: "litellm", id: "available", api: "openai-completions" };
  const policy = parseModelPolicy(JSON.stringify({
    version: 2,
    roles: {
      worker: {
        defaultRoute: "preferred",
        routes: [
          { id: "preferred", model: "litellm/missing", minThinkingLevel: "low", maxThinkingLevel: "low" },
          { id: "available", model: "litellm/available", minThinkingLevel: "medium", maxThinkingLevel: "medium" }
        ]
      },
      oracle: {
        defaultRoute: "reasoning",
        routes: [
          { id: "reasoning", model: "litellm/available", taskClasses: ["root-cause"], minThinkingLevel: "high", maxThinkingLevel: "xhigh" },
          { id: "product", model: "litellm/missing", taskClasses: ["product-judgment"], minThinkingLevel: "high", maxThinkingLevel: "xhigh" }
        ]
      }
    }
  }));
  const loadPolicy = () => ({ path: "/policy-v2.json", policy });
  const ctx = {
    cwd: "/repo",
    isProjectTrusted: () => true,
    modelRegistry: { find: (_provider, id) => id === "available" ? fallback : undefined }
  };

  const worker = createRoleRouter("worker", { loadPolicy });
  const result = worker({ reason: "user", thinkingLevel: "low", messages: [] }, ctx);
  assert.equal(result.model, fallback);
  assert.equal(result.state.routeId, "available");
  assert.equal(result.thinkingLevel, "medium");

  const oracle = createRoleRouter("oracle", { loadPolicy });
  assert.throws(
    () => oracle({
      reason: "user",
      thinkingLevel: "high",
      messages: [{ role: "user", content: "[[forgeflow:task=product-judgment]] decide" }]
    }, ctx),
    /no available physical route/
  );
});

test("v2 policy rejects bad route identities, task classes, and default routes", () => {
  assert.throws(
    () => parseModelPolicy(JSON.stringify({
      version: 2,
      roles: { worker: { defaultRoute: "missing", routes: [{ id: "fast", model: "litellm/a" }] } }
    }), "missing-default.json"),
    /defaultRoute/
  );
  assert.throws(
    () => parseModelPolicy(JSON.stringify({
      version: 2,
      roles: {
        worker: {
          defaultRoute: "fast",
          routes: [{ id: "fast", model: "litellm/a", taskClasses: ["mystery"] }]
        }
      }
    }), "bad-class.json"),
    /invalid task class/
  );
});

test("task-class markers do not leak from an older user turn", () => {
  const cheap = { provider: "litellm", id: "cheap", api: "openai-completions" };
  const expensive = { provider: "litellm", id: "expensive", api: "openai-completions" };
  const policy = parseModelPolicy(JSON.stringify({
    version: 2,
    roles: {
      worker: {
        defaultRoute: "cheap",
        defaultTaskClass: "mechanical",
        routes: [
          { id: "cheap", model: "litellm/cheap", minThinkingLevel: "low", maxThinkingLevel: "low" },
          { id: "expensive", model: "litellm/expensive", taskClasses: ["debug"], minThinkingLevel: "medium", maxThinkingLevel: "medium" }
        ]
      }
    }
  }));
  const route = createRoleRouter("worker", { loadPolicy: () => ({ path: "/policy.json", policy }) });
  const result = route({
    reason: "user",
    thinkingLevel: "low",
    messages: [
      { role: "user", content: "[[forgeflow:task=debug]] old turn" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      { role: "user", content: "new unclassified turn" }
    ]
  }, {
    cwd: "/repo",
    isProjectTrusted: () => true,
    modelRegistry: { find: (_provider, id) => id === "cheap" ? cheap : expensive }
  });
  assert.equal(result.model, cheap);
  assert.equal(result.state.basis, "effort-envelope");
});
