from __future__ import annotations

from collections.abc import Sequence
from math import copysign, inf, isfinite, isnan, nextafter
from typing import Any

import duckdb
import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime._column_binding import bind_step
from openwrangler_runtime.engines import DuckDBEngine, PandasEngine, PolarsEngine
from openwrangler_runtime.engines.duckdb_engine import DuckDBSqlPlan
from openwrangler_runtime.lineage import derive_lineage, source_lineage
from openwrangler_runtime.operations import validate_step


@pytest.fixture(params=["pandas", "polars", "polars-lazy", "duckdb"])
def engine(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> tuple[Any, bool]:
    if request.param == "pandas":
        return PandasEngine(), False
    if request.param.startswith("polars"):
        monkeypatch.setattr(pl.DataFrame, "to_pandas", lambda *_a, **_k: pytest.fail("Polars must stay native"))
        return PolarsEngine(), request.param == "polars-lazy"
    for method in ("arrow", "df", "fetch_arrow_table", "fetchdf", "pl", "to_arrow_table", "to_df"):
        if hasattr(duckdb.DuckDBPyRelation, method):
            monkeypatch.setattr(
                duckdb.DuckDBPyRelation, method, lambda *_a, **_k: pytest.fail("DuckDB must stay native")
            )
    adapter = DuckDBEngine()
    request.addfinalizer(adapter.close)
    return adapter, False


def frame_for(engine: tuple[Any, bool], values: Sequence[float | None]) -> Any:
    adapter, lazy = engine
    if isinstance(adapter, PandasEngine):
        frame = pd.DataFrame({"value": values, "kept": range(len(values))})
        frame.index = pd.Index(["same"] * len(values), name="source index")
        return frame.astype({"value": "float64"})
    if isinstance(adapter, PolarsEngine):
        frame = pl.DataFrame({"value": pl.Series(values, dtype=pl.Float64), "kept": range(len(values))})
        return frame.lazy() if lazy else frame
    if not values:
        return duckdb.sql("SELECT NULL::DOUBLE AS value, 0 AS kept WHERE FALSE")
    rows = ",".join(
        f"(NULL::DOUBLE,{index})" if value is None else f"('{value}'::DOUBLE,{index})"
        for index, value in enumerate(values)
    )
    return duckdb.sql(f"SELECT * FROM (VALUES {rows}) source(value,kept)")


def values_for(frame: Any, column: str) -> list[Any]:
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


def rounded_frames(adapter: Any, source: Any, decimals: int, *, replace: bool = False) -> tuple[Any, Any]:
    schema = adapter.schema(source)
    lineage = source_lineage(schema)
    operation = bind_step(
        validate_step(
            {
                "id": "round",
                "kind": "roundNumber",
                "params": {
                    "column": lineage[0],
                    "decimals": decimals,
                    **({} if replace else {"newColumn": "rounded"}),
                },
            }
        ),
        schema,
        lineage,
    )
    namespace: dict[str, Any] = {}
    exec(adapter.compile_plan([operation]), namespace)
    live = adapter.apply_transform(source, operation)
    generated = namespace["clean_data"](source)
    for result in (live, generated):
        output_lineage = derive_lineage(lineage, adapter.schema(result), operation)
        assert output_lineage[: len(lineage)] == lineage
        if not replace:
            assert output_lineage[-1]["id"] not in {column["id"] for column in lineage}
        if isinstance(source, pl.LazyFrame):
            assert isinstance(result, pl.LazyFrame)
        if isinstance(source, pd.DataFrame):
            assert isinstance(result, pd.DataFrame)
            pd.testing.assert_index_equal(result.index, source.index)
    return live, generated


def float_oracle(value: float | None, decimals: int) -> float | None:
    if value is None or not isfinite(value):
        return value
    try:
        return round(value, decimals)
    except OverflowError:
        return copysign(inf, value)


def assert_float_values(actual: list[Any], expected: Sequence[float | None]) -> None:
    assert len(actual) == len(expected)
    for value, wanted in zip(actual, expected, strict=True):
        if wanted is None or isnan(wanted):
            assert pd.isna(value)
        elif wanted == 0:
            assert value == 0
            assert copysign(1, value) == copysign(1, wanted)
        elif not isfinite(wanted):
            assert value == wanted
        else:
            assert value == pytest.approx(wanted, rel=2e-15, abs=0)


@pytest.mark.parametrize("decimals", [-(10**12), -309, -308, -100, -23, -22, -1, 0, 1, 308, 324, 10**12])
def test_round_finite_ranges_special_values_and_parameter_limits(engine, decimals: int) -> None:
    adapter, _ = engine
    values = [
        0.0,
        -0.0,
        1.5,
        2.5,
        -1.5,
        -2.5,
        15.0,
        25.0,
        -15.0,
        -25.0,
        1e308,
        -1e308,
        nextafter(inf, 0),
        None,
        float("nan"),
        inf,
        -inf,
    ]
    source = frame_for(engine, values)
    before = values_for(source, "value")
    expected = [float_oracle(value, decimals) for value in values]
    for result in rounded_frames(adapter, source, decimals):
        assert_float_values(values_for(result, "rounded"), expected)
        assert_float_values(values_for(result, "value"), before)
        assert values_for(result, "kept") == list(range(len(values)))
    assert_float_values(values_for(source, "value"), before)


@pytest.mark.parametrize(
    "decimals, midpoint", [(-1, 25.0), (-22, 7.5e22), (-23, 5.0000000000000004e22), (-100, 5e99), (-308, 1.5e308)]
)
def test_round_coarse_midpoint_neighbors(engine, decimals: int, midpoint: float) -> None:
    adapter, _ = engine
    positives = [nextafter(midpoint, 0), midpoint, nextafter(midpoint, inf)]
    values = [*positives, *(-value for value in positives)]
    source = frame_for(engine, values)
    expected = [float_oracle(value, decimals) for value in values]
    for result in rounded_frames(adapter, source, decimals, replace=True):
        assert_float_values(values_for(result, "value"), expected)
    assert_float_values(values_for(source, "value"), values)


@pytest.mark.parametrize("decimals", [309, 310, 320, 323, 324])
def test_round_subnormal_precision(engine, decimals: int) -> None:
    adapter, _ = engine
    values = [0.0, -0.0, 5e-324, -5e-324, 1e-310, -1e-310, 1e-300, None]
    expected = [float_oracle(value, decimals) for value in values]
    for result in rounded_frames(adapter, frame_for(engine, values), decimals):
        assert_float_values(values_for(result, "rounded"), expected)


@pytest.mark.parametrize("values", [[], [None, None]])
@pytest.mark.parametrize("decimals", [-(10**12), -100, -1, 309, 10**12])
def test_round_empty_and_all_missing(engine, values: list[None], decimals: int) -> None:
    adapter, _ = engine
    for result in rounded_frames(adapter, frame_for(engine, values), decimals):
        assert_float_values(values_for(result, "rounded"), values)


@pytest.mark.parametrize(
    "dtype",
    [
        "int8",
        "Int8",
        "int16",
        "Int16",
        "int32",
        "Int32",
        "int64",
        "Int64",
        "uint8",
        "UInt8",
        "uint16",
        "UInt16",
        "uint32",
        "UInt32",
        "uint64",
        "UInt64",
        "int64[pyarrow]",
        "uint64[pyarrow]",
    ],
)
@pytest.mark.parametrize("decimals", [-(10**12), -20, -19, -1, 10**12])
def test_pandas_round_retains_exact_integer_values(dtype: str, decimals: int) -> None:
    import numpy as np

    native_dtype = dtype.lower().removesuffix("[pyarrow]")
    bounds = np.iinfo(native_dtype)
    values = [int(bounds.min), int(bounds.max), 15, 25]
    nullable = dtype[0].isupper() or dtype.endswith("[pyarrow]")
    source = pd.DataFrame({"value": pd.Series([*values, *([None] if nullable else [])], dtype=dtype)})
    source.index = pd.Index(["same"] * len(source), name="source index")
    before = source.copy(deep=True)
    expected = [0 if decimals <= -20 else round(value, decimals) for value in values]
    for result in rounded_frames(PandasEngine(), source, decimals):
        actual = result["rounded"].tolist()
        assert actual[: len(values)] == expected
        if nullable:
            assert pd.isna(actual[-1])
        if all(bounds.min <= value <= bounds.max for value in expected):
            assert result["rounded"].dtype == source["value"].dtype
    pd.testing.assert_frame_equal(source, before)


@pytest.mark.parametrize("dtype", ["float32", "Float32", "float64", "Float64", "float[pyarrow]", "double[pyarrow]"])
@pytest.mark.parametrize("decimals", [-(10**12), -100, -39, -1, 10, 39, 45, 309, 10**12])
def test_pandas_round_preserves_float_storage(dtype: str, decimals: int) -> None:
    source = pd.DataFrame({"value": pd.Series([1e30, 1.5, -0.0, 1e-39, None, inf, -inf], dtype=dtype)})
    before = source.copy(deep=True)
    expected = [float_oracle(float(value), decimals) if not pd.isna(value) else None for value in source["value"]]
    # The operation preserves Float32 storage, so its final result has the
    # representable precision of that storage rather than a widened dtype.
    expected = pd.Series(expected, dtype=dtype).tolist()
    for result in rounded_frames(PandasEngine(), source, decimals):
        assert result["rounded"].dtype == source["value"].dtype
        assert_float_values(
            result["rounded"].tolist(), [None if pd.isna(value) else float(value) for value in expected]
        )
    pd.testing.assert_frame_equal(source, before)


@pytest.mark.parametrize("decimals", [-22, -15, -11, 11, 15, 39, 308])
def test_pandas_arrow_round_uses_double_precision_scales(decimals: int) -> None:
    unit = float(f"1e{-decimals}")
    values = [unit, -unit, 1.25 * unit, -0.0, None, inf, -inf]
    source = pd.DataFrame({"value": pd.Series(values, dtype="double[pyarrow]")})
    before = source.copy(deep=True)
    expected = [float_oracle(value, decimals) for value in values]
    for result in rounded_frames(PandasEngine(), source, decimals):
        assert result["rounded"].dtype == source["value"].dtype
        assert_float_values(result["rounded"].tolist(), expected)
    pd.testing.assert_frame_equal(source, before)


@pytest.mark.parametrize("dtype", ["bool", "boolean"])
@pytest.mark.parametrize("decimals", [-(10**12), -1, 0, 10**12])
def test_pandas_round_preserves_boolean_coercion(dtype: str, decimals: int) -> None:
    source = pd.DataFrame({"value": pd.Series([True, False], dtype=dtype)})
    for result in rounded_frames(PandasEngine(), source, decimals):
        pd.testing.assert_series_equal(result["rounded"], pd.Series([True, False], dtype=dtype, name="rounded"))


@pytest.mark.parametrize("decimals, expected", [(2, [2.68, 1.12, 1.38]), (-1, [0.0, 0.0, 0.0])])
def test_round_preserves_numeric_text_coercion(engine, decimals: int, expected: list[float]) -> None:
    adapter, lazy = engine
    values = ["2.675", "1.125", "1.375", "invalid", None]
    if isinstance(adapter, PandasEngine):
        source = pd.DataFrame({"value": pd.Series(values, dtype=object)})
    elif isinstance(adapter, PolarsEngine):
        source = pl.DataFrame({"value": values})
        if lazy:
            source = source.lazy()
    else:
        source = duckdb.sql("SELECT value FROM (VALUES ('2.675'),('1.125'),('1.375'),('invalid'),(NULL)) source(value)")
    for result in rounded_frames(adapter, source, decimals):
        assert_float_values(values_for(result, "rounded"), [*expected, None, None])
        assert values_for(result, "value") == values
    assert values_for(source, "value") == values


@pytest.mark.parametrize("arrow_type", ["float", "double"])
@pytest.mark.parametrize("decimals", [-(10**12), -100, -11, 11, 39, 309, 10**12])
def test_pandas_arrow_round_preserves_valid_nan_and_null(arrow_type: str, decimals: int) -> None:
    import pyarrow as pa

    values = pa.array(
        [None, float("nan"), 1.25, -0.0, inf, -inf], type=pa.type_for_alias(arrow_type), from_pandas=False
    )
    source = pd.DataFrame({"value": pd.Series(pd.arrays.ArrowExtensionArray(values))})
    before = source.copy(deep=True)
    for result in rounded_frames(PandasEngine(), source, decimals):
        assert result["rounded"].dtype == source["value"].dtype
        assert result["rounded"].isna().tolist() == [True, False, False, False, False, False]
        assert isnan(result["rounded"].iloc[1])
        assert_float_values(
            result["rounded"].tolist(),
            [float_oracle(value, decimals) for value in [None, float("nan"), 1.25, -0.0, inf, -inf]],
        )
    pd.testing.assert_frame_equal(source, before)


@pytest.mark.parametrize("dtype", ["float32", "Float32", "float[pyarrow]"])
@pytest.mark.parametrize("decimals, expected", [(-35, [inf, -inf]), (-36, [3.4e38, -3.4e38])])
def test_pandas_round_float32_final_range(dtype: str, decimals: int, expected: list[float]) -> None:
    import numpy as np

    maximum = float(np.finfo(np.float32).max)
    source = pd.DataFrame({"value": pd.Series([maximum, -maximum, None], dtype=dtype)})
    before = source.copy(deep=True)
    expected = pd.Series([*expected, None], dtype=dtype).tolist()
    for result in rounded_frames(PandasEngine(), source, decimals):
        assert result["rounded"].dtype == source["value"].dtype
        assert_float_values(
            result["rounded"].tolist(), [None if pd.isna(value) else float(value) for value in expected]
        )
    pd.testing.assert_frame_equal(source, before)


@pytest.mark.parametrize("decimals", [-(10**12), -6, -5, -4, -1, 0, 1, 4, 5, 7, 8, 10**12])
def test_pandas_round_float16_storage_range(decimals: int) -> None:
    import numpy as np

    info = np.finfo(np.float16)
    values = [float(info.max), -float(info.max), 1.5, -0.0, float(info.smallest_subnormal), None, inf, -inf]
    source = pd.DataFrame({"value": pd.Series(values, dtype="float16")})
    before = source.copy(deep=True)
    with np.errstate(over="ignore"):
        expected = pd.Series([float_oracle(value, decimals) for value in values], dtype="float16").tolist()
    for result in rounded_frames(PandasEngine(), source, decimals):
        assert result["rounded"].dtype == source["value"].dtype
        assert_float_values(result["rounded"].tolist(), expected)
    pd.testing.assert_frame_equal(source, before)


@pytest.mark.parametrize(
    "precision_case",
    [
        "ordinary",
        "coarse",
        "large-negative",
        "negative-boundary",
        "negative-zero",
        "large-positive",
        "subnormal",
        "positive-identity",
    ],
)
def test_pandas_round_extended_float_range(precision_case: str) -> None:
    import math
    from decimal import ROUND_HALF_EVEN, Decimal, localcontext

    import numpy as np

    info = np.finfo(np.longdouble)
    if info.nmant <= 52 and info.maxexp <= 1024:
        pytest.skip("this platform aliases longdouble to Float64")
    positive_limit = math.ceil(-float(np.log10(info.smallest_subnormal)) + math.log10(2))
    negative_limit = math.floor(float(np.log10(info.max)) + math.log10(2)) + 1
    decimals = {
        "ordinary": 2,
        "coarse": -23,
        "large-negative": -(negative_limit // 2),
        "negative-boundary": -negative_limit + 1,
        "negative-zero": -(10**12),
        "large-positive": positive_limit // 2,
        "subnormal": positive_limit - 1,
        "positive-identity": 10**12,
    }[precision_case]
    values = [np.longdouble(value) for value in [1.25, 0.0, -0.0, inf, -inf, float("nan")]]
    values.extend([info.max, -info.max, info.smallest_subnormal, -info.smallest_subnormal])
    if -negative_limit < decimals < positive_limit and precision_case != "ordinary":
        unit = np.fromstring(f"1e{-decimals}", dtype=np.longdouble, sep=" ")[0]
        for factor in [0.5, 1.5, 2.5, 7.5]:
            with np.errstate(over="ignore"):
                midpoint = unit * factor
            if np.isfinite(midpoint):
                values.extend(
                    [midpoint, np.nextafter(midpoint, np.longdouble(0)), np.nextafter(midpoint, np.longdouble(inf))]
                )
    source = pd.DataFrame({"value": pd.Series(values, dtype=np.longdouble)})
    source.index = pd.Index(["same"] * len(source), name="source index")
    before = source.copy(deep=True)
    expected = []
    # Decimal independently rounds the exact extended input, without first
    # reducing it to Python's binary64 float or copying the production divmod.
    with localcontext() as context:
        context.prec = info.maxexp * 2 + info.nmant
        for value in values:
            if not np.isfinite(value) or decimals >= positive_limit:
                expected.append(value)
            elif decimals <= -negative_limit:
                expected.append(np.copysign(np.longdouble(0), value))
            else:
                numerator, denominator = value.as_integer_ratio()
                exact = Decimal(numerator) / Decimal(denominator)
                rounded = exact.quantize(Decimal(f"1e{-decimals}"), rounding=ROUND_HALF_EVEN)
                parsed = np.fromstring(str(rounded), dtype=np.longdouble, sep=" ")[0]
                expected.append(np.copysign(parsed, value))
    for result in rounded_frames(PandasEngine(), source, decimals):
        assert result["rounded"].dtype == source["value"].dtype
        for actual, wanted in zip(result["rounded"].array, expected, strict=True):
            if np.isnan(wanted):
                assert np.isnan(actual)
            elif wanted == 0:
                assert actual == 0 and np.signbit(actual) == np.signbit(wanted)
            elif np.isinf(wanted):
                assert actual == wanted
            else:
                assert np.isfinite(actual)
                ulp = abs(wanted - np.nextafter(wanted, np.longdouble(0)))
                assert abs(actual - wanted) <= ulp
    pd.testing.assert_frame_equal(source, before)
