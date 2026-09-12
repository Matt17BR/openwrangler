from typing import Any, cast


def _open_wrangler_arrow_formula_repair(
    left: Any, right: Any, operator: str, original_error: Exception, formula
) -> Any:
    try:
        import numpy as np
        import pandas as pd
        import pyarrow as pa

        left_type = left.dtype.pyarrow_dtype if isinstance(left.dtype, pd.ArrowDtype) else None
        right_type = right.dtype.pyarrow_dtype if isinstance(getattr(right, "dtype", None), pd.ArrowDtype) else None

        if (
            left_type is not None
            and pa.types.is_decimal256(left_type)
            and (
                isinstance(original_error, pa.ArrowInvalid)
                or isinstance(original_error, TypeError)
                and left_type.scale < 0
                and left_type.precision - left_type.scale > 76
            )
            and type(right) is int
            and (
                operator in {"multiply", "divide"}
                and right in {-1, 1}
                or operator in {"add", "subtract"}
                and right == 0
            )
        ):
            result = left.array.__arrow_array__()
            if right == -1:
                import pyarrow.compute as pc

                result = pc.call_function("negate_checked", [result])
            return pd.Series(pd.arrays.ArrowExtensionArray(result), index=left.index, name=left.name)

        def is_integer_column(value: Any, *, signed_only: bool = True) -> bool:
            if not isinstance(value, pd.Series) or isinstance(value.dtype, pd.SparseDtype):
                return False
            if isinstance(value.dtype, pd.ArrowDtype):
                dtype = value.dtype.pyarrow_dtype
                if not pa.types.is_integer(dtype) or dtype.bit_width > 64:
                    return False
                if signed_only and not pa.types.is_signed_integer(dtype):
                    return False
            else:
                dtype = value.dtype
                if type(dtype) in (
                    pd.Int8Dtype,
                    pd.Int16Dtype,
                    pd.Int32Dtype,
                    pd.Int64Dtype,
                    pd.UInt8Dtype,
                    pd.UInt16Dtype,
                    pd.UInt32Dtype,
                    pd.UInt64Dtype,
                ):
                    dtype = cast(Any, dtype).numpy_dtype
                if (
                    not isinstance(dtype, np.dtype)
                    or dtype.kind not in ("i" if signed_only else "iu")
                    or dtype.itemsize > 8
                ):
                    return False
            return True

        if isinstance(original_error, (pa.ArrowInvalid, TypeError)) and operator in {
            "add",
            "subtract",
            "multiply",
            "divide",
        }:
            negative_left = (
                left_type if left_type is not None and pa.types.is_decimal(left_type) and left_type.scale < 0 else None
            )
            negative_right = (
                right_type
                if right_type is not None and pa.types.is_decimal(right_type) and right_type.scale < 0
                else None
            )
            if (negative_left is not None or negative_right is not None) and all(
                dtype is not None
                and pa.types.is_decimal(dtype)
                or is_integer_column(value, signed_only=False)
                or type(value) is int
                for value, dtype in ((left, left_type), (right, right_type))
            ):
                # A negative scale needs p-s whole digits, without inspecting or narrowing values.
                if any(
                    dtype.precision - dtype.scale > 76 for dtype in (negative_left, negative_right) if dtype is not None
                ):
                    raise original_error
                if negative_left is not None:
                    left = left.astype(pd.ArrowDtype(pa.decimal256(negative_left.precision - negative_left.scale, 0)))
                if negative_right is not None and isinstance(right, pd.Series):
                    right = right.astype(
                        pd.ArrowDtype(pa.decimal256(negative_right.precision - negative_right.scale, 0))
                    )
                return formula(left, right, operator)
        if isinstance(original_error, TypeError):
            raise original_error

        if (
            isinstance(original_error, pa.ArrowInvalid)
            and operator == "power"
            and is_integer_column(left)
            and is_integer_column(right, signed_only=False)
            and (cast(Any, right).dtype.kind == "i" or cast(Any, right).dtype.itemsize < 8)
        ):
            import pyarrow.compute as pc

            try:
                first = pc.cast(pa.array(left.array), pa.int64())
                second = pc.cast(pa.array(cast(pd.Series, right).array), pa.int64())
                result = pc.call_function("power_checked", [first, second])
            except pa.ArrowInvalid:
                raise original_error from None
            return pd.Series(pd.arrays.ArrowExtensionArray(result), index=left.index, name=left.name)

        if operator == "power" and is_integer_column(left) and type(right) is int and 0 < right < 2**64:
            import pyarrow.compute as pc

            # Widen narrow signed minima before even powers take their magnitude.
            first = pc.cast(pa.array(left.array), pa.int64())
            try:
                magnitude = pc.cast(pc.call_function("abs_checked", [first]) if right % 2 == 0 else first, pa.uint64())
                result = pc.call_function("power_checked", [magnitude, pa.scalar(right, pa.uint64())])
            except pa.ArrowInvalid:
                if right % 2 == 1 and right >= 2**63:
                    # These bases retain their value for any positive odd exponent.
                    bounds = pc.call_function("min_max", [first])
                    if bounds["min"].as_py() == -1 and bounds["max"].as_py() <= 1:
                        return pd.Series(pd.arrays.ArrowExtensionArray(first), index=left.index, name=left.name)
                raise original_error from None
            return pd.Series(pd.arrays.ArrowExtensionArray(result), index=left.index, name=left.name)

        if (
            operator == "subtract"
            and is_integer_column(left, signed_only=False)
            and (is_integer_column(right, signed_only=False) or type(right) is int and -(2**63) <= right < 2**64)
        ):
            import pyarrow.compute as pc

            decimal = pa.decimal128(20, 0)
            first = pc.cast(pa.array(left.array), decimal)
            second = (
                pc.cast(pa.array(right.array), decimal) if isinstance(right, pd.Series) else pa.scalar(right, decimal)
            )
            result = pc.call_function("subtract_checked", [first, second])
            try:
                try:
                    result = pc.cast(result, pa.uint64())
                except pa.ArrowInvalid:
                    result = pc.cast(result, pa.int64())
            except pa.ArrowInvalid:
                # Preserve the original repair path and its refusal.
                del first, second, result
            else:
                return pd.Series(pd.arrays.ArrowExtensionArray(result), index=left.index, name=left.name)

        if operator in {"add", "subtract", "multiply", "power"}:
            if left_type == pa.uint64() and type(right) is int:
                if 0 <= right < 2**64:
                    return formula(left, pa.scalar(right, type=pa.uint64()), operator)
                if operator in {"add", "subtract"} and -(2**64 - 1) <= right < 0:
                    return formula(
                        left, pa.scalar(-right, type=pa.uint64()), "subtract" if operator == "add" else "add"
                    )
            if isinstance(original_error, pa.ArrowInvalid):
                if operator == "add" and right_type == pa.uint64() and is_integer_column(left):
                    left, right = right, left
                    left_type, right_type = right_type, left_type
                if left_type == pa.uint64() and isinstance(right, pd.Series) and is_integer_column(right):
                    minimum = right.min()
                    if pd.isna(minimum) or minimum >= 0:
                        return formula(left, right.astype(pd.ArrowDtype(pa.uint64())), operator)
                    if operator in {"add", "subtract"}:
                        import pyarrow.compute as pc

                        array = cast(pd.arrays.ArrowExtensionArray, right.astype(pd.ArrowDtype(pa.int64())).array)
                        values = array.__arrow_array__()
                        bits = pc.cast(values, pa.uint64(), safe=False)
                        if right.max() > 0:
                            negative = pc.call_function("less", [values, pa.scalar(0, type=pa.int64())])
                            zero = pa.scalar(0, type=pa.uint64())
                            positive = pc.call_function("if_else", [negative, zero, bits])
                            bits = pc.call_function("if_else", [negative, bits, zero])
                            positive = pd.Series(
                                pd.arrays.ArrowExtensionArray(positive), index=right.index, name=right.name
                            )
                            left = formula(left, positive, operator)
                        # Selected signed x <= 0 becomes its exact unsigned magnitude,
                        # including INT64_MIN. Both requested arithmetic calls are checked.
                        magnitude = pc.call_function("negate", [bits])
                        right = pd.Series(pd.arrays.ArrowExtensionArray(magnitude), index=right.index, name=right.name)
                        return formula(left, right, "subtract" if operator == "add" else "add")
                if right_type == pa.uint64() and is_integer_column(left):
                    minimum = left.min()
                    if pd.isna(minimum) or minimum >= 0:
                        return formula(left.astype(pd.ArrowDtype(pa.uint64())), right, operator)
        if (
            operator in {"add", "multiply"}
            and is_integer_column(left, signed_only=operator == "add")
            and (
                is_integer_column(right, signed_only=operator == "add")
                or type(right) is int
                and -(2**63) <= right < 2 ** (63 if operator == "add" else 64)
            )
        ):
            import pyarrow.compute as pc

            # Native inference needs 21 decimal digits for addition, 41 for multiplication.
            # Keep an integer result: signed capacity first, then unsigned.
            decimal = pa.decimal128(20, 0) if operator == "add" else pa.decimal256(20, 0)
            first = pc.cast(pa.array(left.array), decimal)
            second = (
                pc.cast(pa.array(right.array), decimal) if isinstance(right, pd.Series) else pa.scalar(right, decimal)
            )
            result = pc.call_function(f"{operator}_checked", [first, second])
            try:
                result = pc.cast(result, pa.int64())
            except pa.ArrowInvalid:
                try:
                    result = pc.cast(result, pa.uint64())
                except pa.ArrowInvalid:
                    raise original_error from None
            return pd.Series(pd.arrays.ArrowExtensionArray(result), index=left.index, name=left.name)
        if isinstance(original_error, pa.ArrowInvalid) and operator in {"add", "subtract", "multiply", "divide"}:
            left_decimal = left_type if left_type is not None and pa.types.is_decimal128(left_type) else None
            right_decimal = right_type if right_type is not None and pa.types.is_decimal128(right_type) else None
            if left_decimal is not None or right_decimal is not None:
                if left_decimal is not None:
                    left = left.astype(pd.ArrowDtype(pa.decimal256(left_decimal.precision, left_decimal.scale)))
                if right_decimal is not None and isinstance(right, pd.Series):
                    right = right.astype(pd.ArrowDtype(pa.decimal256(right_decimal.precision, right_decimal.scale)))
                return formula(left, right, operator)
        raise original_error
    finally:
        # Avoid a traceback cycle retaining the original error and Arrow buffers.
        del original_error
