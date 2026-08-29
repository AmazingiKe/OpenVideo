from collections.abc import Callable
from time import perf_counter

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from openvideo.core.ai_models import (
    AiModelConfiguration,
    IMAGE_INPUT_MODALITY,
    InputModality,
    online_api_configuration_error,
)
from openvideo.llm.capability_resolver import CapabilityResolver
from openvideo.llm.errors import LlmRuntimeError, ToolCallingUnsupportedError
from openvideo.llm.model_profile import (
    CAPABILITY_NAMES,
    CapabilityName,
    CapabilityOverride,
    CapabilitySource,
    ModelCapabilityOverrides,
    ModelProfile,
    Support,
)
from openvideo.llm.probes import (
    probe_basic_tools,
    probe_named_tool_choice,
    probe_parallel_tools,
    probe_reasoning_tools,
    probe_streaming_tools,
    probe_vision_tools,
)
from openvideo.settings import Settings
from openvideo.tools.llm import LlmCompletionError, complete_text, probe_image_input


MILLISECONDS_PER_SECOND = 1_000
MODEL_TEST_MAX_TOKENS = 8
MODEL_TEST_PROMPT = "Reply only with OK."
MODEL_TEST_REDACTED_SECRET = "[已隐藏]"
MODEL_TEST_SUCCESS_MESSAGE = "模型响应正常"
MODEL_TEST_TIMEOUT_SECONDS = 30


class AiModelSummary(BaseModel):
    model_id: str
    name: str
    litellm_model: str
    input_modalities: list[InputModality]
    capabilities: ModelCapabilityOverrides
    profile: ModelProfile


class AiModelCapabilityTest(BaseModel):
    support: Support
    source: CapabilitySource
    tested: bool
    message: str


class AiModelTestResponse(BaseModel):
    available: bool
    latency_ms: int
    message: str
    capabilities: dict[str, AiModelCapabilityTest]
    profile: ModelProfile


