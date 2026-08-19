from __future__ import annotations

from typing import Any

MIN_PIVOT_LONGER_COLUMNS = 2
MAX_PIVOT_LONGER_COLUMNS = 64
MAX_PIVOT_LONGER_OUTPUT_NAME_BYTES = 1_024
MAX_PIVOT_LONGER_ROWS = 2_147_483_647

# These are the scalar semantic kinds that all four editing runtimes can
# preserve without converting through another dataframe engine.
PIVOT_LONGER_SCALAR_TYPES = {
    "string",
    "integer",
    "float",
    "decimal",
    "boolean",
    "datetime",
    "date",
    "duration",
}


def portable_pivot_longer_name_key(value: str) -> str:
    parts: list[str] = []
    for character in value:
        code_point = ord(character)
        if 0x41 <= code_point <= 0x5A:
            parts.append(chr(code_point + 0x20))
        elif character in {"ß", "ẞ"}:
            parts.append("ss")
        else:
            parts.append(character)
    return "".join(parts)


class PivotLongerContractError(ValueError):
    """Raised when the portable pivot-longer contract is invalid."""


def validate_pivot_longer_output_name(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise PivotLongerContractError(f"{label} must be a non-empty string.")
    if "\x00" in value or "\r" in value or "\n" in value:
        raise PivotLongerContractError(f"{label} must be a single-line Unicode name without NUL.")
    if any(0xD800 <= ord(character) <= 0xDFFF for character in value):
        raise PivotLongerContractError(f"{label} must contain only valid Unicode scalar values.")
    if len(value.encode("utf-8")) > MAX_PIVOT_LONGER_OUTPUT_NAME_BYTES:
        raise PivotLongerContractError(f"{label} must not exceed {MAX_PIVOT_LONGER_OUTPUT_NAME_BYTES:,} UTF-8 bytes.")
    return value


def checked_pivot_longer_row_count(row_count: int, selected_count: int) -> int:
    if row_count < 0 or not MIN_PIVOT_LONGER_COLUMNS <= selected_count <= MAX_PIVOT_LONGER_COLUMNS:
        raise PivotLongerContractError("Pivot-longer row-count inputs are invalid.")
    if row_count and row_count > MAX_PIVOT_LONGER_ROWS // selected_count:
        raise PivotLongerContractError(f"Pivot longer would exceed the portable {MAX_PIVOT_LONGER_ROWS:,}-row limit.")
    return row_count * selected_count
