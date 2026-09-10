# Security

ForgeFlow Policy V1 must not become a second privileged execution runtime. Open SWE/LangGraph own
agent execution and sandbox/runtime state; ForgeFlow consumes bounded identities and evidence.

Security-sensitive invariants:

- never treat an agent/run `success` status as engineering completion by itself;
- bind CI and review decisions to the exact current PR head SHA;
- never persist provider credentials, GitHub tokens, raw model responses, or sandbox secrets in
  ForgeFlow policy state;
- do not expose an unauthenticated LangGraph API to public networks;
- use the upstream Open SWE GitHub authentication path rather than implementing a second token
  store;
- keep model-controlled execution inside the self-hosted Open SWE Docker sandbox boundary; never
  reintroduce the retired OpenHands/Antigravity execution plane;
- bounded retries must escalate rather than loop forever.

Report suspected vulnerabilities privately to the repository owner rather than opening a public
issue with exploit details.
