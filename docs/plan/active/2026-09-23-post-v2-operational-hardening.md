# ForgeFlow Post-v2 Operational Hardening

> Status: active
> Owner: ChatGPT Web planning/control plane
> Created: 2026-09-23
> Execution mode: planning truth only; ForgeFlow self-supervision is not enabled by this plan.

## Outcome

Close the remaining post-v2 operational ambiguity without expanding ForgeFlow runtime ownership.

The cycle is complete when:

1. GCP Dev has a deterministic read-only health check that detects required ForgeFlow user units or timers that are not active.
2. Deployment acceptance fails closed when required runtime units are not active after installation.
3. Repository documentation defines how to distinguish active implementation from stale Git worktrees and branches, and how to close them safely.
4. Focused deployment and documentation checks, Ruff, the full pytest suite, and git diff --check pass on the integrated exact head.
5. ForgeFlow does not automatically opt itself into continuous_supervisor; self-supervision remains an explicit operator decision.

## Current evidence

- main is clean and aligned with origin/main after PR #100.
- PR #100 added durable acceptance-thread resume support with repository, base-ref, and workspace identity validation.
- The complete repository suite passed: 538 tests.
- Historical ForgeFlow worktrees from the September 14-16 optimization cycle were clean and tied to merged or superseded work; they have been removed.
- Stale draft PR #77 was closed because its recovery design was superseded by the current attempt-ledger, provider-fallback, continuation, and delivery implementation.
- GCP Dev forgeflow-policy.service and direct ChatGPT MCP are healthy.
- forgeflow-project-supervisor.timer was observed enabled but inactive. The installer enables it with --now, but there is no reusable runtime-health acceptance surface that makes later lifecycle drift explicit.
- Agent Harness skill materialization has been reconciled. The remaining Codex runtime pin drift is host/tooling ownership and is out of scope while another project is actively using Codex.

## Architecture decisions

- ForgeFlow remains a thin quality-policy layer over Open SWE and LangGraph. This cycle must not add a second workflow database, scheduler, worktree manager, provider runtime, or control plane.
- Runtime health inspection is read-only. A health check may report or fail; it must not silently start or stop project supervision.
- Installation may assert that units it just enabled are active. Later activation or deactivation remains explicit.
- Git worktree cleanup is host and repository maintenance, not ForgeFlow execution-state ownership.
- TaskGraph is planning truth. LangGraph threads remain execution truth. GitHub remains delivery truth.

## Protected contracts

- Exact-head CI and independent review remain mandatory before READY.
- Open SWE owns implementation and reviewer execution plus sandbox and workspace lifecycle.
- ForgeFlow project-supervisor activation remains opt-in at the project configuration level.
- No secret values are printed by operational health tooling.
- forgeflow-policy.service remains loopback-only.
- Existing user-unit names and timer cadences remain unchanged unless a separate migration explicitly changes them.

## Non-goals

- Do not enable ForgeFlow self-supervision as part of this plan.
- Do not resume MemoFlow or another project's autonomous execution.
- Do not downgrade or upgrade the global Codex runtime while another project has a live Codex process.
- Do not add automated deletion of arbitrary worktrees or remote branches.
- Do not redesign model routing, TaskGraph scheduling, reviewer policy, or provider fallback.

## Phase 1 - Runtime-unit health postcondition

Implement a deterministic, read-only runtime-health surface for deployed user units and make installation verify the postcondition after enabling timers.

Acceptance evidence:

- a required inactive unit or timer produces a non-zero result and identifies the unit without exposing secrets;
- all required active units produce success;
- installer deployment tests cover the post-install health assertion;
- focused tests and Ruff pass.

## Phase 2 - Active-work and closure contract

Document the operational distinction between active plans, TaskGraphs, runtime threads, PRs, and stale worktrees. Define safety checks required before removing a worktree or local branch.

Acceptance evidence:

- the runbook requires a clean worktree, no live process using its cwd, and merged, closed, or superseded delivery evidence before removal;
- the runbook states that worktree count is not active-task count;
- the runbook documents ForgeFlow's default no-self-supervision posture;
- documentation tests and repository-wide tests pass.

## Verification matrix

- uv run pytest tests/test_deployment.py tests/test_deploy_contract.py -q
- uv run pytest tests/test_documentation.py -q
- uv run ruff check forgeflow openswe_ext deploy/gcp-dev tests
- uv run pytest -q
- git diff --check

## Rollback and containment

Both tasks are additive hardening. If runtime-health integration causes deployment regressions, remove the installer invocation while retaining the read-only checker and tests for diagnosis. Documentation changes can be reverted independently. No state migration is involved.
