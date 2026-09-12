# ForgeFlow model and external-agent routing — V2 implementation plan

> Status: Phase 1 ACP vertical slice implemented; Phase 2 evidence harness implemented but real coding gate is blocked by the current Antigravity headless permission/sandbox behavior.
> Date: 2026-09-12.

## 1. Decision summary

ForgeFlow will separate **model routing** from **agent-runtime routing**.

The existing Open SWE path stays authoritative for current implementation, repair, and review work:

- implementation / repair primary: `fireworks:accounts/fireworks/models/glm-5p3` through the private LiteLLM route, effort `max`;
- implementation fallback: ChatGPT/Codex OAuth `gpt-5.6-luna`, effort `xhigh`;
- review: ChatGPT/Codex OAuth `gpt-5.6-sol`, effort `medium`.

This phase does **not** change those priorities, fallbacks, or model-policy hooks.

A second execution class is introduced for products that are valuable specifically as a complete,
account-authenticated coding agent rather than as a chat-model endpoint. Antigravity is the first
such route and is connected through ACP (Agent Client Protocol):

```text
ForgeFlow policy / future route selector
        |
        +-- MODEL route --------------------> Open SWE agent
        |                                      |-- LiteLLM / GLM
        |                                      `-- Codex OAuth / Luna / Sol
        |
        `-- EXTERNAL_AGENT route -----------> generic ACP client
                                               |
                                               `-- Antigravity ACP bridge
                                                    |
                                                    `-- agy headless agent
                                                         `-- Google account auth
```

The ACP bridge is an **opt-in compatibility surface**, not a restored ForgeFlow runtime. There is no
new SQLite workflow engine, no long-lived Antigravity systemd worker, and no resurrection of the old
Resource Selector.

## 2. Why this boundary

### 2.1 Open SWE model routes

Open SWE is already a complete agent runtime. When ForgeFlow selects GLM, Luna, Sol, or another
API-accessible model, the correct abstraction is still:

```text
Open SWE agent + selected model backend
```

Putting a second full coding agent underneath Open SWE would duplicate planning, tool execution,
workspace ownership, cancellation, and recovery semantics.

### 2.2 Account-native external agents

Antigravity is different. The value we want is the authenticated `agy` agent itself and its account
allowance, tool loop, and native behavior. Treating it as a fake OpenAI-compatible ChatModel would
blur ownership and require unsupported proxy behavior.

For these integrations the abstraction is:

```text
ForgeFlow -> ACP -> external agent
```

ACP gives ForgeFlow a stable protocol surface without forcing all agents to expose the same vendor
API or authentication mechanism.

## 3. Current verified baseline

### 3.1 Open SWE remains unchanged

No existing Open SWE model constants, per-role reasoning efforts, or fallback policy were changed by
this work. `openswe_ext/model_policy.py` remains the authority for the current model path.

### 3.2 Antigravity host readiness

GCP Dev currently has `agy 1.1.28` installed and an already-authenticated account session. Two direct
headless probes passed:

1. JSON single-turn headless invocation returned `SUCCESS`.
2. `stream-json` input/output emitted `init -> step_update -> result`, including a conversation id.

No Antigravity/Gemini API key is introduced by the bridge. Authentication remains owned by `agy`.

### 3.3 ACP vertical slice

The first production-shaped vertical slice is implemented as:

- `forgeflow/external_agents/acp.py`
  - generic ACP subprocess client;
  - ACP initialize/new-session/prompt flow;
  - normalized `AcpExecutionResult`;
  - collects streamed ACP agent-message chunks and safe metadata.
- `openswe_ext/antigravity_acp.py`
  - ACP Agent implementation;
  - one persistent `agy --input-format stream-json --output-format stream-json` process per ACP
    session;
  - text prompt translation;
  - streamed Antigravity response -> ACP `agent_message_chunk` translation;
  - conversation id retained as provenance metadata;
  - ACP cancellation -> Antigravity process-group termination;
  - explicit workspace allowlist;
  - bounded event/prompt sizes;
  - stdout reserved for ACP protocol, diagnostics on stderr.
- `deploy/gcp-dev/start-forgeflow-policy.sh`
  - defines disabled-by-default Antigravity ACP configuration;
  - does not select the route.

A real end-to-end smoke has passed:

```text
ForgeFlow ACP client
 -> ACP stdio bridge
 -> real agy 1.1.28
 -> authenticated Antigravity account
 -> gemini-3.8-flash-high / high
 -> ACP result: end_turn
