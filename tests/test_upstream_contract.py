import re
import tomllib
from pathlib import Path

from forgeflow.adapters.openswe import GRAPH_ENTRIES, RunConfig

REPO = Path(__file__).resolve().parents[1]
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def _pinned_shas() -> tuple[str, str, str]:
    marker = (REPO / "UPSTREAM_OPEN_SWE_SHA").read_text(encoding="utf-8").strip()
    pyproject = tomllib.loads((REPO / "pyproject.toml").read_text(encoding="utf-8"))
    dependency = next(
        item for item in pyproject["project"]["dependencies"] if item.startswith("open-swe-agent @ git+")
    )
    pyproject_match = re.search(r"@([0-9a-f]{40})$", dependency)
    if pyproject_match is None:
        raise AssertionError(f"Open SWE pyproject dependency is not exact-SHA pinned: {dependency}")
    pyproject_sha = pyproject_match.group(1)

    lock = (REPO / "uv.lock").read_text(encoding="utf-8")
    source_match = re.search(
        r'git = "https://github\.com/langchain-ai/open-swe\.git\?rev=([0-9a-f]{40})#[0-9a-f]{40}"',
        lock,
    )
    if source_match is None:
        raise AssertionError("uv.lock has no exact Open SWE source revision")
    return marker, pyproject_sha, source_match.group(1)


def test_open_swe_pin_is_exact_and_identical_in_marker_manifest_and_lock() -> None:
    marker, pyproject_sha, lock_sha = _pinned_shas()
    assert SHA_RE.fullmatch(marker)
    assert marker == pyproject_sha == lock_sha


def test_upstream_graph_contracts_import_through_single_adapter() -> None:
    assert set(GRAPH_ENTRIES) == {"agent", "reviewer", "analyzer", "chat", "scheduler"}
    assert all(callable(value) for value in GRAPH_ENTRIES.values())


def test_upstream_run_config_still_accepts_policy_model_and_desktop_fields() -> None:
    parsed = RunConfig.parse(
        {
            "thread_id": "thread",
            "source": "desktop",
            "local_project_path": "/tmp/worktree",
            "agent_model_id": "openai:gpt-5.6-luna",
            "agent_effort": "xhigh",
            "reviewer_model_id": "openai:gpt-5.6-sol",
            "reviewer_reasoning_effort": "medium",
        }
    )
    assert parsed.local_project_path == "/tmp/worktree"
    assert parsed.agent_model_id == "openai:gpt-5.6-luna"
    assert parsed.reviewer_model_id == "openai:gpt-5.6-sol"
