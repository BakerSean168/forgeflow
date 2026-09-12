# ForgeFlow Policy V1 — Open SWE Quality Governance Architecture

> **Status: implemented current architecture for the v2.0.0 release candidate.**
> ForgeFlow is a thin deterministic quality-policy layer on pinned Open SWE/LangGraph. It is not a
> standalone coding-agent runtime. The previous Node/SQLite/OpenHands/Antigravity runtime has been
> removed from the repository and GCP Dev deployment.

## Current system at a glance

```text
Hermes / operator
      |
      v
ForgeFlow policy graph -------------------- deterministic quality decisions
      |
      +----> GitHub ------------------------ authoritative PR head + CI
      |
      +----> Open SWE agent ---------------- implementation / same-thread repair
      |          |
      |          +--> Deep Agents / tools
      |          +--> openswe_ext Docker sandbox provider
      |
      +----> Open SWE official reviewer ---- independent exact-head review
      |
      +----> LangGraph --------------------- thread/run/checkpoint + cron/replay
```

Current GCP Dev runtime components are `forgeflow-policy.service`,
`open-swe-codex-broker.service`, the Open SWE Docker sandbox network helper, and the hourly sandbox
GC timer. **There is no OpenHands Agent Server, OpenHands container, long-lived Antigravity worker,
Node control plane, or ForgeFlow SQLite workflow database in the current runtime.** An experimental,
disabled-by-default Antigravity ACP bridge exists as an execution-scoped runtime extension. Writable external-agent turns are additionally wrapped in a short-lived Docker sandbox whose bootstrap account mount is detached before the project prompt; the extension does not own workflow state or change the default Open SWE route.

Delivery ownership is explicit: external agents never receive GitHub delivery credentials; ForgeFlow independently verifies workspace evidence, writes operation provenance into the commit, pushes the branch, and creates the pull request.

## Historical destructive cutover contract

The following sequence is retained as the v2 migration record. It is not a list of currently
running components. The cutover is complete and the legacy resources named here were removed only
after replacement health was proven.

1. Build and validate the exact candidate checkout.
2. Install/start `open-swe-codex-broker.service` and `forgeflow-policy.service` side-by-side with the legacy runtime.
3. Authenticate to the replacement and require `/ok`, all six graph ids (`agent`, `reviewer`, `analyzer`, `chat`, `scheduler`, `forgeflow`), the expected systemd fragment/ExecStart identity, and a successful authenticated broker token probe.
4. Only after that proof, stop every known legacy ForgeFlow/OpenHands/Antigravity unit and verify each is inactive. Stop failure is a hard blocker.
5. Only after quiescence proof, remove legacy container/image, `/var/lib/forgeflow`, old unit/drop-in files, exact known libexec helpers, the legacy AppArmor profile, and the old OpenHands literal-worktree override. Preserve independently owned `/etc/forgeflow/litellm.env`.
6. Re-run replacement health after cleanup. There is no legacy database/schema migration or compatibility adapter.

The repeatable cleanup guard remains in `deploy/gcp-dev/purge-legacy.sh` so a stale legacy resource
cannot silently reappear.

## 1. Executive decision

ForgeFlow Policy V1 is **not** a coding-agent runtime, worktree manager, provider router, durable workflow database, release controller, or second software factory.

It owns only one question:

> Given an engineering objective handled by Open SWE, is there enough independent, exact-revision evidence to declare the work ready, or must it be repaired/retried/escalated?

The current ownership boundary is:

```text
User / Hermes
    |
    v
ForgeFlow Policy Graph
    |  quality policy only
    |
    +--> Open SWE Agent Graph -------- implementation / repair
    |         |
    |         +--> Deep Agents / sandbox / subagents / Git / PR
    |
    +--> GitHub ---------------------- exact PR head + CI evidence
    |
    +--> Open SWE Reviewer Graph ----- independent exact-head review
    |
    +--> LangGraph ------------------- durable thread/run/checkpoint state
```

ForgeFlow does **not** duplicate any of those owners.

## 2. Evidence for the reset

The pre-v2 ForgeFlow implementation owned the entire lifecycle itself:

