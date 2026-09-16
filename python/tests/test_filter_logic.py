from __future__ import annotations

import json
import operator
import sys
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, localcontext
from pathlib import Path
from typing import Any, cast

import duckdb
import numpy as np
import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime._column_binding import bind_step
from openwrangler_runtime.engines import DuckDBEngine, PandasEngine, PolarsEngine
from openwrangler_runtime.engines.base import (
    EngineError,
    coerce_typed_view_value,
    generated_view_value_helper_lines,
    normalize_cell,
    typed_selection_value,
)
from openwrangler_runtime.engines.duckdb_engine import DuckDBSqlPlan
from openwrangler_runtime.lineage import source_lineage
from openwrangler_runtime.operations import FILTER_OPERATORS, validate_step
from openwrangler_runtime.session import SessionManager

_VIEW_LITERAL_CONTRACT = json.loads(
    (Path(__file__).resolve().parents[2] / "fixtures" / "view-literal-contract.json").read_text(encoding="utf-8")
)

_PANDAS_PREDICATE_PARITY_CASES = {
    "equals": ("integer", {"value": 2}, ["two"]),
    "notEquals": ("integer", {"value": 2}, ["one", "three", "four"]),
    "contains": ("string", {"value": "PHA"}, ["alpha", "alphabet"]),
    "startsWith": ("string", {"value": "alpha"}, ["alpha", "alphabet"]),
    "endsWith": ("string", {"value": "ta"}, ["beta"]),
    "gt": ("integer", {"value": 2}, ["three", "four"]),
    "gte": ("integer", {"value": 2}, ["two", "three", "four"]),
    "lt": ("integer", {"value": 3}, ["one", "two"]),
    "lte": ("integer", {"value": 3}, ["one", "two", "three"]),
    "between": ("integer", {"value": 2, "secondValue": 3}, ["two", "three"]),
    "isNull": ("float", {}, ["null"]),
    "isNotNull": ("float", {}, ["nan", "one"]),
    "isNaN": ("float", {}, ["nan"]),
    "isNotNaN": ("float", {}, ["null", "one"]),
}


@pytest.mark.parametrize("case", _VIEW_LITERAL_CONTRACT["accepted"], ids=lambda case: f"{case['type']}:{case['value']}")
def test_portable_view_literal_contract_accepts_live_and_generated_values(case):
    namespace = {"Decimal": Decimal, "date": date, "datetime": datetime, "timedelta": timedelta}
    exec("\n".join(generated_view_value_helper_lines()), namespace, namespace)

    coerce_typed_view_value(case["value"], case["type"])
    namespace["_open_wrangler_view_value"](case["value"], case["type"])


