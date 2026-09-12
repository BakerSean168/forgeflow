"""Guarded Antigravity implementation route built on the generic ACP execution port."""

from __future__ import annotations

import os
import sys
from pathlib import Path

from forgeflow.external_agents.execution import (
    ExternalAgentExecutionEvidence,
    ExternalAgentExecutionRequest,
    ExternalAgentRouteGate,
    ExternalAgentRouteRejected,
)
from openswe_ext.external_agent_execution import AcpWorkspaceExecutionAdapter


def _enabled(value: str | None) -> bool:
    return (value or "").strip().casefold() in {"1", "true", "yes", "on"}


def _projects(value: str | None) -> frozenset[str]:
    return frozenset(item.strip() for item in (value or "").split(",") if item.strip())


class AntigravityExternalAgentExecution:
    """Explicit-only Antigravity route; this class never performs automatic fallback."""

    def __init__(self, *, env: dict[str, str] | None = None) -> None:
        values = os.environ if env is None else env
        root = Path(
            values.get(
                "FORGEFLOW_EXTERNAL_AGENT_WORKSPACE_ROOT",
                str(Path.home() / ".local/share/forgeflow-policy/external-agent-workspaces"),
            )
        ).expanduser()
        self._gate = ExternalAgentRouteGate(
            enabled=_enabled(values.get("FORGEFLOW_ANTIGRAVITY_ACP_ENABLED")),
            allowed_projects=_projects(values.get("FORGEFLOW_ANTIGRAVITY_ACP_PROJECTS")),
            workspace_root=root,
        )
        outer = values.get("FORGEFLOW_EXTERNAL_AGENT_OUTER_SANDBOX", "docker").strip()
        if outer != "docker":
            raise ExternalAgentRouteRejected("ANTIGRAVITY_OUTER_SANDBOX_REQUIRED")
        agy_bin = values.get("FORGEFLOW_ANTIGRAVITY_BIN", str(Path.home() / ".local/bin/agy"))
        auth_state = values.get(
            "FORGEFLOW_ANTIGRAVITY_AUTH_STATE_DIR",
            str(Path.home() / ".gemini/antigravity-cli"),
        )
        model = values.get("FORGEFLOW_ANTIGRAVITY_MODEL", "gemini-3.8-flash-high")
        effort = values.get("FORGEFLOW_ANTIGRAVITY_EFFORT", "high")
        timeout = values.get("FORGEFLOW_ANTIGRAVITY_PRINT_TIMEOUT", "20m")
        image = values.get(
            "FORGEFLOW_EXTERNAL_AGENT_DOCKER_IMAGE",
            "forgeflow/openswe-sandbox:bookworm-node24",
        )
        args = (
            "-m",
            "openswe_ext.antigravity_acp",
            "--agy-bin",
            agy_bin,
            "--allowed-root",
            str(root),
            "--model",
            model,
            "--effort",
            effort,
            "--mode",
            "accept-edits",
            "--print-timeout",
            timeout,
            "--sandbox",
            "--outer-sandbox",
            "docker",
            "--auth-state-dir",
            auth_state,
            "--docker-image",
            image,
        )
        self._adapter = AcpWorkspaceExecutionAdapter(
            gate=self._gate,
            agent_command=sys.executable,
            agent_args=args,
            runtime_label="antigravity",
        )

    async def execute(
        self, request: ExternalAgentExecutionRequest
    ) -> ExternalAgentExecutionEvidence:
        return await self._adapter.execute(request)


__all__ = ["AntigravityExternalAgentExecution"]
