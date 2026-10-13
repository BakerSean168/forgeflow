// Deterministic execution selection for Pi. This module never launches an Agent,
// reads credentials, allocates worktrees, or stores task/run state.
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";

export const EXECUTION_POLICY_ENV = "FORGEFLOW_EXECUTION_POLICY";
export const TASK_CLASSES = Object.freeze([
  "recon", "mechanical", "implementation", "debug", "review",
  "architecture", "root-cause", "product-judgment"
]);
export const COMPLEXITIES = Object.freeze(["low", "medium", "high", "critical"]);
const ACCESS = new Set(["read", "write"]);
const RUNTIMES = new Set(["pi", "external-cli"]);
const HEALTH = new Set(["verified", "unverified", "blocked"]);
const ISOLATIONS = new Set(["none", "managed-worktree", "prepared-worktree"]);
const PROFILE_KEYS = new Set([
  "id", "agent", "runtime", "model", "modelLabel", "providerLabel", "kinds",
  "complexities", "access", "rank", "isolation", "health", "enabled", "executable",
  "expectedPhysicalModels"
]);
const TASK_KEYS = new Set([
  "id", "description", "kind", "complexity", "access", "dependsOn",
  "cwd", "repo", "expectedHead", "acceptance", "profile"
]);
const ID_RE = /^[a-z][a-z0-9-]{0,62}$/;
const MODEL_RE = /^[a-z0-9][a-z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._/\[\]-]*(?::(?:off|minimal|low|medium|high|xhigh|max))?$/;
const MAX_TASKS = 64;

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}
function exactKeys(value, allowed, label) {
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length) throw new Error(`${label}: unsupported fields ${extra.join(", ")}`);
}
function requiredString(value, label, max = 8192) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()
    || Buffer.byteLength(value) > max || value.includes("\0")) {
    throw new Error(`${label} must be a nonblank trimmed string <= ${max} bytes`);
  }
  return value;
}
function names(value, valid, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new Error(`${label} must contain 1-16 values`);
  }
  const unique = new Set();
  for (const item of value) {
    if (typeof item !== "string" || !valid.includes(item) || unique.has(item)) {
      throw new Error(`${label} has unknown or duplicate item '${String(item)}'`);
    }
    unique.add(item);
  }
  return [...unique];
}
function enumValue(value, choices, label) {
  if (!choices.has(value)) throw new Error(`${label} must be one of ${[...choices].join(", ")}`);
  return value;
}
function profileDefinition(value, i) {
  const p = record(value, `profiles[${i}]`);
  exactKeys(p, PROFILE_KEYS, `profiles[${i}]`);
  const id = requiredString(p.id, `profiles[${i}].id`, 64);
  if (!ID_RE.test(id)) throw new Error(`Invalid profile id '${id}'`);
  const runtime = enumValue(p.runtime, RUNTIMES, `${id}.runtime`);
  const agent = requiredString(p.agent, `${id}.agent`, 128);
  const access = enumValue(p.access, ACCESS, `${id}.access`);
  const isolation = enumValue(p.isolation, ISOLATIONS, `${id}.isolation`);
  if (access === "write" && (runtime === "pi" ? isolation !== "managed-worktree" : isolation !== "prepared-worktree")) {
    throw new Error(`${id}: writer isolation must use its supported worktree type`);
  }
  if (access === "read" && isolation !== "none") throw new Error(`${id}: read role should not reserve writer isolation`);
  if (runtime === "pi" && isolation === "prepared-worktree") throw new Error(`${id}: Pi uses plugin-managed worktrees`);
  if (runtime === "external-cli" && isolation === "managed-worktree") throw new Error(`${id}: external CLI cannot use plugin-managed worktrees`);
  const health = enumValue(p.health, HEALTH, `${id}.health`);
  const enabled = p.enabled === undefined ? true : p.enabled;
  if (typeof enabled !== "boolean") throw new Error(`${id}.enabled must be boolean`);
  if (!Number.isSafeInteger(p.rank) || p.rank < 0 || p.rank > 10000) {
    throw new Error(`${id}.rank must be an integer between 0 and 10000`);
  }
  if (runtime === "pi") {
    if (typeof p.model !== "string" || !MODEL_RE.test(p.model) || !p.model.startsWith("forgeflow/")) {
      throw new Error(`${id}: Pi profile requires one fully-qualified ForgeFlow model`);
    }
    if (p.modelLabel !== undefined || p.providerLabel !== undefined || p.executable !== undefined) {
      throw new Error(`${id}: native Pi profile cannot declare external-model routing`);
    }
    if (!Array.isArray(p.expectedPhysicalModels) || p.expectedPhysicalModels.length < 1 ||
      p.expectedPhysicalModels.length > 8 ||
      p.expectedPhysicalModels.some((model) => typeof model !== "string" || !MODEL_RE.test(model) ||
        model.includes(":") || model.startsWith("forgeflow/")) ||
      new Set(p.expectedPhysicalModels).size !== p.expectedPhysicalModels.length) {
      throw new Error(`${id}: native Pi profile must declare 1-8 exact allowed physical models`);
    }
  } else {
    if (p.expectedPhysicalModels !== undefined) throw new Error(`${id}: external CLI does not use Pi physical model allowlists`);
    if (p.model !== undefined) throw new Error(`${id}: external CLI cannot receive a Pi model override`);
    requiredString(p.modelLabel, `${id}.modelLabel`, 128);
    requiredString(p.providerLabel, `${id}.providerLabel`, 128);
    requiredString(p.executable, `${id}.executable`, 256);
  }
  return Object.freeze({
    id, runtime, agent, access, isolation, health, enabled, rank: p.rank,
    kinds: names(p.kinds, TASK_CLASSES, `${id}.kinds`),
    complexities: names(p.complexities, COMPLEXITIES, `${id}.complexities`),
    ...(runtime === "pi" ? { model: p.model, expectedPhysicalModels: [...p.expectedPhysicalModels] } :
      { modelLabel: p.modelLabel, providerLabel: p.providerLabel, executable: p.executable })
  });
}

