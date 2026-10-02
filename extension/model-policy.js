import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const FORGEFLOW_MODEL_PROVIDER = "forgeflow";
export const FORGEFLOW_MODEL_POLICY_ENV = "FORGEFLOW_MODEL_POLICY";
export const FORGEFLOW_MODEL_ROLES = Object.freeze([
  "planner",
  "worker",
  "reviewer",
  "scout",
  "oracle"
]);

const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);

function modelPolicyCandidates(cwd, env = process.env, home = homedir(), options = {}) {
  const explicit = env[FORGEFLOW_MODEL_POLICY_ENV]?.trim();
  const candidates = [];

  if (explicit) {
    if (!isAbsolute(explicit)) {
      throw new Error(`${FORGEFLOW_MODEL_POLICY_ENV} must be an absolute path.`);
    }
    return [explicit];
  }

  if (options.allowProject !== false) {
    candidates.push(join(cwd, ".pi", "forgeflow-models.json"));
  }
  candidates.push(join(home, ".pi", "forgeflow-models.json"));
  return [...new Set(candidates)];
}

export function resolveModelPolicyPath(cwd, env = process.env, home = homedir(), options = {}) {
  return modelPolicyCandidates(cwd, env, home, options).find((path) => existsSync(path));
}

function validateRolePolicy(role, value, source) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`ForgeFlow model policy '${source}' has invalid role '${role}'; expected an object.`);
  }

  if (typeof value.model !== "string" || !value.model.trim()) {
    throw new Error(`ForgeFlow model policy '${source}' role '${role}' requires a non-empty 'model'.`);
  }

  const model = value.model.trim();
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) {
    throw new Error(
      `ForgeFlow model policy '${source}' role '${role}' must use a qualified physical model 'provider/model'.`
    );
  }

  const provider = model.slice(0, separator);
  const id = model.slice(separator + 1);
  if (provider === FORGEFLOW_MODEL_PROVIDER) {
    throw new Error(
      `ForgeFlow model policy '${source}' role '${role}' cannot route to another ForgeFlow virtual model.`
    );
  }

  let thinkingLevel;
  if (value.thinkingLevel !== undefined) {
    if (typeof value.thinkingLevel !== "string" || !THINKING_LEVELS.has(value.thinkingLevel)) {
      throw new Error(
        `ForgeFlow model policy '${source}' role '${role}' has invalid 'thinkingLevel'.`
      );
    }
    thinkingLevel = value.thinkingLevel;
  }

  return { provider, id, thinkingLevel };
}

export function parseModelPolicy(text, source = "<memory>") {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `ForgeFlow model policy '${source}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`ForgeFlow model policy '${source}' must be a JSON object.`);
  }
  if (raw.version !== 1) {
    throw new Error(`ForgeFlow model policy '${source}' requires version 1.`);
  }
  if (!raw.roles || typeof raw.roles !== "object" || Array.isArray(raw.roles)) {
    throw new Error(`ForgeFlow model policy '${source}' requires a 'roles' object.`);
  }

  const roles = {};
  for (const role of FORGEFLOW_MODEL_ROLES) {
    if (raw.roles[role] !== undefined) {
      roles[role] = validateRolePolicy(role, raw.roles[role], source);
    }
  }

  for (const role of Object.keys(raw.roles)) {
    if (!FORGEFLOW_MODEL_ROLES.includes(role)) {
      throw new Error(`ForgeFlow model policy '${source}' has unknown role '${role}'.`);
    }
  }

  return { version: 1, roles };
}

export function loadModelPolicy(cwd, env = process.env, home = homedir(), options = {}) {
  const path = resolveModelPolicyPath(cwd, env, home, options);
  if (!path) {
    const searched = modelPolicyCandidates(cwd, env, home, options).join(", ");
    throw new Error(
      `ForgeFlow model policy not found. Configure ${FORGEFLOW_MODEL_POLICY_ENV} or create .pi/forgeflow-models.json. Searched: ${searched}`
    );
  }

  return {
    path,
    policy: parseModelPolicy(readFileSync(path, "utf8"), path)
  };
}

function stickyRoute(request) {
  if (request.reason === "retry" && request.failed) {
    return {
      model: request.failed.model,
      thinkingLevel: request.failed.thinkingLevel ?? request.thinkingLevel
    };
  }
  if (request.reason === "continuation" && request.previous) {
    return {
      model: request.previous.model,
      thinkingLevel: request.previous.thinkingLevel ?? request.thinkingLevel
    };
  }
  return undefined;
}

export function createRoleRouter(role, options = {}) {
  const loadPolicy = options.loadPolicy ?? loadModelPolicy;

  return function route(request, ctx) {
    const sticky = stickyRoute(request);
    if (sticky) {
      return sticky;
    }

    const allowProject = typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted();
    const { path, policy } = loadPolicy(ctx.cwd, process.env, homedir(), { allowProject });
    const target = policy.roles[role];
    if (!target) {
      throw new Error(
        `ForgeFlow logical model '${FORGEFLOW_MODEL_PROVIDER}/${role}' is not configured in '${path}'.`
      );
    }

    const model = ctx.modelRegistry.find(target.provider, target.id);
    if (!model) {
      throw new Error(
        `ForgeFlow role '${role}' targets unknown physical model '${target.provider}/${target.id}' from '${path}'.`
      );
    }

    return {
      model,
      thinkingLevel: target.thinkingLevel ?? request.thinkingLevel
    };
  };
}

export function registerForgeFlowVirtualModels(pi, options = {}) {
  if (typeof pi.registerVirtualModel !== "function") {
    throw new Error("ForgeFlow requires Pi with registerVirtualModel() support.");
  }

  for (const role of FORGEFLOW_MODEL_ROLES) {
    pi.registerVirtualModel({
      provider: FORGEFLOW_MODEL_PROVIDER,
      id: role,
      name: `ForgeFlow ${role}`,
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      route: createRoleRouter(role, options)
    });
  }
}
