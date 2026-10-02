import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderPreflight } from "./invariants.js";

const MAX_TASK_LENGTH = 12000;
const VERDICT_HELPER_PATH = fileURLToPath(new URL("../scripts/review-verdict.mjs", import.meta.url));

export const REVIEW_VERDICT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    status: { enum: ["clean", "blocked"] },
    verdict: { enum: ["BLOCK", "OK", "OK with notes"] }
  },
  required: ["status", "verdict"]
});

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function validateTask(args) {
  const keys = Object.keys(args);
  if (keys.some((key) => key !== "task")) {
    return { error: "forgeflow.review supports only the task field." };
  }
  if (typeof args.task !== "string") {
    return { error: "task must be a string." };
  }
  const task = args.task.trim();
  if (!task || task.length > MAX_TASK_LENGTH) {
    return { error: `task must contain 1-${MAX_TASK_LENGTH} characters.` };
  }
  return { task };
}

export function reviewContractTask(lines) {
  return [
    ...lines,
    "",
    "Use your normal reviewer report format for findings and evidence.",
    "End with Pi's standard merge verdict contract: Merge verdict: BLOCK, OK, or OK with notes.",
    "The builtin reviewer may render that final verdict as its final Markdown list item.",
    "Do not add any text after the final merge verdict."
  ].join("\n");
}

export function reviewVerdictCommand(reportPath) {
  return [
    shellQuote(process.execPath),
    shellQuote(VERDICT_HELPER_PATH),
    "--report",
    shellQuote(reportPath)
  ].join(" ");
}

export function reviewVerdictGate(reportPath) {
  return {
    command: reviewVerdictCommand(reportPath),
    output: "json",
    schema: REVIEW_VERDICT_SCHEMA,
    timeoutMs: 15000
  };
}

export function createReviewWorkflowDefinition(repoRoot) {
  if (typeof repoRoot !== "string" || !repoRoot) {
    throw new Error("ForgeFlow review workflow requires the session cwd.");
  }

  return {
    name: "forgeflow.review",
    version: 3,
    resolve(args) {
      const validated = validateTask(args);
      if ("error" in validated) return validated;

      const task = validated.task;
      const preflight = renderPreflight(task).join("\n");
      const reviewTask = reviewContractTask([
        "You are the independent ForgeFlow reviewer.",
        "Review the current repository diff against the operator task and the existing owner contracts.",
        "Do not mutate files.",
        "A child or implementation agent claiming success is not acceptance.",
        "Report only evidence-backed findings. Use BLOCK when any finding requires another code change before delivery.",
        "",
        "Operator task:",
        task,
        "",
        preflight
      ]);
      const reportPath = resolve(repoRoot, `.pi/subagents/forgeflow-review-${randomUUID()}.md`);
      const gate = reviewVerdictGate(reportPath);

      return {
        script: `
          const requestedReportPath = ${JSON.stringify(reportPath)};
          const review = await runs.run("forgeflow-review", {
            label: "Review ForgeFlow candidate",
            agent: "reviewer",
            model: "forgeflow/reviewer",
            context: "fresh",
            agentContract: { version: 1 },
            task: ${JSON.stringify(reviewTask)},
            output: requestedReportPath,
            outputMode: "file-only",
            gate: ${JSON.stringify(gate)}
          });
          if (!review.ok || !review.structuredOutput) {
            throw new Error("ForgeFlow independent reviewer or verdict gate failed");
          }

          return { ...review.structuredOutput, reportPath: requestedReportPath };
        `
      };
    }
  };
}
