from __future__ import annotations

import ast
from datetime import date, datetime, timezone
from decimal import Decimal
from math import isnan
from numbers import Integral
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd
import polars as pl
import pyarrow as pa
import pytest

from openwrangler_runtime.engines import DuckDBEngine, EngineError, PandasEngine, PolarsEngine
from openwrangler_runtime.engines.duckdb_engine import DuckDBSqlPlan
from openwrangler_runtime.session import SessionManager


def bound_ref(identifier: str, name: str, position: int) -> dict[str, str | int]:
    return {"id": identifier, "name": name, "position": position}


def fill_step(
    column: dict[str, str | int],
    replacement: dict[str, Any],
    *,
    step_id: str = "fill",
) -> dict[str, Any]:
    return {
        "id": step_id,
        "kind": "fillMissingValues",
        "params": {"column": column, "replacement": replacement},
    }


@pytest.fixture(params=["pandas", "polars", "duckdb"])
def engine_and_frame(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch):
    if request.param == "pandas":
        engine = PandasEngine()
        frame = pd.DataFrame(
            {
                "value": [1.0, None, float("nan"), 5.0],
                "label": ["a", None, "b", None],
            }
        )
    elif request.param == "polars":
        monkeypatch.setattr(
            pl.DataFrame,
            "to_pandas",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Polars must stay native")),
            raising=False,
        )
        engine = PolarsEngine()
        frame = pl.DataFrame(
            {
                "value": [1.0, None, float("nan"), 5.0],
                "label": ["a", None, "b", None],
            }
        )
    else:
        engine = DuckDBEngine()
        frame = duckdb.sql(
            """
            SELECT * FROM (VALUES
                (1.0::DOUBLE, 'a'::VARCHAR),
                (NULL::DOUBLE, NULL::VARCHAR),
                ('NaN'::DOUBLE, 'b'::VARCHAR),
                (5.0::DOUBLE, NULL::VARCHAR)
            ) AS source("value", "label")
            """
        )

    try:
        yield engine, frame
    finally:
        engine.close()


def rows(frame: Any) -> list[tuple[Any, ...]]:
    if isinstance(frame, pd.DataFrame):
        return list(frame.itertuples(index=False, name=None))
    if isinstance(frame, pl.LazyFrame):
        frame = frame.collect()
    if isinstance(frame, pl.DataFrame):
        return frame.rows()
    if isinstance(frame, DuckDBSqlPlan):
        connection = duckdb.connect(
            config={
                "autoinstall_known_extensions": False,
                "autoload_known_extensions": False,
                "enable_external_file_cache": False,
            }
        )
        try:
            return list(connection.execute(frame.sql).fetchall())
        finally:
            connection.close()
    return list(frame.fetchall())


def normalized_rows(frame: Any) -> list[tuple[Any, ...]]:
    def normalize(value: Any) -> Any:
        if value is None or type(value).__name__ in {"NAType", "NaTType"}:
            return None
        return None if isinstance(value, float) and isnan(value) else value

    return [tuple(normalize(value) for value in row) for row in rows(frame)]


def first_column_type(frame: Any) -> str:
    if isinstance(frame, pd.DataFrame):
        return str(frame.dtypes.iloc[0])
    if isinstance(frame, pl.LazyFrame):
        schema = frame.collect_schema()
        return str(schema[schema.names()[0]])
    if isinstance(frame, pl.DataFrame):
        return str(frame.dtypes[0])
    return str(frame.types[0])


def execute_generated(engine: Any, frame: Any, plan: list[dict[str, Any]]) -> Any:
    namespace: dict[str, Any] = {}
    code = engine.compile_plan(plan)
    assert "openwrangler_runtime" not in code
    exec(compile(code, "<generated-fill-plan>", "exec"), namespace, namespace)
    return namespace["clean_data"](frame)


def float_frame(engine: Any, values: list[float | None]) -> Any:
    if isinstance(engine, PandasEngine):
        return pd.DataFrame({"value": pd.Series(values, dtype="float64")})
    if isinstance(engine, PolarsEngine):
        return pl.DataFrame({"value": pl.Series(values, dtype=pl.Float64)})

    def literal(value: float | None) -> str:
        if value is None:
            return "NULL::DOUBLE"
        if isnan(value):
            return "'NaN'::DOUBLE"
        if value == float("inf"):
            return "'Infinity'::DOUBLE"
        if value == float("-inf"):
            return "'-Infinity'::DOUBLE"
        return f"{value!r}::DOUBLE"

    rows_sql = ", ".join(f"({literal(value)})" for value in values)
    return duckdb.sql(f'SELECT * FROM (VALUES {rows_sql}) AS source("value")')


def schema_column(metadata: dict[str, Any], name: str) -> dict[str, Any]:
    return next(column for column in metadata["schema"] if column["name"] == name)


_DIRECTIONAL_SOURCE = [
    (4, 0, 4, 20.0),
    (0, 0, 0, None),
    (8, 1, 3, 30.0),
    (3, 0, 3, float("nan")),
    (6, 1, 1, None),
    (1, 0, 1, 10.0),
    (9, 1, 4, None),
    (2, 0, 2, None),
    (7, 1, 2, float("nan")),
    (5, 1, 0, None),
]


def directional_frame(engine: Any) -> Any:
    columns = ["row", "priority", "sequence", "value"]
    if isinstance(engine, PandasEngine):
        return pd.DataFrame(_DIRECTIONAL_SOURCE, columns=columns)
    if isinstance(engine, PolarsEngine):
        return pl.DataFrame(_DIRECTIONAL_SOURCE, schema=columns, orient="row")

    def value_sql(value: float | None) -> str:
        if value is None:
            return "NULL::DOUBLE"
        if isnan(value):
            return "'NaN'::DOUBLE"
        return f"{value!r}::DOUBLE"

    values = ", ".join(
        f"({row}::INTEGER, {priority}::INTEGER, {sequence}::INTEGER, {value_sql(value)})"
        for row, priority, sequence, value in _DIRECTIONAL_SOURCE
    )
    return duckdb.sql(f'SELECT * FROM (VALUES {values}) AS source("row", "priority", "sequence", "value")')


def directional_step(direction: str, max_gap: int | None = 2) -> dict[str, Any]:
    replacement: dict[str, Any] = {
        "kind": "directional",
        "direction": direction,
        "orderBy": [
            {
                "column": bound_ref("c:source:1", "priority", 1),
                "direction": "asc",
                "nulls": "last",
            },
            {
                "column": bound_ref("c:source:2", "sequence", 2),
                "direction": "asc",
                "nulls": "last",
            },
        ],
    }
    if max_gap is not None:
        replacement["maxGap"] = max_gap
    return fill_step(bound_ref("c:source:3", "value", 3), replacement, step_id=f"{direction}-fill")


def grouped_step(statistic: str, target_position: int, keys: list[tuple[int, str]]) -> dict[str, Any]:
    return fill_step(
        bound_ref(f"c:source:{target_position}", "value", target_position),
        {
            "kind": "groupedStatistic",
            "statistic": statistic,
            "keys": [bound_ref(f"c:source:{position}", name, position) for position, name in keys],
        },
        step_id=f"grouped-{statistic}",
    )


def grouped_float_frame(engine: Any) -> Any:
    values = [
        ("x", 1.0, 1.0),
        ("x", 1.0, None),
        ("x", 1.0, 3.0),
        ("y", None, float("inf")),
        ("y", float("nan"), float("-inf")),
        ("y", None, None),
        ("z", 2.0, None),
        ("w", 3.0, float("inf")),
        ("w", 3.0, None),
    ]
    if isinstance(engine, PandasEngine):
        return pd.DataFrame(values, columns=["group", "bucket", "value"])
    if isinstance(engine, PolarsEngine):
        return pl.DataFrame(values, schema=["group", "bucket", "value"], orient="row").lazy()
    sql_values = ", ".join(
        "("
        + ", ".join(
            "NULL"
            if value is None
            else "'NaN'::DOUBLE"
            if isinstance(value, float) and isnan(value)
            else "'Infinity'::DOUBLE"
            if value == float("inf")
            else "'-Infinity'::DOUBLE"
            if value == float("-inf")
            else repr(value)
            for value in row
        )
        + ")"
        for row in values
    )
    return duckdb.sql(f'SELECT * FROM (VALUES {sql_values}) AS source("group", "bucket", "value")')


def grouped_string_frame(engine: Any) -> Any:
    values = [
        ("x", "A"),
        ("x", "A"),
        ("x", "a"),
        ("x", None),
        ("y", "C"),
        ("y", "D"),
        ("y", None),
        ("z", None),
    ]
    if isinstance(engine, PandasEngine):
        return pd.DataFrame(values, columns=["group", "value"])
    if isinstance(engine, PolarsEngine):
        return pl.DataFrame(values, schema=["group", "value"], orient="row").lazy()
    sql_values = ", ".join(f"({group!r}, {('NULL' if value is None else repr(value))})" for group, value in values)
    return duckdb.sql(f'SELECT * FROM (VALUES {sql_values}) AS source("group", "value")')


def grouped_exact_median_frame(engine: Any, kind: str, *, exact: bool) -> Any:
    lower = 1 if kind == "integer" else Decimal("1.25")
    upper = (3 if exact else 2) if kind == "integer" else Decimal("1.27" if exact else "1.26")
    # The y group has an inexact median but no missing cell, so it must not
    # make an otherwise valid preview fail.
    untouched_upper = 2 if kind == "integer" else Decimal("1.26")
    values = [("x", lower), ("x", None), ("x", upper), ("y", lower), ("y", untouched_upper)]
    if isinstance(engine, PandasEngine):
        dtype = "Int64" if kind == "integer" else pd.ArrowDtype(pa.decimal128(38, 2))
        return pd.DataFrame(
            {
                "group": [group for group, _value in values],
                "value": pd.Series([value for _group, value in values], dtype=dtype),
            }
        )
    if isinstance(engine, PolarsEngine):
        dtype = pl.Int64 if kind == "integer" else pl.Decimal(38, 2)
        return pl.DataFrame(
            {
                "group": [group for group, _value in values],
                "value": pl.Series([value for _group, value in values], dtype=dtype),
            }
        ).lazy()
    raw_type = "BIGINT" if kind == "integer" else "DECIMAL(38, 2)"
    sql_values = ", ".join(
        f"({group!r}, {('NULL' if value is None else repr(str(value)) if kind == 'decimal' else value)}::{raw_type})"
        for group, value in values
    )
    return duckdb.sql(f'SELECT * FROM (VALUES {sql_values}) AS source("group", "value")')


def test_grouped_mean_uses_exact_multi_keys_and_leaves_undefined_groups_missing(engine_and_frame) -> None:
    engine, _unused = engine_and_frame
    source = grouped_float_frame(engine)
    operation = grouped_step("mean", 2, [(0, "group"), (1, "bucket")])

    live = engine.apply_transform(source, operation)
    generated = execute_generated(engine, source, [operation])

    expected = [
        ("x", 1.0, 1.0),
        ("x", 1.0, 2.0),
        ("x", 1.0, 3.0),
        ("y", None, float("inf")),
        ("y", None, float("-inf")),
        ("y", None, None),
        ("z", 2.0, None),
        ("w", 3.0, float("inf")),
        ("w", 3.0, float("inf")),
    ]
    assert normalized_rows(live) == expected
    assert normalized_rows(generated) == expected
    if isinstance(engine, PolarsEngine):
        assert isinstance(live, pl.LazyFrame)
        assert isinstance(generated, pl.LazyFrame)


