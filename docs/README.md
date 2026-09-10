# ForgeFlow documentation

ForgeFlow v2 has one current architecture and one retained migration record. Read the current-state
documents first; the migration record exists for auditability and should not be used to infer the
running topology.

## Current system

| Document | Purpose |
| --- | --- |
| [`open-swe-policy-v1-architecture.md`](./open-swe-policy-v1-architecture.md) | Authoritative ownership, lifecycle, policy state, deployment shape, and acceptance contract. |
| [`reviewer-sandbox.md`](./reviewer-sandbox.md) | Self-hosted Open SWE Docker sandbox isolation, credentials, persistence, and GC. |
| [`github-app.md`](./github-app.md) | Dedicated Open SWE GitHub App configuration and required-check policy. |
| [`upstream.md`](./upstream.md) | Exact pinned Open SWE revision, consumed contracts, compatibility extensions, and upgrade rules. |

## Historical migration record

[`open-swe-policy-v1-refactor-plan.md`](./open-swe-policy-v1-refactor-plan.md) records the destructive
v2 rebuild, the retired Node/SQLite/OpenHands/Antigravity architecture, implementation phases, and
real acceptance evidence. It is intentionally retained as an audit trail, not as current operating
documentation.

## Current runtime boundary

The running architecture is Python 3.14 + LangGraph + pinned Open SWE + ForgeFlow policy +
`openswe_ext` self-hosted Docker sandbox compatibility extensions. OpenHands is not used by the
current runtime. Any remaining `OpenHands` text in the repository must be either historical
migration context or guarded legacy-cleanup/test logic.
