import { inspectPreparedWorktree } from "./execution-git.js";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  validateTaskSet, orderExecutionWaves, selectExecutionProfile
} from "./execution-policy.js";

function approvedTask(task) {
  const notes = [task.description];
  notes.push(`Task: ${task.id} | Class: ${task.kind} | Complexity: ${task.complexity}`);
  if (task.acceptance.length) {
    notes.push("Acceptance criteria (validate against actual code/CI):");
    notes.push(...task.acceptance.map((a) => `- ${a}`));
  }
  notes.push("Report exact changed files, current HEAD, tests, blockers and next handoff.");
  notes.push("Do not perform unapproved scope expansions or independent provider/Agent failover.");
  return notes.join("\n\n");
}

export function buildExecutionPlan(policy, tasks, options = {}) {
  const list = validateTaskSet(tasks);
  const maxParallel = options.maxParallel ?? 4;
  const ordered = orderExecutionWaves(list, maxParallel);
  const selected = list.map((task) => selectExecutionProfile(policy, task, {
    ...options, inspectWorktree: options.inspectWorktree ?? inspectPreparedWorktree
  }));
  const failures = selected.filter((x) => !x.ok).map((x) => ({
    id: x.task.id, reason: "no-eligible-execution-profile", candidates: x.candidates
  }));

  // No two writer tasks in the same plan may share the same external worktree;
  // this remains fail-closed even if the tasks are ordered sequentially.
  const claims = new Map();
  for (const selection of selected) {
    if (!selection.ok || selection.selection.isolation !== "prepared-worktree"
      || selection.task.access !== "write") continue;
    const path = (options.inspectWorktree ?? inspectPreparedWorktree)(
      selection.task.repo, selection.task.cwd, selection.task.expectedHead
    ).cwd ?? selection.task.cwd;
    if (claims.has(path)) {
      failures.push({ id: selection.task.id, reason: "worktree-claimed-by-another-task",
        ownerTask: claims.get(path) });
    } else claims.set(path, selection.task.id);
  }
  const ownerPaths = options.activeWriterPaths ?? [];
  if (!Array.isArray(ownerPaths) || ownerPaths.length > 64 ||
      ownerPaths.some((p) => typeof p !== "string" || !isAbsolute(p))) {
    throw new Error("activeWriterPaths must be 0-64 absolute worktree paths");
  }
  const active = new Set(ownerPaths.map((p) => {
    try { return realpathSync(p); }
    catch { throw new Error("Unable to canonicalize activeWriterPaths entry"); }
  }));
  for (const [path, id] of claims) {
    if (active.has(path)) failures.push({ id, reason: "worktree-has-known-active-writer" });
  }
  if (failures.length) {
    return { ok: false, reason: "fail-closed-before-dispatch", failures, decisions: selected,
      launched: false };
  }

  const byId = new Map(selected.map((x) => [x.task.id, x]));
  const waves = ordered.map((wave, i) => {
    const native = [];
    const external = [];
    for (const task of wave) {
      const resolved = byId.get(task.id).selection;
      const launch = {
        agent: resolved.agent,
        task: approvedTask(task),
        async: true,
        ...(resolved.model ? { model: resolved.model } : {}),
        ...(resolved.isolation === "managed-worktree" ? { worktree: true } : {}),
        ...(resolved.isolation === "prepared-worktree" ? { cwd: task.cwd } : {}),
      };
      if (resolved.runtime === "pi") {
        native.push({ key: task.id, ...launch });
      } else {
        external.push({ key: task.id, ...launch, ownerVerificationRequired: resolved.access === "write" });
      }
    }
    return {
      index: i, taskIds: wave.map((t) => t.id),
      nativeRunsAll: native,
      externalSubagentCalls: external,
      requiresBarrier: i !== 0,
      requiresAcceptanceBeforeNextWave: true,
      notes: [
        "Each wave launches only after prior dependencies have reached verified acceptance.",
        ...(external.some((x) => x.ownerVerificationRequired) ? [
          "Immediately before external writer launch, inspect pi-subagents active runs/ownership.",
          "External CLI has no per-child cwd in runs.all: dispatch each as a separate subagent call with its explicit cwd."
        ] : []),
        ...(native.some((x) => x.worktree) ? ["Native Pi writer uses pi-subagents managed worktree."] : [])
      ]
    };
  });
  return { ok: true, policyVersion: policy.version, maxParallel,
    launched: false, engine: "pi-subagents", waves, decisions: selected,
    guarantees: ["topological-dependencies", "pre-launch-git-worktree-preflight",
      "no-reused-prepared-writer-path", "no-agent-runtime-spawned-by-forgeflow"],
    limitations: [
      "Git cannot prove no active pi-subagents writer; recheck the authoritative Run owner before every external launch.",
      "Only an accepted run plus current-head tests/CI may unlock a dependent wave.",
      "Generic external CLI writers require prepared independent worktrees; pi-subagents does not manage those worktrees."
    ]
  };
}
