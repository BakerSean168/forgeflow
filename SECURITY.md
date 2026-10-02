# Security

ForgeFlow must remain a policy layer, not a second privileged execution runtime.

Security-sensitive rules:

- never treat an agent/run success status as engineering acceptance by itself;
- keep one mutation writer per working tree;
- use fresh read-only reviewers for independent review;
- bind final review and CI evidence to the exact current PR head SHA;
- fail closed when the PR head/base changes, a required check is absent,
  pending, failed, skipped, neutral, or ambiguous;
- keep provider and GitHub credentials host-owned; ForgeFlow stores no token
  database and never places credentials in reviewer artifacts;
- allow reviewer reports only under the ignored `.pi/subagents/` runtime
  directory;
- a new push invalidates the previous exact-head acceptance.

Report suspected vulnerabilities privately to the repository owner rather than
opening a public issue with exploit details.
