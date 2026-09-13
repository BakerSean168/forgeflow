"""ForgeFlow-owned context policy overlay for Open SWE models.

Open SWE delegates context compaction to Deep Agents. Deep Agents derives its
summarization thresholds from ``BaseChatModel.profile['max_input_tokens']`` and
falls back to a fixed 170k-token trigger when that profile is missing.

Our GLM-5.3 deployment is routed through ``ChatFireworks`` to the private
LiteLLM gateway. The provider wrapper does not currently expose a model profile,
so the upstream fallback is both late and expensive for long software-engineering
runs. Keep the physical model capability separate from the operational Agent
working-set policy:

* physical context window: 1,048,576 tokens
* compact at: 65,536 tokens OR 120 messages
* retain after compaction: 16,384 recent tokens
* truncate old tool-call arguments at: 32,768 tokens, retaining 12,288 tokens

The overlay is deliberately narrow and idempotent so Open SWE upgrades have one
small compatibility surface rather than a forked runtime.
"""

from __future__ import annotations

import logging
import os
import sys
from collections.abc import Awaitable, Callable
from typing import Any

import agent.dashboard.options as upstream_options
import agent.utils.model as upstream_model
import deepagents
import deepagents.graph as upstream_deepagents_graph
from deepagents.middleware import summarization as upstream_summarization
from langchain.agents.middleware import AgentMiddleware, ModelRequest, ModelResponse
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.messages.utils import count_tokens_approximately

GLM53_MODEL_ID = "fireworks:accounts/fireworks/models/glm-5p3"
GLM53_PROVIDER_MODEL_NAME = "accounts/fireworks/models/glm-5p3"
GLM53_CONTEXT_WINDOW = 1_048_576
GLM53_COMPACT_TRIGGER_TOKENS = 65_536
GLM53_COMPACT_KEEP_TOKENS = 16_384
GLM53_COMPACT_TRIGGER_MESSAGES = 120
GLM53_TOOL_ARG_TRUNCATE_TOKENS = 32_768
GLM53_TOOL_ARG_KEEP_TOKENS = 12_288
GLM53_TOOL_ARG_MAX_CHARS = 2_000
GLM53_RUN_INPUT_WARN_TOKENS = 5_000_000
GLM53_RUN_INPUT_HARD_TOKENS = 10_000_000
GLM53_SUMMARY_FALLBACK_EFFORT = "medium"
GLM53_SUMMARY_FALLBACK_MAX_TOKENS = 8_192

logger = logging.getLogger(__name__)

_original_model_profile_with_context_override: Callable[[str], dict[str, object] | None] = (
    upstream_model.model_profile_with_context_override
)
_original_compute_summarization_defaults: Callable[[BaseChatModel], Any] = (
    upstream_summarization.compute_summarization_defaults
)
_original_create_deep_agent = deepagents.create_deep_agent
_original_create_summarization_middleware = upstream_summarization.create_summarization_middleware
_installed = False


def _model_name(model: BaseChatModel) -> str | None:
    """Return the provider-native model name without assuming one LangChain wrapper."""
    for attribute in ("model_name", "model"):
        value = getattr(model, attribute, None)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def model_profile_with_context_override(model_id: str) -> dict[str, object] | None:
    """Expose GLM-5.3's physical context capability to the runtime.

    This does *not* mean the agent may routinely consume the whole 1M window;
    ``compute_summarization_defaults`` below supplies the smaller operational
    working-set policy.
    """
    profile = _original_model_profile_with_context_override(model_id)
    if model_id != GLM53_MODEL_ID:
        return profile
    merged = dict(profile or {})
    merged["max_input_tokens"] = GLM53_CONTEXT_WINDOW
    return merged


def compute_summarization_defaults(model: BaseChatModel) -> Any:
    """Return a cost-aware working-set policy for the ForgeFlow GLM-5.3 route."""
    if _model_name(model) != GLM53_PROVIDER_MODEL_NAME:
        return _original_compute_summarization_defaults(model)
    return {
        "trigger": [
            ("tokens", GLM53_COMPACT_TRIGGER_TOKENS),
            ("messages", GLM53_COMPACT_TRIGGER_MESSAGES),
        ],
        "keep": ("tokens", GLM53_COMPACT_KEEP_TOKENS),
        "truncate_args_settings": {
            "trigger": ("tokens", GLM53_TOOL_ARG_TRUNCATE_TOKENS),
            "keep": ("tokens", GLM53_TOOL_ARG_KEEP_TOKENS),
            "max_length": GLM53_TOOL_ARG_MAX_CHARS,
            "truncation_text": "...(argument truncated by ForgeFlow context policy)",
        },
    }


