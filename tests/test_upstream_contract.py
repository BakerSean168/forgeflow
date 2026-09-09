from pathlib import Path

from agent.dispatch import dispatch_agent_run
from agent.github.pull_request_checks import get_pull_request_check_states
from agent.github.webhook import trigger_pr_review_from_ref
from agent.graphs.agent import traced_agent
from agent.graphs.reviewer import traced_reviewer_agent
from agent.graphs.scheduler import get_scheduler
from agent.review.findings import list_findings
from agent.run_config import RunConfig

EXPECTED_OPEN_SWE_SHA = "0ff86e22a94cc84e32883fcb1beee568560d4140"


def test_exact_upstream_pin_file_matches_contract_baseline() -> None:
    pin = Path("UPSTREAM_OPEN_SWE_SHA").read_text(encoding="utf-8").strip()
    assert pin == EXPECTED_OPEN_SWE_SHA


def test_required_open_swe_graphs_and_adapters_are_importable() -> None:
    assert callable(traced_agent)
    assert callable(traced_reviewer_agent)
    assert callable(get_scheduler)
    assert callable(dispatch_agent_run)
    assert callable(list_findings)
    assert callable(trigger_pr_review_from_ref)
    assert callable(get_pull_request_check_states)


def test_required_run_config_contract_exists() -> None:
    required = {
        "thread_id",
        "run_id",
        "repo",
        "branch_name",
        "pr_number",
        "pr_url",
        "head_sha",
        "base_sha",
        "agent_model_id",
        "agent_effort",
        "reviewer_model_id",
        "reviewer_reasoning_effort",
        "reviewer_subagent_model_id",
        "reviewer_subagent_reasoning_effort",
        "draft_prs",
    }
    assert required <= set(RunConfig.model_fields)
