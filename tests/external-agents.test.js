import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { registerAgent } from "pi-subagents/agents";
import {
  ACP_SUBAGENT_BRIDGE_PATH,
  EXTERNAL_ACP_AGENTS,
  registerExternalAcpAgents
} from "../extension/external-agents.js";

test("external ACP agents have explicit read-only / writer identities", () => {
  assert.deepEqual(EXTERNAL_ACP_AGENTS.map((x) => x.name), [
    "glm-agent", "glm-agent-writer", "zcode-agent", "zcode-agent-writer", "dsh-agent-writer"
  ]);
  for (const { name, definition } of EXTERNAL_ACP_AGENTS) {
    assert.equal(definition.runner.type, "external-cli", name);
    assert.equal(definition.runner.command, process.execPath);
    assert.equal(definition.runner.args[0], ACP_SUBAGENT_BRIDGE_PATH);
    assert.equal(definition.runner.promptDelivery, "stdin");
    assert.equal(definition.defaultAsync, true);
    assert.equal(definition.acceptanceRole, name.endsWith("-writer") ? "writer" : "read-only");
  }
  assert.deepEqual(EXTERNAL_ACP_AGENTS[4].definition.runner.args.slice(1), ["dsh", "writer"]);
});

test("pi-subagents validates all five runtime agent definitions", () => {
  const pi = { on() {}, registerTool() {} };
  for (const agent of EXTERNAL_ACP_AGENTS) {
    registerAgent({ pi, name: agent.name, definition: agent.definition }).dispose();
  }
});

test("registration belongs to pi-subagents and disposes atomically", () => {
  const requests = [];
  const disposed = [];
  const pi = {
    events: {
      emit(event, request) {
        assert.equal(event, "pi-subagents:runtime-agent-register:v1");
        requests.push(request.name);
        request.result = {
          ok: true,
          registration: { dispose: () => disposed.push(request.name) }
        };
      }
    }
  };
  const registration = registerExternalAcpAgents(pi);
  assert.deepEqual(requests, EXTERNAL_ACP_AGENTS.map((x) => x.name));
  registration.dispose();
  assert.deepEqual(disposed, requests.toReversed());
  assert.equal(registerExternalAcpAgents({ events: { emit() {} } }), undefined);
});

