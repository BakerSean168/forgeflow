import { registerWorkflowResource } from "pi-subagents/workflow-resources";
import { renderPreflight } from "./invariants.js";
import { createAcceptanceWorkflowDefinition } from "./acceptance-workflow.js";
import { createReviewWorkflowDefinition } from "./review-workflow.js";

const CORE_POLICY = [
  "ForgeFlow is a thin engineering-governance extension for Pi; Pi and pi-subagents own agent execution, sessions, delegation, worktrees, missions, schedules, and resume.",
  "Do not create a second agent runtime, workflow database, provider router, or duplicate subagent scheduler inside ForgeFlow.",
  "Keep one mutation writer per working tree. Independent reviewers must not mutate the candidate under review.",
  "Agent completion is evidence, not authority. For PR delivery, final acceptance must be tied to the authoritative current head and must invalidate stale CI/review evidence after every new push.",
  "Prefer existing Pi/pi-subagents capabilities over ForgeFlow-specific infrastructure. Add extension code only for engineering policy that Pi does not already own."
];

export function buildForgeFlowPromptSection(prompt) {
  return [...CORE_POLICY, "", ...renderPreflight(prompt)].join("\n");
}

export default function registerForgeFlow(pi) {
  let reviewRegistration;
  let acceptanceRegistration;

  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.forgeflow_policy = buildForgeFlowPromptSection(event.prompt);
  });

  pi.on("session_start", (_event, ctx) => {
    reviewRegistration?.dispose();
    acceptanceRegistration?.dispose();

    const sessionId = ctx.sessionManager.getSessionId();
    reviewRegistration = registerWorkflowResource({
      sessionId,
      definition: createReviewWorkflowDefinition()
    });
    acceptanceRegistration = registerWorkflowResource({
      sessionId,
      definition: createAcceptanceWorkflowDefinition()
    });
  });

  pi.on("session_shutdown", () => {
    reviewRegistration?.dispose();
    acceptanceRegistration?.dispose();
    reviewRegistration = undefined;
    acceptanceRegistration = undefined;
  });
}
