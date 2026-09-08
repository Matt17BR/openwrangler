from __future__ import annotations

from decimal import Decimal
from typing import Any

import duckdb
import numpy as np
import pandas as pd
import polars as pl
import pyarrow as pa
import pytest
from pandas.testing import assert_frame_equal
from polars.testing import assert_frame_equal as assert_polars_frame_equal

from openwrangler_runtime._column_binding import ColumnBindingError, bind_step
from openwrangler_runtime.engines import DuckDBEngine, EngineError, PandasEngine, PolarsEngine
from openwrangler_runtime.engines.duckdb_engine import DuckDBSqlPlan
from openwrangler_runtime.lineage import derive_lineage, source_lineage
from openwrangler_runtime.operations import validate_step

SOURCE = 'value\'s "column"'
TARGET = 'rank\'s "column"'


@pytest.fixture(params=["pandas", "polars", "polars-lazy", "duckdb"])
def engine(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> tuple[Any, bool]:
    if request.param == "pandas":
        return PandasEngine(), False
    if request.param.startswith("polars"):
        monkeypatch.setattr(pl.DataFrame, "to_pandas", lambda *_a, **_kw: pytest.fail("Polars must stay native"))
        return PolarsEngine(), request.param == "polars-lazy"
    for name in ("arrow", "df", "fetch_arrow_table", "fetchdf", "pl", "to_arrow_table", "to_df"):
        if hasattr(duckdb.DuckDBPyRelation, name):
            monkeypatch.setattr(
                duckdb.DuckDBPyRelation, name, lambda *_a, **_kw: pytest.fail("DuckDB must stay native")
            )
    adapter = DuckDBEngine()
    request.addfinalizer(adapter.close)
    return adapter, False


def make_frame(engine: tuple[Any, bool], values: list[Any], kind: str) -> Any:
    adapter, lazy = engine
    if isinstance(adapter, PandasEngine):
        dtype = {"BIGINT": "Int64", "UBIGINT": "UInt64", "DOUBLE": "Float64", "BOOLEAN": "boolean"}.get(kind, object)
        frame = pd.DataFrame(
            {SOURCE: pd.Series(values, dtype=dtype), "__ow_rank_order": range(len(values)), "__ow_rank_value": 7}
        )
        frame.index = pd.MultiIndex.from_tuples([("same", i % 2) for i in range(len(values))], names=["group", "row"])
        return frame
    if isinstance(adapter, PolarsEngine):
        dtype = {
            "BIGINT": pl.Int64,
            "UBIGINT": pl.UInt64,
            "HUGEINT": pl.Int128,
            "DOUBLE": pl.Float64,
            "BOOLEAN": pl.Boolean,
            "DECIMAL(38,2)": pl.Decimal(38, 2),
        }[kind]
        frame = pl.DataFrame(
            {
                SOURCE: pl.Series(values, dtype=dtype),
                "__ow_rank_order": range(len(values)),
                "__ow_rank_value": [7] * len(values),
            }
        )
        return frame.lazy() if lazy else frame
    name = '"' + SOURCE.replace('"', '""') + '"'
    if not values:
        return duckdb.sql(f"SELECT NULL::{kind} AS {name}, 0 AS __ow_rank_order, 7 AS __ow_rank_value WHERE FALSE")
    rows = ", ".join(
        f"(NULL::{kind}, {i}, 7)" if value is None else f"('{value}'::{kind}, {i}, 7)" for i, value in enumerate(values)
    )
    return duckdb.sql(f"SELECT * FROM (VALUES {rows}) source({name}, __ow_rank_order, __ow_rank_value)")


def materialize(frame: Any) -> Any:
    if isinstance(frame, pl.LazyFrame):
        return frame.collect()
    if isinstance(frame, DuckDBSqlPlan):
        return duckdb.sql(frame.sql)
    return frame


def values_of(frame: Any, name: str) -> list[Any]:
    frame = materialize(frame)
    if isinstance(frame, pd.DataFrame):
        return frame[name].tolist()
    if isinstance(frame, pl.DataFrame):
        return frame[name].to_list()
    identifier = '"' + name.replace('"', '""') + '"'
    return [row[0] for row in frame.project(identifier).fetchall()]


def ranked(adapter: Any, source: Any, direction: str) -> tuple[Any, Any, dict[str, Any], str]:
    schema = adapter.schema(source)
    lineage = source_lineage(schema)
    public = validate_step(
        {
            "id": "rank",
            "kind": "denseRank",
            "params": {"column": lineage[0], "direction": direction, "newColumn": TARGET},
        }
    )
    bound = bind_step(public, schema, lineage)
    code = adapter.compile_plan([bound])
    assert "openwrangler_runtime" not in code
    if isinstance(adapter, PandasEngine):
        for unused in ("take_rows", "sort_order", "factorize_group_key"):
            assert f"def _open_wrangler_{unused}(" not in code
    namespace: dict[str, Any] = {}
    exec(code, namespace)
    return adapter.apply_transform(source, bound), namespace["clean_data"](source), bound, code


@pytest.mark.parametrize("direction", ["asc", "desc"])
@pytest.mark.parametrize(
    ("values", "kind", "ascending"),
    [
        ([20, 10, 20, None], "BIGINT", [2, 1, 2, None]),
        ([2**64 - 1, 2**64 - 2, None, 2**64 - 1], "UBIGINT", [2, 1, None, 2]),
        ([2**100, 2**100 - 1, None], "HUGEINT", [2, 1, None]),
        ([float("inf"), float("-inf"), 0.0, -0.0, float("nan"), None, 1.0], "DOUBLE", [4, 1, 2, 2, None, None, 3]),
        (
            [Decimal("123456789012345678901234567890.02"), Decimal("123456789012345678901234567890.01"), None],
            "DECIMAL(38,2)",
            [2, 1, None],
        ),
        ([], "BIGINT", []),
        ([None, None], "BIGINT", [None, None]),
    ],
)
def test_dense_rank_native_generated_exact_values_and_order(
    engine: tuple[Any, bool], direction: str, values: list[Any], kind: str, ascending: list[int | None]
) -> None:
    adapter, _ = engine
    source = make_frame(engine, values, kind)
    before = (
        source.copy(deep=True)
        if isinstance(source, pd.DataFrame)
        else source.clone()
        if isinstance(source, (pl.DataFrame, pl.LazyFrame))
        else source.sql_query()
    )
    total = max((rank for rank in ascending if rank is not None), default=0)
    expected = ascending if direction == "asc" else [None if rank is None else total + 1 - rank for rank in ascending]
    live, generated, bound, code = ranked(adapter, source, direction)
    for result in (live, generated):
        actual = values_of(result, TARGET)
        assert [None if pd.isna(value) else int(value) for value in actual] == expected
        assert values_of(result, "__ow_rank_order") == list(range(len(values)))
        assert values_of(result, "__ow_rank_value") == [7] * len(values)
        output_schema = adapter.schema(result)
        assert output_schema[-1]["type"] == "integer"
        assert [column["name"] for column in output_schema] == [SOURCE, "__ow_rank_order", "__ow_rank_value", TARGET]
        lineage = derive_lineage(source_lineage(adapter.schema(source)), output_schema, bound)
        assert lineage[-1] == {"id": "c:step:rank:0", "name": TARGET}
        assert lineage[:-1] == source_lineage(adapter.schema(source))
        if isinstance(result, pd.DataFrame):
            assert isinstance(source, pd.DataFrame)
            assert str(result[TARGET].dtype) == "Int64"
            assert result.index.equals(source.index)
            assert_frame_equal(result.iloc[:, :-1], source)
        elif isinstance(materialize(result), pl.DataFrame):
            assert materialize(result).schema[TARGET] == pl.get_index_type()
            assert_polars_frame_equal(materialize(result).drop(TARGET), materialize(source))
        else:
            assert str(materialize(result).types[-1]) == "BIGINT"
    if isinstance(source, pd.DataFrame):
        assert_frame_equal(source, before)
    elif isinstance(source, (pl.DataFrame, pl.LazyFrame)):
        assert_polars_frame_equal(materialize(source), materialize(before))
    else:
        assert source.sql_query() == before
    assert code.count("def clean_data") == 1


def arrow_series(values: list[Any], dtype: Any) -> pd.Series:
    return pd.Series(pd.arrays.ArrowExtensionArray(pa.array(values, type=dtype, from_pandas=False)))


@pytest.mark.parametrize(
    ("series", "expected"),
    [
        (pd.Series([2**53 + 1, np.float64(2**53), 2**53, None], dtype=object), [2, 1, 1, None]),
        (
            arrow_series([-65504.0, 65504.0, -(2**-24), 2**-24, -0.0, 0.0, float("nan"), None], pa.float16()),
            [1, 5, 2, 4, 3, 3, None, None],
        ),
        (arrow_series([-0.0, 0.0, 1.0, float("nan"), None], pa.float64()), [1, 1, 2, None, None]),
        (
            arrow_series(
                [
                    Decimal("1234567890123456789012345678901234567890.02"),
                    Decimal("1234567890123456789012345678901234567890.01"),
                    None,
                ],
                pa.decimal256(76, 2),
            ),
            [2, 1, None],
        ),
        (pd.Series([2**63 - 1, 2**63 - 2, 0], dtype=pd.SparseDtype("int64", 0)), [3, 2, 1]),
        (pd.Series([2.0, np.nan, 1.0, 2.0], dtype=pd.SparseDtype("float64", np.nan)), [2, None, 1, 2]),
        (pd.Series([2.0, 1.0, np.nan], dtype="float32"), [2, 1, None]),
    ],
)
def test_pandas_rank_comparison_keys_preserve_physical_columns(series: pd.Series, expected: list[int | None]) -> None:
    source = pd.concat([series, series.copy()], axis=1)
    source.columns = pd.Index([7, 7])
    source.index = pd.MultiIndex.from_tuples([("same", i % 2) for i in range(len(source))], names=["group", "row"])
    source.attrs = {"synthetic": "preserved"}
    before = source.copy(deep=True)
    adapter = PandasEngine()
    schema = adapter.schema(source)
    lineage = source_lineage(schema)
    for direction in ("asc", "desc"):
        step = bind_step(
            validate_step(
                {
                    "id": "rank",
                    "kind": "denseRank",
                    "params": {"column": lineage[1], "direction": direction, "newColumn": TARGET},
                }
            ),
            schema,
            lineage,
        )
        namespace: dict[str, Any] = {}
        exec(adapter.compile_plan([step]), namespace)
        live, emitted = adapter.apply_transform(source, step), namespace["clean_data"](source)
        total = max((value for value in expected if value is not None), default=0)
        wanted = (
            expected if direction == "asc" else [None if value is None else total + 1 - value for value in expected]
        )
        for result in (live, emitted):
            assert [None if pd.isna(value) else int(value) for value in result[TARGET]] == wanted
            assert_frame_equal(result.iloc[:, :2], source, check_column_type=False)
            assert str(result[TARGET].dtype) == "Int64"
        assert_frame_equal(live, emitted)
    assert_frame_equal(source, before)
    assert source.attrs == before.attrs


def test_pandas_rank_dictionary_nan_nullability_and_encoded_source() -> None:
    dictionary = pa.DictionaryArray.from_arrays(
        pa.array([0, 1, 2, 3, None, 0], type=pa.int8()),
        pa.array([-0.0, 0.0, float("nan"), 2.0], type=pa.float16(), from_pandas=False),
    )
    source = pd.DataFrame(
        {
            SOURCE: pd.Series(
                pd.arrays.ArrowExtensionArray(pa.chunked_array([dictionary.slice(0, 2), dictionary.slice(2)]))
            )
        }
    )

    def encoded_buffers(frame: pd.DataFrame) -> list[Any]:
        array = frame[SOURCE].array
        assert isinstance(array, pd.arrays.ArrowExtensionArray)
        return [
            (
                chunk.offset,
                tuple(None if buffer is None else bytes(buffer) for buffer in chunk.buffers()),
                tuple(None if buffer is None else bytes(buffer) for buffer in chunk.dictionary.buffers()),
            )
            for chunk in array.__arrow_array__().chunks
        ]

    before = encoded_buffers(source)
    adapter = PandasEngine()
    live, emitted, _, _ = ranked(adapter, source, "asc")
    for result in (live, emitted):
        assert [None if pd.isna(value) else int(value) for value in result[TARGET]] == [1, 1, None, 2, None, 1]
        assert encoded_buffers(result) == before
        assert adapter.schema(result)[-1]["nullable"] is True
    assert encoded_buffers(source) == before
    nonnullable = pd.DataFrame({SOURCE: arrow_series([1.0, float("nan")], pa.float64())})
    assert adapter.schema(nonnullable)[0]["nullable"] is False
    result, replay, _, _ = ranked(adapter, nonnullable, "asc")
    assert adapter.schema(result)[-1]["nullable"] is True
    assert_frame_equal(result, replay)


class RankIntArray(pd.arrays.IntegerArray):
    def factorize(self, use_na_sentinel: bool = True) -> tuple[np.ndarray, Any]:
        raise AssertionError("Dense rank must not call an unknown extension's factorize.")


class RankFloatDtype(pd.Float64Dtype):
    @property
    def na_value(self) -> Any:
        return np.nextafter(np.longdouble(1), np.longdouble(2))


class RankFloatArray(pd.arrays.FloatingArray):
    @property
    def dtype(self) -> Any:
        return RankFloatDtype()

    def to_numpy(self, dtype: Any = None, copy: bool = False, na_value: Any = None) -> np.ndarray:
        result = super().to_numpy(dtype=object, copy=True)
        result[self.isna()] = self.dtype.na_value
        return result


@pytest.mark.parametrize(
    "series",
    [
        pd.Series(RankIntArray(np.array([2, 99, 1], dtype=np.int64), np.array([False, True, False]))),
        pd.Series(RankFloatArray(np.array([2.0, 99.0, 1.0]), np.array([False, True, False]))),
    ],
)
def test_pandas_rank_custom_storage_uses_numeric_values_and_logical_missing_mask(series: pd.Series) -> None:
    source = pd.DataFrame({SOURCE: series})
    before = source.copy(deep=True)
    live, emitted, _, _ = ranked(PandasEngine(), source, "asc")
    for result in (live, emitted):
        assert [None if pd.isna(value) else int(value) for value in result[TARGET]] == [2, None, 1]
        assert_frame_equal(result.iloc[:, :1], source)
    assert_frame_equal(source, before)


class RankReversedInt(int):
    def __lt__(self, other: Any) -> bool:
        return int(self) > int(other)

    def __gt__(self, other: Any) -> bool:
        return int(self) < int(other)


@pytest.mark.parametrize(
    "series",
    [
        pd.Series([RankReversedInt(1), RankReversedInt(2)], dtype=object),
        pd.Series([np.nextafter(np.longdouble(1), np.longdouble(2))], dtype=object),
    ],
)
def test_pandas_rank_checks_present_comparison_values_at_native_precision(series: pd.Series) -> None:
    source = pd.DataFrame({SOURCE: series})
    before = source.copy(deep=True)
    adapter = PandasEngine()
    lineage = source_lineage(adapter.schema(source))
    step = bind_step(
        validate_step(
            {
                "id": "rank",
                "kind": "denseRank",
                "params": {"column": lineage[0], "direction": "asc", "newColumn": TARGET},
            }
        ),
        adapter.schema(source),
        lineage,
    )
    namespace: dict[str, Any] = {}
    exec(adapter.compile_plan([step]), namespace)
    extended = type(series.iloc[0]) is np.longdouble
    if extended and np.finfo(np.longdouble).nmant == np.finfo(np.float64).nmant:
        for result in (adapter.apply_transform(source, step), namespace["clean_data"](source)):
            assert result[TARGET].tolist() == [1]
            assert str(result[TARGET].dtype) == "Int64"
    else:
        with pytest.raises(EngineError):
            adapter.apply_transform(source, step)
        with pytest.raises(ValueError):
            namespace["clean_data"](source)
    assert_frame_equal(source, before)


@pytest.mark.parametrize("direction", ["asc", "desc"])
def test_dense_rank_uses_current_cleaning_order_and_standalone_helper_dependencies(
    engine: tuple[Any, bool], direction: str
) -> None:
    adapter, _ = engine
    source = make_frame(engine, [20, 10, 20, 30], "BIGINT")
    source = adapter.ensure_row_ids(source, "rank-order")
    schema = adapter.schema(source)
    lineage = source_lineage(schema)
    sort = bind_step(
        validate_step(
            {
                "id": "sort",
                "kind": "sortRows",
                "params": {"rules": [{"column": lineage[1], "direction": "desc", "nulls": "last"}]},
            }
        ),
        schema,
        lineage,
    )
    reordered = adapter.apply_transform(source, sort)
    step = bind_step(
        validate_step(
            {
                "id": "rank",
                "kind": "denseRank",
                "params": {"column": lineage[0], "direction": direction, "newColumn": TARGET},
            }
        ),
        adapter.schema(reordered),
        lineage,
    )
    plan = [sort, step]
    namespace: dict[str, Any] = {}
    code = adapter.compile_plan(plan)
    exec(code, namespace)
    for result in (adapter.apply_transform(reordered, step), namespace["clean_data"](source)):
        assert values_of(result, "__ow_rank_order") == [3, 2, 1, 0]
        assert values_of(result, TARGET) == ([3, 2, 1, 2] if direction == "asc" else [1, 2, 3, 2])
    assert "openwrangler_runtime" not in code


@pytest.mark.parametrize("failure", ["stale-id", "stale-name", "collision", "nonnumeric"])
def test_dense_rank_binding_refuses_unsupported_current_input(engine: tuple[Any, bool], failure: str) -> None:
    adapter, _ = engine
    source = (
        make_frame(engine, [True, False], "BOOLEAN")
        if failure == "nonnumeric"
        else make_frame(engine, [20, 10], "BIGINT")
    )
    schema = adapter.schema(source)
    lineage = source_lineage(schema)
    reference = dict(lineage[0])
    if failure == "stale-id":
        reference["id"] = "c:missing"
    elif failure == "stale-name":
        reference["name"] = "old name"
    operation = validate_step(
        {
            "id": "rank",
            "kind": "denseRank",
            "params": {
                "column": reference,
                "direction": "asc",
                "newColumn": SOURCE if failure == "collision" else TARGET,
            },
        }
    )
    with pytest.raises(ColumnBindingError):
        bind_step(operation, schema, lineage)
