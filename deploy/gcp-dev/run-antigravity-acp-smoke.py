#!/usr/bin/env python3
"""GCP Dev wrapper for the real account-authenticated Antigravity ACP smoke."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from dataclasses import asdict
from pathlib import Path

from acp.exceptions import RequestError

from forgeflow.external_agents.acp import python_module_command
from openswe_ext.external_agent_smoke import CodingSmokeError, run_disposable_coding_smoke


def _failure(code: str, *, detail: str | None = None) -> None:
    payload = {"status": "BLOCKED", "failure_code": code}
    if detail:
        payload["detail"] = detail
    print(json.dumps(payload, sort_keys=True))


async def _run() -> int:
    agy_bin = os.environ.get("FORGEFLOW_ANTIGRAVITY_BIN", str(Path.home() / ".local/bin/agy"))
    model = os.environ.get("FORGEFLOW_ANTIGRAVITY_MODEL", "gemini-3.8-flash-high")
    effort = os.environ.get("FORGEFLOW_ANTIGRAVITY_EFFORT", "high")
    timeout = os.environ.get("FORGEFLOW_ANTIGRAVITY_PRINT_TIMEOUT", "20m")
    command, prefix = python_module_command("openswe_ext.antigravity_acp")

    # Never point a writable external agent at the live project checkout. Real
    # project execution will later create disposable worktrees below this root.
    temp_root = Path.home() / ".local/share/forgeflow-policy/external-agent-workspaces"
    temp_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp_root.chmod(0o700)
    args = (
        *prefix,
        "--agy-bin",
        agy_bin,
        "--allowed-root",
        str(temp_root),
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
        str(Path.home() / ".gemini/antigravity-cli"),
    )
    prompt = (
        "This is a disposable ForgeFlow coding smoke. Modify only calc.py so add_one(value) "
        "returns the input plus one. Do not modify test_calc.py, do not add dependencies, and do "
        "not create a git commit. Keep the implementation minimal. ForgeFlow will run the "
        "verification command independently after your turn."
    )
    try:
        evidence = await run_disposable_coding_smoke(
            agent_command=command,
            agent_args=args,
            runtime_label="antigravity",
            prompt=prompt,
            temp_root=temp_root,
        )
    except RequestError as exc:
        data = exc.data if isinstance(exc.data, dict) else {}
        failure_code = data.get("code")
        detail = None
        actions = data.get("actions")
        if isinstance(actions, list) and all(isinstance(item, str) for item in actions):
            detail = "actions=" + ",".join(actions)
        _failure(
            failure_code if isinstance(failure_code, str) else "ANTIGRAVITY_ACP_REQUEST_FAILED",
            detail=detail,
        )
        return 2
    except CodingSmokeError as exc:
        _failure(str(exc).split(":", 1)[0])
        return 2

    print(json.dumps({"status": "PASS", "evidence": asdict(evidence)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(_run()))
