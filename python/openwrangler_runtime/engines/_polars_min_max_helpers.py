def _ow_polars_min_max_scale(expression, dtype):
    import polars as pl

    if dtype.is_integer() or dtype.base_type() == pl.Decimal:
        physical = expression.to_physical() if dtype.base_type() == pl.Decimal else expression
        integer_type = pl.UInt128 if dtype == pl.UInt128 else pl.Int128
        physical = physical.cast(integer_type)
        minimum = physical.min()
        maximum = physical.max()
        if dtype in {pl.Int128, pl.UInt128} or dtype.base_type() == pl.Decimal:
            # Subtract base-2^64 limbs with a borrow before converting to
            # double; a full-width span may not fit in a signed integer.
            base = pl.lit(2**64, dtype=integer_type)

            def difference(value):
                quotients = (value // base).cast(pl.Int128) - (minimum // base).cast(pl.Int128)
                remainders = (value % base).cast(pl.Int128) - (minimum % base).cast(pl.Int128)
                borrow = (remainders < 0).cast(pl.Int128)
                return (quotients - borrow).cast(pl.Float64) * float(2**64) + (
                    remainders + borrow * pl.lit(2**64, dtype=pl.Int128)
                ).cast(pl.Float64)

            delta = difference(physical)
            span = difference(maximum)
        else:
            delta = (physical - minimum).cast(pl.Float64)
            span = (maximum - minimum).cast(pl.Float64)
        return (
            pl.when(physical.is_null())
            .then(None)
            .when(physical == minimum)
            .then(0.0)
            .when(physical == maximum)
            .then(1.0)
            .otherwise(delta / span)
        )
    numeric = expression.cast(pl.Float64, strict=False)
    finite = pl.when(numeric.is_finite()).then(numeric).otherwise(None)
    minimum = finite.min()
    maximum = finite.max()
    span = maximum - minimum
    # Polars evaluates vector/scalar division with a reciprocal. Rescale tiny
    # spans so that reciprocal stays finite without losing subnormal deltas.
    scaled = (
        pl.when(span < 2.0**-1022)
        .then(((finite - minimum) * 2.0**1022) / (span * 2.0**1022))
        .when(span.is_finite())
        .then((finite - minimum) / span)
        .otherwise((finite / 2 - minimum / 2) / (maximum / 2 - minimum / 2))
    )
    return (
        pl.when(finite.is_null())
        .then(None)
        .when(finite == minimum)
        .then(0.0)
        .when(finite == maximum)
        .then(1.0)
        .otherwise(scaled)
    )
