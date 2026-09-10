from decimal import Decimal, localcontext
from math import isfinite
from numbers import Integral
from typing import Any


def _open_wrangler_fill_linear_gaps(
    ordered: Any,
    ordered_coordinates: "list[Any]",
    ordered_missing: Any,
    max_gap: "int | None",
    error_type: "type[Exception]",
) -> Any:
    """Fill bracketed runs in already ordered data; None preserves original storage."""

    result = ordered.copy()
    filled = False
    cursor = 0
    while cursor < len(result):
        if not ordered_missing[cursor]:
            cursor += 1
            continue
        start = cursor
        while cursor < len(result) and ordered_missing[cursor]:
            cursor += 1
        end = cursor
        if start == 0 or end == len(result) or (max_gap is not None and end - start > max_gap):
            continue
        left_value = ordered.iloc[start - 1]
        right_value = ordered.iloc[end]
        if not _open_wrangler_finite_interpolation_anchor(left_value) or not _open_wrangler_finite_interpolation_anchor(
            right_value
        ):
            continue
        left_coordinate = ordered_coordinates[start - 1]
        right_coordinate = ordered_coordinates[end]
        try:
            for position in range(start, end):
                weight = _open_wrangler_linear_interpolation_weight(
                    ordered_coordinates[position],
                    left_coordinate,
                    right_coordinate,
                )
                if not isfinite(weight) or not 0.0 <= weight <= 1.0:
                    raise ValueError("coordinate distance produced a non-finite interpolation weight")
                # This convex form avoids overflowing ``right - left`` for
                # finite endpoints with opposite signs.
                result.iloc[position] = (1.0 - weight) * float(left_value) + weight * float(right_value)
                filled = True
        except (ArithmeticError, TypeError, ValueError, OverflowError) as error:
            raise error_type(f"Linear interpolation failed for the selected coordinates: {error}") from error

    return result if filled else None


def _open_wrangler_linear_interpolation_weight(current: Any, left: Any, right: Any) -> float:
    if any(isinstance(value, Decimal) for value in (current, left, right)) or all(
        isinstance(value, Integral) for value in (current, left, right)
    ):
        with localcontext() as context:
            context.prec = 80
            return float((Decimal(current) - Decimal(left)) / (Decimal(right) - Decimal(left)))
    current_float = float(current)
    left_float = float(left)
    right_float = float(right)
    denominator = right_float - left_float
    if isfinite(denominator):
        return (current_float - left_float) / denominator
    return ((current_float / 2.0) - (left_float / 2.0)) / ((right_float / 2.0) - (left_float / 2.0))


def _open_wrangler_finite_interpolation_anchor(value: Any) -> bool:
    # The ordered missing mask already excludes null and NaN anchors.
    try:
        return isfinite(float(value))
    except (TypeError, ValueError, OverflowError):
        return False
