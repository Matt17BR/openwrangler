def _open_wrangler_round_exact(expression, dtype, decimals: int):
    import polars as pl

    if dtype.is_integer():
        if decimals >= 0:
            return expression
        if decimals <= -40:
            return expression * pl.lit(0, dtype=dtype)
        unsigned = str(dtype).startswith("U")
        bits = int(str(dtype).removeprefix("U").removeprefix("Int"))
        low = 0 if unsigned else -(2 ** (bits - 1))
        high = 2**bits - 1 if unsigned else 2 ** (bits - 1) - 1
        low, high = round(low, decimals), round(high, decimals)
        target = dtype
        for width in (8, 16, 32, 64, 128):
            name = ("UInt" if unsigned else "Int") + str(width)
            if width < bits or not hasattr(pl, name):
                continue
            minimum = 0 if unsigned else -(2 ** (width - 1))
            maximum = 2**width - 1 if unsigned else 2 ** (width - 1) - 1
            if low >= minimum and high <= maximum:
                target = getattr(pl, name)
                break
        else:
            if unsigned and high < 2**127:
                target = pl.Int128
        if low == high == 0:
            return expression * pl.lit(0, dtype=dtype)

        def round_integers(series):
            return pl.Series([None if value is None else round(value, decimals) for value in series], dtype=target)

        return expression.map_batches(round_integers, return_dtype=target, is_elementwise=True)
    if dtype.base_type() == pl.Decimal:
        if decimals >= dtype.scale:
            return expression
        target = pl.Decimal(38, max(decimals, 0))
        if decimals < -(dtype.precision - dtype.scale):
            return (expression * 0).cast(target)
        if decimals >= 0:
            if dtype.precision < 38:
                return expression.cast(pl.Decimal(38, dtype.scale)).round(decimals).cast(target)
            coefficient = expression.to_physical()
            limit = 10**38 - 5 * 10 ** (dtype.scale - decimals - 1) + int(dtype.scale == 38 and decimals == 0)
            threshold = pl.lit(limit, dtype=pl.Int128)
            negative_threshold = pl.lit(-limit, dtype=pl.Int128)
            endpoint = pl.lit(10 ** (38 - dtype.scale), dtype=target)
            negative_endpoint = pl.lit(-(10 ** (38 - dtype.scale)), dtype=target)
            safe = (
                pl.when((coefficient < threshold) & (coefficient > negative_threshold)).then(expression).otherwise(None)
            )
            rounded = safe.round(decimals).cast(target)
            return (
                pl.when(coefficient >= threshold)
                .then(endpoint)
                .when(coefficient <= negative_threshold)
                .then(negative_endpoint)
                .otherwise(rounded)
            )
        from decimal import ROUND_HALF_EVEN, Context, Decimal

        context = Context(prec=dtype.precision + 1, rounding=ROUND_HALF_EVEN)
        quantum = Decimal((0, (1,), -decimals))

        def round_decimals(series):
            return pl.Series(
                [None if value is None else value.quantize(quantum, context=context) for value in series], dtype=target
            )

        return expression.map_batches(round_decimals, return_dtype=target, is_elementwise=True)
    return _open_wrangler_round(expression.cast(pl.Float64, strict=False), decimals)


def _open_wrangler_round(expression, decimals: int):
    import math

    import polars as pl

    if decimals >= 324:
        return expression
    if decimals <= -309:
        return pl.when(expression.is_finite()).then(expression * 0.0).otherwise(expression)
    if decimals >= 0:
        return expression.round(decimals)
    unit = float(10 ** (-decimals))
    small = expression.is_finite() & (expression.abs() < unit / 4)
    eligible = expression.is_finite() & ~small & (expression.abs() < unit * 2**54)

    def rounded(value) -> float:
        try:
            return round(float(value), decimals)
        except OverflowError:
            return math.copysign(math.inf, value)

    # Polars accepts only nonnegative precision. A masked native-Series callback
    # also avoids false decimal ties introduced by floating division/modulo.
    result = pl.when(eligible).then(expression).otherwise(None).map_elements(rounded, return_dtype=pl.Float64)
    return pl.when(eligible).then(result).when(small).then(expression * 0.0).otherwise(expression)
