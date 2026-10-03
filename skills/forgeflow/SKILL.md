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
acceptance, worktrees, missions, schedules, resume, and PR gating. Do not recreate
those mechanisms inside ForgeFlow.

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
and runtime acceptance evidence.

When `pi-gauntlet` is installed, use its `gatekeep-pr` skill for pull-request
verification and merge gating. It owns exact-head CI evidence, freshness checks,
review orchestration, and head-matched merge safety.

Do not add ForgeFlow-specific wrappers around those plugin surfaces unless a
concrete missing policy cannot be expressed through the existing plugin contract.
