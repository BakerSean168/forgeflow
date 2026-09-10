# ForgeFlow

> **A thin software-engineering quality policy for Open SWE.**

ForgeFlow Policy V1 does **not** implement its own autonomous coding runtime. Open SWE and
LangGraph own agent execution, reviewer execution, durable threads/runs, scheduling, Git/PR
behavior, and reviewer findings. ForgeFlow adds a small deterministic policy layer plus narrow
self-hosted Open SWE compatibility extensions for Docker sandboxing and GitHub credentials.

**OpenHands is not part of the current ForgeFlow runtime.** The previous
Node/SQLite/OpenHands/Antigravity execution plane was retired during the v2 rebuild. Remaining
`OpenHands` references are migration history, guarded legacy-purge code, or tests that prevent the
old runtime from returning.

The current lifecycle is:

```text
Objective
  -> Open SWE implementation (Luna xhigh)
  -> real PR/head evidence
  -> exact-head CI
  -> independent Open SWE review (Sol medium)
  -> blocking findings? same-thread repair : READY
  -> repeat with bounded repair budget
```

A child agent reporting `success` is never enough. ForgeFlow requires authoritative PR, exact-head
CI, and exact-head reviewer evidence before `READY`.

## Status

ForgeFlow Policy V1 / v2.0.0 is implementation-complete and acceptance-backed. The implementation
is tracked by [PR #27](https://github.com/BakerSean168/forgeflow/pull/27) and the stacked v2.0.0
release candidate [PR #28](https://github.com/BakerSean168/forgeflow/pull/28). Releases are cut only
from merged `main`; [GitHub Releases](https://github.com/BakerSean168/forgeflow/releases) is the
source of truth for published tags.

The legacy Node/SQLite/OpenHands/Antigravity control plane was removed rather than migrated.
The current GCP Dev deployment is Python 3.14 + LangGraph + pinned Open SWE, with per-thread Docker
sandboxes supplied through `openswe_ext`.

The real ForgeFlow policy acceptance on PR #28 reached `READY` after a controlled read-only-rootfs
regression at `7115c08` passed CI, the Official Reviewer raised a blocking high finding, and the
same implementation thread performed Luna xhigh repair `94ddd70`. Exact-head CI and re-review then
resolved the blocker with `repair_round=1`. Digital Biome PR #59 remains separate corroborating
evidence for the underlying Open SWE review → repair → re-review loop.

## Documentation

- [`docs/README.md`](./docs/README.md) — documentation map and current-vs-historical boundary.
- [`docs/open-swe-policy-v1-architecture.md`](./docs/open-swe-policy-v1-architecture.md) — current
  architecture, ownership, state machine, and deployment shape.
- [`docs/reviewer-sandbox.md`](./docs/reviewer-sandbox.md) — current self-hosted Docker sandbox
  isolation and lifecycle.
- [`docs/github-app.md`](./docs/github-app.md) — current GitHub App and required-check setup.
- [`docs/upstream.md`](./docs/upstream.md) — pinned Open SWE contract and upgrade procedure.
- [`docs/open-swe-policy-v1-refactor-plan.md`](./docs/open-swe-policy-v1-refactor-plan.md) — completed
  v2 migration/acceptance record; retained as history, not as the current architecture guide.

## Development

Requires `uv` and Python 3.14.

```bash
uv sync --locked --python 3.14
uv run pytest
uv run ruff check forgeflow openswe_ext tests
```

## License

MIT. Open SWE and its transitive dependencies remain governed by their own upstream licenses.
