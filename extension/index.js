import { fileURLToPath } from "node:url";

import { registerRequiredChildExtensions } from "pi-subagents/required-child-extensions";
import { registerAntigravityAgents } from "./antigravity.js";
import { registerExternalAcpAgents } from "./external-agents.js";
import { registerExecutionPolicyTool } from "./execution-tool.js";
import { renderPreflight } from "./invariants.js";
import { registerForgeFlowVirtualModels } from "./model-policy.js";
import { createUsageRecorder } from "./usage.js";

const FORGEFLOW_EXTENSION_PATH = fileURLToPath(import.meta.url);

const CORE_POLICY = [
  "ForgeFlow is a thin engineering-governance extension for Pi; Pi and installed plugins own execution, sessions, delegation, review loops, acceptance gates, worktrees, missions, schedules, and resume.",
  "ForgeFlow may define stable logical model roles, but Pi owns virtual-model dispatch and the provider layer owns channel, credential, quota, and transport routing.",
  "When delegating through forgeflow/* roles, classify the task explicitly when useful by prefixing the delegated prompt with [[forgeflow:task=<class>]], where class is recon, mechanical, implementation, debug, review, architecture, product-judgment, or root-cause. Omit the marker when the role's effort-based default routing is desired.",
  "Do not create a second agent runtime, workflow database, provider gateway, reviewer runtime, PR gate, or duplicate subagent scheduler inside ForgeFlow.",
  "Keep one mutation writer per working tree. Independent reviewers must not mutate the candidate under review.",
  "External coding agents, when installed, can be delegated through pi-subagents: glm-agent and zcode-agent are analysis roles; glm-agent-writer, zcode-agent-writer and dsh-agent-writer are explicit mutation roles. Use async local delegation; their own configured model and provider remain authoritative.",
  "For approved multi-agent engineering plans, call forgeflow_execution inventory/select/plan to choose an eligible execution profile before delegation; the tool never launches work. Explicitly classify task class, complexity, read/write authority, prerequisites and acceptance, then use pi-subagents for execution and exact-head verification.",
  "Native Pi writers use pi-subagents managed worktrees. External ACP writers require registered clean independent worktrees and explicit cwd; verify current plugin-owned writer status before dispatch. Never run generic external-cli writers via managed worktree or per-step cwd in runs.all.",
  "Cross-Agent failure handoff requires a terminated original run, a captured Git checkpoint/diff fingerprint, explicit operator approval and fresh pi-subagents owner verification. Use forgeflow_execution recover as a preflight; it never resumes/starts an Agent.",
  "Agent completion is evidence, not authority. For PR delivery, final acceptance must be tied to the authoritative current head and stale evidence must be invalidated after every new push.",
  "Prefer existing Pi/plugin capabilities over ForgeFlow-specific infrastructure. Add extension code only for engineering policy that Pi and installed plugins do not already own."
];

export function buildForgeFlowPromptSection(prompt) {
  return [...CORE_POLICY, "", ...renderPreflight(prompt)].join("\n");
}

export default function registerForgeFlow(pi) {
  const usageRecorder = createUsageRecorder();
  registerForgeFlowVirtualModels(pi, { onDecision: usageRecorder.recordDecision });
  registerExecutionPolicyTool(pi);

  let requiredChildRegistration;
  let antigravityRegistration;
  let externalAcpRegistration;

  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.forgeflow_policy = buildForgeFlowPromptSection(event.prompt);
  });

  pi.on("message_end", (event, ctx) => {
    try {
      usageRecorder.recordMessage(event, ctx);
    } catch {
      // Observability is best-effort and must never break an agent turn.
    }
  });

  pi.on("session_start", (_event, ctx) => {
    requiredChildRegistration?.dispose();
    antigravityRegistration?.dispose();
    externalAcpRegistration?.dispose();

    requiredChildRegistration = registerRequiredChildExtensions({
      sessionId: ctx.sessionManager.getSessionId(),
      extensions: [{ id: "forgeflow", path: FORGEFLOW_EXTENSION_PATH }]
    });
    antigravityRegistration = registerAntigravityAgents(pi);
    externalAcpRegistration = registerExternalAcpAgents(pi);
  });

  pi.on("session_shutdown", () => {
    externalAcpRegistration?.dispose();
    externalAcpRegistration = undefined;
    antigravityRegistration?.dispose();
    antigravityRegistration = undefined;
    requiredChildRegistration?.dispose();
    requiredChildRegistration = undefined;
  });
}
