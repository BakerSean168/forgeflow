"""ACP bridge for the authenticated Antigravity headless agent (`agy`)."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import shutil
import signal
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from acp import PROTOCOL_VERSION, run_agent
from acp.exceptions import RequestError
from acp.helpers import update_agent_message_text
from acp.schema import (
    AgentCapabilities,
    Implementation,
    InitializeResponse,
    NewSessionResponse,
    PromptResponse,
)

from openswe_ext.external_agent_docker import (
    CONTAINER_HOME,
    ExternalAgentDockerError,
    ExternalAgentDockerSandbox,
)

LOGGER = logging.getLogger("forgeflow.antigravity_acp")
MAX_EVENT_BYTES = 4 * 1024 * 1024
MAX_PROMPT_CHARS = 200_000
AGY_ENV_ALLOWLIST = frozenset(
    {
        "HOME",
        "USER",
        "LOGNAME",
        "PATH",
        "SHELL",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TERM",
        "TMPDIR",
        "TZ",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
    }
)


class AntigravityBridgeError(RuntimeError):
    pass


@dataclass(slots=True)
class _Session:
    cwd: Path
    process: asyncio.subprocess.Process | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    cancelled: asyncio.Event = field(default_factory=asyncio.Event)
    conversation_id: str | None = None
    outer_sandbox: ExternalAgentDockerSandbox | None = None


class AntigravityAcpAgent:
    """Translate ACP sessions into persistent `agy` stream-json sessions."""

    def __init__(
        self,
        *,
        client: Any,
        agy_bin: Path,
        model: str,
        effort: str,
        mode: str,
        allowed_roots: Sequence[Path],
        sandbox: bool,
        print_timeout: str,
        outer_sandbox: str = "host",
        auth_state_dir: Path | None = None,
        docker_image: str = "forgeflow/openswe-sandbox:bookworm-node24",
    ) -> None:
        self._client = client
        self._agy_bin = agy_bin
        self._model = model
        self._effort = effort
        self._mode = mode
        self._allowed_roots = tuple(root.resolve(strict=True) for root in allowed_roots)
        self._sandbox = sandbox
        self._print_timeout = print_timeout
        self._outer_sandbox = outer_sandbox
        self._auth_state_dir = auth_state_dir
        self._docker_image = docker_image
        self._sessions: dict[str, _Session] = {}

    async def initialize(
        self,
        protocol_version: int,
        client_capabilities: Any = None,
        client_info: Any = None,
        **_: Any,
    ) -> InitializeResponse:
        del client_capabilities, client_info
        if protocol_version != PROTOCOL_VERSION:
            raise AntigravityBridgeError("ACP_PROTOCOL_VERSION_UNSUPPORTED")
        return InitializeResponse(
            protocolVersion=PROTOCOL_VERSION,
            agentCapabilities=AgentCapabilities(loadSession=False),
            authMethods=[],
            agentInfo=Implementation(
                name="forgeflow-antigravity",
                title="ForgeFlow Antigravity ACP Bridge",
                version="0.1.0",
            ),
        )

    async def new_session(
        self,
        cwd: str,
        additional_directories: list[str] | None = None,
        mcp_servers: list[Any] | None = None,
        **_: Any,
    ) -> NewSessionResponse:
        if additional_directories:
            raise RequestError.invalid_params(
                {"code": "ANTIGRAVITY_ADDITIONAL_DIRECTORIES_UNSUPPORTED"}
            )
        if mcp_servers:
            raise RequestError.invalid_params({"code": "ANTIGRAVITY_ACP_MCP_UNSUPPORTED"})
        workspace = self._validate_workspace(Path(cwd))
        session_id = str(uuid.uuid4())
        self._sessions[session_id] = _Session(cwd=workspace)
        return NewSessionResponse(sessionId=session_id)

    async def prompt(self, session_id: str, prompt: list[Any], **_: Any) -> PromptResponse:
        session = self._sessions.get(session_id)
        if session is None:
            raise AntigravityBridgeError("ANTIGRAVITY_SESSION_NOT_FOUND")
        text = self._prompt_text(prompt)
        async with session.lock:
            session.cancelled.clear()
            process = await self._ensure_process(session)
            if process.stdin is None or process.stdout is None:
                raise AntigravityBridgeError("ANTIGRAVITY_STREAM_UNAVAILABLE")
            request = {"event": "user", "message": {"content": text}}
            process.stdin.write((json.dumps(request, separators=(",", ":")) + "\n").encode())
            await process.stdin.drain()

            response_parts: list[str] = []
            while True:
                line = await process.stdout.readline()
                if not line:
                    if session.cancelled.is_set():
                        return PromptResponse(stopReason="cancelled")
                    stderr = await self._safe_stderr(process)
                    raise AntigravityBridgeError(
                        "ANTIGRAVITY_PROCESS_EXITED" + (f":{stderr}" if stderr else "")
                    )
                if len(line) > MAX_EVENT_BYTES:
                    await self._terminate(session)
                    raise AntigravityBridgeError("ANTIGRAVITY_EVENT_TOO_LARGE")
                event = self._event(line)
                kind = event.get("event")
                if kind == "init":
                    continue
                if kind == "step_update":
                    update = event.get("step_update")
                    if not isinstance(update, dict):
                        continue
                    if update.get("step_type") != "agent_response":
                        continue
                    delta = update.get("text_delta")
                    if isinstance(delta, str) and delta:
                        response_parts.append(delta)
                        await self._client.session_update(
                            session_id=session_id,
                            update=update_agent_message_text(delta),
                        )
                    continue
                if kind != "result":
                    continue
                result = event.get("result")
                if not isinstance(result, dict):
                    raise AntigravityBridgeError("ANTIGRAVITY_RESULT_INVALID")
                conversation_id = result.get("conversation_id")
                if isinstance(conversation_id, str) and conversation_id:
                    session.conversation_id = conversation_id
                denied_actions = _denied_action_names(result.get("denied_actions"))
                if denied_actions:
                    raise RequestError(
                        -32010,
                        "External agent tool permission denied",
                        {
                            "code": "ANTIGRAVITY_TOOL_PERMISSION_DENIED",
                            "actions": list(denied_actions),
                        },
                    )
                status = str(result.get("status") or "").upper()
                if status == "SUCCESS":
                    if not response_parts:
                        response = result.get("response")
                        if isinstance(response, str) and response:
                            response_parts.append(response)
                            await self._client.session_update(
                                session_id=session_id,
                                update=update_agent_message_text(response),
                            )
                    return PromptResponse(
                        stopReason="end_turn",
                        _meta={
                            "runtime": "antigravity",
                            "model": self._model,
                            "conversation_id": session.conversation_id,
                        },
                    )
                if session.cancelled.is_set():
                    return PromptResponse(stopReason="cancelled")
                raise AntigravityBridgeError(f"ANTIGRAVITY_RESULT_{status or 'FAILED'}")

    async def cancel(self, session_id: str, **_: Any) -> None:
        session = self._sessions.get(session_id)
        if session is None:
            return
        session.cancelled.set()
        await self._terminate(session)

    async def close(self) -> None:
        for session in list(self._sessions.values()):
            await self._terminate(session)
        self._sessions.clear()

    def _validate_workspace(self, value: Path) -> Path:
        workspace = value.resolve(strict=True)
        if not workspace.is_dir():
            raise RequestError.invalid_params({"code": "ANTIGRAVITY_WORKSPACE_NOT_DIRECTORY"})
        if not self._allowed_roots:
            raise RequestError.invalid_params({"code": "ANTIGRAVITY_ALLOWED_ROOT_REQUIRED"})
        for root in self._allowed_roots:
            if workspace == root or root in workspace.parents:
                return workspace
        raise RequestError.invalid_params({"code": "ANTIGRAVITY_WORKSPACE_NOT_ALLOWED"})

    @staticmethod
    def _prompt_text(prompt: list[Any]) -> str:
        parts: list[str] = []
        for block in prompt:
            if getattr(block, "type", None) != "text":
                raise RequestError.invalid_params({"code": "ANTIGRAVITY_TEXT_PROMPT_ONLY"})
            text = getattr(block, "text", None)
            if not isinstance(text, str):
                raise RequestError.invalid_params({"code": "ANTIGRAVITY_PROMPT_INVALID"})
            parts.append(text)
        merged = "\n".join(parts).strip()
        if not merged:
            raise RequestError.invalid_params({"code": "ANTIGRAVITY_PROMPT_EMPTY"})
        if len(merged) > MAX_PROMPT_CHARS:
            raise RequestError.invalid_params({"code": "ANTIGRAVITY_PROMPT_TOO_LARGE"})
        return merged

    async def _ensure_process(self, session: _Session) -> asyncio.subprocess.Process:
        if session.process is not None and session.process.returncode is None:
            return session.process
        args = [
            str(self._agy_bin),
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--mode",
            self._mode,
            "--model",
            self._model,
            "--effort",
            self._effort,
            "--print-timeout",
            self._print_timeout,
            "--disable-slash-commands",
        ]
        if self._sandbox:
            args.append("--sandbox")
        if self._outer_sandbox == "docker":
            # Antigravity headless permission matching is not reliable enough for
            # unattended coding. Broad approval is permitted only after adding
            # ForgeFlow's outer Docker isolation; the bootstrap turn is tool-free
            # and auth is unmounted before the real task prompt is sent.
            args.append("--dangerously-skip-permissions")
            auth_state = self._auth_state_dir
            if auth_state is None:
                raise AntigravityBridgeError("ANTIGRAVITY_AUTH_STATE_REQUIRED")
            sandbox = ExternalAgentDockerSandbox(
                workspace=session.cwd,
                executable=self._agy_bin,
                bootstrap_dir=auth_state,
                image=self._docker_image,
            )
            try:
                await sandbox.start()
                settings = {
                    "permissions": {
                        "allow": [
                            "read_file(*)",
                            "write_file(/workspace)",
                            "command(*)",
                        ],
                        "deny": [
                            "read_url(*)",
                            "execute_url(*)",
                            "mcp(*)",
                            "unsandboxed(*)",
                        ],
                    },
                    "trustedWorkspaces": ["/workspace"],
                }
                await sandbox.write_text(
                    f"{CONTAINER_HOME}/.gemini/antigravity-cli/settings.json",
                    json.dumps(settings, sort_keys=True) + "\n",
                )
                await sandbox.symlink_bootstrap_file(
                    source_name="antigravity-oauth-token",
                    destination=(
                        f"{CONTAINER_HOME}/.gemini/antigravity-cli/antigravity-oauth-token"
                    ),
                )
                container_args = args[1:]
                process = await sandbox.start_process(container_args)
                session.outer_sandbox = sandbox
                session.process = process
                await self._bootstrap_and_seal(session)
                return process
            except ExternalAgentDockerError as exc:
                await sandbox.close()
                session.outer_sandbox = None
                session.process = None
                code = str(exc).split(":", 1)[0]
                raise RequestError(
                    -32011,
                    "External agent sandbox unavailable",
                    {"code": code},
                ) from exc
            except AntigravityBridgeError as exc:
                await sandbox.close()
                session.outer_sandbox = None
                session.process = None
                code = str(exc).split(":", 1)[0]
                raise RequestError(
                    -32012,
                    "Antigravity bootstrap failed",
                    {"code": code},
                ) from exc
            except Exception:
                await sandbox.close()
                session.outer_sandbox = None
                session.process = None
                raise

        process = await asyncio.create_subprocess_exec(
            *args,
            cwd=session.cwd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=_agy_environment(),
            start_new_session=True,
        )
        session.process = process
        return process

    async def _bootstrap_and_seal(self, session: _Session) -> None:
        process = session.process
        sandbox = session.outer_sandbox
        if process is None or process.stdin is None or process.stdout is None or sandbox is None:
            raise AntigravityBridgeError("ANTIGRAVITY_BOOTSTRAP_STREAM_UNAVAILABLE")
        request = {
            "event": "user",
            "message": {
                "content": (
                    "ForgeFlow runtime bootstrap. Reply exactly FORGEFLOW_RUNTIME_READY. "
                    "Do not use any tools."
                )
            },
        }
        process.stdin.write((json.dumps(request, separators=(",", ":")) + "\n").encode())
        await process.stdin.drain()
        while True:
            try:
                line = await asyncio.wait_for(process.stdout.readline(), timeout=90)
            except TimeoutError as exc:
                raise AntigravityBridgeError("ANTIGRAVITY_TIMEOUT") from exc
            if not line:
                raise AntigravityBridgeError("ANTIGRAVITY_BOOTSTRAP_PROCESS_EXITED")
            event = self._event(line)
            kind = event.get("event")
            if kind == "init":
                continue
            if kind == "step_update":
                update = event.get("step_update")
                step_type = update.get("step_type") if isinstance(update, dict) else None
                if step_type in {"user_input", "agent_response"}:
                    continue
                raise AntigravityBridgeError("ANTIGRAVITY_BOOTSTRAP_TOOL_ACTIVITY")
            if kind != "result":
                continue
            result = event.get("result")
            if not isinstance(result, dict):
                raise AntigravityBridgeError("ANTIGRAVITY_BOOTSTRAP_RESULT_INVALID")
            if _denied_action_names(result.get("denied_actions")):
                raise AntigravityBridgeError("ANTIGRAVITY_BOOTSTRAP_PERMISSION_DENIED")
            if str(result.get("status") or "").upper() != "SUCCESS":
                raise AntigravityBridgeError("ANTIGRAVITY_BOOTSTRAP_FAILED")
            response = result.get("response")
            if not isinstance(response, str) or "FORGEFLOW_RUNTIME_READY" not in response:
                raise AntigravityBridgeError("ANTIGRAVITY_BOOTSTRAP_MARKER_MISSING")
            conversation_id = result.get("conversation_id")
            if isinstance(conversation_id, str) and conversation_id:
                session.conversation_id = conversation_id
            break
        await sandbox.seal_bootstrap()
        await sandbox.exec(
            "rm",
            "-f",
            f"{CONTAINER_HOME}/.gemini/antigravity-cli/antigravity-oauth-token",
        )

    async def _terminate(self, session: _Session) -> None:
        process = session.process
        if session.outer_sandbox is not None:
            await session.outer_sandbox.close()
            session.outer_sandbox = None
            if process is not None and process.returncode is None:
                try:
                    await asyncio.wait_for(process.wait(), timeout=5)
                except TimeoutError:
                    process.kill()
                    await process.wait()
            return
        if process is None or process.returncode is not None:
            return
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except TimeoutError:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            await process.wait()

    @staticmethod
    async def _safe_stderr(process: asyncio.subprocess.Process) -> str:
        if process.stderr is None:
            return ""
        try:
            raw = await asyncio.wait_for(process.stderr.read(4096), timeout=1)
        except TimeoutError:
            return ""
        # Keep ACP/stdout secret-free. stderr is reduced to one bounded line and
        # obvious bearer/API-key material is never reflected into protocol data.
        text = raw.decode(errors="replace").replace("\n", " ").strip()
        lowered = text.lower()
        if any(token in lowered for token in ("bearer ", "api_key", "api-key", "access_token")):
            return "<redacted>"
        return text[:500]

    @staticmethod
    def _event(line: bytes) -> dict[str, Any]:
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as exc:
            raise AntigravityBridgeError("ANTIGRAVITY_EVENT_INVALID_JSON") from exc
        if not isinstance(payload, dict):
            raise AntigravityBridgeError("ANTIGRAVITY_EVENT_INVALID")
        return payload


def _agy_environment(source: dict[str, str] | None = None) -> dict[str, str]:
    current = os.environ if source is None else source
    return {key: value for key, value in current.items() if key in AGY_ENV_ALLOWLIST}


def _denied_action_names(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    names: list[str] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        action = item.get("action")
        if isinstance(action, str) and action.strip():
            names.append(action.strip())
    return tuple(dict.fromkeys(names))


def _resolve_executable(value: str) -> Path:
    expanded = Path(value).expanduser()
    if expanded.parent != Path(".") or expanded.is_absolute():
        resolved = expanded.resolve(strict=True)
    else:
        located = shutil.which(value)
        if not located:
            raise AntigravityBridgeError("ANTIGRAVITY_BINARY_NOT_FOUND")
        resolved = Path(located).resolve(strict=True)
    if not resolved.is_file() or not os.access(resolved, os.X_OK):
        raise AntigravityBridgeError("ANTIGRAVITY_BINARY_NOT_EXECUTABLE")
    return resolved


async def _serve(args: argparse.Namespace) -> None:
    agy_bin = _resolve_executable(args.agy_bin)
    roots = [Path(value).expanduser() for value in args.allowed_root]
    holder: dict[str, AntigravityAcpAgent] = {}

    def factory(client: Any) -> AntigravityAcpAgent:
        agent = AntigravityAcpAgent(
            client=client,
            agy_bin=agy_bin,
            model=args.model,
            effort=args.effort,
            mode=args.mode,
            allowed_roots=roots,
            sandbox=args.sandbox,
            print_timeout=args.print_timeout,
            outer_sandbox=args.outer_sandbox,
            auth_state_dir=(
                Path(args.auth_state_dir).expanduser() if args.auth_state_dir else None
            ),
            docker_image=args.docker_image,
        )
        holder["agent"] = agent
        return agent

    try:
        await run_agent(factory)
    finally:
        agent = holder.get("agent")
        if agent is not None:
            await agent.close()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="ForgeFlow ACP bridge for Antigravity")
    parser.add_argument("--agy-bin", default=os.environ.get("FORGEFLOW_ANTIGRAVITY_BIN", "agy"))
    parser.add_argument(
        "--model",
        default=os.environ.get("FORGEFLOW_ANTIGRAVITY_MODEL", "gemini-3.8-flash-high"),
    )
    parser.add_argument(
        "--effort",
        choices=("low", "medium", "high"),
        default=os.environ.get("FORGEFLOW_ANTIGRAVITY_EFFORT", "high"),
    )
    parser.add_argument(
        "--mode",
        choices=("plan", "accept-edits", "request-review"),
        default=os.environ.get("FORGEFLOW_ANTIGRAVITY_MODE", "accept-edits"),
    )
    parser.add_argument(
        "--print-timeout",
        default=os.environ.get("FORGEFLOW_ANTIGRAVITY_PRINT_TIMEOUT", "20m"),
    )
    parser.add_argument("--allowed-root", action="append", required=True)
    parser.add_argument("--sandbox", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument(
        "--outer-sandbox",
        choices=("host", "docker"),
        default=os.environ.get("FORGEFLOW_EXTERNAL_AGENT_OUTER_SANDBOX", "host"),
    )
    parser.add_argument(
        "--auth-state-dir",
        default=os.environ.get("FORGEFLOW_ANTIGRAVITY_AUTH_STATE_DIR"),
    )
    parser.add_argument(
        "--docker-image",
        default=os.environ.get(
            "FORGEFLOW_EXTERNAL_AGENT_DOCKER_IMAGE",
            "forgeflow/openswe-sandbox:bookworm-node24",
        ),
    )
    return parser


def main() -> None:
    logging.basicConfig(level=logging.INFO, stream=os.sys.stderr)
    args = _parser().parse_args()
    asyncio.run(_serve(args))


if __name__ == "__main__":
    main()
