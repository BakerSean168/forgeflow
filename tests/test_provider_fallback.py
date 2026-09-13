from __future__ import annotations

import asyncio

import agent.middleware.model_fallback as upstream_fallback
from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import AIMessage

from openswe_ext.provider_fallback import (
    classify_exception,
    install_provider_fallback_overlay,
    is_provider_capacity_exhaustion,
)


class FakeProviderError(RuntimeError):
    def __init__(self, message: str, *, status_code: int, body=None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.body = body


class FakeModel:
    def __init__(self, name: str) -> None:
        self.model_name = name

    def bind_tools(self, tools, **kwargs):
        return self



def test_quota_403_is_capacity_exhaustion_but_generic_permission_403_is_not() -> None:
    quota = FakeProviderError(
        "Request denied",
        status_code=403,
        body={"error": {"message": "当前渠道额度不足，请稍后再试"}},
    )
    permission = FakeProviderError("Forbidden", status_code=403, body={"error": "permission denied"})
    assert is_provider_capacity_exhaustion(quota) is True
    assert classify_exception(quota) == "provider_quota_exhausted"
    assert is_provider_capacity_exhaustion(permission) is False


def test_overlay_makes_existing_fallback_middleware_try_secondary_model() -> None:
    install_provider_fallback_overlay()
    quota = FakeProviderError(
        "HTTP 403",
        status_code=403,
        body={"error": {"message": "insufficient balance"}},
    )
    assert upstream_fallback._should_fallback(quota) is True

    primary = FakeModel("primary")
    secondary = FakeModel("secondary")
    middleware = upstream_fallback.ModelFallbackMiddleware(
        secondary,
        backoff_schedule=(0.0,),
        surface_outage_message=False,
    )
    request = ModelRequest(model=primary, messages=[], tools=[])
    calls: list[str] = []

    async def handler(attempt_request):
        calls.append(attempt_request.model.model_name)
        if attempt_request.model is primary:
            raise quota
        return AIMessage(content="fallback ok")

    result = asyncio.run(middleware.awrap_model_call(request, handler))
    assert result.content == "fallback ok"
    assert calls == ["primary", "secondary"]
