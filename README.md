# ForgeFlow

> **A thin software-engineering quality policy for Open SWE.**

ForgeFlow Policy V1 does **not** implement its own autonomous coding runtime. Open SWE and
LangGraph own agent execution, reviewer execution, sandboxes, durable threads/runs, scheduling,
Git operations, pull requests, and reviewer findings. ForgeFlow owns only the deterministic
quality policy that decides whether observed evidence is sufficient to continue, repair, escalate,
or declare a revision ready.

The target lifecycle is:

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

ForgeFlow Policy V1 / v2.0.0 is implementation-complete and acceptance-backed. The v2.0.0
release candidate is [PR #28](https://github.com/BakerSean168/forgeflow/pull/28), stacked on the
underlying Policy V1 implementation [PR #27](https://github.com/BakerSean168/forgeflow/pull/27).
Both remain unmerged; the published release and tag are intentionally still pending.

The legacy Node/SQLite/OpenHands control plane is intentionally retired rather than migrated.

The real ForgeFlow policy acceptance on PR #28 reached `READY` after a controlled read-only-rootfs
regression at `7115c08` passed CI, the Official Reviewer raised a blocking high finding, and the
same implementation thread performed Luna xhigh repair `94ddd70`. Exact-head CI and re-review then
resolved the blocker with `repair_round=1`. Digital Biome PR #59 remains separate corroborating
evidence for the underlying Open SWE review → repair → re-review loop.

See:

- [`docs/open-swe-policy-v1-architecture.md`](./docs/open-swe-policy-v1-architecture.md)
- [`docs/open-swe-policy-v1-refactor-plan.md`](./docs/open-swe-policy-v1-refactor-plan.md)
- [`docs/upstream.md`](./docs/upstream.md)

## Development

Requires `uv` and Python 3.14.

```bash
uv sync --locked --python 3.14
uv run pytest
uv run ruff check forgeflow openswe_ext tests
```

## License

MIT. Open SWE and its transitive dependencies remain governed by their own upstream licenses.
