import assert from "node:assert/strict";
import test from "node:test";

import {
  CLEAN_HEAD_COMMAND,
  createAcceptanceWorkflowDefinition
} from "../extension/acceptance-workflow.js";

const HEAD = "a".repeat(40);

function validArgs(overrides = {}) {
  return {
    task: "Ship the retry fix",
    owner: "BakerSean168",
    repo: "forgeflow",
    pr: 106,
    expectedHead: HEAD,
    baseRef: "main",
    requiredChecks: ["verify"],
    ...overrides
  };
}

test("acceptance resource validates public identity and CI policy fields", () => {
  const definition = createAcceptanceWorkflowDefinition();

  assert.deepEqual(definition.resolve({ ...validArgs(), command: "echo nope" }), {
    error: "forgeflow.accept received unsupported fields."
  });
  assert.deepEqual(definition.resolve(validArgs({ owner: "bad owner" })), {
    error: "owner is invalid."
  });
  assert.deepEqual(definition.resolve(validArgs({ pr: 0 })), {
    error: "pr must be a positive integer."
  });
  assert.deepEqual(definition.resolve(validArgs({ expectedHead: "abc" })), {
    error: "expectedHead must be a full hexadecimal commit id."
  });
  assert.deepEqual(definition.resolve(validArgs({ baseRef: "../main" })), {
    error: "baseRef is invalid."
  });
  assert.deepEqual(definition.resolve(validArgs({ requiredChecks: [] })), {
    error: "requiredChecks must contain 1-64 unique check names."
  });
  assert.deepEqual(definition.resolve(validArgs({ requiredChecks: ["verify", " verify "] })), {
    error: "requiredChecks must contain 1-64 unique check names."
  });
});

test("acceptance resource binds review and GitHub checks to one exact committed head", () => {
  const definition = createAcceptanceWorkflowDefinition();
  const result = definition.resolve(validArgs());

  assert.equal("error" in result, false);
  assert.equal(result.hostCommands.length, 3);
  assert.deepEqual(
    result.hostCommands.map((entry) => entry.key),
    ["head-before-review", "head-after-review", "github-exact-head"]
  );
  assert.equal(result.hostCommands[0].command, CLEAN_HEAD_COMMAND);
  assert.equal(result.hostCommands[1].command, CLEAN_HEAD_COMMAND);
  assert.match(result.hostCommands[2].command, /github-acceptance\.mjs/);
  assert.match(result.hostCommands[2].command, /--expected-head 'a{40}'/);
  assert.match(result.hostCommands[2].command, /--base-ref 'main'/);
  assert.match(result.hostCommands[2].command, /--required-checks-json '\["verify"\]'/);
  assert.match(result.script, /context: "fresh"/);
  assert.match(result.script, /agent: "reviewer"/);
  assert.match(result.script, /head-before-review/);
  assert.match(result.script, /head-after-review/);
  assert.match(result.script, /github-exact-head/);
  assert.match(result.script, /review\.structuredOutput\.verdict !== "clean"/);
  assert.match(result.script, /evidence\.status !== "accepted"/);
});

test("task text cannot widen host command authority", () => {
  const definition = createAcceptanceWorkflowDefinition();
  const injectedTask = "Review this; rm -rf /; $(touch /tmp/nope)";
  const result = definition.resolve(validArgs({ task: injectedTask }));

  assert.equal("error" in result, false);
  for (const grant of result.hostCommands) {
    assert.equal(grant.command.includes(injectedTask), false);
    assert.equal(grant.command.includes("rm -rf"), false);
    assert.equal(grant.command.includes("touch /tmp/nope"), false);
  }
  assert.match(result.script, /rm -rf/);
});