@pytest.mark.parametrize("case", _VIEW_LITERAL_CONTRACT["rejected"], ids=lambda case: f"{case['type']}:{case['value']}")
def test_portable_view_literal_contract_rejects_live_and_generated_values(case):
    namespace = {"Decimal": Decimal, "date": date, "datetime": datetime, "timedelta": timedelta}
    exec("\n".join(generated_view_value_helper_lines()), namespace, namespace)

    with pytest.raises(EngineError):
        coerce_typed_view_value(case["value"], case["type"])
    with pytest.raises((TypeError, ValueError, ArithmeticError)):
        namespace["_open_wrangler_view_value"](case["value"], case["type"])


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_advanced_filter_logic_matches_between_columns_and_within_a_column(tmp_path, backend):
    path = tmp_path / "logic.csv"
    path.write_text("city,value\nBerlin,2\nMilan,7\nParis,12\nRome,20\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session({"kind": "file", "label": path.name, "path": str(path)}, backend=backend)

    model = {
        "logic": "or",
        "filters": [
            {
                "column": "city",
                "type": "string",
                "logic": "or",
                "predicates": [
                    {"kind": "predicate", "operator": "startsWith", "value": "Ber"},
                    {"kind": "predicate", "operator": "endsWith", "value": "lan"},
                ],
            },
            {
                "column": "value",
                "type": "integer",
                "logic": "and",
                "predicates": [{"kind": "predicate", "operator": "gt", "value": 15}],
            },
        ],
        "sort": [{"column": "value", "direction": "asc", "nulls": "last"}],
    }

    response = manager.get_page(opened["metadata"]["sessionId"], 0, 0, 10, model)
    assert [row["values"][0]["display"] for row in response["page"]["rows"]] == ["Berlin", "Milan", "Rome"]


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_empty_value_selection_does_not_hide_every_row(tmp_path, backend):
    path = tmp_path / "empty-selection.csv"
    path.write_text("name\nalpha\nbeta\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session({"kind": "file", "label": path.name, "path": str(path)}, backend=backend)
    model = {
        "logic": "and",
        "filters": [
            {
                "column": "name",
                "type": "string",
                "logic": "and",
                "valueFilter": {
                    "kind": "values",
                    "selectedValues": [],
                    "includeNulls": False,
                    "includeNaN": False,
                },
                "predicates": [],
            }
        ],
        "sort": [],
    }

    response = manager.get_page(opened["metadata"]["sessionId"], 0, 0, 10, model)
    assert response["page"]["totalRows"] == 2


def _missing_frame(backend: str) -> Any:
    values = [None, float("nan"), 1.0]
    labels = ["null", "nan", "value"]
    if backend == "pandas":
        return pd.DataFrame(
            {
                "label": labels,
                "value": pd.Series(values, dtype="object"),
            }
        )
    if backend == "duckdb":
        return duckdb.sql(
            "SELECT * FROM (VALUES ('null', NULL::DOUBLE), ('nan', 'NaN'::DOUBLE), "
            "('value', 1.0::DOUBLE)) AS values(label, value)"
        )
    return pl.DataFrame({"label": labels, "value": values})


def _filtered_labels(frame: Any, backend: str) -> list[str]:
    if backend == "pandas":
        return frame["label"].tolist()
    if backend == "duckdb":
        if isinstance(frame, DuckDBSqlPlan):
            connection = duckdb.connect(config={"enable_external_file_cache": False})
            try:
                return [
                    str(row[0]) for row in connection.execute(f'SELECT "label" FROM ({frame.sql}) AS ow').fetchall()
                ]
            finally:
                connection.close()
        return [str(row[0]) for row in frame.project('"label"').fetchall()]
    return frame.get_column("label").to_list()


def _duckdb_rows(frame: Any) -> list[tuple[Any, ...]]:
    if not isinstance(frame, DuckDBSqlPlan):
        return list(frame.fetchall())
    connection = duckdb.connect(config={"enable_external_file_cache": False})
    try:
        return list(connection.execute(frame.sql).fetchall())
    finally:
        connection.close()


def _engine(backend: str) -> Any:
    return {"pandas": PandasEngine, "polars": PolarsEngine, "duckdb": DuckDBEngine}[backend]()


def _execute_generated_filter(
    engine: Any, frame: Any, model: dict[str, Any], *, namespace: dict[str, Any] | None = None
) -> Any:
    namespace = {} if namespace is None else namespace
    bound_model = deepcopy(model)
    columns = frame.collect_schema().names() if isinstance(frame, pl.LazyFrame) else frame.columns
    positions = {str(name): position for position, name in enumerate(columns)}
    for column_filter in bound_model["filters"]:
        name = str(column_filter["column"])
        column_filter["column"] = {
            "id": f"c:source:{positions[name]}",
            "name": name,
            "position": positions[name],
        }
    for rule in bound_model["sort"]:
        name = str(rule["column"])
        rule["column"] = {
            "id": f"c:source:{positions[name]}",
            "name": name,
            "position": positions[name],
        }
    step = {"id": "filter", "kind": "filterRows", "params": {"filterModel": bound_model}}
    exec(engine.compile_plan([step]), namespace, namespace)
    return namespace["clean_data"](frame)


@pytest.mark.parametrize(
    ("operator", "case"),
    _PANDAS_PREDICATE_PARITY_CASES.items(),
    ids=_PANDAS_PREDICATE_PARITY_CASES,
)
def test_pandas_predicate_operators_match_view_bound_and_generated(operator, case):
    assert set(_PANDAS_PREDICATE_PARITY_CASES) == FILTER_OPERATORS
    column_type, operands, expected = case
    labels, values, dtype = {
        "integer": (
            ["one", "two", "three", "four", "missing"],
            [1, 2, 3, 4, None],
            "Int64",
        ),
        "string": (["missing", "alpha", "alphabet", "beta"], [None, "alpha", "alphabet", "beta"], "string"),
        "float": (["null", "nan", "one"], [None, float("nan"), 1.0], "object"),
    }[column_type]
    frame = pd.DataFrame({"label": labels, "value": pd.Series(values, dtype=dtype)})
    model = {
        "logic": "and",
        "filters": [
            {
                "column": "value",
                "type": column_type,
                "logic": "and",
                "predicates": [{"kind": "predicate", "operator": operator, **operands}],
            }
        ],
        "sort": [],
    }

    engine = PandasEngine()
    schema = engine.schema(frame)
    lineage = source_lineage(schema)
    public_model = deepcopy(model)
    public_model["filters"][0]["column"] = lineage[1]
    bound_step = bind_step(
        validate_step({"id": "filter", "kind": "filterRows", "params": {"filterModel": public_model}}),
        schema,
        lineage,
    )
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([bound_step]), namespace, namespace)

    results = [
        engine.apply_filter_model(frame, model),
        engine.apply_transform(frame, bound_step),
        namespace["clean_data"](frame),
    ]
    assert [result["label"].tolist() for result in results] == [expected, expected, expected]


def _assert_pandas_row_query(frame, model, expected_rows, *, sort_only=False):
    engine = PandasEngine()
    before = frame.copy(deep=True)
    schema = engine.schema(frame)
    lineage = source_lineage(schema)
    public_model = deepcopy(model)
    for item in [*public_model["filters"], *public_model["sort"]]:
        item["column"] = lineage[list(frame.columns).index(item["column"])]
    step = {
        "id": "query",
        "kind": "sortRows" if sort_only else "filterRows",
        "params": {"rules": public_model["sort"]} if sort_only else {"filterModel": public_model},
    }
    bound = bind_step(validate_step(step), schema, lineage)
    namespace = {}
    exec(engine.compile_plan([bound]), namespace, namespace)
    results = [
        engine.apply_filter_model(frame, model),
        engine.apply_transform(frame, bound),
        namespace["clean_data"](frame),
    ]
    expected_dtypes = [
        frame.iloc[:, position].array.take(np.array([], dtype=np.intp), allow_fill=False).dtype
        if not expected_rows and isinstance(dtype, pd.SparseDtype)
        else dtype
        for position, dtype in enumerate(frame.dtypes)
    ]
    for result in results:
        assert result["row"].tolist() == expected_rows
        assert result.dtypes.tolist() == expected_dtypes
        assert result.attrs == frame.attrs
        pd.testing.assert_index_equal(result.columns, frame.columns)
        pd.testing.assert_index_equal(result.index, frame.index.take(expected_rows))
        for position in range(frame.shape[1]):
            if isinstance(frame.dtypes.iloc[position], pd.ArrowDtype):
                original_values = frame.iloc[:, position].array.__arrow_array__().to_pylist()
                expected = [original_values[row] for row in expected_rows]
                actual = result.iloc[:, position].array.__arrow_array__().to_pylist()
            else:
                expected = frame.iloc[:, position].to_numpy(dtype=object)[expected_rows]
                actual = result.iloc[:, position].to_numpy(dtype=object)
            for value, original in zip(actual, expected, strict=True):
                assert pd.isna(value) if pd.isna(original) else value == original
    pd.testing.assert_index_equal(frame.columns, before.columns)
    pd.testing.assert_index_equal(frame.index, before.index)
    assert frame.dtypes.tolist() == before.dtypes.tolist()
    for position, dtype in enumerate(frame.dtypes):
        if isinstance(dtype, pd.ArrowDtype):
            assert (
                frame.iloc[:, position].array.__arrow_array__().equals(before.iloc[:, position].array.__arrow_array__())
            )
        else:
            pd.testing.assert_series_equal(frame.iloc[:, position], before.iloc[:, position])
    assert frame.attrs == before.attrs
    return results


def _integer_query_frame(values, dtype):
    frame = pd.DataFrame({"value": pd.Series(values, dtype=object).astype(dtype), "row": range(len(values))})
    frame.index = pd.MultiIndex.from_tuples([("same", 7)] * len(frame), names=["group", "index"])
    frame.attrs = {"source": "unchanged"}
    return frame


@pytest.mark.parametrize(
    "dtype",
    [
        "uint8",
        "Int8",
        "int64",
        "Int64",
        "int64[pyarrow]",
        "uint64",
        "UInt64",
        "uint64[pyarrow]",
        pd.SparseDtype("uint64", 0),
        pd.SparseDtype("uint64", np.nan),
        pd.SparseDtype("int64", -7),
    ],
)
def test_pandas_integer_filters_preserve_exact_values_and_bounds(dtype):
    resolved = pd.api.types.pandas_dtype(dtype)
    native = getattr(resolved, "numpy_dtype", getattr(resolved, "subtype", resolved))
    assert isinstance(native, np.dtype)
    bounds = np.iinfo(native)
    low, high = int(bounds.min), int(bounds.max)
    needle = 2**53 + 1 if bounds.bits == 64 else 1
    values: list[int | None] = [low, 0, needle - 1, needle, needle + 1, high]
    sparse = isinstance(resolved, pd.SparseDtype)
    missing = sparse and pd.isna(resolved.fill_value)
    if sparse and not missing:
        values.append(int(resolved.fill_value))
    if missing or (not sparse and isinstance(resolved, pd.api.extensions.ExtensionDtype)):
        values.append(None)
    frame = _integer_query_frame(values, dtype)
    choices, _ = PandasEngine().column_values(frame, "value")
    token = next(choice["selectionValue"] for choice in choices if choice["value"] == str(needle))
    assert coerce_typed_view_value(token, "integer") == needle

    for selected in [[needle], [high], [low - 1], [high + 1], [-1, 2**64 - 1], []]:
        model = _value_selection_model("integer", token)
        model["filters"][0]["valueFilter"]["selectedValues"] = [
            typed_selection_value(value, "integer") for value in selected
        ]
        expected = [i for i, value in enumerate(values) if not selected or (value is not None and value in selected)]
        _assert_pandas_row_query(frame, model, expected)
    for include_nulls, include_nan in [(True, False), (False, True), (True, True)]:
        model = _value_selection_model("integer", typed_selection_value(0, "integer"))
        model["filters"][0]["valueFilter"].update(includeNulls=include_nulls, includeNaN=include_nan)
        expected = [
            i
            for i, value in enumerate(values)
            if value == 0 or (value is None and (include_nan if missing else include_nulls))
        ]
        _assert_pandas_row_query(frame, model, expected)
    for spelling, compare in [
        ("equals", operator.eq),
        ("notEquals", operator.ne),
        ("gt", operator.gt),
        ("gte", operator.ge),
        ("lt", operator.lt),
        ("lte", operator.le),
    ]:
        for value in [low - 1, needle, high + 1, -(2**100), 2**100]:
            model = {
                "filters": [
                    {
                        "column": "value",
                        "type": "integer",
                        "predicates": [{"kind": "predicate", "operator": spelling, "value": str(value)}],
                    }
                ],
                "sort": [],
            }
            expected = [i for i, item in enumerate(values) if item is not None and compare(item, value)]
            _assert_pandas_row_query(frame, model, expected)
    for low_value, high_value in [(low - 1, high + 1), (needle, needle), (high + 1, high + 2), (high, low)]:
        model = {
            "filters": [
                {
                    "column": "value",
                    "type": "integer",
                    "predicates": [
                        {
                            "kind": "predicate",
                            "operator": "between",
                            "value": str(low_value),
                            "secondValue": str(high_value),
                        }
                    ],
                }
            ],
            "sort": [],
        }
        _assert_pandas_row_query(
            frame,
            model,
            [i for i, value in enumerate(values) if value is not None and low_value <= value <= high_value],
        )


@pytest.mark.parametrize("dtype", ["UInt64", "uint64[pyarrow]", pd.SparseDtype("uint64", np.nan)])
@pytest.mark.parametrize("values", [[], [None, None]])
def test_pandas_integer_filters_keep_empty_and_missing_storage(dtype, values):
    frame = _integer_query_frame(values, dtype)
    model = _value_selection_model("integer", typed_selection_value(2**64 - 1, "integer"))
    _assert_pandas_row_query(frame, model, [])
    model["filters"][0]["valueFilter"].update(includeNulls=True, includeNaN=True)
    _assert_pandas_row_query(frame, model, list(range(len(values))))


def test_pandas_integer_filters_keep_arbitrary_object_integers():
    values = [-(2**1000), 0, 2**1000, None]
    frame = _integer_query_frame(values, object)
    for selected in [2**1000, -(2**1000), 2**1000 + 1]:
        model = _value_selection_model("integer", typed_selection_value(selected, "integer"))
        _assert_pandas_row_query(frame, model, [i for i, value in enumerate(values) if value == selected])
    model = {
        "filters": [
            {
                "column": "value",
                "type": "integer",
                "predicates": [{"kind": "predicate", "operator": "gt", "value": str(2**999)}],
            }
        ],
        "sort": [],
    }
    _assert_pandas_row_query(frame, model, [2])


@pytest.mark.parametrize("fill", [0, np.nan, 1.0, -1, 2**64, 1.5])
@pytest.mark.filterwarnings("ignore:Allowing arbitrary scalar fill_value:FutureWarning")
def test_pandas_sparse_integer_filters_and_sorting_preserve_returned_values(fill):
    try:
        dtype = pd.SparseDtype("uint64", fill)
    except ValueError:
        pytest.skip("This Pandas version rejects the older supported non-integer or out-of-range sparse fill.")
    values = [fill, 2**53 + 4, 2**53 + 3, 2**64 - 1, fill, 2**53 + 3]
    frame = _integer_query_frame(values, dtype)
    frame.insert(
        1, "other sparse", pd.Series([0, 2**53 + 3, 0, 0, 1, 0], dtype=object).astype(pd.SparseDtype("uint64", 0)).array
    )
    frame.insert(2, "tie", np.array([1, 0, 0, 0, 1, 1], dtype=np.int64))
    selected = [2**53 + 3, 2**64 - 1, 0, -1, 2**64]
    model = _value_selection_model("integer", typed_selection_value(selected[0], "integer"))
    model["filters"][0]["valueFilter"].update(
        selectedValues=[typed_selection_value(value, "integer") for value in selected], includeNaN=True
    )
    included = [i for i, value in enumerate(values) if pd.isna(value) or value in selected]
    _assert_pandas_row_query(frame, model, included)
    for ascending in [True, False]:
        for nulls in ["first", "last"]:
            rules = [
                {"column": "value", "direction": "asc" if ascending else "desc", "nulls": nulls},
                {"column": "tie", "direction": "desc", "nulls": "last"},
            ]
            for sort_only in [False, True]:
                query = {"filters": [], "sort": rules} if sort_only else {**model, "sort": rules}
                rows = list(range(len(values))) if sort_only else included
                rows = sorted(rows, key=lambda i: frame["tie"].iloc[i], reverse=True)
                missing_rows = [i for i in rows if pd.isna(values[i])]
                rows = sorted(
                    [i for i in rows if not pd.isna(values[i])], key=lambda i: values[i], reverse=not ascending
                )
                expected = missing_rows + rows if nulls == "first" else rows + missing_rows
                _assert_pandas_row_query(frame, query, expected, sort_only=sort_only)


@pytest.mark.parametrize("storage", ["sparse-duration", "dictionary"])
def test_pandas_combined_sorts_preserve_native_keys_and_empty_results(storage):
    ticks = None
    if storage == "sparse-duration":
        ticks = np.array([0, 1, 2, -(2**63), 3, 0, 2, 1], dtype=np.int64)
        native = ticks.view("timedelta64[2s]")
        keys = pd.arrays.SparseArray(native, dtype=pd.SparseDtype(native.dtype, np.timedelta64(0, "s")))
        expected = [3, 5, 7, 1, 2, 6, 4]
    else:
        import pyarrow as pa

        chunks = [
            pa.DictionaryArray.from_arrays(pa.array([0, 1, 2, None], type=pa.int8()), pa.array(["z", None, "a"])),
            pa.DictionaryArray.from_arrays(pa.array([1, 0, 2, 1], type=pa.int8()), pa.array(["b", "z", None])),
        ]
        keys = pd.arrays.ArrowExtensionArray(pa.chunked_array(chunks))
        expected = [6, 1, 3, 2, 5, 4, 7]
    frame = pd.DataFrame({"key": keys, "tie": [1, 0, 1, 0, 1, 0, 1, 1], "row": range(8)})
    frame.index = pd.MultiIndex.from_tuples([("same", 7)] * len(frame), names=["group", "index"])
    frame.attrs = {"source": "unchanged"}
    model = {
        "filters": [
            {"column": "row", "type": "integer", "predicates": [{"kind": "predicate", "operator": "gt", "value": "0"}]}
        ],
        "sort": [
            {"column": "key", "direction": "asc", "nulls": "first"},
            {"column": "tie", "direction": "desc", "nulls": "last"},
        ],
    }
    for operand, rows in [("0", expected), ("100", [])]:
        model["filters"][0]["predicates"][0]["value"] = operand
        results = _assert_pandas_row_query(frame, model, rows)
        if ticks is not None:
            for result in results:
                array = result["key"].array
                actual_ticks = np.zeros(len(result), dtype=np.int64)
                actual_ticks[array.sp_index.indices] = array.sp_values.view(np.int64)
                np.testing.assert_array_equal(actual_ticks, ticks[rows])


def _value_selection_model(column_type: str, value: Any) -> dict[str, Any]:
    return {
        "logic": "and",
        "filters": [
            {
                "column": "value",
                "type": column_type,
                "logic": "and",
                "valueFilter": {
                    "kind": "values",
                    "selectedValues": [value],
                    "includeNulls": False,
                    "includeNaN": False,
                },
                "predicates": [],
            }
        ],
        "sort": [],
    }


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
@pytest.mark.parametrize(("selected", "expected"), [("inf", "positive"), ("-inf", "negative")])
def test_legacy_infinity_selection_survives_live_bound_and_generated_filters(backend, selected, expected):
    labels = ["positive", "negative", "finite", "null", "nan"]
    values = [float("inf"), float("-inf"), 1.0, None, float("nan")]
    if backend == "pandas":
        frame = pd.DataFrame({"label": labels, "value": pd.Series(values, dtype="object")})
    elif backend == "polars":
        frame = pl.DataFrame({"label": labels, "value": values})
    else:
        frame = duckdb.sql(
            "SELECT * FROM (VALUES ('positive', 'Infinity'::DOUBLE), ('negative', '-Infinity'::DOUBLE), "
            "('finite', 1.0::DOUBLE), ('null', NULL::DOUBLE), ('nan', 'NaN'::DOUBLE)) AS source(label, value)"
        )
    engine = _engine(backend)
    model = _value_selection_model("float", selected)
    schema = engine.schema(frame)
    lineage = source_lineage(schema)
    public_model = deepcopy(model)
    public_model["filters"][0]["column"] = lineage[1]
    step = bind_step(
        validate_step({"id": "filter", "kind": "filterRows", "params": {"filterModel": public_model}}),
        schema,
        lineage,
    )
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([step]), namespace, namespace)

    results = [
        engine.apply_filter_model(frame, model),
        engine.apply_transform(frame, step),
        namespace["clean_data"](frame),
    ]
    assert [_filtered_labels(result, backend) for result in results] == [[expected], [expected], [expected]]


def _empty_duckdb_contract_frame(column_type: str) -> Any:
    raw_type = {
        "string": "VARCHAR",
        "integer": "HUGEINT",
        "float": "DOUBLE",
        "decimal": "DECIMAL(38, 6)",
        "boolean": "BOOLEAN",
        "date": "DATE",
        "datetime": "TIMESTAMPTZ",
        "duration": "INTERVAL",
    }[column_type]
    return duckdb.sql(f"SELECT NULL::{raw_type} AS value WHERE FALSE")


@pytest.mark.parametrize("case", _VIEW_LITERAL_CONTRACT["accepted"], ids=lambda case: f"{case['type']}:{case['value']}")
def test_duckdb_live_and_generated_filters_accept_shared_literal_contract(case):
    engine = DuckDBEngine()
    frame = _empty_duckdb_contract_frame(case["type"])
    model = _value_selection_model(case["type"], case["value"])

    assert _duckdb_rows(engine.apply_filter_model(frame, model)) == []
    assert _duckdb_rows(_execute_generated_filter(engine, frame, model)) == []


