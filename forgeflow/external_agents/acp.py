"""Small ACP client used to invoke an external coding agent as a subprocess."""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from acp import PROTOCOL_VERSION, spawn_agent_process
from acp.helpers import text_block
from acp.schema import AgentMessageChunk, Implementation


@dataclass(frozen=True, slots=True)
class AcpExecutionResult:
    """Normalized evidence returned from one bounded external-agent turn."""

    stop_reason: str
    text: str
    session_id: str
    metadata: Mapping[str, Any]


class _CaptureClient:
    """ACP client endpoint that records only evidence ForgeFlow needs."""

    def __init__(self) -> None:
        self.message_chunks: list[str] = []
        self.metadata: dict[str, Any] = {}

    async def session_update(self, session_id: str, update: Any, **_: Any) -> None:
        if isinstance(update, AgentMessageChunk) and update.content.type == "text":
            self.message_chunks.append(update.content.text)
        field_meta = getattr(update, "field_meta", None)
        if isinstance(field_meta, dict):
            self.metadata.update(field_meta)


async def run_acp_agent(
    *,
    command: str,
    args: Sequence[str],
    cwd: Path,
    prompt: str,
    env: Mapping[str, str] | None = None,
) -> AcpExecutionResult:
    """Spawn one ACP agent, open a session in ``cwd``, and execute one turn.

    The external process receives the normal process environment unless an
    explicit mapping is supplied. No credentials are copied into ACP payloads.
    """

    workspace = cwd.resolve(strict=True)
    if not workspace.is_dir():
        raise ValueError("ACP_WORKSPACE_NOT_DIRECTORY")
    if not prompt.strip():
        raise ValueError("ACP_PROMPT_EMPTY")

    client = _CaptureClient()
    child_env = dict(os.environ) if env is None else dict(env)
    async with spawn_agent_process(
        client,
        command,
        *args,
        cwd=workspace,
        env=child_env,
    ) as (connection, _process):
        await connection.initialize(
            protocol_version=PROTOCOL_VERSION,
            client_info=Implementation(
                name="forgeflow",
                title="ForgeFlow",
                version="2.0.2",
            ),
        )
        session = await connection.new_session(cwd=str(workspace), mcp_servers=[])
        response = await connection.prompt(
            session_id=session.session_id,
            prompt=[text_block(prompt)],
        )
        metadata = dict(response.field_meta or {})
        metadata.update(client.metadata)
        return AcpExecutionResult(
            stop_reason=response.stop_reason,
            text="".join(client.message_chunks),
            session_id=session.session_id,
            metadata=metadata,
        )


def python_module_command(module: str) -> tuple[str, tuple[str, ...]]:
    """Return the current interpreter plus ``-m`` args for an ACP bridge module."""

    return sys.executable, ("-m", module)
