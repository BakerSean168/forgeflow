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

The repository is undergoing the destructive Policy V1 / repository v2.0.0 rebuild. The legacy
Node/SQLite/OpenHands control plane is intentionally retired rather than migrated.

See:

- [`docs/open-swe-policy-v1-architecture.md`](./docs/open-swe-policy-v1-architecture.md)
- [`docs/open-swe-policy-v1-refactor-plan.md`](./docs/open-swe-policy-v1-refactor-plan.md)
- [`docs/upstream.md`](./docs/upstream.md)

## Development

Requires `uv` and Python 3.14.

```bash
uv sync --locked --python 3.14
uv run pytest
uv run ruff check forgeflow tests
```

## License

MIT. Open SWE and its transitive dependencies remain governed by their own upstream licenses.
