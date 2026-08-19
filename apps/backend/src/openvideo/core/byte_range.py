import re
from dataclasses import dataclass


RANGE_PATTERN = re.compile(r"^bytes=(\d*)-(\d*)$")


class InvalidByteRange(ValueError):
    pass


@dataclass(frozen=True)
class ByteRange:
    start: int
    end: int
    total_size: int

    @property
    def length(self) -> int:
        return self.end - self.start + 1

    @property
    def content_range(self) -> str:
        return f"bytes {self.start}-{self.end}/{self.total_size}"


def parse_byte_range(range_header: str, total_size: int) -> ByteRange:
    """浏览器拖动播放只需要单区间，拒绝多区间可避免 multipart 响应歧义。"""
    if total_size <= 0 or "," in range_header:
        raise InvalidByteRange("不支持该字节范围")
    match = RANGE_PATTERN.fullmatch(range_header.strip())
    if not match:
        raise InvalidByteRange("字节范围格式无效")
    raw_start, raw_end = match.groups()
    if not raw_start and not raw_end:
        raise InvalidByteRange("字节范围不能为空")

    if not raw_start:
        suffix_length = int(raw_end)
        if suffix_length <= 0:
            raise InvalidByteRange("后缀长度必须大于零")
        start = max(total_size - suffix_length, 0)
        return ByteRange(start=start, end=total_size - 1, total_size=total_size)

    start = int(raw_start)
    if start >= total_size:
        raise InvalidByteRange("范围起点超出文件")
    end = int(raw_end) if raw_end else total_size - 1
    if end < start:
        raise InvalidByteRange("范围终点早于起点")
    return ByteRange(start=start, end=min(end, total_size - 1), total_size=total_size)
