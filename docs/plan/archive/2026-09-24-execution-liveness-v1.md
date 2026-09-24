# ForgeFlow Execution Liveness V1

> Status: completed
> Owner: ChatGPT Web
> Created: 2026-09-24
> Execution mode: ChatGPT implementation; ForgeFlow self-supervision remains disabled.

## Outcome

Make stale supervisor-owned objectives observable without changing durable thread state, and give the
Policy service enough shutdown budget to complete LangGraph's graceful stop path.

The cycle is complete when:

1. `/forgeflow/api/v1/summary` distinguishes durable active lifecycle state from effective/actionable execution state.
2. Supervisor-owned objectives from an inactive archived plan are projected as stale rather than silently inflating actionable activity.
3. Existing `activeObjectiveCount` remains backward-compatible as the durable lifecycle count, while explicit actionable/stale counts remove ambiguity.
4. Manual/hermes objectives are not marked stale merely because a project's continuous plan is inactive.
5. `forgeflow-policy.service` has a 60-second stop budget and a controlled restart completes without a systemd stop-timeout/SIGKILL event.
6. Focused tests, full pytest, Ruff, and `git diff --check` pass.

## Current evidence

- Workflow Lifecycle V2 is merged at main commit `d90b684`; no ForgeFlow active plan remains.
- MemoFlow's configured supervisor plan and TaskGraph are archived on the configured base.
- Operator summary correctly projects MemoFlow planning as `INACTIVE`, but four September 16 supervisor-owned objectives still have durable statuses `VERIFYING` or `IMPLEMENTING`.
- No child agent is running for those four objectives.
- The Policy service restart on 2026-09-24 entered graceful shutdown but hit `TimeoutStopSec=30` and systemd killed the old LangGraph process with SIGKILL.
- The service template and installed unit both explicitly configure `TimeoutStopSec=30`.

## Architecture decisions

- LangGraph thread status remains durable lifecycle truth; this plan does not rewrite historical threads automatically.
- Operator summary adds a liveness projection rather than redefining or deleting durable state.
- Existing `activeObjectiveCount` remains compatible; new counts distinguish actionable and stale supervisor-owned active objectives.
- A stale classification requires both supervisor ownership and an inactive configured plan. Manual objectives remain actionable unless their own lifecycle becomes terminal.
- Policy shutdown tuning changes only systemd stop budget; signal type, restart policy, and project supervisor activation remain unchanged.

## Protected contracts

- GET operator endpoints remain read-only.
- No bulk cancellation or cross-project state mutation is introduced.
- Existing objective command semantics remain unchanged.
- Project supervisor timer remains inactive unless explicitly activated.
- Service remains loopback-only and retains existing hardening options.

## Non-goals

- Do not cancel MemoFlow's historical objectives automatically.
- Do not enable MemoFlow or ForgeFlow continuous supervision.
- Do not redesign objective statuses or LangGraph persistence.
- Do not upgrade LangGraph packages in this cycle.

## Phase 1 - Effective execution liveness

Add a bounded, read-only objective liveness projection.

Acceptance evidence:

- supervisor-owned active objective + inactive plan => `STALE_PLAN_INACTIVE`;
- manual/hermes active objective + inactive plan => `EFFECTIVE_ACTIVE`;
- terminal objective => `INACTIVE`;
- summary exposes durable, actionable, and stale active counts;
- active objective rows include liveness classification and reason;
- no GET path creates runs or updates thread state.

## Phase 2 - Graceful Policy shutdown budget

Increase Policy service `TimeoutStopSec` from 30s to 60s and verify the deployed unit.

Acceptance evidence:

- deployment contract tests assert 60s;
- installed unit is reconciled to 60s without running the full installer;
- controlled restart leaves Policy active and project-supervisor timer inactive;
- restart journal contains no new stop-timeout/SIGKILL event for the controlled restart.

## Verification

- `uv run pytest tests/test_operator_api.py -q`
- `uv run pytest tests/test_deployment.py tests/test_deploy_contract.py -q`
- `uv run ruff check forgeflow openswe_ext deploy/gcp-dev tests`
- `uv run pytest -q`
- `git diff --check`

## Closure evidence

Completed on 2026-09-24.

- FF-LIVE-3001 added read-only objective liveness projection to the operator summary. Durable `activeObjectiveCount` remains unchanged; `actionableActiveObjectiveCount` and `staleActiveObjectiveCount` now distinguish effective work from historical supervisor-owned rows.
- Supervisor-owned active objectives whose configured plan is inactive are projected as `STALE_PLAN_INACTIVE`; manual/Hermes objectives remain `EFFECTIVE_ACTIVE` unless their own lifecycle is terminal.
- Project supervisor summaries expose `staleActiveObjectiveCount` without rewriting LangGraph thread state or issuing cancel commands.
- FF-OPS-3002 changed only `forgeflow-policy.service` `TimeoutStopSec` from 30s to 60s; signal, restart policy, loopback binding, and project-supervisor activation are unchanged.
- The full suite initially exposed four stale reviewer-fallback tests because `openswe-reviewer-glm53` expired on 2026-09-23T16:00:00Z. Tests were made deterministic: default policy now expects the expired route to be excluded, while explicit future-expiry fixtures still cover fallback behavior.
- Focused liveness/deployment/documentation checks: 74 passed.
- Reviewer/model-routing expiry checks: 18 passed.
- Repository-wide Ruff passed.
- Repository-wide pytest passed: 563 tests, with 6 upstream dependency warnings.
- `git diff --check` passed.
- Post-merge live-unit verification passed at delivered main commit `d66810e`: the installed Policy unit reports `TimeoutStopUSec=1min`, a controlled restart completed graceful shutdown in about 8 seconds with no stop-timeout/SIGKILL evidence, the Policy service returned active, and `forgeflow-project-supervisor.timer` remained inactive.
- The live operator summary then reported `activeObjectiveCount=4`, `actionableActiveObjectiveCount=0`, and `staleActiveObjectiveCount=4`; all four historical MemoFlow supervisor objectives were classified `STALE_PLAN_INACTIVE` with reason `PLAN_INACTIVE`, while `runningAgentCount=0`.
