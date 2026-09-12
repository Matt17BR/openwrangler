def _ow_polars_fill_missing_directional(frame, target, order_rules, direction, max_gap):
    """Fill complete missing runs in stable calculation order without collecting a lazy frame."""

    import polars as pl

    schema = frame.collect_schema() if isinstance(frame, pl.LazyFrame) else frame.schema
    reserved = set(schema.names())

    def unique(base: str) -> str:
        candidate = base
        while candidate in reserved:
            candidate += "_"
        reserved.add(candidate)
        return candidate

    position_name = unique("__ow_directional_position")
    missing_name = unique("__ow_directional_missing")
    run_name = unique("__ow_directional_run")
    gap_name = unique("__ow_directional_gap")
    candidate_name = unique("__ow_directional_candidate")

    target_value = pl.col(target)
    target_missing = target_value.is_null()
    candidate = target_value
    if schema[target].is_float():
        target_missing = target_missing | target_value.is_nan()
        candidate = candidate.fill_nan(None)

    order_expressions = []
    for rule in order_rules:
        expression = pl.col(rule["column"])
        if schema[rule["column"]].is_float():
            expression = expression.fill_nan(None)
        order_expressions.append(expression)
    ordered = frame.with_row_index(position_name).sort(
        order_expressions,
        descending=[rule["direction"] == "desc" for rule in order_rules],
        nulls_last=[rule["nulls"] == "last" for rule in order_rules],
        maintain_order=True,
    )
    ordered = ordered.with_columns(target_missing.alias(missing_name))
    ordered = ordered.with_columns(
        (pl.col(missing_name) != pl.col(missing_name).shift(1).fill_null(False)).cum_sum().alias(run_name)
    )
    ordered = ordered.with_columns(
        pl.when(pl.col(missing_name)).then(pl.len().over(run_name)).otherwise(0).alias(gap_name),
        (candidate.forward_fill() if direction == "forward" else candidate.backward_fill()).alias(candidate_name),
    )
    eligible = pl.col(missing_name) & pl.col(candidate_name).is_not_null()
    if max_gap is not None:
        eligible = eligible & (pl.col(gap_name) <= max_gap)
    result = pl.when(eligible).then(pl.col(candidate_name)).otherwise(target_value)
    return (
        ordered.with_columns(result.alias(target))
        .sort(position_name)
        .drop(position_name, missing_name, run_name, gap_name, candidate_name)
    )
