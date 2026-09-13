from __future__ import annotations

import importlib.util
import os
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType

import pytest

ROOT = Path(__file__).resolve().parents[1]
GATE_PATH = ROOT / "deploy/gcp-dev/run-pr-review-gate.py"


def _load_gate() -> ModuleType:
    spec = importlib.util.spec_from_file_location("forgeflow_review_gate_test", GATE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@dataclass
class FakeThreads:
    record: dict

    async def get(self, _thread_id: str):
        return self.record


@dataclass
class FakeRuns:
    record: dict
    requested: list[tuple[str, str]] = field(default_factory=list)

    async def get(self, thread_id: str, run_id: str):
        self.requested.append((thread_id, run_id))
        return self.record


@dataclass
class FakeClient:
    threads: FakeThreads
    runs: FakeRuns


def test_load_github_app_env_is_minimal_and_handles_shell_quotes(tmp_path: Path, monkeypatch) -> None:
    gate = _load_gate()
    for key in gate._GITHUB_APP_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.delenv("GITHUB_APP_CLIENT_SECRET", raising=False)
    (tmp_path / "github-app.env").write_text(
        "GITHUB_APP_ID=123\n"
        "GITHUB_APP_CLIENT_SECRET=do-not-load-this\n"
        "GITHUB_APP_PRIVATE_KEY='line1\\nline2'\n"
        "GITHUB_APP_INSTALLATION_ID=456\n",
        encoding="utf-8",
    )

    gate._load_github_app_env(tmp_path)

    assert os.environ["GITHUB_APP_ID"] == "123"
    assert os.environ["GITHUB_APP_PRIVATE_KEY"] == "line1\\nline2"
    assert os.environ["GITHUB_APP_INSTALLATION_ID"] == "456"
    assert "GITHUB_APP_CLIENT_SECRET" not in os.environ


def test_load_github_app_env_fails_closed_when_required_value_missing(
    tmp_path: Path, monkeypatch
) -> None:
    gate = _load_gate()
    for key in gate._GITHUB_APP_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    (tmp_path / "github-app.env").write_text(
        "GITHUB_APP_ID=123\nGITHUB_APP_PRIVATE_KEY='key'\n",
        encoding="utf-8",
    )

    with pytest.raises(gate.ReviewGateError, match="REVIEW_GATE_GITHUB_APP_ENV_INCOMPLETE"):
        gate._load_github_app_env(tmp_path)


@pytest.mark.asyncio
async def test_adopt_rejects_stale_run_even_when_thread_head_was_updated() -> None:
    gate = _load_gate()
    head = "a" * 40
    client = FakeClient(
        threads=FakeThreads(
            {"metadata": {"head_sha": head, "current_reviewer_run_id": "old-run"}}
        ),
        runs=FakeRuns({"metadata": {"head_sha": "b" * 40}, "status": "success"}),
    )

    adopted = await gate._adopt_current_exact_head(
        client, owner="o", repo="r", pr_number=1, head_sha=head
    )

    assert adopted is None
    assert client.runs.requested


@pytest.mark.asyncio
async def test_adopt_accepts_run_bound_to_exact_current_head() -> None:
    gate = _load_gate()
    head = "a" * 40
    client = FakeClient(
        threads=FakeThreads(
            {"metadata": {"head_sha": head, "current_reviewer_run_id": "current-run"}}
        ),
        runs=FakeRuns({"metadata": {"head_sha": head}, "status": "running"}),
    )

    adopted = await gate._adopt_current_exact_head(
        client, owner="o", repo="r", pr_number=1, head_sha=head
    )

    assert adopted is not None
    assert adopted[1] == "current-run"
