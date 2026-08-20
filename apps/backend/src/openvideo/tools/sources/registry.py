from urllib.parse import urlsplit

from openvideo.tools.sources.base import SourceMatch, UnsupportedSourceError
from openvideo.tools.sources.bilibili import BilibiliSource
from openvideo.tools.sources.douyin import DouyinSource
from openvideo.tools.sources.youtube import YoutubeSource


MAX_SOURCE_URL_LENGTH = 2048
_REGISTERED_SOURCES = (BilibiliSource(), DouyinSource(), YoutubeSource())


def resolve_source(source_url: str) -> SourceMatch:
    """把任意输入解析成平台无关的 SourceMatch；无法识别时抛 UnsupportedSourceError。

    通用约束(长度、控制字符、scheme、认证信息、端口)在这里统一校验，
    平台实现只负责各自域名下的路径与参数识别。
    """
    candidate = source_url.strip()
    if not candidate or len(candidate) > MAX_SOURCE_URL_LENGTH:
        raise UnsupportedSourceError("请输入有效的视频地址")
    if any(ord(character) < 32 for character in candidate):
        raise UnsupportedSourceError("视频地址包含非法字符")

    try:
        parsed = urlsplit(candidate)
        port = parsed.port
    except ValueError as error:
        raise UnsupportedSourceError("视频地址格式无效") from error

    if parsed.scheme != "https":
        raise UnsupportedSourceError("视频地址必须使用 HTTPS")
    if parsed.username or parsed.password or port not in {None, 443}:
        raise UnsupportedSourceError("视频地址包含不允许的认证或端口")

    for source in _REGISTERED_SOURCES:
        try:
            match = source.match(parsed)
        except ValueError as error:
            raise UnsupportedSourceError(str(error)) from error
        if match is not None:
            return match
    raise UnsupportedSourceError("目前只支持 Bilibili、抖音或 YouTube 公开视频")
