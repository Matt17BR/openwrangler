def _open_wrangler_duration_operand(value):
    return ((value.days * 86400 + value.seconds) * 1000000 + value.microseconds) * 10**12


def _open_wrangler_duration_keys(series, units):
    from datetime import timedelta
    from decimal import Decimal
    from typing import cast

    import numpy as np
    import pandas as pd

    if series.dtype != object:
        return series

    def key(value):
        kind = type(value)
        if kind is pd.Timedelta:
            value = value.asm8
            kind = np.timedelta64
        if kind is np.timedelta64:
            ticks = int(value.view(np.int64))
            if ticks == -(2**63):
                return None
            unit, multiplier = np.datetime_data(value.dtype)
            factor_scale = units.get(unit)
            if factor_scale is None:
                raise ValueError("Object duration comparisons require fixed NumPy units.")
            factor, scale = factor_scale
            return ticks * multiplier * factor * (10**18 // scale)
        if kind is timedelta:
            return _open_wrangler_duration_operand(value)
        if value is None or value is pd.NaT or value is pd.NA:
            return None
        if isinstance(value, (float, np.floating)) and np.isnan(value):
            return None
        if kind is Decimal and cast(Decimal, value).is_nan():
            return None
        raise ValueError("Object duration comparisons cannot mix ordinary durations with custom scalar types.")

    values = series.to_numpy(copy=False)
    affected = next(
        (
            value
            for value in values
            if type(value) is pd.Timedelta
            or type(value) is np.timedelta64
            and int(value.view(np.int64)) != -(2**63)
            and np.datetime_data(value.dtype)[0] in units
        ),
        None,
    )
    if affected is None:
        return series
    # Retain native ticks in their stored unit before exact integer scaling.
    if type(affected) is np.timedelta64:
        dtype = affected.dtype
        ticks = (
            values.astype(dtype).view(np.int64)
            if all(type(value) is np.timedelta64 and value.dtype == dtype for value in values)
            else None
        )
    else:
        affected = cast(pd.Timedelta, affected)
        dtype = affected.asm8.dtype
        unit = affected.unit
        ticks = (
            np.fromiter(map(pd.Timedelta.to_timedelta64, values), dtype=dtype, count=len(values)).view(np.int64)
            if all(type(value) is pd.Timedelta and value.unit == unit for value in values)
            else None
        )
    if ticks is not None:
        unit, multiplier = np.datetime_data(dtype)
        factor, scale = units[unit]
        keys = ticks.astype(object) * (multiplier * factor * (10**18 // scale))
        keys[ticks == -(2**63)] = None
        return pd.Series(keys, dtype=object, index=series.index, name=series.name, copy=False)
    return pd.Series([key(value) for value in values], dtype=object, index=series.index, name=series.name)