def test_grouped_mean_treats_target_nan_and_null_as_the_same_missing_value(engine_and_frame) -> None:
    engine, _unused = engine_and_frame
    values = [
        ("fill", 1.0),
        ("fill", float("nan")),
        ("fill", None),
        ("fill", 3.0),
        ("undefined", float("-inf")),
        ("undefined", float("nan")),
        ("undefined", None),
        ("undefined", float("inf")),
    ]
    if isinstance(engine, PandasEngine):
        source = pd.DataFrame(values, columns=["group", "value"])
    elif isinstance(engine, PolarsEngine):
        source = pl.DataFrame(values, schema=["group", "value"], orient="row").lazy()
    else:
        source = duckdb.sql(
            "SELECT * FROM (VALUES ('fill', 1.0::DOUBLE), ('fill', 'NaN'::DOUBLE), "
            "('fill', NULL::DOUBLE), ('fill', 3.0::DOUBLE), "
            "('undefined', '-Infinity'::DOUBLE), ('undefined', 'NaN'::DOUBLE), "
            "('undefined', NULL::DOUBLE), ('undefined', 'Infinity'::DOUBLE)) "
            'AS source("group", "value")'
        )
    operation = grouped_step("mean", 1, [(0, "group")])

    live = engine.apply_transform(source, operation)
    generated = execute_generated(engine, source, [operation])

    expected = [
        ("fill", 1.0),
        ("fill", 2.0),
        ("fill", 2.0),
        ("fill", 3.0),
        ("undefined", float("-inf")),
        ("undefined", None),
        ("undefined", None),
        ("undefined", float("inf")),
    ]
    assert normalized_rows(live) == expected
    assert normalized_rows(generated) == expected


def test_grouped_most_frequent_is_case_sensitive_and_does_not_break_ties(engine_and_frame) -> None:
    engine, _unused = engine_and_frame
    source = grouped_string_frame(engine)
    operation = grouped_step("mostFrequent", 1, [(0, "group")])

    live = engine.apply_transform(source, operation)
    generated = execute_generated(engine, source, [operation])

    expected = [
        ("x", "A"),
        ("x", "A"),
        ("x", "a"),
        ("x", "A"),
        ("y", "C"),
        ("y", "D"),
        ("y", None),
        ("z", None),
    ]
    assert normalized_rows(live) == expected
    assert normalized_rows(generated) == expected


@pytest.mark.parametrize("target_kind", ["categorical", "boolean"])
def test_grouped_most_frequent_preserves_categorical_and_boolean_types(engine_and_frame, target_kind: str) -> None:
    engine, _unused = engine_and_frame
    raw_values: list[Any] = ["a", "a", "b", None] if target_kind == "categorical" else [True, True, False, None]
    expected_fill = "a" if target_kind == "categorical" else True
    sources: list[Any]
    if isinstance(engine, PandasEngine):
        dtype = "category" if target_kind == "categorical" else "boolean"
        sources = [pd.DataFrame({"group": ["x"] * 4, "value": pd.Series(raw_values, dtype=dtype)})]
    elif isinstance(engine, PolarsEngine):
        dtypes = [pl.Categorical, pl.Enum(["a", "b"])] if target_kind == "categorical" else [pl.Boolean]
        sources = [
            pl.DataFrame({"group": ["x"] * 4, "value": pl.Series(raw_values, dtype=dtype)}).lazy() for dtype in dtypes
        ]
    else:
        raw_type = "ENUM('a', 'b')" if target_kind == "categorical" else "BOOLEAN"
        literals = [
            "NULL" if value is None else repr(value) if isinstance(value, str) else str(value).upper()
            for value in raw_values
        ]
        sources = [
            duckdb.sql(
                "SELECT * FROM (VALUES "
                + ", ".join(f"('x', {literal}::{raw_type})" for literal in literals)
                + ') AS source("group", "value")'
            )
        ]

    operation = grouped_step("mostFrequent", 1, [(0, "group")])
    for source in sources:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])
        assert normalized_rows(live)[-1] == ("x", expected_fill)
        assert normalized_rows(generated)[-1] == ("x", expected_fill)
        if isinstance(engine, PandasEngine):
            if target_kind == "categorical":
                assert isinstance(live.dtypes.iloc[1], pd.CategoricalDtype)
                assert isinstance(generated.dtypes.iloc[1], pd.CategoricalDtype)
            else:
                assert str(live.dtypes.iloc[1]) == "boolean"
                assert str(generated.dtypes.iloc[1]) == "boolean"
        elif isinstance(engine, PolarsEngine):
            assert live.collect_schema()["value"] == source.collect_schema()["value"]
            assert generated.collect_schema()["value"] == source.collect_schema()["value"]
        else:
            assert str(live.types[1]) == str(source.types[1])
            assert str(generated.types[1]) == str(source.types[1])


def test_grouped_float_median_leaves_an_undefined_infinite_midpoint_missing(engine_and_frame) -> None:
    engine, _unused = engine_and_frame
    values = [("x", float("-inf")), ("x", None), ("x", float("inf"))]
    if isinstance(engine, PandasEngine):
        source = pd.DataFrame(values, columns=["group", "value"])
    elif isinstance(engine, PolarsEngine):
        source = pl.DataFrame(values, schema=["group", "value"], orient="row").lazy()
    else:
        source = duckdb.sql(
            "SELECT * FROM (VALUES ('x', '-Infinity'::DOUBLE), ('x', NULL::DOUBLE), "
            "('x', 'Infinity'::DOUBLE)) AS source(\"group\", \"value\")"
        )
    operation = grouped_step("median", 1, [(0, "group")])

    live = engine.apply_transform(source, operation)
    generated = execute_generated(engine, source, [operation])

    assert normalized_rows(live) == [("x", float("-inf")), ("x", None), ("x", float("inf"))]
    assert normalized_rows(generated) == [("x", float("-inf")), ("x", None), ("x", float("inf"))]


def test_grouped_float_median_avoids_opposite_sign_overflow(engine_and_frame) -> None:
    engine, _unused = engine_and_frame
    values = [("x", -1e308), ("x", None), ("x", 1e308)]
    if isinstance(engine, PandasEngine):
        source = pd.DataFrame(values, columns=["group", "value"])
    elif isinstance(engine, PolarsEngine):
        source = pl.DataFrame(values, schema=["group", "value"], orient="row").lazy()
    else:
        source = duckdb.sql(
            "SELECT * FROM (VALUES ('x', -1e308::DOUBLE), ('x', NULL::DOUBLE), "
            '(\'x\', 1e308::DOUBLE)) AS source("group", "value")'
        )
    operation = grouped_step("median", 1, [(0, "group")])

    live = engine.apply_transform(source, operation)
    generated = execute_generated(engine, source, [operation])

    assert normalized_rows(live)[1] == ("x", 0.0)
    assert normalized_rows(generated)[1] == ("x", 0.0)


@pytest.mark.parametrize("kind", ["integer", "decimal"])
def test_grouped_median_preserves_exact_target_type_or_fails_before_filling(engine_and_frame, kind: str) -> None:
    engine, _unused = engine_and_frame
    operation = grouped_step("median", 1, [(0, "group")])
    exact_source = grouped_exact_median_frame(engine, kind, exact=True)
    inexact_source = grouped_exact_median_frame(engine, kind, exact=False)

    live = engine.apply_transform(exact_source, operation)
    generated = execute_generated(engine, exact_source, [operation])
    expected = 2 if kind == "integer" else Decimal("1.26")
    assert normalized_rows(live)[1] == ("x", expected)
    assert normalized_rows(generated)[1] == ("x", expected)

    with pytest.raises((EngineError, ValueError, duckdb.Error), match="fractional|represented exactly|scale"):
        normalized_rows(engine.apply_transform(inexact_source, operation))
    with pytest.raises((EngineError, ValueError, duckdb.Error), match="fractional|represented exactly|scale"):
        normalized_rows(execute_generated(engine, inexact_source, [operation]))


def test_pandas_grouped_mode_distinguishes_boolean_and_integer_object_values() -> None:
    engine = PandasEngine()
    source = pd.DataFrame(
        {
            "group": ["x", "x", "x"],
            "value": pd.Series([1, True, None], dtype=object),
        }
    )
    operation = grouped_step("mostFrequent", 1, [(0, "group")])

    live = engine.apply_transform(source, operation)
    generated = execute_generated(engine, source, [operation])

    assert normalized_rows(live) == [("x", 1), ("x", True), ("x", None)]
    assert normalized_rows(generated) == normalized_rows(live)


def test_pandas_grouped_fill_rejects_unhashable_mixed_object_keys_clearly() -> None:
    engine = PandasEngine()
    source = pd.DataFrame(
        {
            "group": pd.Series(["x", ["x"], "x"], dtype=object),
            "value": [1.0, None, 3.0],
        }
    )
    operation = grouped_step("mean", 1, [(0, "group")])

    with pytest.raises(EngineError, match="scalar Pandas group keys"):
        engine.apply_transform(source, operation)
    with pytest.raises(ValueError, match="scalar Pandas group keys"):
        execute_generated(engine, source, [operation])


def test_pandas_grouped_fill_includes_the_missing_categorical_key_group() -> None:
    engine = PandasEngine()
    source = pd.DataFrame(
        {
            "group": pd.Series(["x", None, None, None], dtype="category"),
            "value": [9.0, 1.0, None, float("nan")],
        }
    )
    operation = grouped_step("mean", 1, [(0, "group")])

    live = engine.apply_transform(source, operation)
    generated = execute_generated(engine, source, [operation])

    expected = [("x", 9.0), (None, 1.0), (None, 1.0), (None, 1.0)]
    assert normalized_rows(live) == expected
    assert normalized_rows(generated) == expected


def test_pandas_grouped_decimal_median_ignores_untouched_high_scale_groups() -> None:
    engine = PandasEngine()
    source = pd.DataFrame(
        {
            "group": ["fill", "fill", "fill", "untouched"],
            "value": pd.Series(
                [Decimal("1.0"), None, Decimal("3.0"), Decimal("1E-100")],
                dtype=object,
            ),
        }
    )
    operation = grouped_step("median", 1, [(0, "group")])

    live = engine.apply_transform(source, operation)
    generated = execute_generated(engine, source, [operation])

    expected = [
        ("fill", Decimal("1.0")),
        ("fill", Decimal("2.0")),
        ("fill", Decimal("3.0")),
        ("untouched", Decimal("1E-100")),
    ]
    assert normalized_rows(live) == expected
    assert normalized_rows(generated) == expected


