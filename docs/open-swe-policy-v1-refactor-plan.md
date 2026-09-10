# ForgeFlow Policy V1 — Destructive Refactor Implementation Plan


## Authoritative destructive cutover order

This section is the authoritative cutover contract and overrides any earlier shorthand that could be read as deleting the legacy runtime first. ForgeFlow Policy V1 has **no migration compatibility path**, but destructive deletion still occurs only after the replacement proves it is healthy.

1. Build and validate the exact candidate checkout.
2. Install/start `open-swe-codex-broker.service` and `forgeflow-policy.service` side-by-side with the legacy runtime.
3. Authenticate to the replacement and require `/ok`, all six graph ids (`agent`, `reviewer`, `analyzer`, `chat`, `scheduler`, `forgeflow`), the expected systemd fragment/ExecStart identity, and a successful authenticated broker token probe.
4. Only after that proof, stop every known legacy ForgeFlow/OpenHands/Antigravity unit and verify each is inactive. Stop failure is a hard blocker.
5. Only after quiescence proof, remove legacy container/image, `/var/lib/forgeflow`, old unit/drop-in files, exact known libexec helpers, the legacy AppArmor profile, and the old OpenHands literal-worktree override. Preserve independently owned `/etc/forgeflow/litellm.env`.
6. Re-run replacement health after cleanup. There is no legacy database/schema migration or compatibility adapter.

The implementation of this contract lives in `deploy/gcp-dev/purge-legacy.sh`; the script refuses destructive work unless the replacement preflight passes.

> Scope: execution-ready plan for replacing the current Node/SQLite autonomous coding control plane with a thin Open SWE quality-policy graph.
> Mode: destructive rebuild. No database migration, API compatibility layer, historical execution import, or old-runtime coexistence is required.

## 1. Outcome

At the end of this refactor:

- ForgeFlow contains no autonomous coding runtime of its own;
- Open SWE owns agent execution, reviewer execution, sandbox/workspace lifecycle, Git/PR behavior and child-run persistence;
- LangGraph owns policy checkpoint/recovery;
- GitHub owns exact revision and CI evidence;
- ForgeFlow owns only deterministic quality decisions and bounded repair/retry policy;
- the old SQLite state and 3 GB `/var/lib/forgeflow` runtime data are deleted;
- the old Node/Fastify/OpenHands/Antigravity control plane and six old ForgeFlow systemd units are removed;
- a real end-to-end Thin-Policy acceptance run reaches `READY` only after exact-head CI and official Open SWE re-review have no open P0/P1/P2;
- a deliberately simulated false-success child run is rejected.

## 2. Current baseline and destructive assumptions

### Repository baseline

Current main/origin main at planning time:

`6c29586 fix(plans): audit finalization scope corrections (#26)`

The working repository has unrelated uncommitted WIP on `fix/active-finalization-correction`:

- 7 modified files;
- ~582 insertions / 13 deletions;
- all changes belong to the old Plan/worktree/finalization runtime.

**Decision:** do not port this WIP. It is obsolete under the new ownership model. Preserve it only in Git/worktree history until the destructive implementation branch starts, then discard it rather than adapting it.

### Old deployed state

Observed at planning time:

- `forgeflow.service`: active + enabled;
- `/var/lib/forgeflow`: ~3.0 GB;
- old SQLite DB: ~19 MB plus WAL/SHM;
- old DB backups: ~378 MB;
- old OpenHands/tooling state: ~2.5 GB;
- old workspace state: ~110 MB;
- six old ForgeFlow systemd unit files are installed/enabled/static.

**Decision:** none of this runtime state is migrated.

### Compatibility assumption

The following may break and be deleted without adapters:

- current database schema/data;
- old plan/execution/review IDs;
- old HTTP API;
- old OpenAPI contract;
- generated TypeScript client;
- old provider/resource configuration;
- old worktree provenance;
- old release/self-promotion state;
- old backup files.

Credentials/secrets are not treated as application data. Required GitHub/OpenAI/LangGraph credentials may be reconfigured for the new deployment, but no secret values are copied into the repository.

## 3. Target dependency boundary

### New stack

