"""Durable LangGraph child for one already-selected external-agent implementation route."""

from __future__ import annotations

import asyncio
import os
import subprocess
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal, Protocol, TypedDict

from acp.exceptions import RequestError
from httpx2 import RequestError as HttpxRequestError
from langgraph.graph import END, START, StateGraph

from forgeflow.adapters.external_delivery import GitHubExternalAgentDelivery
from forgeflow.attempts import AttemptHandle, AttemptLedger
from forgeflow.external_agents.execution import ExternalAgentExecutionRequest
from forgeflow.projects import load_external_agent_project_config
from forgeflow.routing import classify_failure_code, load_route_registry
from openswe_ext.antigravity_execution import AntigravityExternalAgentExecution
from openswe_ext.external_agent_workspace import (
    cleanup_external_workspace,
    prepare_external_workspace,
)

ExternalGraphStatus = Literal["SUCCESS", "BLOCKED"]


class ExternalAgentGraphInput(TypedDict):
    owner: str
    repo: str
    base_ref: str
    objective: str
    operation_key: str
    route_id: str
    phase: Literal["IMPLEMENT", "REPAIR"]


class ExternalAgentGraphState(ExternalAgentGraphInput, total=False):
    external_status: ExternalGraphStatus
    failure_code: str | None
    failure_class: str | None
    attempt_id: str | None
    source_revision: str | None
    pr_url: str | None
    pr_number: int | None
    head_sha: str | None
    head_ref: str | None
    external_session_id: str | None
    external_conversation_id: str | None


@dataclass(frozen=True, slots=True)
class ExternalAgentGraphResult:
    external_status: ExternalGraphStatus
    failure_code: str | None = None
    failure_class: str | None = None
    attempt_id: str | None = None
    source_revision: str | None = None
    pr_url: str | None = None
    pr_number: int | None = None
    head_sha: str | None = None
    head_ref: str | None = None
    external_session_id: str | None = None
    external_conversation_id: str | None = None


class ExternalAgentGraphServices(Protocol):
    async def run(self, request: ExternalAgentGraphInput) -> ExternalAgentGraphResult: ...


def _failure_code(exc: BaseException) -> str:
    if isinstance(exc, HttpxRequestError):
        return "EXTERNAL_AGENT_GITHUB_TRANSPORT_FAILED"
    if isinstance(exc, RequestError):
        data = getattr(exc, "data", None)
        code = data.get("code") if isinstance(data, dict) else None
        if isinstance(code, str) and code.strip():
            return code.split(":", 1)[0].strip().upper()
    if isinstance(exc, OSError):
        return "EXTERNAL_AGENT_IO_FAILED"
    code = str(exc).split(":", 1)[0].strip()
    return code or type(exc).__name__


def _summary(objective: str, *, limit: int = 68) -> str:
    compact = " ".join(objective.split())
    return compact[:limit] or "external implementation"


