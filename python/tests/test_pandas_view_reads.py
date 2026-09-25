from __future__ import annotations

import json
from typing import Any

import numpy as np
import pandas as pd
import pytest

from openwrangler_runtime.engines.pandas_engine import (
    PandasEngine,
    _pandas_contiguous_text,
    _pandas_distinct_text_condition,
    _pandas_sort_order,
    _pandas_text_condition,
    _pandas_text_sort_ranks,
    _PandasRowView,
)

pa = pytest.importorskip("pyarrow")

TEXT = ["b", None, "A", "é", "", "b", "a", None, "B", "ab"]


def _chunked(values: list[Any], dtype: Any) -> pd.Series:
    middle = len(values) // 2
    return pd.concat(
        [pd.Series(values[:middle], dtype=dtype), pd.Series(values[middle:], dtype=dtype)], ignore_index=True
    )


def _frame(index: pd.Index) -> pd.DataFrame:
    frame = pd.DataFrame(
        {
            "text": _chunked(TEXT, "str"),
            "arrow_text": _chunked(TEXT, pd.ArrowDtype(pa.large_string())),
            "number": [3.0, np.nan, 1.5, 3.0, -0.0, 0.0, None, 2.5, 3.0, 1.5],
            "sparse": pd.arrays.SparseArray([0, 0, 1, 0, 2, 0, 0, 1, 0, 0]),
            "when": pd.to_datetime(["2024-01-02"] * 5 + [None] + ["2023-12-31"] * 4),
        }
    )
    frame.index = index
    return frame


def _predicate(column: str, column_type: str, operator: str, value: object) -> dict[str, object]:
    return {
        "column": column,
        "type": column_type,
        "predicates": [{"kind": "predicate", "operator": operator, "value": value}],
    }


INDEXES = {
    "positional": pd.RangeIndex(10),
    "labeled": pd.Index(list("jihgfedcba"), name="key"),
    "multi": pd.MultiIndex.from_arrays([[1, 1, 2, 2, 3, 3, 4, 4, 5, 5], list("xyxyxyxyxy")], names=["group", "side"]),
}
MODELS = {
    "text-filter-and-sort": {
        "filters": [_predicate("text", "string", "contains", "B")],
        "sort": [{"column": "number", "direction": "desc", "nulls": "first"}],
    },
    "or-filter": {
        "logic": "or",
        "filters": [_predicate("number", "float", "gt", 2), _predicate("arrow_text", "string", "endsWith", "b")],
        "sort": [],
    },
    "multi-sort": {
        "filters": [],
        "sort": [
            {"column": "text", "direction": "asc", "nulls": "last"},
            {"column": "when", "direction": "desc", "nulls": "first"},
        ],
    },
    "text-sort-only": {"filters": [], "sort": [{"column": "arrow_text", "direction": "desc", "nulls": "first"}]},
}


@pytest.mark.parametrize("index_name", INDEXES)
@pytest.mark.parametrize("model_name", MODELS)
def test_pandas_row_views_read_exactly_like_their_materialized_rows(index_name: str, model_name: str) -> None:
    engine = PandasEngine()
    frame = _frame(INDEXES[index_name])
    model = MODELS[model_name]
    view = engine.filter_view(frame, model)
    materialized = engine.apply_filter_model(frame, model)
    assert isinstance(view, _PandasRowView)

    def same(read):
        assert json.dumps(read(view), sort_keys=True, default=str) == json.dumps(
            read(materialized), sort_keys=True, default=str
        )

    same(engine.shape)
    same(engine.row_axis)
    for offset, limit in ((0, 3), (2, 20)):
        same(lambda target, offset=offset, limit=limit: engine.page(target, offset, limit))
    same(engine.summaries)
    same(engine.header_stats)
    for position in range(frame.shape[1]):
        same(lambda target, position=position: engine.missing_count(target, position))
    for column in frame.columns:
        same(lambda target, column=column: engine.column_values(target, column, "b"))
        same(lambda target, column=column: engine.column_values(target, column))


@pytest.mark.parametrize(
    "dtype",
    [
        pytest.param(
            "str",
            marks=pytest.mark.skipif(pd.Series(dtype="str").dtype == object, reason='Pandas 2 stores "str" as objects'),
        ),
        pd.StringDtype("pyarrow"),
        pd.ArrowDtype(pa.string()),
    ],
)
def test_pandas_arrow_text_fast_paths_match_row_wise_semantics(dtype: Any) -> None:
    series = _chunked(TEXT * 3, dtype)
    for ascending in (True, False):
        for nulls in ("first", "last"):
            ranks = _pandas_text_sort_ranks(series, ascending, nulls)
            assert ranks is not None
            np.testing.assert_array_equal(
                np.argsort(ranks, kind="stable"), _pandas_sort_order(series, ascending, nulls)
            )
    for method, value in (("contains", "B"), ("contains", "É"), ("startswith", "a"), ("endswith", "")):
        pd.testing.assert_series_equal(
            _pandas_distinct_text_condition(series, method, value), _pandas_text_condition(series, method, value)
        )

    frame = pd.DataFrame({"text": series, "number": range(len(series))})
    contiguous = _pandas_contiguous_text(frame)
    assert contiguous.iloc[:, 0].array.__arrow_array__().num_chunks == 1
    pd.testing.assert_frame_equal(contiguous, frame)
    assert frame.iloc[:, 0].array.__arrow_array__().num_chunks == 2


@pytest.mark.parametrize("values", [[0, 0, 1, 0, 2], [0.0, 1.5, None, 0.0]], ids=["integer", "float"])
def test_pandas_sparse_numeric_profiles_match_dense_values(values: list[object]) -> None:
    engine = PandasEngine()
    dense = pd.Series(values, dtype="float64" if None in values else "int64")
    (sparse_summary,) = engine.summaries(pd.DataFrame({"v": pd.arrays.SparseArray(values)}))
    (dense_summary,) = engine.summaries(pd.DataFrame({"v": dense}))
    for key in ("numeric", "visualization", "topValues", "distinctCount", "nullCount", "nanCount"):
        assert sparse_summary[key] == dense_summary[key]
