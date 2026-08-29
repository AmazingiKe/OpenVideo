from types import SimpleNamespace

from openvideo.llm.errors import (
    ProviderRequestError,
    TransientProviderRequestError,
    classify_provider_error,
    provider_retry_delay_seconds,
)


class ProviderError(RuntimeError):
    def __init__(self, status_code: int, retry_after: str | None = None) -> None:
        super().__init__(f"provider returned {status_code}")
        self.status_code = status_code
        self.response = SimpleNamespace(
            headers={} if retry_after is None else {"Retry-After": retry_after}
        )


def test_rate_limit_preserves_retry_after_delay():
    error = classify_provider_error(ProviderError(429, "3"))

    assert isinstance(error, TransientProviderRequestError)
    assert error.retry_after_seconds == 3
    assert provider_retry_delay_seconds(error, 0) == 3


def test_authentication_failure_is_not_transient():
    error = classify_provider_error(ProviderError(401))

    assert type(error) is ProviderRequestError
