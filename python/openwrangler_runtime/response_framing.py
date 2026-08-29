# pyright: strict

from __future__ import annotations

import json
import math
from typing import TypeGuard, TypeVar

MAX_STRICT_RESPONSE_PAYLOAD_BYTES = 16 * 1024 * 1024
MAX_RESPONSE_FRAME_BYTES = 17 * 1024 * 1024
MAX_STRICT_JSON_NESTING_DEPTH = 128
_JSON_STRING_CHUNK_CHARACTERS = 16 * 1024
_LOG10_2_LOWER_NUMERATOR = 3_010_299_956_639_811
_LOG10_2_DENOMINATOR = 10_000_000_000_000_000


class ResponseEncodingError(ValueError):
    """A payload-free strict-JSON response encoding failure."""


class ResponseFrameTooLargeError(ValueError):
    """Raised before writing a response that exceeds the stdout frame cap."""


def strict_json_byte_length(value: object, maximum_bytes: int) -> int:
    """Return the compact strict-JSON UTF-8 size or ``maximum_bytes + 1``."""
    writer = _StrictJsonWriter(maximum_bytes, retain_bytes=False)
    try:
        _write_strict_json(value, writer)
    except _StrictJsonLimitExceeded:
        return maximum_bytes + 1
    return writer.byte_length


def encode_response_frame(payload: object, maximum_bytes: int | None = None) -> bytes:
    """Encode one compact strict-JSON LF frame without retaining oversized prefixes."""
    limit = MAX_RESPONSE_FRAME_BYTES if maximum_bytes is None else maximum_bytes
    writer = _StrictJsonWriter(limit - 1, retain_bytes=True)
    try:
        _write_strict_json(payload, writer)
    except _StrictJsonLimitExceeded:
        raise ResponseFrameTooLargeError("Response frame exceeds its configured byte limit.") from None
    return writer.frame()


class _StrictJsonLimitExceeded(Exception):
    """Internal bounded-size sentinel."""


class _StrictJsonWriter:
    def __init__(self, maximum_bytes: int, *, retain_bytes: bool) -> None:
        self.maximum_bytes = maximum_bytes
        self.byte_length = 0
        self._encoded = bytearray() if retain_bytes else None

    @property
    def remaining_bytes(self) -> int:
        return self.maximum_bytes - self.byte_length

    def write(self, value: str) -> None:
        encoded = value.encode("utf-8")
        if len(encoded) > self.remaining_bytes:
            raise _StrictJsonLimitExceeded
        self.byte_length += len(encoded)
        if self._encoded is not None:
            self._encoded.extend(encoded)

    def reject_oversized_scalar(self) -> None:
        raise _StrictJsonLimitExceeded

    def frame(self) -> bytes:
        if self._encoded is None:
            raise AssertionError("A sizing-only strict JSON writer has no frame.")
        self._encoded.append(0x0A)
        return bytes(self._encoded)


def _write_strict_json(value: object, writer: _StrictJsonWriter) -> None:
    active_containers: set[int] = set()
    try:
        _write_strict_json_value(value, 0, active_containers, writer)
    except _StrictJsonLimitExceeded:
        raise
    except ResponseEncodingError:
        raise
    except (TypeError, ValueError, OverflowError, RecursionError, RuntimeError, UnicodeError) as error:
        raise ResponseEncodingError("Response could not be encoded as strict JSON.") from error


_Scalar = TypeVar("_Scalar", str, bool, int, float)


def _is_exact_scalar(value: object, expected: type[_Scalar]) -> TypeGuard[_Scalar]:
    return type(value) is expected


def _is_exact_dict(value: object) -> TypeGuard[dict[object, object]]:
    return type(value) is dict


def _is_exact_list(value: object) -> TypeGuard[list[object]]:
    return type(value) is list


