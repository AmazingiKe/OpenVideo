from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from contextlib import aclosing, contextmanager
from typing import Any

from agno.exceptions import AgnoError, ModelProviderError
from agno.models.deepseek import DeepSeek
from agno.models.response import ModelResponse

from openvideo.llm.credentials import redact_model_secrets


class CredentialSafeDeepSeek(DeepSeek):
    """在 Agno 保存失败会话前清理供应商错误，保留 SDK 的错误分类与重试信息。"""

    @contextmanager
    def _redact_provider_errors(self) -> Iterator[None]:
        try:
            yield
        except AgnoError as error:
            message = redact_model_secrets(str(error))
            error.message = message
            error.args = (message,)
            error.__context__ = None
            raise error from None
        except Exception as error:
            raise ModelProviderError(
                message=redact_model_secrets(str(error)),
                model_name=self.name,
                model_id=self.id,
            ) from None

    def invoke(self, *args: Any, **kwargs: Any) -> ModelResponse:
        with self._redact_provider_errors():
            return super().invoke(*args, **kwargs)

    async def ainvoke(self, *args: Any, **kwargs: Any) -> ModelResponse:
        with self._redact_provider_errors():
            return await super().ainvoke(*args, **kwargs)

    def invoke_stream(self, *args: Any, **kwargs: Any) -> Iterator[ModelResponse]:
        with self._redact_provider_errors():
            yield from super().invoke_stream(*args, **kwargs)

    async def ainvoke_stream(
        self, *args: Any, **kwargs: Any
    ) -> AsyncIterator[ModelResponse]:
        with self._redact_provider_errors():
            async with aclosing(super().ainvoke_stream(*args, **kwargs)) as responses:
                async for response in responses:
                    yield response