@pytest.mark.parametrize("case", _VIEW_LITERAL_CONTRACT["rejected"], ids=lambda case: f"{case['type']}:{case['value']}")
def test_duckdb_live_and_generated_filters_reject_shared_literal_contract(case):
    engine = DuckDBEngine()
    frame = _empty_duckdb_contract_frame(case["type"])
    model = _value_selection_model(case["type"], case["value"])

    with pytest.raises(EngineError, match=f"Invalid {case['type']} view-filter value"):
        engine.apply_filter_model(frame, model)
    with pytest.raises((TypeError, ValueError, ArithmeticError)):
        _execute_generated_filter(engine, frame, model)


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
@pytest.mark.parametrize(
    ("operator", "expected"),
    [
        ("isNull", ["null"]),
        ("isNotNull", ["nan", "value"]),
        ("isNaN", ["nan"]),
        ("isNotNaN", ["null", "value"]),
    ],
)
def test_live_and_generated_missing_predicates_distinguish_null_from_nan(backend, operator, expected):
    engine = _engine(backend)
    frame = _missing_frame(backend)
    model = {
        "logic": "and",
        "filters": [
            {
                "column": "value",
                "type": "float",
                "logic": "and",
                "predicates": [{"kind": "predicate", "operator": operator}],
            }
        ],
        "sort": [],
    }

    live = engine.apply_filter_model(frame, model)
    generated = _execute_generated_filter(engine, frame, model)

    assert _filtered_labels(live, backend) == expected
    assert _filtered_labels(generated, backend) == expected


@pytest.mark.parametrize(
    "dtype,values,semantic,operation,operand,positions",
    [
        ("int64", [0, 1, 2], "integer", "gte", "1", [1, 2]),
        ("uint64", [0, 1, 2], "integer", "gte", "1", [1, 2]),
        ("bool", [False, True, False], "boolean", "equals", True, [1]),
        ("float64", [0, np.nan, np.inf, -np.inf], "float", "isNaN", None, [1]),
        ("float64", [0, np.nan, np.inf, -np.inf], "float", "isNull", None, []),
        ("float64", [0, np.nan, np.inf, -np.inf], "float", "gte", "0", [0, 2]),
        ("datetime64[us]", [0, None, 1], "datetime", "isNull", None, [1]),
        ("timedelta64[ns]", [0, None, 1], "duration", "isNull", None, [1]),
    ],
)
def test_pandas_native_masks_preserve_view_bound_and_generated_rows(
    dtype, values, semantic, operation, operand, positions
):
    engine = PandasEngine()
    source = pd.DataFrame({"value": np.array(values, dtype=dtype)})
    source.index = pd.Index([4, 4, 2, 1][: len(source)], name="source")
    source.attrs["origin"] = "retained"
    index = source.index
    before = source.copy(deep=True)
    predicate = {"kind": "predicate", "operator": operation}
    if operand is not None:
        predicate["value"] = operand
    model = {"filters": [{"column": "value", "type": semantic, "predicates": [predicate]}], "sort": []}
    bound_model = deepcopy(model)
    bound_model["filters"][0]["column"] = {"id": "c:source:0", "name": "value", "position": 0}
    bound = {"id": "filter", "kind": "filterRows", "params": {"filterModel": bound_model}}
    for frame in [source, source.iloc[:0]]:
        expected = frame.iloc[positions] if len(frame) else frame
        caller_names = {"type": frame, "len": frame} if operation in {"isNull", "isNaN"} else {}
        namespace = dict(caller_names)
        for result in (
            engine.apply_filter_model(frame, model),
            engine.apply_transform(frame, bound),
            _execute_generated_filter(engine, frame, model, namespace=namespace),
        ):
            pd.testing.assert_frame_equal(result, expected)
            assert result.attrs == expected.attrs
        for name, value in caller_names.items():
            assert namespace[name] is value
    pd.testing.assert_frame_equal(source, before)
    assert source.index is index


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
@pytest.mark.parametrize(
    ("include_nulls", "include_nan", "expected"),
    [
        (True, False, ["null"]),
        (False, True, ["nan"]),
        (True, True, ["null", "nan"]),
    ],
)
def test_live_and_generated_value_filters_keep_null_and_nan_independent(
    backend,
    include_nulls,
    include_nan,
    expected,
):
    engine = _engine(backend)
    frame = _missing_frame(backend)
    model = {
        "logic": "and",
        "filters": [
            {
                "column": "value",
                "type": "float",
                "logic": "and",
                "valueFilter": {
                    "kind": "values",
                    "selectedValues": [],
                    "includeNulls": include_nulls,
                    "includeNaN": include_nan,
                },
                "predicates": [],
            }
        ],
        "sort": [],
    }

    live = engine.apply_filter_model(frame, model)
    generated = _execute_generated_filter(engine, frame, model)

    assert _filtered_labels(live, backend) == expected
    assert _filtered_labels(generated, backend) == expected


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
@pytest.mark.parametrize("operator", ["notEquals", "gt"])
def test_ordinary_predicates_exclude_both_null_and_nan(backend, operator):
    engine = _engine(backend)
    frame = _missing_frame(backend)
    model = {
        "logic": "and",
        "filters": [
            {
                "column": "value",
                "type": "float",
                "logic": "and",
                "predicates": [{"kind": "predicate", "operator": operator, "value": 0}],
            }
        ],
        "sort": [],
    }

    assert _filtered_labels(engine.apply_filter_model(frame, model), backend) == ["value"]
    assert _filtered_labels(_execute_generated_filter(engine, frame, model), backend) == ["value"]


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_type_incompatible_predicates_fail_closed_live_and_generated(backend):
    engine = _engine(backend)
    frame = _missing_frame(backend)
    model = {
        "logic": "and",
        "filters": [
            {
                "column": "value",
                "type": "float",
                "logic": "and",
                "predicates": [{"kind": "predicate", "operator": "contains", "value": "1"}],
            }
        ],
        "sort": [],
    }

    with pytest.raises(EngineError, match="predicate 'contains' is unavailable"):
        engine.apply_filter_model(frame, model)
    with pytest.raises(EngineError, match="predicate 'contains' is unavailable"):
        _execute_generated_filter(engine, frame, model)


@pytest.mark.parametrize("backend", ["pandas", "polars", "polars-lazy", "duckdb"])
@pytest.mark.parametrize("active", [True, False], ids=["predicate", "inactive-filter"])
def test_generated_filter_rechecks_declared_type_on_reused_input(backend, active):
    engine = _engine("polars" if backend == "polars-lazy" else backend)
    connection = duckdb.connect() if backend == "duckdb" else None

    def frame_for(dtype, shape="ordinary"):
        values = [40.5, 7.5, None] if dtype == "float" else [40, 7, None]
        labels = ["first", "second", "missing"]
        if shape == "empty":
            values, labels = [], []
        elif shape == "null":
            values, labels = [None], ["missing"]
        if backend == "pandas":
            frame = pd.DataFrame(
                {
                    "amount": pd.array(values, dtype={"integer": "Int32", "wide": "Int64", "float": "Float64"}[dtype]),
                    "label": pd.array(labels, dtype="string"),
                }
            )
            frame.index = pd.Index([4, 4, 1][: len(frame)], name="source_row")
            return frame
        if backend.startswith("polars"):
            frame = pl.DataFrame(
                {
                    "amount": pl.Series(
                        values, dtype={"integer": pl.Int32, "wide": pl.Int64, "float": pl.Float64}[dtype]
                    ),
                    "label": pl.Series(labels, dtype=pl.String),
                }
            )
            return frame.lazy() if backend == "polars-lazy" else frame
        native_type = {"integer": "INTEGER", "wide": "BIGINT", "float": "DOUBLE"}[dtype]
        rows = (
            "(40.5, 'first'), (7.5, 'second'), (NULL, 'missing')"
            if dtype == "float"
            else "(40, 'first'), (7, 'second'), (NULL, 'missing')"
        )
        assert connection is not None
        source = connection.sql(
            f"SELECT amount::{native_type} AS amount, label FROM (VALUES {rows}) input(amount,label)"
        )
        return source.limit(0) if shape == "empty" else source.filter("amount IS NULL") if shape == "null" else source

    def snapshot(frame):
        if backend == "pandas":
            return frame.copy(deep=True)
        if backend.startswith("polars"):
            return frame.collect() if isinstance(frame, pl.LazyFrame) else frame.clone()
        return frame.fetchall(), frame.columns, frame.types

    def assert_source(frame, before):
        after = snapshot(frame)
        if backend == "pandas":
            pd.testing.assert_frame_equal(after, before)
        elif backend.startswith("polars"):
            assert isinstance(after, pl.DataFrame)
            assert after.equals(before)
            assert after.schema == before.schema
        else:
            assert after == before

    model = {
        "filters": [
            {
                "column": "amount",
                "type": "integer",
                "predicates": ([{"kind": "predicate", "operator": "gt", "value": 10}] if active else []),
            }
        ],
        "sort": [],
    }
    namespace = {}
    try:
        original = frame_for("integer")
        _execute_generated_filter(engine, original, model, namespace=namespace)
        for shape in ("ordinary", "empty", "null"):
            compatible = frame_for("wide", shape)
            before = snapshot(compatible)
            result = namespace["clean_data"](compatible)
            if backend == "polars-lazy":
                assert isinstance(result, pl.LazyFrame)
                result = result.collect()
            expected = ["first"] if active else ["first", "second", "missing"]
            if shape != "ordinary":
                expected = ["missing"] if shape == "null" and not active else []
            assert _filtered_labels(result, "polars" if backend == "polars-lazy" else backend) == expected
            assert_source(compatible, before)
            if backend == "pandas":
                assert isinstance(result, pd.DataFrame)
                assert result.index.name == "source_row"
                if shape == "ordinary":
                    assert result.index.tolist() == ([4] if active else [4, 4, 1])
            changed = frame_for("float", shape)
            before = snapshot(changed)
            with pytest.raises(EngineError, match="declares"):
                engine.apply_filter_model(changed, model)
            with pytest.raises(ValueError, match="type"):
                namespace["clean_data"](changed)
            assert_source(changed, before)
    finally:
        engine.close()
        if connection is not None:
            connection.close()


@pytest.mark.parametrize("missing", ["amount", "rank"])
def test_generated_duckdb_filter_refuses_missing_reused_input_columns(missing):
    engine = DuckDBEngine()
    try:
        with duckdb.connect() as connection:
            source = connection.sql(
                "SELECT * FROM (VALUES (20,1,'first'), (30,2,'second'), (0,3,'excluded')) input(amount,rank,label)"
            )
            model = {
                "filters": [
                    {
                        "column": "amount",
                        "type": "integer",
                        "predicates": [{"kind": "predicate", "operator": "gt", "value": 10}],
                    }
                ],
                "sort": [{"column": "rank", "direction": "desc", "nulls": "last"}],
            }
            namespace = {}
            result = _execute_generated_filter(engine, source, model, namespace=namespace)
            assert result.fetchall() == [(30, 2, "second"), (20, 1, "first")]
            changed = source.project(",".join(f'"{name}"' for name in source.columns if name != missing))
            before = changed.fetchall()
            with pytest.raises(ValueError, match="column"):
                namespace["clean_data"](changed)
            assert changed.fetchall() == before
            assert source.fetchall() == [(20, 1, "first"), (30, 2, "second"), (0, 3, "excluded")]
    finally:
        engine.close()


