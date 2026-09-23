# ForgeFlow Workflow Lifecycle V2

> Status: active
> Owner: ChatGPT Web planning/control plane
> Created: 2026-09-23
> Execution mode: ChatGPT implementation; ForgeFlow self-supervision remains disabled.

## Outcome

Make ForgeFlow's planning-to-execution workflow explicit and observable without adding a second state
store or allowing plans to activate themselves.

The cycle is complete when:

1. A TaskGraph whose tasks are all accepted on the configured base reports an explicit
   `task-graph-complete` supervisor result instead of an ambiguous idle parallel result.
2. The operator summary projects each project's supervisor configuration, plan/TaskGraph identity,
   and bounded task progress without mutating Git, systemd, or LangGraph state.
3. TaskGraph unattended execution can be explicitly bound to an approved TaskGraph revision, so a
   changed plan cannot silently inherit an older activation.
4. Legacy projects without the new activation binding remain supported and are visibly classified as
   legacy/unbound rather than silently presented as explicitly activated.
5. Focused tests, repository-wide Ruff, repository-wide pytest, and `git diff --check` pass.

## Current evidence

- The previous operational-hardening plan is archived and `docs/plan/active/` is empty.
- The continuous project supervisor already computes task completion from exact-head READY evidence
  plus ancestry on the configured base branch.
- When every TaskGraph task is complete, the current parallel supervisor can fall through to
  `parallel:active=0/... created=- blocked=-` rather than emitting a terminal planning result.
- `/forgeflow/api/v1/summary` exposes active objectives and latest project state but not the
  configured active plan, TaskGraph identity/revision, or per-task progress.
- `continuous_supervisor.enabled=true` is an explicit project-level switch, but it is not bound to
  the specific TaskGraph revision that was reviewed when execution was authorized.
- The current config loader resolves and loads `task_graph_path` before the supervisor evaluates the
  active-plan stop signal. If a completed plan and its TaskGraph are archived together, a configured
  project can fail during config loading instead of returning `plan-complete`.

## Architecture decisions

- TaskGraph remains repository-owned planning truth.
- LangGraph threads remain execution truth.
- GitHub exact-head CI/review and base-branch ancestry remain delivery truth.
- Operator GET surfaces remain read-only; they must not fetch, merge, start timers, or mutate state.
- TaskGraph completion is a projection, not a persisted state machine transition.
- Explicit activation binds unattended execution to `graph_id + revision`; changing either requires
  operator re-activation.
- Missing activation on an existing enabled TaskGraph remains legacy-compatible for this migration
  cycle but is surfaced as `LEGACY_UNBOUND`.

## Protected contracts

- Exact-head CI and independent review remain required before task acceptance.
- A READY task is not complete until its accepted head is on the configured base branch.
- Unknown or unfingerprinted active writers continue to block TaskGraph expansion.
- The supervisor never archives or edits repository plans.
- Operator summary does not perform network fetches or systemd mutations.
- Existing non-TaskGraph continuous supervisor configurations remain valid.

## Non-goals

- Do not enable ForgeFlow self-supervision.
- Do not activate MemoFlow or other projects.
- Do not redesign routing, reviewer policy, retry budgets, or sandbox ownership.
- Do not add a workflow database.
- Do not auto-archive completed plans.

## Phase 1 — Explicit TaskGraph completion

Add a terminal supervisor projection when every TaskGraph task is accepted on the configured base.

Acceptance evidence:

- all completed TaskGraph tasks return `task-graph-complete`;
- no new objective is created;
- READY-but-unmerged tasks do not count as complete;
- legacy lane behavior remains unchanged;
- an inactive/archived plan returns `plan-complete` even when its former TaskGraph path no longer exists.

## Phase 2 — Operator planning/progress projection

Expose bounded planning and execution status in project summary views.

Acceptance evidence:

- project summary shows continuous-supervisor configured/enabled state;
- active plan paths and TaskGraph id/revision are visible without exposing arbitrary file contents;
- task counts distinguish total, active, READY, blocked, and completed-on-base;
- completed TaskGraph projects report `COMPLETE`;
- disabled/unconfigured projects remain explicit rather than ambiguous.

## Phase 3 — Explicit TaskGraph activation binding

Allow enabled TaskGraph supervisors to declare an approved `graph_id + revision` activation binding.

Acceptance evidence:

- matching binding loads and executes normally;
- mismatched graph id or revision fails closed before dispatch;
- legacy missing binding remains compatible and is projected as `LEGACY_UNBOUND`;
- example/configuration docs show the explicit binding;
- no activation field is required for legacy inline lanes.

## Verification matrix

- `uv run pytest tests/test_project_supervisor.py -q`
- `uv run pytest tests/test_operator_api.py -q`
- `uv run pytest tests/test_projects.py tests/test_project_supervisor.py -q`
- `uv run pytest tests/test_documentation.py -q`
- `uv run ruff check forgeflow openswe_ext deploy/gcp-dev tests`
- `uv run pytest -q`
- `git diff --check`

## Rollback and containment

Each phase is additive. Completion projection can be reverted without changing persisted threads.
Operator projection is read-only. Activation binding remains optional for legacy compatibility during
this cycle, so rollback does not require rewriting existing project manifests.