class DefaultExternalAgentGraphServices:
    """Production external execution. LangGraph owns durability around this bounded turn."""

    async def run(self, request: ExternalAgentGraphInput) -> ExternalAgentGraphResult:
        route_config = os.environ.get("FORGEFLOW_ROUTE_CONFIG_FILE", "").strip()
        ledger_path = os.environ.get("FORGEFLOW_ATTEMPT_LEDGER_FILE", "").strip()
        workspace_root = os.environ.get("FORGEFLOW_EXTERNAL_AGENT_WORKSPACE_ROOT", "").strip()
        if not route_config:
            return ExternalAgentGraphResult("BLOCKED", "ROUTE_CONFIG_MISSING", "POLICY_DENIED")
        if not ledger_path:
            return ExternalAgentGraphResult("BLOCKED", "ATTEMPT_LEDGER_MISSING", "POLICY_DENIED")
        if not workspace_root:
            return ExternalAgentGraphResult(
                "BLOCKED", "EXTERNAL_AGENT_WORKSPACE_ROOT_MISSING", "POLICY_DENIED"
            )

        attempt: AttemptHandle | None = None
        attempt_finished = False
        workspace: Path | None = None
        source_revision: str | None = None
        ledger = AttemptLedger(Path(ledger_path))
        try:
            registry = await asyncio.to_thread(load_route_registry, Path(route_config))
            route = registry.get(request["route_id"])
            if (
                route.role != "IMPLEMENT"
                or route.runtime != "EXTERNAL_ACP"
                or route.adapter != "antigravity"
                or not route.eligible(now=datetime.now(UTC))
            ):
                raise RuntimeError("EXTERNAL_AGENT_ROUTE_NOT_ELIGIBLE")

            attempt_status = await _cancellation_safe_to_thread(
                ledger.ensure_started,
                role=route.role,
                route_id=route.id,
                priority=route.priority,
                runtime=route.runtime,
                target=route.target,
                operation_key=request["operation_key"],
                cancel_cleanup=lambda status: _close_cancelled_attempt(
                    ledger, status, source_revision=None
                ),
            )
            attempt = attempt_status.handle
            if attempt_status.finished:
                raise RuntimeError("EXTERNAL_AGENT_OPERATION_ALREADY_FINISHED")
            project = await asyncio.to_thread(
                load_external_agent_project_config, request["owner"], request["repo"]
            )
            if project is None:
                raise RuntimeError("EXTERNAL_AGENT_PROJECT_CONFIG_MISSING")
            root = Path(workspace_root).expanduser()
            await asyncio.to_thread(_ensure_private_directory, root)
            prepared = await _cancellation_safe_to_thread(
                prepare_external_workspace,
                source_repo=project.cwd,
                base_ref=request["base_ref"],
                workspace_root=root,
                cancel_cleanup=lambda prepared: cleanup_external_workspace(prepared.path),
            )
            workspace = prepared.path
            source_revision = prepared.source_revision
            execution_request = ExternalAgentExecutionRequest(
                owner=request["owner"],
                repo=request["repo"],
                workspace=workspace,
                objective=request["objective"],
                operation_key=request["operation_key"],
                phase=request["phase"],
                test_command=project.test_command,
            )
            evidence = await AntigravityExternalAgentExecution().execute(execution_request)
            if evidence.source_revision != source_revision:
                raise RuntimeError("EXTERNAL_AGENT_SOURCE_REVISION_MISMATCH")
            title = _summary(request["objective"])
            delivery = await GitHubExternalAgentDelivery().deliver(
                request=execution_request,
                evidence=evidence,
                base_ref=request["base_ref"],
                commit_subject="feat: apply ForgeFlow external implementation",
                pr_title=f"ForgeFlow: {title}",
                pr_body=(
                    "Guarded ForgeFlow external-agent implementation.\n\n"
                    f"Operation: `{request['operation_key']}`"
                ),
            )
            await _cancellation_safe_to_thread(
                ledger.finish_operation,
                route_id=route.id,
                operation_key=request["operation_key"],
                outcome="SUCCEEDED",
                source_revision=evidence.source_revision,
                result_revision=delivery.head_sha,
                external_session_id=evidence.acp_session_id,
                external_conversation_id=evidence.external_conversation_id,
            )
            attempt_finished = True
            return ExternalAgentGraphResult(
                external_status="SUCCESS",
                attempt_id=attempt.attempt_id,
                source_revision=evidence.source_revision,
                pr_url=delivery.pr_url,
                pr_number=delivery.pr_number,
                head_sha=delivery.head_sha,
                head_ref=delivery.branch,
                external_session_id=evidence.acp_session_id,
                external_conversation_id=evidence.external_conversation_id,
            )
        except asyncio.CancelledError:
            if attempt is not None and not attempt_finished:
                await _cancellation_safe_to_thread(
                    ledger.finish_operation,
                    route_id=attempt.route_id,
                    operation_key=attempt.operation_key,
                    outcome="BLOCKED",
                    failure_class="POLICY_DENIED",
                    fallback_reason="EXTERNAL_AGENT_CANCELLED",
                    source_revision=source_revision,
                )
                attempt_finished = True
            raise
        except (
            RequestError,
            HttpxRequestError,
            RuntimeError,
            OSError,
            subprocess.SubprocessError,
            ValueError,
            KeyError,
        ) as exc:
            code = _failure_code(exc)
            failure_class = classify_failure_code(code)
            if attempt is not None and not attempt_finished:
                try:
                    await _cancellation_safe_to_thread(
                        ledger.finish_operation,
                        route_id=attempt.route_id,
                        operation_key=attempt.operation_key,
                        outcome="BLOCKED",
                        failure_class=failure_class,
                        fallback_reason=code,
                        source_revision=source_revision,
                    )
                except OSError:
                    code = "ATTEMPT_LEDGER_WRITE_FAILED"
                    failure_class = "POLICY_DENIED"
            return ExternalAgentGraphResult(
                external_status="BLOCKED",
                failure_code=code,
                failure_class=failure_class,
                attempt_id=attempt.attempt_id if attempt is not None else None,
                source_revision=source_revision,
            )
        finally:
            if workspace is not None:
                await asyncio.to_thread(cleanup_external_workspace, workspace)


async def _cancellation_safe_to_thread(
    func, /, *args, cancel_cleanup=None, **kwargs
):
    """Finish a side-effecting worker before propagating task cancellation."""
    worker = asyncio.create_task(asyncio.to_thread(func, *args, **kwargs))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        result = await worker
        if cancel_cleanup is not None:
            await asyncio.to_thread(cancel_cleanup, result)
        raise


def _close_cancelled_attempt(ledger: AttemptLedger, status, *, source_revision: str | None) -> None:
    if status.finished:
        return
    ledger.finish_operation(
        route_id=status.handle.route_id,
        operation_key=status.handle.operation_key,
        outcome="BLOCKED",
        failure_class="POLICY_DENIED",
        fallback_reason="EXTERNAL_AGENT_CANCELLED",
        source_revision=source_revision,
    )


def _ensure_private_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)


def build_external_agent_graph(*, services: ExternalAgentGraphServices | None = None):
    resolved = services or DefaultExternalAgentGraphServices()

    async def execute(state: ExternalAgentGraphState) -> dict:
        request: ExternalAgentGraphInput = {
            "owner": state["owner"],
            "repo": state["repo"],
            "base_ref": state["base_ref"],
            "objective": state["objective"],
            "operation_key": state["operation_key"],
            "route_id": state["route_id"],
            "phase": state["phase"],
        }
        return asdict(await resolved.run(request))

    builder = StateGraph(ExternalAgentGraphState, input_schema=ExternalAgentGraphInput)
    builder.add_node("execute", execute)
    builder.add_edge(START, "execute")
    builder.add_edge("execute", END)
    return builder.compile()


def get_external_agent_graph():
    return build_external_agent_graph()


__all__ = [
    "DefaultExternalAgentGraphServices",
    "ExternalAgentGraphInput",
    "ExternalAgentGraphResult",
    "ExternalAgentGraphState",
    "build_external_agent_graph",
    "get_external_agent_graph",
]
