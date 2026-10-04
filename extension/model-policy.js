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
export const FORGEFLOW_TASK_CLASSES = Object.freeze([
  "recon",
  "mechanical",
  "implementation",
  "debug",
  "review",
  "architecture",
  "product-judgment",
  "root-cause"
]);

const THINKING_LEVELS = Object.freeze([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);
const THINKING_LEVEL_SET = new Set(THINKING_LEVELS);
const TASK_CLASS_SET = new Set(FORGEFLOW_TASK_CLASSES);
const ROUTE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const TASK_CLASS_MARKER_RE = /\[\[forgeflow:task=([a-z0-9-]+)\]\]/i;

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

function parseQualifiedPhysicalModel(rawModel, subject) {
  if (typeof rawModel !== "string" || !rawModel.trim()) {
    throw new Error(`${subject} requires a non-empty 'model'.`);
  }

  const model = rawModel.trim();
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) {
    throw new Error(`${subject} must use a qualified physical model 'provider/model'.`);
  }

  const provider = model.slice(0, separator);
  const id = model.slice(separator + 1);
  if (provider === FORGEFLOW_MODEL_PROVIDER) {
    throw new Error(`${subject} cannot route to another ForgeFlow virtual model.`);
  }
  return { provider, id };
}

function optionalThinkingLevel(value, field, subject) {
  if (value[field] === undefined) return undefined;
  if (typeof value[field] !== "string" || !THINKING_LEVEL_SET.has(value[field])) {
    throw new Error(`${subject} has invalid '${field}'.`);
  }
  return value[field];
}

function validateThinkingPolicy(value, subject) {
  const thinkingLevel = optionalThinkingLevel(value, "thinkingLevel", subject);
  const defaultThinkingLevel = optionalThinkingLevel(value, "defaultThinkingLevel", subject);
  const minThinkingLevel = optionalThinkingLevel(value, "minThinkingLevel", subject);
  const maxThinkingLevel = optionalThinkingLevel(value, "maxThinkingLevel", subject);

  const adaptiveFields = [defaultThinkingLevel, minThinkingLevel, maxThinkingLevel];
  if (thinkingLevel !== undefined && adaptiveFields.some((entry) => entry !== undefined)) {
    throw new Error(`${subject} cannot combine legacy 'thinkingLevel' with adaptive thinking fields.`);
  }

  const rank = (level) => level === undefined ? undefined : THINKING_LEVELS.indexOf(level);
  const minRank = rank(minThinkingLevel);
  const maxRank = rank(maxThinkingLevel);
  const defaultRank = rank(defaultThinkingLevel);
  if (minRank !== undefined && maxRank !== undefined && minRank > maxRank) {
    throw new Error(`${subject} has minThinkingLevel above maxThinkingLevel.`);
  }
  if (defaultRank !== undefined && minRank !== undefined && defaultRank < minRank) {
    throw new Error(`${subject} has defaultThinkingLevel below minThinkingLevel.`);
  }
  if (defaultRank !== undefined && maxRank !== undefined && defaultRank > maxRank) {
    throw new Error(`${subject} has defaultThinkingLevel above maxThinkingLevel.`);
  }

  return {
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    ...(defaultThinkingLevel !== undefined ? { defaultThinkingLevel } : {}),
    ...(minThinkingLevel !== undefined ? { minThinkingLevel } : {}),
    ...(maxThinkingLevel !== undefined ? { maxThinkingLevel } : {})
  };
}

function validateV1RolePolicy(role, value, source) {
  const subject = `ForgeFlow model policy '${source}' role '${role}'`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${subject} must be an object.`);
  }
  return {
    ...parseQualifiedPhysicalModel(value.model, subject),
    ...validateThinkingPolicy(value, subject)
  };
}

function validateTaskClasses(value, subject) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${subject} 'taskClasses' must be a non-empty array when provided.`);
  }
  const classes = [];
  for (const taskClass of value) {
    if (typeof taskClass !== "string" || !TASK_CLASS_SET.has(taskClass)) {
      throw new Error(`${subject} has invalid task class '${String(taskClass)}'.`);
    }
    if (!classes.includes(taskClass)) classes.push(taskClass);
  }
  return classes;
}

