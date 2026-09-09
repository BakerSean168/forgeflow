# ForgeFlow Policy V1 — Open SWE Quality Governance Architecture

> Status: proposed north-star architecture for the destructive ForgeFlow rebuild.
> Decision: ForgeFlow no longer owns an autonomous coding runtime. ForgeFlow becomes a thin, deterministic software-engineering quality policy layered on Open SWE.
> Compatibility: intentionally none with the current Node/SQLite control plane, HTTP API, database schema, execution/worktree state, provider registry, or deployment units.

## 1. Executive decision

ForgeFlow Policy V1 is **not** a coding-agent runtime, worktree manager, provider router, durable workflow database, release controller, or second software factory.

It owns only one question:

> Given an engineering objective handled by Open SWE, is there enough independent, exact-revision evidence to declare the work ready, or must it be repaired/retried/escalated?

The new ownership boundary is:

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

The existing ForgeFlow implementation currently owns the entire lifecycle itself:

- ~37.6k lines under `src/`;
- ~25.0k lines under `test/`;
- ~19.3k lines in `src/core/` alone;
- ~7.5k lines of custom persistence;
- ~7.1k lines of custom orchestration;
- ~11.5k lines of external integrations;
- a custom SQLite schema for plans, graph versions, executions, reviews, supervisor state, leases, resource state, runtime admission, project queues, worktrees, delivery, maintenance, and release evidence;
- custom OpenHands, Antigravity, worktree ACL/provenance, resource routing, recovery, release and self-promotion infrastructure.

The deployed old runtime currently also owns ~3.0 GB under `/var/lib/forgeflow`, including ~2.5 GB of old OpenHands/tooling state and hundreds of MB of historical SQLite backups.

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

ForgeFlow Policy V1 will not implement:

- its own SQLite/PostgreSQL workflow database;
- schema migrations from the current ForgeFlow DB;
- old `/api/v1/*` compatibility;
- old generated `@forgeflow/client` compatibility;
- custom Plan/WorkItem/Execution/Review entities mirroring Open SWE;
- custom worktree creation or ACL management;
- OpenHands Agent Server integration;
- Antigravity worker integration;
- LiteLLM resource directory / runtime admission / provider health routing;
- custom execution leases;
- custom event store;
- custom Supervisor model;
- custom release/self-promotion engine;
- autonomous self-improvement in the first release;
- automatic merge in the first release;
- compatibility adapters for old ForgeFlow state.

If implementation begins recreating any of these, the architecture has drifted and must stop for review.

## 5. Integration strategy

### Decision: overlay package, not a heavy fork

ForgeFlow becomes a small Python package deployed in the **same LangGraph server** as a pinned Open SWE dependency.

Conceptual dependency:

```toml
open-swe-agent = { git = "https://github.com/langchain-ai/open-swe.git", rev = "<PINNED_SHA>" }
```

ForgeFlow's `langgraph.json` exposes both upstream graphs and the policy graph:

```json
{
  "graphs": {
    "agent": "agent.graphs.agent:traced_agent",
    "reviewer": "agent.graphs.reviewer:traced_reviewer_agent",
    "analyzer": "agent.graphs.analyzer:traced_analyzer",
    "chat": "agent.graphs.chat:traced_chat_agent",
    "scheduler": "agent.graphs.scheduler:get_scheduler",
    "forgeflow": "forgeflow.graph:get_policy_graph"
  },
  "http": {
    "app": "agent.webapp:app"
  }
}
```

This keeps upstream Open SWE code unmodified by default. A ForgeFlow change should live under `forgeflow/`, not under `agent/`.

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
5. The initial rebuild will freeze the Open SWE revision selected at implementation start, then run the real Thin-Policy acceptance scenario before promotion.

There is no compatibility promise across arbitrary Open SWE revisions.

## 7. Policy state

ForgeFlow state is intentionally a **reference ledger**, not a second execution database.

Proposed shape:

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

    # bounded policy counters
    run_retry_count: int
    repair_round: int

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
 |  exact head checks terminal + accepted
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
 | same implementation thread |
 | exact findings + exact SHA  |
 +------------> VERIFYING <----+