export function parseExecutionPolicy(text, source = "<memory>") {
  let obj;
  try { obj = JSON.parse(text); }
  catch { throw new Error(`Invalid execution policy JSON: ${source}`); }
  record(obj, "policy");
  exactKeys(obj, new Set(["version", "profiles"]), "policy");
  if (obj.version !== 1) throw new Error("Execution policy must use version 1");
  if (!Array.isArray(obj.profiles) || obj.profiles.length === 0 || obj.profiles.length > 32) {
    throw new Error("Execution policy must have 1-32 profiles");
  }
  const profiles = obj.profiles.map(profileDefinition);
  if (new Set(profiles.map((p) => p.id)).size !== profiles.length) {
    throw new Error("Execution policy profile ids must be unique");
  }
  return Object.freeze({ version: 1, profiles });
}

export function resolveExecutionPolicyPath(cwd, options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const explicit = env[EXECUTION_POLICY_ENV]?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) throw new Error(`${EXECUTION_POLICY_ENV} must be absolute`);
    return explicit;
  }
  const candidates = [
    ...(options.trusted === true ? [join(cwd, ".pi", "forgeflow-execution.json")] : []),
    join(home, ".pi", "forgeflow-execution.json"),
    fileURLToPath(new URL("../config/execution-policy.v1.json", import.meta.url))
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`No ForgeFlow execution policy found: ${candidates.join(", ")}`);
  return found;
}

export function loadExecutionPolicy(cwd, options = {}) {
  const path = resolveExecutionPolicyPath(cwd, options);
  return { path, policy: parseExecutionPolicy(readFileSync(path, "utf8"), path) };
}

export function parseExecutionTask(task) {
  const t = record(task, "task");
  exactKeys(t, TASK_KEYS, `task ${t.id ?? "?"}`);
  const id = requiredString(t.id, "task.id", 64);
  if (!ID_RE.test(id)) throw new Error(`Invalid task id '${id}'`);
  const description = requiredString(t.description, `${id}.description`, 16 * 1024);
  if (!TASK_CLASSES.includes(t.kind)) throw new Error(`${id}: invalid task class`);
  if (!COMPLEXITIES.includes(t.complexity)) throw new Error(`${id}: invalid task complexity`);
  enumValue(t.access, ACCESS, `${id}.access`);
  const deps = t.dependsOn ?? [];
  if (!Array.isArray(deps) || deps.length > MAX_TASKS || deps.some((s) => typeof s !== "string" || !ID_RE.test(s))) {
    throw new Error(`${id}: invalid dependencies`);
  }
  if (deps.includes(id) || new Set(deps).size !== deps.length) {
    throw new Error(`${id}: cyclic or duplicate direct dependency`);
  }
  const acceptance = t.acceptance ?? [];
  if (!Array.isArray(acceptance) || acceptance.length > 16 || acceptance.some((x) => typeof x !== "string" || !x.trim() || x.length > 2048)) {
    throw new Error(`${id}: invalid acceptance criteria`);
  }
  const cwd = t.cwd === undefined ? undefined : requiredString(t.cwd, `${id}.cwd`, 2048);
  const repo = t.repo === undefined ? undefined : requiredString(t.repo, `${id}.repo`, 2048);
  if ((cwd && !isAbsolute(cwd)) || (repo && !isAbsolute(repo))) throw new Error(`${id}: worktree paths must be absolute`);
  if ((cwd === undefined) !== (repo === undefined)) throw new Error(`${id}: cwd and repo must be supplied together`);
  const expectedHead = t.expectedHead;
  if (expectedHead !== undefined && !/^[0-9a-f]{40,64}$/.test(expectedHead)) {
    throw new Error(`${id}: expectedHead must be a complete Git object id`);
  }
  const profile = t.profile === undefined ? undefined : requiredString(t.profile, `${id}.profile`, 64);
  return Object.freeze({ id, description, kind: t.kind, complexity: t.complexity, access: t.access,
    dependsOn: [...deps], acceptance: [...acceptance], ...(cwd ? { cwd, repo } : {}),
    ...(expectedHead ? { expectedHead } : {}), ...(profile ? { profile } : {}) });
}