```

The expected marker was returned exactly and conversation provenance was present.

## 4. Configuration contract

The deployment exports configuration only; the route stays disabled until a future scheduler selects
it explicitly.

| Variable | Default | Meaning |
| --- | --- | --- |
| `FORGEFLOW_ANTIGRAVITY_ACP_ENABLED` | `false` | feature gate; no scheduling effect in Phase 1 |
| `FORGEFLOW_ANTIGRAVITY_BIN` | `$HOME/.local/bin/agy` | official/headless CLI executable |
| `FORGEFLOW_ANTIGRAVITY_MODEL` | `gemini-3.8-flash-high` | initial implementation model |
| `FORGEFLOW_ANTIGRAVITY_EFFORT` | `high` | Antigravity effort |
| `FORGEFLOW_ANTIGRAVITY_MODE` | `accept-edits` | future implementation-mode default |
| `FORGEFLOW_ANTIGRAVITY_PRINT_TIMEOUT` | `20m` | bounded agent turn timeout |

The ACP bridge additionally requires one or more `--allowed-root` arguments supplied by the caller.
The caller must derive them from the selected ForgeFlow project/workspace. They are deliberately not
a second global project registry.

## 5. Security and ownership invariants

1. **Open SWE model routing stays independent.** Enabling ACP must not rewrite GLM/Luna/Sol policy.
2. **No account secret in ACP payloads.** `agy` reads its own authenticated account state locally.
3. **No unrelated service secrets in the agent environment.** The `agy` child receives only a small runtime allowlist (`HOME`, `PATH`, XDG/locale/terminal basics); LiteLLM, GitHub and Codex service credentials are not inherited.
4. **No arbitrary cwd.** An ACP session is rejected unless its resolved cwd is equal to or below an
   explicit allowed root.
5. **No host-wide permission bypass in the bridge.** Phase 1 does not pass
   `--dangerously-skip-permissions`.
6. **No long-lived agent daemon.** The ACP bridge and `agy` are execution-scoped child processes.
7. **One writer per workspace.** A future selector must never start Open SWE and Antigravity against
   the same mutable worktree concurrently.
8. **Protocol stdout is clean.** ACP JSON-RPC owns stdout; diagnostics stay on stderr.
9. **Bounded inputs.** Prompt and event sizes are capped before materialization into policy evidence.
10. **Normalized evidence only.** ForgeFlow should persist route id, runtime, provenance ids, result,
   revisions, and failure class, not full private agent transcripts.

## 6. Target routing model

Do not restore the old multi-dimensional score (`resource tier + model rank + sequence + transport`).
Use an explicit ordered route list per role.

### 6.1 Roles

Keep only two scheduling capabilities:

- `IMPLEMENT`: implementation and implementation repair;
- `REASONING`: planning/review/orchestration-class reasoning when such routing is later enabled.

Review continues to use the independent Open SWE reviewer in the current phase. A separate
`REVIEW` routing class is unnecessary until evidence proves otherwise.

### 6.2 Route schema

Proposed minimal schema:

```yaml
id: anti-account-primary
role: IMPLEMENT
priority: 20
runtime: EXTERNAL_ACP
adapter: antigravity
enabled: true
health: READY
config:
  model: gemini-3.8-flash-high
  effort: high
  mode: accept-edits
