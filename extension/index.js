import { fileURLToPath } from "node:url";

import { registerRequiredChildExtensions } from "pi-subagents/required-child-extensions";
import { registerWorkflowResource } from "pi-subagents/workflow-resources";
import { renderPreflight } from "./invariants.js";
import { createAcceptanceWorkflowDefinition } from "./acceptance-workflow.js";
import { createReviewWorkflowDefinition } from "./review-workflow.js";
import { registerForgeFlowVirtualModels } from "./model-policy.js";

const CHILD_MODEL_POLICY_EXTENSION = fileURLToPath(
  new URL("./child-model-policy.js", import.meta.url)
);

const CORE_POLICY = [
  "ForgeFlow is a thin engineering-governance extension for Pi; Pi and pi-subagents own agent execution, sessions, delegation, worktrees, missions, schedules, and resume.",
  "ForgeFlow may define stable logical model roles, but Pi owns virtual-model dispatch and the provider layer owns channel, credential, quota, and transport routing.",
  "Do not create a second agent runtime, workflow database, provider gateway, or duplicate subagent scheduler inside ForgeFlow.",
  "Keep one mutation writer per working tree. Independent reviewers must not mutate the candidate under review.",
  "Agent completion is evidence, not authority. For PR delivery, final acceptance must be tied to the authoritative current head and must invalidate stale CI/review evidence after every new push.",
  "Prefer existing Pi/pi-subagents capabilities over ForgeFlow-specific infrastructure. Add extension code only for engineering policy that Pi does not already own."
];

export function buildForgeFlowPromptSection(prompt) {
  return [...CORE_POLICY, "", ...renderPreflight(prompt)].join("\n");
}

export default function registerForgeFlow(pi) {
  registerForgeFlowVirtualModels(pi);

  let reviewRegistration;
  let acceptanceRegistration;
  let childModelPolicyRegistration;

  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.forgeflow_policy = buildForgeFlowPromptSection(event.prompt);
  });

  pi.on("session_start", (_event, ctx) => {
    reviewRegistration?.dispose();
    acceptanceRegistration?.dispose();
    childModelPolicyRegistration?.dispose();

    const sessionId = ctx.sessionManager.getSessionId();
    const sessionCwd = ctx.cwd;
    reviewRegistration = registerWorkflowResource({
      sessionId,
      definition: createReviewWorkflowDefinition(sessionCwd)
    });
    acceptanceRegistration = registerWorkflowResource({
      sessionId,
      definition: createAcceptanceWorkflowDefinition(sessionCwd)
    });
    childModelPolicyRegistration = registerRequiredChildExtensions({
      sessionId,
      extensions: [
        {
          id: "forgeflow-model-policy",
          path: CHILD_MODEL_POLICY_EXTENSION
        }
      ]
    });
  });

  pi.on("session_shutdown", () => {
    reviewRegistration?.dispose();
    acceptanceRegistration?.dispose();
    childModelPolicyRegistration?.dispose();
    reviewRegistration = undefined;
    acceptanceRegistration = undefined;
    childModelPolicyRegistration = undefined;
  });
}
