from __future__ import annotations

import importlib.util
import json
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "deploy/gcp-dev/migrate_project_defaults.py"
SPEC = importlib.util.spec_from_file_location("migrate_project_defaults", SCRIPT)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


def test_migration_replaces_legacy_string_and_adds_memoflow(tmp_path: Path) -> None:
    target = Path(__file__).resolve().parents[1] / "deploy/gcp-dev/projects.default.json"
    current = tmp_path / "projects.json"
    current.write_text(
        json.dumps([
            {"name": "ForgeFlow", "repo": "BakerSean168/forgeflow", "cwd": "/custom/forgeflow", "ci_required": True, "required_checks": ["verify"]},
            "/home/dev/projects/.chatgpt-worktrees/memoflow-task7307",
            {"name": "Private extra", "repo": "BakerSean168/private-extra", "cwd": "/private"},
        ]),
        encoding="utf-8",
    )
    assert module.migrate(current, target) == "reconciled"
    payload = json.loads(current.read_text(encoding="utf-8"))
    by_repo = {row["repo"]: row for row in payload}
    assert "BakerSean168/memoflow" in by_repo
    assert by_repo["BakerSean168/memoflow"]["project_key"] == "memoflow"
    assert by_repo["BakerSean168/forgeflow"]["cwd"] == "/custom/forgeflow"
    assert by_repo["BakerSean168/forgeflow"]["external_agent_test_command"] == ["uv", "run", "pytest", "-q"]
    assert "BakerSean168/private-extra" in by_repo
    assert all(isinstance(row, dict) for row in payload)
    assert module.migrate(current, target) == "already-converged"


def test_migration_preserves_repo_less_desktop_allowlist_entry(tmp_path: Path) -> None:
    target = Path(__file__).resolve().parents[1] / "deploy/gcp-dev/projects.default.json"
    current = tmp_path / "projects.json"
    allowlist = {
        "cwd": "/home/dev/projects/bodysense-vnext-03-public-stream",
        "allowlist_only": True,
    }
    current.write_text(
        json.dumps([*json.loads(target.read_text(encoding="utf-8")), allowlist]),
        encoding="utf-8",
    )

    assert module.migrate(current, target) == "already-converged"
    payload = json.loads(current.read_text(encoding="utf-8"))
    assert allowlist in payload


def test_migration_drops_malformed_repo_less_extras(tmp_path: Path) -> None:
    target = Path(__file__).resolve().parents[1] / "deploy/gcp-dev/projects.default.json"
    current = tmp_path / "projects.json"
    current.write_text(
        json.dumps(
            [
                *json.loads(target.read_text(encoding="utf-8")),
                {"cwd": "/tmp/not-explicitly-allowed"},
                {"cwd": "", "allowlist_only": True},
                {"allowlist_only": True},
            ]
        ),
        encoding="utf-8",
    )

    assert module.migrate(current, target) == "reconciled"
    assert json.loads(current.read_text(encoding="utf-8")) == json.loads(
        target.read_text(encoding="utf-8")
    )
