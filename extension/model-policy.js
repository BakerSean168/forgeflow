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
const SUPPLY_ID_RE = ROUTE_ID_RE;
const SUPPLY_GROUP_RE = /^[a-z0-9][a-z0-9._-]{0,95}$/;
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

function validateSupplyGroups(rawSupplies, source) {
  if (rawSupplies === undefined) return {};
  if (!rawSupplies || typeof rawSupplies !== "object" || Array.isArray(rawSupplies)) {
    throw new Error(`ForgeFlow model policy '${source}' 'supplies' must be an object.`);
  }

  const supplies = {};
  for (const [groupId, value] of Object.entries(rawSupplies)) {
    const subject = `ForgeFlow model policy '${source}' supply group '${groupId}'`;
    if (!SUPPLY_GROUP_RE.test(groupId)) {
      throw new Error(`${subject} has an invalid group id.`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${subject} must be an object.`);
    }
    if (!Array.isArray(value.sources) || value.sources.length === 0) {
      throw new Error(`${subject} requires a non-empty 'sources' array.`);
    }

    const sourceIds = new Set();
    const sources = value.sources.map((entry, index) => {
      const sourceSubject = `${subject} source #${index + 1}`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`${sourceSubject} must be an object.`);
      }
      if (typeof entry.id !== "string" || !SUPPLY_ID_RE.test(entry.id)) {
        throw new Error(`${sourceSubject} requires a safe non-empty 'id'.`);
      }
      if (sourceIds.has(entry.id)) {
        throw new Error(`${subject} has duplicate source id '${entry.id}'.`);
      }
      sourceIds.add(entry.id);
      const priority = entry.priority ?? (index + 1) * 10;
      if (!Number.isSafeInteger(priority) || priority < 0) {
        throw new Error(`${sourceSubject} requires a non-negative integer 'priority'.`);
      }
      return {
        supplyId: entry.id,
        priority,
        ...parseQualifiedPhysicalModel(entry.model, `${subject} source '${entry.id}'`)
      };
    });

    sources.sort((left, right) => left.priority - right.priority || left.supplyId.localeCompare(right.supplyId));
    supplies[groupId] = { groupId, sources };
  }
  return supplies;
}

