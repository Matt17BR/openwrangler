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
        index=[0, 0, 1],
        columns=["duplicate", "duplicate", 7],
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
