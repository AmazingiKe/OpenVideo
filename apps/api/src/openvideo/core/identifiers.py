import os
import threading
import time
from uuid import UUID

_RANDOM_A_BITS = 12
_RANDOM_A_MAX = (1 << _RANDOM_A_BITS) - 1
_RANDOM_B_MASK = (1 << 62) - 1
_lock = threading.Lock()
_last_timestamp_ms = 0
_last_rand_a = 0


def uuid7() -> UUID:
    """生成 RFC 9562 的 UUIDv7，同一毫秒内通过递增计数器保证单调递增。

    前 48 位是毫秒时间戳，随后是版本位、12 位随机/计数器位、变体位和 62 位随机位，
    既可按创建时间排序，又无需中心化协调即可保证唯一性。时钟出现回拨或浮点抖动时，
    沿用上一毫秒并继续递增计数器，避免生成比前一个更小的值。
    """
    global _last_timestamp_ms, _last_rand_a
    with _lock:
        timestamp_ms = int(time.time() * 1000)
        if timestamp_ms < _last_timestamp_ms:
            timestamp_ms = _last_timestamp_ms
        if timestamp_ms == _last_timestamp_ms:
            rand_a = (_last_rand_a + 1) & _RANDOM_A_MAX
            if rand_a == 0:
                # 计数器溢出时推进一毫秒，维持单调性
                timestamp_ms += 1
        else:
            rand_a = int.from_bytes(os.urandom(2), "big") & _RANDOM_A_MAX
        _last_timestamp_ms = timestamp_ms
        _last_rand_a = rand_a
        random_b = int.from_bytes(os.urandom(8), "big") & _RANDOM_B_MASK
        value = (
            (timestamp_ms << 80)
            | (0x7 << 76)
            | (rand_a << 64)
            | (0x2 << 62)
            | random_b
        )
        return UUID(int=value)
