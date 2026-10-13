# Delegating to external ACP coding agents

ForgeFlow registers **local, asynchronous** external coding agents with the existing
`pi-subagents` runtime. ForgeFlow does not own their sessions, credentials, model
configuration, provider/channel health, scheduling, worktrees, or run ledger.

The adapter is intentionally a single ACP **stdio → stdin/stdout** bridge,
`bin/acp-subagent.mjs`. On each run it:

1. Reads the assembled delegated task on stdin, using the current working directory.
2. Starts the selected local ACP executable with no shell interpolation.
3. Negotiates `initialize` and `session/new`.
4. Selects the advertised access mode when the agent provides one.
5. Sends one `session/prompt`; forwards only final assistant text to stdout.
6. Exits nonzero on RPC errors, non-`end_turn` stops, empty final text, timeouts,
   oversized output or missing native components.

`pi-subagents` still owns task status, mission association, background execution,
retention, artifacts and lifecycle. The bridge does **not** create a separate
worker, scheduler, retry ledger, provider router or transcript store.

## Agent catalog

| Canonical agent | Aliases | Mode | ACP executable | Permissions |
| --- | --- | --- | --- | --- |
| `glm-agent` | `glm` | `default` | `glm-acp-t3` | Analysis; denies requested edits/commands |
| `glm-agent-writer` | `glm-writer` | `accept_edits` | `glm-acp-t3` | Explicit writer; allows per-command `allow_once` requests |
| `zcode-agent` | `zcode` | `plan` | `zcode-acp-t3` | Analysis; denies permission requests |
| `zcode-agent-writer` | `zcode-writer` | `build` | `zcode-acp-t3` | Explicit writer; allows per-request `allow_once` |
| `dsh-agent-writer` | `dsh`, `dsh-writer` | DSH default | `dsh acp` | Explicit writer |

DSH currently advertises model and reasoning settings via ACP but **no enforceable
read-only mode**. Do not register DSH as a read-only reviewer until that capability
is available and tested.

The reader profiles decline ACP permission requests, and the bridge never grants
the **client-side** file or terminal capabilities. These are ACP permission
boundaries, **not operating-system sandboxes**: all external Agents can potentially
access whatever the launched OS user can access. Run untrusted tools in an actual
sandbox, and never assign a reader as the only enforcement of an isolation policy.

In particular, writer names grant explicit authority for their respective ACP
mode; **one writer per worktree** remains mandatory. Reviewers should use a
separate context and must not mutate the candidate they judge.

## Setup on GCP Dev

For the current tested installation, the model-provider choices and credentials
already reside within the **external Agent** launchers:

- `glm-acp-t3`: GLM Agent with WindHub Direct / GLM-5.3.
- `zcode-acp-t3`: ZCode ACP bridge with WindHub Direct / GLM-5.3.
- `dsh acp`: DSH's local configured profile/provider/model.

The two WindHub launchers obtain the user-owned private configuration from
`~/.config/t3-direct-providers/windhub.json`; ForgeFlow neither reads nor stores
that credential. The bridge does **not** invoke the T3 runtime or LiteLLM.

The executable names can be overridden without touching package code:

| Environment variable | Default executable |
| --- | --- |
| `FORGEFLOW_GLM_ACP_COMMAND` | `glm-acp-t3` |
| `FORGEFLOW_ZCODE_ACP_COMMAND` | `zcode-acp-t3` |
| `FORGEFLOW_DSH_ACP_COMMAND` | `dsh` (fixed `acp` argument) |

The command variable is a **single executable path or name**, not a shell command;
arguments are not interpolated. When the command is missing, the delegated run
fails explicitly. Core Pi and ForgeFlow remain usable.

Optional time bounds in milliseconds:

- `FORGEFLOW_ACP_STARTUP_TIMEOUT_MS`: default 45,000; range 1,000–180,000.
- `FORGEFLOW_ACP_RUN_TIMEOUT_MS`: default 3,600,000; range 1,000–7,200,000.

Prompts and final responses are bounded at 256 KiB. All other ACP session updates,
including reasoning chunks and untrusted tool output, stay inside the child
process. Original backend stderr is **not forwarded** to the parent transcript
because it may contain tokens, private paths, or prompts.

## Using pi-subagents

Start the ForgeFlow-enabled Pi profile and choose an explicitly named external
agent, for example:

```text
Use glm-agent to inspect the current diagnosis ViewModel contract. No changes.

Delegate the isolated, approved Person Records UI ticket to zcode-agent-writer;
wait for its handoff, then let a read-only reviewer inspect the diff.

Use dsh-agent-writer for a narrowly scoped implementation ticket in its own
worktree.
```

The underlying tool call is equivalent to:

```js
subagent({
  agent: "zcode-agent-writer",
  task: "Implement only the approved ticket, test it and report evidence.",
  async: true
})
```

Generic `external-cli` agents are **local-only** and **async-only**. They
receive a prompt and current working directory, not the full native Pi session.
Do not pass a native `model` or `thinking` override to them: they use their
respective ACP session's configured model/provider. Changing a T3 Provider
instance by ID is a **separate future integration**; registering these agent
names does not add T3-instance routing or automatic quota failover.

A completed external run is not proof that the software change is accepted.
Review diffs and use the project's actual build, test, CI and current-head
delivery evidence.

## Failure and interruption policy

- No model response or only thinking, then ACP `end_turn`: **failed**
  (prevents the Pi/T3 reasoning-only false-success regression).
- An ACP `cancelled`, `refused`, provider RPC error, or CLI crash: **failed**.
- Pending questions or unknown client-side tools: **denied / unsupported**;
  never fabricate answers to user decisions.
- `SIGINT`/`SIGTERM`: terminate the child process group.
- Provider/model quota failures are **not silently switched** to another Agent.
  Before changing executor, capture the current run ID, partial Git diff,
  worktree ownership and plan checkpoint; obtain explicit owner approval.

An external ACP run launches a **fresh ACP session**. It does not restore an
external Agent's hidden conversation or checkpoint; the project plan and Git
state are the handoff contract.

## GCP Dev verification (2026-10-13)

- GLM ACP: successful isolated read-only file inspection and explicit writer edit.
- ZCode ACP: successful isolated read-only file inspection and explicit writer edit.
- DSH ACP: `initialize` and `session/new` succeed, but the configured model
  request returns ACP `-32603`. The initial `deepseek-official` selection reports
  a missing API key. Selecting the existing `deepseek-account` model within
  the DSH session also did **not** restore inference. DSH's own credentials/model
  configuration must be made healthy independently; ForgeFlow deliberately does
  not steal another agent's credential or silently substitute LiteLLM.

## Verification

```bash
npm run check
printf 'Answer just TEST_OK' | node bin/acp-subagent.mjs glm plan
printf 'Answer just TEST_OK' | node bin/acp-subagent.mjs zcode plan
printf 'Answer just TEST_OK' | node bin/acp-subagent.mjs dsh writer
```

Run write-capability checks only in a disposable, isolated worktree or temporary
directory. Never use the BodySense integration checkout as a smoke-test target.
