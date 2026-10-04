# ForgeFlow model policy

ForgeFlow uses **stable logical model roles** and leaves provider/channel execution to Pi and the configured provider layer.

The model path is:

```text
ForgeFlow role policy
    ↓
Pi virtual model
    ↓
physical model
    ↓
provider gateway / native provider
    ↓
channel, credential, quota, transport
```

This keeps fast-moving physical model names out of ForgeFlow workflows and agent definitions. A model upgrade should normally be a policy-file change, not a ForgeFlow code change.

## Logical roles

ForgeFlow registers these Pi virtual models:

| Role | Purpose | Typical effort envelope |
| --- | --- | --- |
| `forgeflow/planner` | decompose work, architecture, execution planning | `high` by default, up to `xhigh` |
| `forgeflow/worker` | implementation, focused debugging, routine code changes | `low` by default, up to `medium` |
| `forgeflow/reviewer` | diff review, acceptance reasoning, risk checks | `high` by default, up to `xhigh` |
| `forgeflow/scout` | repository exploration, cheap search, fact gathering | `low` by default, up to `medium` |
| `forgeflow/oracle` | expensive expert escalation for ambiguous, cross-system, or hard root-cause questions | `xhigh` by default and capped at `xhigh` |

`oracle` is an engineering consultation role, not Oracle Cloud or the Oracle2 host. It should be invoked sparingly when the planner/reviewer needs a higher-cost second opinion or a difficult decision resolved; it is not the default implementation worker.

The names are stable contracts. The physical model behind each role is operator policy.

The pinned `pi-subagents@0.75.0` includes the child-runtime fixes required for Pi virtual models, so builtin roles can point directly at the logical models:

```json
{
  "subagents": {
    "agentOverrides": {
      "worker": { "model": "forgeflow/worker" },
      "reviewer": { "model": "forgeflow/reviewer" },
      "scout": { "model": "forgeflow/scout" },
      "oracle": { "model": "forgeflow/oracle" }
    }
  }
}
```

The parent Pi session can select `forgeflow/planner` when acting as the planning/orchestration role. Reviewer and acceptance plugins should select `forgeflow/reviewer` when they need the stable reviewer role; operator policy remains free to change the physical reviewer model without editing plugin workflows or agent definitions.

`pi-subagents@0.75.0` contains the upstream child-runtime fixes for queued virtual-model registration and logical-selection verification (#2636 and #2638). ForgeFlow also registers its own extension as a required native-child extension for each Pi session, because local foreground children intentionally do not load the parent's ambient extensions. This makes the `forgeflow/*` virtual models available in foreground, detached, nested, and recovery child sessions without hard-coding an installation path in operator profile settings. External CLI runners remain excluded by pi-subagents. ForgeFlow therefore does not carry a virtual-child compatibility shim.

## Policy file

ForgeFlow resolves the physical mapping in this order:

1. `FORGEFLOW_MODEL_POLICY` when explicitly set;
2. `<project>/.pi/forgeflow-models.json` when Pi reports the project trusted;
3. `~/.pi/forgeflow-models.json`.

An explicit `FORGEFLOW_MODEL_POLICY` path is authoritative, must be absolute, and fails closed if it does not exist. Requiring an absolute operator path prevents a globally inherited relative environment value from resolving to a file supplied by an untrusted checkout. Project-local policy is ignored for untrusted projects so a checked-out repository cannot silently redirect prompts to another provider.

Policy schema v1:

```json
{
  "version": 1,
  "roles": {
    "planner": {
      "model": "gateway/frontier-reasoning",
      "defaultThinkingLevel": "high",
      "minThinkingLevel": "medium",
      "maxThinkingLevel": "xhigh"
    },
    "worker": {
      "model": "gateway/fast-coder",
      "defaultThinkingLevel": "low",
      "minThinkingLevel": "minimal",
      "maxThinkingLevel": "medium"
    },
    "reviewer": {
      "model": "gateway/frontier-review",
      "defaultThinkingLevel": "high",
      "minThinkingLevel": "high",
      "maxThinkingLevel": "xhigh"
    },
    "scout": {
      "model": "gateway/fast-general",
      "defaultThinkingLevel": "low",
      "minThinkingLevel": "off",
      "maxThinkingLevel": "medium"
    },
    "oracle": {
      "model": "gateway/frontier-reasoning",
      "defaultThinkingLevel": "xhigh",
      "minThinkingLevel": "high",
      "maxThinkingLevel": "xhigh"
    }
  }
}
```

`model` must be a fully qualified **physical** Pi model, `provider/model`. Model IDs may contain additional slashes. A role may not point at another `forgeflow/*` virtual model.

Thinking effort is part of the role policy, not an afterthought. The adaptive fields are:

- `defaultThinkingLevel`: used when the caller does not request a level;
- `minThinkingLevel`: floor for the role, preventing an underpowered call;
- `maxThinkingLevel`: ceiling for the role, preventing routine work from consuming frontier effort;
- legacy `thinkingLevel`: an exact fixed pin retained for backwards compatibility. It cannot be combined with the adaptive fields.

When the caller explicitly selects a virtual thinking level, ForgeFlow preserves that request inside the configured envelope. For example a planner configured as `medium..xhigh` can run at `high` or escalate to `xhigh`, while a worker capped at `medium` cannot accidentally consume `xhigh`. `max` remains available in the schema, but operator policy should only enable it for a physical model whose registry metadata explicitly supports that level. Continuations and retries keep the already-selected physical model and effort for turn stability.

The policy file is read when a new user/direct request is routed, so changing a mapping does not require changing ForgeFlow code. Pi still records the actual physical model on every assistant response.

## Turn stickiness

Pi documents that continuation requests should normally remain on the model that handled the turn, and retries should remain on the failed request's physical model unless a router deliberately performs a recovery switch.

ForgeFlow v1 follows that conservative rule:

- `continuation` → reuse `previous`;
- `retry` → reuse `failed`;
- new `user` or `direct` request → resolve the current role policy again.

This preserves provider prompt caches and reasoning signatures inside a turn while still allowing model policy to change between user turns.

Cross-model retry escalation can be added later as an explicit policy version rather than hidden fallback behavior.

## Provider boundary

ForgeFlow does **not** own API keys, endpoint selection, channel weights, provider health, quota routing, or provider retries.

Those stay below the physical model boundary and may be implemented by:

- Pi native/custom providers;
- LiteLLM;
- New API;
- Bifrost;
- another OpenAI-compatible or native Pi provider extension.

Only one layer should make semantic model-selection decisions. Provider gateways should normally choose a channel for the already-selected physical model rather than independently replacing it with a different model.

This preserves the distinction:

```text
task/role decision → model selection → channel selection
```

and prevents opaque double-routing.
