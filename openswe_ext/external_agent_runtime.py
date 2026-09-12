"""LangGraph child-run adapter for ForgeFlow external-agent execution graphs."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from forgeflow.adapters.openswe import ChildRunSnapshot, ThreadSnapshot


class ExternalAgentChildRuntimeError(RuntimeError):
    pass


def external_implementation_thread_id(policy_thread_id: str, route_id: str) -> str:
    if not policy_thread_id or not route_id:
        raise ValueError("policy_thread_id and route_id are required")
    return str(uuid5(NAMESPACE_URL, f"forgeflow:external-implementation:{policy_thread_id}:{route_id}"))


class ExternalAgentChildRuntime:
    def __init__(self, client: Any) -> None:
        self._client = client

    async def ensure_thread(
        self,
        *,
        policy_thread_id: str,
        route_id: str,
        repo_owner: str,
        repo_name: str,
        objective: str,
    ) -> str:
        thread_id = external_implementation_thread_id(policy_thread_id, route_id)
        await self._client.threads.create(
            thread_id=thread_id,
            if_exists="do_nothing",
            graph_id="external_agent",
            metadata={
                "kind": "forgeflow_external_implementation",
                "source": "forgeflow",
                "origin": "forgeflow",
                "route_id": route_id,
                "repo_owner": repo_owner,
                "repo_name": repo_name,
                "title": objective[:80],
            },
        )
        return thread_id

    async def find_run_by_operation(self, *, thread_id: str, operation_key: str) -> str | None:
        runs = await self._client.runs.list(thread_id, limit=100)
        matches: list[str] = []
        for run in runs:
            if not isinstance(run, Mapping):
                continue
            metadata = run.get("metadata")
            if not isinstance(metadata, Mapping):
                continue
            if metadata.get("forgeflow_operation_key") != operation_key:
                continue
            run_id = run.get("run_id")
            if isinstance(run_id, str) and run_id:
                matches.append(run_id)
        unique = list(dict.fromkeys(matches))
        if len(unique) > 1:
            raise ExternalAgentChildRuntimeError(
                f"duplicate external runs for operation {operation_key!r}: {unique!r}"
            )
        return unique[0] if unique else None

    async def dispatch(
        self,
        *,
        thread_id: str,
        route_id: str,
        objective: str,
        repo_owner: str,
        repo_name: str,
        base_ref: str,
        operation_key: str,
        phase: str,
    ) -> str:
        run = await self._client.runs.create(
            thread_id,
            "external_agent",
            input={
                "owner": repo_owner,
                "repo": repo_name,
                "base_ref": base_ref,
                "objective": objective,
                "operation_key": operation_key,
                "route_id": route_id,
                "phase": phase,
            },
            metadata={
                "kind": "forgeflow_external_child",
                "forgeflow_operation_key": operation_key,
                "route_id": route_id,
            },
            multitask_strategy="enqueue",
        )
        run_id = run.get("run_id") if isinstance(run, Mapping) else None
        if not isinstance(run_id, str) or not run_id:
            raise ExternalAgentChildRuntimeError("external child dispatch returned no run_id")
        return run_id

    async def read_run(self, *, thread_id: str, run_id: str) -> ChildRunSnapshot:
        run = await self._client.runs.get(thread_id, run_id)
        status = run.get("status") if isinstance(run, Mapping) else None
        if not isinstance(status, str):
            raise ExternalAgentChildRuntimeError("external child run has no status")
        if status != "success":
            return ChildRunSnapshot(thread_id=thread_id, run_id=run_id, status=status)
        values = await self._state_values(thread_id)
        external_status = values.get("external_status")
        if external_status == "SUCCESS":
            return ChildRunSnapshot(thread_id=thread_id, run_id=run_id, status="success")
        failure_code = values.get("failure_code")
        failure_class = values.get("failure_class")
        return ChildRunSnapshot(
            thread_id=thread_id,
            run_id=run_id,
            status="error",
            failure_code=failure_code if isinstance(failure_code, str) else "EXTERNAL_AGENT_RESULT_MISSING",
            failure_class=failure_class if isinstance(failure_class, str) else None,
        )

    async def read_thread(self, thread_id: str) -> ThreadSnapshot:
        thread = await self._client.threads.get(thread_id)
        if not isinstance(thread, Mapping):
            raise ExternalAgentChildRuntimeError("external child thread payload is not a mapping")
        metadata = thread.get("metadata")
        projected = dict(metadata) if isinstance(metadata, Mapping) else {}
        values = await self._state_values(thread_id)
        if values.get("external_status") == "SUCCESS":
            pr_url = values.get("pr_url")
            pr_number = values.get("pr_number")
            head_ref = values.get("head_ref")
            base_ref = values.get("base_ref")
            if (
                isinstance(pr_url, str)
                and pr_url
                and isinstance(pr_number, int)
                and pr_number > 0
                and isinstance(head_ref, str)
                and head_ref
                and isinstance(base_ref, str)
                and base_ref
            ):
                projected["pull_requests"] = [
                    {
                        "url": pr_url,
                        "number": pr_number,
                        "state": "open",
                        "head_ref": head_ref,
                        "base_ref": base_ref,
                    }
                ]
        status = thread.get("status")
        return ThreadSnapshot(
            thread_id=thread_id,
            status=status if isinstance(status, str) else "unknown",
            metadata=projected,
        )

    async def _state_values(self, thread_id: str) -> Mapping[str, Any]:
        state = await self._client.threads.get_state(thread_id)
        if not isinstance(state, Mapping):
            return {}
        values = state.get("values")
        return values if isinstance(values, Mapping) else {}


__all__ = [
    "ExternalAgentChildRuntime",
    "ExternalAgentChildRuntimeError",
    "external_implementation_thread_id",
]
