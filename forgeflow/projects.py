"""Repository policy projected from Open SWE's existing local project manifest."""

import json
import os
from dataclasses import dataclass
from pathlib import Path

from forgeflow.models import RepositoryPolicy


@dataclass(frozen=True, slots=True)
class ExternalAgentProjectConfig:
    cwd: Path
    test_command: tuple[str, ...]


def _project_entry(owner: str, repo: str) -> dict | None:
    path = os.environ.get("OPEN_SWE_LOCAL_PROJECTS_FILE", "").strip()
    if not path:
        return None
    try:
        entries = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(entries, list):
        return None
    expected = f"{owner}/{repo}".casefold()
    for raw in entries:
        if not isinstance(raw, dict):
            continue
        full_name = raw.get("repo")
        if isinstance(full_name, str) and full_name.casefold() == expected:
            return raw
    return None


def load_repository_policy(owner: str, repo: str) -> RepositoryPolicy:
    """Load CI policy without introducing a second project registry or database."""
    raw = _project_entry(owner, repo)
    if raw is None:
        return RepositoryPolicy(ci_required=True)
    ci_required = raw.get("ci_required", True)
    if not isinstance(ci_required, bool):
        return RepositoryPolicy(ci_required=True)
    checks = raw.get("required_checks", [])
    if not isinstance(checks, list) or any(not isinstance(item, str) for item in checks):
        return RepositoryPolicy(ci_required=ci_required)
    normalized = tuple(dict.fromkeys(item.strip() for item in checks if item.strip()))
    return RepositoryPolicy(ci_required=ci_required, required_checks=normalized)


def load_external_agent_project_config(owner: str, repo: str) -> ExternalAgentProjectConfig | None:
    """Read the optional external-agent execution contract from the same project manifest."""
    raw = _project_entry(owner, repo)
    if raw is None:
        return None
    cwd = raw.get("cwd")
    command = raw.get("external_agent_test_command")
    if not isinstance(cwd, str) or not cwd.strip():
        return None
    if (
        not isinstance(command, list)
        or not command
        or any(not isinstance(item, str) or not item.strip() for item in command)
    ):
        return None
    path = Path(cwd).expanduser()
    try:
        resolved = path.resolve(strict=True)
    except OSError:
        return None
    if not resolved.is_dir():
        return None
    return ExternalAgentProjectConfig(
        cwd=resolved,
        test_command=tuple(item.strip() for item in command),
    )


__all__ = [
    "ExternalAgentProjectConfig",
    "load_external_agent_project_config",
    "load_repository_policy",
]