@pytest.mark.parametrize("object_role", ["key", "target"])
def test_polars_grouped_fill_rejects_object_columns_before_execution(object_role: str) -> None:
    engine = PolarsEngine()
    source = pl.DataFrame(
        {
            "group": pl.Series(["x", "x"], dtype=pl.Object if object_role == "key" else pl.String),
            "value": pl.Series([1.0, None], dtype=pl.Object if object_role == "target" else pl.Float64),
        }
    ).lazy()
    statistic = "mostFrequent" if object_role == "target" else "mean"
    operation = grouped_step(statistic, 1, [(0, "group")])

    with pytest.raises(EngineError, match="Object columns are not supported"):
        engine.apply_transform(source, operation)
    with pytest.raises(ValueError, match="Object columns are not supported"):
        execute_generated(engine, source, [operation])


def test_polars_grouped_exact_median_builds_a_lazy_plan_without_collecting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = PolarsEngine()
    source = grouped_exact_median_frame(engine, "integer", exact=True)
    operation = grouped_step("median", 1, [(0, "group")])

    with monkeypatch.context() as context:
        context.setattr(
            pl.LazyFrame,
            "collect",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("grouped fill collected eagerly")),
        )
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])

    assert isinstance(live, pl.LazyFrame)
    assert isinstance(generated, pl.LazyFrame)
    assert normalized_rows(live)[1] == ("x", 2)
    assert normalized_rows(generated)[1] == ("x", 2)


def test_duckdb_grouped_fill_ignores_nocase_collation_for_public_exact_semantics() -> None:
    engine = DuckDBEngine()
    mode_source = duckdb.sql(
        'SELECT "group", value COLLATE nocase AS value FROM '
        "(VALUES ('x', 'A'), ('x', 'a'), ('x', NULL)) AS source(\"group\", value)"
    )
    key_source = duckdb.sql(
        'SELECT raw_group COLLATE nocase AS "group", value FROM '
        "(VALUES ('A', 1.0), ('A', NULL), ('a', 3.0), ('a', NULL)) AS source(raw_group, value)"
    )
    mode_operation = grouped_step("mostFrequent", 1, [(0, "group")])
    key_operation = grouped_step("median", 1, [(0, "group")])

    try:
        expected_mode = [("x", "A"), ("x", "a"), ("x", None)]
        expected_keys = [("A", Decimal("1.0")), ("A", Decimal("1.0")), ("a", Decimal("3.0")), ("a", Decimal("3.0"))]
        assert normalized_rows(engine.apply_transform(mode_source, mode_operation)) == expected_mode
        assert normalized_rows(execute_generated(engine, mode_source, [mode_operation])) == expected_mode
        assert normalized_rows(engine.apply_transform(key_source, key_operation)) == expected_keys
        assert normalized_rows(execute_generated(engine, key_source, [key_operation])) == expected_keys
    finally:
        engine.close()


def test_duckdb_grouped_exact_median_defers_validation_to_the_single_lazy_query() -> None:
    engine = DuckDBEngine()
    source = grouped_exact_median_frame(engine, "integer", exact=False)
    operation = grouped_step("median", 1, [(0, "group")])

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])
        assert isinstance(live, DuckDBSqlPlan)
        with pytest.raises(duckdb.Error, match="represented exactly"):
            normalized_rows(live)
        with pytest.raises(duckdb.Error, match="represented exactly"):
            normalized_rows(generated)
    finally:
        engine.close()


def test_pandas_grouped_fill_addresses_duplicate_and_non_string_labels_by_position() -> None:
    engine = PandasEngine()
    source = pd.DataFrame(
        [["x", 1, "ignored"], ["x", None, "ignored"], ["x", 3, "ignored"]],
        columns=[0, "value", "value"],
    )
    source.isetitem(1, pd.Series([1, None, 3], dtype="Int64"))
    operation = grouped_step("median", 1, [(0, "0")])

    live = engine.apply_transform(source, operation)
    generated = execute_generated(engine, source, [operation])

    assert list(live.iloc[:, 1]) == [1, 2, 3]
    assert list(generated.iloc[:, 1]) == [1, 2, 3]
    assert list(live.iloc[:, 2]) == ["ignored"] * 3
    assert list(generated.iloc[:, 2]) == ["ignored"] * 3


def test_duckdb_grouped_fill_preserves_case_variant_internal_name_columns() -> None:
    engine = DuckDBEngine()
    source = duckdb.sql(
        "SELECT * FROM (VALUES (10, 'x', 1.0), (20, 'x', NULL), (30, 'x', 3.0)) "
        'AS source("__OW_GROUPED_ORIGINAL", "group", "value")'
    )
    operation = grouped_step("mean", 2, [(1, "group")])

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])

        assert normalized_rows(live) == [(10, "x", 1.0), (20, "x", 2.0), (30, "x", 3.0)]
        assert normalized_rows(generated) == [(10, "x", 1.0), (20, "x", 2.0), (30, "x", 3.0)]
    finally:
        engine.close()


@pytest.mark.parametrize(
    ("direction", "expected_by_row"),
    [
        (
            "forward",
            {0: None, 1: 10.0, 2: 10.0, 3: 10.0, 4: 20.0, 5: None, 6: None, 7: None, 8: 30.0, 9: 30.0},
        ),
        (
            "backward",
            {0: 10.0, 1: 10.0, 2: 20.0, 3: 20.0, 4: 20.0, 5: None, 6: None, 7: None, 8: 30.0, 9: None},
        ),
    ],
)
def test_directional_fill_respects_stable_multi_sort_whole_gap_limit_and_source_order(
    engine_and_frame,
    direction: str,
    expected_by_row: dict[int, float | None],
) -> None:
    engine, _unused = engine_and_frame
    source = directional_frame(engine)
    operation = directional_step(direction, max_gap=2)

    live = engine.apply_transform(source, operation)
    generated = execute_generated(engine, source, [operation])

    expected = [
        (row, priority, sequence, expected_by_row[row]) for row, priority, sequence, _value in _DIRECTIONAL_SOURCE
    ]
    assert normalized_rows(live) == expected
    assert normalized_rows(generated) == expected


def test_directional_fill_without_max_gap_fills_every_anchored_run(engine_and_frame) -> None:
    engine, _unused = engine_and_frame
    source = directional_frame(engine)
    operation = directional_step("forward", max_gap=None)

    live = engine.apply_transform(source, operation)
    generated = execute_generated(engine, source, [operation])

    expected_by_row = {
        0: None,
        1: 10.0,
        2: 10.0,
        3: 10.0,
        4: 20.0,
        5: 20.0,
        6: 20.0,
        7: 20.0,
        8: 30.0,
        9: 30.0,
    }
    expected = [
        (row, priority, sequence, expected_by_row[row]) for row, priority, sequence, _value in _DIRECTIONAL_SOURCE
    ]
    assert normalized_rows(live) == expected
    assert normalized_rows(generated) == expected


def string_tie_frame(engine: Any) -> Any:
    records = [
        (0, 1, "alpha"),
        (1, 1, None),
        (2, 1, "beta"),
        (3, 2, None),
        (4, 2, "omega"),
    ]
    columns = ["row", "order", "value"]
    if isinstance(engine, PandasEngine):
        return pd.DataFrame(records, columns=columns)
    if isinstance(engine, PolarsEngine):
        return pl.DataFrame(records, schema=columns, orient="row")
    return duckdb.sql(
        """
        SELECT * FROM (VALUES
            (0::INTEGER, 1::INTEGER, 'alpha'::VARCHAR),
            (1::INTEGER, 1::INTEGER, NULL::VARCHAR),
            (2::INTEGER, 1::INTEGER, 'beta'::VARCHAR),
            (3::INTEGER, 2::INTEGER, NULL::VARCHAR),
            (4::INTEGER, 2::INTEGER, 'omega'::VARCHAR)
        ) AS source("row", "order", "value")
        """
    )


def test_directional_fill_breaks_identical_order_keys_by_stable_source_order(engine_and_frame) -> None:
    engine, _unused = engine_and_frame
    source = string_tie_frame(engine)
    operation = fill_step(
        bound_ref("c:source:2", "value", 2),
        {
            "kind": "directional",
            "direction": "forward",
            "orderBy": [
                {
                    "column": bound_ref("c:source:1", "order", 1),
                    "direction": "asc",
                    "nulls": "last",
                }
            ],
        },
        step_id="stable-tie-fill",
    )

    live = engine.apply_transform(source, operation)
    generated = execute_generated(engine, source, [operation])

    expected = [
        (0, 1, "alpha"),
        (1, 1, "alpha"),
        (2, 1, "beta"),
        (3, 2, "beta"),
        (4, 2, "omega"),
    ]
    assert normalized_rows(live) == expected
    assert normalized_rows(generated) == expected


def float_missing_order_frame(engine: Any) -> Any:
    if isinstance(engine, PandasEngine):
        return pd.DataFrame(
            {
                "row": [0, 1, 2],
                "order": [None, float("nan"), 1.0],
                "value": ["missing-anchor", None, "finite-anchor"],
            }
        )
    if isinstance(engine, PolarsEngine):
        return pl.DataFrame(
            {
                "row": pl.Series([0, 1, 2], dtype=pl.Int64),
                "order": pl.Series([None, float("nan"), 1.0], dtype=pl.Float64),
                "value": pl.Series(["missing-anchor", None, "finite-anchor"], dtype=pl.String),
            }
        )
    return duckdb.sql(
        """
        SELECT * FROM (VALUES
            (0::INTEGER, NULL::DOUBLE, 'missing-anchor'::VARCHAR),
            (1::INTEGER, 'NaN'::DOUBLE, NULL::VARCHAR),
            (2::INTEGER, 1.0::DOUBLE, 'finite-anchor'::VARCHAR)
        ) AS source("row", "order", "value")
        """
    )


@pytest.mark.parametrize("nulls", ["first", "last"])
def test_directional_float_order_treats_null_and_nan_as_one_stable_missing_group(
    engine_and_frame,
    nulls: str,
) -> None:
    engine, _unused = engine_and_frame
    source = float_missing_order_frame(engine)
    operation = fill_step(
        bound_ref("c:source:2", "value", 2),
        {
            "kind": "directional",
            "direction": "forward",
            "orderBy": [
                {
                    "column": bound_ref("c:source:1", "order", 1),
                    "direction": "asc",
                    "nulls": nulls,
                }
            ],
        },
        step_id=f"float-missing-order-{nulls}",
    )

    live = engine.apply_transform(source, operation)
    generated = execute_generated(engine, source, [operation])

    expected = [
        (0, None, "missing-anchor"),
        (1, None, "missing-anchor"),
        (2, 1.0, "finite-anchor"),
    ]
    assert normalized_rows(live) == expected
    assert normalized_rows(generated) == expected


def test_polars_directional_fill_stays_lazy_until_the_result_is_collected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        pl.DataFrame,
        "to_pandas",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Polars must stay native")),
        raising=False,
    )
    engine = PolarsEngine()
    source = pl.DataFrame({"order": [2, 1, 3], "value": [None, "seed", None]}).lazy()
    operation = fill_step(
        bound_ref("c:source:1", "value", 1),
        {
            "kind": "directional",
            "direction": "forward",
            "orderBy": [
                {
                    "column": bound_ref("c:source:0", "order", 0),
                    "direction": "asc",
                    "nulls": "last",
                }
            ],
        },
        step_id="lazy-directional-fill",
    )

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])

        assert isinstance(live, pl.LazyFrame)
        assert isinstance(generated, pl.LazyFrame)
        assert rows(live) == [(2, "seed"), (1, "seed"), (3, "seed")]
        assert rows(generated) == rows(live)
    finally:
        engine.close()


