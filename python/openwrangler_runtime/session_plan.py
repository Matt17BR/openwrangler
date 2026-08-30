from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from .custom_code_scope import custom_code_generated_utf8_bytes
from .engines import DataFrameEngine, EngineError
from .protocol_limits_generated import (
    MAX_GENERATED_PYTHON_CODE_UTF8_BYTES,
    MAX_PYTHON_RETAINED_PLAN_UTF8_BYTES,
)
from .response_framing import strict_json_byte_length


def preflight_retained_plan(plan: Sequence[Mapping[str, Any]]) -> int:
    try:
        size = strict_json_byte_length(plan, MAX_PYTHON_RETAINED_PLAN_UTF8_BYTES)
    except (TypeError, ValueError, OverflowError, RecursionError, UnicodeError) as error:
        raise EngineError("The retained cleaning plan must be compact strict-JSON UTF-8 data.") from error
    if size > MAX_PYTHON_RETAINED_PLAN_UTF8_BYTES:
        raise EngineError(
            "The retained cleaning plan may contain at most "
            f"{MAX_PYTHON_RETAINED_PLAN_UTF8_BYTES:,} compact strict-JSON UTF-8 bytes."
        )
    return size


def compile_plan_with_limits(
    engine: DataFrameEngine,
    bound_plan: Sequence[Mapping[str, Any]],
) -> str:
    if not bound_plan:
        return ""
    _preflight_custom_code_generation(engine, bound_plan)
    generated_code = engine.compile_plan(bound_plan)
    if not isinstance(generated_code, str):
        raise EngineError("The dataframe engine returned malformed generated Python code.")
    try:
        size = _bounded_utf8_size(generated_code, MAX_GENERATED_PYTHON_CODE_UTF8_BYTES)
    except UnicodeEncodeError as error:
        raise EngineError("Generated Python code must contain valid Unicode text.") from error
    if size > MAX_GENERATED_PYTHON_CODE_UTF8_BYTES:
        raise EngineError(
            f"Generated Python code may contain at most {MAX_GENERATED_PYTHON_CODE_UTF8_BYTES:,} UTF-8 bytes."
        )
    return generated_code


def _bounded_utf8_size(value: str, maximum_bytes: int) -> int:
    total = 0
    for offset in range(0, len(value), 4096):
        total += len(value[offset : offset + 4096].encode("utf-8"))
        if total > maximum_bytes:
            return total
    return total


def _preflight_custom_code_generation(
    engine: DataFrameEngine,
    bound_plan: Sequence[Mapping[str, Any]],
) -> None:
    """Reject complete Custom Code expansion before an adapter allocates it."""

    generated_bytes = 0
    prelude_pending = True
    for index, step in enumerate(bound_plan):
        if step.get("kind") != "customCode":
            continue
        params = step.get("params")
        code = params.get("code") if isinstance(params, Mapping) else None
        if not isinstance(code, str):
            raise EngineError("The bound Custom Code step is malformed.")
        code_bytes = _bounded_utf8_size(code, MAX_GENERATED_PYTHON_CODE_UTF8_BYTES)
        line_count, separator_bytes = _splitlines_shape(code)
        try:
            generated_bytes += custom_code_generated_utf8_bytes(
                code_utf8_bytes=code_bytes,
                separator_utf8_bytes=separator_bytes,
                line_count=line_count,
                engine_name=engine.name,
                index=index,
                include_prelude=prelude_pending,
            )
        except ValueError as error:
            raise EngineError("The dataframe engine cannot generate Custom Code.") from error
        prelude_pending = False
        if generated_bytes > MAX_GENERATED_PYTHON_CODE_UTF8_BYTES:
            raise EngineError(
                f"Generated Python code may contain at most {MAX_GENERATED_PYTHON_CODE_UTF8_BYTES:,} UTF-8 bytes."
            )


def _splitlines_shape(value: str) -> tuple[int, int]:
    """Return splitlines() count and removed UTF-8 separator bytes without allocation."""

    line_count = 0
    separator_bytes = 0
    index = 0
    ended_with_separator = False
    while index < len(value):
        character = value[index]
        if character == "\r":
            line_count += 1
            separator_bytes += 1
            index += 1
            if index < len(value) and value[index] == "\n":
                separator_bytes += 1
                index += 1
            ended_with_separator = True
            continue
        if character in {"\n", "\v", "\f", "\x1c", "\x1d", "\x1e", "\x85", "\u2028", "\u2029"}:
            line_count += 1
            separator_bytes += len(character.encode("utf-8"))
            index += 1
            ended_with_separator = True
            continue
        ended_with_separator = False
        index += 1
    if value and not ended_with_separator:
        line_count += 1
    return line_count, separator_bytes
