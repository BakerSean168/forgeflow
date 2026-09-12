from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import pytest
from acp.exceptions import RequestError

from forgeflow.external_agents.acp import python_module_command, run_acp_agent

FAKE_AGY = r"""#!/usr/bin/env python3
import json, sys, uuid
conversation = str(uuid.uuid4())
for raw in sys.stdin:
    try:
        item = json.loads(raw)
    except json.JSONDecodeError:
        continue
    if item.get("event") != "user":
        continue
    text = item.get("message", {}).get("content", "")
    print(json.dumps({"event":"init","init":{"model":"fake-antigravity"}}), flush=True)
    if text == "BLOCK":
        import time
        time.sleep(30)
    if text == "DENY":
        print(json.dumps({"event":"result","result":{"status":"SUCCESS","response":"","conversation_id":conversation,"denied_actions":[{"action":"read_file","display_name":"ListDir","target":"/secret/path"}]}}), flush=True)
        continue
    response = "FAKE_AGY:" + text
    print(json.dumps({"event":"step_update","step_update":{"step_type":"agent_response","text_delta":response}}), flush=True)
    print(json.dumps({"event":"result","result":{"status":"SUCCESS","response":response,"conversation_id":conversation}}), flush=True)
"""


def _fake_agy(tmp_path: Path) -> Path:
    executable = tmp_path / "fake-agy"
    executable.write_text(FAKE_AGY, encoding="utf-8")
    executable.chmod(0o700)
    return executable


def _bridge_args(workspace: Path, fake_agy: Path) -> tuple[str, ...]:
    _, prefix = python_module_command("openswe_ext.antigravity_acp")
    return (
        *prefix,
        "--agy-bin",
        str(fake_agy),
        "--allowed-root",
        str(workspace),
        "--model",
        "fake-model",
        "--effort",
        "high",
        "--mode",
        "plan",
        "--no-sandbox",
    )


def test_acp_bridge_streams_antigravity_response_and_metadata(tmp_path: Path) -> None:
    fake = _fake_agy(tmp_path)
    workspace = tmp_path / "repo"
    workspace.mkdir()
    command, _ = python_module_command("openswe_ext.antigravity_acp")

    result = asyncio.run(
        run_acp_agent(
            command=command,
            args=_bridge_args(workspace, fake),
            cwd=workspace,
            prompt="hello",
        )
    )

    assert result.stop_reason == "end_turn"
    assert result.text == "FAKE_AGY:hello"
    assert result.metadata["runtime"] == "antigravity"
    assert result.metadata["model"] == "fake-model"
    assert result.metadata["conversation_id"]


def test_acp_bridge_rejects_workspace_outside_allowed_root(tmp_path: Path) -> None:
    fake = _fake_agy(tmp_path)
    allowed = tmp_path / "allowed"
    denied = tmp_path / "denied"
    allowed.mkdir()
    denied.mkdir()
    command, prefix = python_module_command("openswe_ext.antigravity_acp")
    args = (
        *prefix,
        "--agy-bin",
        str(fake),
        "--allowed-root",
        str(allowed),
        "--mode",
        "plan",
        "--no-sandbox",
    )

    with pytest.raises(RequestError) as captured:
        asyncio.run(run_acp_agent(command=command, args=args, cwd=denied, prompt="should fail"))
    assert captured.value.code == -32602
    assert captured.value.data == {"code": "ANTIGRAVITY_WORKSPACE_NOT_ALLOWED"}


def test_acp_client_rejects_empty_prompt_before_spawning(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="ACP_PROMPT_EMPTY"):
        asyncio.run(
            run_acp_agent(
                command=sys.executable,
                args=("-c", "raise SystemExit(9)"),
                cwd=tmp_path,
                prompt="   ",
            )
        )


def test_antigravity_bridge_does_not_require_api_key_env() -> None:
    source = Path("openswe_ext/antigravity_acp.py").read_text(encoding="utf-8")
    assert "ANTIGRAVITY_API_KEY" not in source
    assert "GEMINI_API_KEY" not in source
    assert "--input-format" in source
    assert "stream-json" in source
    assert "--allowed-root" in source
    assert "--dangerously-skip-permissions" not in source
    assert os.path.basename(source) != "auth.json"


