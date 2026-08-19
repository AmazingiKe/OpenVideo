import re
from urllib.parse import SplitResult, parse_qs, urlencode, urlunsplit

from openvideo.core.models import SourcePlatform
from openvideo.tools.sources.base import SourceMatch, VideoSource


YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"}
SHORT_LINK_HOSTS = {"youtu.be"}
VIDEO_ID_PATTERN = re.compile(r"^[0-9A-Za-z_-]{11}$")
PLAYLIST_ID_PATTERN = re.compile(r"^[0-9A-Za-z_-]{10,64}$")


class YoutubeSource(VideoSource):
    """YouTube 单视频、youtu.be 短链与播放列表的识别。"""

    @property
    def platform(self) -> SourcePlatform:
        return SourcePlatform.YOUTUBE

    def match(self, parsed_url: SplitResult) -> SourceMatch | None:
        hostname = parsed_url.hostname.casefold() if parsed_url.hostname else ""
        if hostname in SHORT_LINK_HOSTS:
            return self._match_short_link(parsed_url)
        if hostname in YOUTUBE_HOSTS:
            return self._match_main_site(parsed_url)
        return None

    def _match_main_site(self, parsed_url: SplitResult) -> SourceMatch:
        query = parse_qs(parsed_url.query)
        path = parsed_url.path.rstrip("/").casefold()
        video_id = _first(query.get("v"))
        playlist_id = _first(query.get("list"))

        # 纯播放列表页：/playlist?list=...，没有具体视频。
        if path == "/playlist":
            if not playlist_id or not PLAYLIST_ID_PATTERN.fullmatch(playlist_id):
                raise ValueError("未识别到有效的 YouTube 播放列表 ID")
            return self._playlist_match(playlist_id)

        if path == "/watch":
            if not video_id or not VIDEO_ID_PATTERN.fullmatch(video_id):
                raise ValueError("未识别到有效的 YouTube 视频 ID")
            has_playlist = bool(playlist_id and PLAYLIST_ID_PATTERN.fullmatch(playlist_id))
            return SourceMatch(
                platform=SourcePlatform.YOUTUBE,
                normalized_url=_watch_url(video_id),
                source_video_id=video_id,
                is_playlist=has_playlist,
                playlist_url=_playlist_url(playlist_id) if has_playlist else None,
            )

        raise ValueError("目前只支持 YouTube 视频或播放列表页面")

    def _match_short_link(self, parsed_url: SplitResult) -> SourceMatch:
        video_id = parsed_url.path.strip("/")
        if not VIDEO_ID_PATTERN.fullmatch(video_id):
            raise ValueError("YouTube 短链接格式无效")
        query = parse_qs(parsed_url.query)
        playlist_id = _first(query.get("list"))
        has_playlist = bool(playlist_id and PLAYLIST_ID_PATTERN.fullmatch(playlist_id))
        return SourceMatch(
            platform=SourcePlatform.YOUTUBE,
            normalized_url=_watch_url(video_id),
            source_video_id=video_id,
            is_playlist=has_playlist,
            playlist_url=_playlist_url(playlist_id) if has_playlist else None,
        )

    def _playlist_match(self, playlist_id: str) -> SourceMatch:
        playlist_url = _playlist_url(playlist_id)
        return SourceMatch(
            platform=SourcePlatform.YOUTUBE,
            normalized_url=playlist_url,
            source_video_id=None,
            is_playlist=True,
            playlist_url=playlist_url,
        )


def _watch_url(video_id: str) -> str:
    return urlunsplit(("https", "www.youtube.com", "/watch", urlencode({"v": video_id}), ""))


def _playlist_url(playlist_id: str) -> str:
    return urlunsplit(
        ("https", "www.youtube.com", "/playlist", urlencode({"list": playlist_id}), "")
    )


def _first(values: list[str] | None) -> str | None:
    return values[0] if values else None
