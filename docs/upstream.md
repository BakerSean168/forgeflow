# Open SWE upstream contract

ForgeFlow Policy V1 is an overlay on Open SWE, not an autonomous coding runtime.

## Pinned revision

- Repository: `langchain-ai/open-swe`
- Exact revision: `0ff86e22a94cc84e32883fcb1beee568560d4140`
- Commit date: `2026-09-08T18:43:52-07:00`
- Commit subject: `fix(ui): make new thread heading project-agnostic (#2539)`

The same SHA is stored in `UPSTREAM_OPEN_SWE_SHA` and in the direct Git dependency in
`pyproject.toml`. ForgeFlow never tracks Open SWE `main` at runtime.

## v2 migration baseline

- Legacy ForgeFlow main baseline: `6c29586d699e...` (`6c29586`, `fix(plans): audit finalization scope corrections (#26)`).
- Planning baseline commit: `9b64347` (`docs: define Open SWE policy architecture`).
- The separate legacy worktree `fix/active-finalization-correction` carried 7 modified files / 582 insertions / 13 deletions in the old Plan/worktree orchestration. Those changes are intentionally **not** ported into Policy V1.
- The production cutover is complete. Legacy Node/SQLite/OpenHands/Antigravity services and state were removed only after the replacement passed authenticated health checks; `/etc/forgeflow/litellm.env` remained independently owned and was preserved.

## Contracts ForgeFlow consumes

Upstream-internal imports are centralized behind the ForgeFlow adapter/extension boundary and guarded by `tests/test_upstream_contract.py`. The pinned baseline requires:

- `agent.graphs.agent:traced_agent`
- `agent.graphs.reviewer:traced_reviewer_agent`
- `agent.graphs.scheduler:get_scheduler`
- `agent.dispatch:dispatch_agent_run`
- `agent.review.findings:list_findings`
- `agent.github.webhook:trigger_pr_review_from_ref`
- `agent.github.pull_request_checks:get_pull_request_check_states`
- `agent.run_config.RunConfig` model-routing and PR/SHA fields

`tests/test_upstream_contract.py` is the executable compatibility gate. An upstream bump is a
separate reviewed change: update the exact SHA, regenerate `uv.lock`, run the contract suite,
run ForgeFlow's policy tests, and then repeat real-repository acceptance before promotion.

## Self-hosted compatibility extensions

The GCP Dev deployment adds narrowly scoped runtime extensions under `openswe_ext/`; these are
compatibility adapters, not forks of Open SWE graphs:

- `docker_sandbox.py` supplies the self-hosted Docker sandbox provider and least-privilege GitHub
  credential bridge.
- `workflow_push_guard.py` preserves Open SWE's workflow approval gate while correcting one pinned
  upstream edge case: for a new task branch that tracks a non-default `origin/*` base, workflow
  diffs are evaluated against that tracked base rather than unconditionally against `origin/HEAD`.
  Real task-authored `.github/workflows/*` changes remain approval-gated.

`langgraph.json` points `agent`, `reviewer`, `analyzer`, `chat`, and `scheduler` at
`openswe_ext.graphs:*`. Those wrappers install the compatibility hooks and then delegate to the
pinned upstream graphs. The extension installer fails closed if another implementation has already
replaced the same pinned upstream hook. The
characterization tests in `tests/test_workflow_push_guard.py` cover both the false-positive case
and the retained human-approval case.

## Runtime compatibility notes

- The pinned Open SWE package declares `Python >=3.14`; Python 3.14 is therefore part of the
  current runtime contract, not an incidental ForgeFlow preference.
- ForgeFlow constrains the local Agent Server line to `langgraph-api>=0.14,<0.15`. The lockfile is
  reviewed with each minor-line change and the existing durable thread state must survive a real
  restart before promotion.
- The GCP Dev deployment is loopback-only. Open SWE intentionally refuses relative/loopback
  completion webhooks, so `RUN_COMPLETE_WEBHOOK_SECRET` and `COMPLETION_WEBHOOK_URL` remain unset
  unless an explicitly approved public HTTPS callback endpoint is introduced. The corresponding
  startup warning means run-completion replies are unavailable on this local-only surface; it is
  not a readiness failure.
- Import-time warnings from LangChain's Pydantic v1 compatibility shim are upstream compatibility
  noise on Python 3.14. ForgeFlow/Open SWE runtime code does not directly depend on `pydantic.v1`;
  treat a future direct dependency or runtime failure as a new compatibility gate.

## Ownership rule

Open SWE/LangGraph own agent execution, reviewer execution, scheduling, thread/run durability,
sandboxes, Git/PR operations, and reviewer findings. ForgeFlow may reference those identities and
apply quality policy, but must not duplicate their persistence or runtime ownership.
