"""Bounded external-agent execution surfaces for ForgeFlow.

Open SWE remains ForgeFlow's default implementation/review runtime. Modules in
this package are opt-in adapters for account-native agents that cannot be
represented faithfully as an Open SWE chat model.
"""

from forgeflow.external_agents.acp import AcpExecutionResult, run_acp_agent

__all__ = ["AcpExecutionResult", "run_acp_agent"]
