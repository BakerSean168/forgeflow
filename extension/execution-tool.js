import { loadExecutionPolicy, selectExecutionProfile } from "./execution-policy.js";
import { inspectExecutionInventory, executionRuntime } from "./execution-runtime.js";
import { buildExecutionPlan } from "./execution-plan.js";
import { assessExecutionTakeover } from "./execution-recovery.js";
import { captureWorktreeEvidence } from "./execution-git.js";

// JSON-schema-compatible TypeBox schema; avoids introducing another dependency
// just for a single, strictly bounded policy-only Pi tool.
const PARAMETERS = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["inventory", "select", "plan", "snapshot", "recover"] },
    task: { type: "object", additionalProperties: true },
    tasks: { type: "array", minItems: 1, maxItems: 64, items: { type: "object", additionalProperties: true } },
    maxParallel: { type: "integer", minimum: 1, maximum: 8 },
    activeWriterPaths: { type: "array", maxItems: 64, items: { type: "string" } },
    recovery: { type: "object", additionalProperties: true },
    worktree: { type: "string", maxLength: 2048 }
  },
  required: ["action"],
  additionalProperties: false
};

export function registerExecutionPolicyTool(pi, injected = {}) {
  pi.registerTool({
    name: "forgeflow_execution",
    label: "ForgeFlow execution policy",
    description: "Read-only policy compiler for delegated engineering tasks. Use inventory to inspect available Agent/Model profiles; select for one task; plan for dependency-safe waves with pi-subagents dispatch arguments; recover for evidence-gated cross-Agent takeover. NEVER launches tools, modifies worktrees, or implicitly switches providers. Run pi-subagents status and validate writer ownership immediately before external delegation.",
    parameters: PARAMETERS,
    execute: async (_id, params, ctx) => {
      if (!ctx?.cwd) throw new Error("ForgeFlow execution requires a Pi working directory");
      if (!["inventory", "select", "plan", "snapshot", "recover"].includes(params.action)) {
        throw new Error("Unsupported ForgeFlow execution policy operation");
      }
      if (params.action === "snapshot") {
        if (params.task || params.tasks || params.recovery) throw new Error("snapshot accepts only worktree");
        return render(captureWorktreeEvidence(params.worktree ?? ctx.cwd));
      }
      if (params.action === "recover") {
        if (!params.recovery || params.task || params.tasks) throw new Error("recover requires recovery only");
        const trusted = typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted();
        const { policy } = injected.policy ? { policy: injected.policy } : loadExecutionPolicy(ctx.cwd, { trusted });
        return render(assessExecutionTakeover(params.recovery, { policy }));
      }
      const trusted = typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted();
      const models = ctx.modelRegistry?.getAll?.() ?? [];
      const { policy, path } = injected.policy
        ? { policy: injected.policy, path: "(injected-test-policy)" }
        : loadExecutionPolicy(ctx.cwd, { trusted });
      const runtime = executionRuntime(ctx.cwd, { trusted, modelRegistry: ctx.modelRegistry,
        models: models.map((m) => `${m.provider}/${m.id}`),
        ...(injected.modelPolicy ? { modelPolicy: injected.modelPolicy } : {}) });
      if (params.action === "inventory") {
        if (params.task || params.tasks) throw new Error("inventory does not accept task inputs");
        return render(inspectExecutionInventory(ctx.cwd, { trusted, policy, modelRegistry: ctx.modelRegistry,
          models: models.map((m) => `${m.provider}/${m.id}`),
          ...(injected.modelPolicy ? { modelPolicy: injected.modelPolicy } : {}) }));
      }
      const opts = { ...runtime };
      if (params.action === "select") {
        if (!params.task || params.tasks) throw new Error("select requires exactly one task");
        return render({ policyPath: path, ...selectExecutionProfile(policy, params.task, opts) });
      }
      if (!params.tasks || params.task) throw new Error("plan requires tasks without task");
      return render({ policyPath: path, ...buildExecutionPlan(policy, params.tasks, {
        ...opts, maxParallel: params.maxParallel ?? 4,
        activeWriterPaths: params.activeWriterPaths ?? []
      }) });
    }
  });
  return PARAMETERS;
}

function render(result) {
  const text = JSON.stringify(result, null, 2);
  if (Buffer.byteLength(text) > 180_000) throw new Error("Execution decision too large; split tasks into smaller batches");
  return { content: [{ type: "text", text }], details: result };
}
