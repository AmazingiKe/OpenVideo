import json

import pytest

from openvideo.agent_intent_router import (
    AgentIntentRoutingError,
    route_agent_intent,
)
from openvideo.core.agent_governance_models import AgentRetrievalScope
from openvideo.core.ai_models import AiModelConfiguration
from openvideo.core.identifiers import uuid7


def test_router_validates_structured_fast_model_decision(monkeypatch):
    captured: dict[str, object] = {}

    def complete_route(model, messages, *args, **kwargs):
        captured["messages"] = messages
        captured["args"] = args
        captured["kwargs"] = kwargs
        return json.dumps(
            {
                "intent": "illustrate",
                "model_role": "complex",
                "reason": "需要检查画面并生成媒体建议",
            }
        )

    monkeypatch.setattr("openvideo.agent_intent_router.complete_text", complete_route)
    route = route_agent_intent(
        model_configuration(),
        agent_id="summary",
        content="给这一段插入关键画面",
        retrieval_scope=AgentRetrievalScope.CURRENT_ASSET,
        requested_intent=None,
    )

    assert route.intent == "illustrate"
    assert route.model_role == "complex"
    request_payload = json.loads(captured["messages"][-1]["content"])
    assert request_payload["allowed_intents"] == ["chat", "edit", "illustrate"]
    assert request_payload["user_request"] == "给这一段插入关键画面"
    assert captured["args"][-1] is True
    assert captured["kwargs"]["priority"].name == "FOREGROUND"


@pytest.mark.parametrize(
    "response",
    [
        "```json\n{}\n```",
        '{"intent":"illustrate","model_role":"fast","reason":"越界"}',
        '{"intent":"chat","model_role":"vision","reason":"无效角色"}',
    ],
)
def test_router_rejects_invalid_or_out_of_scope_decision(monkeypatch, response):
    monkeypatch.setattr(
        "openvideo.agent_intent_router.complete_text",
        lambda *_args, **_kwargs: response,
    )

    with pytest.raises(AgentIntentRoutingError):
        route_agent_intent(
            model_configuration(),
            agent_id="marker",
            content="测试请求",
            retrieval_scope=AgentRetrievalScope.CURRENT_ASSET,
            requested_intent=None,
        )


def model_configuration() -> AiModelConfiguration:
    return AiModelConfiguration(
        model_id=f"model-{uuid7().hex}",
        name="快速模型",
        litellm_model="openai/test",
    )