def test_pandas_directional_fill_uses_exact_duplicate_label_positions_in_live_and_generated_code() -> None:
    engine = PandasEngine()
    source = pd.DataFrame(
        [
            [9, 2, "decoy-0", None],
            [8, 1, "decoy-1", "seed"],
            [7, 3, "decoy-2", None],
            [6, 4, "decoy-3", "end"],
        ],
        columns=["order", "order", "value", "value"],
    )
    operation = fill_step(
        bound_ref("c:source:3", "value", 3),
        {
            "kind": "directional",
            "direction": "forward",
            "orderBy": [
                {
                    "column": bound_ref("c:source:1", "order", 1),
                    "direction": "asc",
                    "nulls": "last",
                }
            ],
        },
        step_id="duplicate-position-directional-fill",
    )

    live = engine.apply_transform(source, operation)
    generated = execute_generated(engine, source, [operation])

    expected = [
        (9, 2, "decoy-0", "seed"),
        (8, 1, "decoy-1", "seed"),
        (7, 3, "decoy-2", "seed"),
        (6, 4, "decoy-3", "end"),
    ]
    assert list(live.columns) == ["order", "order", "value", "value"]
    assert normalized_rows(live) == expected
    assert normalized_rows(generated) == expected


def test_duckdb_directional_fill_preserves_case_variant_internal_name_columns() -> None:
    engine = DuckDBEngine()
    source = duckdb.sql(
        """
        SELECT * FROM (VALUES
            (101::INTEGER, 1::INTEGER, 'seed'::VARCHAR),
            (102::INTEGER, 2::INTEGER, NULL::VARCHAR),
            (103::INTEGER, 3::INTEGER, NULL::VARCHAR)
        ) AS source("__OW_DIRECTIONAL_ORIGINAL", "order", "value")
        """
    )
    operation = fill_step(
        bound_ref("c:source:2", "value", 2),
        {
            "kind": "directional",
            "direction": "forward",
            "orderBy": [
                {
                    "column": bound_ref("c:source:1", "order", 1),
                    "direction": "asc",
                    "nulls": "last",
                }
            ],
        },
        step_id="duckdb-casefolded-temporary-fill",
    )

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])

        expected = [(101, 1, "seed"), (102, 2, "seed"), (103, 3, "seed")]
        assert list(live.columns) == ["__OW_DIRECTIONAL_ORIGINAL", "order", "value"]
        assert normalized_rows(live) == expected
        assert normalized_rows(generated) == expected
    finally:
        engine.close()


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_session_directional_fill_keeps_nullable_metadata(
    backend: str,
    tmp_path: Path,
) -> None:
    path = tmp_path / f"directional-nullability-{backend}.csv"
    path.write_text("order,target\n1,\n2,present\n3,\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend=backend,
        page_size=10,
    )
    session_id = opened["metadata"]["sessionId"]
    operation = {
        "id": "directional-fill",
        "kind": "fillMissingValues",
        "params": {
            "column": {"id": "c:source:1", "name": "target"},
            "replacement": {
                "kind": "directional",
                "direction": "forward",
                "orderBy": [
                    {
                        "column": {"id": "c:source:0", "name": "order"},
                        "direction": "asc",
                        "nulls": "last",
                    }
                ],
            },
        },
    }

    try:
        preview = manager.preview_step(session_id, 0, operation, 0, 10)
        assert schema_column(preview["metadata"], "target")["nullable"] is True
        applied = manager.apply_draft(session_id, 1, 0, 10)
        assert schema_column(applied["metadata"], "target")["nullable"] is True
    finally:
        manager.close_session(session_id, 2)


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_session_fill_metadata_stays_consistent_through_preview_apply_and_replay(
    backend: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / f"fill-metadata-{backend}.csv"
    path.write_text("label,position\nalpha,1\n,2\nalpha,3\n", encoding="utf-8")
    if backend == "polars":
        monkeypatch.setattr(
            pl.DataFrame,
            "to_pandas",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Polars must stay native")),
            raising=False,
        )

    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend=backend,
        page_size=10,
    )
    session_id = opened["metadata"]["sessionId"]
    step = {
        "id": "fill-label",
        "kind": "fillMissingValues",
        "params": {
            "column": {"id": "c:source:0", "name": "label"},
            "replacement": {"kind": "mostFrequent"},
        },
    }

    try:
        assert schema_column(opened["metadata"], "label")["nullable"] is True

        preview = manager.preview_step(session_id, 0, step, 0, 10)
        assert schema_column(preview["metadata"], "label")["nullable"] is False

        discarded = manager.discard_draft(session_id, 1, 0, 10)
        assert schema_column(discarded["metadata"], "label")["nullable"] is True

        preview = manager.preview_step(session_id, 2, step, 0, 10)
        applied = manager.apply_draft(session_id, 3, 0, 10)
        assert schema_column(applied["metadata"], "label")["nullable"] is False

        inspection = manager.inspect_step(session_id, 4, "fill-label", 0, 10)
        assert schema_column({"schema": inspection["inputSchema"]}, "label")["nullable"] is True
        assert schema_column({"schema": inspection["outputSchema"]}, "label")["nullable"] is False

        undone = manager.undo_step(session_id, 4, 0, 10)
        assert schema_column(undone["metadata"], "label")["nullable"] is True
    finally:
        manager.close_session(session_id, 5)


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_session_fallback_fill_keeps_nullable_metadata_when_rows_remain_unresolved(
    backend: str,
    tmp_path: Path,
) -> None:
    path = tmp_path / f"fallback-nullability-{backend}.csv"
    path.write_text("target,fallback\npresent,first\n,second\n,\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend=backend,
        page_size=10,
    )
    session_id = opened["metadata"]["sessionId"]
    operation = {
        "id": "fill-from-fallback",
        "kind": "fillMissingValues",
        "params": {
            "column": {"id": "c:source:0", "name": "target"},
            "replacement": {
                "kind": "fallbackColumns",
                "columns": [{"id": "c:source:1", "name": "fallback"}],
            },
        },
    }

    try:
        preview = manager.preview_step(session_id, 0, operation, 0, 10)
        assert schema_column(preview["metadata"], "target")["nullable"] is True
        applied = manager.apply_draft(session_id, 1, 0, 10)
        assert schema_column(applied["metadata"], "target")["nullable"] is True
    finally:
        manager.close_session(session_id, 2)


def test_polars_generated_fill_plan_uses_python_310_grammar() -> None:
    engine = PolarsEngine()
    operation = fill_step(bound_ref("c:source:0", "value", 0), {"kind": "median"})

    try:
        ast.parse(engine.compile_plan([operation]), feature_version=(3, 10))
    finally:
        engine.close()


def test_fill_missing_median_and_typed_value_match_generated_code(engine_and_frame) -> None:
    engine, source = engine_and_frame
    plan = [
        fill_step(bound_ref("c:source:0", "value", 0), {"kind": "median"}, step_id="fill-number"),
        fill_step(
            bound_ref("c:source:1", "label", 1),
            {"kind": "string", "value": "unknown"},
            step_id="fill-text",
        ),
    ]

    live = source
    for operation in plan:
        live = engine.apply_transform(live, operation)
    generated = execute_generated(engine, source, plan)

    expected = [
        (1.0, "a"),
        (3.0, "unknown"),
        (3.0, "b"),
        (5.0, "unknown"),
    ]
    assert normalized_rows(live) == expected
    assert normalized_rows(generated) == expected


def test_float_mean_fill_is_stable_for_huge_values_and_matches_generated_code(engine_and_frame) -> None:
    engine, _source = engine_and_frame
    source = float_frame(engine, [1e308, 1e308, None, float("nan")])
    operation = fill_step(bound_ref("c:source:0", "value", 0), {"kind": "mean"})

    live = engine.apply_transform(source, operation)
    generated = execute_generated(engine, source, [operation])

    assert [value for (value,) in rows(live)] == pytest.approx([1e308] * 4)
    assert [value for (value,) in rows(generated)] == pytest.approx([1e308] * 4)
    assert first_column_type(live) == first_column_type(source)
    assert first_column_type(generated) == first_column_type(source)


@pytest.mark.parametrize(
    ("values", "message"),
    [
        ([None, float("nan")], "no present numeric values"),
        ([float("inf"), float("-inf"), None], "positive and negative infinity"),
    ],
)
def test_float_mean_fill_rejects_undefined_results_in_live_and_generated_code(
    engine_and_frame,
    values: list[float | None],
    message: str,
) -> None:
    engine, _source = engine_and_frame
    source = float_frame(engine, values)
    operation = fill_step(bound_ref("c:source:0", "value", 0), {"kind": "mean"})

    with pytest.raises(EngineError, match=message):
        engine.apply_transform(source, operation)
    with pytest.raises(ValueError, match=message):
        execute_generated(engine, source, [operation])


def test_float_mean_fill_is_an_exact_noop_without_missing_values(engine_and_frame) -> None:
    engine, _source = engine_and_frame
    source = float_frame(engine, [float("inf"), float("-inf")])
    operation = fill_step(bound_ref("c:source:0", "value", 0), {"kind": "mean"})

    live = engine.apply_transform(source, operation)
    generated = execute_generated(engine, source, [operation])

    assert rows(live) == rows(source)
    assert rows(generated) == rows(source)
    assert first_column_type(live) == first_column_type(source)
    assert first_column_type(generated) == first_column_type(source)


def test_mean_fill_rejects_non_float_columns_at_execution(engine_and_frame) -> None:
    engine, _source = engine_and_frame
    if isinstance(engine, PandasEngine):
        source = pd.DataFrame({"value": pd.Series([1, None], dtype="Int64")})
    elif isinstance(engine, PolarsEngine):
        source = pl.DataFrame({"value": pl.Series([1, None], dtype=pl.Int64)})
    else:
        source = duckdb.sql('SELECT * FROM (VALUES (1::BIGINT), (NULL::BIGINT)) AS source("value")')
    operation = fill_step(bound_ref("c:source:0", "value", 0), {"kind": "mean"})

    with pytest.raises(EngineError, match="floating-point column"):
        engine.apply_transform(source, operation)
    with pytest.raises(ValueError, match="floating-point column"):
        execute_generated(engine, source, [operation])


