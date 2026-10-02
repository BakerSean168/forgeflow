import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
FORBIDDEN_TRACKED_PATHS = (
    "src/",
    "test/",
    "api/",
    "packages/",
    "openhands_tools/",
    "deploy/openhands/",
    "tsconfig.json",
)
FORBIDDEN_POLICY_TOKENS = (
    "import sqlite3",
    "node:sqlite",
    "OpenHands",
    "Antigravity",
    "plan_worktrees",
    "execution_sessions",
)


def _tracked_files() -> set[str]:
    output = subprocess.check_output(["git", "ls-files"], cwd=REPO, text=True)
    return {line.strip() for line in output.splitlines() if line.strip()}


def test_legacy_runtime_paths_are_absent() -> None:
    tracked = _tracked_files()
    for forbidden in FORBIDDEN_TRACKED_PATHS:
        if forbidden.endswith("/"):
            assert not any(path.startswith(forbidden) for path in tracked), forbidden
        else:
            assert forbidden not in tracked
    assert not any(path.endswith((".ts", ".mts")) for path in tracked)
    assert not any(path.endswith("schema.sql") for path in tracked)


def test_pi_native_package_has_one_explicit_runtime_entrypoint() -> None:
    package = json.loads((REPO / "package.json").read_text(encoding="utf-8"))

    assert package["pi"]["extensions"] == ["./extension/index.js"]
    assert package["pi"]["skills"] == ["./skills"]
    assert package["dependencies"] == {"pi-subagents": "0.73.1"}
    assert set(package["files"]) == {"extension", "scripts", "skills", "README.md", "LICENSE"}

    tracked = _tracked_files()
    runtime_javascript = {
        path
        for path in tracked
        if path.endswith((".js", ".mjs")) and not path.startswith("tests/")
    }
    assert runtime_javascript
    assert all(
        path.startswith(("extension/", "scripts/"))
        for path in runtime_javascript
    )


def test_policy_package_does_not_reintroduce_runtime_ownership() -> None:
    for path in (REPO / "forgeflow").rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        for token in FORBIDDEN_POLICY_TOKENS:
            assert token not in text, f"{path.relative_to(REPO)} contains forbidden token {token!r}"


def test_placeholder_graph_imports() -> None:
    from forgeflow.graph import get_forgeflow_graph

    graph = get_forgeflow_graph()
    assert graph is not None
