# ForgeFlow model policy

ForgeFlow uses **stable logical model roles** and leaves provider/channel execution to Pi and the configured provider layer.

The model path is:

```text
ForgeFlow role policy
    ↓
model capability + thinking effort
    ↓
supply policy (subscription/team before commercial relay)
    ↓
Pi physical model
    ↓
provider gateway / native provider
    ↓
channel, credential, transport
```

This keeps fast-moving physical model names out of ForgeFlow workflows and agent definitions. A model upgrade should normally be a policy-file change, not a ForgeFlow code change.

## Logical roles

ForgeFlow registers these Pi virtual models:

| Role | Purpose | Typical effort envelope |
| --- | --- | --- |
| `forgeflow/planner` | decompose work, architecture, execution planning | `high` by default, up to `xhigh` |
| `forgeflow/worker` | implementation, focused debugging, routine code changes | prefers Codex Team `gpt-6.1-sol` at `medium`; falls back by policy |
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

### Policy schema v2

Version 2 makes a role a **candidate-route policy** instead of a permanent alias for one physical model. Each request still resolves to exactly one physical model before provider execution.

```json
{
  "version": 2,
  "roles": {
    "worker": {
      "defaultRoute": "fast",
      "defaultTaskClass": "mechanical",
      "routes": [
        {
          "id": "fast",
          "model": "litellm/deepseek-v4-flash",
          "taskClasses": ["mechanical", "implementation"],
          "defaultThinkingLevel": "low",
          "minThinkingLevel": "minimal",
          "maxThinkingLevel": "low"
        },
        {
          "id": "standard",
          "model": "litellm/gpt-6-astra",
          "taskClasses": ["implementation", "debug"],
          "defaultThinkingLevel": "medium",
          "minThinkingLevel": "medium",
          "maxThinkingLevel": "medium"
        }
      ]
    }
  }
}
```

`model` must be a fully qualified **physical** Pi model, `provider/model`. A route may not point at another `forgeflow/*` virtual model. Route ids are stable operator-facing names, not model ids.

Supported task classes are:

- `recon` — repository search, inventory, fact gathering;
- `mechanical` — small, well-scoped, mechanically verifiable edits;
- `implementation` — ordinary feature implementation;
- `debug` — diagnosis and repair of a concrete failure;
- `review` — diff/acceptance/risk review;
- `architecture` — system design and cross-cutting tradeoffs;
- `product-judgment` — UX, intent, taste, and ambiguous product tradeoffs;
- `root-cause` — difficult cross-system diagnosis or causal analysis.

A parent can explicitly classify a delegated request by putting this marker in the delegated user prompt:

```text
[[forgeflow:task=debug]]
```

The marker is deterministic routing metadata. ForgeFlow does **not** use an LLM or keyword classifier to guess a task class. If the marker is absent, routes are ranked by how closely their thinking envelope matches the selected virtual thinking level; `defaultRoute` breaks equal-distance ties. `defaultTaskClass` is only the recorded semantic default for unclassified requests.

When a task class is explicit, ForgeFlow only considers routes that declare that class (or a generic route with no `taskClasses` if no exact class route exists). It does not silently cross a semantic boundary such as `product-judgment` → `root-cause` merely because another model is available.

If the best unclassified route names a model that is not present in Pi's physical model registry, ForgeFlow deterministically tries the next compatible route. Runtime provider/channel failures are **not** model fallback signals: once a launch has selected a physical model, LiteLLM owns channel failover for that model and Pi surfaces an exhausted model failure back to the parent.

### Thinking effort

Thinking effort is part of each route policy:

- `defaultThinkingLevel`: used when a caller does not provide a level;
- `minThinkingLevel`: floor for the route;
- `maxThinkingLevel`: ceiling for the route;
- legacy `thinkingLevel`: an exact fixed pin retained for version-1 compatibility and single-route policies.

The supported levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. `max` should only be enabled when the physical model's registry metadata explicitly supports it.

The selected virtual level participates in route choice. A `worker` at `low` can therefore resolve to a cheap implementation model while the same `forgeflow/worker` selected at `medium` resolves to a stronger implementation model. After route selection, the level is clamped to that route's configured envelope.

### Decision telemetry

