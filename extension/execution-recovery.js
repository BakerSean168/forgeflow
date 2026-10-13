// A preflight decision, NOT an autonomous restart/replay engine.
// The actual Run lifecycle, latest checkpoints, authorizations and handoffs
// remain with pi-subagents, the operator, and the existing Active Plan.
import { captureWorktreeEvidence } from "./execution-git.js";
import { classifySupplyFailure } from "./model-policy.js";

const TERMINAL_FAILURE = new Set(["failed", "stopped"]);
const SEMANTIC_ERRORS = [
  { id: "context-overflow", pattern: /context.{0,18}(overflow|length|too long|limit)|prompt.{0,12}too.long/i },
  { id: "invalid-request", pattern: /invalid.request|bad.request|schema.invalid|invalid tool|malformed/i },
  { id: "policy-rejection", pattern: /content.policy|policy.violat|safety.refusal/i },
  { id: "tool-failure", pattern: /tool.execution|tool.error|shell.command.failed|build.failed|test.failed/i }
];
const RUNTIME_FAILURES = [
  { id: "agent-runtime", pattern: /agent.crash|process.exited|spawn.failure|process.terminated|signal.sig(term|kill)|worker.crashed/i },
  { id: "agent-timeout", pattern: /run.timed.out|worker.timeout|agent.timeout|watchdog.timeout/i },
  { id: "operator-stopped", pattern: /operator.stopped|owner.stopped|manual.stop/i }
];

export function classifyExecutionFailure(message) {
  if (typeof message !== "string" || message.length > 16384) {
    throw new Error("failureMessage must be <= 16 KiB");
  }
  for (const reason of SEMANTIC_ERRORS) {
    if (reason.pattern.test(message)) return { category: reason.id, supplyRelated: false };
  }
  for (const reason of RUNTIME_FAILURES) {
    if (reason.pattern.test(message)) return { category: reason.id, supplyRelated: false };
  }
  const supply = classifySupplyFailure(message);
  if (supply) return { category: supply, supplyRelated: true };
  return { category: "unknown", supplyRelated: false };
}

function nonblank(input, label, max = 2048) {
  if (typeof input !== "string" || !input.trim() || input.length > max) {
    throw new Error(`${label} must be nonblank (<=${max})`);
  }
  return input;
}
function validDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

// The status and approval records MUST be supplied from independently reviewed
// pi-subagents + operator evidence. Fields here cannot cryptographically certify
// a source or fabricate an actual user approval.
export function assessExecutionTakeover(input, options = {}) {
  const reasons = [];
  const run = input?.run;
  const checkpoint = input?.checkpoint;
  const approval = input?.approval;
  let snapshot;
  let failure;
  if (!run || typeof run !== "object") throw new Error("run evidence is required");
  const runId = nonblank(run.id, "run.id");
  nonblank(run.agent, "run.agent", 128);
  nonblank(run.worktree, "run.worktree");
  if (typeof run.error !== "string") throw new Error("run.error is required");
  failure = classifyExecutionFailure(run.error);
  const recoveryClasses = new Set(["agent-runtime", "agent-timeout", "operator-stopped"]);
  if (!failure.supplyRelated && !recoveryClasses.has(failure.category)) {
    reasons.push("failure-not-eligible-for-agent-substitution");
  }
  if (!options.policy || !Array.isArray(options.policy.profiles)) {
    reasons.push("missing-authoritative-execution-policy");
  } else {
    const candidates = options.policy.profiles.filter((p) => p.agent === input.targetAgent);
    if (!candidates.some((p) => p.enabled && p.health === "verified" &&
      p.access === "write" && p.runtime === "external-cli" && p.isolation === "prepared-worktree")) {
      reasons.push("target-agent-not-eligible-for-dirty-worktree-takeover");
    }
  }

  if (!TERMINAL_FAILURE.has(run.status)) reasons.push("old-run-not-confirmed-terminal-failure");
  if (run.owner !== "pi-subagents") reasons.push("run-status-must-be-attested-from-pi-subagents");
  if (run.stopConfirmed !== true) reasons.push("old-agent-termination-not-confirmed");
  if (typeof checkpoint?.summary !== "string" || !checkpoint.summary.trim()) {
    reasons.push("missing-durable-handoff-summary");
  }
  if (!validDigest(checkpoint?.fingerprint)) reasons.push("missing-captured-worktree-fingerprint");
  if (!/^[a-f0-9]{40,64}$/.test(checkpoint?.head ?? "")) {
    reasons.push("missing-checkpoint-head");
  }
  if (checkpoint?.sourceRunId !== runId) reasons.push("checkpoint-run-id-mismatch");

  // Never start the second writer without explicit scope-specific approval.
  if (approval?.granted !== true || approval?.scope !== "cross-agent"
      || approval?.sourceRunId !== runId || !approval?.id || !approval?.by) {
    reasons.push("explicit-operator-cross-agent-approval-required");
  }
  if (input.targetAgent === run.agent || !input.targetAgent) {
    reasons.push("takeover-must-specify-different-agent");
  }
  if (input.targetWorktree && input.targetWorktree !== run.worktree) {
    reasons.push("takeover-requires-same-reviewed-worktree");
  }
  if (Array.isArray(input.activeWriterRunIds)
      && input.activeWriterRunIds.some((id) => id !== runId)) {
    reasons.push("another-active-writer-is-recorded");
  }
  if (!Array.isArray(input.activeWriterRunIds)) {
    reasons.push("current-active-writer-roster-required");
  }
  try {
    snapshot = (options.captureEvidence ?? captureWorktreeEvidence)(run.worktree);
    if (snapshot.cwd !== run.worktree) reasons.push("worktree-path-must-be-canonical");
    if (snapshot.head !== checkpoint?.head) reasons.push("head-changed-since-checkpoint");
    if (snapshot.fingerprint !== checkpoint?.fingerprint) {
      reasons.push("partial-diff-changed-since-checkpoint");
    }
  } catch {
    reasons.push("unable-to-verify-current-git-snapshot");
  }
  const blocked = [...new Set(reasons)];
  return {
    ok: blocked.length === 0, oldRun: runId, fromAgent: run.agent,
    targetAgent: input.targetAgent ?? null,
    failure, currentHead: snapshot?.head ?? null,
    dirtyWorktree: snapshot?.dirty ?? null,
    blocked,
    status: blocked.length === 0 ? "eligible-for-controlled-manual-handoff" : "blocked",
    automaticRestart: false,
    requires: [
      "The operator must verify the active-run roster and explicit approval outside this helper.",
      "Resume the old retained child first when it is eligible; this cross-Agent path is only for failed/stopped irrecoverable ownership.",
      "The new agent must receive the verified checkpoint and diff digest; do not discard partial work.",
      "After the new child completes, check exact-head tests/review/CI before recording acceptance."
    ],
    ...(blocked.length === 0 ? {
      handoff: {
        cwd: snapshot.cwd,
        fromRunId: runId,
        fromAgent: run.agent,
        toAgent: input.targetAgent,
        checkpointHead: checkpoint.head,
        checkpointFingerprint: checkpoint.fingerprint,
        checkpointSummary: checkpoint.summary,
        approvalId: approval.id,
        warnings: [
          "No new Agent has been launched.",
          "This attestation is an eligibility check, not an independent verification of external provenance."
        ]
      }
    } : {})
  };
}
