import assert from "node:assert/strict";
import test from "node:test";

import { createReviewWorkflowDefinition } from "../src/review-workflow.js";

test("review resource rejects unknown public arguments", () => {
  const definition = createReviewWorkflowDefinition();
  const result = definition.resolve({ task: "Review this", command: "rm -rf /" });
  assert.deepEqual(result, { error: "forgeflow.review supports only the task field." });
});

test("review resource emits a fresh structured reviewer workflow", () => {
  const definition = createReviewWorkflowDefinition();
  const result = definition.resolve({ task: "Review the retry implementation" });

  assert.equal("error" in result, false);
  assert.match(result.script, /agent: "reviewer"/);
  assert.match(result.script, /context: "fresh"/);
  assert.match(result.script, /outputSchema/);
  assert.match(result.script, /INV-REPLAY-001/);
  assert.doesNotMatch(result.script, /runs\.host/);
});