```

Existing model-backed work can later be described without moving model policy out of Open SWE:

```yaml
id: openswe-current
role: IMPLEMENT
priority: 10
runtime: OPEN_SWE
enabled: true
```

`OPEN_SWE` means “use the current Open SWE model-policy chain”, not “duplicate every model as a
ForgeFlow route”. That preserves the user's requested boundary for this iteration.

## 7. Selection and fallback semantics

When ordered routing is added, selection should be deterministic:

1. map phase -> role;
2. filter routes by `enabled`, health, expiry and workspace/policy compatibility;
3. sort by the single explicit `priority` integer;
4. acquire workspace ownership;
5. execute the first eligible route;
6. fall through only for a classified **route-availability** failure.

Do not fall through for task/application failures such as invalid tests, malformed requirements, or a
coding agent producing a bad patch. Those belong to the repair/review loop, not provider failover.

Recommended availability states:

- `READY`: selectable;
- `COOLDOWN`: transiently skipped after timeout/429/provider 5xx/temporary transport failure;
- `DISABLED`: operator/auth/quota/contract gate; excluded until explicitly recovered.

Suggested failure classes:

| Failure | Scheduler action |
| --- | --- |
| timeout / transport reset / 429 / provider 5xx | `COOLDOWN`, try next eligible route |
| account auth revoked / definite quota exhausted / executable missing | `DISABLED`, try next route |
| workspace rejected / policy denied | fail closed; do not silently bypass policy |
| invalid objective / bad patch / test failure | remain on engineering workflow; no provider fallback |
| ACP protocol incompatibility | disable that route and require repair/upgrade |

## 8. Attempt ledger

Before automatic multi-route failover is enabled, add a small append-only execution-attempt record.
Each attempt should capture:

```text
plan/thread/work item reference
role
route_id
priority
runtime
model/account label
started_at / finished_at
duration
outcome
failure_class
fallback_reason
external_session_id / conversation_id
source revision / result revision
```

This makes resource decisions explainable and prevents “it silently changed agents” debugging.
Credentials and full transcripts are excluded.

## 9. Implementation phases

### Phase 0 — baseline freeze — complete

- Record current Open SWE models and fallback behavior.
- Do not change existing GLM/Luna/Sol routing.
- Verify GCP Dev `agy` installation and account-authenticated headless access.

**Gate:** direct JSON + stream-json smoke pass.

### Phase 1 — ACP + Antigravity vertical slice — complete

- Add pinned ACP Python SDK dependency.
- Add generic ForgeFlow ACP client.
- Add external runtime bridge under `openswe_ext`, outside the policy package.
- Implement workspace allowlist, stream translation, cancellation, provenance metadata and bounded
  inputs.
- Add disabled-by-default deployment configuration.
- Add fake-agent contract tests.
- Run a real account-authenticated ACP smoke.

**Gate:** full ForgeFlow regression suite stays green and a real ACP->Antigravity prompt succeeds.

### Phase 2 — disposable coding smoke — harness complete, real gate blocked

The disposable harness is implemented and always uses a generated repository below
`~/.local/share/forgeflow-policy/external-agent-workspaces`; it never points Antigravity at a live
shared project checkout. It:

1. establishes a known base commit;
2. invokes the external agent through the generic ACP client;
3. requires exactly one expected file to change and includes untracked files in the check;
4. runs an explicit verification command independently of the agent;
5. records a binary-diff SHA-256, base/result revisions, test exit code, ACP session id and external
   conversation id;
6. creates the result revision itself only after verification;
7. destroys the disposable workspace on both success and failure.

The first real coding attempt exposed an upstream headless constraint rather than a ForgeFlow diff
problem. `agy` returned `SUCCESS` while reporting a soft-denied `read_file` action, so no edit was
made. ForgeFlow now treats any non-empty `denied_actions` result as the structured failure
`ANTIGRAVITY_TOOL_PERMISSION_DENIED`; a soft denial can no longer masquerade as a successful run.

A second safety probe tested the only documented bypass, `--dangerously-skip-permissions` together
with `--sandbox`. On the current GCP Dev host and `agy 1.1.28`, the resulting tool process attempted
`find / ...` and remained `unconfined` with `Seccomp=0` and `NoNewPrivs=0`, in the same mount
namespace as the host process. ForgeFlow therefore does **not** enable that bypass. Public upstream
reports also document headless `permissions.allow` problems around the current 1.1.x line:

- https://github.com/google-antigravity/antigravity-cli/issues/548
- https://github.com/google-antigravity/antigravity-cli/issues/955

The safe retry command is `uv run python deploy/gcp-dev/run-antigravity-acp-smoke.py`. It returns
`PASS` with normalized revision/test evidence, or `BLOCKED` with a bounded failure code.

**Gate:** still requires reproducible edit + test + independent git evidence, with no host pollution.
Phase 3 must not be enabled until this command passes without broad permission bypasses.

### Phase 3 — guarded ForgeFlow execution route

Add a tiny `ExternalAgentExecutionPort`/adapter boundary to the ForgeFlow orchestration layer. Do not
teach policy code about Antigravity-specific CLI flags.

Initial rollout rules:

- route feature flag remains off by default;
- only explicitly allowlisted trusted projects;
- only `IMPLEMENT`/repair phases;
- official review still uses the current Open SWE Sol reviewer;
- no automatic fallback to ACP until the attempt ledger and failure classifier are present.

**Gate:** one real project task completes through external route and passes normal CI + independent
review.

### Phase 4 — ordered role routing

Introduce the minimal role/priority registry and attempt ledger. At this point Antigravity can be
placed before or after the current Open SWE implementation route by configuration.

The first safe production shape should be conservative, for example:

```text
IMPLEMENT
  10 current Open SWE chain (unchanged GLM -> Luna)
  20 Antigravity ACP (account-native)

