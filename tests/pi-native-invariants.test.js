import assert from "node:assert/strict";
import test from "node:test";

import { inferInvariants, renderPreflight } from "../src/invariants.js";
import { buildForgeFlowPromptSection } from "../src/index.js";

function ids(text) {
  return new Set(inferInvariants(text).map((rule) => rule.id));
}

test("portable birthday import surfaces owner, time, identity, and parity risks", () => {
  const found = ids(
    "Import an account birthday profile through a portable dry-run/apply path across Prisma and PowerSync with deterministic IDs"
  );

  for (const id of [
    "INV-ROOT-001",
    "INV-OWNER-001",
    "INV-TIME-001",
    "INV-IDENTITY-001",
    "INV-PARITY-001"
  ]) {
    assert.equal(found.has(id), true, id);
  }
});

test("trigger matching uses terms rather than substrings", () => {
  const found = ids("Update a refactor implementation without changing semantics");
  assert.equal(found.has("INV-TIME-001"), false);
  assert.equal(found.has("INV-ORDER-001"), false);
});

test("prompt section declares Pi ownership and deterministic preflight", () => {
  const section = buildForgeFlowPromptSection("Migrate a legacy importer with retry semantics");
  assert.match(section, /Pi and pi-subagents own agent execution/);
  assert.match(section, /Do not create a second agent runtime/);
  assert.match(section, /INV-CUTOVER-001/);
  assert.match(section, /INV-REPLAY-001/);
  assert.match(section, /Agent completion is evidence, not authority/);
});

test("preflight always includes the root owner-truth invariant", () => {
  const text = renderPreflight("Rename a button").join("\n");
  assert.match(text, /INV-ROOT-001/);
});