- ~37.6k lines under `src/`;
- ~25.0k lines under `test/`;
- ~19.3k lines in `src/core/` alone;
- ~7.5k lines of custom persistence;
- ~7.1k lines of custom orchestration;
- ~11.5k lines of external integrations;
- a custom SQLite schema for plans, graph versions, executions, reviews, supervisor state, leases, resource state, runtime admission, project queues, worktrees, delivery, maintenance, and release evidence;
- custom OpenHands, Antigravity, worktree ACL/provenance, resource routing, recovery, release and self-promotion infrastructure.

At migration planning time, the deployed legacy runtime also owned ~3.0 GB under `/var/lib/forgeflow`, including ~2.5 GB of OpenHands/tooling state and hundreds of MB of SQLite backups. That state has since been removed from GCP Dev.

That architecture was rational when ForgeFlow had to supply its own durable software-engineering runtime. It is now redundant with Open SWE + Deep Agents + LangGraph.

The Open SWE bakeoff established that the upstream runtime can already provide:

- isolated per-thread workspaces;
- true parallel worker/subagent execution;
- durable thread/run state;
- same-thread continuation after failure;
- Git commit/push/PR delivery;
- official reviewer graph in the full deployment;
- reviewer finding persistence in LangGraph thread metadata;
- scheduler/reconciliation infrastructure;
- GitHub App integration;
- model overrides for agent and reviewer roles.

The bakeoff also established the policy requirement ForgeFlow must retain: **a run marked success is not sufficient evidence of engineering completion**.

## 3. Product boundary

### ForgeFlow owns

1. Engineering quality state for one objective.
2. Model-role policy:
   - implementation/repair model;
   - reviewer model;
   - reviewer subagent model.
3. Evidence-owned completion.
4. Exact-head consistency between PR, CI and review.
5. Severity mapping and delivery gate.
6. Bounded repair/retry budgets.
7. Escalation when autonomous closure is unsafe or exhausted.
8. A small observable policy state for Hermes/operator use.

### Open SWE owns

1. Agent loop.
2. Deep Agents and subagents.
3. Thread/session context.
4. Sandbox/workspace lifecycle.
5. Git operations.
6. Branch naming.
7. Commit/push behavior.
8. PR creation/update.
9. Agent tool execution.
10. Reviewer execution and finding persistence.
11. GitHub App credentials and webhook integration.
12. Scheduler primitives.
13. Model/provider client implementation and fallback middleware.

### LangGraph owns

1. Policy graph checkpointing.
2. Child graph thread/run durability.
3. Run status and cancellation primitives.
4. Cron/wakeup scheduling.
5. Resume/replay after service restart.

### GitHub owns

1. Repository source of truth.
2. PR identity.
3. Exact PR head SHA.
4. Check runs/statuses.
5. Review comments and review-thread surface state.

## 4. Non-goals

ForgeFlow Policy V1 does not implement:

- its own SQLite/PostgreSQL workflow database;
- schema migrations from the retired ForgeFlow DB;
- old `/api/v1/*` compatibility;
- old generated `@forgeflow/client` compatibility;
- custom Plan/WorkItem/Execution/Review entities mirroring Open SWE;
- custom worktree creation or ACL management;
- OpenHands Agent Server integration;
- the legacy long-lived Antigravity worker integration (replaced only by an optional execution-scoped ACP bridge);
- LiteLLM resource directory / runtime admission / provider health routing;
- custom execution leases;
- custom event store;
- custom Supervisor model;
- custom release/self-promotion engine;
- autonomous self-improvement in v2.0.0;
- automatic merge in v2.0.0;
- compatibility adapters for old ForgeFlow state.

If implementation begins recreating any of these, the architecture has drifted and must stop for review.

## 5. Integration strategy

### Decision: overlay package, not a heavy fork

ForgeFlow becomes a small Python package deployed in the **same LangGraph server** as a pinned Open SWE dependency.

Conceptual dependency:

```toml
open-swe-agent = { git = "https://github.com/langchain-ai/open-swe.git", rev = "<PINNED_SHA>" }
```

The current `langgraph.json` exposes Open SWE through the narrow `openswe_ext.graphs` wrapper so
self-hosted compatibility hooks are installed before upstream graph construction:

