import re
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit


MAX_SOURCE_URL_LENGTH = 2048
BILIBILI_HOSTS = {"bilibili.com", "www.bilibili.com", "m.bilibili.com"}
SHORT_LINK_HOSTS = {"b23.tv", "www.b23.tv"}
BVID_PATTERN = re.compile(r"^BV[0-9A-Za-z]{10}$", re.IGNORECASE)
SHORT_LINK_PATTERN = re.compile(r"^[0-9A-Za-z]+$")


class InvalidBilibiliUrl(ValueError):
    pass


@dataclass(frozen=True)
class BilibiliSource:
    normalized_url: str
    source_video_id: str | None


def validate_bilibili_url(source_url: str) -> BilibiliSource:
    """把下载入口限制为 Bilibili 单视频和官方短链，避免后端成为通用抓取器。"""
    candidate = source_url.strip()
    if not candidate or len(candidate) > MAX_SOURCE_URL_LENGTH:
        raise InvalidBilibiliUrl("请输入有效的 Bilibili 视频地址")
    if any(ord(character) < 32 for character in candidate):
        raise InvalidBilibiliUrl("视频地址包含非法字符")

    try:
        parsed = urlsplit(candidate)
        port = parsed.port
    except ValueError as error:
        raise InvalidBilibiliUrl("视频地址格式无效") from error

    hostname = parsed.hostname.casefold() if parsed.hostname else ""
    if parsed.scheme != "https":
        raise InvalidBilibiliUrl("视频地址必须使用 HTTPS")
    if parsed.username or parsed.password or port not in {None, 443}:
        raise InvalidBilibiliUrl("视频地址包含不允许的认证或端口")
    if parsed.query and "list=" in parsed.query.casefold():
        raise InvalidBilibiliUrl("暂不支持播放列表或合集")

    if hostname in BILIBILI_HOSTS:
        path_parts = [part for part in parsed.path.split("/") if part]
        if len(path_parts) != 2 or path_parts[0].casefold() != "video":
            raise InvalidBilibiliUrl("目前只支持 Bilibili 单个视频页面")
        source_video_id = path_parts[1]
        if not BVID_PATTERN.fullmatch(source_video_id):
            raise InvalidBilibiliUrl("未识别到有效的 BV 号")
        normalized_path = f"/video/{source_video_id}"
        normalized_url = urlunsplit(("https", "www.bilibili.com", normalized_path, "", ""))
        return BilibiliSource(normalized_url, source_video_id)

    if hostname in SHORT_LINK_HOSTS:
        path = parsed.path.strip("/")
        if not path or "/" in path or not SHORT_LINK_PATTERN.fullmatch(path):
            raise InvalidBilibiliUrl("Bilibili 短链接格式无效")
        normalized_url = urlunsplit(("https", "b23.tv", f"/{path}", "", ""))
        return BilibiliSource(normalized_url, None)

    raise InvalidBilibiliUrl("目前只支持 bilibili.com 和 b23.tv")
