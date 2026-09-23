#!/usr/bin/env python3
"""Reconcile ForgeFlow-managed projects while preserving operator overrides/extras."""
from __future__ import annotations

import argparse
import json
import os
import stat
import tempfile
from pathlib import Path
from typing import Any


def _load_list(path: Path) -> list[Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise TypeError(f"project config must be a JSON array: {path}")
    return payload


def _repo(row: Any) -> str | None:
    if not isinstance(row, dict):
        return None
    value = row.get("repo")
    return value.casefold() if isinstance(value, str) and "/" in value else None


def _is_allowlist_only(row: Any) -> bool:
    """Return whether *row* is an Open SWE desktop allowlist entry only.

    These rows deliberately have no repository identity, so ForgeFlow's project
    registry ignores them. They still need to survive installer convergence so
    a long-running desktop execution does not lose access after a service repair.
    """
    if not isinstance(row, dict) or row.get("allowlist_only") is not True:
        return False
    cwd = row.get("cwd")
    return isinstance(cwd, str) and bool(cwd.strip()) and _repo(row) is None


def _write_atomic(path: Path, payload: list[dict[str, Any]]) -> None:
    original_mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False) as handle:
        temp = Path(handle.name)
        json.dump(payload, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    try:
        os.chmod(temp, original_mode)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def migrate(current_path: Path, target_default_path: Path) -> str:
    current = _load_list(current_path)
    target = _load_list(target_default_path)
    current_by_repo = {_repo(row): row for row in current if _repo(row)}
    target_repos = {_repo(row) for row in target if _repo(row)}
    result: list[dict[str, Any]] = []

    for default in target:
        repo = _repo(default)
        if repo is None or not isinstance(default, dict):
            raise ValueError("managed project defaults must contain object entries with repo")
        existing = current_by_repo.get(repo)
        merged = dict(default)
        if isinstance(existing, dict):
            # Local/operator values win; new managed fields are filled in.
            merged.update(existing)
            for key in ("project_key", "external_agent_test_command"):
                if key not in existing and key in default:
                    merged[key] = default[key]
        result.append(merged)

    # Preserve valid operator-owned projects plus repo-less Open SWE desktop
    # allowlist entries. The latter intentionally stay invisible to ForgeFlow's
    # repository-policy/project surfaces while remaining durable across install.
    for row in current:
        repo = _repo(row)
        if (
            isinstance(row, dict) and repo and repo not in target_repos
        ) or _is_allowlist_only(row):
            result.append(row)

    if result == current:
        return "already-converged"
    _write_atomic(current_path, result)
    return "reconciled"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--current", required=True, type=Path)
    parser.add_argument("--target-default", required=True, type=Path)
    args = parser.parse_args()
    print(f"project_config_migration={migrate(args.current, args.target_default)}")


if __name__ == "__main__":
    main()
