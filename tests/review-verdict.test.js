import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { parseReviewVerdict } from "../extension/review-verdict.js";

for (const prefix of ["Merge verdict: ", "- Merge verdict: "]) {
  for (const [verdict, status] of [
    ["BLOCK", "blocked"],
    ["OK", "clean"],
    ["OK with notes", "clean"]
  ]) {
    const line = `${prefix}${verdict}`;
    test(`parses Pi canonical reviewer verdict: ${line}`, () => {
      assert.deepEqual(parseReviewVerdict(`## Review\n- evidence\n\n${line}\n`), {
        status,
        verdict
      });
    });
  }
}

test("fails closed when the verdict is not the final non-empty line", () => {
  const result = parseReviewVerdict("Merge verdict: OK\nextra prose");
  assert.equal(result.status, "invalid");
  assert.equal(result.reason, "REVIEW_VERDICT_MISSING");
});

test("fails closed on decoration, whitespace, noncanonical shape, or unknown spelling", () => {
  for (const report of [
    "**Merge verdict:** OK",
    "-- Merge verdict: OK",
    "* Merge verdict: OK",
    "Merge verdict: CLEAN",
    "- Merge verdict: ok",
    " Merge verdict: OK",
    "Merge verdict: OK ",
    "- Merge verdict: OK "
  ]) {
    assert.equal(parseReviewVerdict(report).status, "invalid", JSON.stringify(report));
  }
});

test("ignores whitespace-only lines after an exact canonical verdict", () => {
  assert.deepEqual(parseReviewVerdict("review body\nMerge verdict: OK\n \t\n"), {
    status: "clean",
    verdict: "OK"
  });
});

test("fails closed on empty or non-text reviewer output", () => {
  assert.deepEqual(parseReviewVerdict(" \n "), {
    status: "invalid",
    reason: "REVIEW_REPORT_EMPTY"
  });
  assert.deepEqual(parseReviewVerdict(null), {
    status: "invalid",
    reason: "REVIEW_REPORT_NOT_TEXT"
  });
});

test("review verdict helper reads the absolute reviewer artifact under .pi/subagents", () => {
  const root = process.cwd();
  const reviewRoot = resolve(root, ".pi/subagents");
  mkdirSync(reviewRoot, { recursive: true });
  const dir = mkdtempSync(resolve(reviewRoot, "verdict-test-"));
  const report = resolve(dir, "review.md");
  writeFileSync(report, "## Review\nNo issues found.\nMerge verdict: OK\n", "utf8");

  try {
    const helper = resolve(root, "scripts/review-verdict.mjs");
    const result = spawnSync(process.execPath, [helper, "--report", report], {
      cwd: root,
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      status: "clean",
      verdict: "OK"
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
