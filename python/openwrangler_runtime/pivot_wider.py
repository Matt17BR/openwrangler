from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from .pivot_longer import (
    PIVOT_LONGER_SCALAR_TYPES,
    portable_pivot_longer_name_key,
    validate_pivot_longer_output_name,
)

MIN_PIVOT_WIDER_OUTPUTS = 2
MAX_PIVOT_WIDER_OUTPUTS = 64
MAX_PIVOT_WIDER_COLUMNS = 2_048
MAX_PIVOT_WIDER_ROWS = 2_147_483_647
PIVOT_WIDER_VALUE_TYPES = PIVOT_LONGER_SCALAR_TYPES


class PivotWiderContractError(ValueError):
    """Raised when the deterministic fixed-output Pivot Wider contract is invalid."""


def portable_pivot_wider_name_key(value: str) -> str:
    return portable_pivot_longer_name_key(value)


def validate_pivot_wider_output_name(value: Any, label: str) -> str:
    try:
        return validate_pivot_longer_output_name(value, label)
    except ValueError as error:
        raise PivotWiderContractError(str(error)) from error


def pivot_wider_key_value(value: Any, label: str) -> str:
    if not isinstance(value, Mapping) or set(value) != {"kind", "version", "columnType", "cell"}:
        raise PivotWiderContractError(f"{label} must be a canonical present string selection token.")
    cell = value.get("cell")
    if (
        value.get("kind") != "typedSelection"
        or type(value.get("version")) is not int
        or value["version"] != 1
        or value.get("columnType") != "string"
        or not isinstance(cell, Mapping)
        or set(cell) != {"kind", "raw", "display", "isNull", "isNaN"}
        or cell.get("kind") != "string"
        or not isinstance(cell.get("raw"), str)
        or cell.get("display") != cell.get("raw")
        or cell.get("isNull") is not False
        or cell.get("isNaN") is not False
    ):
        raise PivotWiderContractError(f"{label} must be a canonical present string selection token.")
    return str(cell["raw"])


def validate_pivot_wider_outputs(outputs: Any) -> list[dict[str, Any]]:
    if not isinstance(outputs, list) or not MIN_PIVOT_WIDER_OUTPUTS <= len(outputs) <= MAX_PIVOT_WIDER_OUTPUTS:
        raise PivotWiderContractError(
            f"pivotWider.outputs must contain between {MIN_PIVOT_WIDER_OUTPUTS} and {MAX_PIVOT_WIDER_OUTPUTS} items."
        )
    normalized: list[dict[str, Any]] = []
    key_values: set[str] = set()
    name_keys: set[str] = set()
    for index, output in enumerate(outputs):
        if not isinstance(output, Mapping) or set(output) != {"key", "name"}:
            raise PivotWiderContractError(f"pivotWider.outputs[{index}] must contain only key and name.")
        key_value = pivot_wider_key_value(output.get("key"), f"pivotWider.outputs[{index}].key")
        name = validate_pivot_wider_output_name(output.get("name"), f"pivotWider.outputs[{index}].name")
        name_key = portable_pivot_wider_name_key(name)
        if key_value in key_values:
            raise PivotWiderContractError("pivotWider.outputs must contain unique typed keys.")
        if name_key in name_keys:
            raise PivotWiderContractError("pivotWider output names must differ case-insensitively.")
        key_values.add(key_value)
        name_keys.add(name_key)
        normalized.append({"key": dict(output["key"]), "name": name})
    return normalized


def checked_pivot_wider_column_count(input_columns: int, output_count: int) -> int:
    retained = input_columns - 2
    final = retained + output_count
    if input_columns < 2 or retained < 0 or not MIN_PIVOT_WIDER_OUTPUTS <= output_count <= MAX_PIVOT_WIDER_OUTPUTS:
        raise PivotWiderContractError("Pivot-wider column-count inputs are invalid.")
    if final > MAX_PIVOT_WIDER_COLUMNS:
        raise PivotWiderContractError(
            f"Pivot wider would exceed the portable {MAX_PIVOT_WIDER_COLUMNS:,}-column limit."
        )
    return final


def output_names(outputs: Sequence[Mapping[str, Any]]) -> list[str]:
    return [str(output["name"]) for output in outputs]