def test_deployment_configures_antigravity_acp_but_keeps_it_disabled() -> None:
    start = Path("deploy/gcp-dev/start-forgeflow-policy.sh").read_text(encoding="utf-8")
    assert (
        'FORGEFLOW_ANTIGRAVITY_ACP_ENABLED="${FORGEFLOW_ANTIGRAVITY_ACP_ENABLED:-false}"' in start
    )
    assert 'FORGEFLOW_ANTIGRAVITY_BIN="${FORGEFLOW_ANTIGRAVITY_BIN:-$HOME/.local/bin/agy}"' in start
    assert (
        'FORGEFLOW_ANTIGRAVITY_MODEL="${FORGEFLOW_ANTIGRAVITY_MODEL:-gemini-3.8-flash-high}"'
        in start
    )
    assert 'FORGEFLOW_ANTIGRAVITY_EFFORT="${FORGEFLOW_ANTIGRAVITY_EFFORT:-high}"' in start
    assert 'FORGEFLOW_ANTIGRAVITY_MODE="${FORGEFLOW_ANTIGRAVITY_MODE:-accept-edits}"' in start


def test_acp_cancel_terminates_active_antigravity_turn(tmp_path: Path) -> None:
    from acp import PROTOCOL_VERSION, spawn_agent_process
    from acp.helpers import text_block
    from acp.schema import Implementation

    class Client:
        async def session_update(self, session_id, update, **kwargs):
            del session_id, update, kwargs

    fake = _fake_agy(tmp_path)
    workspace = tmp_path / "cancel-repo"
    workspace.mkdir()
    command, _ = python_module_command("openswe_ext.antigravity_acp")

    async def run() -> str:
        async with spawn_agent_process(
            Client(), command, *_bridge_args(workspace, fake), cwd=workspace, env=os.environ.copy()
        ) as (connection, _process):
            await connection.initialize(
                protocol_version=PROTOCOL_VERSION,
                client_info=Implementation(name="forgeflow-test", version="1"),
            )
            session = await connection.new_session(cwd=str(workspace), mcp_servers=[])
            turn = asyncio.create_task(
                connection.prompt(session_id=session.session_id, prompt=[text_block("BLOCK")])
            )
            await asyncio.sleep(0.2)
            await connection.cancel(session_id=session.session_id)
            response = await asyncio.wait_for(turn, timeout=5)
            return response.stop_reason

    assert asyncio.run(run()) == "cancelled"


def test_antigravity_child_environment_drops_unrelated_service_secrets() -> None:
    from openswe_ext.antigravity_acp import _agy_environment

    child = _agy_environment(
        {
            "HOME": "/home/dev",
            "PATH": "/usr/bin",
            "LANG": "C.UTF-8",
            "FIREWORKS_API_KEY": "must-not-leak",
            "GITHUB_APP_PRIVATE_KEY": "must-not-leak",
            "OPEN_SWE_CODEX_BROKER_TOKEN": "must-not-leak",
            "OPENAI_API_KEY": "must-not-leak",
        }
    )
    assert child == {"HOME": "/home/dev", "PATH": "/usr/bin", "LANG": "C.UTF-8"}


def test_acp_bridge_surfaces_soft_denied_tools_as_structured_failure(tmp_path: Path) -> None:
    fake = _fake_agy(tmp_path)
    workspace = tmp_path / "denied-repo"
    workspace.mkdir()
    command, _ = python_module_command("openswe_ext.antigravity_acp")

    with pytest.raises(RequestError) as captured:
        asyncio.run(
            run_acp_agent(
                command=command,
                args=_bridge_args(workspace, fake),
                cwd=workspace,
                prompt="DENY",
            )
        )
    assert captured.value.code == -32010
    assert captured.value.data == {
        "code": "ANTIGRAVITY_TOOL_PERMISSION_DENIED",
        "actions": ["read_file"],
    }
    assert "/secret/path" not in str(captured.value.data)
