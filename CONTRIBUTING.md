# Contributing

ForgeFlow Policy V1 is deliberately small. Contributions should strengthen software-engineering
quality governance without reintroducing an autonomous coding runtime.

Before submitting changes:

```bash
uv sync --locked --python 3.14
uv run pytest
uv run ruff check forgeflow tests
```

Do not add ForgeFlow-owned databases, worktree managers, provider/session runtimes, reviewer
stores, model gateways, or job schedulers. Prefer upstream Open SWE/LangGraph capabilities behind
one narrow adapter boundary. Upstream Open SWE updates must use an exact SHA and pass the contract
tests plus real acceptance before promotion.
