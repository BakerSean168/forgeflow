import { fileURLToPath } from "node:url";

import { registerAgentViaEvents } from "pi-subagents/agents";

const AGY_BRIDGE_PATH = fileURLToPath(
  new URL("../bin/agy-subagent.mjs", import.meta.url)
);

const RUNTIME_OWNER_UNAVAILABLE =
  /pi-subagents is not installed, not ready, or does not support runtime agent event registration/;

function definition(mode, options) {
  return {
    description: options.description,
    aliases: options.aliases,
    systemPrompt: options.systemPrompt,
    systemPromptMode: "replace",
    inheritProjectContext: true,
    inheritGlobalContext: false,
    inheritSkills: false,
    defaultAsync: true,
    acceptanceRole: options.acceptanceRole,
    runner: {
      type: "external-cli",
      command: process.execPath,
      args: [AGY_BRIDGE_PATH, mode],
      promptDelivery: "stdin"
    }
  };
}

export const ANTIGRAVITY_AGENTS = Object.freeze([
  Object.freeze({
    name: "antigravity",
    definition: Object.freeze(
      definition("plan", {
        aliases: ["agy"],
        acceptanceRole: "read-only",
        description:
          "Read-only Antigravity coding agent using the locally authenticated agy CLI and its own subscription quota",
        systemPrompt:
          "Analyze the requested engineering task using Antigravity in plan mode. Inspect as needed, do not modify the workspace, and return concise findings with concrete evidence."
      })
    )
  }),
  Object.freeze({
    name: "antigravity-writer",
    definition: Object.freeze(
      definition("accept-edits", {
        aliases: ["agy-writer"],
        acceptanceRole: "writer",
        description:
          "Workspace-writing Antigravity coding agent using the locally authenticated agy CLI and its own subscription quota",
        systemPrompt:
          "Implement the requested engineering task in the current workspace using Antigravity. Keep changes scoped, run relevant validation, and return a concise completion report with changed files and test evidence."
      })
    )
  })
]);

function disposeAll(registrations) {
  for (const registration of registrations.reverse()) {
    registration.dispose();
  }
}

export function registerAntigravityAgents(pi) {
  const registrations = [];

  try {
    for (const agent of ANTIGRAVITY_AGENTS) {
      registrations.push(
        registerAgentViaEvents({
          pi,
          name: agent.name,
          definition: agent.definition
        })
      );
    }
  } catch (error) {
    disposeAll(registrations);

    if (
      error instanceof Error &&
      RUNTIME_OWNER_UNAVAILABLE.test(error.message)
    ) {
      return undefined;
    }

    throw error;
  }

  return {
    dispose() {
      disposeAll(registrations);
    }
  };
}

export { AGY_BRIDGE_PATH };
