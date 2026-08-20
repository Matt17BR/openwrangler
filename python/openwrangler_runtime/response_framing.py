from __future__ import annotations

import json
import math
from collections.abc import Iterator
from typing import Any

MAX_STRICT_RESPONSE_PAYLOAD_BYTES = 16 * 1024 * 1024
MAX_RESPONSE_FRAME_BYTES = 17 * 1024 * 1024
MAX_STRICT_JSON_NESTING_DEPTH = 64


class ResponseEncodingError(ValueError):
    """A payload-free strict-JSON response encoding failure."""


class ResponseFrameTooLargeError(ValueError):
    """Raised before writing a response that exceeds the stdout frame cap."""


def strict_json_byte_length(value: Any, maximum_bytes: int) -> int:
    """Return the compact strict-JSON UTF-8 size, stopping once it exceeds a cap."""
    total = 0
    for chunk in _iter_strict_json(value):
        total += len(chunk.encode("utf-8"))
        if total > maximum_bytes:
            return total
    return total


def encode_response_frame(payload: Any, maximum_bytes: int | None = None) -> bytes:
    """Encode one compact strict-JSON LF frame without retaining oversized prefixes."""
    limit = MAX_RESPONSE_FRAME_BYTES if maximum_bytes is None else maximum_bytes
    encoded = bytearray()
    for chunk in _iter_strict_json(payload):
        chunk_bytes = chunk.encode("utf-8")
        if len(encoded) + len(chunk_bytes) + 1 > limit:
            raise ResponseFrameTooLargeError("Response frame exceeds its configured byte limit.")
        encoded.extend(chunk_bytes)
    if len(encoded) + 1 > limit:
        raise ResponseFrameTooLargeError("Response frame exceeds its configured byte limit.")
    encoded.append(0x0A)
    return bytes(encoded)


def _iter_strict_json(value: Any) -> Iterator[str]:
    active_containers: set[int] = set()
    try:
        yield from _iter_strict_json_value(value, 0, active_containers)
    except ResponseEncodingError:
        raise
    except (TypeError, ValueError, OverflowError, RecursionError, RuntimeError, UnicodeError) as error:
        raise ResponseEncodingError("Response could not be encoded as strict JSON.") from error


def _iter_strict_json_value(
    value: Any,
    parent_depth: int,
    active_containers: set[int],
) -> Iterator[str]:
    value_type = type(value)
    if value_type is str:
        yield _encode_json_string(value)
        return
    if value is None:
        yield "null"
        return
    if value_type is bool:
        yield "true" if value else "false"
        return
    if value_type is int:
        yield json.dumps(value, allow_nan=False, separators=(",", ":"))
        return
    if value_type is float:
        if not math.isfinite(value):
            raise ResponseEncodingError("Response contains a non-finite JSON number.")
        yield json.dumps(value, allow_nan=False, separators=(",", ":"))
        return
    if value_type not in {dict, list}:
        raise ResponseEncodingError("Response contains a value outside the strict JSON data model.")

    depth = parent_depth + 1
    if depth > MAX_STRICT_JSON_NESTING_DEPTH:
        raise ResponseEncodingError(f"Response exceeds the {MAX_STRICT_JSON_NESTING_DEPTH}-level JSON nesting limit.")
    identity = id(value)
    if identity in active_containers:
        raise ResponseEncodingError("Response contains a cyclic JSON collection.")
    active_containers.add(identity)
    try:
        if value_type is dict:
            yield "{"
            first = True
            for key, nested in value.items():
                if type(key) is not str:
                    raise ResponseEncodingError("Response contains a non-string JSON object key.")
                if not first:
                    yield ","
                first = False
                yield _encode_json_string(key)
                yield ":"
                yield from _iter_strict_json_value(nested, depth, active_containers)
            yield "}"
        else:
            yield "["
            first = True
            for nested in value:
                if not first:
                    yield ","
                first = False
                yield from _iter_strict_json_value(nested, depth, active_containers)
            yield "]"
    finally:
        active_containers.remove(identity)


def _encode_json_string(value: str) -> str:
    try:
        for offset in range(0, len(value), 16 * 1024):
            value[offset : offset + 16 * 1024].encode("utf-8")
    except UnicodeEncodeError as error:
        raise ResponseEncodingError("Response contains text that is not valid UTF-8.") from error
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