- Python 3.14 to match current Open SWE deployment contract;
- `uv` + `pyproject.toml`;
- pinned `open-swe-agent` Git revision;
- LangGraph API Server;
- Open SWE `agent`, `reviewer`, `analyzer`, `chat`, `scheduler` graphs;
- ForgeFlow `forgeflow` policy graph;
- Open SWE `agent.webapp:app` for GitHub/webhook/dashboard API;
- official Open SWE GitHub App path for reviewer automation.

### Removed stack

- Node.js production runtime;
- Fastify control plane;
- SQLite ForgeFlow workflow DB;
- custom event store/repositories;
- custom OpenHands Agent Server deployment;
- custom Antigravity execution units;
- custom LiteLLM routing/resource admission;
- custom project queue/lease/worktree state;
- custom release/self-promotion runtime.

## 4. Deletion map

### Delete wholesale

```text
src/api/
src/application/
src/bootstrap/
src/core/
src/integrations/
src/platform/
src/reconcilers/
src/app.ts
src/main.ts
src/processLifecycle.ts

test/
api/
packages/client/
openhands_tools/

deploy/openhands/
deploy/gcp/forgeflow-antigravity@.service
deploy/gcp/forgeflow-host-cache.service
deploy/gcp/forgeflow-host-cache.timer
deploy/gcp/forgeflow-self-promote.path
deploy/gcp/forgeflow-self-promote.service

scripts/* old Node/OpenHands/Antigravity/release/API generation scripts

package.json
package-lock.json
tsconfig.json
```

### Replace, do not migrate

```text
README.md
docs/architecture.md
docs/configuration.md
docs/development.md
docs/extensibility.md
docs/getting-started.md
deploy/gcp/forgeflow.service
deploy/gcp/install.sh
deploy/forgeflow.env.example
```

### Keep/rewrite attribution and project metadata

```text
LICENSE
CONTRIBUTING.md
SECURITY.md
CREDITS.md
THIRD_PARTY_NOTICES.md
.github/
```

These files should be reviewed rather than blindly retained because the runtime/dependency story changes from OpenHands to Open SWE/LangChain/Deep Agents/LangGraph.

## 5. Target source layout

```text
forgeflow/
  forgeflow/
    __init__.py
    graph.py
    state.py
    policy.py
    evidence.py
    models.py
    adapters/
      openswe.py
      github.py
    prompts/
      repair.py

  tests/
    test_upstream_contract.py
    test_policy.py
    test_evidence.py
    test_false_success.py
    test_ci_gate.py
    test_review_gate.py
    test_repair_loop.py

  docs/
    architecture.md
    upstream.md
    deployment.md
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

## 6. State-transition contract

```text
NEW
  -> IMPLEMENTING
  -> VERIFYING
  -> WAITING_FOR_CI
  -> REVIEWING
  -> READY

VERIFYING
  -> IMPLEMENTING      transient/no-progress retry
  -> ESCALATED         proof unavailable / retry exhausted

WAITING_FOR_CI
  -> REPAIRING         failing checks
  -> REVIEWING         exact-head checks pass
  -> ESCALATED         unresolved unsafe CI state

REVIEWING
  -> REPAIRING         open P0/P1/P2
  -> READY             exact-head review + no P0/P1/P2
  -> ESCALATED         reviewer cannot produce trustworthy result

REPAIRING
  -> VERIFYING         new child run dispatched
  -> ESCALATED         repair budget exhausted

any non-terminal
  -> CANCELLED         operator/user stop
