from collections.abc import Mapping
from datetime import date, datetime, timedelta
from decimal import Decimal
from numbers import Real


def _open_wrangler_object_semantic_type(series, is_missing_scalar, is_integer_scalar):
    import pandas as pd

    # Keep ordinary object inference in Pandas' exhaustive native classifier.
    inferred = pd.api.types.infer_dtype(series, skipna=True)
    inferred_semantic = {
        "boolean": "boolean",
        "integer": "integer",
        "floating": "float",
        "mixed-integer-float": "float",
        "decimal": "decimal",
        "datetime": "datetime",
        "datetime64": "datetime",
        "timedelta": "duration",
        "timedelta64": "duration",
        "bytes": "binary",
    }.get(inferred)
    if inferred_semantic is not None:
        return inferred_semantic
    if inferred in {"mixed", "mixed-integer", "date"}:
        import numpy as np

        # Refine containers and ambiguous scalar families using the existing
        # missing-value semantics, including Pandas NaT in object columns.
        values = [value for value in series.array if not is_missing_scalar(value)]
        if values and all(isinstance(value, bool) for value in values):
            return "boolean"
        if values and all(is_integer_scalar(value) for value in values):
            return "integer"
        if values and all(isinstance(value, Real) and not isinstance(value, bool | np.timedelta64) for value in values):
            return "float"
        if values and all(isinstance(value, Decimal) for value in values):
            return "decimal"
        if values and all(isinstance(value, datetime) for value in values):
            return "datetime"
        if values and all(isinstance(value, date) for value in values):
            return "date"
        if values and all(isinstance(value, timedelta | np.timedelta64) for value in values):
            return "duration"
        if values and all(isinstance(value, bytes) for value in values):
            return "binary"
        if values and all(isinstance(value, list | tuple) for value in values):
            return "list"
        if values and all(isinstance(value, Mapping) for value in values):
            return "struct"
    return "string"
