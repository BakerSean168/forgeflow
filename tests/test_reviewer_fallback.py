from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from agent.middleware import ModelFallbackMiddleware

import openswe_ext.reviewer_fallback as overlay

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ROUTES = ROOT / "deploy/gcp-dev/routes.default.json"


class FakeModel:
    def __init__(self, name: str) -> None:
        self.model_name = name


def _middleware_names(items: list[object]) -> list[str]:
    return [item.__class__.__name__ for item in items]


def test_reviewer_overlay_installs_fallback_for_parent_and_subagent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = json.loads(DEFAULT_ROUTES.read_text(encoding="utf-8"))
    route = next(item for item in payload["routes"] if item["id"] == "openswe-reviewer-glm53")
    route["expires_at"] = "2099-01-01T00:00:00Z"
    routes = tmp_path / "routes.json"
    routes.write_text(json.dumps(payload), encoding="utf-8")
    monkeypatch.setenv("FORGEFLOW_ROUTE_CONFIG_FILE", str(routes))
    captured: dict[str, object] = {}
    fallback_model = FakeModel("accounts/fireworks/models/glm-5p3")

    def fake_original(*args, **kwargs):
        captured.update(kwargs)
        return "graph"

    monkeypatch.setattr(overlay, "_original_create_deep_agent", fake_original)
    monkeypatch.setattr(
        overlay.upstream_reviewer,
        "_make_model_or_defer",
        lambda *args, **kwargs: fallback_model,
    )

    result = overlay._create_reviewer_deep_agent(
        model=FakeModel("gpt-5.6-sol"),
        middleware=[SimpleNamespace()],
        subagents=[
            {
                "name": "reviewer",
                "model": FakeModel("gpt-5.6-sol"),
                "middleware": [SimpleNamespace()],
            }
        ],
    )

    assert result == "graph"
    parent = captured["middleware"]
    assert isinstance(parent, list)
    assert sum(isinstance(item, ModelFallbackMiddleware) for item in parent) == 1
    subagent = captured["subagents"][0]
    assert sum(
        isinstance(item, ModelFallbackMiddleware) for item in subagent["middleware"]
    ) == 1


def test_reviewer_overlay_does_not_touch_non_primary_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FORGEFLOW_ROUTE_CONFIG_FILE", str(DEFAULT_ROUTES))
    captured: dict[str, object] = {}

    def fake_original(*args, **kwargs):
        captured.update(kwargs)
        return "graph"

    monkeypatch.setattr(overlay, "_original_create_deep_agent", fake_original)
    result = overlay._create_reviewer_deep_agent(
        model=FakeModel("some-other-model"),
        middleware=[SimpleNamespace()],
        subagents=[],
    )
    assert result == "graph"
    assert "ModelFallbackMiddleware" not in _middleware_names(captured["middleware"])


def test_expired_reasoning_fallback_is_not_installed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = json.loads(DEFAULT_ROUTES.read_text(encoding="utf-8"))
    route = next(item for item in payload["routes"] if item["id"] == "openswe-reviewer-glm53")
    route["expires_at"] = "2000-01-01T00:00:00Z"
    config = tmp_path / "routes.json"
    config.write_text(json.dumps(payload), encoding="utf-8")
    monkeypatch.setenv("FORGEFLOW_ROUTE_CONFIG_FILE", str(config))
    captured: dict[str, object] = {}

    def fake_original(*args, **kwargs):
        captured.update(kwargs)
        return "graph"

    monkeypatch.setattr(overlay, "_original_create_deep_agent", fake_original)
    result = overlay._create_reviewer_deep_agent(
        model=FakeModel("gpt-5.6-sol"),
        middleware=[SimpleNamespace()],
        subagents=[],
    )
    assert result == "graph"
    assert "ModelFallbackMiddleware" not in _middleware_names(captured["middleware"])
