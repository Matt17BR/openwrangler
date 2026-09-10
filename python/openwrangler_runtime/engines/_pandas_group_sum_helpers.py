def _open_wrangler_native_int64_sum_is_safe(series) -> bool:
    import builtins

    import numpy as np

    if not isinstance(series.dtype, np.dtype) or series.dtype != np.dtype("int64"):
        return False
    if series.empty:
        return True
    # Bound every group and intermediate sum without converting every value to a Python integer.
    return builtins.len(series) * builtins.max(abs(int(series.min())), abs(int(series.max()))) <= 2**63 - 1
