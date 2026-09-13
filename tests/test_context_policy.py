import agent.utils.model as upstream_model
import pytest
from deepagents.middleware import summarization as upstream_summarization
from langchain_fireworks import ChatFireworks

from openswe_ext.context_policy import (
    GLM53_COMPACT_KEEP_TOKENS,
    GLM53_COMPACT_TRIGGER_MESSAGES,
    GLM53_COMPACT_TRIGGER_TOKENS,
    GLM53_CONTEXT_WINDOW,
    GLM53_MODEL_ID,
    GLM53_PROVIDER_MODEL_NAME,
    GLM53_TOOL_ARG_KEEP_TOKENS,
    GLM53_TOOL_ARG_MAX_CHARS,
    GLM53_TOOL_ARG_TRUNCATE_TOKENS,
    install_agent_context_policy,
)


def _glm_model() -> ChatFireworks:
    return ChatFireworks(model=GLM53_PROVIDER_MODEL_NAME, api_key="test-only")


def test_glm53_runtime_profile_exposes_physical_context_window() -> None:
    install_agent_context_policy()

    profile = upstream_model.model_profile_with_context_override(GLM53_MODEL_ID)

    assert profile is not None
    assert profile["max_input_tokens"] == GLM53_CONTEXT_WINDOW


def test_glm53_context_policy_uses_small_operational_working_set() -> None:
    install_agent_context_policy()
    model = _glm_model()
    model.profile = upstream_model.model_profile_with_context_override(GLM53_MODEL_ID)

    defaults = upstream_summarization.compute_summarization_defaults(model)

    assert defaults["trigger"] == [
        ("tokens", GLM53_COMPACT_TRIGGER_TOKENS),
        ("messages", GLM53_COMPACT_TRIGGER_MESSAGES),
    ]
    assert defaults["keep"] == ("tokens", GLM53_COMPACT_KEEP_TOKENS)
    assert defaults["truncate_args_settings"] == {
        "trigger": ("tokens", GLM53_TOOL_ARG_TRUNCATE_TOKENS),
        "keep": ("tokens", GLM53_TOOL_ARG_KEEP_TOKENS),
        "max_length": GLM53_TOOL_ARG_MAX_CHARS,
        "truncation_text": "...(argument truncated by ForgeFlow context policy)",
    }


def test_glm53_physical_window_does_not_drive_85_percent_compaction() -> None:
    install_agent_context_policy()
    model = _glm_model()
    model.profile = {"max_input_tokens": GLM53_CONTEXT_WINDOW}

    defaults = upstream_summarization.compute_summarization_defaults(model)

    assert defaults["trigger"][0] == ("tokens", 65_536)
    assert defaults["trigger"][0] != ("fraction", 0.85)


def test_context_policy_install_is_idempotent() -> None:
    install_agent_context_policy()
    install_agent_context_policy()


@pytest.mark.asyncio
async def test_glm53_budget_warns_then_stops_after_hard_grace_call() -> None:
    from langchain.agents.middleware import ModelRequest, ModelResponse
    from langchain_core.messages import AIMessage, HumanMessage

    from openswe_ext.context_policy import ForgeFlowRunInputBudgetMiddleware

    model = _glm_model()
    middleware = ForgeFlowRunInputBudgetMiddleware(warn_tokens=10, hard_tokens=12)
    seen_requests: list[ModelRequest] = []

    async def handler(request: ModelRequest) -> ModelResponse:
        seen_requests.append(request)
        return ModelResponse(result=[AIMessage(content="ok")])

    request = ModelRequest(
        model=model,
        messages=[HumanMessage(content="x" * 40)],
        tools=[],
    )

    await middleware.abefore_agent({}, None)
    first = await middleware.awrap_model_call(request, handler)
    assert isinstance(first, ModelResponse)
    assert "HARD input-token budget reached" in seen_requests[-1].messages[-1].text

    second = await middleware.awrap_model_call(request, handler)
    assert isinstance(second, AIMessage)
    assert "FORGEFLOW_TOKEN_BUDGET_CHECKPOINT" in second.text
    assert len(seen_requests) == 1


def test_deep_agent_wrapper_injects_one_budget_guard(monkeypatch: pytest.MonkeyPatch) -> None:
    from openswe_ext import context_policy
    from openswe_ext.context_policy import ForgeFlowRunInputBudgetMiddleware

    captured: dict[str, object] = {}

    def fake_create(*args: object, **kwargs: object) -> str:
        captured["middleware"] = kwargs.get("middleware")
        return "graph"

    monkeypatch.setattr(context_policy, "_original_create_deep_agent", fake_create)
    result = context_policy.create_deep_agent_with_forgeflow_budget(model="dummy", middleware=[])

    assert result == "graph"
    middleware = captured["middleware"]
    assert isinstance(middleware, list)
    assert sum(isinstance(item, ForgeFlowRunInputBudgetMiddleware) for item in middleware) == 1