const MOCK = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const results = [];
let lastMode = "unset";
function send(frame) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\\n"); }
function record(event) { results.push(event); fs.writeFileSync(process.env.FAKE_TRACE, JSON.stringify(results)); }
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const x = JSON.parse(line);
  if (x.method === "initialize") {
    record({ method: x.method, clientCapabilities: x.params.clientCapabilities });
    return send({ id: x.id, result: { protocolVersion: 1, agentInfo: { name: "mock", version: "1.0" } } });
  }
  if (x.method === "session/new") {
    record({ method: x.method, cwd: x.params.cwd, mcpServers: x.params.mcpServers });
    const modes = process.env.FAKE_AGENT === "dsh" ? undefined : {
      availableModes: process.env.FAKE_AGENT === "glm"
        ? [{ id: "default" }, { id: "accept_edits" }]
        : [{ id: "plan" }, { id: "build" }],
      currentModeId: "unset"
    };
    return send({ id: x.id, result: { sessionId: "mock-session", ...(modes ? { modes } : {}) } });
  }
  if (x.method === "session/set_mode") {
    lastMode = x.params.modeId;
    record({ method: x.method, mode: lastMode });
    return send({ id: x.id, result: {} });
  }
  if (x.method === "session/prompt") {
    record({ method: x.method, prompt: x.params.prompt[0].text });
    if (process.env.FAKE_BEHAVIOR === "no_message") {
      send({ method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "secret thinking" } } } });
      return send({ id: x.id, result: { stopReason: "end_turn" } });
    }
    if (process.env.FAKE_BEHAVIOR === "bad_stop") {
      send({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } } } });
      return send({ id: x.id, result: { stopReason: "cancelled" } });
    }
    if (process.env.FAKE_BEHAVIOR === "upstream_error") return send({ id: x.id, error: { code: 429, message: "sensitive error details" } });
    if (process.env.FAKE_BEHAVIOR === "permission") {
      globalThis.waitingId = x.id;
      return send({ id: 900, method: "session/request_permission", params: { options: [
        { kind: "allow_once", optionId: "yes" }, { kind: "deny_once", optionId: "no" }
      ] } });
    }
    if (process.env.FAKE_BEHAVIOR === "timeout") return;
    send({ method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hidden reasoning" } } } });
    send({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK " } } } });
    send({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "DONE" } } } });
    process.stderr.write("SENSITIVE_MOCK_VALUE_SHOULD_NOT_LEAK\\n");
    return send({ id: x.id, result: { stopReason: "end_turn" } });
  }
  if (x.id === 900) {
    const outcome = x.result?.outcome ?? {};
    record({ method: "permission_result", outcome });
    send({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "permission=" + outcome.optionId } } } });
    return send({ id: globalThis.waitingId, result: { stopReason: "end_turn" } });
  }
});
`;

function fakeRun(t, agent, role, options = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "forgeflow-acp-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const executable = path.join(tmp, "fake-acp");
  const trace = path.join(tmp, "trace.json");
  writeFileSync(executable, MOCK);
  chmodSync(executable, 0o755);
  const run = spawnSync(process.execPath, [ACP_SUBAGENT_BRIDGE_PATH, agent, role], {
    cwd: tmp,
    input: "Inspect carefully; literal $(do_not_expand)\nsecond line",
    encoding: "utf8",
    timeout: 8_000,
    env: {
      ...process.env,
      FORGEFLOW_GLM_ACP_COMMAND: executable,
      FORGEFLOW_ZCODE_ACP_COMMAND: executable,
      FORGEFLOW_DSH_ACP_COMMAND: executable,
      FORGEFLOW_ACP_RUN_TIMEOUT_MS: "1200",
      FAKE_AGENT: agent,
      FAKE_TRACE: trace,
      FAKE_BEHAVIOR: options.behavior || ""
    }
  });
  return { run, trace: JSON.parse(readFileSync(trace, "utf8")) };
}

for (const [name, runtime, role, expectedMode] of [
  ["GLM advisor", "glm", "plan", "default"],
  ["GLM writer", "glm", "writer", "accept_edits"],
  ["ZCode advisor", "zcode", "plan", "plan"],
  ["ZCode writer", "zcode", "writer", "build"],
  ["DSH writer", "dsh", "writer", null]
]) {
  test(`${name} completes ACP handshake, mode selection and bounded final message`, (t) => {
    const { run, trace } = fakeRun(t, runtime, role);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "OK DONE\n");
    assert.doesNotMatch(run.stdout + run.stderr, /SENSITIVE_MOCK_VALUE|hidden reasoning/);
    assert.equal(trace[0].method, "initialize");
    assert.equal(trace[0].clientCapabilities.terminal, false);
    assert.deepEqual(trace[1].mcpServers, []);
    assert.ok(trace[trace.length - 1].prompt.includes("$(do_not_expand)"));
    const modes = trace.filter((x) => x.method === "session/set_mode");
    assert.deepEqual(modes.map((x) => x.mode), expectedMode ? [expectedMode] : []);
  });
}

test("analysis roles decline ACP permission requests; writers approve once", (t) => {
  for (const [runtime, role, expected] of [
    ["glm", "plan", "no"],
    ["zcode", "plan", "no"],
    ["glm", "writer", "yes"],
    ["zcode", "writer", "yes"],
    ["dsh", "writer", "yes"]
  ]) {
    const result = fakeRun(t, runtime, role, { behavior: "permission" });
    assert.equal(result.run.status, 0, result.run.stderr);
    assert.equal(result.run.stdout, `permission=${expected}\n`);
    const reply = result.trace.find((x) => x.method === "permission_result");
    assert.equal(reply.outcome.optionId, expected);
  }
});

test("reasoning-only stop, cancelled turn, and provider API errors are failures", (t) => {
  for (const [behavior, message] of [
    ["no_message", "empty response"],
    ["bad_stop", "without successful completion"],
    ["upstream_error", "code 429"]
  ]) {
    const { run } = fakeRun(t, "glm", "plan", { behavior });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, new RegExp(message));
    assert.doesNotMatch(run.stderr, /sensitive error details/);
  }
});

test("hung ACP prompt times out instead of creating a false completion", (t) => {
  const { run } = fakeRun(t, "zcode", "writer", { behavior: "timeout" });
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /timed out/);
});

test("external agent selection rejects unsafe role and missing prompt", () => {
  const bad = spawnSync(process.execPath, [ACP_SUBAGENT_BRIDGE_PATH, "dsh", "plan"], { encoding: "utf8" });
  assert.equal(bad.status, 64);
  const empty = spawnSync(process.execPath, [ACP_SUBAGENT_BRIDGE_PATH, "glm", "plan"], { input: "", encoding: "utf8" });
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /must not be empty/);
});