```json
{
  "graphs": {
    "agent": "openswe_ext.graphs:agent_graph",
    "reviewer": "openswe_ext.graphs:reviewer_graph",
    "analyzer": "openswe_ext.graphs:analyzer_graph",
    "chat": "openswe_ext.graphs:chat_graph",
    "scheduler": "openswe_ext.graphs:scheduler_graph",
    "external_agent": "openswe_ext.external_agent_graph:get_external_agent_graph",
    "forgeflow": "forgeflow.graph:get_forgeflow_graph"
  },
  "http": {
    "app": "agent.webapp:app"
  }
}
```

`openswe_ext.graphs` then delegates to the pinned upstream Open SWE graphs. The separate
`external_agent` graph is ForgeFlow-owned runtime compatibility code: it executes one already-selected
external route as a durable LangGraph child run and publishes only normalized execution/PR evidence.
This keeps upstream source unmodified while making the self-hosted Docker provider, external-agent
runtime, and workflow-push guard explicit. Policy logic belongs under `forgeflow/`; narrowly scoped
runtime compatibility code belongs under `openswe_ext/`. ForgeFlow does not vendor or edit an
`agent/` package.

### Why not an external controller service?

A separate service would need another persistence/scheduler/recovery layer and would recreate the architecture we are deleting.

### Why not a broad Open SWE fork?

A broad fork would increase upstream merge burden and make it difficult to distinguish policy from runtime. The default rule is therefore:

> Import narrow upstream contracts, pin the upstream SHA, and keep ForgeFlow changes in its own package.

If an upstream internal contract proves impossible to use safely, prefer contributing a small extension upstream before carrying a long-lived patch.

## 6. Upstream pinning policy

Open SWE is moving quickly. ForgeFlow must never run directly from a floating `main`.

Rules:

1. Pin one exact Open SWE commit in `pyproject.toml`/`uv.lock`.
2. Record the SHA in `README.md` and `docs/upstream.md`.
3. Every upstream bump is a separate PR.
4. Every bump must pass ForgeFlow's upstream-conformance suite before product tests.
5. The v2 rebuild pinned `0ff86e22a94cc84e32883fcb1beee568560d4140` and completed the real Thin-Policy acceptance scenario before release-candidate promotion.

There is no compatibility promise across arbitrary Open SWE revisions.

## 7. Policy state

ForgeFlow state is intentionally a **reference ledger**, not a second execution database.

Implemented shape (abridged from `forgeflow/state.py`):

```python
class ForgeFlowState(TypedDict, total=False):
    # objective identity
    objective: str
    repo_owner: str
    repo_name: str
    base_ref: str

    # implementation references
    implementation_thread_id: str
    implementation_run_id: str

    # GitHub evidence references
    pr_url: str
    pr_number: int
    observed_head_sha: str
    ci_head_sha: str

    # reviewer references
    reviewer_thread_id: str
    reviewer_run_id: str
    reviewed_head_sha: str

    # bounded policy counters / scheduling
    run_retry_count: int
    reviewer_retry_count: int
    repair_round: int
    reconcile_cron_id: str | None

    # summarized policy evidence only
    blocking_finding_ids: list[str]
    last_failure_code: str | None

    status: Literal[
        "NEW",
        "IMPLEMENTING",
        "VERIFYING",
        "WAITING_FOR_CI",
        "REVIEWING",
        "REPAIRING",
        "READY",
        "ESCALATED",
        "CANCELLED",
    ]
```

Do not copy full Open SWE messages, full findings, GitHub responses, logs, patches, or sandbox state into ForgeFlow state. Store references and normalized decisions only.

## 8. Primary lifecycle

```text
NEW
 |
 v
IMPLEMENTING
 |  dispatch Open SWE agent
 v
VERIFYING
 |  run success is NOT enough
 |  require PR + exact head evidence
 v
WAITING_FOR_CI
 |  exact-head required checks accepted
 v
REVIEWING
 |  official Open SWE reviewer on exact head
 v
+-----------------------------+
| blocking findings?          |
|                             |
| yes                         | no
v                             v
REPAIRING                    READY
 |                             |
 | same implementation thread | monitor authoritative PR head
 | repair -> new head          | head drift
 +------> WAITING_FOR_CI <------+
```

Any new push invalidates prior CI and review evidence because the head SHA changed. `READY` is a
**monitored ready state**, not a terminal state: its reconcile cron stays live so external head
drift can return the objective to `WAITING_FOR_CI`. Only `ESCALATED` and `CANCELLED` are terminal
and remove the cron.

