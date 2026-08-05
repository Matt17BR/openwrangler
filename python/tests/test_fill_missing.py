from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from math import isnan
from typing import Any

import duckdb
import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime.engines import DuckDBEngine, EngineError, PandasEngine, PolarsEngine
from openwrangler_runtime.engines.duckdb_engine import DuckDBSqlPlan


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
    return [tuple(None if isinstance(value, float) and isnan(value) else value for value in row) for row in rows(frame)]


def execute_generated(engine: Any, frame: Any, plan: list[dict[str, Any]]) -> Any:
    namespace: dict[str, Any] = {}
    code = engine.compile_plan(plan)
    assert "openwrangler_runtime" not in code
    exec(compile(code, "<generated-fill-plan>", "exec"), namespace, namespace)
    return namespace["clean_data"](frame)


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
        columns=["duplicate", "duplicate", 7],
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
