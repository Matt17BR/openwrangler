def _open_wrangler_fill_directional_gaps(ordered_missing, direction, max_gap):
    """Map each ordered row to the row whose value it keeps; None when no complete run is filled."""

    import numpy as np

    size = len(ordered_missing)
    positions = np.arange(size, dtype=np.int64)
    if direction == "forward":
        anchors = np.maximum.accumulate(np.where(ordered_missing, -1, positions))
    else:
        anchors = np.minimum.accumulate(np.where(ordered_missing, size, positions)[::-1])[::-1]
    filled = ordered_missing & (anchors >= 0) & (anchors < size)
    if max_gap is not None and filled.any():
        starts = ordered_missing.copy()
        starts[1:] &= ~ordered_missing[:-1]
        runs = np.cumsum(starts) - 1
        lengths = np.bincount(runs[ordered_missing])
        filled &= lengths[np.maximum(runs, 0)] <= max_gap
    if not filled.any():
        return None
    return np.where(filled, anchors, positions)