@pytest.mark.parametrize("backend", ["polars", "polars-lazy", "duckdb"])
def test_generated_filter_rechecks_current_sort_comparability(backend):
    engine = _engine("polars" if backend == "polars-lazy" else backend)
    connection = duckdb.connect() if backend == "duckdb" else None
    try:
        if connection is not None:
            source = connection.sql("SELECT * FROM (VALUES (2,'first'), (1,'second')) input(value,label)")
            changed = connection.sql("SELECT * FROM (VALUES ([2],'first'), ([1],'second')) input(value,label)")
            comparable = source.project("CAST(value AS DOUBLE) + 0.5 AS value, label")
        else:
            source = pl.DataFrame({"value": [2, 1], "label": ["first", "second"]})
            changed = pl.DataFrame({"value": [[2], [1]], "label": ["first", "second"]})
            comparable = source.with_columns((pl.col("value").cast(pl.Float64) + 0.5).alias("value"))
            if backend == "polars-lazy":
                source, changed, comparable = source.lazy(), changed.lazy(), comparable.lazy()
        model = {"filters": [], "sort": [{"column": "value", "direction": "asc", "nulls": "last"}]}
        namespace = {}
        result = _execute_generated_filter(engine, source, model, namespace=namespace)
        if isinstance(result, pl.LazyFrame):
            result = result.collect()
        assert _filtered_labels(result, "polars" if backend == "polars-lazy" else backend) == ["second", "first"]
        for result in [engine.apply_filter_model(comparable, model), namespace["clean_data"](comparable)]:
            if isinstance(result, pl.LazyFrame):
                result = result.collect()
            assert engine.schema(result)[0]["type"] == "float"
            assert _filtered_labels(result, "polars" if backend == "polars-lazy" else backend) == ["second", "first"]
        preserved = comparable.collect() if isinstance(comparable, pl.LazyFrame) else comparable
        assert _filtered_labels(preserved, "polars" if backend == "polars-lazy" else backend) == ["first", "second"]
        with pytest.raises(EngineError, match="sorting is unavailable"):
            engine.apply_filter_model(changed, model)
        with pytest.raises(ValueError, match="sort"):
            namespace["clean_data"](changed)
        preserved = changed.collect() if isinstance(changed, pl.LazyFrame) else changed
        assert _filtered_labels(preserved, "polars" if backend == "polars-lazy" else backend) == ["first", "second"]
    finally:
        engine.close()
        if connection is not None:
            connection.close()


@pytest.mark.parametrize("backend", ["pandas", "polars", "polars-lazy", "duckdb"])
def test_generated_filter_checks_the_input_established_by_an_earlier_cast(backend):
    engine = _engine("polars" if backend == "polars-lazy" else backend)
    connection = duckdb.connect() if backend == "duckdb" else None
    try:
        if backend == "pandas":
            source = pd.DataFrame(
                {"value": pd.array([40, 7, None], dtype="Int64"), "label": ["first", "second", "null"]}
            )
            source.index = pd.Index([4, 4, 1], name="source_row")
            before = source.copy(deep=True)
        elif connection is not None:
            source = connection.sql(
                "SELECT * FROM (VALUES (40,'first'), (7,'second'), (NULL,'null')) input(value,label)"
            )
            before = source.fetchall()
        else:
            source = pl.DataFrame({"value": [40, 7, None], "label": ["first", "second", "null"]})
            before = source.clone()
            if backend == "polars-lazy":
                source = source.lazy()
        schema = engine.schema(source)
        assert schema[0]["type"] == "integer"
        lineage = source_lineage(schema)
        cast_step = bind_step(
            validate_step(
                {"id": "cast-value", "kind": "castColumn", "params": {"column": lineage[0], "dtype": "float"}}
            ),
            schema,
            lineage,
        )
        converted = engine.apply_transform(source, cast_step)
        converted_schema = engine.schema(converted)
        assert converted_schema[0]["type"] == "float"
        filter_step = bind_step(
            validate_step(
                {
                    "id": "filter-value",
                    "kind": "filterRows",
                    "params": {
                        "filterModel": {
                            "filters": [
                                {
                                    "column": lineage[0],
                                    "type": "float",
                                    "predicates": [{"kind": "predicate", "operator": "gt", "value": 10}],
                                }
                            ],
                            "sort": [],
                        }
                    },
                }
            ),
            converted_schema,
            lineage,
        )
        live = engine.apply_transform(converted, filter_step)
        namespace = {}
        exec(engine.compile_plan([cast_step, filter_step]), namespace, namespace)
        generated = namespace["clean_data"](source)
        if backend == "pandas":
            assert isinstance(source, pd.DataFrame) and isinstance(before, pd.DataFrame)
            assert isinstance(generated, pd.DataFrame) and isinstance(live, pd.DataFrame)
            pd.testing.assert_frame_equal(generated, live, check_exact=True)
            pd.testing.assert_frame_equal(source, before, check_exact=True)
            assert generated["value"].tolist() == [40.0]
            assert generated.index.tolist() == [4]
            assert generated.index.name == "source_row"
        elif connection is not None:
            assert generated.fetchall() == engine._terminal_rows(live, "SELECT * FROM ow") == [(40.0, "first")]
            assert isinstance(source, duckdb.DuckDBPyRelation)
            assert source.fetchall() == before
        else:
            if backend == "polars-lazy":
                assert isinstance(live, pl.LazyFrame) and isinstance(generated, pl.LazyFrame)
                live, generated = live.collect(), generated.collect()
            assert isinstance(live, pl.DataFrame) and isinstance(generated, pl.DataFrame)
            assert isinstance(before, pl.DataFrame)
            assert generated.equals(live) and generated.schema == live.schema
            assert generated.get_column("value").to_list() == [40.0]
            preserved = source.collect() if isinstance(source, pl.LazyFrame) else source
            assert isinstance(preserved, pl.DataFrame)
            assert preserved.equals(before) and preserved.schema == before.schema
        assert engine.schema(generated)[0]["type"] == "float"
        assert _filtered_labels(generated, "polars" if backend == "polars-lazy" else backend) == ["first"]
    finally:
        engine.close()
        if connection is not None:
            connection.close()


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_nan_text_selection_requires_the_explicit_nan_option(backend):
    engine = _engine(backend)
    frame = _missing_frame(backend)
    model = {
        "logic": "and",
        "filters": [
            {
                "column": "value",
                "type": "float",
                "logic": "and",
                "valueFilter": {
                    "kind": "values",
                    "selectedValues": ["NaN"],
                    "includeNulls": False,
                    "includeNaN": False,
                },
                "predicates": [],
            }
        ],
        "sort": [],
    }

    with pytest.raises(EngineError, match="explicit includeNaN"):
        engine.apply_filter_model(frame, model)


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
@pytest.mark.parametrize(("search", "expected"), [("MIL", ["Milan"]), ("[", ["[bracket"])])
def test_column_value_search_is_case_insensitive_and_literal(backend, search, expected):
    engine = _engine(backend)
    if backend == "pandas":
        frame = pd.DataFrame({"city": ["Milan", "[bracket", None]})
    elif backend == "polars":
        frame = pl.DataFrame({"city": ["Milan", "[bracket", None]})
    else:
        frame = duckdb.sql("SELECT * FROM (VALUES ('Milan'), ('[bracket'), (NULL)) AS values(city)")

    values, has_more = engine.column_values(frame, "city", search=search)

    assert [item["value"] for item in values] == expected
    assert has_more is False


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
@pytest.mark.parametrize(("search", "expected"), [("i", ["i"]), ("s", ["S"]), ("İ", ["İ"])])
def test_column_value_search_uses_portable_ascii_case_folding(backend, search, expected):
    engine = _engine(backend)
    if backend == "pandas":
        frame = pd.DataFrame({"value": ["İ", "i", "ſ", "S"]})
    elif backend == "polars":
        frame = pl.DataFrame({"value": ["İ", "i", "ſ", "S"]})
    else:
        frame = duckdb.sql("SELECT * FROM (VALUES ('İ'), ('i'), ('ſ'), ('S')) AS values(value)")

    values, has_more = engine.column_values(frame, "value", search=search)

    assert [item["value"] for item in values] == expected
    assert has_more is False


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
@pytest.mark.parametrize(("needle", "expected"), [("i", ["ascii-i"]), ("s", ["ascii-s"])])
def test_live_and_generated_contains_use_portable_ascii_case_folding(backend, needle, expected):
    engine = _engine(backend)
    records = {"label": ["dotted-i", "ascii-i", "long-s", "ascii-s"], "value": ["İ", "I", "ſ", "S"]}
    if backend == "pandas":
        frame = pd.DataFrame(records)
    elif backend == "polars":
        frame = pl.DataFrame(records)
    else:
        frame = duckdb.sql(
            "SELECT * FROM (VALUES ('dotted-i', 'İ'), ('ascii-i', 'I'), "
            "('long-s', 'ſ'), ('ascii-s', 'S')) AS values(label, value)"
        )
    model = {
        "logic": "and",
        "filters": [
            {
                "column": "value",
                "type": "string",
                "logic": "and",
                "predicates": [{"kind": "predicate", "operator": "contains", "value": needle}],
            }
        ],
        "sort": [],
    }

    live = engine.apply_filter_model(frame, model)
    generated = _execute_generated_filter(engine, frame, model)

    assert _filtered_labels(live, backend) == expected
    assert _filtered_labels(generated, backend) == expected


def test_mixed_pandas_object_value_selection_preserves_pandas_equality_groups():
    engine = PandasEngine()
    frame = pd.DataFrame(
        {
            "label": ["integer", "float", "boolean", "decimal", "string"],
            "value": pd.Series([1, 1.0, True, Decimal("1"), "1"], dtype="object"),
        }
    )
    values, has_more = engine.column_values(frame, "value")

    assert has_more is False
    assert [(item["value"], item["count"], item["selectionValue"]["cell"]["kind"]) for item in values] == [
        ("1", 4, "integer"),
        ("1", 1, "string"),
    ]

    for selection, expected in [
        (values[0]["selectionValue"], ["integer", "float", "boolean", "decimal"]),
        (values[1]["selectionValue"], ["string"]),
        ("1", ["string"]),
    ]:
        model = _value_selection_model("string", selection)
        assert _filtered_labels(engine.apply_filter_model(frame, model), "pandas") == expected
        assert _filtered_labels(_execute_generated_filter(engine, frame, model), "pandas") == expected


_MIXED_NUMERIC_QUERIES = {
    "picker": [1],
    "include": [1],
    "exclude": [0, 2],
    "equals": [1],
    "notEquals": [0, 2],
    "gt": [2],
    "gte": [1, 2],
    "lt": [0],
    "lte": [0, 1],
    "between": [1],
}


def _mixed_numeric_query_model(frame, target, query):
    token = {"kind": "typedSelection", "version": 1, "columnType": "float", "cell": normalize_cell(target)}
    if query == "picker":
        values, has_more = PandasEngine().column_values(frame, "value")
        assert has_more is False
        item = next(item for item in values if item["value"] == str(target))
        assert item["selectionValue"] == token
        return _value_selection_model("float", item["selectionValue"])
    if query == "include":
        return _value_selection_model("float", token)
    predicate = {
        "kind": "predicate",
        "operator": "notEquals" if query == "exclude" else query,
        "value": token if query == "exclude" else str(target),
    }
    if query == "between":
        predicate["secondValue"] = str(target + 1)
    return {"filters": [{"column": "value", "type": "float", "predicates": [predicate]}], "sort": []}


@pytest.mark.parametrize("query, expected_rows", _MIXED_NUMERIC_QUERIES.items())
@pytest.mark.parametrize(
    "neighbor, target",
    [
        (float(2**53), 2**53 + 1),
        (np.float16(2**11), 2**11 + 1),
        (np.float32(2**24), 2**24 + 1),
        (np.float64(2**53), 2**53 + 1),
        (np.longdouble(2**64), 2**64 + 1),
        (float(2**64), 2**64 + 1),
        (float(-(2**53) - 4), -(2**53) - 1),
    ],
    ids=[
        "python-float",
        "numpy-float16",
        "numpy-float32",
        "numpy-float64",
        "numpy-longdouble",
        "wide-python-int",
        "negative",
    ],
)
def test_mixed_pandas_numeric_queries_preserve_exact_integer_rows(neighbor, target, query, expected_rows):
    values = np.array([neighbor, target, target + 2, None, float("nan"), pd.NA, Decimal("NaN"), pd.NaT], dtype=object)
    frame = pd.DataFrame({"value": pd.Series(values, copy=False), "row": range(len(values))})
    frame.index = pd.MultiIndex.from_tuples([("duplicate", 7)] * len(frame), names=["group", "index"])
    frame.attrs = {"source": "unchanged"}
    assert PandasEngine().schema(frame)[0]["type"] == "float"
    before_scalars = list(frame["value"].array)
    model = _mixed_numeric_query_model(frame, target, query)

    _assert_pandas_row_query(frame, model, expected_rows)

    assert all(actual is original for actual, original in zip(frame["value"].array, before_scalars, strict=True))


