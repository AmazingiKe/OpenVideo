import re
from urllib.parse import SplitResult, parse_qs, urlunsplit

from openvideo.core.models import SourcePlatform
from openvideo.tools.sources.base import SourceMatch, VideoSource


BILIBILI_HOSTS = {"bilibili.com", "www.bilibili.com", "m.bilibili.com"}
SHORT_LINK_HOSTS = {"b23.tv", "www.b23.tv"}
BVID_PATTERN = re.compile(r"^BV[0-9A-Za-z]{10}$", re.IGNORECASE)
SHORT_LINK_PATTERN = re.compile(r"^[0-9A-Za-z]+$")


class BilibiliSource(VideoSource):
    """Bilibili 单视频、官方短链与合集/播放列表的识别。"""

    @property
    def platform(self) -> SourcePlatform:
        return SourcePlatform.BILIBILI

    def match(self, parsed_url: SplitResult) -> SourceMatch | None:
        hostname = parsed_url.hostname.casefold() if parsed_url.hostname else ""
        if hostname in BILIBILI_HOSTS:
            return self._match_main_site(parsed_url)
        if hostname in SHORT_LINK_HOSTS:
            return self._match_short_link(parsed_url)
        return None

    def _match_main_site(self, parsed_url: SplitResult) -> SourceMatch:
        query = parse_qs(parsed_url.query)
        list_id = _first(query.get("list"))
        path_parts = [part for part in parsed_url.path.split("/") if part]
        # /list/... 是收藏夹或合集播放页，整体作为播放列表处理。
        if path_parts and path_parts[0].casefold() == "list":
            playlist_url = parsed_url.geturl()
            return SourceMatch(
                platform=SourcePlatform.BILIBILI,
                normalized_url=playlist_url,
                source_video_id=None,
                is_playlist=True,
                playlist_url=playlist_url,
            )
        # 合集列表通过 query 的 list= 进入但没有 BV 号时，同样作为播放列表处理。
        if list_id and (not path_parts or path_parts[0].casefold() != "video"):
            playlist_url = urlunsplit(
                ("https", "www.bilibili.com", "/list/ml" + list_id, "", "")
            )
            return SourceMatch(
                platform=SourcePlatform.BILIBILI,
                normalized_url=playlist_url,
                source_video_id=None,
                is_playlist=True,
                playlist_url=playlist_url,
            )
        if len(path_parts) != 2 or path_parts[0].casefold() != "video":
            raise ValueError("目前只支持 Bilibili 视频、合集或播放列表页面")
        source_video_id = path_parts[1]
        if not BVID_PATTERN.fullmatch(source_video_id):
            raise ValueError("未识别到有效的 BV 号")
        normalized_url = urlunsplit(
            ("https", "www.bilibili.com", f"/video/{source_video_id}", "", "")
        )
        # 带 list= 的单视频既能单下，也能作为进入合集的入口，交给探测判断整列表。
        return SourceMatch(
            platform=SourcePlatform.BILIBILI,
            normalized_url=normalized_url,
            source_video_id=source_video_id,
            is_playlist=bool(list_id),
            playlist_url=parsed_url.geturl() if list_id else None,
        )

    def _match_short_link(self, parsed_url: SplitResult) -> SourceMatch:
        path = parsed_url.path.strip("/")
        if not path or "/" in path or not SHORT_LINK_PATTERN.fullmatch(path):
            raise ValueError("Bilibili 短链接格式无效")
        normalized_url = urlunsplit(("https", "b23.tv", f"/{path}", "", ""))
        return SourceMatch(
            platform=SourcePlatform.BILIBILI,
            normalized_url=normalized_url,
            source_video_id=None,
            is_playlist=False,
        )


def _first(values: list[str] | None) -> str | None:
    return values[0] if values else None
