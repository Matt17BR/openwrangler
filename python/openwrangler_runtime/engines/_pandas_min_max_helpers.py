from typing import Any


def _open_wrangler_min_max_scale(series: Any) -> Any:
    from decimal import MAX_EMAX, MIN_EMIN, Decimal, localcontext
    from numbers import Integral

    import numpy as np
    import pandas as pd

    result_dtype = "Float64" if isinstance(series.dtype, pd.api.extensions.ExtensionDtype) else "float64"
    if pd.api.types.is_integer_dtype(series.dtype) and series.notna().any():
        minimum = int(series.min())
        span = int(series.max()) - minimum
        # Ordinary integer ranges can keep vectorized native subtraction.
        # Larger spans use Python integers below so signed storage cannot wrap.
        if span <= 2**63 - 1:
            integer_dtype = "uint64" if pd.api.types.is_unsigned_integer_dtype(series.dtype) else "int64"
            if isinstance(series.dtype, pd.api.extensions.ExtensionDtype):
                integer_dtype = "UInt64" if integer_dtype == "uint64" else "Int64"
            widened = series.astype(integer_dtype)
            return (widened - minimum) / span if span else series.astype(result_dtype).where(series.isna(), 0.0)
    present = None if pd.api.types.is_float_dtype(series.dtype) else series.dropna().tolist()
    if present == []:
        return pd.Series(float("nan"), index=series.index, dtype=result_dtype)
    if present is not None and all(isinstance(value, Integral) and not isinstance(value, bool) for value in present):
        minimum = min(map(int, present))
        span = max(map(int, present)) - minimum
        return pd.Series(
            [float("nan") if pd.isna(value) else (int(value) - minimum) / span if span else 0.0 for value in series],
            index=series.index,
            dtype=result_dtype,
        )
    if present is not None and all(
        isinstance(value, (Decimal, Integral)) and not isinstance(value, bool) for value in present
    ):
        values = [
            None if pd.isna(value) else value if isinstance(value, Decimal) else Decimal(int(value)) for value in series
        ]
        finite_values = [value for value in values if value is not None and value.is_finite()]
        if not finite_values:
            return pd.Series(float("nan"), index=series.index, dtype=result_dtype)
        # Preserve narrow decimal differences independently of the caller's
        # Decimal context, and round only the final dimensionless ratio.
        with localcontext() as context:
            context.prec = max(
                34,
                max(value.adjusted() for value in finite_values)
                - min(int(value.as_tuple().exponent) for value in finite_values)
                + 2,
            )
            context.Emax = MAX_EMAX
            context.Emin = MIN_EMIN
            minimum = min(finite_values)
            span = max(finite_values) - minimum
            scaled = [
                float("nan")
                if value is None or not value.is_finite()
                else float((value - minimum) / span)
                if span
                else 0.0
                for value in values
            ]
        return pd.Series(scaled, index=series.index, dtype=result_dtype)
    numeric: Any = pd.to_numeric(series, errors="coerce")
    if pd.api.types.is_integer_dtype(numeric.dtype):
        return _open_wrangler_min_max_scale(numeric)
    numeric = numeric.astype(result_dtype)
    finite = numeric.where(np.isfinite(numeric))
    if not finite.notna().any():
        return finite
    minimum = float(finite.min())
    maximum = float(finite.max())
    span = maximum - minimum
    if pd.isna(span) or span == 0:
        return finite.where(finite.isna(), 0.0)
    if np.isfinite(span):
        return (finite - minimum) / span
    return (finite / 2 - minimum / 2) / (maximum / 2 - minimum / 2)