@pytest.mark.parametrize(
    "neighbor", [np.float32(2**90), np.float64(2**120), np.longdouble(2**126)], ids=["float32", "float64", "longdouble"]
)
def test_mixed_pandas_integer_selection_survives_numpy_float_hash_collisions(neighbor):
    target = int(neighbor) + sys.hash_info.modulus
    assert hash(neighbor) == hash(target)
    frame = pd.DataFrame(
        {"value": pd.Series([neighbor, target, 0.5, None, float("nan")], dtype=object), "row": range(5)}
    )
    frame.index = pd.Index([f"row-{index}" for index in range(len(frame))], name="source_row")
    exact = {"kind": "typedSelection", "version": 1, "columnType": "float", "cell": normalize_cell(target)}
    model = _value_selection_model("float", exact)
    _assert_pandas_row_query(frame, model, [1])
    model["filters"][0]["valueFilter"].update(
        selectedValues=[exact, typed_selection_value(0.5, "float")], includeNulls=True, includeNaN=True
    )
    _assert_pandas_row_query(frame, model, [1, 2, 3, 4])


@pytest.mark.parametrize("query, expected_rows", [("include", [1]), ("exclude", [0, 2])])
def test_heterogeneous_pandas_integer_tokens_keep_exact_comparison_groups(query, expected_rows):
    target = 2**120 + sys.hash_info.modulus
    frame = pd.DataFrame(
        {"value": pd.Series([np.float64(2**120), target, "other", None, Decimal("NaN")], dtype=object), "row": range(5)}
    )
    frame.index = pd.Index([f"row-{index}" for index in range(len(frame))], name="source_row")
    assert PandasEngine().schema(frame)[0]["type"] == "string"
    token = typed_selection_value(target, "string")
    model = (
        _value_selection_model("string", token)
        if query == "include"
        else {
            "filters": [
                {
                    "column": "value",
                    "type": "string",
                    "predicates": [{"kind": "predicate", "operator": "notEquals", "value": token}],
                }
            ],
            "sort": [],
        }
    )
    _assert_pandas_row_query(frame, model, expected_rows)
    _assert_pandas_row_query(frame, _value_selection_model("string", str(target)), [])


@pytest.mark.parametrize(
    "resident", [[], {}, [1], {"a": 1}, np.array([1])], ids=["empty-list", "empty-dict", "list", "dict", "array"]
)
def test_heterogeneous_pandas_integer_selection_preserves_unhashable_residents(resident):
    target = 2**120 + sys.hash_info.modulus
    frame = pd.DataFrame(
        {"value": pd.Series([np.float64(2**120), target, resident, "word", None], dtype=object), "row": range(5)}
    )
    frame.index = pd.Index([f"row-{index}" for index in range(len(frame))], name="source_row")
    resident_before = deepcopy(resident)
    model = _value_selection_model("string", typed_selection_value(target, "string"))
    _assert_pandas_row_query(frame, model, [1])
    assert frame["value"].iloc[2] is resident
    if isinstance(resident, np.ndarray):
        np.testing.assert_array_equal(resident, resident_before)
    else:
        assert resident == resident_before


@pytest.mark.parametrize(
    "neighbor",
    [float(2**120), np.float32(2**90), np.float64(2**120), np.longdouble(2**126)],
    ids=["python-float", "float32", "float64", "longdouble"],
)
def test_mixed_pandas_numeric_picker_keeps_distinct_hash_colliding_values(neighbor):
    target = int(neighbor) + sys.hash_info.modulus
    frame = pd.DataFrame({"value": pd.Series([neighbor, target, 0.5], dtype=object), "row": range(3)})
    frame.index = pd.Index(["neighbor", "exact", "fraction"], name="source_row")
    before = frame.copy(deep=True)
    values, has_more = PandasEngine().column_values(frame, "value")
    assert has_more is False
    assert len(values) == 3
    assert [item["count"] for item in values] == [1, 1, 1]
    exact = next(item for item in values if item["value"] == str(target))
    assert exact["selectionValue"]["cell"] == normalize_cell(target)
    _assert_pandas_row_query(frame, _value_selection_model("float", exact["selectionValue"]), [1])
    pd.testing.assert_frame_equal(frame, before)


@pytest.mark.parametrize(
    "value, expected_rows",
    [
        ("0.5", [0]),
        ("5e-1", [0]),
        ("1e30", [1]),
        ("9007199254740993.0", [2]),
        ("9007199254740993e0", [2]),
        ("-0", [4, 5]),
        ("Infinity", [6]),
        ("-Infinity", [7]),
    ],
)
def test_mixed_pandas_numeric_queries_retain_fractional_exponent_zero_and_infinity_behavior(value, expected_rows):
    frame = pd.DataFrame(
        {
            "value": pd.Series(
                [
                    0.5,
                    1e30,
                    float(2**53),
                    2**53 + 1,
                    -0.0,
                    np.float32(0),
                    float("inf"),
                    np.float64(-float("inf")),
                    None,
                    float("nan"),
                ],
                dtype=object,
            ),
            "row": range(10),
        }
    )
    frame.index = pd.Index([f"row-{index}" for index in range(len(frame))], name="source_row")
    model = {
        "filters": [
            {
                "column": "value",
                "type": "float",
                "predicates": [{"kind": "predicate", "operator": "equals", "value": value}],
            }
        ],
        "sort": [],
    }
    _assert_pandas_row_query(frame, model, expected_rows)


@pytest.mark.parametrize("value", [2**24 + 1, 2**53 + 1, 2**100])
def test_float_integer_tokens_require_the_exact_object_numeric_owner(value):
    token = {"kind": "typedSelection", "version": 1, "columnType": "float", "cell": normalize_cell(value)}
    assert typed_selection_value(value, "float") == token
    namespace = {"Decimal": Decimal, "date": date, "datetime": datetime, "timedelta": timedelta}
    exec("\n".join(generated_view_value_helper_lines()), namespace, namespace)
    with pytest.raises(EngineError, match="exact object-numeric"):
        coerce_typed_view_value(token, "float")
    with pytest.raises(ValueError, match="exact object-numeric"):
        namespace["_open_wrangler_view_value"](token, "float")
    assert coerce_typed_view_value(token, "float", preserve_float_integers=True) == value
    assert namespace["_open_wrangler_view_value"](token, "float", preserve_float_integers=True) == value
    frame = pd.DataFrame({"value": pd.Series([float(value), None], dtype="float64"), "row": [0, 1]})
    model = _value_selection_model("float", token)
    with pytest.raises(EngineError, match="exact object-numeric"):
        PandasEngine().apply_filter_model(frame, model)
    with pytest.raises(ValueError, match="exact object-numeric"):
        _execute_generated_filter(PandasEngine(), frame, model)


@pytest.mark.parametrize("column_type", ["integer", "string", "float"])
@pytest.mark.parametrize("value", [-(2**53), 2**53, 2**53 + 1])
def test_typed_integer_raw_numbers_require_safe_json_range(column_type, value):
    token = {"kind": "typedSelection", "version": 1, "columnType": column_type, "cell": normalize_cell(value)}
    namespace = {"Decimal": Decimal, "date": date, "datetime": datetime, "timedelta": timedelta}
    exec("\n".join(generated_view_value_helper_lines()), namespace, namespace)
    assert isinstance(token["cell"]["raw"], str)
    assert coerce_typed_view_value(token, column_type, preserve_float_integers=True) == value
    assert namespace["_open_wrangler_view_value"](token, column_type, preserve_float_integers=True) == value
    malformed = {**token, "cell": {**token["cell"], "raw": value}}
    with pytest.raises(EngineError, match="safe JSON integers"):
        coerce_typed_view_value(malformed, column_type, preserve_float_integers=True)
    with pytest.raises(ValueError, match="safe JSON integers"):
        namespace["_open_wrangler_view_value"](malformed, column_type, preserve_float_integers=True)


@pytest.mark.parametrize("raw", [1, 1.0, -0.0, 2**53 - 1, -(2**53 - 1)])
def test_typed_integer_safe_numeric_encodings_match_the_shared_boundary(raw):
    token = {
        "kind": "typedSelection",
        "version": 1,
        "columnType": "float",
        "cell": {**normalize_cell(int(raw)), "raw": raw},
    }
    namespace = {"Decimal": Decimal, "date": date, "datetime": datetime, "timedelta": timedelta}
    exec("\n".join(generated_view_value_helper_lines()), namespace, namespace)
    assert coerce_typed_view_value(token, "float", preserve_float_integers=True) == int(raw)
    assert namespace["_open_wrangler_view_value"](token, "float", preserve_float_integers=True) == int(raw)


def test_exact_object_numeric_opt_in_retains_typed_shape_and_literal_limits():
    token = {"kind": "typedSelection", "version": 1, "columnType": "float", "cell": normalize_cell(2**53 + 1)}
    namespace = {"Decimal": Decimal, "date": date, "datetime": datetime, "timedelta": timedelta}
    exec("\n".join(generated_view_value_helper_lines()), namespace, namespace)
    for value in [
        {**token, "cell": {**token["cell"], "raw": "9" * 65537}},
        {**token, "cell": {**token["cell"], "display": "9" * 65537}},
        {**token, "cell": {**token["cell"], "raw": "1e3"}},
        {**token, "cell": {**token["cell"], "raw": 1.5}},
        {**token, "cell": {**token["cell"], "raw": True}},
        {**token, "cell": {**token["cell"], "raw": float("nan")}},
        {**token, "cell": {**token["cell"], "isNaN": True}},
        {**token, "unexpected": True},
        "NaN",
        "1e9999",
        "0x20000000000001",
        True,
    ]:
        with pytest.raises(EngineError):
            coerce_typed_view_value(value, "float", preserve_float_integers=True)
        with pytest.raises((ValueError, TypeError, ArithmeticError)):
            namespace["_open_wrangler_view_value"](value, "float", preserve_float_integers=True)


@pytest.mark.parametrize("kind", ["groupBy", "pivotWider"])
@pytest.mark.parametrize("fill", [1.0, -0.0])
def test_sparse_group_outputs_keep_exact_numeric_queries_in_sessions_and_generated_code(monkeypatch, kind, fill):
    target = 2**53 + 1
    source = pd.DataFrame(
        {
            "value": pd.Series(
                np.array([fill, target - 1, target, target + 2], dtype=object), dtype=pd.SparseDtype("uint64", fill)
            ),
            "amount": pd.Series([5, 10, 20, 30], dtype="Int64"),
            "name": pd.Series(["x"] * 4, dtype="string"),
        }
    )
    before = source.copy(deep=True)
    monkeypatch.setattr("openwrangler_runtime.session.resolve_notebook_variable", lambda _: source)
    engine = PandasEngine()
    manager = SessionManager()
    try:
        opened = manager.open_session(
            {
                "kind": "notebookVariable",
                "label": "mixed-numeric",
                "variableName": "mixed_numeric",
                "uri": "file:///mixed-numeric.ipynb",
            },
            backend="pandas",
            mode="editing",
        )
        session_id = opened["metadata"]["sessionId"]
        refs = {column["name"]: {"id": column["id"], "name": column["name"]} for column in opened["metadata"]["schema"]}
        params = (
            {
                "keys": [refs["value"]],
                "aggregations": [{"column": refs["amount"], "operation": "sum", "alias": "total"}],
            }
            if kind == "groupBy"
            else {
                "namesFrom": refs["name"],
                "valuesFrom": refs["amount"],
                "outputs": [
                    {"key": typed_selection_value("x", "string"), "name": "total"},
                    {"key": typed_selection_value("y", "string"), "name": "absent"},
                ],
            }
        )
        preview = manager.preview_step(session_id, 0, {"id": "group", "kind": kind, "params": params}, 0, 20)
        applied = manager.apply_draft(session_id, preview["revision"], 0, 20)
        frame = engine._visible_frame(manager.sessions[session_id].committed)
        assert applied["metadata"]["schema"][0]["type"] == "float"
        assert frame["value"].tolist() == [fill, target - 1, target, target + 2]
        frame_before = frame.copy(deep=True)
        expected = {
            "picker": [2],
            "include": [2],
            "exclude": [0, 1, 3],
            "equals": [2],
            "notEquals": [0, 1, 3],
            "gt": [3],
            "gte": [2, 3],
            "lt": [0, 1],
            "lte": [0, 1, 2],
            "between": [2],
        }
        for query, positions in expected.items():
            model = _mixed_numeric_query_model(frame, target, query)
            page = manager.get_page(session_id, applied["revision"], 0, 20, model)["page"]
            assert [row["values"][0]["display"] for row in page["rows"]] == [
                str(frame["value"].iloc[position]) for position in positions
            ]
            generated = _execute_generated_filter(engine, frame, model)
            pd.testing.assert_frame_equal(generated, frame.iloc[positions])
            schema = engine.schema(frame)
            lineage = source_lineage(schema)
            public_model = deepcopy(model)
            public_model["filters"][0]["column"] = lineage[0]
            bound = bind_step(
                validate_step({"id": "filter", "kind": "filterRows", "params": {"filterModel": public_model}}),
                schema,
                lineage,
            )
            namespace = {}
            exec(engine.compile_plan([*manager.sessions[session_id].bound_plan, bound]), namespace, namespace)
            pd.testing.assert_frame_equal(namespace["clean_data"](source), frame.iloc[positions])
        pd.testing.assert_frame_equal(frame, frame_before)
    finally:
        manager.close_all()
    pd.testing.assert_frame_equal(source, before)


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_column_value_selection_tokens_round_trip_live_and_generated(backend):
    engine = _engine(backend)
    if backend == "pandas":
        frame = pd.DataFrame({"label": ["match", "other"], "value": [7, 9]})
    elif backend == "polars":
        frame = pl.DataFrame({"label": ["match", "other"], "value": [7, 9]})
    else:
        frame = duckdb.sql("SELECT * FROM (VALUES ('match', 7), ('other', 9)) AS values(label, value)")

    values, has_more = engine.column_values(frame, "value")
    selected = next(item["selectionValue"] for item in values if item["value"] == "7")
    model = _value_selection_model("integer", selected)

    assert has_more is False
    assert selected == typed_selection_value(7, "integer")
    assert _filtered_labels(engine.apply_filter_model(frame, model), backend) == ["match"]
    assert _filtered_labels(_execute_generated_filter(engine, frame, model), backend) == ["match"]


