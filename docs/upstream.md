# Open SWE upstream contract

ForgeFlow Policy V1 is an overlay on Open SWE, not an autonomous coding runtime.

## Pinned revision

- Repository: `langchain-ai/open-swe`
- Exact revision: `0ff86e22a94cc84e32883fcb1beee568560d4140`
- Commit date: `2026-09-08T18:43:52-07:00`
- Commit subject: `fix(ui): make new thread heading project-agnostic (#2539)`

The same SHA is stored in `UPSTREAM_OPEN_SWE_SHA` and in the direct Git dependency in
`pyproject.toml`. ForgeFlow never tracks Open SWE `main` at runtime.

## Rewrite baseline

- Legacy ForgeFlow main baseline: `6c29586d699e...` (`6c29586`, `fix(plans): audit finalization scope corrections (#26)`).
- Planning baseline commit: `9b64347` (`docs: define Open SWE policy architecture`).
- The separate legacy worktree `fix/active-finalization-correction` carried 7 modified files / 582 insertions / 13 deletions in the old Plan/worktree orchestration. Those changes are intentionally **not** ported into Policy V1.
- Production legacy services/state remain untouched until the Phase 9 cutover; repository-runtime deletion is not a production data migration.

## Contracts ForgeFlow consumes

Normal upstream-internal imports must eventually be centralized in
`forgeflow/adapters/openswe.py`. The frozen baseline currently requires:

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

The extension installer runs before upstream graph imports in `openswe_ext/graphs.py` and fails
closed if another implementation has already replaced the same pinned upstream hook. The
characterization tests in `tests/test_workflow_push_guard.py` cover both the false-positive case
and the retained human-approval case.

## Ownership rule

Open SWE/LangGraph own agent execution, reviewer execution, scheduling, thread/run durability,
sandboxes, Git/PR operations, and reviewer findings. ForgeFlow may reference those identities and
apply quality policy, but must not duplicate their persistence or runtime ownership.
