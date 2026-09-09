from forgeflow.prompts.implementation import build_implementation_prompt, operation_trailer
from forgeflow.prompts.repair import build_ci_repair_prompt


def test_implementation_prompt_requires_exact_final_head_trailer() -> None:
    prompt = build_implementation_prompt(objective="Fix the bug", operation_key="implementation:p:retry:0")
    assert "Fix the bug" in prompt
    assert "ForgeFlow-Operation: implementation:p:retry:0" in prompt
    assert "final pushed HEAD commit message" in prompt


def test_repair_prompt_requires_new_operation_trailer() -> None:
    prompt = build_ci_repair_prompt(
        pr_url="https://github.com/o/r/pull/1",
        rejected_head_sha="a" * 40,
        failure_code="CHECK_FAILED:tests",
        operation_key="repair:p:head:round:1:retry:0",
    )
    assert operation_trailer("repair:p:head:round:1:retry:0") in prompt
