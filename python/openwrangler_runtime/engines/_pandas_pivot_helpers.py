def _open_wrangler_nullable_pivot_series(values, size, name):
    import numpy as np
    import pandas as pd

    dtype = values.dtype
    if isinstance(dtype, pd.CategoricalDtype):
        data = pd.Categorical([None] * size, categories=dtype.categories, ordered=dtype.ordered)
        return pd.Series(data, name=name)
    if pd.api.types.is_integer_dtype(dtype):
        nullable = pd.UInt64Dtype() if pd.api.types.is_unsigned_integer_dtype(dtype) else pd.Int64Dtype()
        return pd.Series(pd.array([pd.NA] * size, dtype=nullable), name=name)
    if pd.api.types.is_bool_dtype(dtype):
        return pd.Series(pd.array([pd.NA] * size, dtype=pd.BooleanDtype()), name=name)
    if isinstance(dtype, np.dtype) and pd.api.types.is_float_dtype(dtype):
        return pd.Series(np.full(size, np.nan, dtype=dtype), name=name)
    try:
        return pd.Series(pd.array([pd.NA] * size, dtype=dtype), name=name)
    except (TypeError, ValueError):
        return pd.Series([None] * size, dtype="object", name=name)


def _open_wrangler_pivot_wider_names_valid(names, output_values):
    invalid_type = names.map(lambda value: value is not None and not isinstance(value, str), na_action=None).astype(
        bool
    )
    invalid = names.isna() | invalid_type | ~names.isin(output_values)
    return not bool(invalid.any())