## 9. Reconcile model

ForgeFlow is a replay-safe reconciler, not a monolithic long-running coroutine.

Each policy run:

1. reads current ForgeFlow checkpoint state;
2. reads current Open SWE child thread/run state;
3. reads current GitHub PR/head/check evidence when needed;
4. reads reviewer thread metadata when needed;
5. performs at most one bounded side effect;
6. persists the new policy state;
7. exits.

A non-terminal policy thread is re-invoked by a LangGraph cron/wakeup. This includes `READY`, which remains monitored for PR head drift. `ESCALATED` and `CANCELLED` are the only terminal statuses and remove the reconcile cron.

This keeps crash recovery simple: the next reconciliation re-observes authoritative external state before taking another action.

## 10. Model policy

Default V1 role policy:

| Phase | Graph | Model | Effort |
| --- | --- | --- | --- |
| Implementation | Open SWE `agent` | `fireworks:accounts/fireworks/models/glm-5p3` via private LiteLLM | `max` |
| Repair | same Open SWE `agent` thread | `fireworks:accounts/fireworks/models/glm-5p3` via private LiteLLM | `max` |
| Review | Open SWE `reviewer` | `openai:gpt-5.6-sol` | `medium` |
| Reviewer subagent | reviewer subagent | `openai:gpt-5.6-sol` | `medium` |

ForgeFlow sets Open SWE's existing per-run configurable model fields. It does not add another provider client or model router.

Fallback uses Open SWE's existing model-fallback middleware. The current deployment keeps fallback inside the available OpenAI/Codex path rather than silently requiring Anthropic credentials.

## 11. Evidence-owned completion

The defining ForgeFlow invariant is:

```text
child_run.status == "success"
    DOES NOT IMPLY
engineering_work.status == "ready"
```

### Implementation evidence gate

After an implementation/repair run becomes terminal, ForgeFlow requires all relevant evidence:

1. the intended Open SWE thread still exists;
2. a tracked PR exists for the thread/objective;
3. the PR is open;
4. the PR head SHA is a valid non-empty SHA;
5. for initial implementation, the head differs from the base where a code change is expected;
6. for repair, the head differs from the previously reviewed/rejected head;
7. the PR head and tracked branch metadata agree;
8. there is no evidence that a different unrelated PR replaced the target.

If a child run reports `success` but no required repository evidence changed, ForgeFlow classifies it as `NO_PROGRESS`, retries the same thread within budget, and never advances to review.

This directly catches the observed provider-quota false-positive failure mode.

## 12. CI gate

CI evidence is exact-head evidence.

Rules:

1. Read checks/statuses for the **current PR head SHA** only.
2. Pending checks keep the policy in `WAITING_FOR_CI`.
3. A new head SHA resets the CI gate.
4. Required failing checks produce a repair prompt on the same implementation thread.
5. No checks is **not** automatically success when the repository policy requires CI.
6. Repository policy may explicitly declare `ci_required=false` for repositories with no CI.
7. Optional required-check names may narrow the gate; otherwise the policy uses the repository's observed required check set / branch-protection-compatible interpretation.

V1 reuses Open SWE/GitHub helpers and does not create a second GitHub authentication stack.

## 13. Review gate

ForgeFlow uses Open SWE's **official reviewer graph** from the full deployment, not a normal coding agent with a review prompt.

The reviewer already provides:

- canonical reviewer thread per PR;
- exact base/head SHA config;
- read-only review sandbox;
- structured findings stored in reviewer thread metadata;
- finding lifecycle (`open`, `resolved`, `dismissed`);
- GitHub inline publication;
- re-review reconciliation.

ForgeFlow only interprets that durable reviewer state.

### Severity mapping

Open SWE -> ForgeFlow:

| Open SWE | ForgeFlow | Gate behavior |
| --- | --- | --- |
| `critical` | P0 | block |
| `high` | P1 | block |
| `medium` | P2 | block |
| `low` | P3 | allow by default |

A policy is ready only when:

```text
reviewed_head_sha == current_pr_head_sha
AND open(P0) == 0
AND open(P1) == 0
AND open(P2) == 0
AND exact-head CI passes
```

P3 remains visible but does not force another repair round unless repository policy opts in.

## 14. Repair contract

A repair is always dispatched to the **original implementation thread**.

