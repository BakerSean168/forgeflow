import json
from pathlib import Path

import pytest

from openswe_ext.model_policy import (
    IMPLEMENTATION_FALLBACK_MODEL_ID,
    IMPLEMENTATION_MODEL_ID,
    REVIEW_FALLBACK_MODEL_ID,
    REVIEW_MODEL_ID,
    ModelPolicyError,
    fallback_model_id_for,
    install_forgeflow_model_policy,
    reasoning_model_ids,
)

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ROUTES = ROOT / "deploy/gcp-dev/routes.default.json"


def test_glm_implementation_falls_back_only_to_luna(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FORGEFLOW_ROUTE_CONFIG_FILE", raising=False)
    assert fallback_model_id_for(IMPLEMENTATION_MODEL_ID) == IMPLEMENTATION_FALLBACK_MODEL_ID
    assert fallback_model_id_for(IMPLEMENTATION_FALLBACK_MODEL_ID) is None


def test_reasoning_registry_selects_sol_then_glm53(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FORGEFLOW_ROUTE_CONFIG_FILE", str(DEFAULT_ROUTES))
    assert reasoning_model_ids() == (REVIEW_MODEL_ID, REVIEW_FALLBACK_MODEL_ID)
    assert fallback_model_id_for(REVIEW_MODEL_ID) == REVIEW_FALLBACK_MODEL_ID


def test_expired_reasoning_fallback_is_not_used(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = json.loads(DEFAULT_ROUTES.read_text(encoding="utf-8"))
    fallback = next(route for route in payload["routes"] if route["id"] == "openswe-reviewer-glm53")
    fallback["expires_at"] = "2000-01-01T00:00:00Z"
    path = tmp_path / "routes.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    monkeypatch.setenv("FORGEFLOW_ROUTE_CONFIG_FILE", str(path))
    assert reasoning_model_ids() == (REVIEW_MODEL_ID, None)
    assert fallback_model_id_for(REVIEW_MODEL_ID) is None


def test_more_than_one_reasoning_fallback_fails_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = json.loads(DEFAULT_ROUTES.read_text(encoding="utf-8"))
    payload["routes"].append(
        {
            "id": "unexpected-third-reviewer",
            "role": "REASONING",
            "priority": 30,
            "runtime": "OPEN_SWE",
            "target": "openai:unexpected",
            "enabled": True,
            "health": "READY",
        }
    )
    path = tmp_path / "routes.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    monkeypatch.setenv("FORGEFLOW_ROUTE_CONFIG_FILE", str(path))
    with pytest.raises(ModelPolicyError, match="REASONING_ROUTE_COUNT_UNSUPPORTED"):
        reasoning_model_ids()


def test_install_is_idempotent() -> None:
    install_forgeflow_model_policy()
    install_forgeflow_model_policy()
