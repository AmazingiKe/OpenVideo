from __future__ import annotations

import json
import logging
import traceback
from types import SimpleNamespace

import pytest

from openvideo.core.ai_models import AiModelConfiguration
from openvideo.llm import probes
from openvideo.llm.credentials import (
    ModelCredentialError,
    redact_model_secrets,
    resolve_model_api_key,
)
from openvideo.llm.model_factory import create_agent_model
from openvideo.llm.model_profile import ModelProfile
from openvideo.preferences import Preferences, PreferenceStore
from openvideo.settings import load_settings, preferences_from_settings
from openvideo.tools import llm


DUMMY_KEY = "dummy-deepseek-key-not-a-real-credential"
ROTATED_DUMMY_KEY = "rotated-dummy-key-not-a-real-credential"
ENV_REFERENCE = "env:DEEPSEEK_API_KEY"


@pytest.fixture(autouse=True)
def dummy_environment(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", DUMMY_KEY)
    monkeypatch.delenv("OPENVIDEO_AI_MODELS", raising=False)


def configured_model(**overrides) -> AiModelConfiguration:
    return AiModelConfiguration(
        **{
            "name": "环境引用测试",
            "litellm_model": "deepseek/deepseek-test-model",
            "api_key": ENV_REFERENCE,
            **overrides,
        }
    )


def text_response() -> SimpleNamespace:
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content="OK"))]
    )


def test_resolve_does_not_mutate_settings_or_persist_secret(tmp_path):
    model = configured_model()
    original = model.model_dump_json()
    assert resolve_model_api_key(model) == DUMMY_KEY
    assert model.model_dump_json() == original
    store = PreferenceStore(tmp_path / "preferences.json")
    store.save(Preferences(ai_models=[model]))
    settings = load_settings(store)
    store.save(preferences_from_settings(settings, None))
    saved = store.path.read_text()
    assert ENV_REFERENCE in saved
    assert DUMMY_KEY not in saved
    assert settings.ai_models[0].api_key == ENV_REFERENCE


@pytest.mark.parametrize("value", [None, "", "   "])
def test_missing_reference_fails_without_provider_request(monkeypatch, value):
    if value is None:
        monkeypatch.delenv("DEEPSEEK_API_KEY")
    else:
        monkeypatch.setenv("DEEPSEEK_API_KEY", value)
    monkeypatch.setattr(
        llm.litellm, "completion", lambda **_: pytest.fail("无密钥不能请求")
    )
    with pytest.raises(llm.LlmCompletionError, match="未设置后端环境变量"):
        llm.complete_text(configured_model(), [], 1)


@pytest.mark.parametrize(
    "endpoint",
    [
        "https://example.com/v1",
        "https://api.deepseek.com.evil.example",
        "https://sub.api.deepseek.com",
        "https://user@api.deepseek.com",
        "https://api.deepseek.com:8443",
        "https://api.deepseek.com:invalid",
        "http://api.deepseek.com",
        "https://api.deepseek.com/v1?forward=example.com",
        "https://api.deepseek.com/#fragment",
        "https://api.deepseek.com/unrecognized",
    ],
)
def test_environment_reference_rejects_other_destinations(endpoint):
    with pytest.raises(ModelCredentialError, match="官方 DeepSeek"):
        resolve_model_api_key(configured_model(api_base=endpoint))


@pytest.mark.parametrize(
    "endpoint",
    [
        None,
        "https://api.deepseek.com",
        "https://api.deepseek.com/v1/",
        "https://api.deepseek.com:443",
    ],
)
def test_environment_reference_accepts_official_endpoint(endpoint):
    assert resolve_model_api_key(configured_model(api_base=endpoint)) == DUMMY_KEY


@pytest.mark.parametrize("reference", ["env:OTHER_API_KEY", "env:PATH", "env:"])
def test_arbitrary_environment_reads_are_rejected(reference):
    with pytest.raises(ModelCredentialError, match="仅支持 env:DEEPSEEK_API_KEY"):
        resolve_model_api_key(configured_model(api_key=reference))


def test_other_provider_cannot_borrow_deepseek_key():
    with pytest.raises(ModelCredentialError, match="官方 DeepSeek"):
        resolve_model_api_key(configured_model(litellm_model="openai/test"))


def test_blank_deepseek_key_cannot_use_ambient_credentials():
    with pytest.raises(ModelCredentialError, match="填写 API 密钥"):
        resolve_model_api_key(
            configured_model(api_key=None, api_base="https://example.com")
        )


def test_uppercase_provider_cannot_bypass_blank_key_guard():
    with pytest.raises(ModelCredentialError, match="填写 API 密钥"):
        resolve_model_api_key(
            configured_model(
                litellm_model="DEEPSEEK/test",
                api_key=None,
                api_base="https://example.com",
            )
        )


def test_literal_key_remains_compatible_with_custom_endpoint():
    assert (
        resolve_model_api_key(
            configured_model(api_key=DUMMY_KEY, api_base="https://example.com")
        )
        == DUMMY_KEY
    )


@pytest.mark.parametrize("images", [False, True])
def test_text_and_image_requests_resolve_only_at_transport(monkeypatch, images):
    captured = {}
    monkeypatch.setenv("DEEPSEEK_API_BASE", "https://untrusted.example")

    def complete(**request):
        captured.update(request)
        return text_response()

    monkeypatch.setattr(llm.litellm, "completion", complete)
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "type": "image_url",
                    "image_url": {"url": "data:image/png;base64,dummy"},
                }
            ]
            if images
            else "test",
        }
    ]
    model = configured_model()
    assert llm.complete_text(model, messages, 1) == "OK"
    assert captured["api_key"] == DUMMY_KEY
    assert captured["api_base"] == "https://api.deepseek.com"
    assert model.api_key == ENV_REFERENCE