function decisionForProfile(p, t, input) {
  const why = [];
  if (t.profile && t.profile !== p.id) why.push("not-requested-profile");
  if (!p.enabled) why.push("disabled");
  if (p.health === "blocked") why.push("health-blocked");
  if (p.health === "unverified" && input.allowUnverified !== true) why.push("health-unverified");
  if (!p.kinds.includes(t.kind)) why.push("task-class-incompatible");
  if (!p.complexities.includes(t.complexity)) why.push("complexity-incompatible");
  if (p.access !== t.access) why.push("permission-mismatch");
  if (p.runtime === "external-cli" && p.access === "write" && (!t.cwd || !t.repo)) {
    why.push("prepared-worktree-required");
  }
  if (p.runtime === "external-cli" && p.access === "write" &&
      t.cwd && t.repo && typeof input.inspectWorktree === "function") {
    try {
      const inspected = input.inspectWorktree(t.repo, t.cwd, t.expectedHead);
      if (!inspected?.ok) why.push(...(inspected?.problems ?? ["worktree-preflight-failed"]));
    } catch { why.push("worktree-preflight-failed"); }
  }
  if (typeof input.isExecutable === "function" && p.runtime === "external-cli"
    && !input.isExecutable(p.executable)) why.push("executable-unavailable");
  if (p.runtime === "pi") {
    if (typeof input.isModelAvailable === "function" && !input.isModelAvailable(p.model)) {
      why.push("model-unavailable");
    }
    if (typeof input.resolvePiModel === "function") {
      try {
        const result = input.resolvePiModel(p.model, t);
        if (!result?.physicalModel) why.push("physical-model-unresolved");
        else {
          if (!p.expectedPhysicalModels.includes(result.physicalModel)) why.push("physical-model-not-allowed");
          return { profile: p, reasons: why, physicalModel: result.physicalModel };
        }
      } catch { why.push("physical-model-unresolved"); }
    }
  }
  return { profile: p, reasons: why };
}

export function selectExecutionProfile(policy, task, options = {}) {
  const t = parseExecutionTask(task);
  const candidates = policy.profiles.map((p) => decisionForProfile(p, t, options))
    .sort((a,b) => a.profile.rank - b.profile.rank || a.profile.id.localeCompare(b.profile.id));
  const chosen = candidates.find((c) => c.reasons.length === 0);
  return {
    task: t,
    ok: Boolean(chosen),
    ...(chosen ? { selection: {
      profile: chosen.profile.id,
      agent: chosen.profile.agent,
      runtime: chosen.profile.runtime,
      ...(chosen.profile.model ? { model: chosen.profile.model } :
        { modelLabel: chosen.profile.modelLabel, providerLabel: chosen.profile.providerLabel }),
      ...(chosen.physicalModel ? { physicalModel: chosen.physicalModel } : {}),
      isolation: chosen.profile.isolation, access: chosen.profile.access,
      rank: chosen.profile.rank,
      basis: t.profile ? "approved-profile-override" : "compatible-profile-priority",
      warnings: [
        ...(chosen.profile.health === "unverified" ? ["agent-health-not-verified"] : []),
        ...(chosen.profile.runtime === "external-cli" && chosen.profile.access === "read"
          ? ["acp-read-mode-is-not-os-sandbox"] : []),
        ...(chosen.profile.runtime === "external-cli" && chosen.profile.access === "write"
          ? ["confirm-pi-subagents-no-active-writer-before-launch"] : [])
      ]
    } } : {}),
    candidates: candidates.map((x) => ({ profile: x.profile.id, rank: x.profile.rank,
      eligible: x.reasons.length === 0, reasons: x.reasons }))
  };
}

export function validateTaskSet(tasks) {
  if (!Array.isArray(tasks) || !tasks.length || tasks.length > MAX_TASKS) {
    throw new Error(`Provide 1-${MAX_TASKS} execution tasks`);
  }
  const validated = tasks.map(parseExecutionTask);
  const byId = new Map(validated.map((x) => [x.id, x]));
  if (byId.size !== validated.length) throw new Error("Task ids must be unique");
  for (const task of validated) for (const dep of task.dependsOn) {
    if (!byId.has(dep)) throw new Error(`${task.id}: unknown dependency ${dep}`);
  }
  return validated;
}

export function orderExecutionWaves(tasks, maxParallel = 4) {
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 8) {
    throw new Error("maxParallel must be between 1 and 8");
  }
  const list = validateTaskSet(tasks);
  const pending = new Set(list.map((t) => t.id));
  const finished = new Set();
  const waves = [];
  while (pending.size) {
    const runnable = list.filter((t) => pending.has(t.id) && t.dependsOn.every((d) => finished.has(d)));
    if (!runnable.length) throw new Error("Task dependency cycle detected");
    const batch = runnable.slice(0, maxParallel);
    waves.push(batch);
    for (const t of batch) { pending.delete(t.id); finished.add(t.id); }
  }
  return waves;
}
