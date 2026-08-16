from __future__ import annotations

import json
from typing import Any

MAX_STRICT_RESPONSE_PAYLOAD_BYTES = 16 * 1024 * 1024
MAX_RESPONSE_FRAME_BYTES = 17 * 1024 * 1024


class ResponseFrameTooLargeError(ValueError):
    """Raised before writing a response that exceeds the stdout frame cap."""


def strict_json_byte_length(value: Any, maximum_bytes: int) -> int:
    """Return the compact strict-JSON UTF-8 size, stopping once it exceeds a cap."""
    total = 0
    for chunk in _encoder(stringify_unknown=False).iterencode(value):
        total += len(chunk.encode("utf-8"))
        if total > maximum_bytes:
            return total
    return total


def encode_response_frame(payload: Any, maximum_bytes: int | None = None) -> bytes:
    """Encode one compact strict-JSON LF frame without retaining oversized prefixes."""
    limit = MAX_RESPONSE_FRAME_BYTES if maximum_bytes is None else maximum_bytes
    encoded = bytearray()
    for chunk in _encoder(stringify_unknown=True).iterencode(payload):
        chunk_bytes = chunk.encode("utf-8")
        if len(encoded) + len(chunk_bytes) + 1 > limit:
            raise ResponseFrameTooLargeError
        encoded.extend(chunk_bytes)
    if len(encoded) + 1 > limit:
        raise ResponseFrameTooLargeError
    encoded.append(0x0A)
    return bytes(encoded)


def _encoder(*, stringify_unknown: bool) -> json.JSONEncoder:
    if stringify_unknown:
        return json.JSONEncoder(
            default=str,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
        )
    return json.JSONEncoder(
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
    )
