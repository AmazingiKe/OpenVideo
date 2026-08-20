import re
from urllib.parse import SplitResult, urlunsplit

from openvideo.core.models import SourcePlatform
from openvideo.tools.sources.base import SourceMatch, VideoSource


DOUYIN_VIDEO_HOSTS = {"douyin.com", "www.douyin.com", "m.douyin.com"}
DOUYIN_SHORT_LINK_HOSTS = {"v.douyin.com"}
DOUYIN_VIDEO_ID_PATTERN = re.compile(r"^[0-9]+$")
DOUYIN_SHORT_CODE_PATTERN = re.compile(r"^[0-9A-Za-z_-]+$")


class DouyinSource(VideoSource):
    """识别公开抖音视频及其分享短链，让通用下载流程不依赖平台 URL 细节。"""

    @property
    def platform(self) -> SourcePlatform:
        return SourcePlatform.DOUYIN

    def match(self, parsed_url: SplitResult) -> SourceMatch | None:
        hostname = parsed_url.hostname.casefold() if parsed_url.hostname else ""
        if hostname in DOUYIN_VIDEO_HOSTS:
            return self._match_video_url(parsed_url)
        if hostname in DOUYIN_SHORT_LINK_HOSTS:
            return self._match_short_link(parsed_url)
        return None

    def _match_video_url(self, parsed_url: SplitResult) -> SourceMatch:
        path_parts = [part for part in parsed_url.path.split("/") if part]
        if len(path_parts) != 2 or path_parts[0].casefold() != "video":
            raise ValueError("目前只支持公开抖音单视频链接")
        source_video_id = path_parts[1]
        if not DOUYIN_VIDEO_ID_PATTERN.fullmatch(source_video_id):
            raise ValueError("未识别到有效的抖音视频 ID")
        normalized_url = urlunsplit(
            ("https", "www.douyin.com", f"/video/{source_video_id}", "", "")
        )
        return SourceMatch(
            platform=SourcePlatform.DOUYIN,
            normalized_url=normalized_url,
            source_video_id=source_video_id,
            is_playlist=False,
        )

    def _match_short_link(self, parsed_url: SplitResult) -> SourceMatch:
        short_code = parsed_url.path.strip("/")
        if not short_code or "/" in short_code or not DOUYIN_SHORT_CODE_PATTERN.fullmatch(short_code):
            raise ValueError("抖音短链格式无效")
        normalized_url = urlunsplit(("https", "v.douyin.com", f"/{short_code}", "", ""))
        return SourceMatch(
            platform=SourcePlatform.DOUYIN,
            normalized_url=normalized_url,
            source_video_id=None,
            is_playlist=False,
        )
