import re
from uuid import RFC_4122

from openvideo.core.identifiers import uuid7

UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


def test_has_rfc9562_uuidv7_format():
    value = uuid7()
    assert UUID_PATTERN.fullmatch(str(value))
    assert value.version == 7
    assert value.variant == RFC_4122


def test_is_unique_across_bulk_generation():
    values = {uuid7() for _ in range(2000)}
    assert len(values) == 2000


def test_is_monotonic_within_same_millisecond():
    previous = uuid7()
    for _ in range(500):
        current = uuid7()
        assert current > previous
        previous = current


def test_is_sortable_by_creation_time():
    first = uuid7()
    second = uuid7()
    assert first < second
