"""Disposable coding smoke harness for ACP-backed external agents.

This module lives outside the pure ForgeFlow policy package because it owns a
throwaway Git workspace and executes test commands. It is intentionally small:
the smoke proves an ACP agent can make a bounded edit while ForgeFlow derives
revision and test evidence independently from the agent's prose.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from forgeflow.external_agents.acp import run_acp_agent


@dataclass(frozen=True, slots=True)
class CodingSmokeEvidence:
    runtime: str
    model: str | None
    base_revision: str
    result_revision: str
    changed_files: tuple[str, ...]
    diff_sha256: str
    test_command: tuple[str, ...]
    test_exit_code: int
    acp_session_id: str
    external_conversation_id: str | None
    agent_stop_reason: str
    workspace_removed: bool


class CodingSmokeError(RuntimeError):
    pass


def _run_git(workspace: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=workspace,
        check=check,
        text=True,
        capture_output=True,
        env={**os.environ, "LC_ALL": "C.UTF-8"},
    )


def _initialize_fixture(workspace: Path) -> str:
    (workspace / "calc.py").write_text(
        "def add_one(value: int) -> int:\n    return value\n",
        encoding="utf-8",
    )
    (workspace / "test_calc.py").write_text(
        "import unittest\n\n"
        "from calc import add_one\n\n\n"
        "class AddOneTest(unittest.TestCase):\n"
        "    def test_add_one(self) -> None:\n"
        "        self.assertEqual(add_one(41), 42)\n\n\n"
        "if __name__ == '__main__':\n"
        "    unittest.main()\n",
        encoding="utf-8",
    )
    _run_git(workspace, "init", "-q", "-b", "main")
    _run_git(workspace, "config", "user.name", "ForgeFlow Smoke")
    _run_git(workspace, "config", "user.email", "forgeflow-smoke@example.invalid")
    _run_git(workspace, "add", "calc.py", "test_calc.py")
    _run_git(workspace, "commit", "-q", "-m", "test: establish external-agent smoke fixture")
    return _run_git(workspace, "rev-parse", "HEAD").stdout.strip()


def _changed_files(workspace: Path) -> tuple[str, ...]:
    tracked = _run_git(
        workspace, "diff", "--name-only", "--diff-filter=ACMRTUXB", "HEAD"
    ).stdout.splitlines()
    untracked = _run_git(
        workspace, "ls-files", "--others", "--exclude-standard"
    ).stdout.splitlines()
    paths = [line.strip() for line in (*tracked, *untracked) if line.strip()]
    return tuple(sorted(dict.fromkeys(paths)))


def _diff_digest(workspace: Path) -> str:
    diff = subprocess.run(
        ["git", "diff", "--binary", "--no-ext-diff", "HEAD"],
        cwd=workspace,
        check=True,
        capture_output=True,
    ).stdout
    return hashlib.sha256(diff).hexdigest()


def _run_test(workspace: Path, command: tuple[str, ...]) -> int:
    completed = subprocess.run(
        command,
        cwd=workspace,
        check=False,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=60,
        env={
            "HOME": os.environ.get("HOME", ""),
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "LANG": os.environ.get("LANG", "C.UTF-8"),
            "LC_ALL": "C.UTF-8",
            "PYTHONPATH": str(workspace),
            "PYTHONDONTWRITEBYTECODE": "1",
        },
    )
    return completed.returncode


def _commit_result(workspace: Path) -> str:
    _run_git(workspace, "add", "--", "calc.py")
    _run_git(workspace, "commit", "-q", "-m", "test: capture external-agent smoke result")
    return _run_git(workspace, "rev-parse", "HEAD").stdout.strip()


def _assert_clean_host_scope(parent: Path, workspace: Path) -> None:
    try:
        workspace.relative_to(parent)
    except ValueError as exc:
        raise CodingSmokeError("SMOKE_WORKSPACE_OUTSIDE_TEMP_ROOT") from exc


async def run_disposable_coding_smoke(
    *,
    agent_command: str,
    agent_args: tuple[str, ...],
    runtime_label: str,
    prompt: str,
    test_command: tuple[str, ...] = ("python3", "-m", "unittest", "-q"),
    temp_root: Path | None = None,
) -> CodingSmokeEvidence:
    root = (temp_root or Path(tempfile.gettempdir())).resolve(strict=True)
    workspace = Path(tempfile.mkdtemp(prefix="forgeflow-acp-smoke-", dir=root)).resolve(strict=True)
    _assert_clean_host_scope(root, workspace)
    removed = False
    evidence: dict[str, Any] = {}
    try:
        base_revision = _initialize_fixture(workspace)
        result = await run_acp_agent(
            command=agent_command,
            args=agent_args,
            cwd=workspace,
            prompt=prompt,
        )
        if result.stop_reason != "end_turn":
            raise CodingSmokeError(f"SMOKE_AGENT_STOP_{result.stop_reason.upper()}")

        changed_files = _changed_files(workspace)
        if changed_files != ("calc.py",):
            raise CodingSmokeError(f"SMOKE_UNEXPECTED_CHANGED_FILES:{changed_files!r}")
        digest = _diff_digest(workspace)
        test_exit_code = _run_test(workspace, test_command)
        if test_exit_code != 0:
            raise CodingSmokeError(f"SMOKE_TEST_FAILED:{test_exit_code}")
        result_revision = _commit_result(workspace)
        if result_revision == base_revision:
            raise CodingSmokeError("SMOKE_NO_RESULT_REVISION")
        if _run_git(workspace, "status", "--porcelain").stdout.strip():
            raise CodingSmokeError("SMOKE_RESULT_NOT_CLEAN")

        evidence = {
            "runtime": runtime_label,
            "model": result.metadata.get("model")
            if isinstance(result.metadata.get("model"), str)
            else None,
            "base_revision": base_revision,
            "result_revision": result_revision,
            "changed_files": changed_files,
            "diff_sha256": digest,
            "test_command": test_command,
            "test_exit_code": test_exit_code,
            "acp_session_id": result.session_id,
            "external_conversation_id": (
                result.metadata.get("conversation_id")
                if isinstance(result.metadata.get("conversation_id"), str)
                else None
            ),
            "agent_stop_reason": result.stop_reason,
        }
    finally:
        shutil.rmtree(workspace, ignore_errors=False)
        removed = not workspace.exists()

    return CodingSmokeEvidence(**evidence, workspace_removed=removed)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run a disposable ACP external-agent coding smoke")
    parser.add_argument("--agent-command", required=True)
    parser.add_argument("--agent-arg", action="append", default=[])
    parser.add_argument("--runtime-label", required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument(
        "--test-command",
        default="python3 -m unittest -q",
        help="shell-like command parsed with shlex; no shell is executed",
    )
    parser.add_argument("--temp-root")
    return parser


async def _main_async(args: argparse.Namespace) -> int:
    evidence = await run_disposable_coding_smoke(
        agent_command=args.agent_command,
        agent_args=tuple(args.agent_arg),
        runtime_label=args.runtime_label,
        prompt=args.prompt,
        test_command=tuple(shlex.split(args.test_command)),
        temp_root=Path(args.temp_root).expanduser() if args.temp_root else None,
    )
    print(json.dumps(asdict(evidence), sort_keys=True))
    return 0


def main() -> None:
    args = _parser().parse_args()
    raise SystemExit(asyncio.run(_main_async(args)))


if __name__ == "__main__":
    main()
