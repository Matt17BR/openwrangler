from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from math import isnan
from typing import Any

import duckdb
import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime._column_binding import ColumnBindingError, bind_step
from openwrangler_runtime.engines import DuckDBEngine, PandasEngine, PolarsEngine
from openwrangler_runtime.engines.base import EngineError
from openwrangler_runtime.lineage import source_lineage
from openwrangler_runtime.operations import OperationError, validate_step


@pytest.fixture(params=["pandas", "polars", "duckdb"])
def engine(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> Any:
    if request.param == "pandas":
        return PandasEngine()
    if request.param == "polars":
        for frame_type in (pl.DataFrame, pl.LazyFrame, pl.Series):
            monkeypatch.setattr(
                frame_type,
                "to_pandas",
                lambda *_args, **_kwargs: (_ for _ in ()).throw(
                    AssertionError("Polars interpolation must stay native")
                ),
                raising=False,
            )
        return PolarsEngine()
    runtime = DuckDBEngine()
    request.addfinalizer(runtime.close)
    return runtime


def frame_for(engine: Any, coordinates: list[Any], values: list[float | None], *, lazy: bool = False) -> Any:
    if isinstance(engine, PandasEngine):
        return pd.DataFrame({"coordinate": coordinates, "value": values})
    if isinstance(engine, PolarsEngine):
        frame = pl.DataFrame({"coordinate": coordinates, "value": values})
        return frame.lazy() if lazy else frame
    coordinate_sql = []
    for value in coordinates:
        if value is None:
            coordinate_sql.append("NULL::DOUBLE")
        elif isinstance(value, float) and value == float("inf"):
            coordinate_sql.append("'Infinity'::DOUBLE")
        else:
            coordinate_sql.append(f"{value!r}::DOUBLE")
    value_sql = [
        "NULL::DOUBLE"
        if value is None
        else "'NaN'::DOUBLE"
        if isinstance(value, float) and isnan(value)
        else "'Infinity'::DOUBLE"
        if value == float("inf")
        else f"{value!r}::DOUBLE"
        for value in values
    ]
    rows = ", ".join(f"({coordinate}, {value})" for coordinate, value in zip(coordinate_sql, value_sql, strict=True))
    return duckdb.sql(f"SELECT * FROM (VALUES {rows}) AS source(coordinate, value)")


def interpolation_step(engine: Any, frame: Any, *, max_gap: int | None = None) -> dict[str, Any]:
    schema = engine.schema(frame)
    lineage = source_lineage(schema)
    replacement: dict[str, Any] = {"kind": "linearInterpolation", "coordinate": lineage[0]}
    if max_gap is not None:
        replacement["maxGap"] = max_gap
    return bind_step(
        validate_step(
            {
                "id": "linear-interpolation",
                "kind": "fillMissingValues",
                "params": {"column": lineage[1], "replacement": replacement},
            }
        ),
        schema,
        lineage,
    )


def execute_generated(engine: Any, frame: Any, operation: dict[str, Any]) -> Any:
    source = engine.compile_plan([operation])
    assert "openwrangler_runtime" not in source
    namespace: dict[str, Any] = {}
    exec(compile(source, "<linear-interpolation>", "exec"), namespace, namespace)
    return namespace["clean_data"](frame)


def result_values(engine: Any, frame: Any) -> list[Any]:
    if isinstance(engine, PandasEngine):
        return list(frame.iloc[:, 1].array)
    if isinstance(engine, PolarsEngine):
        materialized = frame.collect() if isinstance(frame, pl.LazyFrame) else frame
        return materialized["value"].to_list()
    return [row[0] for row in engine._terminal_rows(frame, 'SELECT "value" FROM ow')]


def assert_values(actual: list[Any], expected: list[Any]) -> None:
    assert len(actual) == len(expected)
    for item, wanted in zip(actual, expected, strict=True):
        if wanted is None:
            assert item is None or pd.isna(item)
        elif isinstance(wanted, float) and isnan(wanted):
            assert isinstance(item, float) and isnan(item)
        else:
            assert item == pytest.approx(wanted)


def test_linear_interpolation_uses_real_distance_restores_order_and_matches_generated(engine: Any) -> None:
    coordinates = [10, 0, 4, 1, 7]
    values = [10.0, 0.0, None, float("nan"), None]
    frame = frame_for(engine, coordinates, values, lazy=isinstance(engine, PolarsEngine))
    before = result_values(engine, frame)
    operation = interpolation_step(engine, frame)

    live = engine.apply_transform(frame, operation)
    generated = execute_generated(engine, frame, operation)

    if isinstance(engine, PolarsEngine):
        assert isinstance(live, pl.LazyFrame)
        assert isinstance(generated, pl.LazyFrame)
    assert_values(result_values(engine, live), [10.0, 0.0, 4.0, 1.0, 7.0])
    assert_values(result_values(engine, generated), [10.0, 0.0, 4.0, 1.0, 7.0])
    assert_values(result_values(engine, frame), before)
    assert engine.schema(live)[1]["type"] == "float"


def test_linear_interpolation_respects_complete_gap_limit_and_boundaries(engine: Any) -> None:
    coordinates = [0, 1, 2, 3, 4, 5, 6]
    values = [None, 0.0, None, None, 8.0, float("inf"), None]
    frame = frame_for(engine, coordinates, values)
    operation = interpolation_step(engine, frame, max_gap=1)

    live = engine.apply_transform(frame, operation)
    generated = execute_generated(engine, frame, operation)

    expected = [None, 0.0, None, None, 8.0, float("inf"), None]
    assert_values(result_values(engine, live), expected)
    assert_values(result_values(engine, generated), expected)


@pytest.mark.parametrize(
    ("coordinates", "error"),
    [
        ([0.0, 0.0, 1.0], "unique"),
        ([0.0, None, 1.0], "present and finite"),
        ([0.0, float("inf"), 1.0], "present and finite"),
    ],
)
def test_linear_interpolation_rejects_invalid_coordinates(
    engine: Any,
    coordinates: list[float | None],
    error: str,
) -> None:
    frame = frame_for(engine, coordinates, [0.0, None, 1.0])
    operation = interpolation_step(engine, frame)

    with pytest.raises(EngineError, match=error):
        engine.apply_transform(frame, operation)
    with pytest.raises((EngineError, ValueError), match=error):
        execute_generated(engine, frame, operation)


def test_linear_interpolation_preserves_native_float32_target_type(engine: Any) -> None:
    if isinstance(engine, PandasEngine):
        frame = pd.DataFrame(
            {
                "coordinate": [0, 1, 2],
                "value": pd.Series([0.0, None, 2.0], dtype="Float32"),
            }
        )
    elif isinstance(engine, PolarsEngine):
        frame = pl.DataFrame(
            {
                "coordinate": [0, 1, 2],
                "value": pl.Series([0.0, None, 2.0], dtype=pl.Float32),
            }
        ).lazy()
    else:
        frame = duckdb.sql(
            "SELECT * FROM (VALUES (0, 0.0::FLOAT), (1, NULL::FLOAT), (2, 2.0::FLOAT)) AS source(coordinate, value)"
        )
    operation = interpolation_step(engine, frame)

    live = engine.apply_transform(frame, operation)
    generated = execute_generated(engine, frame, operation)

    assert_values(result_values(engine, live), [0.0, 1.0, 2.0])
    assert_values(result_values(engine, generated), [0.0, 1.0, 2.0])
    if isinstance(engine, PandasEngine):
        assert str(live.dtypes.iloc[1]) == "Float32"
        assert str(generated.dtypes.iloc[1]) == "Float32"
    elif isinstance(engine, PolarsEngine):
        assert live.collect_schema()["value"] == pl.Float32
        assert generated.collect_schema()["value"] == pl.Float32
    else:
        assert str(live.types[1]) == "FLOAT"
        assert str(generated.types[1]) == "FLOAT"


def test_linear_interpolation_stays_finite_across_opposite_float_extremes(engine: Any) -> None:
    frame = frame_for(engine, [-1e308, 0.0, 1e308], [-1e308, None, 1e308])
    operation = interpolation_step(engine, frame)

    live = result_values(engine, engine.apply_transform(frame, operation))
    generated = result_values(engine, execute_generated(engine, frame, operation))

    assert live[1] == pytest.approx(0.0, abs=1e292)
    assert generated[1] == pytest.approx(0.0, abs=1e292)


def test_linear_interpolation_supports_dates_and_datetimes(engine: Any) -> None:
    if isinstance(engine, PandasEngine):
        date_frame = pd.DataFrame(
            {"coordinate": [date(2024, 1, 1), date(2024, 1, 2), date(2024, 1, 4)], "value": [0.0, None, 9.0]}
        )
        datetime_frame = pd.DataFrame(
            {
                "coordinate": pd.to_datetime(
                    ["2024-01-01T00:00:00Z", "2024-01-01T06:00:00Z", "2024-01-02T00:00:00Z"],
                    utc=True,
                ),
                "value": [0.0, None, 24.0],
            }
        )
    elif isinstance(engine, PolarsEngine):
        date_frame = pl.DataFrame(
            {"coordinate": [date(2024, 1, 1), date(2024, 1, 2), date(2024, 1, 4)], "value": [0.0, None, 9.0]}
        )
        datetime_frame = pl.DataFrame(
            {
                "coordinate": pl.Series(
                    [
                        datetime(2024, 1, 1, tzinfo=timezone.utc),
                        datetime(2024, 1, 1, 6, tzinfo=timezone.utc),
                        datetime(2024, 1, 2, tzinfo=timezone.utc),
                    ],
                    dtype=pl.Datetime("us", "UTC"),
                ),
                "value": [0.0, None, 24.0],
            }
        ).lazy()
    else:
        date_frame = duckdb.sql(
            "SELECT * FROM (VALUES (DATE '2024-01-01', 0.0::DOUBLE), "
            "(DATE '2024-01-02', NULL::DOUBLE), (DATE '2024-01-04', 9.0::DOUBLE)) "
            "AS source(coordinate, value)"
        )
        datetime_frame = duckdb.sql(
            "SELECT * FROM (VALUES (TIMESTAMPTZ '2024-01-01 00:00:00+00', 0.0::DOUBLE), "
            "(TIMESTAMPTZ '2024-01-01 06:00:00+00', NULL::DOUBLE), "
            "(TIMESTAMPTZ '2024-01-02 00:00:00+00', 24.0::DOUBLE)) AS source(coordinate, value)"
        )

    for frame, expected in ((date_frame, 3.0), (datetime_frame, 6.0)):
        operation = interpolation_step(engine, frame)
        assert_values(
            result_values(engine, engine.apply_transform(frame, operation)),
            [0.0, expected, 9.0 if expected == 3 else 24.0],
        )
        assert_values(
            result_values(engine, execute_generated(engine, frame, operation)),
            [0.0, expected, 9.0 if expected == 3 else 24.0],
        )


def test_linear_interpolation_supports_decimal_coordinates(engine: Any) -> None:
    if isinstance(engine, PandasEngine):
        frame = pd.DataFrame(
            {
                "coordinate": [Decimal("0.00"), Decimal("0.10"), Decimal("1.00")],
                "value": [0.0, None, 10.0],
            }
        )
    elif isinstance(engine, PolarsEngine):
        frame = pl.DataFrame(
            {
                "coordinate": pl.Series(
                    [Decimal("0.00"), Decimal("0.10"), Decimal("1.00")],
                    dtype=pl.Decimal(10, 2),
                ),
                "value": [0.0, None, 10.0],
            }
        ).lazy()
    else:
        frame = duckdb.sql(
            "SELECT * FROM (VALUES (0.00::DECIMAL(10, 2), 0.0::DOUBLE), "
            "(0.10::DECIMAL(10, 2), NULL::DOUBLE), (1.00::DECIMAL(10, 2), 10.0::DOUBLE)) "
            "AS source(coordinate, value)"
        )
    operation = interpolation_step(engine, frame)

    live = engine.apply_transform(frame, operation)
    generated = execute_generated(engine, frame, operation)

    assert_values(result_values(engine, live), [0.0, 1.0, 10.0])
    assert_values(result_values(engine, generated), [0.0, 1.0, 10.0])


@pytest.mark.parametrize("backend", ["polars-decimal", "duckdb-bigint", "duckdb-decimal"])
def test_linear_interpolation_preserves_high_offset_irregular_distances(backend: str) -> None:
    offset = 9_007_199_254_740_993
    if backend == "polars-decimal":
        engine: Any = PolarsEngine()
        frame = pl.DataFrame(
            {
                "coordinate": pl.Series(
                    [Decimal(offset), Decimal(offset + 1), Decimal(offset + 3)],
                    dtype=pl.Decimal(38, 0),
                ),
                "value": [0.0, None, 3.0],
            }
        ).lazy()
    else:
        engine = DuckDBEngine()
        coordinate_type = "BIGINT" if backend == "duckdb-bigint" else "DECIMAL(38, 0)"
        frame = duckdb.sql(
            f"SELECT * FROM (VALUES ({offset}::{coordinate_type}, 0.0::DOUBLE), "
            f"({offset + 1}::{coordinate_type}, NULL::DOUBLE), "
            f"({offset + 3}::{coordinate_type}, 3.0::DOUBLE)) AS source(coordinate, value)"
        )
    try:
        operation = interpolation_step(engine, frame)
        assert_values(result_values(engine, engine.apply_transform(frame, operation)), [0.0, 1.0, 3.0])
        assert_values(result_values(engine, execute_generated(engine, frame, operation)), [0.0, 1.0, 3.0])
    finally:
        if isinstance(engine, DuckDBEngine):
            engine.close()


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_linear_interpolation_accepts_typed_empty_frames_live_and_generated(backend: str) -> None:
    if backend == "pandas":
        engine: Any = PandasEngine()
        frame = pd.DataFrame(
            {
                "coordinate": pd.Series([], dtype="int64"),
                "value": pd.Series([], dtype="Float32"),
            }
        )
    elif backend == "polars":
        engine = PolarsEngine()
        frame = pl.DataFrame(
            {
                "coordinate": pl.Series([], dtype=pl.Int64),
                "value": pl.Series([], dtype=pl.Float32),
            }
        ).lazy()
    else:
        engine = DuckDBEngine()
        frame = duckdb.sql('SELECT NULL::BIGINT AS coordinate, NULL::FLOAT AS "value" WHERE FALSE')
    try:
        operation = interpolation_step(engine, frame)
        assert result_values(engine, engine.apply_transform(frame, operation)) == []
        assert result_values(engine, execute_generated(engine, frame, operation)) == []
    finally:
        if isinstance(engine, DuckDBEngine):
            engine.close()


def test_linear_interpolation_validation_and_binding_are_strict() -> None:
    target = {"id": "c:target", "name": "value"}
    coordinate = {"id": "c:coordinate", "name": "coordinate"}
    normalized = validate_step(
        {
            "id": "linear",
            "kind": "fillMissingValues",
            "params": {
                "column": target,
                "replacement": {"kind": "linearInterpolation", "coordinate": coordinate, "maxGap": 3},
            },
        }
    )
    assert normalized["params"]["replacement"] == {
        "kind": "linearInterpolation",
        "coordinate": coordinate,
        "maxGap": 3,
    }
    with pytest.raises(OperationError, match="maxGap"):
        validate_step(
            {
                "id": "bad-gap",
                "kind": "fillMissingValues",
                "params": {
                    "column": target,
                    "replacement": {"kind": "linearInterpolation", "coordinate": coordinate, "maxGap": 0},
                },
            }
        )
    with pytest.raises(OperationError, match="coordinate column"):
        validate_step(
            {
                "id": "same-column",
                "kind": "fillMissingValues",
                "params": {
                    "column": target,
                    "replacement": {"kind": "linearInterpolation", "coordinate": target},
                },
            }
        )
    with pytest.raises(ColumnBindingError, match="floating-point"):
        bind_step(
            normalized,
            [{"name": "coordinate", "type": "integer"}, {"name": "value", "type": "integer"}],
            [coordinate, target],
        )


def test_pandas_linear_interpolation_addresses_duplicate_labels_by_position() -> None:
    engine = PandasEngine()
    frame = pd.DataFrame([[100.0, 0, 0.0], [200.0, 1, None], [300.0, 4, 8.0]], columns=["value", "x", "value"])
    operation = {
        "id": "duplicate-label-interpolation",
        "kind": "fillMissingValues",
        "params": {
            "column": {"id": "c:target", "name": "value", "position": 2},
            "replacement": {
                "kind": "linearInterpolation",
                "coordinate": {"id": "c:coordinate", "name": "x", "position": 1},
            },
        },
    }

    live = engine.apply_transform(frame, operation)
    generated = execute_generated(engine, frame, operation)

    assert list(live.iloc[:, 0]) == [100.0, 200.0, 300.0]
    assert list(live.iloc[:, 2]) == [0.0, 2.0, 8.0]
    assert list(generated.iloc[:, 2]) == [0.0, 2.0, 8.0]


def test_duckdb_linear_interpolation_avoids_internal_name_collisions() -> None:
    engine = DuckDBEngine()
    try:
        frame = duckdb.sql(
            "SELECT * FROM (VALUES (0, 0.0::DOUBLE, 10), (1, NULL::DOUBLE, 20), (2, 2.0::DOUBLE, 30)) "
            'AS source(coordinate, value, "__ow_interpolation_original")'
        )
        operation = interpolation_step(engine, frame)
        live = engine.apply_transform(frame, operation)
        generated = execute_generated(engine, frame, operation)
        assert list(live.columns) == list(frame.columns)
        assert list(generated.columns) == list(frame.columns)
        assert_values(result_values(engine, live), [0.0, 1.0, 2.0])
        assert_values(result_values(engine, generated), [0.0, 1.0, 2.0])
    finally:
        engine.close()


def test_duckdb_and_polars_reject_128_bit_integer_coordinates() -> None:
    duckdb_engine = DuckDBEngine()
    try:
        duckdb_frame = duckdb.sql(
            "SELECT * FROM (VALUES (0::HUGEINT, 0.0::DOUBLE), (1::HUGEINT, NULL::DOUBLE), "
            "(2::HUGEINT, 2.0::DOUBLE)) AS source(coordinate, value)"
        )
        duckdb_operation = interpolation_step(duckdb_engine, duckdb_frame)
        with pytest.raises(EngineError, match="HUGEINT"):
            duckdb_engine.apply_transform(duckdb_frame, duckdb_operation)
        with pytest.raises(ValueError, match="HUGEINT"):
            execute_generated(duckdb_engine, duckdb_frame, duckdb_operation)
    finally:
        duckdb_engine.close()

    polars_engine = PolarsEngine()
    polars_frame = pl.DataFrame(
        {
            "coordinate": pl.Series([0, 1, 2], dtype=pl.Int128),
            "value": [0.0, None, 2.0],
        }
    ).lazy()
    polars_operation = interpolation_step(polars_engine, polars_frame)
    with pytest.raises(EngineError, match="128-bit"):
        polars_engine.apply_transform(polars_frame, polars_operation)
    with pytest.raises(ValueError, match="128-bit"):
        execute_generated(polars_engine, polars_frame, polars_operation)