def test_pandas_mean_fill_rejects_object_values_outside_float_range() -> None:
    engine = PandasEngine()
    source = pd.DataFrame({"value": pd.Series([10**400, 1.0, None], dtype=object)})
    operation = fill_step(bound_ref("c:source:0", "value", 0), {"kind": "mean"})

    assert schema_column({"schema": engine.schema(source)}, "value")["type"] == "float"
    with pytest.raises(EngineError, match="cannot be represented as a floating-point number"):
        engine.apply_transform(source, operation)
    with pytest.raises(ValueError, match="cannot be represented as a floating-point number"):
        execute_generated(engine, source, [operation])


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_fallback_columns_are_ordered_and_preserve_unresolved_null_and_nan(
    backend: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if backend == "pandas":
        engine = PandasEngine()
        source = pd.DataFrame(
            {
                "target": pd.Series([10.0, None, float("nan"), None, float("nan")], dtype=object),
                "first": pd.Series([100.0, 1.0, float("nan"), None, None], dtype=object),
                "second": pd.Series([200.0, 2.0, 3.0, float("nan"), None], dtype=object),
            }
        )
    elif backend == "polars":
        monkeypatch.setattr(
            pl.DataFrame,
            "to_pandas",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Polars must stay native")),
            raising=False,
        )
        engine = PolarsEngine()
        source = pl.DataFrame(
            {
                "target": [10.0, None, float("nan"), None, float("nan")],
                "first": [100.0, 1.0, float("nan"), None, None],
                "second": [200.0, 2.0, 3.0, float("nan"), None],
            }
        )
    else:
        engine = DuckDBEngine()
        source = duckdb.sql(
            """
            SELECT * FROM (VALUES
                (10.0::DOUBLE, 100.0::DOUBLE, 200.0::DOUBLE),
                (NULL::DOUBLE, 1.0::DOUBLE, 2.0::DOUBLE),
                ('NaN'::DOUBLE, 'NaN'::DOUBLE, 3.0::DOUBLE),
                (NULL::DOUBLE, NULL::DOUBLE, 'NaN'::DOUBLE),
                ('NaN'::DOUBLE, NULL::DOUBLE, NULL::DOUBLE)
            ) AS source(target, first, second)
            """
        )
    operation = fill_step(
        bound_ref("c:source:0", "target", 0),
        {
            "kind": "fallbackColumns",
            "columns": [
                bound_ref("c:source:1", "first", 1),
                bound_ref("c:source:2", "second", 2),
            ],
        },
    )

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])

        assert normalized_rows(live) == [
            (10.0, 100.0, 200.0),
            (1.0, 1.0, 2.0),
            (3.0, None, 3.0),
            (None, None, None),
            (None, None, None),
        ]
        assert normalized_rows(generated) == normalized_rows(live)
        live_rows = rows(live)
        generated_rows = rows(generated)
        assert live_rows[3][0] is None
        assert generated_rows[3][0] is None
        assert isinstance(live_rows[4][0], float) and isnan(live_rows[4][0])
        assert isinstance(generated_rows[4][0], float) and isnan(generated_rows[4][0])
    finally:
        engine.close()


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_fallback_columns_preserve_a_representable_narrow_integer_target(backend: str) -> None:
    if backend == "pandas":
        engine = PandasEngine()
        source = pd.DataFrame(
            {
                "target": pd.Series([1, None], dtype="Int8"),
                "fallback": pd.Series([1000, 2], dtype="Int64"),
            }
        )
        expected_type = "Int8"
    elif backend == "polars":
        engine = PolarsEngine()
        source = pl.DataFrame(
            {
                "target": pl.Series([1, None], dtype=pl.Int8),
                "fallback": pl.Series([1000, 2], dtype=pl.Int64),
            }
        )
        expected_type = "Int8"
    else:
        engine = DuckDBEngine()
        source = duckdb.sql(
            "SELECT * FROM (VALUES (1::TINYINT, 1000::BIGINT), (NULL::TINYINT, 2::BIGINT)) AS source(target, fallback)"
        )
        expected_type = "TINYINT"
    operation = fill_step(
        bound_ref("c:source:0", "target", 0),
        {
            "kind": "fallbackColumns",
            "columns": [bound_ref("c:source:1", "fallback", 1)],
        },
    )

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])

        assert normalized_rows(live) == [(1, 1000), (2, 2)]
        assert normalized_rows(generated) == normalized_rows(live)
        assert first_column_type(live) == expected_type
        assert first_column_type(generated) == expected_type
    finally:
        engine.close()


def test_polars_fallback_columns_remain_lazy_and_native(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        pl.DataFrame,
        "to_pandas",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Polars must stay native")),
        raising=False,
    )
    engine = PolarsEngine()
    source = pl.LazyFrame(
        {
            "target": pl.Series([None, 2], dtype=pl.Int64),
            "fallback": pl.Series([1, 3], dtype=pl.Int64),
        }
    )
    operation = fill_step(
        bound_ref("c:source:0", "target", 0),
        {
            "kind": "fallbackColumns",
            "columns": [bound_ref("c:source:1", "fallback", 1)],
        },
    )

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])
        assert isinstance(live, pl.LazyFrame)
        assert isinstance(generated, pl.LazyFrame)
        assert live.collect().rows() == [(1, 1), (2, 3)]
        assert generated.collect().rows() == [(1, 1), (2, 3)]
    finally:
        engine.close()


def test_pandas_fallback_columns_are_positional_with_duplicate_indexes_and_labels() -> None:
    engine = PandasEngine()
    source = pd.DataFrame(
        [[None, 10, 100], [2, 20, 200], [None, 30, 300]],
        index=pd.Index([0, 0, 1]),
        columns=pd.Index(["duplicate", "duplicate", 7], dtype=object),
    ).astype({"duplicate": "Int64", 7: "Int64"})
    operation = fill_step(
        bound_ref("c:source:0", "duplicate", 0),
        {
            "kind": "fallbackColumns",
            "columns": [bound_ref("c:source:2", "7", 2)],
        },
    )

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])
        assert normalized_rows(live) == [(100, 10, 100), (2, 20, 200), (300, 30, 300)]
        assert normalized_rows(generated) == normalized_rows(live)
        assert live.index.tolist() == [0, 0, 1]
        assert generated.index.tolist() == [0, 0, 1]
    finally:
        engine.close()


@pytest.mark.parametrize(
    ("target_values", "fallback_values", "expected_values", "expected_type"),
    [
        (["a", None], ["outside", "b"], ["a", "b"], "category"),
        (["a", None], ["outside", "outside"], ["a", "outside"], "string"),
    ],
)
def test_pandas_fallback_columns_widen_a_category_only_for_a_selected_new_label(
    target_values: list[str | None],
    fallback_values: list[str],
    expected_values: list[str],
    expected_type: str,
) -> None:
    engine = PandasEngine()
    source = pd.DataFrame(
        {
            "target": pd.Categorical(target_values, categories=["a", "b"]),
            "fallback": pd.Series(fallback_values, dtype="string"),
        }
    )
    operation = fill_step(
        bound_ref("c:source:0", "target", 0),
        {
            "kind": "fallbackColumns",
            "columns": [bound_ref("c:source:1", "fallback", 1)],
        },
    )

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])
        assert live.iloc[:, 0].tolist() == expected_values
        assert generated.iloc[:, 0].tolist() == expected_values
        assert str(live.dtypes.iloc[0]) == expected_type
        assert str(generated.dtypes.iloc[0]) == expected_type
    finally:
        engine.close()


def test_pandas_fallback_columns_ignore_unused_labels_from_another_category_domain() -> None:
    engine = PandasEngine()
    source = pd.DataFrame(
        {
            "target": pd.Categorical(["a", None], categories=["a", "b"]),
            "fallback": pd.Categorical(["outside", "b"], categories=["outside", "b"]),
        }
    )
    operation = fill_step(
        bound_ref("c:source:0", "target", 0),
        {
            "kind": "fallbackColumns",
            "columns": [bound_ref("c:source:1", "fallback", 1)],
        },
    )

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])
        assert live.iloc[:, 0].tolist() == ["a", "b"]
        assert generated.iloc[:, 0].tolist() == ["a", "b"]
        assert str(live.dtypes.iloc[0]) == "category"
        assert str(generated.dtypes.iloc[0]) == "category"
    finally:
        engine.close()


def test_pandas_fallback_columns_reject_selected_decimal_scale_loss_in_live_and_generated_code() -> None:
    engine = PandasEngine()
    source = pd.DataFrame(
        {
            "target": pd.Series(
                [Decimal("1.00"), None],
                dtype=pd.ArrowDtype(pa.decimal128(6, 2)),
            ),
            "fallback": pd.Series(
                [Decimal("9.999"), Decimal("2.345")],
                dtype=pd.ArrowDtype(pa.decimal128(7, 3)),
            ),
        }
    )
    operation = fill_step(
        bound_ref("c:source:0", "target", 0),
        {
            "kind": "fallbackColumns",
            "columns": [bound_ref("c:source:1", "fallback", 1)],
        },
    )

    try:
        with pytest.raises(EngineError, match="decimal scale 2"):
            engine.apply_transform(source, operation)
        with pytest.raises(ValueError, match="decimal scale 2"):
            execute_generated(engine, source, [operation])
    finally:
        engine.close()


def test_pandas_fallback_columns_validate_only_selected_decimal_values() -> None:
    engine = PandasEngine()
    source = pd.DataFrame(
        {
            "target": pd.Series(
                [Decimal("1.00"), None],
                dtype=pd.ArrowDtype(pa.decimal128(6, 2)),
            ),
            "fallback": pd.Series(
                [Decimal("9.999"), Decimal("2.000")],
                dtype=pd.ArrowDtype(pa.decimal128(7, 3)),
            ),
        }
    )
    operation = fill_step(
        bound_ref("c:source:0", "target", 0),
        {
            "kind": "fallbackColumns",
            "columns": [bound_ref("c:source:1", "fallback", 1)],
        },
    )

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])
        assert normalized_rows(live) == [
            (Decimal("1.00"), Decimal("9.999")),
            (Decimal("2.00"), Decimal("2.000")),
        ]
        assert normalized_rows(generated) == normalized_rows(live)
        assert str(live.dtypes.iloc[0]) == "decimal128(6, 2)[pyarrow]"
        assert str(generated.dtypes.iloc[0]) == "decimal128(6, 2)[pyarrow]"
    finally:
        engine.close()


def test_pandas_fallback_columns_reject_selected_datetime_awareness_mismatch() -> None:
    engine = PandasEngine()
    source = pd.DataFrame(
        {
            "target": pd.Series(
                [datetime(2025, 1, 1, tzinfo=timezone.utc), pd.NaT],
                dtype="datetime64[ns, UTC]",
            ),
            "fallback": pd.Series(
                [datetime(2025, 2, 1, tzinfo=timezone.utc), datetime(2025, 2, 2)],
                dtype=object,
            ),
        }
    )
    operation = fill_step(
        bound_ref("c:source:0", "target", 0),
        {
            "kind": "fallbackColumns",
            "columns": [bound_ref("c:source:1", "fallback", 1)],
        },
    )

    try:
        with pytest.raises(EngineError, match="timezone-aware"):
            engine.apply_transform(source, operation)
        with pytest.raises(ValueError, match="timezone-aware"):
            execute_generated(engine, source, [operation])
    finally:
        engine.close()


