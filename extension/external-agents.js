import { fileURLToPath } from "node:url";
import { registerAgentViaEvents } from "pi-subagents/agents";

const BRIDGE_PATH = fileURLToPath(new URL("../bin/acp-subagent.mjs", import.meta.url));
const OWNER_UNAVAILABLE =
  /pi-subagents is not installed, not ready, or does not support runtime agent event registration/;

function definition(runtime, mode, { description, aliases, role, prompt }) {
  return {
    description,
    aliases,
    systemPrompt: prompt,
    systemPromptMode: "replace",
    inheritProjectContext: true,
    inheritGlobalContext: false,
    inheritSkills: false,
    defaultAsync: true,
    acceptanceRole: role,
    runner: {
      type: "external-cli",
      command: process.execPath,
      args: [BRIDGE_PATH, runtime, mode],
      promptDelivery: "stdin"
    }
  };
}

// The ACP executables, credentials, sessions and models remain native to the external Agent.
// Runtime registration is delegated to pi-subagents; ForgeFlow owns only the transport shim.
export const EXTERNAL_ACP_AGENTS = Object.freeze([
  Object.freeze({
    name: "glm-agent",
    definition: Object.freeze(definition("glm", "plan", {
      description: "Read-only GLM coding advisor over local ACP (no file mutations or permission approvals)",
      aliases: ["glm"],
      role: "read-only",
      prompt: "Inspect the project and offer concrete, source-backed advice. Never modify files or invoke mutating tools. Report any proposed changes without applying them."
    }))
  }),
  Object.freeze({
    name: "glm-agent-writer",
    definition: Object.freeze(definition("glm", "writer", {
      description: "Explicit GLM ACP workspace writer (auto-approve edits and per-command permissions)",
      aliases: ["glm-writer"],
      role: "writer",
      prompt: "Implement only the approved scoped task in the assigned working tree. Respect single-writer ownership. Validate changes and report exact files and test evidence."
    }))
  }),
  Object.freeze({
    name: "zcode-agent",
    definition: Object.freeze(definition("zcode", "plan", {
      description: "Read-only ZCode ACP planning agent (plan mode, write permissions denied)",
      aliases: ["zcode"],
      role: "read-only",
      prompt: "Plan or review the requested task in ZCode plan mode without modifying code. Cite project evidence and return actionable findings."
    }))
  }),
  Object.freeze({
    name: "zcode-agent-writer",
    definition: Object.freeze(definition("zcode", "writer", {
      description: "Explicit ZCode ACP build-mode writer (own model/provider; local execution only)",
      aliases: ["zcode-writer"],
      role: "writer",
      prompt: "Implement this bounded task using ZCode build mode. Respect ownership, avoid unrelated edits and verify the delivered change."
    }))
  }),
  Object.freeze({
    name: "dsh-agent-writer",
    definition: Object.freeze(definition("dsh", "writer", {
      description: "DSH ACP coding worker; no enforceable read-only ACP mode is advertised",
      aliases: ["dsh", "dsh-writer"],
      role: "writer",
      prompt: "Perform only the assigned engineering task within the working tree. Treat tool access as writable, validate the result and report precise evidence."
    }))
  })
]);

export function registerExternalAcpAgents(pi) {
  const registrations = [];
  try {
    for (const agent of EXTERNAL_ACP_AGENTS) {
      registrations.push(registerAgentViaEvents({
        pi, name: agent.name, definition: agent.definition
      }));
    }
  } catch (error) {
    for (const registration of registrations.reverse()) registration.dispose();
    if (error instanceof Error && OWNER_UNAVAILABLE.test(error.message)) return undefined;
    throw error;
  }
  return {
    dispose() {
      for (const registration of registrations.reverse()) registration.dispose();
    }
  };
}

export { BRIDGE_PATH as ACP_SUBAGENT_BRIDGE_PATH };
