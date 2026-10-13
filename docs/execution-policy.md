# ForgeFlow Execution Policy V1 (P0–P3)

Status: implemented as a **deterministic policy compiler and preflight**, not a new
scheduler, workflow engine, Agent runtime or provider router. Each source of truth
remains where it belongs:

- **Planner (Pi)** decomposes a *previously authorized* Active Plan into bounded
  tickets with explicit dependencies and acceptance.
- **ForgeFlow** checks known Agent/Model pairings, capabilities, effort,
  authorization, worktree admission and task-wave constraints; it generates
  one-step or batch dispatch contracts.
- **pi-subagents** exclusively owns Agent launches, native Git worktree
  allocation, task run state, status, resumes, missions, artifacts, review and
  acceptance evidence.
- **External ACP Agent** owns its own model, Provider, account, tools and
  execution session. ZCode/GLM currently use WindHub / GLM-5.3. DSH is
  disabled until its live model health is repaired.
- **Git, tests, CI and the project's Active Plan** are the ultimate evidence
  for whether the current candidate has been delivered.

## P0 · Inventory, operator model-policy fix and verified pairings

The source-controlled default execution profiles are at
[`config/execution-policy.v1.json`](../config/execution-policy.v1.json).
Operator-local overrides are in `~/.pi/forgeflow-execution.json`. A project
may provide `.pi/forgeflow-execution.json` only if Pi explicitly trusts it.
`FORGEFLOW_EXECUTION_POLICY` accepts an absolute path and overrides both.
Policy JSON contains no passwords, headers or API keys.

| Profile | Agent runtime | Model selection | Access | Enablement |
| --- | --- | --- | --- | --- |
| `zcode-fast-writer` | ZCode ACP | WindHub / GLM-5.3, Agent-owned | write, prepared worktree | yes |
| `pi-fast-writer` | native Pi | `forgeflow/worker:low` → DeepSeek V4.1 Flash | write, managed worktree | yes |
| `pi-core-writer` | native Pi | `forgeflow/worker:high` → GPT-6.1 Sol | write, managed worktree | yes |
| `pi-max-writer` | native Pi | `forgeflow/worker:max` → GPT-6 Luna | write, managed worktree | yes (opt-in by profile) |
| `pi-scout` | native Pi | `forgeflow/scout:low` → DeepSeek V4.1 Flash | read | yes |
| `glm-advisor` | GLM ACP | WindHub / GLM-5.3, Agent-owned | read (ACP plan) | yes |
| `zcode-advisor` | ZCode ACP | WindHub / GLM-5.3, Agent-owned | read (ACP plan) | yes |
| `glm-alternative-writer` | GLM ACP | WindHub / GLM-5.3, Agent-owned | write, prepared worktree | yes |
| `pi-reviewer-writer` | native Pi | `forgeflow/reviewer:high` | **may edit**, managed worktree | yes |
| `dsh-writer` | DSH ACP | DSH local config | write | **disabled**, upstream auth/inference not yet healthy |

Agent availability has three separate meanings:

1. **Discovered**: a Pi model id or a local ACP executable exists.
2. **Configured/previously verified**: a known Agent + model/provider pairing
   passed a previous live test. This can become stale at any time.
3. **Healthy now**: an actual authenticated model/tool call succeeds. Discovery
   alone never proves quota or current health.

Pi execution profiles additionally specify `expectedPhysicalModels`: an exact
allowlist checked **after** virtual-model resolution, so a later policy drift
cannot silently turn `pi-fast-writer` into a costly GPT-6.1 Sol call.
If the allowed model is unavailable, policy selection blocks or chooses another
compatible execution profile. No hidden cross-capability fallback is allowed.

An external Agent's `modelLabel` and `providerLabel` are **metadata only**.
Do not submit them as Pi's `model` argument. A Pi profile instead carries the
exact virtual-model selector, with a Thinking suffix if applicable.

For the operator model policy v3, set `roles.worker.defaultRoute = "fast"`.
This fixes the old `worker:low` tie that preferred GPT-6.1 Sol even for
routine edits. Low effort then prefers DeepSeek, medium/high prefers Sol,
max selects Luna. Existing Provider supply priority and modelScope remain
unchanged. When Fast is absent, the existing V3 model router checks other
compatible configured routes, but an upstream quota error does not silently
switch to another Agent.