def test_pandas_fallback_columns_validate_only_selected_datetime_values() -> None:
    engine = PandasEngine()
    source = pd.DataFrame(
        {
            "target": pd.Series(
                [datetime(2025, 1, 1, tzinfo=timezone.utc), pd.NaT],
                dtype="datetime64[ns, UTC]",
            ),
            "fallback": pd.Series(
                [datetime(2025, 2, 1), datetime(2025, 2, 2, tzinfo=timezone.utc)],
                dtype=object,
            ),
        }
    )
    operation = fill_step(
        bound_ref("c:source:0", "target", 0),
        {
            "kind": "fallbackColumns",
            "columns": [bound_ref("c:source:1", "fallback", 1)],
        },
    )

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])
        expected_target = [
            pd.Timestamp("2025-01-01T00:00:00Z"),
            pd.Timestamp("2025-02-02T00:00:00Z"),
        ]
        assert live.iloc[:, 0].tolist() == expected_target
        assert generated.iloc[:, 0].tolist() == expected_target
        assert str(live.dtypes.iloc[0]) == "datetime64[ns, UTC]"
        assert str(generated.dtypes.iloc[0]) == "datetime64[ns, UTC]"
    finally:
        engine.close()


def test_polars_fallback_columns_widen_enum_for_a_public_string_domain(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        pl.DataFrame,
        "to_pandas",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Polars must stay native")),
        raising=False,
    )
    engine = PolarsEngine()
    enum = pl.Enum(["a", "b"])
    source = pl.DataFrame(
        {
            "target": pl.Series(["a", None], dtype=enum),
            "fallback": pl.Series(["ignored", "new"], dtype=pl.String),
        }
    ).lazy()
    operation = fill_step(
        bound_ref("c:source:0", "target", 0),
        {
            "kind": "fallbackColumns",
            "columns": [bound_ref("c:source:1", "fallback", 1)],
        },
    )

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])
        assert isinstance(live, pl.LazyFrame)
        assert isinstance(generated, pl.LazyFrame)
        assert live.collect_schema()["target"] == pl.String
        assert generated.collect_schema()["target"] == pl.String
        assert live.collect().rows() == [("a", "ignored"), ("new", "new")]
        assert generated.collect().rows() == live.collect().rows()
    finally:
        engine.close()


def test_polars_fallback_columns_preserve_an_exact_enum_domain() -> None:
    engine = PolarsEngine()
    enum = pl.Enum(["a", "b"])
    source = pl.DataFrame(
        {
            "target": pl.Series(["a", None], dtype=enum),
            "fallback": pl.Series(["b", "b"], dtype=enum),
        }
    ).lazy()
    operation = fill_step(
        bound_ref("c:source:0", "target", 0),
        {
            "kind": "fallbackColumns",
            "columns": [bound_ref("c:source:1", "fallback", 1)],
        },
    )

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])
        assert live.collect_schema()["target"] == enum
        assert generated.collect_schema()["target"] == enum
        assert live.collect().rows() == [("a", "b"), ("b", "b")]
        assert generated.collect().rows() == live.collect().rows()
    finally:
        engine.close()


def test_polars_fallback_columns_preserve_enum_for_selected_compatible_public_strings() -> None:
    engine = PolarsEngine()
    enum = pl.Enum(["a", "b"])
    source = pl.DataFrame(
        {
            "target": pl.Series(["a", None], dtype=enum),
            "fallback": pl.Series(["outside", "b"], dtype=pl.String),
        }
    ).lazy()
    operation = fill_step(
        bound_ref("c:source:0", "target", 0),
        {
            "kind": "fallbackColumns",
            "columns": [bound_ref("c:source:1", "fallback", 1)],
        },
    )

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])
        assert live.collect_schema()["target"] == enum
        assert generated.collect_schema()["target"] == enum
        assert live.collect().rows() == [("a", "outside"), ("b", "b")]
        assert generated.collect().rows() == live.collect().rows()
    finally:
        engine.close()


def test_polars_fallback_columns_do_not_widen_enum_when_target_has_no_missing_values() -> None:
    engine = PolarsEngine()
    enum = pl.Enum(["a", "b"])
    source = pl.DataFrame(
        {
            "target": pl.Series(["a", "b"], dtype=enum),
            "fallback": pl.Series(["new", "outside"], dtype=pl.String),
        }
    ).lazy()
    operation = fill_step(
        bound_ref("c:source:0", "target", 0),
        {
            "kind": "fallbackColumns",
            "columns": [bound_ref("c:source:1", "fallback", 1)],
        },
    )

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])
        assert live.collect_schema()["target"] == enum
        assert generated.collect_schema()["target"] == enum
        assert live.collect().rows() == [("a", "new"), ("b", "outside")]
        assert generated.collect().rows() == live.collect().rows()
    finally:
        engine.close()


def test_polars_fallback_columns_do_not_widen_enum_for_an_unused_later_domain() -> None:
    engine = PolarsEngine()
    enum = pl.Enum(["a", "b"])
    source = pl.DataFrame(
        {
            "target": pl.Series(["a", None], dtype=enum),
            "first": pl.Series(["b", "b"], dtype=enum),
            "later": pl.Series(["new", "outside"], dtype=pl.String),
        }
    ).lazy()
    operation = fill_step(
        bound_ref("c:source:0", "target", 0),
        {
            "kind": "fallbackColumns",
            "columns": [
                bound_ref("c:source:1", "first", 1),
                bound_ref("c:source:2", "later", 2),
            ],
        },
    )

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])
        assert live.collect_schema()["target"] == enum
        assert generated.collect_schema()["target"] == enum
        assert live.collect().rows() == [("a", "b", "new"), ("b", "b", "outside")]
        assert generated.collect().rows() == live.collect().rows()
    finally:
        engine.close()


@pytest.mark.parametrize(
    ("source_sql", "fallbacks", "expected_rows", "widens"),
    [
        (
            "SELECT * FROM (VALUES "
            "('a'::ENUM('a', 'b'), 'ignored'::VARCHAR), "
            "(NULL::ENUM('a', 'b'), 'new'::VARCHAR)) AS source(target, fallback)",
            ["fallback"],
            [("a", "ignored"), ("new", "new")],
            True,
        ),
        (
            "SELECT * FROM (VALUES "
            "('a'::ENUM('a', 'b'), 'outside'::VARCHAR), "
            "(NULL::ENUM('a', 'b'), 'b'::VARCHAR)) AS source(target, fallback)",
            ["fallback"],
            [("a", "outside"), ("b", "b")],
            False,
        ),
        (
            "SELECT * FROM (VALUES "
            "('a'::ENUM('a', 'b'), 'new'::VARCHAR), "
            "('b'::ENUM('a', 'b'), 'outside'::VARCHAR)) AS source(target, fallback)",
            ["fallback"],
            [("a", "new"), ("b", "outside")],
            False,
        ),
        (
            "SELECT * FROM (VALUES "
            "('a'::ENUM('a', 'b'), 'b'::ENUM('a', 'b'), 'new'::VARCHAR), "
            "(NULL::ENUM('a', 'b'), 'b'::ENUM('a', 'b'), 'outside'::VARCHAR)) "
            "AS source(target, first, later)",
            ["first", "later"],
            [("a", "b", "new"), ("b", "b", "outside")],
            False,
        ),
    ],
)
def test_duckdb_fallback_columns_widen_only_for_selected_values_outside_the_target_domain(
    source_sql: str,
    fallbacks: list[str],
    expected_rows: list[tuple[str, ...]],
    widens: bool,
) -> None:
    engine = DuckDBEngine()
    source = duckdb.sql(source_sql)
    source_type = first_column_type(source)
    operation = fill_step(
        bound_ref("c:source:0", "target", 0),
        {
            "kind": "fallbackColumns",
            "columns": [
                bound_ref(f"c:source:{position}", fallback, position)
                for position, fallback in enumerate(fallbacks, start=1)
            ],
        },
    )

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])
        assert normalized_rows(live) == expected_rows
        assert normalized_rows(generated) == expected_rows
        expected_type = "VARCHAR" if widens else source_type
        assert first_column_type(live) == expected_type
        assert first_column_type(generated) == expected_type
    finally:
        engine.close()


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_fallback_columns_reject_a_selected_integer_that_does_not_fit_the_target(backend: str) -> None:
    if backend == "pandas":
        engine = PandasEngine()
        source = pd.DataFrame(
            {
                "target": pd.Series([None], dtype="Int8"),
                "fallback": pd.Series([1000], dtype="Int64"),
            }
        )
        live_error: type[BaseException] = EngineError
        generated_error: type[BaseException] = ValueError
    elif backend == "polars":
        engine = PolarsEngine()
        source = pl.DataFrame(
            {
                "target": pl.Series([None], dtype=pl.Int8),
                "fallback": pl.Series([1000], dtype=pl.Int64),
            }
        )
        live_error = pl.exceptions.InvalidOperationError
        generated_error = pl.exceptions.InvalidOperationError
    else:
        engine = DuckDBEngine()
        source = duckdb.sql('SELECT NULL::TINYINT AS "target", 1000::BIGINT AS "fallback"')
        live_error = duckdb.ConversionException
        generated_error = duckdb.ConversionException
    operation = fill_step(
        bound_ref("c:source:0", "target", 0),
        {
            "kind": "fallbackColumns",
            "columns": [bound_ref("c:source:1", "fallback", 1)],
        },
    )

    try:
        with pytest.raises(live_error):
            rows(engine.apply_transform(source, operation))
        with pytest.raises(generated_error):
            rows(execute_generated(engine, source, [operation]))
    finally:
        engine.close()


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_median_fill_rejects_a_column_with_no_present_values(backend: str) -> None:
    if backend == "pandas":
        engine = PandasEngine()
        source = pd.DataFrame({"value": [None, float("nan")]}, dtype="Float64")
    elif backend == "polars":
        engine = PolarsEngine()
        source = pl.DataFrame({"value": pl.Series([None, float("nan")], dtype=pl.Float64)})
    else:
        engine = DuckDBEngine()
        source = duckdb.sql("SELECT * FROM (VALUES (NULL::DOUBLE), ('NaN'::DOUBLE)) AS source(value)")
    operation = fill_step(bound_ref("c:source:0", "value", 0), {"kind": "median"})

    try:
        with pytest.raises(EngineError, match="no present numeric values"):
            engine.apply_transform(source, operation)
        with pytest.raises(ValueError, match="no present numeric values"):
            execute_generated(engine, source, [operation])
    finally:
        engine.close()


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_string_fill_accepts_a_new_categorical_value(backend: str, monkeypatch: pytest.MonkeyPatch) -> None:
    if backend == "pandas":
        engine = PandasEngine()
        source = pd.DataFrame({"label": pd.Categorical(["a", None, "b"])})
    elif backend == "polars":
        monkeypatch.setattr(
            pl.DataFrame,
            "to_pandas",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Polars must stay native")),
            raising=False,
        )
        engine = PolarsEngine()
        source = pl.DataFrame({"label": pl.Series(["a", None, "b"], dtype=pl.Categorical)})
    else:
        engine = DuckDBEngine()
        source = duckdb.sql(
            "SELECT * FROM (VALUES ('a'::ENUM('a', 'b')), (NULL::ENUM('a', 'b')), "
            "('b'::ENUM('a', 'b'))) AS source(label)"
        )
    operation = fill_step(
        bound_ref("c:source:0", "label", 0),
        {"kind": "string", "value": "unknown"},
    )

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])

        assert normalized_rows(live) == [("a",), ("unknown",), ("b",)]
        assert normalized_rows(generated) == normalized_rows(live)
    finally:
        engine.close()


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_most_frequent_fill_preserves_categorical_types(backend: str, monkeypatch: pytest.MonkeyPatch) -> None:
    if backend == "pandas":
        engine = PandasEngine()
        source = pd.DataFrame({"label": pd.Categorical(["a", "a", "b", None])})
    elif backend == "polars":
        monkeypatch.setattr(
            pl.DataFrame,
            "to_pandas",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Polars must stay native")),
            raising=False,
        )
        engine = PolarsEngine()
        source = pl.DataFrame({"label": pl.Series(["a", "a", "b", None], dtype=pl.Categorical)})
    else:
        engine = DuckDBEngine()
        source = duckdb.sql(
            "SELECT * FROM (VALUES ('a'::ENUM('a', 'b')), ('a'::ENUM('a', 'b')), "
            "('b'::ENUM('a', 'b')), (NULL::ENUM('a', 'b'))) AS source(label)"
        )
    operation = fill_step(
        bound_ref("c:source:0", "label", 0),
        {"kind": "mostFrequent"},
    )

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])

        assert normalized_rows(live) == [("a",), ("a",), ("b",), ("a",)]
        assert normalized_rows(generated) == normalized_rows(live)
        assert first_column_type(live) == first_column_type(source)
        assert first_column_type(generated) == first_column_type(source)
    finally:
        engine.close()


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_categorical_fill_with_no_missing_values_is_an_exact_type_no_op(
    backend: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    if backend == "pandas":
        engine = PandasEngine()
        source = pd.DataFrame({"label": pd.Categorical(["a", "b"])})
    elif backend == "polars":
        monkeypatch.setattr(
            pl.DataFrame,
            "to_pandas",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Polars must stay native")),
            raising=False,
        )
        engine = PolarsEngine()
        source = pl.DataFrame({"label": pl.Series(["a", "b"], dtype=pl.Categorical)})
    else:
        engine = DuckDBEngine()
        source = duckdb.sql("SELECT * FROM (VALUES ('a'::ENUM('a', 'b')), ('b'::ENUM('a', 'b'))) AS source(label)")
    operation = fill_step(
        bound_ref("c:source:0", "label", 0),
        {"kind": "string", "value": "not-a-category"},
    )

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])

        assert normalized_rows(live) == [("a",), ("b",)]
        assert normalized_rows(generated) == normalized_rows(live)
        assert first_column_type(live) == first_column_type(source)
        assert first_column_type(generated) == first_column_type(source)
    finally:
        engine.close()