@pytest.mark.asyncio
async def test_async_request_and_error_are_redacted(monkeypatch):
    async def fail(**request):
        assert request["api_key"] == DUMMY_KEY
        raise RuntimeError(f"authentication failed: {DUMMY_KEY}")

    monkeypatch.setattr(llm.litellm, "acompletion", fail)
    with pytest.raises(llm.LlmCompletionError) as raised:
        await llm.complete_text_async(configured_model(), [], 1)
    assert DUMMY_KEY not in "".join(traceback.format_exception(raised.value))
    assert "[已隐藏]" in str(raised.value)


def test_sync_error_is_redacted_before_caller_can_save_it(monkeypatch):
    def fail(**request):
        assert request["api_key"] == DUMMY_KEY
        raise RuntimeError(f"authentication failed: {DUMMY_KEY}")

    monkeypatch.setattr(llm.litellm, "completion", fail)
    with pytest.raises(llm.LlmCompletionError) as raised:
        llm.complete_text(configured_model(), [], 1)
    assert DUMMY_KEY not in "".join(traceback.format_exception(raised.value))
    assert "[已隐藏]" in str(raised.value)


def test_probe_and_agent_factory_use_the_reference(monkeypatch):
    captured = {}

    def fail(**request):
        captured.update(request)
        raise RuntimeError(f"authentication failed: {DUMMY_KEY}")

    monkeypatch.setattr(probes.litellm, "completion", fail)
    with pytest.raises(Exception) as raised:
        probes.probe_basic_tools(configured_model(), 1)
    assert captured["api_key"] == DUMMY_KEY
    assert captured["api_base"] == "https://api.deepseek.com"
    assert DUMMY_KEY not in "".join(traceback.format_exception(raised.value))
    model = create_agent_model(
        configured_model(),
        ModelProfile(provider="deepseek", model="deepseek-test-model"),
    )
    assert model.api_key == DUMMY_KEY
    assert DUMMY_KEY not in json.dumps(model.to_dict())


def test_rotation_changes_visual_cache_key_and_redacts_inflight_errors(monkeypatch):
    model = configured_model()
    first = llm._vision_transport_cache_key(model)
    monkeypatch.setenv("DEEPSEEK_API_KEY", ROTATED_DUMMY_KEY)
    second = llm._vision_transport_cache_key(model)
    assert first != second
    assert DUMMY_KEY not in repr(first)
    assert (
        redact_model_secrets(f"{DUMMY_KEY} {ROTATED_DUMMY_KEY}") == "[已隐藏] [已隐藏]"
    )


def test_sdk_logs_redact_message_arguments_and_exception_before_handlers(caplog):
    resolve_model_api_key(configured_model())
    with caplog.at_level(logging.ERROR):
        try:
            raise RuntimeError(DUMMY_KEY)
        except RuntimeError:
            logging.getLogger("openvideo.test.sdk").exception(
                "provider failed: %s", DUMMY_KEY
            )
    assert DUMMY_KEY not in caplog.text
    assert "[已隐藏]" in caplog.text
    assert all(record.exc_info is None for record in caplog.records)


def test_log_redaction_preserves_uvicorn_access_formatter_parameters():
    from uvicorn.logging import AccessFormatter

    resolve_model_api_key(configured_model())
    record = logging.getLogRecordFactory()(
        "uvicorn.access",
        logging.INFO,
        __file__,
        1,
        '%s - "%s %s HTTP/%s" %d',
        ("127.0.0.1", "GET", f"/dummy?key={DUMMY_KEY}", "1.1", 200),
        None,
    )
    formatted = AccessFormatter(
        fmt="%(client_addr)s %(request_line)s %(status_code)s", use_colors=False
    ).format(record)
    assert "200 OK" in formatted
    assert DUMMY_KEY not in formatted
    assert "[已隐藏]" in formatted
    assert len(record.args) == 5


def test_explicit_uvicorn_env_file_preserves_existing_process_values(
    tmp_path, monkeypatch
):
    from uvicorn import Config

    env_file = tmp_path / "dummy.env"
    env_file.write_text("DEEPSEEK_API_KEY=dummy-file-key-not-real\n")
    monkeypatch.setenv("DEEPSEEK_API_KEY", DUMMY_KEY)
    Config("openvideo.ui.api:app", env_file=env_file, log_config=None)
    assert resolve_model_api_key(configured_model()) == DUMMY_KEY
    monkeypatch.delenv("DEEPSEEK_API_KEY")
    Config("openvideo.ui.api:app", env_file=env_file, log_config=None)
    assert resolve_model_api_key(configured_model()) == "dummy-file-key-not-real"
    assert env_file.read_text() == "DEEPSEEK_API_KEY=dummy-file-key-not-real\n"


def test_log_redaction_handles_exception_and_bytes_arguments(caplog):
    resolve_model_api_key(configured_model())
    with caplog.at_level(logging.ERROR):
        logger = logging.getLogger("openvideo.test.sdk")
        logger.error(RuntimeError(DUMMY_KEY))
        logger.error(
            "provider failed: %s %r", RuntimeError(DUMMY_KEY), DUMMY_KEY.encode()
        )
    assert DUMMY_KEY not in caplog.text
    assert "[已隐藏]" in caplog.text
