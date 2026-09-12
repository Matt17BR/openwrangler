def _ow_polars_interpolation_coordinate_kind(dtype, error_type):
    import polars as pl

    if dtype in {pl.Int128, pl.UInt128}:
        raise error_type(
            "Linear interpolation does not support 128-bit integer coordinates; "
            "convert the coordinate to a narrower exact type first."
        )
    if dtype.is_integer():
        return "integer"
    if dtype.is_float():
        return "float"
    if dtype.base_type() == pl.Decimal:
        return "decimal"
    if dtype == pl.Date:
        return "date"
    if dtype.base_type() == pl.Datetime:
        return "datetime"
    raise error_type("Linear interpolation coordinates must be numeric, dates, or datetimes.")


def _ow_polars_interpolation_coordinate_expression(expression, dtype, kind, minimum):
    import polars as pl

    if kind == "float":
        return expression.cast(pl.Float64)
    minimum_expression = minimum if isinstance(minimum, pl.Expr) else pl.lit(minimum, dtype=dtype)
    if kind in {"integer", "datetime"}:
        raw = expression.cast(pl.Int128)
        minimum_raw = minimum_expression.cast(pl.Int128)
        return (raw - minimum_raw).cast(pl.Float64)
    if kind == "date":
        raw = expression.cast(pl.Int32).cast(pl.Int64)
        minimum_raw = minimum_expression.cast(pl.Date).cast(pl.Int32).cast(pl.Int64)
        return (raw - minimum_raw).cast(pl.Float64)
    exact_dtype = pl.Decimal(38, dtype.scale)
    return (expression.cast(exact_dtype) - minimum_expression.cast(exact_dtype)).cast(pl.Float64)


def _ow_polars_interpolation_coordinate_roundtrip(expression, dtype, kind, minimum):
    import polars as pl

    if kind == "float":
        return pl.lit(True)
    minimum_expression = minimum if isinstance(minimum, pl.Expr) else pl.lit(minimum, dtype=dtype)
    if kind in {"integer", "datetime"}:
        exact = expression.cast(pl.Int128) - minimum_expression.cast(pl.Int128)
        return exact.cast(pl.Float64).cast(pl.Int128) == exact
    if kind == "date":
        exact = expression.cast(pl.Int32).cast(pl.Int64) - minimum_expression.cast(pl.Date).cast(pl.Int32).cast(
            pl.Int64
        )
        return exact.cast(pl.Float64).cast(pl.Int64) == exact
    exact_dtype = pl.Decimal(38, dtype.scale)
    exact = expression.cast(exact_dtype) - minimum_expression.cast(exact_dtype)
    return exact.cast(pl.Float64).cast(exact_dtype) == exact