function validateV3RolePolicy(role, value, source, supplies) {
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

    const hasModel = route.model !== undefined;
    const hasSupplyGroup = route.supplyGroup !== undefined;
    if (hasModel === hasSupplyGroup) {
      throw new Error(`${subject} route '${route.id}' requires exactly one of 'model' or 'supplyGroup'.`);
    }

    let target;
    if (hasSupplyGroup) {
      if (typeof route.supplyGroup !== "string" || !Object.hasOwn(supplies, route.supplyGroup)) {
        throw new Error(`${subject} route '${route.id}' references unknown supply group '${String(route.supplyGroup)}'.`);
      }
      target = { supplyGroup: route.supplyGroup };
    } else {
      target = parseQualifiedPhysicalModel(route.model, `${subject} route '${route.id}'`);
    }

    return {
      routeId: route.id,
      ...target,
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
  if (raw.version !== 1 && raw.version !== 2 && raw.version !== 3) {
    throw new Error(`ForgeFlow model policy '${source}' requires version 1, 2, or 3.`);
  }
  if (!raw.roles || typeof raw.roles !== "object" || Array.isArray(raw.roles)) {
    throw new Error(`ForgeFlow model policy '${source}' requires a 'roles' object.`);
  }

  const supplies = raw.version === 3 ? validateSupplyGroups(raw.supplies, source) : {};
  const roles = {};
  for (const role of FORGEFLOW_MODEL_ROLES) {
    if (raw.roles[role] === undefined) continue;
    roles[role] = raw.version === 1
      ? validateV1RolePolicy(role, raw.roles[role], source)
      : raw.version === 2
        ? validateV2RolePolicy(role, raw.roles[role], source)
        : validateV3RolePolicy(role, raw.roles[role], source, supplies);
  }

  for (const role of Object.keys(raw.roles)) {
    if (!FORGEFLOW_MODEL_ROLES.includes(role)) {
      throw new Error(`ForgeFlow model policy '${source}' has unknown role '${role}'.`);
    }
  }

  return { version: raw.version, roles, ...(raw.version === 3 ? { supplies } : {}) };
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

function continuationRoute(request) {
  if (request.reason === "continuation" && request.previous) {
    return {
      model: request.previous.model,
      thinkingLevel: request.previous.thinkingLevel ?? request.thinkingLevel,
      ...(request.state !== undefined ? { state: request.state } : {})
    };
  }
  return undefined;
}

function failedStickyRoute(request) {
  if (request.reason !== "retry" || !request.failed) return undefined;
  return {
    model: request.failed.model,
    thinkingLevel: request.failed.thinkingLevel ?? request.thinkingLevel,
    ...(request.state !== undefined ? { state: request.state } : {})
  };
}

function errorText(messageOrText) {
  if (typeof messageOrText === "string") return messageOrText;
  if (!messageOrText || typeof messageOrText !== "object") return "";
  const values = [
    messageOrText.errorMessage,
    messageOrText.rawStopReason,
    ...(Array.isArray(messageOrText.diagnostics)
      ? messageOrText.diagnostics.flatMap((entry) => [entry?.error?.message, entry?.error?.code])
      : [])
  ];
  return values.filter((value) => typeof value === "string" || typeof value === "number").join(" ");
}

/**
 * Classify only failures that are plausibly specific to the current supply source.
 * Semantic/request failures deliberately return undefined so retries stay sticky.
 */
export function classifySupplyFailure(messageOrText) {
  const text = errorText(messageOrText).toLowerCase();
  if (!text) return undefined;

  const requestFailures = [
    /context.{0,24}(length|window|limit|overflow|too long)/,
    /maximum context/,
    /too many (input )?tokens/,
    /content.?policy/,
    /safety (policy|filter|violation)/,
    /invalid[_ -]?request/,
    /bad request/,
    /malformed/,
    /invalid (tool|schema|json|parameter|argument)/,
    /tool.{0,24}(error|invalid|schema)/
  ];
  if (requestFailures.some((pattern) => pattern.test(text))) return undefined;

  if (/(?:http\s*)?429\b|too many requests|rate[_ -]?limit|rate limit|throttl/.test(text)) {
    return "rate_limited";
  }
  if (/insufficient[_ -]?quota|quota.{0,32}(exceed|exhaust|limit|deplet)|usage.{0,24}(limit|exhaust)|credit.{0,24}(exhaust|deplet|insufficient)|plan.{0,24}(limit|exhaust)/.test(text)) {
    return "quota_exhausted";
  }
  if (/overloaded|over capacity|capacity.{0,24}(exceed|unavailable|full)|server busy|temporar(?:y|ily) unavailable/.test(text)) {
    return "capacity_unavailable";
  }
  if (/(?:http\s*)?(502|503|504)\b|bad gateway|service unavailable|gateway timeout|upstream.{0,32}(error|fail|timeout|unavailable)/.test(text)) {
    return "transient_upstream";
  }
  if (/econnreset|econnrefused|etimedout|connection (?:reset|refused|closed|failed)|network (?:error|failure)|socket hang up|dns.{0,16}(fail|error)|fetch failed/.test(text)) {
    return "transport_unavailable";
  }
  if (/(?:http\s*)?401\b|unauthori[sz]ed|authentication.{0,24}(fail|expired|required)|invalid api key|api key.{0,24}(invalid|expired)|token.{0,24}(expired|invalid)/.test(text)) {
    return "auth_unavailable";
  }
  if (/model[_ -]?not[_ -]?found|model not found|model.{0,24}(not available|unavailable|unsupported)|not authorized.{0,24}model|not authorised.{0,24}model/.test(text)) {
    return "model_unavailable";
  }
  return undefined;
}

function resolvePhysicalModel(ctx, target) {
  const model = ctx.modelRegistry.find(target.provider, target.id);
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

function emitDecision(options, decision, ctx) {
  if (typeof options.onDecision !== "function") return;
  try {
    options.onDecision(decision, ctx);
  } catch {
    // Usage/telemetry must never break routing.
  }
}

function routeV2(role, request, ctx, path, target, options) {
  const taskClass = explicitTaskClass(request.messages);
  const candidates = routeCandidates(target, request.thinkingLevel, taskClass);
  const attempted = [];

  for (const route of candidates) {
    attempted.push(`${route.provider}/${route.id}`);
    const model = resolvePhysicalModel(ctx, route);
    if (!model) continue;

    const thinkingLevel = resolveThinkingLevel(request.thinkingLevel, route);
    const state = {
      decisionVersion: 1,
      policyVersion: 2,
      role,
      routeId: route.routeId,
      taskClass: taskClass ?? target.defaultTaskClass ?? null,
      model: `${route.provider}/${route.id}`,
      thinkingLevel,
      basis: taskClass ? "explicit-task-class" : "effort-envelope"
    };
    emitDecision(options, state, ctx);
    return { model, thinkingLevel, state };
  }

  throw new Error(
    `ForgeFlow role '${role}' has no available physical route in '${path}'. Tried: ${attempted.join(", ")}.`
  );
}

function supplyTargets(policy, route) {
  if (!route.supplyGroup) return [{ ...route, supplyGroup: null, supplyId: null, priority: null }];
  const group = policy.supplies?.[route.supplyGroup];
  if (!group) return [];
  return group.sources.map((source) => ({ ...source, supplyGroup: route.supplyGroup }));
}

function v3DecisionState({ role, target, route, taskClass, source, thinkingLevel, basis, failoverReason, failedSupplyId, priorState }) {
  const physical = `${source.provider}/${source.id}`;
  return {
    decisionVersion: 2,
    policyVersion: 3,
    role,
    routeId: route.routeId,
    taskClass: taskClass ?? target.defaultTaskClass ?? priorState?.taskClass ?? null,
    logicalModel: route.supplyGroup ?? physical,
    supplyGroup: source.supplyGroup ?? null,
    supplyId: source.supplyId ?? null,
    supplyPriority: source.priority ?? null,
    model: physical,
    thinkingLevel,
    basis,
    ...(failoverReason ? { failoverReason } : {}),
    ...(failedSupplyId ? { failedSupplyId } : {}),
    ...(basis === "supply-failover" ? { failoverCount: (priorState?.failoverCount ?? 0) + 1 } : {})
  };
}

function routeV3(role, request, ctx, path, policy, target, options) {
  const taskClass = explicitTaskClass(request.messages);
  const routes = routeCandidates(target, request.thinkingLevel, taskClass);
  const attempted = [];

  for (const route of routes) {
    for (const source of supplyTargets(policy, route)) {
      attempted.push(`${source.provider}/${source.id}`);
      const model = resolvePhysicalModel(ctx, source);
      if (!model) continue;

      const thinkingLevel = resolveThinkingLevel(request.thinkingLevel, route);
      const state = v3DecisionState({
        role,
        target,
        route,
        taskClass,
        source,
        thinkingLevel,
        basis: taskClass ? "explicit-task-class" : route.supplyGroup ? "supply-priority" : "effort-envelope"
      });
      emitDecision(options, state, ctx);
      return { model, thinkingLevel, state };
    }
  }

  throw new Error(
    `ForgeFlow role '${role}' has no available physical route in '${path}'. Tried: ${attempted.join(", ")}.`
  );
}

function sourceMatchesModel(source, model) {
  return Boolean(model) && source.provider === model.provider && source.id === model.id;
}

function findRetryRoute(target, state, supplyGroup) {
  if (state?.routeId) {
    const exact = target.routes.find((route) => route.routeId === state.routeId && route.supplyGroup === supplyGroup);
    if (exact) return exact;
  }
  return target.routes.find((route) => route.supplyGroup === supplyGroup);
}

function findSupplyGroupForFailedModel(policy, failedModel) {
  for (const group of Object.values(policy.supplies ?? {})) {
    const source = group.sources.find((candidate) => sourceMatchesModel(candidate, failedModel));
    if (source) return { group, source };
  }
  return undefined;
}

function retryV3(role, request, ctx, path, policy, target, options) {
  if (request.reason !== "retry" || !request.failed) return undefined;
  const failureClass = classifySupplyFailure(request.failed.message);
  if (!failureClass) return failedStickyRoute(request);

  const priorState = request.state && typeof request.state === "object" ? request.state : undefined;
  let groupId = typeof priorState?.supplyGroup === "string" ? priorState.supplyGroup : undefined;
  let group = groupId ? policy.supplies?.[groupId] : undefined;
  let failedSource = group?.sources.find((source) => sourceMatchesModel(source, request.failed.model));

  if (!group || !failedSource) {
    const found = findSupplyGroupForFailedModel(policy, request.failed.model);
    group = found?.group;
    failedSource = found?.source;
    groupId = group?.groupId;
  }
  if (!group || !failedSource || !groupId) return failedStickyRoute(request);

  const route = findRetryRoute(target, priorState, groupId);
  if (!route) return failedStickyRoute(request);

  const failedIndex = group.sources.findIndex((source) => source.supplyId === failedSource.supplyId);
  const nextSources = group.sources.slice(failedIndex + 1);
  for (const source of nextSources) {
    const model = resolvePhysicalModel(ctx, source);
    if (!model) continue;
    const requestedThinking = request.failed.thinkingLevel ?? request.thinkingLevel;
    const thinkingLevel = resolveThinkingLevel(requestedThinking, route);
    const state = v3DecisionState({
      role,
      target,
      route,
      taskClass: priorState?.taskClass ?? explicitTaskClass(request.messages),
      source: { ...source, supplyGroup: groupId },
      thinkingLevel,
      basis: "supply-failover",
      failoverReason: failureClass,
      failedSupplyId: failedSource.supplyId,
      priorState
    });
    emitDecision(options, state, ctx);
    return { model, thinkingLevel, state };
  }

  return failedStickyRoute(request);
}

export function createRoleRouter(role, options = {}) {
  const loadPolicy = options.loadPolicy ?? loadModelPolicy;

  return function route(request, ctx) {
    const continuation = continuationRoute(request);
    if (continuation) return continuation;
    if (
      request.reason === "retry"
      && request.failed
      && (!request.state || request.state.policyVersion !== 3)
    ) {
      return failedStickyRoute(request);
    }

    const allowProject = typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted();
    const { path, policy } = loadPolicy(ctx.cwd, process.env, homedir(), { allowProject });
    const target = policy.roles[role];
    if (!target) {
      throw new Error(
        `ForgeFlow logical model '${FORGEFLOW_MODEL_PROVIDER}/${role}' is not configured in '${path}'.`
      );
    }

    if (request.reason === "retry" && request.failed) {
      if (policy.version === 3) {
        return retryV3(role, request, ctx, path, policy, target, options);
      }
      return failedStickyRoute(request);
    }

    if (policy.version === 1) return routeV1(role, request, ctx, path, target);
    if (policy.version === 2) return routeV2(role, request, ctx, path, target, options);
    return routeV3(role, request, ctx, path, policy, target, options);
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