function validateV2RolePolicy(role, value, source) {
  const subject = `ForgeFlow model policy '${source}' role '${role}'`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${subject} must be an object.`);
  }
  if (!Array.isArray(value.routes) || value.routes.length === 0) {
    throw new Error(`${subject} requires a non-empty 'routes' array.`);
  }

  const routeIds = new Set();
  const routes = value.routes.map((route, index) => {
    const routeSubject = `${subject} route #${index + 1}`;
    if (!route || typeof route !== "object" || Array.isArray(route)) {
      throw new Error(`${routeSubject} must be an object.`);
    }
    if (typeof route.id !== "string" || !ROUTE_ID_RE.test(route.id)) {
      throw new Error(`${routeSubject} requires a safe non-empty 'id'.`);
    }
    if (routeIds.has(route.id)) {
      throw new Error(`${subject} has duplicate route id '${route.id}'.`);
    }
    routeIds.add(route.id);
    return {
      routeId: route.id,
      ...parseQualifiedPhysicalModel(route.model, `${subject} route '${route.id}'`),
      taskClasses: validateTaskClasses(route.taskClasses, `${subject} route '${route.id}'`),
      ...validateThinkingPolicy(route, `${subject} route '${route.id}'`)
    };
  });

  if (typeof value.defaultRoute !== "string" || !routeIds.has(value.defaultRoute)) {
    throw new Error(`${subject} 'defaultRoute' must name one configured route.`);
  }

  let defaultTaskClass;
  if (value.defaultTaskClass !== undefined) {
    if (typeof value.defaultTaskClass !== "string" || !TASK_CLASS_SET.has(value.defaultTaskClass)) {
      throw new Error(`${subject} has invalid 'defaultTaskClass'.`);
    }
    defaultTaskClass = value.defaultTaskClass;
  }

  return {
    routes,
    defaultRoute: value.defaultRoute,
    ...(defaultTaskClass !== undefined ? { defaultTaskClass } : {})
  };
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
  if (raw.version !== 1 && raw.version !== 2) {
    throw new Error(`ForgeFlow model policy '${source}' requires version 1 or 2.`);
  }
  if (!raw.roles || typeof raw.roles !== "object" || Array.isArray(raw.roles)) {
    throw new Error(`ForgeFlow model policy '${source}' requires a 'roles' object.`);
  }

  const roles = {};
  for (const role of FORGEFLOW_MODEL_ROLES) {
    if (raw.roles[role] === undefined) continue;
    roles[role] = raw.version === 1
      ? validateV1RolePolicy(role, raw.roles[role], source)
      : validateV2RolePolicy(role, raw.roles[role], source);
  }

  for (const role of Object.keys(raw.roles)) {
    if (!FORGEFLOW_MODEL_ROLES.includes(role)) {
      throw new Error(`ForgeFlow model policy '${source}' has unknown role '${role}'.`);
    }
  }

  return { version: raw.version, roles };
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

function resolveThinkingLevel(requested, target) {
  if (target.thinkingLevel !== undefined) return target.thinkingLevel;

  let level = requested ?? target.defaultThinkingLevel;
  if (level === undefined) return undefined;

  const rank = THINKING_LEVELS.indexOf(level);
  if (rank === -1) return target.defaultThinkingLevel;

  const minRank = target.minThinkingLevel === undefined
    ? undefined
    : THINKING_LEVELS.indexOf(target.minThinkingLevel);
  const maxRank = target.maxThinkingLevel === undefined
    ? undefined
    : THINKING_LEVELS.indexOf(target.maxThinkingLevel);

  if (minRank !== undefined && rank < minRank) level = target.minThinkingLevel;
  if (maxRank !== undefined && THINKING_LEVELS.indexOf(level) > maxRank) level = target.maxThinkingLevel;
  return level;
}

function thinkingDistance(requested, route) {
  if (!requested || !THINKING_LEVEL_SET.has(requested)) return 0;
  const effective = resolveThinkingLevel(requested, route) ?? requested;
  return Math.abs(THINKING_LEVELS.indexOf(effective) - THINKING_LEVELS.indexOf(requested));
}

function messageText(message) {
  if (!message || message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .join("\n");
}

function explicitTaskClass(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;
    const text = messageText(message);
    const match = text.match(TASK_CLASS_MARKER_RE);
    if (!match) return undefined;
    const taskClass = match[1].toLowerCase();
    if (!TASK_CLASS_SET.has(taskClass)) {
      throw new Error(
        `ForgeFlow task marker names unknown class '${taskClass}'. Expected one of: ${FORGEFLOW_TASK_CLASSES.join(", ")}.`
      );
    }
    return taskClass;
  }
  return undefined;
}