def test_typed_selection_tokens_fail_closed_live_and_generated():
    token = typed_selection_value(7, "integer")
    assert token is not None
    namespace = {"Decimal": Decimal, "date": date, "datetime": datetime, "timedelta": timedelta}
    exec("\n".join(generated_view_value_helper_lines()), namespace, namespace)
    invalid = [
        {**token, "columnType": "string"},
        {**token, "unexpected": True},
        {**token, "cell": {**token["cell"], "isNull": True}},
        {**token, "cell": {**token["cell"], "kind": "string"}},
    ]

    for value in invalid:
        with pytest.raises(EngineError):
            coerce_typed_view_value(value, "integer")
        with pytest.raises((TypeError, ValueError, ArithmeticError)):
            namespace["_open_wrangler_view_value"](value, "integer")


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_live_and_generated_value_selection_uses_exact_decimal_identity(backend):
    engine = PandasEngine() if backend == "pandas" else PolarsEngine()
    records = {"label": ["first", "equivalent", "other"], "value": [Decimal("1.0"), Decimal("1.00"), Decimal("2")]}
    frame = pd.DataFrame(records) if backend == "pandas" else pl.DataFrame(records)
    model = {
        "logic": "and",
        "filters": [
            {
                "column": "value",
                "type": "decimal",
                "logic": "and",
                "valueFilter": {
                    "kind": "values",
                    "selectedValues": ["1.0"],
                    "includeNulls": False,
                    "includeNaN": False,
                },
                "predicates": [],
            }
        ],
        "sort": [],
    }

    assert _filtered_labels(engine.apply_filter_model(frame, model), backend) == ["first", "equivalent"]
    assert _filtered_labels(_execute_generated_filter(engine, frame, model), backend) == ["first", "equivalent"]


@pytest.mark.parametrize("lazy", [False, True])
@pytest.mark.parametrize("scale", [0, 2])
def test_polars_decimal_filters_keep_exact_thresholds_and_source_capacity(lazy, scale):
    maximum = Decimal("9" * (38 - scale) + ("." + "9" * scale if scale else ""))
    source = pl.DataFrame(
        {
            "label": ["minimum", "negative", "zero", "one", "maximum", "null"],
            "value": pl.Series(
                [maximum.copy_negate(), Decimal(-1), Decimal(0), Decimal(1), maximum, None],
                dtype=pl.Decimal(38, scale),
            ),
        }
    )
    before = source.clone()
    frame = source.lazy() if lazy else source
    engine = PolarsEngine()
    predicates = [
        ("equals", {"value": "1.001"}, []),
        ("notEquals", {"value": "1.001"}, ["minimum", "negative", "zero", "one", "maximum"]),
        ("gt", {"value": "1.001"}, ["maximum"]),
        ("gte", {"value": "1.001"}, ["maximum"]),
        ("lt", {"value": "1.001"}, ["minimum", "negative", "zero", "one"]),
        ("lte", {"value": "1.001"}, ["minimum", "negative", "zero", "one"]),
        ("between", {"value": "-1.001", "secondValue": "1.001"}, ["negative", "zero", "one"]),
        ("lt", {"value": "1e1000000000"}, ["minimum", "negative", "zero", "one", "maximum"]),
        ("gt", {"value": "-1e1000000000"}, ["minimum", "negative", "zero", "one", "maximum"]),
        ("equals", {"value": "1e-1000000000"}, []),
        ("lt", {"value": "1e-1000000000"}, ["minimum", "negative", "zero"]),
    ]
    cases = []
    for operation, values, expected in predicates:
        model = {
            "filters": [
                {
                    "column": "value",
                    "type": "decimal",
                    "predicates": [{"kind": "predicate", "operator": operation, **values}],
                }
            ],
            "sort": [],
        }
        cases.append((model, expected))
    for selected, expected in [(["1.001"], []), (["1.001", "1." + "0" * 100, "1e1000000000"], ["one"])]:
        model = _value_selection_model("decimal", selected[0])
        model["filters"][0]["valueFilter"]["selectedValues"] = selected
        cases.append((model, expected))
    null_alternative = deepcopy(cases[0][0])
    null_alternative["filters"][0]["logic"] = "or"
    null_alternative["filters"][0]["predicates"].append({"kind": "predicate", "operator": "isNull"})
    cases.append((null_alternative, ["null"]))
    with localcontext() as context:
        context.prec = 2
        context.clear_flags()
        for model, labels in cases:
            expected = source.filter(pl.col("label").is_in(labels))
            for result in [engine.apply_filter_model(frame, model), _execute_generated_filter(engine, frame, model)]:
                if isinstance(result, pl.LazyFrame):
                    result = result.collect()
                assert result.schema == source.schema
                assert result.equals(expected)
        assert not any(context.flags.values())
    for subset in [source.head(0), source.tail(1)]:
        frame = subset.lazy() if lazy else subset
        for result in [
            engine.apply_filter_model(frame, cases[0][0]),
            _execute_generated_filter(engine, frame, cases[0][0]),
        ]:
            if isinstance(result, pl.LazyFrame):
                result = result.collect()
            assert result.height == 0
            assert result.schema == source.schema
    assert source.equals(before)


@pytest.mark.parametrize("lazy", [False, True])
def test_polars_enum_filters_match_absent_labels_without_changing_domain_order(lazy, recwarn):
    source = pl.DataFrame(
        {
            "label": ["a-row", "b-row", "null"],
            "value": pl.Series(["a", "b", None], dtype=pl.Enum(["b", "a"])),
        }
    )
    before = source.clone()
    frame = source.lazy() if lazy else source
    engine = PolarsEngine()
    schema = engine.schema(frame)
    lineage = source_lineage(schema)
    cases = []
    for predicate_operator, value, labels in [
        ("equals", "absent", []),
        ("notEquals", "absent", ["a-row", "b-row"]),
        ("equals", "a", ["a-row"]),
        ("notEquals", "a", ["b-row"]),
        ("equals", typed_selection_value(0, "string"), ["b-row"]),
        ("equals", typed_selection_value(1, "string"), ["a-row"]),
        ("notEquals", typed_selection_value(1, "string"), ["b-row"]),
        ("gt", "b", ["a-row"]),  # Enum order is intentionally not lexical.
    ]:
        cases.append(
            (
                {
                    "filters": [
                        {
                            "column": "value",
                            "type": "string",
                            "predicates": [{"kind": "predicate", "operator": predicate_operator, "value": value}],
                        }
                    ],
                    "sort": [],
                },
                labels,
            )
        )
    cases.append(
        (
            {
                "filters": [
                    {
                        "column": "value",
                        "type": "string",
                        "predicates": [
                            {
                                "kind": "predicate",
                                "operator": "between",
                                "value": typed_selection_value(0, "string"),
                                "secondValue": typed_selection_value(1, "string"),
                            }
                        ],
                    }
                ],
                "sort": [],
            },
            ["a-row", "b-row"],
        )
    )
    for selected, include_nulls, labels in [
        (["absent"], False, []),
        (["absent"], True, ["null"]),
        (["a", "absent"], True, ["a-row", "null"]),
        ([], False, ["a-row", "b-row", "null"]),
        ([0], False, ["b-row"]),
        ([1], False, ["a-row"]),
        ([0, 1], False, ["a-row", "b-row"]),
    ]:
        model = _value_selection_model("string", None)
        model["filters"][0]["valueFilter"].update(
            selectedValues=[typed_selection_value(value, "string") for value in selected],
            includeNulls=include_nulls,
        )
        cases.append((model, labels))
    for model, labels in cases:
        public = deepcopy(model)
        public["filters"][0]["column"] = lineage[1]
        bound = bind_step(
            validate_step({"id": "filter", "kind": "filterRows", "params": {"filterModel": public}}), schema, lineage
        )
        expected = source.filter(pl.col("label").is_in(labels))
        for result in [
            engine.apply_filter_model(frame, model),
            engine.apply_transform(frame, bound),
            _execute_generated_filter(engine, frame, model),
        ]:
            assert isinstance(result, pl.LazyFrame) == lazy
            if lazy:
                result = result.collect()
            assert result.schema == source.schema
            assert result.equals(expected)
        assert source.equals(before)
        assert source.schema == before.schema

    assert not [
        str(warning.message)
        for warning in recwarn
        if isinstance(warning.message, DeprecationWarning) and "to Enum" in str(warning.message)
    ]


@pytest.mark.parametrize("lazy", [False, True])
def test_polars_enum_membership_keeps_empty_domain_and_null_selection_separate(lazy):
    engine = PolarsEngine()
    for labels, values in [([], []), (["null"], [None])]:
        source = pl.DataFrame(
            {"label": pl.Series(labels, dtype=pl.String), "value": pl.Series(values, dtype=pl.Enum([]))}
        )
        before = source.clone()
        frame = source.lazy() if lazy else source
        for include_nulls in (False, True):
            model = _value_selection_model("string", typed_selection_value("absent", "string"))
            model["filters"][0]["valueFilter"]["includeNulls"] = include_nulls
            expected = source if include_nulls else source.head(0)
            for result in [engine.apply_filter_model(frame, model), _execute_generated_filter(engine, frame, model)]:
                assert isinstance(result, pl.LazyFrame) == lazy
                if lazy:
                    result = result.collect()
                assert result.schema == source.schema
                assert result.equals(expected)
            assert source.equals(before)
            assert source.schema == before.schema


@pytest.mark.parametrize("lazy", [False, True])
@pytest.mark.parametrize("storage", ["datetime_ms", "datetime_ns", "duration_ms"])
def test_polars_temporal_filters_keep_exact_native_unit_bounds(lazy, storage):
    duration = storage == "duration_ms"
    unit = "ns" if storage == "datetime_ns" else "ms"
    dtype = pl.Duration(unit) if duration else pl.Datetime(unit, "America/New_York")
    source = pl.DataFrame(
        {
            "label": ["minimum", "negative", "zero", "one", "maximum", "null"],
            "value": pl.Series([-(2**63), -1, 0, 1, 2**63 - 1, None], dtype=pl.Int64).cast(dtype),
        }
    )
    before = source.clone()
    frame = source.lazy() if lazy else source
    engine = PolarsEngine()
    kind = "duration" if duration else "datetime"
    lower = "-0.000001" if duration else "1969-12-31T23:59:59.999999Z"
    upper = "0.000001" if duration else "1970-01-01T00:00:00.000001Z"
    zero = "0" if duration else "1970-01-01T00:00:00Z"
    predicates = [
        ("equals", {"value": upper}, []),
        ("lt", {"value": upper}, ["minimum", "negative", "zero"] + (["one"] if unit == "ns" else [])),
        ("between", {"value": lower, "secondValue": upper}, ["negative", "zero", "one"] if unit == "ns" else ["zero"]),
    ]
    cases = []
    for operation, values, labels in predicates:
        cases.append(
            (
                {
                    "filters": [
                        {
                            "column": "value",
                            "type": kind,
                            "predicates": [{"kind": "predicate", "operator": operation, **values}],
                        }
                    ],
                    "sort": [],
                },
                labels,
            )
        )
    model = _value_selection_model(kind, upper)
    model["filters"][0]["valueFilter"]["selectedValues"].append(zero)
    if storage == "datetime_ns":
        model["filters"][0]["valueFilter"]["selectedValues"].append("2500-01-01T00:00:00Z")
    model["filters"][0]["valueFilter"]["includeNulls"] = True
    cases.append((model, ["zero", "null"]))
    for model, labels in cases:
        expected = source.filter(pl.col("label").is_in(labels))
        for result in [engine.apply_filter_model(frame, model), _execute_generated_filter(engine, frame, model)]:
            if isinstance(result, pl.LazyFrame):
                result = result.collect()
            assert result.schema == source.schema
            assert result.equals(expected)
    assert source.equals(before)


