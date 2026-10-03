import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { registerAgent } from "pi-subagents/agents";
import {
  AGY_BRIDGE_PATH,
  ANTIGRAVITY_AGENTS,
  registerAntigravityAgents
} from "../extension/antigravity.js";

test("Antigravity runtime agents expose read-only and writer roles", () => {
  assert.deepEqual(
    ANTIGRAVITY_AGENTS.map(({ name }) => name),
    ["antigravity", "antigravity-writer"]
  );

  const [reader, writer] = ANTIGRAVITY_AGENTS;

  assert.equal(reader.definition.acceptanceRole, "read-only");
  assert.deepEqual(reader.definition.aliases, ["agy"]);
  assert.equal(reader.definition.runner.type, "external-cli");
  assert.equal(reader.definition.runner.command, process.execPath);
  assert.deepEqual(reader.definition.runner.args, [AGY_BRIDGE_PATH, "plan"]);

  assert.equal(writer.definition.acceptanceRole, "writer");
  assert.deepEqual(writer.definition.aliases, ["agy-writer"]);
  assert.deepEqual(writer.definition.runner.args, [
    AGY_BRIDGE_PATH,
    "accept-edits"
  ]);
});

test("Antigravity definitions satisfy the pi-subagents runtime validator", () => {
  const pi = {
    on() {},
    registerTool() {}
  };
  const registrations = ANTIGRAVITY_AGENTS.map((agent) =>
    registerAgent({
      pi,
      name: agent.name,
      definition: agent.definition
    })
  );

  for (const registration of registrations.reverse()) {
    registration.dispose();
  }
});

test("runtime registration is owned by pi-subagents and disposed together", () => {
  const requests = [];
  const disposed = [];

  const pi = {
    events: {
      emit(event, request) {
        assert.equal(event, "pi-subagents:runtime-agent-register:v1");
        requests.push(request);
        request.result = {
          ok: true,
          registration: {
            dispose() {
              disposed.push(request.name);
            }
          }
        };
      }
    }
  };

  const registration = registerAntigravityAgents(pi);
  assert.ok(registration);
  assert.deepEqual(
    requests.map(({ name }) => name),
    ["antigravity", "antigravity-writer"]
  );

  registration.dispose();
  assert.deepEqual(disposed, ["antigravity-writer", "antigravity"]);
});

test("missing pi-subagents owner leaves ForgeFlow usable", () => {
  const pi = {
    events: {
      emit() {}
    }
  };

  assert.equal(registerAntigravityAgents(pi), undefined);
});

test("agy bridge converts stdin into one safe --print argument", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "forgeflow-agy-test-"));
  const capture = path.join(dir, "capture.json");
  const fakeAgy = path.join(dir, process.platform === "win32" ? "agy.cmd" : "agy");

  if (process.platform === "win32") {
    writeFileSync(
      fakeAgy,
      `@echo off\r\nnode -e "require('fs').writeFileSync(process.env.AGY_CAPTURE, JSON.stringify(process.argv.slice(1)))" %*\r\n`
    );
  } else {
    writeFileSync(
      fakeAgy,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.AGY_CAPTURE, JSON.stringify(process.argv.slice(2)));
`
    );
    chmodSync(fakeAgy, 0o755);
  }

  const prompt = "Inspect this; echo $(danger) && keep newlines\nsecond line";
  const result = spawnSync(process.execPath, [AGY_BRIDGE_PATH, "plan"], {
    input: prompt,
    encoding: "utf8",
    env: {
      ...process.env,
      AGY_CAPTURE: capture,
      PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`
    }
  });

  assert.equal(result.status, 0, result.stderr);

  const args = JSON.parse(readFileSync(capture, "utf8"));
  assert.deepEqual(args.slice(0, 7), [
    "--mode",
    "plan",
    "--output-format",
    "text",
    "--dangerously-skip-permissions",
    "--print-timeout",
    "0s"
  ]);
  assert.equal(args[7], `--print=${prompt}`);
});
