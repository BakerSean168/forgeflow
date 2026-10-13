#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { loadExecutionPolicy, selectExecutionProfile } from "../extension/execution-policy.js";
import { inspectExecutionInventory, executionRuntime } from "../extension/execution-runtime.js";
import { buildExecutionPlan } from "../extension/execution-plan.js";
import { assessExecutionTakeover } from "../extension/execution-recovery.js";
import { captureWorktreeEvidence } from "../extension/execution-git.js";

const action = process.argv[2];
const source = process.argv[3] ?? "-";
if (!["inventory", "select", "plan", "snapshot", "recover"].includes(action) || process.argv.length > 4) {
  process.stderr.write("Usage: forgeflow-execution <inventory|select|plan|snapshot|recover> [input.json|-]\n");
  process.exit(64);
}
try {
  let data = {};
  if (source !== "-") {
    if (!isAbsolute(source)) throw new Error("Input path must be absolute");
    data = JSON.parse(readFileSync(source, "utf8"));
  } else if (!process.stdin.isTTY) {
    const chunks = []; let bytes = 0;
    for await (const part of process.stdin) {
      bytes += part.length;
      if (bytes > 512 * 1024) throw new Error("Input exceeds 512 KiB");
      chunks.push(part);
    }
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (text) data = JSON.parse(text);
  }
  const cwd = process.cwd();
  let result;
  if (action === "snapshot") {
    result = captureWorktreeEvidence(data.worktree ?? cwd);
  } else if (action === "recover") {
    const { policy } = loadExecutionPolicy(cwd);
    result = assessExecutionTakeover(data.recovery ?? data, { policy });
  } else {
    const { path, policy } = loadExecutionPolicy(cwd);
    const runtime = executionRuntime(cwd, { models: data.availableModels });
    if (action === "inventory") {
      result = inspectExecutionInventory(cwd, { policy, models: data.availableModels });
    } else if (action === "select") {
      if (!data.task) throw new Error("select requires input.task");
      result = { policyPath: path, ...selectExecutionProfile(policy, data.task, runtime) };
    } else {
      if (!data.tasks) throw new Error("plan requires input.tasks");
      result = { policyPath: path, ...buildExecutionPlan(policy, data.tasks, {
        ...runtime, maxParallel: data.maxParallel ?? 4,
        activeWriterPaths: data.activeWriterPaths ?? []
      }) };
    }
  }
  const text = JSON.stringify(result, null, 2);
  if (Buffer.byteLength(text) > 180_000) throw new Error("Plan output too large");
  process.stdout.write(text + "\n");
  if (result.ok === false) process.exitCode = 2;
} catch (error) {
  // Keep diagnostics bounded and avoid echoing raw input/tasks or provider secrets.
  const message = String(error instanceof Error ? error.message : error).slice(0, 512);
  process.stderr.write(`ForgeFlow execution: ${message}\n`);
  process.exitCode = 1;
}
