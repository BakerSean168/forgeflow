# Credits and ecosystem

ForgeFlow is an independent autonomous software-engineering control plane. It is built to orchestrate and govern coding/review runtimes rather than replace every underlying agent runtime.

## OpenHands

ForgeFlow uses the [OpenHands Software Agent SDK](https://github.com/OpenHands/software-agent-sdk) as a version-pinned execution plane for ACP/headless coding sessions. The deployment currently pins OpenHands Software Agent SDK `v1.39.1` at commit `bf57d16f3dde05b0b03fa0af3f7e0ae924043b80` and builds the Agent Server from that exact source revision.

OpenHands provides the isolated agent-server runtime. ForgeFlow independently owns the higher-level lifecycle: durable Plan/WorkItem/Execution state, resource selection, literal Git worktree ownership, single-writer fencing, exact-revision review provenance, retry/recovery, integration, provider cleanup barriers, release attestation, and bounded improvement governance.

OpenHands Software Agent SDK is MIT-licensed. Its required license notice is preserved in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## Model and agent ecosystem

ForgeFlow can integrate with several external runtimes and model-routing systems, depending on operator configuration. The current codebase contains adapters or deployment support for technologies including:

- [LiteLLM](https://github.com/BerriAI/litellm) as a model/provider gateway.
- [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) compatible runtimes and adapters.
- OpenAI Codex-compatible execution paths.
- Claude/Anthropic-compatible execution paths.
- OpenCode, DSH, ZCode, and provider-native Antigravity execution paths.

These projects, services, model providers, trademarks, and APIs are owned by their respective authors or vendors. Their presence here indicates interoperability or runtime integration, not ownership, endorsement, or affiliation.

## Design lineage

ForgeFlow was rebuilt from earlier internal orchestration experiments around a narrower product boundary: autonomous software engineering with explicit lifecycle ownership and evidence-based acceptance. The design has also been informed by the broader coding-agent ecosystem, including OpenHands and other open-source agent tools. Where ForgeFlow executes third-party software, that software remains governed by its own license and distribution terms.
