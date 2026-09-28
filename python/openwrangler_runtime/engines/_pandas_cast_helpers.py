def _open_wrangler_cast_values(series, target):
    from math import isfinite, trunc

    import numpy as np
    import pandas as pd

    count = len(series)
    data = np.zeros(count, dtype={"integer": np.int64, "float": np.float64, "boolean": np.bool_}[target])
    missing = np.ones(count, dtype=np.bool_)

    def result():
        array = {
            "integer": pd.arrays.IntegerArray,
            "float": pd.arrays.FloatingArray,
            "boolean": pd.arrays.BooleanArray,
        }[target](data, missing)
        return pd.Series(array, index=series.index, name=series.name)

    source = series.astype(object) if isinstance(series.dtype, pd.CategoricalDtype) else series
    arrow_type = getattr(source.dtype, "pyarrow_dtype", None)
    if source.dtype == object:
        inferred = pd.api.types.infer_dtype(source, skipna=True)
        kind = (
            "text"
            if inferred in {"string", "empty"}
            else "boolean"
            if inferred == "boolean"
            else "object"
            if inferred in {"integer", "floating", "mixed-integer-float", "decimal"}
            else None
        )
    elif pd.api.types.is_bool_dtype(source.dtype):
        kind = "boolean"
    elif arrow_type is not None and str(arrow_type).startswith("decimal"):
        kind = "object"
    elif pd.api.types.is_numeric_dtype(source.dtype):
        kind = "integer" if pd.api.types.is_integer_dtype(source.dtype) else "float"
    elif pd.api.types.is_string_dtype(source.dtype):
        kind = "text"
    else:
        kind = None
    if kind is None:
        raise ValueError("Convert type cannot turn values of this column type into the selected type.")
    if kind == "boolean":
        source = source.astype("boolean")
        present = source.notna().to_numpy(dtype=np.bool_)
        data[present] = source[present].to_numpy(dtype=data.dtype)
        missing[present] = False
        return result()
    if kind == "text":
        text = source.astype("string").str.strip(" \t\r\n")
        if target == "boolean":
            for value, pattern in ((True, "[Tt][Rr][Uu][Ee]"), (False, "[Ff][Aa][Ll][Ss][Ee]")):
                matched = text.str.fullmatch(pattern).fillna(False).to_numpy(dtype=np.bool_)
                data[matched] = value
                missing[matched] = False
            return result()
        if target == "float":
            pattern = r"[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?"
            valid = text.str.fullmatch(pattern).fillna(False).to_numpy(dtype=np.bool_)
            parsed = text[valid].astype("Float64").to_numpy(dtype=np.float64, na_value=np.nan)
            data[valid] = parsed
            missing[valid] = ~np.isfinite(parsed)
            return result()
        valid = text.str.fullmatch("[+-]?[0-9]+").fillna(False).to_numpy(dtype=np.bool_)
        digits = text.str.lstrip("+-").str.lstrip("0").str.len().fillna(0).to_numpy(dtype=np.int64)
        short = valid & (digits <= 18)
        data[short] = text[short].str.lstrip("+").astype("Int64").to_numpy(dtype=np.int64)
        missing[short] = False
        for position in np.flatnonzero(valid & (digits == 19)):
            number = int(text.iloc[position])
            if -(2**63) <= number < 2**63:
                data[position] = number
                missing[position] = False
        return result()
    if kind == "object":
        for position, value in enumerate(source.astype(object).to_numpy()):
            if pd.isna(value):
                continue
            if target == "boolean":
                data[position] = value != 0
            else:
                try:
                    number = float(value) if target == "float" else trunc(value)
                except (OverflowError, ValueError):
                    continue
                if not (isfinite(number) if target == "float" else -(2**63) <= number < 2**63):
                    continue
                data[position] = number
            missing[position] = False
        return result()
    present = source.notna().to_numpy(dtype=np.bool_, copy=True)
    if kind == "integer":
        unsigned = pd.api.types.is_unsigned_integer_dtype(source.dtype)
        numbers = source.to_numpy(dtype=np.uint64 if unsigned else np.int64, na_value=0)
        if target == "integer" and unsigned:
            present &= numbers < 2**63
        data[present] = numbers[present] != 0 if target == "boolean" else numbers[present].astype(data.dtype)
        missing[present] = False
        return result()
    numbers = source.to_numpy(dtype=np.float64, na_value=np.nan)
    if target == "integer":
        truncated = np.trunc(numbers)
        present &= np.isfinite(numbers) & (truncated >= -(2.0**63)) & (truncated < 2.0**63)
        data[present] = truncated[present].astype(np.int64)
    elif target == "boolean":
        present &= ~np.isnan(numbers)
        data[present] = numbers[present] != 0
    else:
        data[present] = numbers[present]
    missing[present] = False
    return result()
