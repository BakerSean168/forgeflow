"""Repository policy projected from Open SWE's existing local project manifest."""

import json
import os
from pathlib import Path

from forgeflow.models import RepositoryPolicy


def load_repository_policy(owner: str, repo: str) -> RepositoryPolicy:
    """Load CI policy without introducing a second project registry or database."""
    path = os.environ.get("OPEN_SWE_LOCAL_PROJECTS_FILE", "").strip()
    if not path:
        return RepositoryPolicy(ci_required=True)
    try:
        entries = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return RepositoryPolicy(ci_required=True)
    if not isinstance(entries, list):
        return RepositoryPolicy(ci_required=True)
    expected = f"{owner}/{repo}".casefold()
    for raw in entries:
        if not isinstance(raw, dict):
            continue
        full_name = raw.get("repo")
        if not isinstance(full_name, str) or full_name.casefold() != expected:
            continue
        ci_required = raw.get("ci_required", True)
        if not isinstance(ci_required, bool):
            return RepositoryPolicy(ci_required=True)
        checks = raw.get("required_checks", [])
        if not isinstance(checks, list) or any(not isinstance(item, str) for item in checks):
            return RepositoryPolicy(ci_required=ci_required)
        normalized = tuple(dict.fromkeys(item.strip() for item in checks if item.strip()))
        return RepositoryPolicy(ci_required=ci_required, required_checks=normalized)
    return RepositoryPolicy(ci_required=True)