Run **model-free introspection** in an active Pi session:

```js
forgeflow_execution({ action: "inventory" })
```

CLI (pass model inventory as `availableModels` in a JSON input if you want
the CLI, rather than Pi, to verify registered virtual and physical models):

```bash
forgeflow-execution inventory
forgeflow-execution select /absolute/path/task.json
forgeflow-execution plan /absolute/path/plan.json
```

## P1 · Deterministic Agent + Model selection

The Planner submits a bounded, explicit task contract:

```json
{
  "id": "diagnosis-ui",
  "description": "Implement the approved Diagnosis V2 UI component against the frozen ViewModel.",
  "kind": "implementation",
  "complexity": "low",
  "access": "write",
  "dependsOn": [],
  "acceptance": ["Relevant UI tests pass", "No unrelated changes"]
}
```

It calls:

```js
forgeflow_execution({ action: "select", task: /* explicit ticket object */ })
```

The policy first rejects incompatible task type, complexity, permission,
disabled/blocked profile, missing executable/model, missing physical route or
unsafe external worktree, then ranks compatible candidates by explicit
`rank` and stable profile id. There is no hidden LLM task classifier and no
randomized route selection.

With **no prepared external worktree**, a low-complexity write falls back to
native Pi / DeepSeek (managed worktree), rather than allowing ZCode to edit
the parent checkout. With a **clean, independent and registered Git worktree**
bound to the task's `repo`, `cwd` and optionally `expectedHead`, ZCode
can be selected instead.

An explicit `task.profile` can restrict a task to one approved profile.
It still **cannot** bypass the task's permission, health, executable,
model-route or worktree gates. DSH cannot be enabled by a per-task override.

This policy does not yet route to T3's ProviderInstance ids. External Agent
accounts remain independently configured.

## P2 · Dependency waves and safe parallel fanout

A plan request contains 1–64 explicit tasks, each with a stable id, dependency
edges and acceptance; maximum concurrency is 1–8 tasks per wave (default 4):

```json
{
  "maxParallel": 3,
  "tasks": [
    {
      "id": "schema",
      "description": "Implement approved diagnosis persistence contract",
      "kind": "implementation", "complexity": "high", "access": "write"
    },
    {
      "id": "api",
      "description": "Implement API against frozen schema",
      "kind": "implementation", "complexity": "low", "access": "write",
      "dependsOn": ["schema"]
    },
    {
      "id": "ui",
      "description": "Implement UI against frozen schema and ViewModel",
      "kind": "implementation", "complexity": "low", "access": "write",
      "dependsOn": ["schema"]
    },
    {
      "id": "integration",
      "description": "Test cross-domain contract and integration",
      "kind": "review", "complexity": "high", "access": "read",
      "dependsOn": ["api", "ui"]
    }
  ]
}
```

Call `forgeflow_execution({ action: "plan", tasks, maxParallel: 3 })`.

The compiler checks acyclic dependencies, bounded fanout, each Agent's
capability, executable/model readiness and pre-existing registered worktree.
It returns topological `waves[]` with two **different plugin dispatch
surfaces**:

- `nativeRunsAll`: native Pi children that can be issued via
  `runs.all([...])` in a standard pi-subagents workflow, with
  `worktree: true` on mutation-capable children.
- `externalSubagentCalls`: separate asynchronous
  `subagent({ agent, task, cwd, async: true })` calls for external ACP agents.
  These are **not** placed in a `runs.all` batch, because the generic
  external-CLI adapter does not support managed worktrees or per-child cwd
  in that workflow helper.

**No worker is launched by the policy tool.** The Pi Planner takes the
returned dispatch contract and issues it through pi-subagents. The next wave
must not start merely because the previous one emitted text: it needs
resolved Run status, reviewed Git changes, and the ticket's actual verification
evidence. Run receipts, Mission state and accepted handoffs stay in
pi-subagents, not a new ForgeFlow JSON database.

For external writers the policy checks that the directory is a clean,
registered worktree from the same Git repository, different from the parent
checkout. It rejects reuse of one external worktree anywhere within one
plan, including sequential waves. The `activeWriterPaths` option can reject
known active writers supplied from pi-subagents status.

