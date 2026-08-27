from __future__ import annotations

import json
from typing import Any

import litellm

from openvideo.core.ai_models import AiModelConfiguration
from openvideo.llm.errors import (
    ModelCapabilityUnknownError,
    ProviderRequestError,
    classify_provider_error,
)


BASIC_TOOL_PROMPT = "Call report_probe with status set to ok. Do not answer normally."
VISION_PROBE_DATA_URL = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUB"
    "AScY42YAAAAASUVORK5CYII="
)
REPORT_PROBE_TOOL = {
    "type": "function",
    "function": {
        "name": "report_probe",
        "description": "Report tool calling capability.",
        "parameters": {
            "type": "object",
            "properties": {
                "status": {"type": "string", "enum": ["ok"]},
            },
            "required": ["status"],
            "additionalProperties": False,
        },
    },
}
SECOND_PROBE_TOOL = {
    "type": "function",
    "function": {
        "name": "confirm_probe",
        "description": "Confirm parallel tool calling capability.",
        "parameters": {
            "type": "object",
            "properties": {
                "status": {"type": "string", "enum": ["ok"]},
            },
            "required": ["status"],
            "additionalProperties": False,
        },
    },
}


def probe_basic_tools(model: AiModelConfiguration, timeout_seconds: int) -> None:
    request = _base_request(model, timeout_seconds)
    request.update(
        messages=[{"role": "user", "content": BASIC_TOOL_PROMPT}],
        tools=[REPORT_PROBE_TOOL],
        tool_choice="auto",
        thinking={"type": "disabled"},
    )
    response = _completion(request)
    _require_tool_calls(response.choices[0].message.tool_calls, {"report_probe"})


def probe_streaming_tools(model: AiModelConfiguration, timeout_seconds: int) -> None:
    request = _base_request(model, timeout_seconds)
    request.update(
        messages=[{"role": "user", "content": BASIC_TOOL_PROMPT}],
        tools=[REPORT_PROBE_TOOL],
        tool_choice="auto",
        thinking={"type": "disabled"},
        stream=True,
    )
    stream = _completion(request)
    names: set[str] = set()
    try:
        for chunk in stream:
            for tool_call in chunk.choices[0].delta.tool_calls or []:
                name = tool_call.function.name
                if name:
                    names.add(name)
    except Exception as error:
        raise classify_provider_error(error) from error
    _require_tool_names(names, {"report_probe"})


def probe_reasoning_tools(model: AiModelConfiguration, timeout_seconds: int) -> None:
    request = _base_request(model, timeout_seconds)
    request.update(
        messages=[{"role": "user", "content": BASIC_TOOL_PROMPT}],
        tools=[REPORT_PROBE_TOOL],
        thinking={"type": "enabled"},
    )
    response = _completion(request)
    _require_tool_calls(response.choices[0].message.tool_calls, {"report_probe"})


def probe_named_tool_choice(model: AiModelConfiguration, timeout_seconds: int) -> None:
    request = _base_request(model, timeout_seconds)
    request.update(
        messages=[{"role": "user", "content": BASIC_TOOL_PROMPT}],
        tools=[REPORT_PROBE_TOOL],
        tool_choice={
            "type": "function",
            "function": {"name": "report_probe"},
        },
        thinking={"type": "disabled"},
    )
    response = _completion(request)
    _require_tool_calls(response.choices[0].message.tool_calls, {"report_probe"})


def probe_parallel_tools(model: AiModelConfiguration, timeout_seconds: int) -> None:
    request = _base_request(model, timeout_seconds)
    request.update(
        messages=[
            {
                "role": "user",
                "content": (
                    "Call report_probe and confirm_probe, both with status set to ok. "
                    "Do not answer normally."
                ),
            }
        ],
        tools=[REPORT_PROBE_TOOL, SECOND_PROBE_TOOL],
        tool_choice="auto",
        thinking={"type": "disabled"},
        parallel_tool_calls=True,
    )
    response = _completion(request)
    _require_tool_calls(
        response.choices[0].message.tool_calls,
        {"report_probe", "confirm_probe"},
    )


def probe_vision_tools(model: AiModelConfiguration, timeout_seconds: int) -> None:
    request = _base_request(model, timeout_seconds)
    request.update(
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": BASIC_TOOL_PROMPT},
                    {
                        "type": "image_url",
                        "image_url": {"url": VISION_PROBE_DATA_URL},
                    },
                ],
            }
        ],
        tools=[REPORT_PROBE_TOOL],
        tool_choice="auto",
        thinking={"type": "disabled"},
    )
    response = _completion(request)
    _require_tool_calls(response.choices[0].message.tool_calls, {"report_probe"})


def _base_request(model: AiModelConfiguration, timeout_seconds: int) -> dict[str, Any]:
    request: dict[str, Any] = {
        "model": model.litellm_model,
        "timeout": timeout_seconds,
        "max_tokens": 64,
    }
    if model.api_key:
        request["api_key"] = model.api_key
    if model.api_base:
        request["api_base"] = model.api_base
    if model.api_version:
        request["api_version"] = model.api_version
    return request


def _completion(request: dict[str, Any]) -> Any:
    try:
        return litellm.completion(**request)
    except Exception as error:
        raise classify_provider_error(error) from error


def _require_tool_calls(tool_calls: Any, expected_names: set[str]) -> None:
    if not tool_calls:
        raise ModelCapabilityUnknownError("模型未返回工具调用，能力仍为未知")
    names: set[str] = set()
    for tool_call in tool_calls:
        function = tool_call.function
        names.add(function.name)
        if function.name == "report_probe":
            arguments = function.arguments
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except json.JSONDecodeError as error:
                    raise ProviderRequestError("工具参数不是有效 JSON") from error
            if not isinstance(arguments, dict) or arguments.get("status") != "ok":
                raise ProviderRequestError("模型返回了错误的探测工具参数")
    _require_tool_names(names, expected_names)


def _require_tool_names(names: set[str], expected_names: set[str]) -> None:
    if not expected_names.issubset(names):
        raise ModelCapabilityUnknownError("模型未返回预期工具调用，能力仍为未知")