def _positive_int_env(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        logger.warning("Ignoring invalid %s=%r; using %d", name, raw, default)
        return default
    if value <= 0:
        logger.warning("Ignoring non-positive %s=%r; using %d", name, raw, default)
        return default
    return value


class ForgeFlowRunInputBudgetMiddleware(AgentMiddleware):
    """Bound cumulative GLM-5.3 input spend for one agent invocation.

    The budget is intentionally based on approximate request tokens instead of
    provider-reported usage. Some OpenAI-compatible streaming relays omit usage
    metadata, which is exactly what happened during the BodySense Phase 02 run.

    At the warning threshold the model receives a request-local instruction to
    finish the current coherent slice instead of starting more work. At the hard
    threshold it gets one final grace model call for verification/commit/push;
    the following model call is short-circuited so the invocation terminates
    without another paid request.
    """

    def __init__(self, *, warn_tokens: int | None = None, hard_tokens: int | None = None) -> None:
        super().__init__()
        self.warn_tokens = warn_tokens or _positive_int_env(
            "FORGEFLOW_GLM53_RUN_INPUT_WARN_TOKENS", GLM53_RUN_INPUT_WARN_TOKENS
        )
        self.hard_tokens = hard_tokens or _positive_int_env(
            "FORGEFLOW_GLM53_RUN_INPUT_HARD_TOKENS", GLM53_RUN_INPUT_HARD_TOKENS
        )
        if self.hard_tokens <= self.warn_tokens:
            raise ValueError("GLM-5.3 hard input-token budget must exceed warning budget")
        self._input_tokens = 0
        self._terminate_next_call = False

    async def abefore_agent(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        del state, runtime
        self._input_tokens = 0
        self._terminate_next_call = False
        return None

    @staticmethod
    def _applies(request: ModelRequest[Any]) -> bool:
        return _model_name(request.model) == GLM53_PROVIDER_MODEL_NAME

    @staticmethod
    def _estimate_request_tokens(request: ModelRequest[Any]) -> int:
        messages = list(request.messages)
        if request.system_message is not None:
            messages.insert(0, request.system_message)
        return count_tokens_approximately(messages, tools=request.tools)

    @staticmethod
    def _budget_instruction(*, hard: bool, used: int, limit: int) -> HumanMessage:
        if hard:
            text = (
                "[ForgeFlow runtime budget] HARD input-token budget reached "
                f"(~{used:,}/{limit:,}). This is the final paid model call for this invocation. "
                "Do not inspect new code or start another slice. Finish only the current coherent "
                "checkpoint: run the smallest relevant verification, commit the existing coherent "
                "changes, push/update the current PR when safe, summarize remaining work, then stop."
            )
        else:
            text = (
                "[ForgeFlow runtime budget] Input-token warning threshold reached "
                f"(~{used:,}/{limit:,}). Do not start a new feature slice. Converge the current "
                "slice toward focused verification and a durable commit/PR checkpoint, then stop."
            )
        return HumanMessage(content=text)

    async def awrap_model_call(
        self,
        request: ModelRequest[Any],
        handler: Callable[[ModelRequest[Any]], Awaitable[ModelResponse[Any]]],
    ) -> ModelResponse[Any] | AIMessage:
        if not self._applies(request):
            return await handler(request)

        if self._terminate_next_call:
            return AIMessage(
                content=(
                    "FORGEFLOW_TOKEN_BUDGET_CHECKPOINT: the GLM-5.3 run input-token budget was "
                    "reached. Preserve the current workspace/commit/PR checkpoint and continue in "
                    "a fresh ForgeFlow invocation rather than extending this conversation."
                )
            )

        estimated = self._estimate_request_tokens(request)
        self._input_tokens += estimated
        hard = self._input_tokens >= self.hard_tokens
        warn = self._input_tokens >= self.warn_tokens
        if hard:
            self._terminate_next_call = True
            logger.warning(
                "ForgeFlow GLM-5.3 hard run input-token budget reached: %d/%d",
                self._input_tokens,
                self.hard_tokens,
            )
        elif warn:
            logger.info(
                "ForgeFlow GLM-5.3 run input-token warning: %d/%d",
                self._input_tokens,
                self.warn_tokens,
            )

        if warn:
            request = request.override(
                messages=[
                    *request.messages,
                    self._budget_instruction(
                        hard=hard,
                        used=self._input_tokens,
                        limit=self.hard_tokens if hard else self.warn_tokens,
                    ),
                ]
            )
        return await handler(request)


def _summary_fallback_model() -> BaseChatModel | None:
    """Build the configured Open SWE fallback model for internal summary calls."""
    fallback_model_id = upstream_model.fallback_model_id_for(GLM53_MODEL_ID)
    if not fallback_model_id or fallback_model_id == GLM53_MODEL_ID:
        return None
    kwargs = upstream_model.provider_model_kwargs(
        fallback_model_id,
        GLM53_SUMMARY_FALLBACK_EFFORT,
        max_tokens=GLM53_SUMMARY_FALLBACK_MAX_TOKENS,
    )
    try:
        return upstream_model.make_model(fallback_model_id, use_gateway=None, **kwargs)
    except Exception:
        logger.warning(
            "Could not construct GLM-5.3 summarization fallback model %s",
            fallback_model_id,
            exc_info=True,
        )
        return None


def create_summarization_middleware_with_forgeflow_fallback(
    model: BaseChatModel,
    backend: Any,
    **kwargs: Any,
) -> Any:
    """Give Deep Agents' internal GLM summary call the same availability escape hatch.

    Summarization invokes its model directly and therefore sits outside Open SWE's
    ``ModelFallbackMiddleware``. Without this wrapper an exhausted GLM route can
    fail a run *before* the main model has a chance to fall back to Luna.
    """
    middleware = _original_create_summarization_middleware(model, backend, **kwargs)
    if _model_name(model) != GLM53_PROVIDER_MODEL_NAME:
        return middleware

    fallback = _summary_fallback_model()
    if fallback is None:
        return middleware

    # Replace the upstream primary-only retry runnable with a composite that
    # tries GLM once, then Luna. If both fail, the composite itself retains the
    # upstream retry behavior. ``middleware.model`` remains GLM so token/profile
    # accounting and context-limit calculations stay truthful to the primary.
    middleware._lc_helper._summary_model = model.with_fallbacks([fallback]).with_retry()
    return middleware


def create_deep_agent_with_forgeflow_budget(*args: Any, **kwargs: Any) -> Any:
    """Inject one GLM-aware run-budget middleware into each Deep Agent graph."""
    middleware = list(kwargs.pop("middleware", ()) or ())
    if not any(isinstance(item, ForgeFlowRunInputBudgetMiddleware) for item in middleware):
        middleware.append(ForgeFlowRunInputBudgetMiddleware())
    kwargs["middleware"] = middleware
    return _original_create_deep_agent(*args, **kwargs)


def install_agent_context_policy() -> None:
    """Install ForgeFlow's narrow model-profile and compaction overlays once."""
    global _installed
    if _installed:
        return

    # ``make_model`` imported this helper by value, so patch both the defining
    # dashboard module and the runtime module that actually constructs models.
    upstream_options.model_profile_with_context_override = model_profile_with_context_override
    upstream_model.model_profile_with_context_override = model_profile_with_context_override

    # ``create_summarization_middleware`` looks up this module global at call
    # time, so replacing it here affects main agents and Deep Agents subagents.
    upstream_summarization.compute_summarization_defaults = compute_summarization_defaults

    # Deep Agents imports this factory by value in graph.py, while its manual
    # compact tool resolves the module global. Patch both references so internal
    # summary generation inherits GLM -> Luna availability fallback everywhere.
    upstream_summarization.create_summarization_middleware = (
        create_summarization_middleware_with_forgeflow_fallback
    )
    upstream_deepagents_graph.create_summarization_middleware = (
        create_summarization_middleware_with_forgeflow_fallback
    )

    # Open SWE imports ``create_deep_agent`` from the package after this overlay
    # is installed, so this wrapper injects the run-budget guard without forking
    # agent.server. The middleware itself is a no-op for non-GLM models.
    deepagents.create_deep_agent = create_deep_agent_with_forgeflow_budget
    server = sys.modules.get("agent.server")
    if server is not None:
        server.create_deep_agent = create_deep_agent_with_forgeflow_budget
    _installed = True


__all__ = [
    "GLM53_COMPACT_KEEP_TOKENS",
    "GLM53_COMPACT_TRIGGER_MESSAGES",
    "GLM53_COMPACT_TRIGGER_TOKENS",
    "GLM53_CONTEXT_WINDOW",
    "GLM53_MODEL_ID",
    "GLM53_PROVIDER_MODEL_NAME",
    "GLM53_RUN_INPUT_HARD_TOKENS",
    "GLM53_RUN_INPUT_WARN_TOKENS",
    "GLM53_SUMMARY_FALLBACK_EFFORT",
    "GLM53_SUMMARY_FALLBACK_MAX_TOKENS",
    "GLM53_TOOL_ARG_KEEP_TOKENS",
    "GLM53_TOOL_ARG_MAX_CHARS",
    "GLM53_TOOL_ARG_TRUNCATE_TOKENS",
    "ForgeFlowRunInputBudgetMiddleware",
    "compute_summarization_defaults",
    "create_deep_agent_with_forgeflow_budget",
    "create_summarization_middleware_with_forgeflow_fallback",
    "install_agent_context_policy",
    "model_profile_with_context_override",
]