```

Every transition is deterministic and unit-testable without a model.

## 7. Policy invariants

### INV-01 — Run success is evidence, never completion

A child run with `status=success` cannot advance unless repository evidence satisfies the current stage.

### INV-02 — Exact-head consistency

At `READY`:

```text
PR.head_sha == CI.head_sha == reviewer.last_reviewed_sha
```

### INV-03 — Independent reviewer

Builder/repair agent state cannot directly mark review as passed. Only the official reviewer thread state counts.

### INV-04 — New commits invalidate old evidence

When PR head changes:

- CI pass for old head is stale;
- review pass/findings for old head are stale;
- policy returns to CI/review for the new head.

### INV-05 — No blocking findings at READY

Map Open SWE severities:

- critical -> P0;
- high -> P1;
- medium -> P2;
- low -> P3.

`READY` requires zero **open** P0/P1/P2 on the current exact head.

### INV-06 — Same implementation thread for repair

Review/CI repairs return to the original implementation thread unless that thread is irrecoverably unavailable and the policy explicitly escalates.

### INV-07 — Bounded autonomy

No infinite loops. Default budgets:

- transient run retry: 2;
- no-progress retry: 2;
- reviewer execution retry: 2;
- total code repair rounds: 5.

### INV-08 — No duplicated runtime ownership

ForgeFlow does not create custom worktrees, DB rows, provider sessions, resource leases, or reviewer stores.

## 8. Phase plan

### Phase 0 — Freeze evidence and establish the new baseline

**Objective:** guarantee the destructive rewrite starts from known source and upstream contracts.

**Steps:**

1. Record current ForgeFlow main SHA and current dirty WIP inventory.
2. Do not merge/port `fix/active-finalization-correction` old-runtime WIP.
3. Freeze an exact Open SWE upstream SHA for implementation.
4. Add a machine-readable `UPSTREAM_OPEN_SWE_SHA`/dependency pin.
5. Write an upstream contract test that imports:
   - upstream `agent` graph;
   - reviewer graph;
   - scheduler graph;
   - `RunConfig` model override fields;
   - `dispatch_agent_run` or chosen SDK boundary;
   - reviewer findings read helper;
   - GitHub PR/check helper boundary.
6. Fail the phase if any required current Open SWE contract is unavailable.

**Acceptance:**

- exact ForgeFlow source baseline recorded;
- exact Open SWE SHA pinned;
- upstream conformance test green;
- no production/runtime files changed yet beyond planning/pinning scaffold.

### Phase 1 — Destructive repository reset

**Objective:** remove duplicate runtime ownership before adding the new policy.

**Steps:**

1. Create the destructive implementation branch from the plan/main baseline.
2. Remove all old Node control-plane source directories listed in the deletion map.
3. Remove old tests coupled to Plan/Execution/Review/Supervisor/SQLite/worktrees/providers.
4. Remove generated OpenAPI/client assets.
5. Remove custom OpenHands/Antigravity deployment/runtime tooling.
6. Remove Node manifests and TypeScript config.
7. Introduce minimal Python package/uv skeleton.
8. Keep repository build green with a placeholder `forgeflow` graph before continuing.
9. Add an architecture boundary test that rejects forbidden old ownership patterns.

**Acceptance:**

- no production TypeScript runtime remains;
- no SQL schema or ForgeFlow DB package remains;
- no custom worktree/provider/OpenHands/Antigravity runtime remains;
- Python package imports;
- `uv run pytest` passes minimal scaffold tests;
- diff is intentionally large but mechanically clean.

### Phase 2 — Open SWE overlay foundation

**Objective:** run upstream Open SWE and ForgeFlow in one LangGraph deployment without forking upstream runtime code.

**Steps:**

1. Add pinned `open-swe-agent` dependency.
2. Add `langgraph.json` exposing upstream graphs plus `forgeflow`.
3. Reuse `agent.webapp:app` as HTTP/webhook application.
4. Add `forgeflow/adapters/openswe.py` as the **only** normal import boundary into upstream internals.
5. Add `forgeflow/adapters/github.py` that reuses upstream GitHub token/evidence helpers rather than creating a second auth implementation.
6. Add local test configuration with fake LangGraph/Open SWE clients.
7. Add a startup smoke proving all six graphs resolve.

**Acceptance:**

- one LangGraph process exposes `agent`, `reviewer`, `analyzer`, `chat`, `scheduler`, `forgeflow`;
- upstream webapp imports successfully;
- no source file under upstream `agent/` is modified;
- adapter contract tests pass.

### Phase 3 — Minimal policy state and transition kernel

**Objective:** encode quality governance without side effects first.

**Steps:**

1. Define typed `ForgeFlowState`.
2. Define terminal and non-terminal statuses.
3. Implement pure transition functions.
4. Implement repair/retry budget accounting.
5. Implement severity mapping.
6. Implement exact-head invalidation rules.
7. Implement cancellation transition.
8. Unit-test the full state table, including impossible transitions.

**Acceptance:**

- transition tests contain no network/model calls;
- every status has explicit allowed successors;
- `READY` cannot be synthesized without an evidence decision object;
- repair/retry counters cannot exceed bounds without escalation.

### Phase 4 — Implementation dispatch and false-success verifier

**Objective:** prove ForgeFlow can launch Open SWE implementation and refuse a fake successful run.

**Steps:**

1. Create/reuse one Open SWE implementation thread per ForgeFlow objective.
2. Dispatch implementation using:
   - `agent_model_id=openai:gpt-5.6-luna`;
   - `agent_effort=xhigh`;
   - draft PR behavior enabled.
3. Persist only child thread/run IDs in ForgeFlow state.
4. Observe child run terminal status through LangGraph SDK.
5. Read tracked PR metadata from the child thread.
6. Fetch authoritative PR head from GitHub.
7. Implement `NO_PROGRESS` when a terminal-success child run has no required PR/head delta.
8. Retry same thread within budget.
9. Add fake-client regression test reproducing the observed `429 -> run success -> no code` semantic failure.

**Acceptance:**

- normal success + PR/head delta advances;
- `success` + no PR/head delta does not advance;
- failed/transient run does not create a new implementation thread;
- retry exhaustion escalates.

### Phase 5 — Exact-head CI gate

**Objective:** make deterministic CI the first external quality gate.

**Steps:**

1. Read current PR head SHA.
2. Fetch check runs/statuses using the upstream GitHub authentication path.
3. Normalize to `PENDING`, `PASS`, `FAIL`, `UNRESOLVED`.
4. Make `PASS` exact-head-specific.
5. Configure `ci_required` and optional required check names per repository policy.
6. Treat required-CI + zero observed checks as pending/unresolved, never success.
7. On failing checks, dispatch a bounded repair message to the same implementation thread.
8. A new pushed head resets the CI decision.

**Acceptance:**

- old-head green CI never passes a new head;
- failing CI causes repair, not reviewer dispatch;
- pending CI performs no duplicate repair side effect;
- missing required CI cannot produce `READY`.

### Phase 6 — Official Reviewer integration

**Objective:** replace the bakeoff's manually orchestrated Sol review with the native Open SWE reviewer graph.

**Steps:**

1. Require full Open SWE deployment (`langgraph.json`), not desktop-only graph config.
2. Trigger canonical review for the current PR through upstream reviewer dispatch.
3. Force reviewer model config:
   - `reviewer_model_id=openai:gpt-5.6-sol`;
   - `reviewer_reasoning_effort=medium`;
   - reviewer subagent = Sol medium.
4. Persist reviewer thread/run IDs only.
5. Observe reviewer completion.
6. Read reviewer thread metadata/findings through upstream finding readers.
7. Require `last_reviewed_sha == current PR head`.
8. Map severities to P0/P1/P2/P3.
9. Produce a normalized `ReviewDecision`.

**Acceptance:**

- review always occurs on the current exact head;
- reviewer failure/retry is bounded;
- stale review cannot pass after a new push;
- implementation agent cannot directly set review success.

### Phase 7 — Review-to-repair loop

**Objective:** automate exactly the loop that was manually proven in the Digital Biome bakeoff.

**Steps:**

1. If open P0/P1/P2 exist, build a deterministic repair prompt from official reviewer findings.
2. Include finding IDs, severity, file/line, description, current rejected SHA and PR URL.
3. Dispatch to the original implementation thread.
4. Increment `repair_round` once per requested code-repair pass.
5. Wait for a new PR head.
6. Re-run exact-head CI.
7. Trigger official re-review.
8. Reconcile resolved/dismissed/open findings from reviewer state.
9. Repeat until no current-head P0/P1/P2 or repair budget exhausts.

**Acceptance:**

- one blocking review finding causes one bounded repair dispatch;
- repair must produce a new exact head;
- old review/CI evidence is invalidated;
- resolved findings do not remain blockers;
- new findings can block later rounds;
- fifth repair round is allowed by default; the next required round escalates.

### Phase 8 — Reconciler scheduling and restart recovery

**Objective:** make the policy autonomous without implementing another scheduler/runtime.

**Steps:**

1. Create one LangGraph policy thread per ForgeFlow objective.
2. Make every invocation idempotently reconcile current state and external evidence.
3. Schedule active policy threads through LangGraph cron/wakeup primitives.
4. Ensure a reconciliation performs at most one externally visible dispatch/mutation.
5. Disable/delete the wake/cron when terminal.
6. Add restart test: process stops after side effect but before next policy state write, then replay re-observes external state and does not duplicate the side effect.
7. Add cancellation test.

**Acceptance:**

- service restart does not lose the objective;
- no duplicate PR/reviewer/repair dispatch after replay;
- terminal policy has no live reconcile schedule;
- no custom lease or heartbeat table exists.

### Phase 9 — Deployment replacement and state purge

**Objective:** remove the old production topology and deploy the full Open SWE + ForgeFlow policy runtime.

**Destructive cutover sequence:**

1. Stop and disable:
   - `forgeflow.service`;
   - `forgeflow-host-cache.timer`;
   - `forgeflow-self-promote.path`.
2. Stop any matching live `forgeflow-antigravity@*` units.
3. Remove old systemd unit/drop-in files after verifying they are stopped.
4. Remove old OpenHands Docker compose containers/images created only for ForgeFlow where safe.
5. Delete `/var/lib/forgeflow` old application state, including:
   - SQLite DB/WAL/SHM;
   - backups;
   - old OpenHands tooling;
   - old workspaces;
   - Antigravity state;
   - release/self-promotion files.
6. Remove obsolete `/usr/local/libexec/forgeflow-*` helpers.
7. Recreate only the minimal new deployment state directories required by LangGraph/Open SWE.
8. Install the new Python/uv deployment.
9. Configure Open SWE GitHub App/webhook credentials and OpenAI/Codex path.
10. Configure fallback to an available OpenAI model path rather than an unavailable cross-provider default.
11. Start one LangGraph/Open SWE/ForgeFlow deployment.
12. Verify all six graph IDs and webhook health.

**No database backup is required for rollback.** Rollback is source/deployment rollback only, not old-state restoration.

**Acceptance:**

- old Node `forgeflow.service` is gone;
- no old ForgeFlow SQLite file exists;
- no old custom OpenHands/Antigravity runtime is active;
- old `/var/lib/forgeflow` multi-GB state is reclaimed;
- full Open SWE reviewer graph is available;
- ForgeFlow policy graph is available in the same deployment.

### Phase 10 — Real Thin-Policy acceptance

**Objective:** prove the new architecture in a real repository rather than unit tests only.

Use one substantial but bounded real project task with numeric/behavioral acceptance criteria.

Required path:

```text
ForgeFlow objective
 -> Luna implementation
 -> real branch/commit/push/Draft PR
 -> exact-head CI PASS
 -> official Sol reviewer
 -> at least one intentionally present or naturally discovered blocking finding
 -> same-thread Luna repair
 -> new head
 -> exact-head CI PASS
 -> official Sol re-review
 -> zero open P0/P1/P2
 -> ForgeFlow READY