```

Any new push invalidates prior CI and review evidence because the head SHA changed.

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

An active policy thread is re-invoked by a LangGraph cron/wakeup until terminal.

This keeps crash recovery simple: the next reconciliation re-observes authoritative external state before taking another action.

## 10. Model policy

Default V1 role policy:

| Phase | Graph | Model | Effort |
| --- | --- | --- | --- |
| Implementation | Open SWE `agent` | `openai:gpt-5.6-luna` | `xhigh` |
| Repair | same Open SWE `agent` thread | `openai:gpt-5.6-luna` | `xhigh` |
| Review | Open SWE `reviewer` | `openai:gpt-5.6-sol` | `medium` |
| Reviewer subagent | reviewer subagent | `openai:gpt-5.6-sol` | `medium` |

ForgeFlow sets Open SWE's existing per-run configurable model fields. It does not add another provider client or model router.

Fallback should use Open SWE's existing model-fallback middleware. For the initial deployment, the environment fallback must stay inside the available OpenAI/Codex path rather than silently requiring Anthropic credentials.

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

V1 should reuse Open SWE/GitHub helpers where possible and must not create a second GitHub authentication stack.

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
6. **Bounded autonomy:** retries/repairs terminate in `READY`, `ESCALATED`, or `CANCELLED`.
7. **No secret persistence in repo/policy state.**

Explicitly retired contracts:

- current SQLite schema and all stored rows;
- current `/api/v1/*` routes;
- current OpenAPI file and generated TypeScript client;
- current Plan/Execution/Review/Supervisor IDs;
- current worktree/resource/provider/release APIs;
- current deployment ports and systemd topology;
- current database backup compatibility.

## 18. Target repository layout

```text
forgeflow/
  forgeflow/
    __init__.py
    graph.py                 # LangGraph policy graph
    state.py                 # minimal typed checkpoint state
    policy.py                # deterministic transition/gate rules
    models.py                # role/model defaults only
    evidence.py              # normalized evidence decisions
    adapters/
      openswe.py             # narrow Open SWE thread/run/reviewer adapter
      github.py              # thin wrapper around upstream GitHub evidence helpers
    prompts/
      repair.py              # bounded repair prompt builder

  tests/
    test_policy.py
    test_evidence.py
    test_false_success.py
    test_ci_gate.py
    test_review_gate.py
    test_repair_loop.py
    test_upstream_contract.py

  docs/
    architecture.md
    deployment.md
    upstream.md
    development.md

  langgraph.json
  pyproject.toml
  uv.lock
  .env.example
  README.md
  LICENSE
  CREDITS.md
  THIRD_PARTY_NOTICES.md
```

No `src/core/persistence`, `reconcilers`, provider registry, generated client, or custom worktree runtime survives.

## 19. Deployment shape

ForgeFlow Policy V1 runs as one Open SWE/LangGraph deployment:

```text
systemd / container
      |
      v
LangGraph API Server
  +-- agent          (Open SWE)
  +-- reviewer       (Open SWE)
  +-- analyzer       (Open SWE)
  +-- chat           (Open SWE)
  +-- scheduler      (Open SWE)
  +-- forgeflow      (thin policy)
  |
  +-- agent.webapp   (Open SWE GitHub/webhook/dashboard API)
```

The desktop-only configuration is not the production acceptance target because it exposes only the `agent` graph. ForgeFlow acceptance must use the full `langgraph.json` path where the official reviewer exists.

## 20. Upstream-change containment

Because ForgeFlow will consume some Open SWE internal Python contracts, all such imports must be isolated behind `forgeflow/adapters/openswe.py`.

Rules:

- no scattered `from agent...` imports throughout policy logic;
- adapter tests assert the expected upstream signatures/metadata shape;
- an upstream bump that breaks the adapter fails before policy tests;
- policy types never subclass large upstream runtime classes;
- prefer Open SWE's LangGraph SDK/API surface over direct internal mutation.

This makes an upstream upgrade a bounded adapter change instead of a repository-wide migration.

## 21. Architecture fitness rules

CI must fail if ForgeFlow reintroduces forbidden ownership.

Add static architecture checks forbidding:

- `sqlite3`, `node:sqlite`, SQL schema files;
- custom Git worktree creation commands inside ForgeFlow package;
- custom provider SDK clients in policy code;
- OpenHands/Antigravity-specific execution adapters;
- direct modification of Open SWE reviewer findings metadata outside the upstream reviewer APIs;
- a second FastAPI/Fastify control plane unless explicitly approved later.

A rough size budget should also be tracked. Policy production code should stay in the low-thousands of lines; crossing that is an architectural review trigger, not a target.

## 22. Release/version semantics

The architectural generation is called **ForgeFlow Policy V1**.

Because the public repository already has incompatible `v1.x` releases, the first release of the rebuilt implementation should use the next major SemVer (`v2.0.0`) rather than reusing an existing tag. This communicates the intentional compatibility break while keeping the product architecture name simple.

## 23. Acceptance definition

ForgeFlow Policy V1 is complete only after a real repository scenario proves:

```text
objective
 -> Open SWE Luna implementation
 -> real commit/push/PR
 -> exact-head CI
 -> official Open SWE Sol review
 -> blocking finding
 -> same-thread Luna repair
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

That is the minimum credible proof that ForgeFlow still adds value on top of Open SWE.