function routeCandidates(rolePolicy, requestedThinking, taskClass) {
  let pool = rolePolicy.routes;
  if (taskClass) {
    const exact = pool.filter((route) => route.taskClasses.includes(taskClass));
    if (exact.length > 0) {
      pool = exact;
    } else {
      const generic = pool.filter((route) => route.taskClasses.length === 0);
      if (generic.length === 0) {
        throw new Error(`No ForgeFlow route handles explicit task class '${taskClass}'.`);
      }
      pool = generic;
    }
  }

  const indexed = pool.map((route) => ({
    route,
    distance: thinkingDistance(requestedThinking, route),
    isDefault: route.routeId === rolePolicy.defaultRoute,
    index: rolePolicy.routes.indexOf(route)
  }));
  indexed.sort((left, right) => {
    if (left.distance !== right.distance) return left.distance - right.distance;
    if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
    return left.index - right.index;
  });
  return indexed.map((entry) => entry.route);
}

function stickyRoute(request) {
  if (request.reason === "retry" && request.failed) {
    return {
      model: request.failed.model,
      thinkingLevel: request.failed.thinkingLevel ?? request.thinkingLevel,
      ...(request.state !== undefined ? { state: request.state } : {})
    };
  }
  if (request.reason === "continuation" && request.previous) {
    return {
      model: request.previous.model,
      thinkingLevel: request.previous.thinkingLevel ?? request.thinkingLevel,
      ...(request.state !== undefined ? { state: request.state } : {})
    };
  }
  return undefined;
}

function resolvePhysicalModel(ctx, route) {
  const model = ctx.modelRegistry.find(route.provider, route.id);
  if (!model || model.api === "pi-virtual") return undefined;
  return model;
}

function routeV1(role, request, ctx, path, target) {
  const model = ctx.modelRegistry.find(target.provider, target.id);
  if (!model) {
    throw new Error(
      `ForgeFlow role '${role}' targets unknown physical model '${target.provider}/${target.id}' from '${path}'.`
    );
  }
  if (model.api === "pi-virtual") {
    throw new Error(
      `ForgeFlow role '${role}' must resolve directly to a physical model; '${target.provider}/${target.id}' is virtual.`
    );
  }
  return {
    model,
    thinkingLevel: resolveThinkingLevel(request.thinkingLevel, target)
  };
}

function routeV2(role, request, ctx, path, target) {
  const taskClass = explicitTaskClass(request.messages);
  const candidates = routeCandidates(target, request.thinkingLevel, taskClass);
  const attempted = [];

  for (const route of candidates) {
    attempted.push(`${route.provider}/${route.id}`);
    const model = resolvePhysicalModel(ctx, route);
    if (!model) continue;

    const thinkingLevel = resolveThinkingLevel(request.thinkingLevel, route);
    return {
      model,
      thinkingLevel,
      state: {
        decisionVersion: 1,
        policyVersion: 2,
        role,
        routeId: route.routeId,
        taskClass: taskClass ?? target.defaultTaskClass ?? null,
        model: `${route.provider}/${route.id}`,
        thinkingLevel,
        basis: taskClass ? "explicit-task-class" : "effort-envelope"
      }
    };
  }

  throw new Error(
    `ForgeFlow role '${role}' has no available physical route in '${path}'. Tried: ${attempted.join(", ")}.`
  );
}

export function createRoleRouter(role, options = {}) {
  const loadPolicy = options.loadPolicy ?? loadModelPolicy;

  return function route(request, ctx) {
    const sticky = stickyRoute(request);
    if (sticky) return sticky;

    const allowProject = typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted();
    const { path, policy } = loadPolicy(ctx.cwd, process.env, homedir(), { allowProject });
    const target = policy.roles[role];
    if (!target) {
      throw new Error(
        `ForgeFlow logical model '${FORGEFLOW_MODEL_PROVIDER}/${role}' is not configured in '${path}'.`
      );
    }

    return policy.version === 1
      ? routeV1(role, request, ctx, path, target)
      : routeV2(role, request, ctx, path, target);
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
      thinkingLevels: THINKING_LEVELS,
      route: createRoleRouter(role, options)
    });
  }
}
