#!/usr/bin/env python3
"""Bind LangGraph local-dev persistence to ForgeFlow's stable state directory."""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
from pathlib import Path


class StateMigrationError(RuntimeError):
    pass


def _nonempty(path: Path) -> bool:
    return path.is_dir() and any(path.iterdir())


def _tree_digest(path: Path) -> str:
    digest = hashlib.sha256()
    if not path.is_dir():
        return digest.hexdigest()
    for entry in sorted(path.rglob("*"), key=lambda item: item.as_posix()):
        rel = entry.relative_to(path).as_posix().encode()
        digest.update(rel)
        if entry.is_symlink():
            digest.update(b"L")
            digest.update(os.readlink(entry).encode())
        elif entry.is_dir():
            digest.update(b"D")
        elif entry.is_file():
            digest.update(b"F")
            with entry.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
        else:
            raise StateMigrationError(f"unsupported state entry: {entry}")
    return digest.hexdigest()


def _tighten_permissions(root: Path) -> None:
    root.chmod(0o700)
    for path in root.rglob("*"):
        if path.is_symlink():
            continue
        path.chmod(0o700 if path.is_dir() else 0o600)


def _candidate_state(path: Path, stable: Path) -> Path | None:
    if path.is_symlink():
        target = path.resolve(strict=False)
        if target != stable:
            raise StateMigrationError(f"unexpected LangGraph state symlink {path} -> {target}")
        return None
    if not path.exists():
        return None
    if not path.is_dir():
        raise StateMigrationError(f"LangGraph state path is not a directory: {path}")
    return path if _nonempty(path) else None


def _replace_with_symlink(path: Path, stable: Path) -> None:
    if path.is_symlink():
        if path.resolve(strict=False) != stable:
            raise StateMigrationError(f"refusing to replace foreign state symlink: {path}")
        return
    if path.exists():
        if path.is_dir() and _nonempty(path) and _tree_digest(path) != _tree_digest(stable):
            raise StateMigrationError(f"refusing to replace divergent LangGraph state: {path}")
        if path.is_dir():
            shutil.rmtree(path)
        else:
            raise StateMigrationError(f"refusing non-directory LangGraph state path: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.symlink_to(stable, target_is_directory=True)


def migrate(root: Path, state_dir: Path, previous_root: Path | None = None) -> Path:
    root = root.resolve()
    state_dir = state_dir.resolve()
    stable = state_dir / "langgraph"
    state_dir.mkdir(parents=True, exist_ok=True)
    state_dir.chmod(0o700)
    if stable.is_symlink():
        raise StateMigrationError(f"stable LangGraph state must be a real directory: {stable}")
    if stable.exists() and not stable.is_dir():
        raise StateMigrationError(f"stable LangGraph state is not a directory: {stable}")

    link_paths: list[Path] = []
    if previous_root is not None:
        previous = previous_root.resolve()
        link_paths.append(previous / ".langgraph_api")
    link_paths.append(root / ".langgraph_api")
    link_paths = list(dict.fromkeys(link_paths))

    candidates = [candidate for path in link_paths if (candidate := _candidate_state(path, stable))]
    candidate_digests = {_tree_digest(path) for path in candidates}
    if len(candidate_digests) > 1:
        raise StateMigrationError("multiple divergent LangGraph state directories found")

    if stable.exists() and _nonempty(stable):
        stable_digest = _tree_digest(stable)
        if candidate_digests and candidate_digests != {stable_digest}:
            raise StateMigrationError("stable LangGraph state conflicts with worktree-local state")
    else:
        stable.mkdir(parents=True, exist_ok=True)
        if candidates:
            shutil.copytree(candidates[0], stable, dirs_exist_ok=True, symlinks=True)

    _tighten_permissions(stable)
    for path in link_paths:
        _replace_with_symlink(path, stable)
    return stable


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--previous-root", type=Path)
    args = parser.parse_args()
    try:
        stable = migrate(args.root, args.state_dir, args.previous_root)
    except StateMigrationError as exc:
        parser.error(str(exc))
    print(f"langgraph_state_dir={stable}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
