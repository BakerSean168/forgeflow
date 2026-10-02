---
name: forgeflow
description: |
  Pi-native software-engineering governance: preserve one writer per worktree,
  use pi-subagents for delegation, require independent review where useful, and
  treat exact-revision repository evidence as stronger than agent success text.
---

# ForgeFlow

ForgeFlow is policy for Pi, not another agent runtime.

Use Pi as the parent execution kernel and `pi-subagents` for child agents,
missions, schedules, worktree isolation, resume, background execution, external
CLI agents, and ordinary acceptance evidence. Do not recreate those mechanisms
inside ForgeFlow.

## Core execution rules

- Keep one mutation writer per working tree.
- Use fresh-context reviewers for independent review. Reviewers do not mutate the
  candidate they are judging.
- Treat worker success, reviewer prose, and external receipts as evidence rather
  than final authority.
- When delivery uses a pull request, bind final acceptance to the current
  authoritative head. A new push invalidates CI and review evidence for the old
  head.
- Prefer deterministic repository checks over model claims.
- Repair the same candidate/worktree/PR when possible; do not silently fork a
  second implementation truth.
- Reuse Pi and pi-subagents primitives before adding ForgeFlow code.

## Review

Use the trusted `forgeflow.review` workflow when an independent review is
needed before final delivery. Pi's read-only reviewer writes its full evidence-backed
report to a managed artifact and must end with Pi's standard merge-verdict
contract: `Merge verdict: BLOCK|OK|OK with notes`, either as the plain final line
or the builtin reviewer's final Markdown list item. ForgeFlow deterministically
validates only those canonical forms and returns the artifact path plus a `clean`
or `blocked` state. Missing or malformed verdicts fail closed. The reviewer report remains review
evidence rather than final repository acceptance.

## Final pull-request acceptance

Use the trusted `forgeflow.accept` workflow for a committed pull-request
candidate. Supply the task, repository owner/name, pull-request number, expected
base branch, full expected head commit, and the repository's explicit required
check names. Missing required-check policy fails closed rather than guessing from
whatever checks happened to start.

The workflow fails closed unless:

- the local working tree is clean and its HEAD equals the expected commit before
  review;
- a fresh read-only reviewer returns a clean structured verdict;
- the local candidate is still clean and on the same HEAD after review;
- GitHub reports the pull request open at that exact head; and
- the observed GitHub check-runs and commit statuses for that head are terminal
  and successful.

Any new push requires a new acceptance run for the new head. Do not reuse an
older reviewer or CI result.
