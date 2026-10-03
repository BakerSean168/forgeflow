import assert from "node:assert/strict";
import test from "node:test";

import { createReviewWorkflowDefinition } from "../extension/review-workflow.js";

const ROOT = process.cwd();

test("review resource rejects unknown public arguments", () => {
  const definition = createReviewWorkflowDefinition(ROOT);
  const result = definition.resolve({ task: "Review this", command: "rm -rf /" });
  assert.deepEqual(result, { error: "forgeflow.review supports only the task field." });
});

test("review resource persists reviewer prose and uses Pi typed gate for deterministic verdict", () => {
  const definition = createReviewWorkflowDefinition(ROOT);
  const result = definition.resolve({ task: "Review the retry implementation" });

  assert.equal(definition.version, 4);
  assert.equal("error" in result, false);
  assert.equal(result.hostCommands, undefined);
  assert.match(result.script, /agent: "reviewer"/);
  assert.match(result.script, /model: "forgeflow\/reviewer"/);
  assert.match(result.script, /context: "fresh"/);
  assert.match(result.script, /agentContract: \{ version: 1 \}/);
  assert.match(result.script, /outputMode: "file-only"/);
  assert.match(result.script, /standard merge verdict contract/);
  assert.match(result.script, /review-verdict\.mjs/);
  assert.match(result.script, /"output":"json"/);
  assert.match(result.script, /structuredOutput/);
  assert.match(result.script, /reportPath: requestedReportPath/);
  assert.doesNotMatch(result.script, /outputPathMapping/);
  assert.doesNotMatch(result.script, /artifactPaths/);
  assert.doesNotMatch(result.script, /outputReference/);
  assert.match(result.script, /INV-REPLAY-001/);
  assert.doesNotMatch(result.script, /outputSchema/);
  assert.doesNotMatch(result.script, /runs\.host/);
});

test("review task cannot widen typed gate command authority", () => {
  const definition = createReviewWorkflowDefinition(ROOT);
  const task = "Review this; rm -rf /; $(touch /tmp/nope)";
  const result = definition.resolve({ task });

  assert.equal("error" in result, false);
  const gateIndex = result.script.indexOf("review-verdict.mjs");
  assert.notEqual(gateIndex, -1);
  const gateWindow = result.script.slice(gateIndex, gateIndex + 1200);
  assert.equal(gateWindow.includes("rm -rf"), false);
  assert.equal(gateWindow.includes("touch /tmp/nope"), false);
  assert.match(result.script, /rm -rf/);
});
