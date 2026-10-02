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

- `forgeflow/planner`
- `forgeflow/worker`
- `forgeflow/reviewer`
- `forgeflow/scout`
- `forgeflow/oracle`

The names are stable contracts. The physical model behind each role is operator policy.

Typical `pi-subagents` project settings can point builtin roles at the logical models:

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

The parent Pi session can select `forgeflow/planner` when the parent is acting as the planning/orchestration role. ForgeFlow's trusted `forgeflow.review` and `forgeflow.accept` workflows explicitly launch the builtin reviewer with `model: "forgeflow/reviewer"`, so final review does not silently inherit whichever model the parent session happens to use.

## Policy file

ForgeFlow resolves the physical mapping in this order:

1. `FORGEFLOW_MODEL_POLICY` when explicitly set;
2. `<project>/.pi/forgeflow-models.json` when Pi reports the project trusted;
3. `~/.pi/forgeflow-models.json`.

An explicit `FORGEFLOW_MODEL_POLICY` path is authoritative and fails closed if it does not exist. Project-local policy is ignored for untrusted projects so a checked-out repository cannot silently redirect prompts to another provider.

Policy schema v1:

```json
{
  "version": 1,
  "roles": {
    "planner": {
      "model": "gateway/frontier-reasoning",
      "thinkingLevel": "high"
    },
    "worker": {
      "model": "gateway/fast-coder",
      "thinkingLevel": "low"
    },
    "reviewer": {
      "model": "gateway/frontier-review",
      "thinkingLevel": "high"
    },
    "scout": {
      "model": "gateway/fast-general",
      "thinkingLevel": "low"
    },
    "oracle": {
      "model": "gateway/frontier-reasoning",
      "thinkingLevel": "high"
    }
  }
}
```

`model` must be a fully qualified **physical** Pi model, `provider/model`. Model IDs may contain additional slashes. A role may not point at another `forgeflow/*` virtual model.

`thinkingLevel` is optional. When omitted, the selected virtual thinking level is passed through to the physical model.

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
