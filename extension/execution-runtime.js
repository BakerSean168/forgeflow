import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { createRoleRouter, loadModelPolicy } from "./model-policy.js";
import { loadExecutionPolicy } from "./execution-policy.js";

export const ACP_LAUNCHERS = Object.freeze({
  "glm-acp-t3": "FORGEFLOW_GLM_ACP_COMMAND",
  "zcode-acp-t3": "FORGEFLOW_ZCODE_ACP_COMMAND",
  "dsh": "FORGEFLOW_DSH_ACP_COMMAND"
});

export function executablePresent(name, env = process.env) {
  const actual = env[ACP_LAUNCHERS[name]]?.trim() || name;
  if (typeof actual !== "string" || !actual.trim() || /[\r\n\0]/.test(actual)) return false;
  const candidates = isAbsolute(actual)
    ? [actual]
    : (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, actual));
  return candidates.some((p) => {
    try { accessSync(p, constants.X_OK); return true; }
    catch { return false; }
  });
}

function decodeRoleVirtual(value) {
  const match = /^(forgeflow)\/(planner|worker|reviewer|scout|oracle)(?::(off|minimal|low|medium|high|xhigh|max))?$/.exec(value);
  if (!match) throw new Error("unsupported Pi virtual model");
  return { provider: match[1], role: match[2], thinking: match[3] };
}

// Pi context supplies its actual modelRegistry. The CLI can pass discovered
// model ids as an explicit inventory; an absent inventory never proves support.
export function executionRuntime(cwd, options = {}) {
  const models = options.models;
  const lookup = options.modelRegistry?.find
    ? (provider, id) => options.modelRegistry.find(provider, id)
    : Array.isArray(models) ? (provider, id) =>
      models.includes(`${provider}/${id}`) ? { provider, id, api: provider === "forgeflow" ? "pi-virtual" : "openai-completions" } : undefined
      : () => undefined;
  const supplied = Boolean(options.modelRegistry || Array.isArray(models));
  const trusted = options.trusted === true;
  const cachedPolicy = options.modelPolicy
    ? { path: "(injected)", policy: options.modelPolicy }
    : loadModelPolicy(cwd, options.env ?? process.env,
      options.home, { allowProject: trusted });
  return {
    isExecutable: (name) => executablePresent(name, options.env),
    isModelAvailable: (model) => {
      if (!supplied) return false;
      try { const x = decodeRoleVirtual(model); return Boolean(lookup(x.provider, x.role)); }
      catch { return false; }
    },
    resolvePiModel: (virtual, task) => {
      if (!supplied) throw new Error("No model inventory supplied");
      const { role, thinking } = decodeRoleVirtual(virtual);
      const resolver = createRoleRouter(role, { loadPolicy: () => cachedPolicy });
      const msg = `[[forgeflow:task=${task.kind}]]`;
      const resolved = resolver({ reason: "user", thinkingLevel: thinking,
        messages: [{ role: "user", content: msg }] }, {
        cwd, isProjectTrusted: () => trusted,
        modelRegistry: { find: lookup }
      });
      return { physicalModel: `${resolved.model.provider}/${resolved.model.id}`,
        resolvedThinking: resolved.thinkingLevel };
    }
  };
}

export function inspectExecutionInventory(cwd, options = {}) {
  const { path, policy } = options.policy
    ? { path: "(explicit)", policy: options.policy }
    : loadExecutionPolicy(cwd, options);
  const runtime = executionRuntime(cwd, options);
  const catalog = policy.profiles.map((p) => {
    let physicalModel = null;
    if (p.model && runtime.isModelAvailable(p.model)) {
      try {
        physicalModel = runtime.resolvePiModel(p.model, { kind: p.kinds[0] }).physicalModel;
      } catch { /* absent physical model is not healthy */ }
    }
    return {
      id: p.id, agent: p.agent, runtime: p.runtime,
      model: p.model ?? p.modelLabel, provider: p.providerLabel ?? "Pi Model Policy V3",
      access: p.access, enabled: p.enabled, health: p.health, isolation: p.isolation,
      executableFound: p.executable ? runtime.isExecutable(p.executable) : null,
      modelRegistered: p.model ? runtime.isModelAvailable(p.model) : null,
      allowedPhysicalModels: p.expectedPhysicalModels ?? null,
      resolvedPhysicalModel: physicalModel,
      availableForPlanning: p.enabled && p.health === "verified"
        && (p.executable ? runtime.isExecutable(p.executable)
          : p.expectedPhysicalModels.includes(physicalModel))
    };
  });
  return {
    policyPath: path, policyVersion: policy.version,
    profiles: catalog,
    notes: [
      "Discovery and cached health are not proof of live upstream quota or successful execution.",
      "External ACP agents own model/provider configuration; modelLabel is not a model override.",
      "A healthy delegated run and current-head test/CI evidence are mandatory for delivery."
    ]
  };
}
