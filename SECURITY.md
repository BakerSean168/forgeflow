# Security policy

ForgeFlow can execute code, manage mutable Git worktrees, launch external coding agents, and interact with provider credentials. Please treat security reports as potentially high impact.

## Reporting a vulnerability

Please do **not** publish exploitable security details in a public GitHub Issue.

Use GitHub's private vulnerability reporting / Security Advisory flow for the repository when available. Include:

- affected ForgeFlow revision or release;
- impact and required preconditions;
- a minimal reproduction;
- whether the issue crosses a repository, credential, provider, process, or release-provenance boundary;
- suggested containment, if known.

## Sensitive material

Do not include real API keys, auth/session files, SSH keys, private repository contents, production database rows, raw authorization headers, or unredacted provider response bodies in reports, fixtures, screenshots, or logs.

## Security model

ForgeFlow intentionally treats model/provider output as untrusted input. Acceptance is based on deterministic controller checks such as Git provenance, write-scope validation, exact-SHA review lineage, provider cleanup evidence, worktree retirement, and release provenance rather than a model saying that work is complete.

Self-change, self-promotion, autonomous improvement diagnosis/adoption, and related high-privilege paths are separately gated and default off unless an operator explicitly enables them.
