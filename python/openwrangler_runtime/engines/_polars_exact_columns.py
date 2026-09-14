def _ow_polars_col(frame, name):
    """Keep ordinary lookup unchanged; bind selector-looking names literally."""
    import polars as pl

    if name != "*" and not (name.startswith("^") and name.endswith("$")):
        return pl.col(name)
    schema = (
        frame.collect_schema()
        if isinstance(frame, pl.LazyFrame)
        else frame.schema
        if isinstance(frame, pl.DataFrame)
        else frame
    )
    if name not in schema:
        raise pl.exceptions.ColumnNotFoundError(f"Column {name!r} does not exist.")
    escaped = "".join("\\" + character if character in "\\.^$|?*+()[]{}" else character for character in name)
    return pl.col("^" + escaped + "$").alias(name)


def _ow_polars_columns(frame, names):
    """Resolve exact positions only for the immediate native selector call."""
    if not any(name == "*" or (name.startswith("^") and name.endswith("$")) for name in names):
        return names
    import polars as pl
    import polars.selectors as cs

    schema = (
        frame.collect_schema()
        if isinstance(frame, pl.LazyFrame)
        else frame.schema
        if isinstance(frame, pl.DataFrame)
        else frame
    )
    positions = {name: index for index, name in enumerate(schema)}
    for name in names:
        if name not in positions:
            raise pl.exceptions.ColumnNotFoundError(f"Column {name!r} does not exist.")
    return cs.by_index([positions[name] for name in names])