def _write_strict_json_value(
    value: object,
    parent_depth: int,
    active_containers: set[int],
    writer: _StrictJsonWriter,
) -> None:
    if _is_exact_scalar(value, str):
        _write_json_string(value, writer)
        return
    if value is None:
        writer.write("null")
        return
    if _is_exact_scalar(value, bool):
        writer.write("true" if value else "false")
        return
    if _is_exact_scalar(value, int):
        _write_json_integer(value, writer)
        return
    if _is_exact_scalar(value, float):
        if not math.isfinite(value):
            raise ResponseEncodingError("Response contains a non-finite JSON number.")
        writer.write(json.dumps(value, allow_nan=False, separators=(",", ":")))
        return
    if not (_is_exact_dict(value) or _is_exact_list(value)):
        raise ResponseEncodingError("Response contains a value outside the strict JSON data model.")

    depth = parent_depth + 1
    if depth > MAX_STRICT_JSON_NESTING_DEPTH:
        raise ResponseEncodingError(f"Response exceeds the {MAX_STRICT_JSON_NESTING_DEPTH}-level JSON nesting limit.")
    identity = id(value)
    if identity in active_containers:
        raise ResponseEncodingError("Response contains a cyclic JSON collection.")
    active_containers.add(identity)
    try:
        if _is_exact_dict(value):
            writer.write("{")
            first = True
            for key, nested in value.items():
                if not _is_exact_scalar(key, str):
                    raise ResponseEncodingError("Response contains a non-string JSON object key.")
                if not first:
                    writer.write(",")
                first = False
                _write_json_string(key, writer)
                writer.write(":")
                _write_strict_json_value(nested, depth, active_containers, writer)
            writer.write("}")
        else:
            assert _is_exact_list(value)
            writer.write("[")
            first = True
            for nested in value:
                if not first:
                    writer.write(",")
                first = False
                _write_strict_json_value(nested, depth, active_containers, writer)
            writer.write("]")
    finally:
        active_containers.remove(identity)


def _write_json_integer(value: int, writer: _StrictJsonWriter) -> None:
    sign_bytes = 1 if value < 0 else 0
    bit_length = value.bit_length()
    decimal_digits = 1 if bit_length == 0 else ((bit_length - 1) * _LOG10_2_LOWER_NUMERATOR) // _LOG10_2_DENOMINATOR + 1
    if sign_bytes + decimal_digits > writer.remaining_bytes:
        writer.reject_oversized_scalar()
    threshold = 10**decimal_digits
    if value >= threshold or value <= -threshold:
        decimal_digits += 1
    if sign_bytes + decimal_digits > writer.remaining_bytes:
        writer.reject_oversized_scalar()
    writer.write(json.dumps(value, allow_nan=False, separators=(",", ":")))


def _write_json_string(value: str, writer: _StrictJsonWriter) -> None:
    writer.write('"')
    run_start = 0
    for index, character in enumerate(value):
        codepoint = ord(character)
        escaped = _escaped_json_character(character, codepoint)
        if escaped is None and index - run_start < _JSON_STRING_CHUNK_CHARACTERS:
            continue
        if run_start < index:
            writer.write(value[run_start:index])
        if escaped is not None:
            writer.write(escaped)
            run_start = index + 1
        else:
            run_start = index
    if run_start < len(value):
        writer.write(value[run_start:])
    writer.write('"')


def _escaped_json_character(character: str, codepoint: int) -> str | None:
    if character == '"':
        return '\\"'
    if character == "\\":
        return "\\\\"
    if character == "\b":
        return "\\b"
    if character == "\f":
        return "\\f"
    if character == "\n":
        return "\\n"
    if character == "\r":
        return "\\r"
    if character == "\t":
        return "\\t"
    if codepoint < 0x20:
        return f"\\u{codepoint:04x}"
    if 0xD800 <= codepoint <= 0xDFFF:
        raise ResponseEncodingError("Response contains text that is not valid UTF-8.")
    return None
