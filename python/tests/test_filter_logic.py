from __future__ import annotations

import json
import operator
import sys
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

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


def _execute_generated_filter(engine: Any, frame: Any, model: dict[str, Any]) -> Any:
    namespace: dict[str, Any] = {}
    bound_model = deepcopy(model)
    positions = {str(name): position for position, name in enumerate(frame.columns)}
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
    for result in results:
        assert result["row"].tolist() == expected_rows
        assert result.dtypes.tolist() == frame.dtypes.tolist()
        assert result.attrs == frame.attrs
        pd.testing.assert_index_equal(result.columns, frame.columns)
        pd.testing.assert_index_equal(result.index, frame.index.take(expected_rows))
        for position in range(frame.shape[1]):
            expected = frame.iloc[:, position].to_numpy(dtype=object)[expected_rows]
            actual = result.iloc[:, position].to_numpy(dtype=object)
            for value, original in zip(actual, expected, strict=True):
                assert pd.isna(value) if pd.isna(original) else value == original
    pd.testing.assert_frame_equal(frame, before)


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


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_live_and_generated_datetime_selection_matches_equivalent_instants(backend):
    engine = PandasEngine() if backend == "pandas" else PolarsEngine()
    instants = [
        datetime(2024, 1, 1, 10, 0, tzinfo=timezone.utc),
        datetime(2024, 1, 1, 11, 0, tzinfo=timezone.utc),
    ]
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
                    "selectedValues": ["2024-01-01T12:00:00+02:00"],
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


def test_duckdb_live_and_generated_datetime_selection_preserves_offset_instants():
    engine = DuckDBEngine()
    frame = duckdb.sql(
        "SELECT * FROM (VALUES "
        "('match', TIMESTAMPTZ '2024-01-01 10:00:00+00:00'), "
        "('other', TIMESTAMPTZ '2024-01-01 11:00:00+00:00')) AS values(label, value)"
    )
    model = _value_selection_model("datetime", "2024-01-01T12:00:00+02:00")

    assert _filtered_labels(engine.apply_filter_model(frame, model), "duckdb") == ["match"]
    assert _filtered_labels(_execute_generated_filter(engine, frame, model), "duckdb") == ["match"]


def test_duckdb_live_and_generated_duration_selection_retains_distant_microseconds():
    engine = DuckDBEngine()
    frame = duckdb.sql(
        "SELECT * FROM (VALUES "
        "('match', INTERVAL '8640000000.000001 seconds'), "
        "('other', INTERVAL '8640000000.000002 seconds')) AS values(label, value)"
    )
    model = _value_selection_model("duration", "8640000000.000001")

    assert _filtered_labels(engine.apply_filter_model(frame, model), "duckdb") == ["match"]
    assert _filtered_labels(_execute_generated_filter(engine, frame, model), "duckdb") == ["match"]
