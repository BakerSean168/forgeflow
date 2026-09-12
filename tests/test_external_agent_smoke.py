from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import pytest

from openswe_ext.external_agent_smoke import CodingSmokeError, run_disposable_coding_smoke

FAKE_BRIDGE = r"""#!/usr/bin/env python3
import asyncio
from pathlib import Path
from acp import PROTOCOL_VERSION, run_agent
from acp.helpers import update_agent_message_text
from acp.schema import AgentCapabilities, Implementation, InitializeResponse, NewSessionResponse, PromptResponse

class Agent:
    def __init__(self, client):
        self.client = client
        self.cwd = None
    async def initialize(self, protocol_version, **kwargs):
        assert protocol_version == PROTOCOL_VERSION
        return InitializeResponse(protocolVersion=PROTOCOL_VERSION, agentCapabilities=AgentCapabilities(), authMethods=[], agentInfo=Implementation(name='fake-coder', version='1'))
    async def new_session(self, cwd, **kwargs):
        self.cwd = Path(cwd)
        return NewSessionResponse(sessionId='fake-session')
    async def prompt(self, session_id, prompt, **kwargs):
        mode = os.environ.get('FAKE_SMOKE_MODE', 'good')
        if mode == 'good':
            (self.cwd / 'calc.py').write_text('def add_one(value: int) -> int:\n    return value + 1\n', encoding='utf-8')
        elif mode == 'extra-file':
            (self.cwd / 'calc.py').write_text('def add_one(value: int) -> int:\n    return value + 1\n', encoding='utf-8')
            (self.cwd / 'extra.txt').write_text('bad', encoding='utf-8')
        elif mode == 'bad-test':
            (self.cwd / 'calc.py').write_text('def add_one(value: int) -> int:\n    return value + 2\n', encoding='utf-8')
        await self.client.session_update(session_id=session_id, update=update_agent_message_text('done'))
        return PromptResponse(stopReason='end_turn', _meta={'model':'fake-model','conversation_id':'fake-conversation'})
    async def cancel(self, session_id, **kwargs):
        pass

asyncio.run(run_agent(lambda client: Agent(client)))
"""


def _fake_bridge(tmp_path: Path) -> Path:
    path = tmp_path / "fake_bridge.py"
    path.write_text("import os\n" + FAKE_BRIDGE, encoding="utf-8")
    return path


def test_disposable_smoke_records_independent_git_and_test_evidence(tmp_path: Path) -> None:
    bridge = _fake_bridge(tmp_path)
    smoke_root = tmp_path / "smokes"
    smoke_root.mkdir()
    result = asyncio.run(
        run_disposable_coding_smoke(
            agent_command=sys.executable,
            agent_args=(str(bridge),),
            runtime_label="fake",
            prompt="fix it",
            temp_root=smoke_root,
        )
    )
    assert result.runtime == "fake"
    assert result.model == "fake-model"
    assert result.base_revision != result.result_revision
    assert result.changed_files == ("calc.py",)
    assert len(result.diff_sha256) == 64
    assert result.test_exit_code == 0
    assert result.acp_session_id == "fake-session"
    assert result.external_conversation_id == "fake-conversation"
    assert result.workspace_removed is True
    assert list(smoke_root.iterdir()) == []


def test_disposable_smoke_rejects_unexpected_files_and_still_cleans(tmp_path: Path) -> None:
    bridge = _fake_bridge(tmp_path)
    smoke_root = tmp_path / "smokes"
    smoke_root.mkdir()
    env = os.environ.copy()
    os.environ["FAKE_SMOKE_MODE"] = "extra-file"
    try:
        with pytest.raises(CodingSmokeError, match="SMOKE_UNEXPECTED_CHANGED_FILES"):
            asyncio.run(
                run_disposable_coding_smoke(
                    agent_command=sys.executable,
                    agent_args=(str(bridge),),
                    runtime_label="fake",
                    prompt="fix it",
                    temp_root=smoke_root,
                )
            )
    finally:
        os.environ.clear()
        os.environ.update(env)
    assert list(smoke_root.iterdir()) == []


def test_disposable_smoke_rejects_failed_verification_and_still_cleans(tmp_path: Path) -> None:
    bridge = _fake_bridge(tmp_path)
    smoke_root = tmp_path / "smokes"
    smoke_root.mkdir()
    env = os.environ.copy()
    os.environ["FAKE_SMOKE_MODE"] = "bad-test"
    try:
        with pytest.raises(CodingSmokeError, match="SMOKE_TEST_FAILED"):
            asyncio.run(
                run_disposable_coding_smoke(
                    agent_command=sys.executable,
                    agent_args=(str(bridge),),
                    runtime_label="fake",
                    prompt="fix it",
                    temp_root=smoke_root,
                )
            )
    finally:
        os.environ.clear()
        os.environ.update(env)
    assert list(smoke_root.iterdir()) == []


def test_smoke_wrapper_uses_accept_edits_sandbox_and_no_permission_bypass() -> None:
    text = Path("deploy/gcp-dev/run-antigravity-acp-smoke.py").read_text(encoding="utf-8")
    assert '"accept-edits"' in text
    assert '"--sandbox"' in text
    assert "dangerously-skip-permissions" not in text
    assert "test_calc.py" in text
