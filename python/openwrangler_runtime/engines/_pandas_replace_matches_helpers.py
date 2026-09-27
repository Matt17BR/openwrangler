def _open_wrangler_replace_matches(series, semantic_type, pattern, replacement, whole_cell, row=None):
    """Replace the text Find matches in one column's cells, then convert each new text back to the column's type.

    Each distinct value is spelled and converted once; missing values and NaN never match.
    """
    import math
    import re
    from datetime import date, timedelta, timezone
    from decimal import Decimal, InvalidOperation, localcontext
    from numbers import Integral, Real

    import numpy as np
    import pandas as pd

    name = series.name
    if semantic_type not in {"string", "integer", "float", "decimal", "boolean", "date", "datetime"}:
        raise ValueError(f"Replace can't write text back into {semantic_type} column {name!r}.")
    if row is not None and not 0 <= row < len(series):
        raise ValueError(f"Replace targets row {row + 1:,}, but the dataframe has {len(series):,} rows.")
    dtype = series.dtype
    if isinstance(dtype, pd.SparseDtype):
        raise ValueError(f"Replace can't edit sparse column {name!r}.")
    arrow_type = None
    if isinstance(dtype, pd.ArrowDtype):
        import pyarrow as pa

        arrow_type = dtype.pyarrow_dtype
        if pa.types.is_dictionary(arrow_type):
            arrow_type = arrow_type.value_type
            series = series.astype(pd.ArrowDtype(arrow_type))
            dtype = series.dtype
    categorical = isinstance(dtype, pd.CategoricalDtype)
    objects = isinstance(dtype, np.dtype) and dtype.kind == "O"
    selected = series if row is None else series.iloc[row : row + 1]

    if categorical:
        if not all(isinstance(category, str) for category in dtype.categories):
            raise ValueError(f"Replace can only edit categorical column {name!r} when its categories are text.")
        codes = selected.cat.codes.to_numpy()
        uniques = list(dtype.categories)
    elif objects:
        values = selected.array
        try:
            # Equal objects of different types, such as 1, 1.0 and True, are spelled differently.
            codes = pd.factorize(pd.Series([(type(value), value) for value in values], dtype=object))[0]
            uniques = list(values.take(np.unique(codes, return_index=True)[1]))
        except (TypeError, ValueError, ArithmeticError):
            codes, uniques = np.arange(len(values)), list(values)
    else:
        codes, found = pd.factorize(selected.array, use_na_sentinel=True)
        uniques = list(found)

    widths = {np.dtype("float32"): np.float32, np.dtype("float16"): np.float16}
    narrow = None
    if semantic_type == "float":
        narrow = widths.get(getattr(getattr(dtype, "numpy_dtype", dtype), "base", None))
        # Factorizing merges signed zeros, which the grid spells as 0.0 and -0.0.
        if objects:
            negative = np.fromiter(
                (isinstance(value, float) and value == 0 and math.copysign(1.0, value) < 0 for value in selected.array),
                dtype=bool,
                count=len(selected),
            )
        else:
            numbers = selected.to_numpy(dtype=float, na_value=np.nan)
            negative = (numbers == 0) & np.signbit(numbers)
        if negative.any():
            zero = next(code for code, value in enumerate(uniques) if isinstance(value, Real) and value == 0)
            uniques[zero] = abs(uniques[zero])
            codes = codes.copy()
            codes[negative] = len(uniques)
            uniques.append(-uniques[zero])

    def float_width(value):
        return widths.get(getattr(value, "dtype", None))

    def spell(value):
        if value is None or value is pd.NA or value is pd.NaT:
            return None
        if semantic_type == "string":
            return value if isinstance(value, str) else str(value)
        if semantic_type == "boolean":
            return "True" if value else "False"
        if semantic_type == "integer" or isinstance(value, Integral):
            return str(int(value))
        if semantic_type == "float":
            number = float(value)
            if math.isnan(number):
                return None
            if math.isinf(number):
                return "Infinity" if number > 0 else "-Infinity"
            width = narrow or float_width(value)
            return repr(number) if width is None else repr(float(str(width(number))))
        if semantic_type == "decimal":
            return None if value.is_nan() else str(value)
        if isinstance(value, np.datetime64):
            return None if np.isnat(value) else str(value)
        if isinstance(value, pd.Timestamp) and value.nanosecond:
            # Timestamp's nanosecond formatter can mistake offset seconds for the time fraction.
            text = value.isoformat(timespec="microseconds")
            fraction = text.index(".")
            return f"{text[:fraction]}.{value.microsecond * 1_000 + value.nanosecond:09d}{text[fraction + 7 :]}"
        return value.isoformat()

    matcher = re.compile(pattern)
    changed = []
    texts = []
    for code, value in enumerate(uniques):
        label = spell(value)
        if label is None:
            continue
        if whole_cell:
            text = replacement if matcher.fullmatch(label) else None
        else:
            text, count = matcher.subn(lambda _match: replacement, label)
            text = text if count else None
        if text is not None and text != label:
            changed.append(code)
            texts.append(text)
    if not changed:
        return series

    def refused(text, expected):
        return ValueError(f"Replacing in {name!r} gives {text!r}, which isn't {expected}.")

    def fraction_digits():
        if isinstance(dtype, pd.DatetimeTZDtype):
            return {"s": 0, "ms": 3, "us": 6, "ns": 9}[dtype.unit]
        if arrow_type is not None:
            return {"s": 0, "ms": 3, "us": 6, "ns": 9}[arrow_type.unit]
        if isinstance(dtype, np.dtype) and dtype.kind == "M":
            return {"s": 0, "ms": 3, "us": 6, "ns": 9}[np.datetime_data(dtype)[0]]
        return None

    def column_zone():
        if isinstance(dtype, pd.DatetimeTZDtype):
            return dtype.tz
        if arrow_type is not None:
            return arrow_type.tz
        return None

    def convert(text, original):
        if semantic_type == "string":
            return text
        if semantic_type == "boolean":
            folded = text.lower()
            if folded not in ("true", "false"):
                raise refused(text, "True or False")
            return folded == "true"
        if semantic_type == "integer":
            if re.fullmatch(r"[+-]?[0-9]+", text) is None:
                raise refused(text, "a whole number")
            number = int(text)
            numpy_type = getattr(dtype, "numpy_dtype", dtype)
            if not objects and isinstance(numpy_type, np.dtype) and numpy_type.kind in "iu":
                bounds = np.iinfo(numpy_type)
                if not bounds.min <= number <= bounds.max:
                    raise refused(text, f"a whole number from {bounds.min} to {bounds.max}")
            return number
        if semantic_type == "float":
            if (
                re.fullmatch(
                    r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|(?i:[+-]?inf(?:inity)?|nan)", text
                )
                is None
            ):
                raise refused(text, "a number")
            number = float(text)
            width = narrow or float_width(original)
            if width is not None:
                with np.errstate(over="ignore"):
                    number = width(number)
            if math.isinf(number) and "inf" not in text.lower():
                raise refused(text, "a number this column can store")
            return number
        if semantic_type == "decimal":
            if re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", text) is None:
                raise refused(text, "a decimal number")
            with localcontext() as context:
                context.prec = 2_048
                number = Decimal(text)
                if arrow_type is not None:
                    try:
                        exact = number.quantize(Decimal(1).scaleb(-arrow_type.scale))
                    except InvalidOperation:
                        exact = None
                    if exact is None or exact != number:
                        raise refused(text, f"a decimal number with at most {arrow_type.scale} decimal places")
                    if len(exact.as_tuple().digits) > arrow_type.precision:
                        raise refused(text, f"a decimal number with at most {arrow_type.precision} digits")
                    number = exact
            return number
        if semantic_type == "date":
            parts = re.fullmatch(r"([0-9]{4})-([0-9]{2})-([0-9]{2})", text)
            if parts is None:
                raise refused(text, "a date like 2024-01-31")
            try:
                return date(*(int(part) for part in parts.groups()))
            except ValueError:
                raise refused(text, "a date like 2024-01-31") from None
        parts = re.fullmatch(
            r"([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,9}))?)?)?"
            r"(Z|[+-][0-9]{2}:[0-9]{2})?",
            text,
        )
        if parts is None:
            raise refused(text, "a date and time like 2024-01-31T09:30:00")
        year, month, day, hour, minute, second, fraction, offset = parts.groups()
        fraction = (fraction or "").ljust(9, "0")
        digits = fraction_digits()
        if digits is None:
            digits = 9 if isinstance(original, pd.Timestamp) else 6
        if fraction[digits:].strip("0"):
            raise refused(text, f"a time with at most {digits} decimal places" if digits else "a time in whole seconds")
        zone = column_zone() if fraction_digits() is not None else getattr(original, "tzinfo", None)
        if zone is None and offset:
            raise refused(text, "a date and time without a UTC offset")
        if zone is not None and not offset:
            raise refused(text, "a date and time with a UTC offset such as +00:00")
        written = None
        if offset == "Z":
            written = timezone.utc
        elif offset:
            sign = -1 if offset[0] == "-" else 1
            try:
                written = timezone(sign * timedelta(hours=int(offset[1:3]), minutes=int(offset[4:6])))
            except ValueError:
                raise refused(text, "a date and time with a valid UTC offset") from None
        try:
            stamp = pd.Timestamp(
                year=int(year),
                month=int(month),
                day=int(day),
                hour=int(hour or 0),
                minute=int(minute or 0),
                second=int(second or 0),
                microsecond=int(fraction[:6]),
                nanosecond=int(fraction[6:]),
                tz=written,
            )
        except (ValueError, OverflowError):
            raise refused(text, "a valid date and time") from None
        if zone is not None:
            stamp = stamp.tz_convert(zone)
        return stamp.to_pydatetime() if objects and not isinstance(original, pd.Timestamp) else stamp

    converted = [convert(text, uniques[code]) for text, code in zip(texts, changed, strict=True)]
    result = series.copy()
    if isinstance(dtype, pd.CategoricalDtype):
        additions = [text for text in dict.fromkeys(converted) if text not in dtype.categories]
        if additions:
            result = result.cat.add_categories(additions)
    target = result.dtype
    try:
        typed = pd.array(converted, dtype=target)
    except (TypeError, ValueError, OverflowError, ArithmeticError):
        for text, value in zip(texts, converted, strict=True):
            try:
                pd.array([value], dtype=target)
            except (TypeError, ValueError, OverflowError, ArithmeticError):
                raise refused(text, f"a value this {semantic_type} column can store") from None
        raise
    lookup = np.full(len(uniques) + 1, -1, dtype=np.intp)
    lookup[changed] = np.arange(len(changed))
    which = lookup[codes]
    rows = np.flatnonzero(which >= 0)
    result.iloc[rows if row is None else rows + row] = typed.take(which[rows])
    return result
