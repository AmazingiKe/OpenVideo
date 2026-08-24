import re
from urllib.parse import SplitResult, parse_qs, urlencode, urlunsplit

from openvideo.core.media_models import SourcePlatform
from openvideo.tools.sources.base import SourceMatch, VideoSource


BILIBILI_HOSTS = {"bilibili.com", "www.bilibili.com", "m.bilibili.com"}
SHORT_LINK_HOSTS = {"b23.tv", "www.b23.tv"}
BILIBILI_CANONICAL_HOST = "www.bilibili.com"
BILIBILI_VIDEO_PATH_PREFIX = "/video"
BILIBILI_PART_PARAMETER = "p"
BILIBILI_PART_ID_SEPARATOR = "_p"
BVID_VALUE_PATTERN = r"BV[0-9A-Za-z]{10}"
BVID_PATTERN = re.compile(rf"^{BVID_VALUE_PATTERN}$", re.IGNORECASE)
BILIBILI_SOURCE_VIDEO_ID_PATTERN = re.compile(
    rf"^(?P<bvid>{BVID_VALUE_PATTERN})"
    rf"(?:{re.escape(BILIBILI_PART_ID_SEPARATOR)}[1-9][0-9]*)?$",
    re.IGNORECASE,
)
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
        query = parse_qs(parsed_url.query, keep_blank_values=True)
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
        bvid = path_parts[1]
        if not BVID_PATTERN.fullmatch(bvid):
            raise ValueError("未识别到有效的 BV 号")
        part_number = _positive_query_integer(
            query,
            BILIBILI_PART_PARAMETER,
            "Bilibili 分P序号必须是正整数",
        )
        normalized_url = build_bilibili_video_url(bvid, part_number)
        source_video_id = bilibili_source_video_id(bvid, part_number)
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


def _positive_query_integer(
    query: dict[str, list[str]],
    parameter: str,
    error_message: str,
) -> int | None:
    """查询参数会进入下载地址和持久化 ID，因此只接受唯一、无歧义的正整数。"""
    values = query.get(parameter)
    if values is None:
        return None
    if len(values) != 1 or not values[0].isdecimal():
        raise ValueError(error_message)
    value = int(values[0])
    if value < 1:
        raise ValueError(error_message)
    return value


def bilibili_source_video_id(bvid: str, part_number: int | None) -> str:
    """同一 BV 的不同分P是独立媒体资源，持久化 ID 必须保留分P序号以避免误去重。"""
    if part_number is None:
        return bvid
    return f"{bvid}{BILIBILI_PART_ID_SEPARATOR}{part_number}"


def build_bilibili_video_url(bvid: str, part_number: int | None = None) -> str:
    """只保留影响媒体选择的分P参数，避免追踪参数进入任务和资料库。"""
    query = (
        urlencode({BILIBILI_PART_PARAMETER: part_number})
        if part_number is not None
        else ""
    )
    return urlunsplit(
        (
            "https",
            BILIBILI_CANONICAL_HOST,
            f"{BILIBILI_VIDEO_PATH_PREFIX}/{bvid}",
            query,
            "",
        )
    )


def bilibili_base_video_id(source_video_id: str) -> str:
    """Bilibili 详情接口只接受基础 BV 号，需要从分P资源 ID 中还原该值。"""
    match = BILIBILI_SOURCE_VIDEO_ID_PATTERN.fullmatch(source_video_id)
    return match.group("bvid") if match else source_video_id
