import pytest

from openvideo.core.byte_range import InvalidByteRange, parse_byte_range


@pytest.mark.parametrize(
    ("header", "start", "end", "length"),
    [
        ("bytes=0-9", 0, 9, 10),
        ("bytes=10-", 10, 99, 90),
        ("bytes=-10", 90, 99, 10),
        ("bytes=-200", 0, 99, 100),
        ("bytes=95-200", 95, 99, 5),
    ],
)
def test_parses_supported_ranges(header: str, start: int, end: int, length: int):
    byte_range = parse_byte_range(header, 100)
    assert (byte_range.start, byte_range.end, byte_range.length) == (start, end, length)


@pytest.mark.parametrize(
    "header",
    [
        "bytes=",
        "items=0-1",
        "bytes=100-101",
        "bytes=20-10",
        "bytes=-0",
        "bytes=0-1,4-5",
        "bytes=a-b",
    ],
)
def test_rejects_invalid_ranges(header: str):
    with pytest.raises(InvalidByteRange):
        parse_byte_range(header, 100)
