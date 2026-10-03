import { fileURLToPath } from "node:url";

import { registerRequiredChildExtensions } from "pi-subagents/required-child-extensions";
import { renderPreflight } from "./invariants.js";
import { registerForgeFlowVirtualModels } from "./model-policy.js";

const FORGEFLOW_EXTENSION_PATH = fileURLToPath(import.meta.url);

const CORE_POLICY = [
  "ForgeFlow is a thin engineering-governance extension for Pi; Pi and installed plugins own execution, sessions, delegation, review loops, acceptance gates, worktrees, missions, schedules, and resume.",
  "ForgeFlow may define stable logical model roles, but Pi owns virtual-model dispatch and the provider layer owns channel, credential, quota, and transport routing.",
  "Do not create a second agent runtime, workflow database, provider gateway, reviewer runtime, PR gate, or duplicate subagent scheduler inside ForgeFlow.",
  "Keep one mutation writer per working tree. Independent reviewers must not mutate the candidate under review.",
  "Agent completion is evidence, not authority. For PR delivery, final acceptance must be tied to the authoritative current head and stale evidence must be invalidated after every new push.",
  "Prefer existing Pi/plugin capabilities over ForgeFlow-specific infrastructure. Add extension code only for engineering policy that Pi and installed plugins do not already own."
];

export function buildForgeFlowPromptSection(prompt) {
  return [...CORE_POLICY, "", ...renderPreflight(prompt)].join("\n");
}

export default function registerForgeFlow(pi) {
  registerForgeFlowVirtualModels(pi);

  let requiredChildRegistration;

  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.forgeflow_policy = buildForgeFlowPromptSection(event.prompt);
  });

  pi.on("session_start", (_event, ctx) => {
    requiredChildRegistration?.dispose();

    requiredChildRegistration = registerRequiredChildExtensions({
      sessionId: ctx.sessionManager.getSessionId(),
      extensions: [{ id: "forgeflow", path: FORGEFLOW_EXTENSION_PATH }]
    });
  });

  pi.on("session_shutdown", () => {
    requiredChildRegistration?.dispose();
    requiredChildRegistration = undefined;
  });
}