REASONING
  10 current Open SWE reviewer/reasoning path
```

Priority can be reversed later based on measured cost, quality, latency, and account quota policy.
The important property is that it is explicit and auditable.

### Phase 5 — additional external agents

Only after the Antigravity route is stable, reuse the **same generic ACP client** for other complete
agents such as ZCode or Codex CLI. Each integration should be a thin ACP bridge/adapter with its own
capability declaration; do not add provider-specific branches to the selector.

ZCode is especially suitable for a future route because its model backend can still point at a
provider-specific LiteLLM route while ZCode remains the coding agent.

## 10. Test matrix

### Contract/unit

- ACP initialize/new-session/prompt succeeds.
- text chunks stream in order.
- result metadata includes runtime/model/conversation provenance.
- empty prompts fail before subprocess creation.
- workspace outside allowlist is rejected with structured ACP invalid-params data.
- malformed/oversized Antigravity events fail closed.
- cancellation terminates the execution process group.
- bridge does not require Gemini/Antigravity API-key environment variables.

### Regression

- architecture boundary still forbids execution-runtime ownership under `forgeflow/` policy package;
- Open SWE model-policy tests remain unchanged;
- full pytest suite and Ruff pass.

### Integration

- authenticated real `agy` read-only ACP smoke;
- disposable coding/edit smoke;
- later: one full ForgeFlow implementation -> CI -> official reviewer acceptance path.

## 11. Explicit non-goals for this iteration

- No replacement of Open SWE.
- No change to GLM/Luna/Sol scheduling.
- No broad Resource Selector restoration.
- No Antigravity systemd worker fleet.
- No automatic multi-agent parallel writers.
- No routing based on prompt “difficulty”.
- No attempt to proxy the Antigravity account into an OpenAI-compatible model API.
- No Codex CLI ACP migration in this phase.

## 12. Upstream references

- Antigravity Headless CLI: <https://antigravity.google/docs/cli/headless/>
- ACP Python SDK: <https://github.com/agentclientprotocol/python-sdk>
- Agent Client Protocol: <https://agentclientprotocol.com/>

The local implementation is intentionally narrower than either upstream surface. Only capabilities
needed for a safe ForgeFlow execution route are enabled.
