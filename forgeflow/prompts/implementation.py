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
        ]
    )
    return "\n".join(lines)
