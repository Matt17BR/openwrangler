from __future__ import annotations

from decimal import Decimal, localcontext
from math import isfinite
from typing import Any

import duckdb
import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime._column_binding import bind_step
from openwrangler_runtime.engines import DuckDBEngine, PandasEngine, PolarsEngine
from openwrangler_runtime.engines.duckdb_engine import DuckDBSqlPlan
from openwrangler_runtime.lineage import source_lineage
from openwrangler_runtime.operations import validate_step


@pytest.fixture(params=["pandas", "polars", "polars-lazy", "duckdb"])
def engine(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> tuple[Any, bool]:
    if request.param == "pandas":
        return PandasEngine(), False
    if request.param.startswith("polars"):
        monkeypatch.setattr(pl.DataFrame, "to_pandas", lambda *_args, **_kwargs: pytest.fail("Polars must stay native"))
        return PolarsEngine(), request.param == "polars-lazy"
    for method in ("arrow", "df", "fetch_arrow_table", "fetchdf", "pl", "to_arrow_table", "to_df"):
        if hasattr(duckdb.DuckDBPyRelation, method):
            monkeypatch.setattr(
                duckdb.DuckDBPyRelation,
                method,
                lambda *_args, **_kwargs: pytest.fail("DuckDB must stay native"),
            )
    adapter = DuckDBEngine()
    request.addfinalizer(adapter.close)
    return adapter, False


def frame_for(engine: tuple[Any, bool], values: list[Any], kind: str) -> Any:
    adapter, lazy = engine
    if isinstance(adapter, PandasEngine):
        dtype = (
            "Float64"
            if kind == "DOUBLE"
            else "Int64"
            if kind == "BIGINT"
            else "UInt64"
            if kind == "UBIGINT"
            else object
        )
        frame = pd.DataFrame({"value": pd.Series(values, dtype=dtype), "__ow_scale_value": range(len(values))})
        frame.index = pd.Index(["same"] * len(values), name="source index")
        return frame
    if isinstance(adapter, PolarsEngine):
        dtype = {
            "DOUBLE": pl.Float64,
            "BIGINT": pl.Int64,
            "UBIGINT": pl.UInt64,
            "HUGEINT": pl.Int128,
            "UHUGEINT": pl.UInt128,
            "DECIMAL(38,18)": pl.Decimal(38, 18),
            "DECIMAL(38,0)": pl.Decimal(38, 0),
        }[kind]
        frame = pl.DataFrame({"value": pl.Series(values, dtype=dtype), "__ow_scale_value": range(len(values))})
        return frame.lazy() if lazy else frame
    if not values:
        return duckdb.sql(f"SELECT NULL::{kind} AS value, 0 AS __ow_scale_value WHERE FALSE")
    rows = ", ".join(
        f"(NULL::{kind}, {index})" if value is None else f"('{value}'::{kind}, {index})"
        for index, value in enumerate(values)
    )
    return duckdb.sql(f"SELECT * FROM (VALUES {rows}) source(value, __ow_scale_value)")


def column_values(frame: Any, column: str) -> list[Any]:
    if isinstance(frame, pl.LazyFrame):
        frame = frame.collect()
    if isinstance(frame, pd.DataFrame):
        return frame[column].tolist()
    if isinstance(frame, pl.DataFrame):
        return frame[column].to_list()
    if isinstance(frame, DuckDBSqlPlan):
        with duckdb.connect(config={"enable_external_file_cache": False}) as connection:
            return [row[0] for row in connection.execute(f'SELECT "{column}" FROM ({frame.sql}) ow').fetchall()]
    return [row[0] for row in frame.project(f'"{column}"').fetchall()]


def expected_ratios(values: list[Any]) -> list[float | None]:
    finite = [Decimal(value) for value in values if value is not None and isfinite(value)]
    if not finite:
        return [None] * len(values)
    with localcontext() as context:
        context.prec = 800
        minimum, maximum = min(finite), max(finite)
        return [
            None
            if value is None or not isfinite(value)
            else float((Decimal(value) - minimum) / (maximum - minimum))
            if maximum != minimum
            else 0.0
            for value in values
        ]


def scaled_frames(adapter: Any, source: Any, *, inplace: bool = True) -> tuple[Any, Any]:
    schema = adapter.schema(source)
    lineage = source_lineage(schema)
    operation = bind_step(
        validate_step(
            {
                "id": "scale",
                "kind": "minMaxScale",
                "params": {"column": lineage[0], **({} if inplace else {"newColumn": "scaled"})},
            }
        ),
        schema,
        lineage,
    )
    namespace: dict[str, Any] = {}
    exec(adapter.compile_plan([operation]), namespace, namespace)
    return adapter.apply_transform(source, operation), namespace["clean_data"](source)


def assert_scaling(engine: tuple[Any, bool], values: list[Any], kind: str, *, inplace: bool = False) -> None:
    adapter, _lazy = engine
    source = frame_for(engine, values, kind)
    expected = expected_ratios(values)
    for result in scaled_frames(adapter, source, inplace=inplace):
        actual = column_values(result, "value" if inplace else "scaled")
        assert len(actual) == len(expected)
        for value, ratio in zip(actual, expected, strict=True):
            if ratio is None:
                assert pd.isna(value)
            else:
                assert isfinite(value) and 0 <= value <= 1
                assert value == pytest.approx(ratio, rel=1e-15, abs=0)
                if ratio in {0.0, 1.0}:
                    assert value == ratio
        assert column_values(result, "__ow_scale_value") == list(range(len(values)))
        if isinstance(source, pd.DataFrame):
            assert result.index.equals(source.index)
    # Cleaning must leave the input column and unrelated values unchanged.
    original = column_values(source, "value")
    for actual, expected_value in zip(original, values, strict=True):
        assert pd.isna(actual) if expected_value is None or pd.isna(expected_value) else actual == expected_value


@pytest.mark.parametrize(
    "values",
    [
        [-1e308, 0.0, 1e308, None, float("nan"), float("inf"), float("-inf")],
        [-1.7976931348623157e308, -1e308, 0.0, 1.7976931348623157e308],
        [-1.5e308, -1e308, 0.0, 1e308],
        [1e308, 1.25e308, 1.5e308],
        [0.0, 5e-324, 1e-323],
        [-5e-324, 0.0, 5e-324],
        [5e-324, 1e-323, 1.5e-323],
        [0.0, 1e-310, 2e-310],
        [None, float("nan"), float("inf"), float("-inf")],
        [1e308, None, 1e308],
        [],
    ],
)
def test_floating_ranges_stay_finite_in_live_and_generated_code(engine, values):
    assert_scaling(engine, values, "DOUBLE")


@pytest.mark.parametrize(
    ("kind", "values"),
    [
        ("BIGINT", [-(2**63), 0, 2**63 - 1, None]),
        ("BIGINT", [2**63 - 3, 2**63 - 2, 2**63 - 1, None]),
        ("BIGINT", [2**53, 2**53 + 1, 2**53 + 2]),
        ("UBIGINT", [2**64 - 3, 2**64 - 2, 2**64 - 1]),
        ("HUGEINT", [-(2**127), 0, 2**127 - 1]),
        ("HUGEINT", [10**38 - 3, 10**38 - 2, 10**38 - 1]),
        ("HUGEINT", [2**64 - 1, 2**64, 2**64 + 1]),
        ("HUGEINT", [-(2**64) - 1, -(2**64), -(2**64) + 1]),
        ("UHUGEINT", [0, 2**127, 2**128 - 1]),
        ("UHUGEINT", [2**128 - 3, 2**128 - 2, 2**128 - 1]),
        ("UHUGEINT", [2**127 - 1, 2**127, 2**127 + 1]),
        ("HUGEINT", [10**38 - 1, None, 10**38 - 1]),
        ("HUGEINT", [None, None]),
    ],
)
def test_integer_differences_are_exact_before_scaling(engine, kind, values):
    assert_scaling(engine, values, kind, inplace=True)


@pytest.mark.parametrize(
    ("kind", "values"),
    [
        (
            "DECIMAL(38,18)",
            [Decimal("1.000000000000000001"), Decimal("1.000000000000000002"), Decimal("1.000000000000000003"), None],
        ),
        (
            "DECIMAL(38,18)",
            [Decimal("-1.000000000000000003"), Decimal("-1.000000000000000002"), Decimal("-1.000000000000000001")],
        ),
        ("DECIMAL(38,0)", [Decimal(-(10**38) + 1), Decimal(0), Decimal(10**38 - 1)]),
        ("DECIMAL(38,0)", [Decimal(10**38 - 3), Decimal(10**38 - 2), Decimal(10**38 - 1)]),
    ],
)
def test_decimal_differences_survive_scaling_and_caller_precision(engine, kind, values):
    with localcontext() as context:
        context.prec = 6
        assert_scaling(engine, values, kind)


@pytest.mark.parametrize(
    "dtype", ["int8", "Int8", "int16", "Int16", "int32", "Int32", "uint8", "UInt8", "uint16", "UInt16"]
)
def test_pandas_native_integer_scaling_widens_storage_and_preserves_nullable_cells(dtype):
    import numpy as np

    limits = np.iinfo(dtype.lower())
    values: list[int | None] = [int(limits.min), 0 if limits.min < 0 else limits.max // 2, int(limits.max)]
    if dtype[0].isupper():
        values.append(None)
    source = pd.DataFrame({"value": pd.Series(values, dtype=dtype)})
    for result in scaled_frames(PandasEngine(), source):
        assert result["value"].iloc[:3].tolist() == pytest.approx(expected_ratios(values)[:3])
        if dtype[0].isupper():
            assert result["value"].iloc[-1] is pd.NA
    assert source["value"].dtype == dtype


@pytest.mark.parametrize("dtype", ["float32", "Float32"])
@pytest.mark.parametrize("tiny", [False, True])
def test_pandas_float32_scaling_widens_before_arithmetic(dtype, tiny):
    import numpy as np

    limit = float(np.nextafter(np.float32(0), np.float32(1))) if tiny else float(np.finfo("float32").max)
    source = pd.DataFrame({"value": pd.Series([-limit, 0.0, limit, None], dtype=dtype)})
    for result in scaled_frames(PandasEngine(), source):
        assert result["value"].iloc[:3].tolist() == [0.0, 0.5, 1.0]
        assert pd.isna(result["value"].iloc[-1])
    assert source["value"].iloc[:3].tolist() == [-limit, 0.0, limit]


def test_pandas_numeric_text_keeps_integer_differences_after_coercion():
    source = pd.DataFrame({"value": [str(2**53 + offset) for offset in range(3)]})
    for result in scaled_frames(PandasEngine(), source):
        assert result["value"].tolist() == [0.0, 0.5, 1.0]
