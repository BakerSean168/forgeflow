---
name: forgeflow
description: |
  Thin Pi-native engineering policy: preserve one writer per worktree, use stable
  logical model roles, apply deterministic engineering invariants, and reuse
  installed Pi plugins instead of creating a second execution or review runtime.
---

# ForgeFlow

ForgeFlow is policy for Pi, not another agent runtime.

Use Pi as the execution kernel. Reuse installed plugins for delegation, review,
acceptance, worktrees, missions, schedules, and resume. Reuse host Skills for TDD,
SDD, PR gating, and delivery verification. Do not recreate those mechanisms inside
ForgeFlow.

## Core rules

- Keep one mutation writer per working tree.
- Use fresh-context reviewers when independent review is useful; reviewers do not
  mutate the candidate they judge.
- Treat worker success, reviewer prose, and external receipts as evidence rather
  than final authority.
- Bind delivery evidence to the current candidate. A new push invalidates evidence
  for the old head.
- Prefer deterministic repository checks over model claims.
- Repair the same candidate/worktree/PR when possible; do not fork a second
  implementation truth without an explicit reason.
- Refer to engineering roles through `forgeflow/planner`, `forgeflow/worker`,
  `forgeflow/reviewer`, `forgeflow/scout`, and `forgeflow/oracle` instead of
  hard-coding fast-moving physical model IDs.
- Keep model selection separate from provider/channel selection. Provider
  infrastructure owns endpoints, credentials, channel health, weights, quotas, and
  transport.

## Reuse plugin surfaces

Use `pi-subagents` for child execution, reviewer runs, review loops, typed gates,
and runtime acceptance evidence. Treat it as the single orchestration owner.

When the operator explicitly asks to delegate work to Antigravity, use
`antigravity`/`agy` for read-only analysis or `antigravity-writer`/`agy-writer` for
workspace changes. Those agents consume the local Antigravity CLI's own
subscription quota; they are external agents, not ForgeFlow physical model roles.
Never run an Antigravity writer concurrently with another writer in the same
worktree.

Use installed engineering Skills such as `test-driven-development`,
`spec-driven-development`, `pr-gate`, and `delivery-verification` for reusable
workflow methods. Exact-head CI, test execution, artifact identity, and deployment
state remain deterministic external evidence rather than model-owned state.

Do not add ForgeFlow-specific wrappers or a second workflow runtime unless a concrete
missing mechanism cannot be expressed through Pi, pi-subagents, Skills, or existing
deterministic tooling.