def _ow_polars_fill_missing_linear_interpolation(
    frame, target, coordinate, max_gap, *, error_type: "type[Exception]" = ValueError
):
    import polars as pl

    schema = frame.collect_schema() if isinstance(frame, pl.LazyFrame) else frame.schema
    target_dtype = schema[target]
    coordinate_dtype = schema[coordinate]
    if not target_dtype.is_float():
        raise error_type("Linear interpolation requires a floating-point target column.")
    coordinate_kind = _ow_polars_interpolation_coordinate_kind(coordinate_dtype, error_type)
    source_coordinate = pl.col(coordinate)
    invalid_coordinate = source_coordinate.is_null()
    if coordinate_dtype.is_float():
        invalid_coordinate = invalid_coordinate | ~source_coordinate.is_finite()
    reserved = set(schema.names())

    def unique(base):
        candidate = base
        while candidate in reserved:
            candidate += "_"
        reserved.add(candidate)
        return candidate

    validation_minimum_name = unique("__ow_interpolation_validation_minimum")
    validation_coordinate_name = unique("__ow_interpolation_validation_coordinate")
    validation_frame = frame.with_columns(source_coordinate.min().alias(validation_minimum_name))
    validation_coordinate = _ow_polars_interpolation_coordinate_expression(
        source_coordinate, coordinate_dtype, coordinate_kind, pl.col(validation_minimum_name)
    )
    validation_roundtrip = _ow_polars_interpolation_coordinate_roundtrip(
        source_coordinate, coordinate_dtype, coordinate_kind, pl.col(validation_minimum_name)
    )
    summary_query = validation_frame.with_columns(validation_coordinate.alias(validation_coordinate_name)).select(
        pl.len().alias("__ow_count"),
        invalid_coordinate.sum().alias("__ow_invalid"),
        source_coordinate.n_unique().alias("__ow_unique"),
        pl.col(validation_coordinate_name).n_unique().alias("__ow_projected_unique"),
        pl.col(validation_coordinate_name).is_finite().all().alias("__ow_projected_finite"),
        validation_roundtrip.all().alias("__ow_projected_exact"),
        pl.col(validation_minimum_name).first().alias("__ow_minimum"),
    )
    try:
        summary = (
            summary_query.collect(engine="streaming") if isinstance(summary_query, pl.LazyFrame) else summary_query
        )
    except Exception as error:
        raise error_type("Linear interpolation cannot represent the selected coordinate distances exactly.") from error
    count = int(summary["__ow_count"][0])
    if int(summary["__ow_invalid"][0] or 0):
        raise error_type("Linear interpolation requires every coordinate value to be present and finite.")
    if int(summary["__ow_unique"][0]) != count:
        raise error_type("Linear interpolation requires unique coordinate values.")
    if count and (
        not bool(summary["__ow_projected_finite"][0])
        or not bool(summary["__ow_projected_exact"][0])
        or int(summary["__ow_projected_unique"][0]) != count
    ):
        raise error_type(
            "Linear interpolation cannot preserve the selected coordinate distances exactly enough; "
            "choose a lower-precision coordinate column."
        )
    minimum = summary["__ow_minimum"][0] if count else None
    numeric_coordinate = _ow_polars_interpolation_coordinate_expression(
        source_coordinate, coordinate_dtype, coordinate_kind, minimum
    )
    position_name = unique("__ow_interpolation_position")
    missing_name = unique("__ow_interpolation_missing")
    run_name = unique("__ow_interpolation_run")
    gap_name = unique("__ow_interpolation_gap")
    coordinate_name = unique("__ow_interpolation_coordinate")
    left_value_name = unique("__ow_interpolation_left_value")
    right_value_name = unique("__ow_interpolation_right_value")
    left_coordinate_name = unique("__ow_interpolation_left_coordinate")
    right_coordinate_name = unique("__ow_interpolation_right_coordinate")
    target_value = pl.col(target)
    missing = target_value.is_null() | target_value.is_nan()
    present_target = pl.when(missing).then(None).otherwise(target_value)
    present_coordinate = pl.when(missing).then(None).otherwise(pl.col(coordinate_name))
    ordered = (
        frame.with_row_index(position_name)
        .sort(coordinate, maintain_order=True)
        .with_columns(missing.alias(missing_name), numeric_coordinate.alias(coordinate_name))
        .with_columns(
            (pl.col(missing_name) != pl.col(missing_name).shift(1).fill_null(False)).cum_sum().alias(run_name),
            present_target.shift(1).forward_fill().alias(left_value_name),
            present_target.shift(-1).backward_fill().alias(right_value_name),
            present_coordinate.shift(1).forward_fill().alias(left_coordinate_name),
            present_coordinate.shift(-1).backward_fill().alias(right_coordinate_name),
        )
        .with_columns(pl.when(pl.col(missing_name)).then(pl.len().over(run_name)).otherwise(0).alias(gap_name))
    )
    left_coordinate = pl.col(left_coordinate_name)
    right_coordinate = pl.col(right_coordinate_name)
    current_coordinate = pl.col(coordinate_name)
    coordinate_span = right_coordinate - left_coordinate
    direct_weight = (current_coordinate - left_coordinate) / coordinate_span
    scaled_weight = ((current_coordinate / 2.0) - (left_coordinate / 2.0)) / (
        (right_coordinate / 2.0) - (left_coordinate / 2.0)
    )
    weight = pl.when(coordinate_span.is_finite()).then(direct_weight).otherwise(scaled_weight)
    left_value = pl.col(left_value_name)
    right_value = pl.col(right_value_name)
    interpolated = (
        pl.when((left_value == right_value) & (left_value != 0.0))
        .then(left_value)
        .when(
            (weight == 0.5)
            & (left_value.abs() < 2.2250738585072014e-308)
            & (right_value.abs() < 2.2250738585072014e-308)
        )
        .then((left_value + right_value) / 2.0)
        .otherwise((pl.lit(1.0) - weight) * left_value + weight * right_value)
        .cast(target_dtype)
    )
    eligible = (
        pl.col(missing_name)
        & left_value.is_finite()
        & right_value.is_finite()
        & weight.is_finite()
        & weight.is_between(0.0, 1.0, closed="both")
    )
    if max_gap is not None:
        eligible = eligible & (pl.col(gap_name) <= max_gap)
    temporary_names = [
        position_name,
        missing_name,
        run_name,
        gap_name,
        coordinate_name,
        left_value_name,
        right_value_name,
        left_coordinate_name,
        right_coordinate_name,
    ]
    return (
        ordered.with_columns(pl.when(eligible).then(interpolated).otherwise(target_value).alias(target))
        .sort(position_name)
        .drop(*temporary_names)
    )