```

Also execute a controlled false-success scenario with a fake/test child-run adapter:

```text
run status = success
PR/head delta = none
=> policy remains non-ready
=> retries/escalates according to budget
```

**Acceptance evidence must include:**

- ForgeFlow policy thread ID;
- implementation thread ID;
- reviewer thread ID;
- initial and final PR head SHAs;
- exact CI run/status evidence for final head;
- blocking finding IDs and closure state;
- repair round count;
- final `READY` state;
- no P0/P1/P2 open on final head;
- clean/no-duplicate dispatch evidence.

### Phase 11 — Documentation/release

**Objective:** make the new identity obvious to users and contributors.

**Steps:**

1. Rewrite README around “Open SWE quality policy”, not “autonomous coding runtime”.
2. Document ownership boundaries explicitly.
3. Credit Open SWE, LangChain, Deep Agents and LangGraph.
4. Update third-party notices from the old OpenHands-centric stack.
5. Delete obsolete old architecture/refactor docs or move them to Git history only; do not keep contradictory active docs.
6. Document upstream pin/update procedure.
7. Document deployment and GitHub App setup.
8. Document policy states and failure/escalation semantics.
9. Release as next major SemVer (`v2.0.0`) while calling the architecture “ForgeFlow Policy V1”.

**Acceptance:**

A new reader should not be able to mistake ForgeFlow for an independent coding runtime or Open SWE competitor.

## 9. Execution-ready tickets

### FFP-001 — Freeze Open SWE upstream contract

**Goal:** pin one exact Open SWE revision and prove every upstream contract ForgeFlow will consume exists.
**Scope:** `pyproject.toml`, `uv.lock`, `tests/test_upstream_contract.py`, `docs/upstream.md`.
**Out of scope:** policy behavior.
**Acceptance:** all required imports/config fields/graph IDs pass against the exact pin.
**Dependencies:** none.
**Risk:** Open SWE internals move quickly; containment is the single adapter boundary.

### FFP-002 — Remove legacy ForgeFlow runtime

**Goal:** delete duplicate lifecycle/runtime ownership.
**Scope:** old TypeScript source/tests/API/client/OpenHands/Antigravity/runtime scripts.
**Out of scope:** new behavior.
**Acceptance:** no Node production runtime, SQL schema, custom provider/worktree runtime remains.
**Dependencies:** FFP-001.
**Risk:** accidentally retaining a compatibility shim recreates the old architecture.

### FFP-003 — Establish Python/LangGraph overlay

**Goal:** expose upstream Open SWE graphs and one empty ForgeFlow graph in one deployment.
**Scope:** Python package, `langgraph.json`, upstream dependency, adapter skeleton.
**Acceptance:** all graphs resolve; no upstream source patch.
**Dependencies:** FFP-001, FFP-002.

### FFP-004 — Implement pure policy state machine

**Goal:** deterministic transition model with bounded retry/repair semantics.
**Scope:** `state.py`, `policy.py` and tests.
**Acceptance:** full transition table green; illegal READY construction impossible through public policy functions.
**Dependencies:** FFP-003.

### FFP-005 — Implement Open SWE child-run adapter

**Goal:** create/observe/reuse implementation threads and runs using upstream APIs.
**Scope:** `adapters/openswe.py`.
**Acceptance:** same-thread retry works; model overrides are passed correctly.
**Dependencies:** FFP-003.

### FFP-006 — Implement repository evidence verifier

**Goal:** validate PR/head progress independently of child run status.
**Scope:** `evidence.py`, GitHub adapter, false-success tests.
**Acceptance:** fake-success/no-progress cannot advance.
**Dependencies:** FFP-004, FFP-005.

### FFP-007 — Implement exact-head CI gate

**Goal:** normalize current-head checks and dispatch bounded repair on deterministic failure.
**Acceptance:** stale-head CI cannot pass; missing required CI cannot pass.
**Dependencies:** FFP-006.

### FFP-008 — Integrate official Open SWE reviewer

**Goal:** launch/observe official reviewer and normalize findings.
**Acceptance:** current-head reviewer state maps to P0/P1/P2/P3 and stale review cannot pass.
**Dependencies:** FFP-003, FFP-006.

### FFP-009 — Implement review/repair/re-review policy

**Goal:** convert blocking findings into same-thread repair and close only on fresh exact-head evidence.
**Acceptance:** deterministic test closes a multi-round finding lifecycle without duplicate dispatch.
**Dependencies:** FFP-007, FFP-008.

### FFP-010 — Add durable reconcile scheduling

**Goal:** autonomous progression/restart recovery using LangGraph primitives only.
**Acceptance:** crash/replay test produces no duplicate external mutation; terminal schedule is removed.
**Dependencies:** FFP-009.

### FFP-011 — Replace production deployment and purge legacy state

**Goal:** remove old services/data and deploy full Open SWE + ForgeFlow graph.
**Acceptance:** no old DB/units/runtimes active; six graphs healthy.
**Dependencies:** FFP-010.

### FFP-012 — Real repository acceptance

**Goal:** prove one real implementation→review→repair→re-review→READY path plus false-success rejection.
**Acceptance:** exact evidence ledger complete; P0/P1/P2 zero on final head.
**Dependencies:** FFP-011.

### FFP-013 — Rewrite public project surface

**Goal:** README/docs/credits/release communicate the new product boundary.
**Acceptance:** no active documentation describes ForgeFlow as owning an autonomous coding runtime.
**Dependencies:** FFP-012.

## 10. Verification matrix

| Invariant | Unit | Integration | Real acceptance |
| --- | --- | --- | --- |
| success != completion | fake run adapter | child-run metadata | controlled false-success |
| exact PR head | pure evidence tests | GitHub fake/client | real PR |
| exact-head CI | state fixtures | GitHub check adapter | real Actions run |
| independent review | policy transition | reviewer thread fixture | official reviewer graph |
| P0/P1/P2 gate | finding fixtures | reviewer metadata | real finding closure |
| same-thread repair | dispatch mock | child thread/run | real repair |
| no stale evidence | SHA-change tests | PR head update | real push/re-review |
| bounded autonomy | counter tests | retry simulation | forced failure case |
| restart idempotency | graph checkpoint test | replayed fake side effect | restart smoke |
| no duplicate runtime | architecture check | package import boundary | deployment inventory |

## 11. CI commands for the rebuilt repository

Target commands:

```bash
uv sync --extra dev
uv run ruff check .
uv run ruff format --check .
uv run ty check
uv run pytest -q
uv run python -m forgeflow.check_architecture
```

Add a graph-load smoke against the pinned upstream dependency.

Real provider/GitHub acceptance remains a separate command/job because it consumes external resources:

```bash
uv run python -m forgeflow.acceptance.real_policy_loop
```

The exact command name can be finalized during implementation, but the split between deterministic CI and real external acceptance is mandatory.

## 12. Review protocol during implementation

Each implementation phase must be independently reviewed.

### Review priorities

1. P0: secret exposure, wrong-repo mutation, stale-head acceptance, unsafe duplicate dispatch.
2. P1: ForgeFlow recreates runtime ownership, success can bypass evidence, builder can self-approve, unbounded loop.
3. P2: weak retry semantics, incomplete edge tests, upstream coupling outside adapter, unclear observability.
4. P3: naming/docs/polish.

### Repair rule

No phase is closed by a green build alone. A finding is closed only by:

- focused regression test;
- relevant wider test suite;
- re-review of adjacent state transitions;
- clean diff.

## 13. Explicit rollback strategy

There is intentionally **no old application-state rollback**.

Rollback choices are source/deployment only:

1. revert the new deployment revision;
2. redeploy a known-good new-policy revision;
3. re-run an objective from GitHub/Open SWE source truth.

Do not restore the old ForgeFlow SQLite DB or attempt to resume old Plans/Executions after cutover.

Git history remains the archival record of the old implementation.

## 14. Risks and containment

### Risk: upstream internal API churn

Containment: exact SHA pin + one adapter module + contract test + isolated upgrade PRs.

### Risk: Open SWE full deployment/GitHub App is heavier than local desktop mode

Containment: Phase 6/9 explicitly validates the full reviewer path before product acceptance.

### Risk: LangGraph run status can be semantically misleading

Containment: evidence-owned completion; run status never directly promotes to READY.

### Risk: policy graph quietly grows into a second runtime

Containment: forbidden-ownership static checks + low-thousands LOC architecture review threshold.

### Risk: CI/reviewer races across pushes

Containment: exact-head SHA is checked at every gate and re-read immediately before READY.

### Risk: reviewer false positives

Containment: official finding statuses support dismissed/resolved; P3 is non-blocking; P0/P1/P2 remain blocking until resolved/dismissed.

### Risk: repeated repair consumes excessive quota

Containment: bounded repair rounds and infrastructure retries; explicit ESCALATED terminal state.

### Risk: old 3 GB runtime data is deleted

Containment: intentional product decision. Git/GitHub/Open SWE are the only retained source truths; old execution state is explicitly non-migratable.

## 15. Definition of done

The refactor is complete when all are true:

- [ ] old TypeScript/SQLite autonomous control plane deleted;
- [ ] old API/client compatibility deleted;
- [ ] old OpenHands/Antigravity execution plane deleted;
- [ ] old DB/backups/workspaces/tooling deleted from the host;
- [ ] old ForgeFlow systemd topology removed;
- [ ] Open SWE exact SHA pinned;
- [ ] upstream contract suite green;
- [ ] ForgeFlow policy graph runs in the same LangGraph deployment as Open SWE;
- [ ] implementation uses Luna xhigh by policy;
- [ ] review uses official Open SWE reviewer with Sol medium;
- [ ] false-success/no-progress test proves run success cannot bypass evidence;
- [ ] exact-head CI gate implemented;
- [ ] exact-head reviewer gate implemented;
- [ ] P0/P1/P2 repair loop bounded and same-thread;
- [ ] restart/replay produces no duplicate dispatch;
- [ ] real repository acceptance reaches READY after at least one repair/re-review path;
- [ ] final exact head has CI PASS and zero open P0/P1/P2;
- [ ] README/docs clearly describe ForgeFlow as Open SWE quality governance, not an autonomous coding runtime;
- [ ] release published as a new major version after real acceptance.
