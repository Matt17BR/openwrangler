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


def _open_wrangler_pivot_wider_result(df, prepared, names, values, *, scalar_values, restore_group_key):
    import pandas as pd

    identifiers, output_values, output_names, identifier_frame, key_states = prepared
    if identifiers:
        group_codes = identifier_frame.groupby(
            list(identifier_frame.columns), sort=False, dropna=False, observed=True
        ).ngroup()
        first_rows = ~group_codes.duplicated()
        result = identifier_frame.loc[first_rows].reset_index(drop=True)
        result.columns = pd.Index(
            [df.columns[position] for position in identifiers], dtype="object", tupleize_cols=False
        )
        for output_position, uniques in enumerate(key_states):
            if uniques is not None:
                # Joint groups retain their first identifier row, including equal numeric representations.
                original = scalar_values(df.iloc[:, identifiers[output_position]])
                positions = pd.Series(
                    first_rows.index[first_rows], index=result.index, name=result.columns[output_position]
                )
                restored = restore_group_key(positions, original.to_numpy(dtype=object))
            else:
                restored = restore_group_key(result.iloc[:, output_position], uniques)
            if pd.api.types.is_float_dtype(restored.dtype):
                zeros = restored.eq(0).fillna(False)
                if zeros.any():
                    # Pivot displays the first identifier row, not the globally canonical zero key.
                    original = scalar_values(df.iloc[:, identifiers[output_position]]).reset_index(drop=True)
                    restored = restored.mask(zeros, original.loc[first_rows].reset_index(drop=True))
            result.isetitem(output_position, restored)
        group_count = len(result)
    else:
        group_count = 1 if len(df) else 0
        group_codes = pd.Series([0] * len(df), dtype="int64")
        result = pd.DataFrame(index=range(group_count))

    for key_value, output_name in zip(output_values, output_names, strict=True):
        output = _open_wrangler_nullable_pivot_series(values, group_count, output_name)
        mask = names.eq(key_value)
        target = group_codes.loc[mask].astype("int64").to_list()
        if target:
            output.iloc[target] = values.loc[mask].array
        result[output_name] = output.array
    return result.reset_index(drop=True)
