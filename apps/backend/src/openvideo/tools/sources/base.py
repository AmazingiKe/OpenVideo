from abc import ABC, abstractmethod
from dataclasses import dataclass
from urllib.parse import SplitResult

from openvideo.core.media_models import SourcePlatform


class UnsupportedSourceError(ValueError):
    """输入的地址不属于任何已注册平台，或格式不合法。"""


@dataclass(frozen=True)
class SourceMatch:
    """一次成功的平台识别结果，是下载、去重与批量任务的统一入口。"""

    platform: SourcePlatform
    normalized_url: str
    source_video_id: str | None
    is_playlist: bool
    playlist_url: str | None = None


class VideoSource(ABC):
    """平台特有的 URL 识别与规范化。下载执行与平台无关，只依赖 SourceMatch。"""

    @property
    @abstractmethod
    def platform(self) -> SourcePlatform:
        raise NotImplementedError

    @property
    def requires_login(self) -> bool:
        # 预留位：未来引入账号登录的平台在此返回 True，本版所有平台均为公开免登录。
        return False

    @abstractmethod
    def match(self, parsed_url: SplitResult) -> SourceMatch | None:
        """识别一个已通过通用校验的 URL；不属于本平台时返回 None。"""
        raise NotImplementedError
