import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseExecutionPolicy, parseExecutionTask, selectExecutionProfile, orderExecutionWaves,
  resolveExecutionPolicyPath, loadExecutionPolicy
} from "../extension/execution-policy.js";
import { executionRuntime } from "../extension/execution-runtime.js";
import { parseModelPolicy } from "../extension/model-policy.js";

const policy = parseExecutionPolicy(readFileSync("config/execution-policy.v1.json", "utf8"));
const models = ["forgeflow/scout", "forgeflow/worker", "forgeflow/reviewer",
  "openai-codex/gpt-6.1-sol", "openai-codex/gpt-6-luna",
  "litellm/deepseek-v4.1-flash"];
const modelPolicy = parseModelPolicy(JSON.stringify({
  version: 3,
  supplies: {
    sol: { sources: [{ id: "business", model: "openai-codex/gpt-6.1-sol", priority: 10 }] },
    luna: { sources: [{ id: "business", model: "openai-codex/gpt-6-luna", priority: 10 }] }
  },
  roles: {
    worker: { defaultRoute: "fast", defaultTaskClass: "implementation",
      routes: [
        { id: "frontier", supplyGroup: "sol",
          taskClasses: ["implementation", "mechanical", "debug"],
          defaultThinkingLevel: "medium", minThinkingLevel: "low", maxThinkingLevel: "high" },
        { id: "fast", model: "litellm/deepseek-v4.1-flash",
          taskClasses: ["mechanical", "implementation"],
          defaultThinkingLevel: "low", minThinkingLevel: "low", maxThinkingLevel: "low" },
        { id: "luna-max", supplyGroup: "luna",
          taskClasses: ["implementation", "debug", "root-cause"],
          defaultThinkingLevel: "max", minThinkingLevel: "max", maxThinkingLevel: "max" }
      ]
    },
    scout: { defaultRoute: "fast", defaultTaskClass: "recon", routes: [
      { id: "fast", model: "litellm/deepseek-v4.1-flash", taskClasses: ["recon"],
        defaultThinkingLevel: "low", minThinkingLevel: "low", maxThinkingLevel: "low" }
    ]},
    reviewer: { defaultRoute: "frontier", defaultTaskClass: "review", routes: [{ id: "frontier", supplyGroup: "sol", taskClasses: ["review"], defaultThinkingLevel: "high", minThinkingLevel: "high", maxThinkingLevel: "high" }] }
  }
}));

function runtime(opts={}) {
  return executionRuntime("/tmp", { models, modelPolicy, env: { PATH: "" }, ...opts });
}
function task(overrides={}) {
  return { id: "ticket", description: "Implement a bounded change", kind: "implementation",
    complexity: "low", access: "write", ...overrides };
}

test("P0 default policy validates 10 explicit Agent / Model execution profiles", () => {
  assert.equal(policy.profiles.length, 10);
  assert.ok(policy.profiles.every((p) => p.runtime === "pi" ? p.model.startsWith("forgeflow/") : p.model === undefined));
  assert.equal(policy.profiles.find((p) => p.id === "dsh-writer").enabled, false);
  assert.equal(policy.profiles.find((p) => p.id === "dsh-writer").health, "blocked");
  assert.equal(policy.profiles.find((p) => p.id === "pi-reviewer-writer").access, "write",
    "Bundled Pi reviewer can edit, must not be falsely advertised as read-only");
});

test("P0 native low worker selects DeepSeek, high selects Sol, max selects Luna", () => {
  const rt = runtime();
  const cheap = rt.resolvePiModel("forgeflow/worker:low", task());
  const complex = rt.resolvePiModel("forgeflow/worker:high", task({ complexity: "high" }));
  const max = rt.resolvePiModel("forgeflow/worker:max", task({ complexity: "critical" }));
  assert.equal(cheap.physicalModel, "litellm/deepseek-v4.1-flash");
  assert.equal(complex.physicalModel, "openai-codex/gpt-6.1-sol");
  assert.equal(max.physicalModel, "openai-codex/gpt-6-luna");
});

test("P0 explicit implementation task cannot silently become debug route", () => {
  const rt = runtime();
  assert.throws(() => rt.resolvePiModel("forgeflow/scout:low", task({ kind: "product-judgment" })), /route/i);
});

test("P1 without a prepared external writer worktree, choose native Pi and low-cost model", () => {
  const selected = selectExecutionProfile(policy, task(), {
    ...runtime(), isExecutable: () => true
  });
  assert.equal(selected.ok, true);
  assert.equal(selected.selection.profile, "pi-fast-writer");
  assert.equal(selected.selection.agent, "worker");
  assert.equal(selected.selection.model, "forgeflow/worker:low");
  assert.equal(selected.selection.physicalModel, "litellm/deepseek-v4.1-flash");
  assert.ok(selected.candidates.find((c) => c.profile === "zcode-fast-writer").reasons.includes("prepared-worktree-required"));
});

test("P1 reads prefer Pi scout or GLM advisor, never a writer", () => {
  const selected = selectExecutionProfile(policy, task({ kind: "recon", access: "read" }), {
    ...runtime(), isExecutable: () => true
  });
  assert.equal(selected.selection.agent, "scout");
  const review = selectExecutionProfile(policy, task({ kind: "review", access: "read",
    complexity: "high" }), { ...runtime(), isExecutable: () => true });
  assert.equal(review.selection.agent, "glm-agent");
  assert.ok(review.selection.warnings.includes("acp-read-mode-is-not-os-sandbox"));
});