def register_ai_routes(
    app: FastAPI,
    settings: Settings,
    capability_resolver: CapabilityResolver,
) -> None:
    @app.get("/api/ai/models", response_model=list[AiModelSummary])
    def list_ai_models() -> list[AiModelSummary]:
        return [
            AiModelSummary(
                model_id=model.model_id,
                name=model.name,
                litellm_model=model.litellm_model,
                input_modalities=model.input_modalities,
                capabilities=model.capabilities,
                profile=capability_resolver.resolve(model),
            )
            for model in settings.ai_models
        ]

    @app.post("/api/ai/models/test", response_model=AiModelTestResponse)
    def test_ai_model(request: AiModelConfiguration) -> AiModelTestResponse:
        configuration_error = online_api_configuration_error(request)
        if configuration_error is not None:
            raise HTTPException(status_code=422, detail=configuration_error)
        started_at = perf_counter()
        capabilities: dict[str, AiModelCapabilityTest] = {}
        profile = capability_resolver.resolve(request, refresh_models_dev=True)
        try:
            complete_text(
                request,
                [{"role": "user", "content": MODEL_TEST_PROMPT}],
                timeout_seconds=MODEL_TEST_TIMEOUT_SECONDS,
                max_tokens=MODEL_TEST_MAX_TOKENS,
                disable_thinking=True,
            )
        except LlmCompletionError as error:
            error_message = redact_model_test_error(str(error), request.api_key)
            capabilities["text"] = AiModelCapabilityTest(
                support=Support.NO,
                source=CapabilitySource.RUNTIME_PROBE,
                tested=True,
                message=error_message,
            )
            for capability in CAPABILITY_NAMES:
                capabilities[capability.value] = AiModelCapabilityTest(
                    support=profile.support(capability),
                    source=profile.source(capability),
                    tested=False,
                    message="文本连接失败，未执行能力探测",
                )
            return AiModelTestResponse(
                available=False,
                latency_ms=round(
                    (perf_counter() - started_at) * MILLISECONDS_PER_SECOND
                ),
                message=error_message,
                capabilities=capabilities,
                profile=profile,
            )
        capabilities["text"] = AiModelCapabilityTest(
            support=Support.YES,
            source=CapabilitySource.RUNTIME_PROBE,
            tested=True,
            message="文本响应正常",
        )
        probe_results: dict[CapabilityName, Support] = {}
        tool_probe_specs = (
            (CapabilityName.TOOLS, probe_basic_tools, "基础工具调用"),
            (CapabilityName.STREAMING_TOOLS, probe_streaming_tools, "流式工具调用"),
            (CapabilityName.TOOL_CHOICE_NAMED, probe_named_tool_choice, "指定工具调用"),
            (CapabilityName.PARALLEL_TOOLS, probe_parallel_tools, "并行工具调用"),
        )
        if request.capabilities.tools == CapabilityOverride.DISABLED:
            for capability, _, label in tool_probe_specs:
                capabilities[capability.value] = AiModelCapabilityTest(
                    support=Support.NO,
                    source=CapabilitySource.USER_OVERRIDE,
                    tested=False,
                    message=f"模型配置已禁用{label}",
                )
        else:
            for capability, probe, label in tool_probe_specs:
                support, message = run_model_probe(probe, request, label)
                probe_results[capability] = support
                capabilities[capability.value] = AiModelCapabilityTest(
                    support=support,
                    source=CapabilitySource.RUNTIME_PROBE,
                    tested=True,
                    message=message,
                )
                if capability == CapabilityName.TOOLS and support != Support.YES:
                    break
        profile = capability_resolver.record_probe(request, probe_results)
        if IMAGE_INPUT_MODALITY not in request.input_modalities:
            capabilities["vision"] = AiModelCapabilityTest(
                support=profile.support(CapabilityName.VISION),
                source=profile.source(CapabilityName.VISION),
                tested=False,
                message="模型配置未声明图片输入",
            )
        else:
            try:
                probe_image_input(request, MODEL_TEST_TIMEOUT_SECONDS)
            except LlmCompletionError as error:
                capabilities["vision"] = AiModelCapabilityTest(
                    support=Support.UNKNOWN,
                    source=CapabilitySource.RUNTIME_PROBE,
                    tested=True,
                    message=redact_model_test_error(str(error), request.api_key),
                )
            else:
                probe_results[CapabilityName.VISION] = Support.YES
                capabilities["vision"] = AiModelCapabilityTest(
                    support=Support.YES,
                    source=CapabilitySource.RUNTIME_PROBE,
                    tested=True,
                    message="图片输入正常",
                )
                if probe_results.get(CapabilityName.TOOLS) == Support.YES:
                    support, message = run_model_probe(
                        probe_vision_tools,
                        request,
                        "图片与工具组合",
                    )
                    probe_results[CapabilityName.VISION_TOOLS] = support
                    capabilities[CapabilityName.VISION_TOOLS.value] = (
                        AiModelCapabilityTest(
                            support=support,
                            source=CapabilitySource.RUNTIME_PROBE,
                            tested=True,
                            message=message,
                        )
                    )
        if (
            profile.support(CapabilityName.REASONING) == Support.YES
            and probe_results.get(CapabilityName.TOOLS) == Support.YES
        ):
            support, message = run_model_probe(
                probe_reasoning_tools,
                request,
                "推理与工具组合",
            )
            probe_results[CapabilityName.REASONING_TOOLS] = support
            capabilities[CapabilityName.REASONING_TOOLS.value] = AiModelCapabilityTest(
                support=support,
                source=CapabilitySource.RUNTIME_PROBE,
                tested=True,
                message=message,
            )
        if probe_results.get(CapabilityName.TOOLS) == Support.YES:
            probe_results[CapabilityName.TOOL_CHOICE_AUTO] = Support.YES
        profile = capability_resolver.record_probe(request, probe_results)
        for capability in CAPABILITY_NAMES:
            capabilities.setdefault(
                capability.value,
                AiModelCapabilityTest(
                    support=profile.support(capability),
                    source=profile.source(capability),
                    tested=False,
                    message="未执行该项独立探测",
                ),
            )
        return AiModelTestResponse(
            available=True,
            latency_ms=round((perf_counter() - started_at) * MILLISECONDS_PER_SECOND),
            message=MODEL_TEST_SUCCESS_MESSAGE,
            capabilities=capabilities,
            profile=profile,
        )


def redact_model_test_error(message: str, api_key: str | None) -> str:
    if not api_key:
        return message
    return message.replace(api_key, MODEL_TEST_REDACTED_SECRET)


def run_model_probe(
    probe: Callable[[AiModelConfiguration, int], None],
    model: AiModelConfiguration,
    label: str,
) -> tuple[Support, str]:
    try:
        probe(model, MODEL_TEST_TIMEOUT_SECONDS)
    except ToolCallingUnsupportedError as error:
        message = redact_model_test_error(str(error), model.api_key)
        return Support.NO, f"{label}已确认不支持：{message}"
    except LlmRuntimeError as error:
        message = redact_model_test_error(str(error), model.api_key)
        return Support.UNKNOWN, f"{label}探测未确认：{message}"
    return Support.YES, f"{label}正常"
