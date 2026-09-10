import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def test_current_docs_explicitly_retire_openhands_runtime() -> None:
    readme = (REPO / "README.md").read_text(encoding="utf-8")
    architecture = (REPO / "docs/open-swe-policy-v1-architecture.md").read_text(encoding="utf-8")
    docs_index = (REPO / "docs/README.md").read_text(encoding="utf-8")

    normalized_readme = " ".join(readme.split())
    normalized_architecture = " ".join(architecture.split())
    normalized_index = " ".join(docs_index.split())
    assert "OpenHands is not part of the current ForgeFlow runtime" in normalized_readme
    assert "There is no OpenHands Agent Server" in normalized_architecture
    assert "OpenHands is not used by the current runtime" in normalized_index
    assert "Status: implemented current architecture" in normalized_architecture


def test_migration_plan_is_marked_historical_not_current_architecture() -> None:
    plan = (REPO / "docs/open-swe-policy-v1-refactor-plan.md").read_text(encoding="utf-8")
    normalized = " ".join(plan.replace(">", " ").split())
    assert "Status: completed migration record" in normalized
    assert "It is not the current architecture guide" in normalized
    assert "current Node/SQLite autonomous coding control plane" not in normalized


def test_upstream_doc_does_not_claim_legacy_production_is_still_running() -> None:
    upstream = (REPO / "docs/upstream.md").read_text(encoding="utf-8")
    assert "Production legacy services/state remain untouched" not in upstream
    assert "production cutover is complete" in upstream


def test_relative_markdown_links_in_public_docs_resolve() -> None:
    files = [REPO / "README.md", *(REPO / "docs").glob("*.md")]
    link_re = re.compile(r"\[[^]]+\]\(([^)]+)\)")
    for source in files:
        text = source.read_text(encoding="utf-8")
        for raw in link_re.findall(text):
            target = raw.split("#", 1)[0]
            if not target or "://" in target or target.startswith("mailto:"):
                continue
            resolved = (source.parent / target).resolve()
            assert resolved.exists(), f"{source.relative_to(REPO)} -> {raw}"


def test_architecture_graph_mapping_matches_langgraph_config() -> None:
    architecture = (REPO / "docs/open-swe-policy-v1-architecture.md").read_text(encoding="utf-8")
    config = json.loads((REPO / "langgraph.json").read_text(encoding="utf-8"))
    for name, target in config["graphs"].items():
        assert f'"{name}": "{target}"' in architecture


def test_public_markdown_code_fences_are_balanced() -> None:
    files = [REPO / "README.md", *(REPO / "docs").glob("*.md")]
    for path in files:
        text = path.read_text(encoding="utf-8")
        assert text.count("```") % 2 == 0, path.relative_to(REPO)