@pytest.mark.parametrize("storage", ["datetime64[s]", "datetime64[ms, UTC]", "timedelta64[ms]"])
def test_pandas_native_temporal_membership_keeps_exact_selected_values(storage):
    duration = storage.startswith("timedelta")
    value = timedelta(0) if duration else datetime(1970, 1, 1, tzinfo=timezone.utc if "UTC" in storage else None)
    source = pd.DataFrame({"label": ["value", "null"], "value": pd.Series([value, None], dtype=storage)})
    source.index = pd.Index(["same", "same"], name="source-row")
    before = source.copy(deep=True)
    engine = PandasEngine()
    kind = "duration" if duration else "datetime"
    suffix = "Z" if "UTC" in storage else ""
    exact = "0" if duration else "1970-01-01T00:00:00" + suffix
    inexact = "0.000001" if duration else "1970-01-01T00:00:00.000001" + suffix
    for selected, include_nulls, positions in [
        ([inexact], False, []),
        ([inexact, exact], False, [0]),
        ([inexact, exact], True, [0, 1]),
    ]:
        model = _value_selection_model(kind, selected[0])
        model["filters"][0]["valueFilter"].update(selectedValues=selected, includeNulls=include_nulls)
        for result in [engine.apply_filter_model(source, model), _execute_generated_filter(engine, source, model)]:
            pd.testing.assert_frame_equal(result, source.iloc[positions])
    if not duration:
        model = _value_selection_model(kind, "1970-01-01T00:00:00Z")
        model["filters"][0]["valueFilter"]["selectedValues"].append("1970-01-01T00:00:00")
        for result in [engine.apply_filter_model(source, model), _execute_generated_filter(engine, source, model)]:
            pd.testing.assert_frame_equal(result, source.iloc[:1])
    pd.testing.assert_frame_equal(source, before)


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_exact_temporal_view_membership_keeps_session_state_after_rejected_input(tmp_path, backend):
    path = tmp_path / "temporal-membership.parquet"
    pl.DataFrame(
        {
            "label": ["value", "null"],
            "value": pl.Series([datetime(1970, 1, 1, tzinfo=timezone.utc), None], dtype=pl.Datetime("ms", "UTC")),
        }
    ).write_parquet(path)
    original_bytes = path.read_bytes()
    manager = SessionManager()
    try:
        opened = manager.open_session({"kind": "file", "label": path.name, "path": str(path)}, backend=backend)
        sid = opened["metadata"]["sessionId"]
        session = manager.sessions[sid]
        original = session.original
        model = _value_selection_model("datetime", "1970-01-01T00:00:00.000001Z")
        page = manager.get_page(sid, 0, 0, 5, model)
        assert page["page"]["totalRows"] == 0
        assert page["metadata"]["filterModel"] == model
        filtered, generation, epoch = session.filtered, session.view_generation, session.view_change_epoch
        cache = list(session.page_cache.items())
        invalid = _value_selection_model("datetime", "not-a-datetime")
        with pytest.raises(EngineError, match="datetime"):
            manager.get_page(sid, 0, 0, 5, invalid)
        assert session.filter_model == model
        assert session.filtered is filtered
        assert session.view_generation == generation
        assert session.view_change_epoch == epoch
        assert list(session.page_cache.items()) == cache
        assert manager.get_page(sid, 0, 0, 5, model)["page"] is page["page"]
        corrected = _value_selection_model("datetime", "1970-01-01T00:00:00Z")
        assert manager.get_page(sid, 0, 0, 5, corrected)["page"]["totalRows"] == 1
        assert session.original is original
        assert session.plan == []
        assert session.draft_step is None
    finally:
        manager.close_all()
    assert path.read_bytes() == original_bytes


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_live_and_generated_predicates_preserve_wide_integers_and_boolean_text(backend):
    engine = PandasEngine() if backend == "pandas" else PolarsEngine()
    wide = 9_007_199_254_740_993
    records = {"label": ["match", "other"], "value": [wide, wide + 1], "flag": [True, False]}
    if backend == "pandas":
        frame = pd.DataFrame(records)
    else:
        frame = pl.DataFrame(records, schema_overrides={"value": pl.Int128})
    model = {
        "logic": "and",
        "filters": [
            {
                "column": "value",
                "type": "integer",
                "logic": "and",
                "predicates": [{"kind": "predicate", "operator": "equals", "value": str(wide)}],
            },
            {
                "column": "flag",
                "type": "boolean",
                "logic": "and",
                "predicates": [{"kind": "predicate", "operator": "equals", "value": " TrUe "}],
            },
        ],
        "sort": [],
    }

    assert _filtered_labels(engine.apply_filter_model(frame, model), backend) == ["match"]
    assert _filtered_labels(_execute_generated_filter(engine, frame, model), backend) == ["match"]


_DATETIME_SELECTION_CASES = [
    ("2024-01-01T12:00:00+02:00", datetime(2024, 1, 1, 10, tzinfo=timezone.utc)),
    ("2024-01-01T10:00:00.1Z", datetime(2024, 1, 1, 10, microsecond=100000, tzinfo=timezone.utc)),
    ("2024-01-01T10:00:00.12Z", datetime(2024, 1, 1, 10, microsecond=120000, tzinfo=timezone.utc)),
    ("2024-01-01T10:00:00.123Z", datetime(2024, 1, 1, 10, microsecond=123000, tzinfo=timezone.utc)),
    ("2024-01-01T10:00:00.1234Z", datetime(2024, 1, 1, 10, microsecond=123400, tzinfo=timezone.utc)),
    ("2024-01-01T10:00:00.12345Z", datetime(2024, 1, 1, 10, microsecond=123450, tzinfo=timezone.utc)),
    ("2024-01-01T10:00:00.123456Z", datetime(2024, 1, 1, 10, microsecond=123456, tzinfo=timezone.utc)),
    ("2024-01-01T12:30:00+0230", datetime(2024, 1, 1, 10, tzinfo=timezone.utc)),
    ("2024-01-01T07:30:00-0230", datetime(2024, 1, 1, 10, tzinfo=timezone.utc)),
    ("2024-01-01 10:00:00.1", datetime(2024, 1, 1, 10, microsecond=100000)),
    ("2024-01-02T09:59:00+23:59", datetime(2024, 1, 1, 10, tzinfo=timezone.utc)),
    ("2023-12-31T10:01:00-2359", datetime(2024, 1, 1, 10, tzinfo=timezone.utc)),
    ("2024-01-01T10:00:00-0000", datetime(2024, 1, 1, 10, tzinfo=timezone.utc)),
]


@pytest.mark.parametrize("backend", ["pandas", "polars"])
@pytest.mark.parametrize("literal, expected", _DATETIME_SELECTION_CASES)
def test_live_and_generated_datetime_selection_matches_equivalent_instants(backend, literal, expected):
    engine = PandasEngine() if backend == "pandas" else PolarsEngine()
    instants = [expected, expected + timedelta(hours=1)]
    records = {"label": ["match", "other"], "value": instants}
    frame = pd.DataFrame(records) if backend == "pandas" else pl.DataFrame(records)
    model = {
        "logic": "and",
        "filters": [
            {
                "column": "value",
                "type": "datetime",
                "logic": "and",
                "valueFilter": {
                    "kind": "values",
                    "selectedValues": [literal],
                    "includeNulls": False,
                    "includeNaN": False,
                },
                "predicates": [],
            }
        ],
        "sort": [],
    }

    assert _filtered_labels(engine.apply_filter_model(frame, model), backend) == ["match"]
    assert _filtered_labels(_execute_generated_filter(engine, frame, model), backend) == ["match"]