For the current operator policy, GPT-6.1 Sol roles use the `gpt-6.1-sol` supply group. Its first source is native `openai-codex/gpt-6.1-sol` (Business Team / Codex Team; `Media` is the product/quota lane label), followed by `litellm/gpt-6.1-sol` as the commercial relay. If the native source is absent from Pi's registry, a new request selects the commercial source immediately; if it fails at runtime with a qualifying supply error, retry advances to the commercial source.

Version 2 returns a small JSON-serializable routing decision as Pi virtual-model state. Pi stores that state on the session branch as its native `pi.virtual-model-state` entry, so ForgeFlow does not create a second telemetry database. A decision records:

```text
role
routeId
taskClass
physical model
effective thinking level
selection basis (explicit task class or effort envelope)
```

This is enough to audit why a launch used a model and to build routing data later without introducing a learned router now.

### Policy schema v3: supply priority

Version 3 separates **what model capability the role needs** from **which quota source should pay for that model**. A supply group is an ordered list of physical Pi models that represent the same logical model capability:

```json
{
  "version": 3,
  "supplies": {
    "gpt-6.1-sol": {
      "sources": [
        {
          "id": "business-team",
          "model": "openai-codex/gpt-6.1-sol",
          "priority": 10
        },
        {
          "id": "commercial-relay",
          "model": "litellm/gpt-6.1-sol",
          "priority": 20
        }
      ]
    }
  },
  "roles": {
    "worker": {
      "defaultRoute": "frontier",
      "defaultTaskClass": "implementation",
      "routes": [
        {
          "id": "frontier",
          "supplyGroup": "gpt-6.1-sol",
          "taskClasses": ["mechanical", "implementation", "debug"],
          "defaultThinkingLevel": "medium",
          "minThinkingLevel": "low",
          "maxThinkingLevel": "high"
        }
      ]
    }
  }
}
```

For a new request ForgeFlow tries the lowest numeric supply priority whose physical model exists in Pi's model registry. With the operator policy above, `openai-codex/gpt-6.1-sol` consumes Business Team/Codex Team quota first; `litellm/gpt-6.1-sol` is the commercial-relay source. The `Media` label is a product/quota lane name rather than a distinct physical model id.

A supply failover is allowed only on a narrow set of source-specific failures: rate limiting, exhausted quota/credits, capacity/overload, 502/503/504-style upstream failures, transport failures, authentication expiry, or source-specific model unavailability. Context overflow, malformed/bad requests, content-policy failures, tool/schema errors, and other request-semantic failures stay on the current source. This prevents a bad request from silently burning a second paid channel.

Continuation requests stay on the last successful physical model. On a retry caused by a qualifying supply failure, ForgeFlow moves only to the next source in that logical supply group and records the reason in virtual-model state. Once the commercial relay is selected, LiteLLM remains responsible for endpoint/channel routing inside that physical model group; ForgeFlow does not select ACS versus 4Router.

### Usage projection

ForgeFlow writes a compact local JSONL usage projection to `~/.pi/forgeflow-usage.jsonl` by default. Override it with the absolute `FORGEFLOW_USAGE_LOG` path. The projection contains only routing metadata and Pi's normalized assistant usage; it never records credentials or request payloads.

Each v3 route decision records the role, route, logical model, supply id/priority, physical model, effective thinking level, and any supply-failover reason. Each assistant `message_end` records provider/model, stop status, normalized input/output/cache/reasoning token counts, and Pi's normalized cost fields. Use:

```bash
forgeflow-usage
forgeflow-usage --json
```

Business Team usage is therefore visible from Pi/ForgeFlow even though it bypasses LiteLLM. Commercial API truth remains in LiteLLM's `LiteLLM_SpendLogs`, which additionally identifies the actual relay endpoint/deployment such as ACS or 4Router. The two logs intentionally preserve their own authority rather than pretending a subscription-backed Codex request passed through LiteLLM.

### Version 1/2 compatibility

Version 1 single-model policies and version 2 multi-route policies remain valid. Version 3 is preferred for operator policy when one logical model can be supplied by multiple quota sources.

## Turn stickiness

Pi documents that continuation requests should normally remain on the model that handled the turn. ForgeFlow keeps that rule. Version 1/2 retries also stay on the failed physical model. Version 3 permits one explicit exception: a retry whose failure is classified as supply-specific may move to the next source in the same logical supply group.

This preserves provider prompt caches and reasoning signatures during healthy execution while making quota/capacity exhaustion recoverable without re-launching the whole child. The switch is source failover, not semantic model replacement.

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