def test_duckdb_uuid_fill_with_no_missing_values_preserves_uuid_type() -> None:
    engine = DuckDBEngine()
    source = duckdb.sql("SELECT '123e4567-e89b-12d3-a456-426614174000'::UUID AS identifier")
    operation = fill_step(
        bound_ref("c:source:0", "identifier", 0),
        {"kind": "string", "value": "not-a-uuid"},
    )

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])

        assert normalized_rows(live) == normalized_rows(source)
        assert normalized_rows(generated) == normalized_rows(source)
        assert first_column_type(live) == "UUID"
        assert first_column_type(generated) == "UUID"
    finally:
        engine.close()


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_most_frequent_fill_preserves_boolean_types(backend: str) -> None:
    if backend == "pandas":
        engine = PandasEngine()
        source = pd.DataFrame({"enabled": pd.Series([True, None, True, False], dtype="boolean")})
    elif backend == "polars":
        engine = PolarsEngine()
        source = pl.DataFrame({"enabled": pl.Series([True, None, True, False], dtype=pl.Boolean)})
    else:
        engine = DuckDBEngine()
        source = duckdb.sql(
            "SELECT * FROM (VALUES (TRUE::BOOLEAN), (NULL::BOOLEAN), (TRUE::BOOLEAN), (FALSE::BOOLEAN)) "
            "AS source(enabled)"
        )
    operation = fill_step(
        bound_ref("c:source:0", "enabled", 0),
        {"kind": "mostFrequent"},
    )

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])

        assert normalized_rows(live) == [(True,), (True,), (True,), (False,)]
        assert normalized_rows(generated) == normalized_rows(live)
        assert first_column_type(live) == first_column_type(source)
        assert first_column_type(generated) == first_column_type(source)
    finally:
        engine.close()


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
@pytest.mark.parametrize(
    ("values", "message"),
    [
        (["a", "b", None], "2 values are tied"),
        ([None, None], "no non-missing values"),
    ],
)
def test_most_frequent_fill_rejects_ties_and_all_missing_values(
    backend: str, values: list[str | None], message: str
) -> None:
    if backend == "pandas":
        engine = PandasEngine()
        source = pd.DataFrame({"label": pd.Series(values, dtype="string")})
    elif backend == "polars":
        engine = PolarsEngine()
        source = pl.DataFrame({"label": pl.Series(values, dtype=pl.String)})
    else:
        engine = DuckDBEngine()
        rows_sql = ", ".join("(NULL::VARCHAR)" if value is None else f"('{value}'::VARCHAR)" for value in values)
        source = duckdb.sql(f"SELECT * FROM (VALUES {rows_sql}) AS source(label)")
    operation = fill_step(
        bound_ref("c:source:0", "label", 0),
        {"kind": "mostFrequent"},
    )

    try:
        with pytest.raises(EngineError, match=message):
            engine.apply_transform(source, operation)
        with pytest.raises(ValueError, match=message):
            execute_generated(engine, source, [operation])
    finally:
        engine.close()


def test_polars_most_frequent_fill_stays_lazy_and_native(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        pl.DataFrame,
        "to_pandas",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Polars must stay native")),
        raising=False,
    )
    engine = PolarsEngine()
    source = pl.DataFrame({"label": ["a", "a", "b", None]}).lazy()
    operation = fill_step(
        bound_ref("c:source:0", "label", 0),
        {"kind": "mostFrequent"},
    )

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])

        assert isinstance(live, pl.LazyFrame)
        assert isinstance(generated, pl.LazyFrame)
        assert rows(live) == [("a",), ("a",), ("b",), ("a",)]
        assert rows(generated) == rows(live)
    finally:
        engine.close()


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_typed_fill_values_match_generated_code(backend: str, monkeypatch: pytest.MonkeyPatch) -> None:
    if backend == "pandas":
        engine = PandasEngine()
        source = pd.DataFrame(
            {
                "count": pd.array([1, None], dtype="Int64"),
                "amount": [Decimal("1.25"), None],
                "enabled": pd.array([True, None], dtype="boolean"),
                "day": [date(2026, 1, 1), None],
                "moment": pd.to_datetime(["2026-01-01T12:00:00", None]),
            }
        )
    elif backend == "polars":
        monkeypatch.setattr(
            pl.DataFrame,
            "to_pandas",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Polars must stay native")),
            raising=False,
        )
        engine = PolarsEngine()
        source = pl.DataFrame(
            {
                "count": pl.Series([1, None], dtype=pl.Int64),
                "amount": pl.Series([Decimal("1.25"), None], dtype=pl.Decimal(38, 2)),
                "enabled": pl.Series([True, None], dtype=pl.Boolean),
                "day": pl.Series([date(2026, 1, 1), None], dtype=pl.Date),
                "moment": pl.Series([datetime(2026, 1, 1, 12), None], dtype=pl.Datetime("us")),
            }
        )
    else:
        engine = DuckDBEngine()
        source = duckdb.sql(
            """
            SELECT * FROM (VALUES
                (1::BIGINT, 1.25::DECIMAL(38, 2), TRUE, DATE '2026-01-01', TIMESTAMP '2026-01-01 12:00:00'),
                (NULL::BIGINT, NULL::DECIMAL(38, 2), NULL::BOOLEAN, NULL::DATE, NULL::TIMESTAMP)
            ) AS source("count", "amount", "enabled", "day", "moment")
            """
        )

    plan = [
        fill_step(bound_ref("c:source:0", "count", 0), {"kind": "integer", "value": "7"}, step_id="count"),
        fill_step(
            bound_ref("c:source:1", "amount", 1),
            {"kind": "decimal", "value": "2.50"},
            step_id="amount",
        ),
        fill_step(
            bound_ref("c:source:2", "enabled", 2),
            {"kind": "boolean", "value": False},
            step_id="enabled",
        ),
        fill_step(
            bound_ref("c:source:3", "day", 3),
            {"kind": "date", "value": "2026-08-05"},
            step_id="day",
        ),
        fill_step(
            bound_ref("c:source:4", "moment", 4),
            {"kind": "datetime", "value": "2026-08-05T18:20:00"},
            step_id="moment",
        ),
    ]

    try:
        live = source
        for operation in plan:
            live = engine.apply_transform(live, operation)
        generated = execute_generated(engine, source, plan)

        assert normalized_rows(generated) == normalized_rows(live)
        assert normalized_rows(live)[1] == (
            7,
            Decimal("2.50"),
            False,
            date(2026, 8, 5),
            datetime(2026, 8, 5, 18, 20),
        )
    finally:
        engine.close()


def test_pandas_fill_missing_keeps_duplicate_and_non_string_labels_positional() -> None:
    engine = PandasEngine()
    source = pd.DataFrame(
        [[1.0, None, 10.0], [None, 3.0, None]],
        columns=pd.Index(["duplicate", "duplicate", 7], dtype="object"),
    )
    plan = [
        fill_step(
            bound_ref("c:source:1", "duplicate", 1),
            {"kind": "float", "value": "9"},
            step_id="fill-second-duplicate",
        ),
        fill_step(bound_ref("c:source:2", "7", 2), {"kind": "median"}, step_id="fill-non-string"),
    ]

    live = source
    for operation in plan:
        live = engine.apply_transform(live, operation)
    generated = execute_generated(engine, source, plan)

    assert list(live.columns) == ["duplicate", "duplicate", 7]
    assert normalized_rows(live) == [(1.0, 9.0, 10.0), (None, 3.0, 10.0)]
    assert normalized_rows(generated) == normalized_rows(live)


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_integer_median_preserves_values_above_javascript_safe_integer(backend: str) -> None:
    lower = 9_007_199_254_740_993
    median = 9_007_199_254_740_994
    upper = 9_007_199_254_740_995
    if backend == "pandas":
        engine = PandasEngine()
        source = pd.DataFrame({"value": pd.array([lower, None, upper], dtype="Int64")})
    elif backend == "polars":
        engine = PolarsEngine()
        source = pl.DataFrame({"value": pl.Series([lower, None, upper], dtype=pl.Int64)})
    else:
        engine = DuckDBEngine()
        source = duckdb.sql(
            f"SELECT * FROM (VALUES ({lower}::BIGINT), (NULL::BIGINT), ({upper}::BIGINT)) AS source(value)"
        )
    operation = fill_step(bound_ref("c:source:0", "value", 0), {"kind": "median"})

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])

        live_values = [row[0] for row in rows(live)]
        generated_values = [row[0] for row in rows(generated)]
        assert all(isinstance(value, Integral) and not isinstance(value, bool) for value in live_values)
        assert all(isinstance(value, Integral) and not isinstance(value, bool) for value in generated_values)
        assert [int(value) for value in live_values] == [lower, median, upper]
        assert [int(value) for value in generated_values] == [lower, median, upper]
        assert normalized_rows(source) == [(lower,), (None,), (upper,)]
    finally:
        engine.close()


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_float_median_avoids_overflow(backend: str) -> None:
    value = 1e308
    if backend == "pandas":
        engine = PandasEngine()
        source = pd.DataFrame({"value": pd.Series([value, None, value], dtype="Float64")})
    elif backend == "polars":
        engine = PolarsEngine()
        source = pl.DataFrame({"value": pl.Series([value, None, value], dtype=pl.Float64)})
    else:
        engine = DuckDBEngine()
        source = duckdb.sql(
            f"SELECT * FROM (VALUES ({value!r}::DOUBLE), (NULL::DOUBLE), ({value!r}::DOUBLE)) AS source(value)"
        )
    operation = fill_step(bound_ref("c:source:0", "value", 0), {"kind": "median"})

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])

        assert rows(live) == [(value,), (value,), (value,)]
        assert rows(generated) == rows(live)
        assert normalized_rows(source) == [(value,), (None,), (value,)]
    finally:
        engine.close()