Repair input contains bounded, deterministic context:

- exact rejected head SHA;
- current PR URL;
- blocking finding IDs;
- severity/title/file/line/description for open blocking findings;
- exact failing CI check summaries when applicable;
- instruction to preserve the existing branch/PR and push a new commit;
- instruction to run focused tests first, then the repository's wider gate.

The repair agent cannot approve its own work. Any new head must pass CI and official re-review again.

## 15. Retry and escalation policy

Defaults:

- transient child-run/provider retry: 2 attempts for the same stage/context;
- no-progress retry: 2 attempts;
- total code repair rounds: 5;
- reviewer execution retry: 2 attempts when the reviewer run itself fails without producing a valid exact-head result.

`repair_round` increments only when code is asked to change because of CI or review evidence. Infrastructure retries do not consume a code-quality round.

Escalate when:

- the same head repeatedly produces no progress;
- GitHub/PR identity cannot be proven;
- child run success has no required evidence after retry budget;
- official review cannot be established on the exact head;
- CI state cannot be resolved safely;
- repair budget is exhausted;
- user/operator intervention is explicitly required.

Escalation preserves the Open SWE threads/PR as evidence; it does not mutate them into a fake success state.

## 16. Cancellation

Cancellation means:

1. mark ForgeFlow policy thread `CANCELLED`;
2. cancel a currently running child LangGraph run if one is active and cancellable;
3. remove/disable the policy reconciliation cron;
4. stop dispatching new agent/reviewer runs.

ForgeFlow does not implement custom sandbox/worktree teardown. Open SWE owns those resources.

## 17. Protected contracts

Because compatibility is intentionally broken, only these contracts survive the reset:

1. **Repository identity:** the public `BakerSean168/forgeflow` project remains ForgeFlow.
2. **License:** MIT remains unless an upstream dependency requires additional notices.
3. **Quality philosophy:** model claims never outrank deterministic evidence.
4. **Independent review:** implementation and acceptance remain distinct roles.
5. **Exact-revision acceptance:** CI and review must apply to the exact current head.
6. **Bounded autonomy:** retries/repairs settle into monitored `READY` or terminal `ESCALATED`/`CANCELLED`; budgets prevent unbounded loops.
7. **No secret persistence in repo/policy state.**

Explicitly retired contracts:

- retired SQLite schema and all stored rows;
- retired `/api/v1/*` routes;
- retired OpenAPI file and generated TypeScript client;
- retired Plan/Execution/Review/Supervisor IDs;
- retired worktree/resource/provider/release APIs;
- retired deployment ports and systemd topology;
- retired database backup compatibility.

## 18. Current repository layout

```text
forgeflow/
  graph.py / state.py / policy.py / reconcile.py
  evidence.py / models.py / projects.py / preflight.py / deployment.py
  adapters/
    openswe.py
    github.py
  prompts/
    implementation.py
    repair.py

openswe_ext/
  graphs.py                  # narrow wrappers around pinned upstream graphs
  docker_sandbox.py          # self-hosted SandboxBackendProtocol provider
  docker_gc.py               # provider-owned idle sandbox GC
  github_auth.py             # short-lived installation-token bridge
  workflow_push_guard.py     # pinned-upstream compatibility guard

deploy/gcp-dev/
  start-forgeflow-policy.sh
  forgeflow-policy.service.in
  open-swe-codex-broker.service.in
  setup-docker-sandbox.sh
  forgeflow-openswe-sandbox-network.service.in
  forgeflow-openswe-sandbox-gc.{service,timer}.in
  run_policy_acceptance.py
  purge-legacy.sh            # historical cleanup guard, not an execution plane

docs/
tests/
langgraph.json
pyproject.toml
uv.lock
UPSTREAM_OPEN_SWE_SHA
```

No `src/`, legacy TypeScript control plane, generated client, custom worktree runtime, OpenHands
Agent Server integration, long-lived Antigravity worker, or ForgeFlow workflow database survives.
The later ACP experiment is a new bounded runtime extension, not a restored legacy execution plane.

## 19. Deployment shape

GCP Dev runs one loopback-only LangGraph/Open SWE/ForgeFlow control service and isolated per-thread
Docker execution sandboxes:

```text
systemd --user
  +-- open-swe-codex-broker.service
  +-- forgeflow-policy.service
        |
        v
      LangGraph API Server (127.0.0.1)
        +-- agent       -> openswe_ext wrapper -> Open SWE agent
        +-- reviewer    -> openswe_ext wrapper -> Open SWE official reviewer
        +-- analyzer    -> Open SWE
        +-- chat        -> Open SWE
        +-- scheduler      -> Open SWE
        +-- external_agent -> ForgeFlow selected external runtime child graph
        +-- forgeflow      -> ForgeFlow policy graph
        +-- agent.webapp -> Open SWE GitHub/webhook/dashboard API

Docker
  +-- openswe-sandbox bridge with private/link-local/Tailscale egress blocks
  +-- one persistent sandbox + workspace volume per Open SWE sandbox id

systemd timer
  +-- forgeflow-openswe-sandbox-gc.timer -> conservative idle sandbox cleanup
```

LangGraph local-dev persistence is anchored at `$FORGEFLOW_POLICY_STATE_DIR/langgraph`. The active
checkout exposes `.langgraph_api` only as a symlink to that stable directory, so changing the code
worktree does not create a second thread/run/checkpoint/store universe. The installer stops the
policy writer before migrating or relinking state and fails closed if two non-empty state trees
diverge.

The tested default is `SANDBOX_TYPE=docker`; model-controlled commands do not run via the upstream
`local` backend on the host principal. The desktop-only Open SWE configuration is not the
production acceptance path because the policy requires the official reviewer graph.

The systemd unit treats the server's normal SIGTERM exit (`143`) as successful shutdown. This keeps
planned deploy/restart operations from being recorded as service failures while retaining
`Restart=on-failure` for genuine abnormal exits.

## 20. Upstream-change containment

ForgeFlow has two bounded upstream-facing surfaces: policy orchestration imports are isolated behind `forgeflow/adapters/openswe.py`, while self-hosted runtime hooks live under `openswe_ext/`. Both are covered by upstream-contract/characterization tests.

Rules:

- no scattered `from agent...` imports throughout policy logic; upstream runtime imports belong only in the bounded adapter/extension surfaces;
- adapter tests assert the expected upstream signatures/metadata shape;
- an upstream bump that breaks the adapter fails before policy tests;
- policy types never subclass large upstream runtime classes;
- prefer Open SWE's LangGraph SDK/API surface over direct internal mutation.

This makes an upstream upgrade a bounded adapter change instead of a repository-wide migration.

## 21. Architecture fitness rules

CI must fail if ForgeFlow reintroduces forbidden ownership.

Static architecture checks forbid:

- `sqlite3`, `node:sqlite`, SQL schema files;
- custom Git worktree creation commands inside ForgeFlow package;
- custom provider SDK clients in policy code;
- OpenHands-specific execution adapters or a long-lived Antigravity execution plane; the optional Antigravity ACP bridge must remain execution-scoped and outside policy ownership;
- direct modification of Open SWE reviewer findings metadata outside the upstream reviewer APIs;
- a second FastAPI/Fastify control plane unless explicitly approved later.

Policy production code is expected to stay in the low-thousands of lines; crossing that range is an architectural-review trigger rather than a growth target.

## 22. Release/version semantics

The architectural generation is called **ForgeFlow Policy V1**.

The rebuilt package is versioned `2.0.0` because the public repository already has incompatible `v1.x` releases. The v2.0.0 release candidate communicates the intentional compatibility break while keeping the architecture name simple.

## 23. Acceptance definition

The v2 acceptance gate is defined by the following real-repository path, and PR #28 has completed it:

```text
objective
 -> Open SWE GLM 5.3 implementation (Luna fallback)
 -> real commit/push/PR
 -> exact-head CI
 -> official Open SWE Sol review
 -> blocking finding
 -> same-thread GLM 5.3 repair (Luna fallback)
 -> new exact head
 -> exact-head CI
 -> official re-review
 -> zero open P0/P1/P2
 -> READY
```

The acceptance must also inject a false-success case:

```text
child run reports success
+ no PR/head/evidence delta
=> ForgeFlow MUST NOT advance
=> retry or escalate
```

That path was completed with a controlled blocking finding and same-thread repair on PR #28. Subsequent candidate-only changes continue to pass the same exact-head CI/reviewer gate before `READY`.