**A Git preflight cannot prove absence of an active process.** Before every
external writer launch the Planner/operator must check the authoritative
pi-subagents active-run/ownership roster. The plan reports this missing proof;
it does not claim to acquire a concurrency lease.

ACP read-only modes deny permission requests but are not kernel-level
sandboxes. Do not use them in an untrusted checkout as the sole enforcement
of write restrictions.

## P3 · Controlled failure handoff, not automatic replay

The first response to a failed or stopped worker is **inspect/recover that
retained child**, where supported, keeping the same Agent and model. A
cross-Agent replacement is a distinct, operator-approved recovery.

After the original worker has stopped and its status has been read through
pi-subagents, capture the actual working tree:

```js
forgeflow_execution({ action: "snapshot", worktree: "/absolute/approved/worktree" })
```

or with the CLI:

```bash
printf '{"worktree":"/absolute/approved/worktree"}' |
  forgeflow-execution snapshot
```

The snapshot returns HEAD, tracked-diff digest, untracked-file content hashes
aggregated into a 64-digit SHA-256 fingerprint, and whether the checkout is
dirty. It does **not** copy the source bytes into a ForgeFlow event log.
Ignored files, git-ignored build outputs, running processes, remote provider
state, and uncommitted model thoughts are not covered by this fingerprint.

The operator/Planner attaches that fingerprint, the original Run id, an
explicit checkpoint summary, plugin-owned terminal status and approval to a
`recover` preflight:

```json
{
  "run": {
    "id": "run-from-pi-subagents",
    "agent": "zcode-agent-writer",
    "status": "failed",
    "owner": "pi-subagents",
    "stopConfirmed": true,
    "worktree": "/absolute/approved/worktree",
    "error": "rate limit from actual Run status"
  },
  "checkpoint": {
    "sourceRunId": "run-from-pi-subagents",
    "head": "40-or-64-digit-git-oid",
    "fingerprint": "64-digit-sha256-fingerprint",
    "summary": "Exactly what was edited, verified and not completed"
  },
  "approval": {
    "granted": true,
    "scope": "cross-agent",
    "sourceRunId": "run-from-pi-subagents",
    "by": "operator",
    "id": "approval-record-reference"
  },
  "targetAgent": "glm-agent-writer",
  "targetWorktree": "/absolute/approved/worktree",
  "activeWriterRunIds": []
}
```

Call `forgeflow_execution({ action: "recover", recovery })`. It rejects
active writers, absent operator approval, conflicting worktree identity,
stale HEAD, changed tracked/untracked bytes, and unconfirmed termination.
It classifies upstream supply failures and explicit Agent crashes/timeouts/
operator stops differently from malformed requests, context overflow, policy,
unknown or tool errors. The latter **block** cross-Agent substitution until
the task/error itself is remediated. It also rejects disabled DSH or a native
Pi Agent as a dirty same-worktree successor (native Pi uses new plugin-managed
worktrees). It never echoes raw credential-bearing provider error text.

An eligible result is **not** an authorization signature and is **not** a
new launch. The submitted status/approval must come from the real
pi-subagents and operator evidence; ForgeFlow cannot verify their provenance
from arbitrary JSON. The new writer must receive the verified checkpoint,
and subsequent acceptance still requires current-head review/tests/CI.

The V3 *same-model, different supply source* failover remains in the
Model Policy; it is separate from the V1 cross-Agent takeover decision.
The current `gpt-6.1-sol` supply group contains only the native Codex Team
source, so an exhausted Business Team has no configured alternate source.

## Implementation and validation boundaries

- This work **does not change BodySense's own Active Plan or schema**.
- It **does not restart T3**, modify T3 Provider lists, or migrate credentials.
- No new queue, database, or persistent runner exists; all execution remains
  subject to the current pi-subagents runtime and per-Worktree ownership.
- Long-running automatic mission continuation is not supplied by this policy.
  The parent Pi Planner or a separately authorized T3/ChatGPT orchestration
  flow must continue the next wave and interpret acceptance evidence.
- P4, a genuine BodySense multi-Worker rollout, is separate and should
  proceed only after the strategy/Worktree preflight and release CI pass.
