"""Deterministic implementation instructions layered onto an Open SWE objective."""

from forgeflow.invariants import render_preflight


def operation_trailer(operation_key: str) -> str:
    if not operation_key:
        raise ValueError("operation_key is required")
    return f"ForgeFlow-Operation: {operation_key}"


def build_implementation_prompt(
    *,
    objective: str,
    operation_key: str,
    base_ref: str = "main",
    project_learning: tuple[str, ...] = (),
) -> str:
    trailer = operation_trailer(operation_key)
    if not base_ref.strip():
        raise ValueError("base_ref is required")
    lines = [
        objective.strip(),
        "",
        *render_preflight(objective),
    ]
    if project_learning:
        lines.extend(("", *project_learning))
    lines.extend(
        [
            "",
            "ForgeFlow delivery evidence requirement:",
            f"- Base the task branch on `origin/{base_ref}` and open/update the PR against exactly `{base_ref}`.",
            f"- The final pushed HEAD commit message MUST contain this exact trailer on its own line: `{trailer}`",
            "- Preserve the current task branch/PR if one already belongs to this thread.",
            "- Do not claim completion until the final commit is pushed and the PR points at that commit.",
            "- Before your final response, explicitly verify `git status`, the pushed HEAD, and the tracked PR head. A prose summary without a tracked PR is not a valid ForgeFlow delivery.",
        ]
    )
    return "\n".join(lines)


def build_delivery_checkpoint_prompt(
    *,
    objective: str,
    operation_key: str,
    base_ref: str = "main",
) -> str:
    """Recover a run that changed code but returned without durable PR evidence."""

    trailer = operation_trailer(operation_key)
    if not base_ref.strip():
        raise ValueError("base_ref is required")
    return "\n".join(
        [
            "ForgeFlow delivery-checkpoint recovery retry.",
            "",
            "The previous implementation run returned without a tracked pull request. Do not restart broad implementation or re-analyze the objective from scratch.",
            f"Original objective (context only): {objective.strip()}",
            "",
            "Recover the existing same-thread workspace in this order:",
            "1. Inspect `git status`, the current branch, recent commits, and any existing PR metadata before editing.",
            "2. Preserve coherent existing changes. Only make additional code edits if they are required to make the already-started slice valid and deliverable.",
            "3. Run the smallest relevant verification needed for the existing changes; do not start unrelated test suites or a new feature slice.",
            f"4. Ensure the task branch is based on `origin/{base_ref}` and the PR targets exactly `{base_ref}`.",
            f"5. Commit the coherent changes. The final pushed HEAD commit message MUST contain this exact trailer on its own line: `{trailer}`",
            "6. Push the task branch and create or update the Draft PR owned by this thread.",
            "7. Verify the tracked PR exists and its head commit is exactly the pushed HEAD before your final response.",
            "",
            "Do not report completion with only local file changes, an unpushed commit, or a prose summary. ForgeFlow accepts this retry only when durable PR evidence exists.",
        ]
    )