@pytest.mark.parametrize("literal, expected", _DATETIME_SELECTION_CASES)
def test_duckdb_live_and_generated_datetime_selection_preserves_offset_instants(literal, expected):
    engine = DuckDBEngine()
    raw_type = "TIMESTAMPTZ" if expected.tzinfo is not None else "TIMESTAMP"
    other = expected + timedelta(hours=1)
    frame = duckdb.sql(
        "SELECT * FROM (VALUES "
        f"('match', {expected.isoformat()!r}::{raw_type}), "
        f"('other', {other.isoformat()!r}::{raw_type})) AS values(label, value)"
    )
    model = _value_selection_model("datetime", literal)

    assert _filtered_labels(engine.apply_filter_model(frame, model), "duckdb") == ["match"]
    assert _filtered_labels(_execute_generated_filter(engine, frame, model), "duckdb") == ["match"]


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
@pytest.mark.parametrize("literal", ["2.123456", "-2.123456", "8640000000.000001"])
def test_duration_filters_preserve_microseconds_under_notebook_decimal_context(backend, literal):
    numerator, denominator = Decimal(literal).as_integer_ratio()
    value = timedelta(microseconds=numerator * 1_000_000 // denominator)
    records = {
        "label": ["match", "neighbor", "match", "null"],
        "value": [value, value + timedelta(microseconds=1), value, None],
    }
    engine = _engine(backend)
    if backend == "pandas":
        frame = pd.DataFrame(records)
    elif backend == "polars":
        frame = pl.DataFrame(records)
    else:
        frame = duckdb.sql(
            "SELECT * FROM (VALUES "
            f"('match', INTERVAL '{literal} seconds'), "
            f"('neighbor', INTERVAL '{literal} seconds' + INTERVAL '1 microsecond'), "
            f"('match', INTERVAL '{literal} seconds'), ('null', NULL)) AS source(label, value)"
        )
    try:
        with localcontext() as context:
            context.prec = 3
            context.clear_flags()
            token = typed_selection_value(value, "duration")
            assert token is not None
            for operand in [literal, token]:
                model = _value_selection_model("duration", operand)
                assert _filtered_labels(engine.apply_filter_model(frame, model), backend) == ["match", "match"]
                assert _filtered_labels(_execute_generated_filter(engine, frame, model), backend) == ["match", "match"]
            assert context.prec == 3 and not any(context.flags.values())
    finally:
        engine.close()


@pytest.mark.parametrize("unit", ["s", "ms", "us", "ns"])
@pytest.mark.parametrize("storage", ["arrow", "dictionary", "numpy-object", "pandas-object"])
def test_pandas_duration_filters_preserve_native_ticks(unit, storage):
    from fractions import Fraction

    import pyarrow as pa

    ticks = [-(2**63), -(2**63) + 1, -1001, -1000, -999, -1, 0, 1, 999, 1000, 1001, 2**63 - 1, -(2**63), None]
    native = None
    if storage in {"arrow", "dictionary"}:
        chunks = [pa.array(ticks[:7], type=pa.duration(unit)), pa.array(ticks[7:], type=pa.duration(unit))]
        if storage == "dictionary":
            chunks = [chunk.dictionary_encode() for chunk in chunks]
        native = pa.chunked_array(chunks)
        series = pd.Series(pd.arrays.ArrowExtensionArray(native))
    else:
        values = [np.timedelta64(value, unit) if value is not None else None for value in ticks]
        if storage == "pandas-object":
            values = [pd.Timedelta(value) if value is not None else None for value in values]
        series = pd.Series(values, dtype=object)
    source = pd.DataFrame({"value": series, "row": range(len(ticks))})
    source.index = pd.Index(["same"] * len(source), name="original")
    source.attrs["origin"] = "retained"
    before = source.copy(deep=True)
    scale = {"s": 1, "ms": 1000, "us": 1_000_000, "ns": 1_000_000_000}[unit]
    seconds = [
        Fraction(value, scale) if value is not None and (native is not None or value != -(2**63)) else None
        for value in ticks
    ]
    cases = []
    for name in ("eq", "ne", "gt", "ge", "lt", "le"):
        predicate = {
            "kind": "predicate",
            "operator": {"eq": "equals", "ne": "notEquals", "ge": "gte", "le": "lte"}.get(name, name),
            "value": "-0.000001",
        }
        expected = [
            i
            for i, value in enumerate(seconds)
            if value is not None and getattr(operator, name)(value, Fraction(-1, 1_000_000))
        ]
        cases.append(({"predicates": [predicate]}, expected))
    for lower, upper in (
        ("-0.000001", "0.000001"),
        ("0.000001", "-0.000001"),
        ("-9223372036854.775808", "86399999999999.999999"),
    ):
        rule = {"predicates": [{"kind": "predicate", "operator": "between", "value": lower, "secondValue": upper}]}
        expected = [
            i for i, value in enumerate(seconds) if value is not None and Fraction(lower) <= value <= Fraction(upper)
        ]
        cases.append((rule, expected))
    selected = ["-9223372036854.775808", "-0.000001", "0", "0.000001"]
    for include_nulls in (False, True):
        rule = {
            "predicates": [],
            "valueFilter": {
                "kind": "values",
                "selectedValues": selected,
                "includeNulls": include_nulls,
                "includeNaN": True,
            },
        }
        expected = [
            i
            for i, value in enumerate(seconds)
            if (value is None and include_nulls) or value in set(map(Fraction, selected))
        ]
        cases.append((rule, expected))
    engine = PandasEngine()
    try:
        for rule, expected_rows in cases:
            model = {"filters": [{"column": "value", "type": "duration", **rule}], "sort": []}
            for result in (engine.apply_filter_model(source, model), _execute_generated_filter(engine, source, model)):
                pd.testing.assert_frame_equal(result, source.iloc[expected_rows], check_exact=True)
                assert result.attrs == source.attrs
        pd.testing.assert_frame_equal(source, before, check_exact=True)
        if native is not None:
            assert cast(pd.arrays.ArrowExtensionArray, source["value"].array).__arrow_array__().equals(native)
        assert source.attrs == before.attrs
    finally:
        engine.close()


@pytest.mark.parametrize("unit", ["s", "ms", "us", "ns", "2s", "3ms", "2us", "3ns"])
@pytest.mark.parametrize("ordered", [False, True])
def test_pandas_categorical_duration_selections_preserve_native_ticks(unit, ordered):
    from fractions import Fraction

    ticks = [2**63 - 1, 1000, 1, 0, -1, -1000, -(2**63) + 1]
    categories = np.asarray(ticks, dtype=np.int64).view(f"timedelta64[{unit}]")
    codes = [0, 1, 2, 3, 4, 5, 6, 0, -1]
    frame = pd.DataFrame(
        {"value": pd.Categorical.from_codes(codes, categories=categories, ordered=ordered), "row": range(len(codes))}
    )
    frame.index = pd.Index(["same"] * len(frame), name="retained")
    frame.attrs = {"origin": "retained"}
    before = frame.copy(deep=True)
    base_unit, multiplier = np.datetime_data(categories.dtype)
    scale = {"s": 1, "ms": 1000, "us": 1_000_000, "ns": 1_000_000_000}[base_unit]
    seconds = [Fraction(ticks[code] * multiplier, scale) if code >= 0 else None for code in codes]
    selections = [
        [],
        [timedelta(0)],
        [timedelta(microseconds=-1), timedelta(microseconds=1)],
        [timedelta(seconds=1), timedelta(milliseconds=1), timedelta(microseconds=1)],
        [timedelta(seconds=2), timedelta(milliseconds=3), timedelta(microseconds=2), timedelta(microseconds=3)],
        [
            timedelta(microseconds=2**63 - 1),
            timedelta(microseconds=-(2**63) + 1),
            timedelta(microseconds=-(2**63)),
        ],
        [timedelta(microseconds=2**63 + 1)],
        [timedelta.min, timedelta.max],
    ]
    engine = PandasEngine()
    try:
        assert frame["value"].cat.categories.dtype == np.dtype(f"timedelta64[{unit}]")
        assert engine.schema(frame)[0]["type"] == "string"
        for selected in selections:
            exact = {
                Fraction((value.days * 86_400 + value.seconds) * 1_000_000 + value.microseconds, 1_000_000)
                for value in selected
            }
            tokens = [typed_selection_value(value, "string") for value in selected]
            assert all(token is not None for token in tokens)
            for include_nulls in (False, True):
                model = {
                    "filters": [
                        {
                            "column": "value",
                            "type": "string",
                            "predicates": [],
                            "valueFilter": {
                                "kind": "values",
                                "selectedValues": tokens,
                                "includeNulls": include_nulls,
                                "includeNaN": True,
                            },
                        }
                    ],
                    "sort": [],
                }
                expected = [i for i, value in enumerate(seconds) if value in exact or value is None and include_nulls]
                for result in (
                    engine.apply_filter_model(frame, model),
                    _execute_generated_filter(engine, frame, model),
                ):
                    pd.testing.assert_frame_equal(result, frame.iloc[expected], check_exact=True)
                    assert result.attrs == frame.attrs
        pd.testing.assert_frame_equal(frame, before, check_exact=True)
        assert frame.attrs == before.attrs
    finally:
        engine.close()


@pytest.mark.parametrize("codes", [[], [-1, -1], [1, -1, 1]], ids=["empty", "missing", "unused-wide"])
def test_pandas_categorical_duration_selections_preserve_missing_and_unused_categories(codes):
    categories = np.asarray([2**63 - 1, 0], dtype=np.int64).view("timedelta64[us]")
    frame = pd.DataFrame({"value": pd.Categorical.from_codes(codes, categories=categories), "row": range(len(codes))})
    frame.index = pd.Index(["same"] * len(frame), name="retained")
    before = frame.copy(deep=True)
    engine = PandasEngine()
    try:
        for value in (timedelta(0), timedelta(microseconds=2**63 - 1)):
            token = typed_selection_value(value, "string")
            assert token is not None
            model = _value_selection_model("string", token)
            for include_nulls in (False, True):
                model["filters"][0]["valueFilter"]["includeNulls"] = include_nulls
                expected = [
                    i
                    for i, code in enumerate(codes)
                    if code == 1 and value == timedelta(0) or code == -1 and include_nulls
                ]
                for result in (
                    engine.apply_filter_model(frame, model),
                    _execute_generated_filter(engine, frame, model),
                ):
                    pd.testing.assert_frame_equal(result, frame.iloc[expected], check_exact=True)
        pd.testing.assert_frame_equal(frame, before, check_exact=True)
    finally:
        engine.close()


@pytest.mark.parametrize(
    "unit,codes",
    [(unit, [0, 1, 2, 3, 4, 5, 6, 0, -1]) for unit in ("s", "ms", "us", "ns")]
    + [("us", []), ("us", [-1, -1]), ("s", [5, -1, 5])],
)
def test_pandas_arrow_categorical_duration_membership_preserves_native_ticks(unit, codes):
    from fractions import Fraction

    import pyarrow as pa

    from openwrangler_runtime.engines import pandas_engine

    ticks = [-(2**63), 2**63 - 1, 86399999913601, 1000, 1, 0, -1]
    dtype = pd.ArrowDtype(pa.duration(unit))
    categories = pd.Index(pd.array(pa.array(ticks, type=dtype.pyarrow_dtype), dtype=dtype))
    series = pd.Series(
        pd.Categorical.from_codes(codes, categories=categories, ordered=True),
        index=pd.Index(["same"] * len(codes), name="retained"),
        name="value",
    )
    before = series.copy(deep=True)
    scale = {"s": 1, "ms": 1000, "us": 1_000_000, "ns": 1_000_000_000}[unit]
    seconds = [Fraction(ticks[code], scale) if code >= 0 else None for code in codes]
    namespace = {"np": np, "pd": pd, "timedelta": timedelta}
    exec("\n".join(pandas_engine._generated_pandas_numeric_filter_helpers()), namespace, namespace)
    for selected in [
        [],
        [timedelta(0)],
        [timedelta(microseconds=-1), timedelta(microseconds=1)],
        [timedelta(seconds=86399999913601)],
        [timedelta(microseconds=-(2**63)), timedelta(microseconds=2**63 - 1)],
        [timedelta(microseconds=-(2**63) - 1), timedelta(microseconds=2**63)],
        [timedelta.min, timedelta.max],
    ]:
        exact = {
            Fraction((value.days * 86_400 + value.seconds) * 1_000_000 + value.microseconds, 1_000_000)
            for value in selected
        }
        expected = pd.Series([value in exact for value in seconds], index=series.index, name=series.name, dtype=bool)
        for helper in (pandas_engine._pandas_numeric_filter, namespace["_open_wrangler_numeric_filter"]):
            pd.testing.assert_series_equal(helper(series, "isin", selected), expected)
    pd.testing.assert_series_equal(series, before, check_exact=True)
    assert series.cat.categories.array.__arrow_array__().cast(pa.int64()).to_pylist() == ticks


@pytest.mark.parametrize("storage", ["numpy", "arrow"])
def test_pandas_categorical_duration_filter_fallbacks_retain_native_semantics(storage):
    import pyarrow as pa

    from openwrangler_runtime.engines import pandas_engine

    class CustomDuration(timedelta):
        pass

    values = (
        np.asarray([0, 1, -(2**63)], dtype=np.int64).view("timedelta64[us]")
        if storage == "numpy"
        else pd.array(pa.array([0, 1, None], type=pa.duration("us")), dtype=pd.ArrowDtype(pa.duration("us")))
    )
    series = pd.Series(pd.Categorical(values))
    before = series.copy(deep=True)
    namespace = {"np": np, "pd": pd, "timedelta": timedelta}
    exec("\n".join(pandas_engine._generated_pandas_numeric_filter_helpers()), namespace, namespace)
    for method, values in [
        ("isin", [timedelta(microseconds=1), "0 days"]),
        ("isin", [CustomDuration(microseconds=1)]),
        ("isin", [pd.Timedelta(1, "us")]),
        ("isin", ["0 days"]),
        ("eq", [timedelta(microseconds=1)]),
    ]:
        expected = series.isin(values) if method == "isin" else series.eq(values[0])
        for helper in (pandas_engine._pandas_numeric_filter, namespace["_open_wrangler_numeric_filter"]):
            pd.testing.assert_series_equal(helper(series, method, values), expected)
    pd.testing.assert_series_equal(series, before)


def test_pandas_categorical_duration_selections_refuse_zero_unit_operands():
    categories = np.asarray([0, 1, 2], dtype=np.int64).view("timedelta64[0s]")
    frame = pd.DataFrame({"value": pd.Categorical.from_codes([0, 1, 2, -1], categories=categories), "row": range(4)})
    frame.index = pd.Index(["same"] * len(frame), name="retained")
    before = frame.copy(deep=True)
    token = typed_selection_value(timedelta(0), "string")
    assert token is not None
    model = _value_selection_model("string", token)
    engine = PandasEngine()
    try:
        for apply in (engine.apply_filter_model, lambda source, rule: _execute_generated_filter(engine, source, rule)):
            with pytest.raises(ValueError, match="zero unit multiplier"):
                apply(frame, model)
        model["filters"][0]["valueFilter"]["selectedValues"] = []
        for include_nulls in (False, True):
            model["filters"][0]["valueFilter"]["includeNulls"] = include_nulls
            positions = [3] if include_nulls else [0, 1, 2, 3]
            for result in (engine.apply_filter_model(frame, model), _execute_generated_filter(engine, frame, model)):
                assert result["row"].tolist() == positions
                assert result["value"].cat.codes.tolist() == [[0, 1, 2, -1][position] for position in positions]
                assert result["value"].cat.categories is frame["value"].cat.categories
                assert result.index.equals(frame.index.take(positions))
        assert frame["value"].cat.codes.tolist() == before["value"].cat.codes.tolist()
        assert frame["value"].cat.categories.dtype == categories.dtype
        assert frame["value"].cat.categories.asi8.tolist() == [0, 1, 2]
        assert frame["row"].tolist() == before["row"].tolist() and frame.index.equals(before.index)
    finally:
        engine.close()
