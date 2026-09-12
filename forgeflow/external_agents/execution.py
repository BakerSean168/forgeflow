"""Generic contracts for explicitly selected external coding-agent executions."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol

ExternalAgentPhase = Literal["IMPLEMENT", "REPAIR"]


class ExternalAgentRouteRejected(RuntimeError):
    """A guarded external route was not explicitly eligible for this request."""


@dataclass(frozen=True, slots=True)
class ExternalAgentExecutionRequest:
    owner: str
    repo: str
    workspace: Path
    objective: str
    operation_key: str
    phase: ExternalAgentPhase
    test_command: tuple[str, ...]

    @property
    def project(self) -> str:
        return f"{self.owner}/{self.repo}"


@dataclass(frozen=True, slots=True)
class ExternalAgentExecutionEvidence:
    runtime: str
    model: str | None
    source_revision: str
    changed_files: tuple[str, ...]
    diff_sha256: str
    test_command: tuple[str, ...]
    test_exit_code: int
    test_output_sha256: str
    acp_session_id: str
    external_conversation_id: str | None
    agent_stop_reason: str


@dataclass(frozen=True, slots=True)
class ExternalAgentRouteGate:
    enabled: bool
    allowed_projects: frozenset[str]
    workspace_root: Path

    def validate(self, request: ExternalAgentExecutionRequest) -> Path:
        if not self.enabled:
            raise ExternalAgentRouteRejected("EXTERNAL_AGENT_ROUTE_DISABLED")
        allowed = {item.casefold() for item in self.allowed_projects}
        if request.project.casefold() not in allowed:
            raise ExternalAgentRouteRejected("EXTERNAL_AGENT_PROJECT_NOT_ALLOWED")
        if request.phase not in {"IMPLEMENT", "REPAIR"}:
            raise ExternalAgentRouteRejected("EXTERNAL_AGENT_PHASE_NOT_ALLOWED")
        if not request.objective.strip():
            raise ExternalAgentRouteRejected("EXTERNAL_AGENT_OBJECTIVE_EMPTY")
        if not request.operation_key.strip():
            raise ExternalAgentRouteRejected("EXTERNAL_AGENT_OPERATION_KEY_EMPTY")
        if not request.test_command:
            raise ExternalAgentRouteRejected("EXTERNAL_AGENT_TEST_COMMAND_EMPTY")

        root = self.workspace_root.expanduser().resolve(strict=True)
        workspace = request.workspace.expanduser().resolve(strict=True)
        if not workspace.is_dir():
            raise ExternalAgentRouteRejected("EXTERNAL_AGENT_WORKSPACE_NOT_DIRECTORY")
        if workspace != root and root not in workspace.parents:
            raise ExternalAgentRouteRejected("EXTERNAL_AGENT_WORKSPACE_NOT_ALLOWED")
        return workspace


class ExternalAgentExecutionPort(Protocol):
    async def execute(
        self, request: ExternalAgentExecutionRequest
    ) -> ExternalAgentExecutionEvidence: ...


__all__ = [
    "ExternalAgentExecutionEvidence",
    "ExternalAgentExecutionPort",
    "ExternalAgentExecutionRequest",
    "ExternalAgentPhase",
    "ExternalAgentRouteGate",
    "ExternalAgentRouteRejected",
]
