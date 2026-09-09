import importlib
import json
from pathlib import Path

from forgeflow.adapters.github import PullRequestEvidence
from forgeflow.adapters.openswe import GRAPH_ENTRIES, implementation_config, reviewer_config

REPO = Path(__file__).resolve().parents[1]
EXPECTED_GRAPHS = {"agent", "reviewer", "analyzer", "chat", "scheduler", "forgeflow"}


def _resolve(spec: str):
    module_name, symbol = spec.split(":", 1)
    return getattr(importlib.import_module(module_name), symbol)


def test_one_langgraph_deployment_exposes_upstream_and_policy_graphs() -> None:
    config = json.loads((REPO / "langgraph.json").read_text(encoding="utf-8"))
    assert set(config["graphs"]) == EXPECTED_GRAPHS
    assert config["http"]["app"] == "agent.webapp:app"
    for spec in config["graphs"].values():
        assert callable(_resolve(spec))


def test_open_swe_graph_imports_are_centralized() -> None:
    assert set(GRAPH_ENTRIES) == EXPECTED_GRAPHS - {"forgeflow"}
    for path in (REPO / "forgeflow").rglob("*.py"):
        if path.name == "openswe.py":
            continue
        text = path.read_text(encoding="utf-8")
        assert "from agent." not in text, path
        assert "import agent." not in text, path


def test_default_model_policy_uses_luna_for_build_and_sol_for_review() -> None:
    impl = implementation_config(thread_id="thread-1")
    assert impl["agent_model_id"] == "openai:gpt-5.6-luna"
    assert impl["agent_effort"] == "xhigh"
    assert impl["draft_prs"] is True

    review = reviewer_config(reviewer_thread_id="review-1")
    assert review["reviewer_model_id"] == "openai:gpt-5.6-sol"
    assert review["reviewer_reasoning_effort"] == "medium"
    assert review["reviewer_subagent_model_id"] == "openai:gpt-5.6-sol"
    assert review["reviewer_subagent_reasoning_effort"] == "medium"


def test_github_adapter_returns_bounded_reference_shape() -> None:
    evidence = PullRequestEvidence(
        owner="o",
        repo="r",
        number=1,
        url="https://github.com/o/r/pull/1",
        state="open",
        head_sha="a" * 40,
        head_ref="feature",
        base_sha="b" * 40,
        base_ref="main",
    )
    assert evidence.head_sha != evidence.base_sha
