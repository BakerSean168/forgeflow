from forgeflow.prompts.implementation import (
    build_delivery_checkpoint_prompt,
    build_implementation_prompt,
    operation_trailer,
)
from forgeflow.prompts.repair import build_ci_repair_prompt


def test_implementation_prompt_requires_exact_final_head_trailer() -> None:
    prompt = build_implementation_prompt(
        objective="Fix the bug",
        operation_key="implementation:p:retry:0",
        base_ref="release/policy-v1",
    )
    assert "Fix the bug" in prompt
    assert "ForgeFlow-Operation: implementation:p:retry:0" in prompt
    assert "final pushed HEAD commit message" in prompt
    assert "origin/release/policy-v1" in prompt
    assert "against exactly `release/policy-v1`" in prompt
    assert "A prose summary without a tracked PR is not a valid ForgeFlow delivery" in prompt


def test_delivery_checkpoint_prompt_is_narrow_and_requires_tracked_pr() -> None:
    prompt = build_delivery_checkpoint_prompt(
        objective="Cut over Routine writes",
        operation_key="implementation:p:retry:1",
        base_ref="integration",
    )
    assert "delivery-checkpoint recovery retry" in prompt
    assert "Do not restart broad implementation" in prompt
    assert "Cut over Routine writes" in prompt
    assert "git status" in prompt
    assert "create or update the Draft PR" in prompt
    assert "ForgeFlow-Operation: implementation:p:retry:1" in prompt
    assert "targets exactly `integration`" in prompt


def test_repair_prompt_requires_new_operation_trailer() -> None:
    prompt = build_ci_repair_prompt(
        pr_url="https://github.com/o/r/pull/1",
        rejected_head_sha="a" * 40,
        failure_code="CHECK_FAILED:tests",
        operation_key="repair:p:head:round:1:retry:0",
    )
    assert operation_trailer("repair:p:head:round:1:retry:0") in prompt


def test_implementation_prompt_rejects_empty_base_ref() -> None:
    import pytest

    with pytest.raises(ValueError, match="base_ref is required"):
        build_implementation_prompt(objective="Fix", operation_key="op", base_ref="  ")