@pytest.mark.parametrize(
    ("replacement", "expected"),
    [
        ({"kind": "median"}, Decimal("2.00")),
        ({"kind": "decimal", "value": "2.50"}, Decimal("2.50")),
    ],
)
def test_pandas_decimal_nan_is_filled_without_changing_present_values(
    replacement: dict[str, Any], expected: Decimal
) -> None:
    engine = PandasEngine()
    source_nan = Decimal("NaN")
    source = pd.DataFrame({"value": pd.Series([Decimal("1.00"), source_nan, None, Decimal("3.00")], dtype=object)})
    operation = fill_step(bound_ref("c:source:0", "value", 0), replacement)

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])

        expected_rows = [(Decimal("1.00"),), (expected,), (expected,), (Decimal("3.00"),)]
        assert rows(live) == expected_rows
        assert rows(generated) == expected_rows
        source_rows = rows(source)
        assert source_rows[0] == (Decimal("1.00"),)
        assert isinstance(source_rows[1][0], Decimal) and source_rows[1][0].is_nan()
        assert source_rows[2] == (None,)
        assert source_rows[3] == (Decimal("3.00"),)
    finally:
        engine.close()


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_decimal_median_preserves_38_digit_values(backend: str) -> None:
    lower = Decimal("99999999999999999999999999999999999997")
    median = Decimal("99999999999999999999999999999999999998")
    upper = Decimal("99999999999999999999999999999999999999")
    if backend == "pandas":
        engine = PandasEngine()
        source = pd.DataFrame({"value": pd.Series([lower, None, upper], dtype=pd.ArrowDtype(pa.decimal128(38, 0)))})
    elif backend == "polars":
        engine = PolarsEngine()
        source = pl.DataFrame({"value": pl.Series([lower, None, upper], dtype=pl.Decimal(38, 0))})
    else:
        engine = DuckDBEngine()
        source = duckdb.sql(
            "SELECT * FROM (VALUES "
            f"({lower}::DECIMAL(38, 0)), (NULL::DECIMAL(38, 0)), ({upper}::DECIMAL(38, 0))"
            ") AS source(value)"
        )
    operation = fill_step(bound_ref("c:source:0", "value", 0), {"kind": "median"})

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])

        assert all(isinstance(row[0], Decimal) for row in rows(live))
        assert all(isinstance(row[0], Decimal) for row in rows(generated))
        assert rows(live) == [(lower,), (median,), (upper,)]
        assert rows(generated) == rows(live)
        assert normalized_rows(source) == [(lower,), (None,), (upper,)]
    finally:
        engine.close()


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_integer_median_rejects_a_fractional_result(backend: str) -> None:
    if backend == "pandas":
        engine = PandasEngine()
        source = pd.DataFrame({"value": pd.array([1, None, 2], dtype="Int64")})
    elif backend == "polars":
        engine = PolarsEngine()
        source = pl.DataFrame({"value": pl.Series([1, None, 2], dtype=pl.Int64)})
    else:
        engine = DuckDBEngine()
        source = duckdb.sql("SELECT * FROM (VALUES (1::BIGINT), (NULL::BIGINT), (2::BIGINT)) AS source(value)")
    operation = fill_step(bound_ref("c:source:0", "value", 0), {"kind": "median"})

    try:
        with pytest.raises(EngineError, match="integer median is fractional"):
            engine.apply_transform(source, operation)
        with pytest.raises(ValueError, match="integer median is fractional"):
            execute_generated(engine, source, [operation])
        assert normalized_rows(source) == [(1,), (None,), (2,)]
    finally:
        engine.close()


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_decimal_median_rejects_rounding_to_the_column_scale(backend: str) -> None:
    if backend == "pandas":
        engine = PandasEngine()
        source = pd.DataFrame(
            {
                "value": pd.Series(
                    [Decimal("1.25"), None, Decimal("1.26")],
                    dtype=pd.ArrowDtype(pa.decimal128(38, 2)),
                )
            }
        )
    elif backend == "polars":
        engine = PolarsEngine()
        source = pl.DataFrame({"value": pl.Series([Decimal("1.25"), None, Decimal("1.26")], dtype=pl.Decimal(38, 2))})
    else:
        engine = DuckDBEngine()
        source = duckdb.sql(
            "SELECT * FROM (VALUES (1.25::DECIMAL(38, 2)), (NULL::DECIMAL(38, 2)), "
            "(1.26::DECIMAL(38, 2))) AS source(value)"
        )
    operation = fill_step(bound_ref("c:source:0", "value", 0), {"kind": "median"})

    try:
        with pytest.raises(EngineError, match="decimal scale 2"):
            engine.apply_transform(source, operation)
        with pytest.raises(ValueError, match="decimal scale 2"):
            execute_generated(engine, source, [operation])
        assert normalized_rows(source) == [(Decimal("1.25"),), (None,), (Decimal("1.26"),)]
    finally:
        engine.close()


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_decimal_fill_rejects_rounding_to_the_column_scale(backend: str) -> None:
    if backend == "pandas":
        engine = PandasEngine()
        source = pd.DataFrame({"value": pd.Series([Decimal("1.25"), None], dtype=pd.ArrowDtype(pa.decimal128(38, 2)))})
    elif backend == "polars":
        engine = PolarsEngine()
        source = pl.DataFrame({"value": pl.Series([Decimal("1.25"), None], dtype=pl.Decimal(38, 2))})
    else:
        engine = DuckDBEngine()
        source = duckdb.sql("SELECT * FROM (VALUES (1.25::DECIMAL(38, 2)), (NULL::DECIMAL(38, 2))) AS source(value)")
    operation = fill_step(
        bound_ref("c:source:0", "value", 0),
        {"kind": "decimal", "value": "2.509"},
    )

    try:
        with pytest.raises(EngineError, match="decimal scale 2"):
            engine.apply_transform(source, operation)
        with pytest.raises(ValueError, match="decimal scale 2"):
            execute_generated(engine, source, [operation])
        assert normalized_rows(source) == [(Decimal("1.25"),), (None,)]
    finally:
        engine.close()


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
@pytest.mark.parametrize("column_aware", [False, True])
def test_datetime_fill_rejects_naive_and_aware_mismatches(backend: str, column_aware: bool) -> None:
    present = datetime(2026, 1, 1, 12, tzinfo=timezone.utc) if column_aware else datetime(2026, 1, 1, 12)
    replacement = "2026-08-05T18:20:00" if column_aware else "2026-08-05T18:20:00+02:00"
    if backend == "pandas":
        engine = PandasEngine()
        dtype = "datetime64[ns, UTC]" if column_aware else "datetime64[ns]"
        source = pd.DataFrame({"value": pd.Series([present, None], dtype=dtype)})
    elif backend == "polars":
        engine = PolarsEngine()
        dtype = pl.Datetime("us", "UTC") if column_aware else pl.Datetime("us")
        source = pl.DataFrame({"value": pl.Series([present, None], dtype=dtype)})
    else:
        engine = DuckDBEngine()
        raw_type = "TIMESTAMPTZ" if column_aware else "TIMESTAMP"
        source = duckdb.sql(
            f"SELECT * FROM (VALUES ({present.isoformat()!r}::{raw_type}), (NULL::{raw_type})) AS source(value)"
        )
    operation = fill_step(
        bound_ref("c:source:0", "value", 0),
        {"kind": "datetime", "value": replacement},
    )
    expected = "timezone-aware" if column_aware else "timezone-naive"

    try:
        with pytest.raises(EngineError, match=expected):
            engine.apply_transform(source, operation)
        with pytest.raises(ValueError, match=expected):
            execute_generated(engine, source, [operation])
    finally:
        engine.close()


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
@pytest.mark.parametrize("column_aware", [False, True])
def test_datetime_fill_accepts_matching_awareness(backend: str, column_aware: bool) -> None:
    present = datetime(2026, 1, 1, 12, tzinfo=timezone.utc) if column_aware else datetime(2026, 1, 1, 12)
    replacement = "2026-08-05T18:20:00+00:00" if column_aware else "2026-08-05T18:20:00"
    expected = datetime.fromisoformat(replacement)
    if backend == "pandas":
        engine = PandasEngine()
        dtype = "datetime64[ns, UTC]" if column_aware else "datetime64[ns]"
        source = pd.DataFrame({"value": pd.Series([present, None], dtype=dtype)})
    elif backend == "polars":
        engine = PolarsEngine()
        dtype = pl.Datetime("us", "UTC") if column_aware else pl.Datetime("us")
        source = pl.DataFrame({"value": pl.Series([present, None], dtype=dtype)})
    else:
        engine = DuckDBEngine()
        raw_type = "TIMESTAMPTZ" if column_aware else "TIMESTAMP"
        source = duckdb.sql(
            f"SELECT * FROM (VALUES ({present.isoformat()!r}::{raw_type}), (NULL::{raw_type})) AS source(value)"
        )
    operation = fill_step(
        bound_ref("c:source:0", "value", 0),
        {"kind": "datetime", "value": replacement},
    )

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])

        assert rows(live)[1][0] == expected
        assert rows(generated)[1][0] == expected
        assert normalized_rows(source)[1] == (None,)
    finally:
        engine.close()


def test_duckdb_uuid_fill_promotes_the_column_to_varchar() -> None:
    engine = DuckDBEngine()
    identifier = "123e4567-e89b-12d3-a456-426614174000"
    source = duckdb.sql(f"SELECT * FROM (VALUES ({identifier!r}::UUID), (NULL::UUID)) AS source(value)")
    operation = fill_step(
        bound_ref("c:source:0", "value", 0),
        {"kind": "string", "value": "unknown"},
    )

    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])

        assert rows(live) == [(identifier,), ("unknown",)]
        assert rows(generated) == rows(live)
    finally:
        engine.close()
