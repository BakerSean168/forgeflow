import assert from "node:assert/strict";
import test from "node:test";

import { evaluateGithubAcceptance } from "../extension/github-acceptance.js";

const HEAD = "a".repeat(40);
const BASE = "main";
const REQUIRED = ["verify"];

function pr(overrides = {}) {
  return {
    state: "open",
    head: { sha: HEAD },
    base: { ref: BASE },
    ...overrides
  };
}

function evaluate(overrides = {}) {
  return evaluateGithubAcceptance({
    pullRequest: pr(),
    expectedHead: HEAD,
    baseRef: BASE,
    requiredChecks: REQUIRED,
    checkRuns: [{ id: 1, name: "verify", status: "completed", conclusion: "success" }],
    statuses: [],
    ...overrides
  });
}

test("accepts only an open PR at the expected base/head with required CI passing", () => {
  const result = evaluate();

  assert.deepEqual(result, {
    status: "accepted",
    reason: null,
    headSha: HEAD,
    requiredChecks: REQUIRED
  });
});

test("blocks when the authoritative PR head differs from the reviewed head", () => {
  const result = evaluate({
    pullRequest: pr({ head: { sha: "b".repeat(40) } })
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "PR_HEAD_MISMATCH");
  assert.equal(result.expectedHead, HEAD);
});

test("blocks when the pull request is retargeted to another base", () => {
  const result = evaluate({
    pullRequest: pr({ base: { ref: "release" } })
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "PR_BASE_MISMATCH");
  assert.equal(result.expectedBase, BASE);
  assert.equal(result.observedBase, "release");
});

test("reports pending when a required CI signal is still pending", () => {
  const result = evaluate({
    checkRuns: [{ id: 1, name: "verify", status: "in_progress", conclusion: null }]
  });

  assert.equal(result.status, "pending");
  assert.equal(result.reason, "CI_PENDING");
  assert.equal(result.requiredCheck, "verify");
});

test("blocks when a required CI signal fails", () => {
  const result = evaluate({
    checkRuns: [{ id: 1, name: "verify", status: "completed", conclusion: "failure" }]
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "CI_FAILED");
  assert.equal(result.requiredCheck, "verify");
});

test("fails closed when required CI policy is missing", () => {
  const result = evaluate({ requiredChecks: [] });

  assert.deepEqual(result, {
    status: "blocked",
    reason: "REQUIRED_CHECK_POLICY_MISSING"
  });
});

test("fails closed when a required check has no evidence", () => {
  const result = evaluate({ checkRuns: [], statuses: [] });

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "MISSING_REQUIRED_CHECK");
  assert.equal(result.requiredCheck, "verify");
});

test("fails closed on unrecognized required CI conclusions", () => {
  const result = evaluate({
    checkRuns: [{ id: 1, name: "verify", status: "completed", conclusion: "mystery" }]
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "CI_STATE_UNRECOGNIZED");
});

test("uses the newest rerun for a duplicated check name", () => {
  const result = evaluate({
    checkRuns: [
      {
        id: 10,
        name: "verify",
        status: "completed",
        conclusion: "failure",
        completed_at: "2026-10-02T01:00:00Z"
      },
      {
        id: 11,
        name: "verify",
        status: "completed",
        conclusion: "success",
        completed_at: "2026-10-02T01:05:00Z"
      }
    ]
  });

  assert.equal(result.status, "accepted");
});

test("fails closed when duplicate check evidence cannot be ordered", () => {
  const result = evaluate({
    checkRuns: [
      { name: "verify", status: "completed", conclusion: "failure" },
      { name: "verify", status: "completed", conclusion: "success" }
    ]
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "AMBIGUOUS_CHECK_NAME:verify");
});

test("uses the newest legacy commit status for a duplicated context", () => {
  const result = evaluate({
    checkRuns: [],
    statuses: [
      {
        id: 20,
        context: "verify",
        state: "failure",
        updated_at: "2026-10-02T01:00:00Z"
      },
      {
        id: 21,
        context: "verify",
        state: "success",
        updated_at: "2026-10-02T01:05:00Z"
      }
    ]
  });

  assert.equal(result.status, "accepted");
});