test("P1 high-complexity writers choose Sol, while Luna stays opt-in", () => {
  const selected = selectExecutionProfile(policy, task({ complexity: "high" }), {
    ...runtime(), isExecutable: () => true
  });
  assert.equal(selected.selection.profile, "pi-core-writer");
  assert.equal(selected.selection.physicalModel, "openai-codex/gpt-6.1-sol");
  const luna = selectExecutionProfile(policy, task({ complexity: "critical",
    profile: "pi-max-writer" }), { ...runtime(), isExecutable: () => true });
  assert.equal(luna.selection.profile, "pi-max-writer");
  assert.equal(luna.selection.physicalModel, "openai-codex/gpt-6-luna");
});

test("P0 profile fail-closes when worker:low drifts back to expensive Sol", () => {
  const drift = selectExecutionProfile(policy, task(), {
    isExecutable: () => false,
    isModelAvailable: () => true,
    resolvePiModel: () => ({ physicalModel: "openai-codex/gpt-6.1-sol" })
  });
  assert.equal(drift.ok, false);
  assert.ok(drift.candidates.find((x) => x.profile === "pi-fast-writer")
    .reasons.includes("physical-model-not-allowed"));
});

test("P1 external model/Provider is metadata, never passed as Pi model argument", () => {
  const found = selectExecutionProfile(policy, task({cwd:"/tmp/writer",repo:"/tmp/main"}), {
    ...runtime(), isExecutable: () => true
  });
  assert.equal(found.selection.agent, "zcode-agent-writer");
  assert.equal(found.selection.model, undefined);
  assert.equal(found.selection.modelLabel, "glm-5.3");
  assert.equal(found.selection.providerLabel, "windhub-direct");
});

test("P1 executable missing or unhealthy profile fails closed/falls back", () => {
  const found = selectExecutionProfile(policy, task({cwd:"/tmp/writer",repo:"/tmp/main"}), {
    ...runtime(), isExecutable: () => false
  });
  assert.equal(found.selection.agent, "worker");
  const dsh = selectExecutionProfile(policy, task({cwd:"/tmp/writer",repo:"/tmp/main",
    profile:"dsh-writer"}), { ...runtime(), isExecutable: () => true });
  assert.equal(dsh.ok, false);
  assert.ok(dsh.candidates.find((x) => x.profile === "dsh-writer").reasons.includes("health-blocked"));
});

test("P1 fail closed on unknown or dangerous policy fields and undeclared models", () => {
  const p = JSON.parse(readFileSync("config/execution-policy.v1.json", "utf8"));
  p.profiles[0].model = "forgeflow/worker:low";
  assert.throws(() => parseExecutionPolicy(JSON.stringify(p)), /external CLI cannot receive/);
  delete p.profiles[0].model;
  p.profiles[0].isolation = "managed-worktree";
  assert.throws(() => parseExecutionPolicy(JSON.stringify(p)), /writer isolation/);
  p.profiles[0].isolation = "prepared-worktree";
  p.profiles[0].unexpected = "ignored?";
  assert.throws(() => parseExecutionPolicy(JSON.stringify(p)), /unsupported fields/);
});

test("P1 strict task validation, no inferred task class/complexity", () => {
  assert.throws(() => parseExecutionTask(task({ complexity: "maybe" })), /invalid task complexity/);
  assert.throws(() => parseExecutionTask(task({ unexpected: "unsafe" })), /unsupported fields/);
  assert.throws(() => parseExecutionTask(task({dependsOn:["ticket"]})), /cyclic/);
  assert.throws(() => parseExecutionTask(task({cwd:"relative", repo:"/tmp/main"})), /absolute/);
  assert.throws(() => parseExecutionTask(task({cwd:"/tmp/a"})), /supplied together/);
});

test("P1 project-local policy is ignored unless project trust is explicit", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(),"forgeflow-execution-trust-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const project=path.join(dir,"project");const home=path.join(dir,"home");
  mkdirSync(path.join(project,".pi"),{recursive:true});
  mkdirSync(path.join(home,".pi"),{recursive:true});
  const projectFile=path.join(project,".pi","forgeflow-execution.json");
  const homeFile=path.join(home,".pi","forgeflow-execution.json");
  writeFileSync(projectFile,readFileSync("config/execution-policy.v1.json"));
  writeFileSync(homeFile,readFileSync("config/execution-policy.v1.json"));
  const env={};
  assert.equal(resolveExecutionPolicyPath(project,{home,env,trusted:false}),homeFile);
  assert.equal(resolveExecutionPolicyPath(project,{home,env,trusted:true}),projectFile);
  assert.equal(loadExecutionPolicy(project,{home,env,trusted:false}).policy.version,1);
  assert.throws(()=>resolveExecutionPolicyPath(project,{home,env:{FORGEFLOW_EXECUTION_POLICY:"relative"}}),/absolute/);
});

test("P2 task dependency waves topologically sorted; unknown/cyclic edges fail closed", () => {
  const one=task({id:"schema"});
  const two=task({id:"ui",dependsOn:["schema"]});
  const three=task({id:"api",dependsOn:["schema"]});
  const four=task({id:"integration",dependsOn:["api","ui"]});
  assert.deepEqual(orderExecutionWaves([one,two,three,four],2).map(w=>w.map(x=>x.id)),[
    ["schema"],["ui","api"],["integration"]
  ]);
  assert.throws(()=>orderExecutionWaves([task({id:"a",dependsOn:["b"]}),task({id:"b",dependsOn:["a"]})]),/cycle/);
  assert.throws(()=>orderExecutionWaves([task({id:"a",dependsOn:["missing"]})]),/unknown dependency/);
  assert.throws(()=>orderExecutionWaves([one,one]),/unique/);
});
