import { renderPreflight } from "./invariants.js";

const MAX_TASK_LENGTH = 12000;

const REVIEW_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { enum: ["clean", "blocked"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: { enum: ["blocker", "high", "medium", "low"] },
          title: { type: "string" },
          evidence: { type: "string" },
          recommendation: { type: "string" }
        },
        required: ["severity", "title", "evidence", "recommendation"]
      }
    }
  },
  required: ["verdict", "summary", "findings"]
});

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

export function createReviewWorkflowDefinition() {
  return {
    name: "forgeflow.review",
    version: 1,
    resolve(args) {
      const validated = validateTask(args);
      if ("error" in validated) return validated;

      const task = validated.task;
      const preflight = renderPreflight(task).join("\n");
      const reviewTask = [
        "You are the independent ForgeFlow reviewer.",
        "Review the current repository diff against the operator task and the existing owner contracts.",
        "Do not mutate files.",
        "A child or implementation agent claiming success is not acceptance.",
        "Report only evidence-backed findings. Mark verdict=blocked when any finding requires another code change before delivery.",
        "For structured output, return exactly verdict, summary, and findings. Do not add acceptanceReport or any other top-level field.",
        "",
        "Operator task:",
        task,
        "",
        preflight
      ].join("\n");

      return {
        script: `
          const review = await runs.run("forgeflow-review", {
            label: "Review ForgeFlow candidate",
            agent: "reviewer",
            context: "fresh",
            task: ${JSON.stringify(reviewTask)},
            outputSchema: ${JSON.stringify(REVIEW_SCHEMA)}
          });
          if (!review.ok) throw new Error("ForgeFlow independent reviewer failed");
          if (!review.structuredOutput) throw new Error("ForgeFlow reviewer returned no structured verdict");
          return review.structuredOutput;
        `
      };
    }
  };
}

export { REVIEW_SCHEMA };
