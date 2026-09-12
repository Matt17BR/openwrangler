def _open_wrangler_fill_directional_gaps(ordered, ordered_missing, ordered_temporal, direction, max_gap, error_type):
    """Fill complete ordered runs; None preserves the original target storage."""

    import pandas as pd

    result = ordered.copy()
    filled = False
    cursor = 0
    while cursor < len(result):
        if not ordered_missing[cursor]:
            cursor += 1
            continue
        start = cursor
        while cursor < len(result) and ordered_missing[cursor]:
            cursor += 1
        end = cursor
        gap_size = end - start
        anchor = start - 1 if direction == "forward" else end
        if (max_gap is None or gap_size <= max_gap) and 0 <= anchor < len(result):
            try:
                result.iloc[start:end] = (
                    ordered.array[anchor : anchor + 1].repeat(gap_size)
                    if isinstance(ordered.dtype, pd.CategoricalDtype)
                    else ordered_temporal[anchor]
                    if ordered_temporal is not None
                    else ordered.iloc[anchor]
                )
                filled = True
            except (TypeError, ValueError, OverflowError) as error:
                raise error_type(
                    f"Directional fill is incompatible with the selected Pandas column: {error}"
                ) from error

    return result if filled else None
