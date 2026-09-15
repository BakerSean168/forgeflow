from forgeflow.invariants import infer_invariants, render_finding_reinforcement
from forgeflow.prompts.implementation import build_implementation_prompt
from forgeflow.prompts.repair import RepairFinding, build_review_repair_prompt


def _ids(text: str) -> set[str]:
    return {rule.id for rule in infer_invariants(text)}


def test_portability_preflight_surfaces_owner_time_identity_and_parity_risks() -> None:
    ids = _ids(
        "Import an account birthday profile through a portable dry-run/apply path across Prisma and PowerSync with deterministic IDs"
    )
    assert {
        "INV-ROOT-001",
        "INV-OWNER-001",
        "INV-TIME-001",
        "INV-IDENTITY-001",
        "INV-PARITY-001",
    } <= ids


def test_implementation_prompt_requires_preflight_and_tiered_validation() -> None:
    prompt = build_implementation_prompt(
        objective="Add portable account birthday import with dry-run/apply parity",
        operation_key="implementation:p:retry:0",
        base_ref="integration",
    )
    assert "ForgeFlow invariant preflight (complete before editing)" in prompt
    assert "INV-OWNER-001" in prompt
    assert "INV-TIME-001" in prompt
    assert "failing/characterization test" in prompt
    assert "reserve broad integration/E2E for the candidate exact head" in prompt


def test_review_finding_maps_back_to_known_invariants() -> None:
    lines = render_finding_reinforcement(
        ["Portable birthday accepts a future date and avatarUrl accepts an invalid value"]
    )
    text = "\n".join(lines)
    assert "INV-OWNER-001" in text
    assert "INV-TIME-001" in text
    assert "regression test" in text


def test_review_repair_prompt_reinforces_root_invariant() -> None:
    prompt = build_review_repair_prompt(
        pr_url="https://github.com/o/r/pull/1",
        rejected_head_sha="a" * 40,
        operation_key="repair:p:head:round:1:retry:0",
        findings=(
            RepairFinding(
                id="f1",
                severity="medium",
                title="Future birthday bypasses owner validation",
                file="account-portability.ts",
                start_line=10,
                end_line=20,
                description="The portable schema is weaker than the account owner path and accepts a future birthday.",
            ),
        ),
    )
    assert "Finding-derived invariant reinforcement" in prompt
    assert "INV-OWNER-001" in prompt
    assert "INV-TIME-001" in prompt
    assert "adjacent path sharing the same invariant" in prompt


def test_trigger_matching_uses_terms_not_substrings() -> None:
    ids = _ids("Update a refactor implementation without changing semantics")
    assert "INV-TIME-001" not in ids
    assert "INV-ORDER-001" not in ids
