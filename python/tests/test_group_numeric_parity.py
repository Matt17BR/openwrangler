from __future__ import annotations

from decimal import Decimal
from typing import Any, cast

import duckdb
import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime._column_binding import bind_step
from openwrangler_runtime.engines import DuckDBEngine, PandasEngine, PolarsEngine
from openwrangler_runtime.lineage import source_lineage
from openwrangler_runtime.operations import validate_step

_WIDE_INTEGER = 2**63


@pytest.fixture(params=["pandas", "polars", "duckdb"])
def engine(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> Any:
    if request.param == "pandas":
        return PandasEngine()
    if request.param == "polars":

        def reject_to_pandas(*_args: Any, **_kwargs: Any) -> None:
            raise AssertionError("Polars group operations must stay native")

        for frame_type in (pl.DataFrame, pl.LazyFrame, pl.Series):
            monkeypatch.setattr(frame_type, "to_pandas", reject_to_pandas, raising=False)
        return PolarsEngine()
    runtime = DuckDBEngine()
    request.addfinalizer(runtime.close)
    return runtime


def _wide_integer_frame(engine: Any) -> Any:
    groups = [_WIDE_INTEGER, _WIDE_INTEGER, None, None]
    values = [_WIDE_INTEGER + 1, _WIDE_INTEGER + 2, None, None]
    if isinstance(engine, PandasEngine):
        return pd.DataFrame(
            {
                "group": pd.Series(groups, dtype=object),
                "value": pd.Series(values, dtype=object),
            }
        )
    if isinstance(engine, PolarsEngine):
        return pl.DataFrame(
            {
                "group": pl.Series(groups, dtype=pl.Int128),
                "value": pl.Series(values, dtype=pl.Int128),
            }
        )
    return duckdb.sql(
        "SELECT * FROM (VALUES "
        "(CAST(9223372036854775808 AS HUGEINT), CAST(9223372036854775809 AS HUGEINT)), "
        "(CAST(9223372036854775808 AS HUGEINT), CAST(9223372036854775810 AS HUGEINT)), "
        "(NULL::HUGEINT, NULL::HUGEINT), "
        '(NULL::HUGEINT, NULL::HUGEINT)) AS source("group", value)'
    )


def _decimal_frame(engine: Any) -> Any:
    values = [Decimal("1.10"), Decimal("2.20"), None, None]
    if isinstance(engine, PandasEngine):
        return pd.DataFrame(
            {
                "group": ["a", "a", "b", "b"],
                "value": pd.Series(values, dtype=object),
            }
        )
    if isinstance(engine, PolarsEngine):
        return pl.DataFrame(
            {
                "group": ["a", "a", "b", "b"],
                "value": pl.Series(values, dtype=pl.Decimal(10, 2)),
            }
        )
    return duckdb.sql(
        "SELECT * FROM (VALUES "
        "('a', CAST(1.10 AS DECIMAL(10, 2))), "
        "('a', CAST(2.20 AS DECIMAL(10, 2))), "
        "('b', NULL::DECIMAL(10, 2)), "
        "('b', NULL::DECIMAL(10, 2))) AS source(\"group\", value)"
    )


def _group_operation(engine: Any, frame: Any, operations: tuple[str, ...]) -> dict[str, Any]:
    schema = engine.schema(frame)
    lineage = source_lineage(schema)
    public_step = validate_step(
        {
            "id": "numeric-group-parity",
            "kind": "groupBy",
            "params": {
                "keys": [lineage[0]],
                "aggregations": [
                    {
                        "column": lineage[1],
                        "operation": operation,
                        "alias": operation,
                    }
                    for operation in operations
                ],
            },
        }
    )
    return bind_step(public_step, schema, lineage)


def _execute_generated(engine: Any, frame: Any, operation: dict[str, Any]) -> Any:
    namespace: dict[str, Any] = {}
    code = compile(engine.compile_plan([operation]), "<group-numeric-parity>", "exec")
    exec(code, namespace, namespace)
    return namespace["clean_data"](frame)


def _typed_rows(engine: Any, frame: Any) -> list[dict[str, dict[str, Any]]]:
    schema = engine.schema(frame)
    page = engine.page(
        frame,
        0,
        10,
        column_projection=[(column["position"], column["id"]) for column in schema],
    )
    return [{column["name"]: cell for column, cell in zip(schema, row["values"], strict=True)} for row in page["rows"]]


def test_nullable_wide_integer_group_keys_and_extrema_stay_exact_live_and_generated(engine: Any) -> None:
    frame = _wide_integer_frame(engine)
    operation = _group_operation(engine, frame, ("min", "max", "first", "last"))

    live = _typed_rows(engine, engine.apply_transform(frame, operation))
    generated = _typed_rows(engine, _execute_generated(engine, frame, operation))

    assert live == generated
    wide_group = next(row for row in live if row["group"]["kind"] == "integer")
    null_group = next(row for row in live if row["group"]["kind"] == "null")
    assert wide_group["group"]["display"] == str(_WIDE_INTEGER)
    assert wide_group["group"]["raw"] == str(_WIDE_INTEGER)
    expected = {
        "min": _WIDE_INTEGER + 1,
        "max": _WIDE_INTEGER + 2,
        "first": _WIDE_INTEGER + 1,
        "last": _WIDE_INTEGER + 2,
    }
    for operation_name, value in expected.items():
        assert wide_group[operation_name]["kind"] == "integer"
        assert wide_group[operation_name]["display"] == str(value)
        assert wide_group[operation_name]["raw"] == str(value)
        assert null_group[operation_name]["kind"] == "null"


def test_decimal_group_mean_and_median_are_portable_floats_with_typed_nulls(engine: Any) -> None:
    frame = _decimal_frame(engine)
    operation = _group_operation(engine, frame, ("mean", "median"))

    live = _typed_rows(engine, engine.apply_transform(frame, operation))
    generated = _typed_rows(engine, _execute_generated(engine, frame, operation))

    assert live == generated
    populated_group = next(row for row in live if row["group"]["display"] == "a")
    null_group = next(row for row in live if row["group"]["display"] == "b")
    for operation_name in ("mean", "median"):
        assert populated_group[operation_name]["kind"] == "number"
        assert populated_group[operation_name]["raw"] == pytest.approx(1.65)
        assert null_group[operation_name]["kind"] == "null"


def test_decimal_group_sum_preserves_exact_value_and_declared_scale(engine: Any) -> None:
    frame = _decimal_frame(engine)
    operation = _group_operation(engine, frame, ("sum",))

    live = _typed_rows(engine, engine.apply_transform(frame, operation))
    generated = _typed_rows(engine, _execute_generated(engine, frame, operation))

    assert live == generated
    populated_group = next(row for row in live if row["group"]["display"] == "a")
    null_group = next(row for row in live if row["group"]["display"] == "b")
    assert populated_group["sum"]["kind"] == "decimal"
    assert populated_group["sum"]["raw"] == "3.30"
    assert null_group["sum"]["kind"] == "decimal"
    assert null_group["sum"]["raw"] == "0.00"


@pytest.mark.parametrize("family", ["integer", "decimal", "text", "boolean", "date"])
def test_pandas_dictionary_group_inputs_are_logical_and_repeated_positions_remain_independent(family: str) -> None:
    from datetime import date

    pa = pytest.importorskip("pyarrow")
    dtype, values = {
        "integer": (pa.uint64(), [2**64 - 1, None, 2**53 + 3, 2**64 - 1]),
        "decimal": (pa.decimal128(20, 3), [Decimal("2.125"), None, Decimal("3.500"), Decimal("2.125")]),
        "text": (pa.string(), ["é", None, "a", "é"]),
        "boolean": (pa.bool_(), [True, None, False, True]),
        "date": (pa.date32(), [date(2024, 2, 1), None, date(2023, 3, 2), date(2024, 2, 1)]),
    }[family]
    indices = pa.array([0, 1, 2, 3, None], type=pa.int8())
    chunks = [
        pa.DictionaryArray.from_arrays(indices, pa.array(book, type=dtype)) for book in (values, list(reversed(values)))
    ]
    series = pd.Series(pd.arrays.ArrowExtensionArray(pa.chunked_array(chunks)))
    frame = pd.concat([series, series], axis=1)
    frame.columns = ["same", "same"]
    frame.index = pd.MultiIndex.from_tuples([("same", i % 2) for i in range(len(frame))], names=["outer", "inner"])
    frame.attrs["annotation"] = "retained source"
    runtime = PandasEngine()
    schema = runtime.schema(frame)
    lineage = source_lineage(schema)
    operation = bind_step(
        validate_step(
            {
                "id": "dictionary-group",
                "kind": "groupBy",
                "params": {
                    "keys": [lineage[0]],
                    "aggregations": [
                        {"column": lineage[0], "operation": name, "alias": name}
                        for name in ("count", "nUnique", "first")
                    ]
                    + [{"column": lineage[1], "operation": "last", "alias": "last"}],
                },
            }
        ),
        schema,
        lineage,
    )
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    logical = frame.copy()
    for position in range(2):
        # Text dictionary decoding retains shared string payloads in Pandas StringArray storage.
        logical_dtype = pd.StringDtype(storage="python") if family == "text" else pd.ArrowDtype(dtype)
        logical.isetitem(position, frame.iloc[:, position].astype(pd.ArrowDtype(dtype)).astype(logical_dtype))
    expected = runtime.apply_transform(logical, operation)
    original = frame.iloc[:, 0].array.__arrow_array__()
    for actual in (runtime.apply_transform(frame, operation), _execute_generated(runtime, frame, operation)):
        pd.testing.assert_frame_equal(actual, expected)
        assert sorted(actual["count"].tolist()) == [0, 2, 4]
        assert sorted(actual["nUnique"].tolist()) == [0, 1, 1]
        assert all(frame.iloc[:, position].array.__arrow_array__().equals(original) for position in range(2))
        assert frame.attrs == {"annotation": "retained source"}
        pd.testing.assert_index_equal(frame.index, logical.index)


@pytest.mark.parametrize("empty", [False, True])
@pytest.mark.parametrize("encoded", [False, True])
def test_pandas_missing_arrow_decimal_groups_keep_declared_scale_and_generated_types(
    empty: bool, encoded: bool
) -> None:
    pa = pytest.importorskip("pyarrow")
    dtype = pa.decimal128(10, 3)
    values = pa.array([] if empty else [None, None], type=dtype)
    if encoded:
        values = pa.DictionaryArray.from_arrays(
            pa.array([] if empty else [0, None], type=pa.int8()), pa.array([None], type=dtype)
        )
    frame = pd.DataFrame({"group": ["a"] * len(values), "value": pd.arrays.ArrowExtensionArray(values)})
    runtime = PandasEngine()
    operation = _group_operation(runtime, frame, ("sum", "mean", "median"))
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    for actual in (runtime.apply_transform(frame, operation), _execute_generated(runtime, frame, operation)):
        assert actual["sum"].dtype == object
        assert actual["mean"].dtype == actual["median"].dtype == pd.Float64Dtype()
        assert actual["mean"].isna().all() and actual["median"].isna().all()
        assert [str(value) for value in actual["sum"]] == ([] if empty else ["0.000"])
        assert cast(Any, frame["value"].array).__arrow_array__().equals(pa.chunked_array([values]))


def _native_floating_series(values: list[float | None], storage: str, bits: int) -> pd.Series:
    import numpy as np

    if storage == "nullable":
        return pd.Series(
            pd.arrays.FloatingArray(
                np.array([np.nan if value is None else value for value in values], dtype=f"float{bits}"),
                np.array([value is None for value in values]),
            )
        )
    pa = pytest.importorskip("pyarrow")
    dtype = pa.float32() if bits == 32 else pa.float64()
    chunks = [pa.array(part, type=dtype, from_pandas=False) for part in (values[:3], values[3:])]
    if storage == "dictionary":
        chunks = [chunk.dictionary_encode() for chunk in chunks]
    return pd.Series(pd.arrays.ArrowExtensionArray(pa.chunked_array(chunks)))


@pytest.mark.parametrize("storage", ["arrow", "dictionary", "nullable"])
@pytest.mark.parametrize("bits", [32, 64])
@pytest.mark.parametrize("empty", [False, True])
def test_pandas_floating_group_keys_use_numeric_equality_and_preserve_repeated_operands(
    storage: str, bits: int, empty: bool
) -> None:
    import numpy as np

    values = [-0.0, 0.0, 0.0, -0.0, float("nan"), None, 1.0, 1.0]
    frame = pd.DataFrame(
        {
            "partition": ["a", "a", "b", "b", "missing", "missing", "finite", "finite"],
            "value": _native_floating_series(values, storage, bits),
        }
    )
    if empty:
        frame = frame.iloc[:0]
    frame.index = pd.MultiIndex.from_tuples([("source", i % 2) for i in range(len(frame))], names=["outer", "inner"])
    frame.attrs["annotation"] = "source"
    original = frame.copy(deep=True)
    runtime = PandasEngine()
    schema = runtime.schema(frame)
    lineage = source_lineage(schema)
    operations = ("count", "nUnique", "sum", "mean", "median", "min", "max", "first", "last")
    operation = bind_step(
        validate_step(
            {
                "id": "floating-keys",
                "kind": "groupBy",
                "params": {
                    "keys": lineage,
                    "aggregations": [{"column": lineage[1], "operation": name, "alias": name} for name in operations],
                },
            }
        ),
        schema,
        lineage,
    )
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    control = frame.copy()
    control.isetitem(1, pd.Series(values[: len(frame)], index=frame.index, dtype=f"float{bits}"))
    expected = _typed_rows(runtime, runtime.apply_transform(control, operation))
    results = [runtime.apply_transform(frame, operation), _execute_generated(runtime, frame, operation)]
    for result in results:
        assert _typed_rows(runtime, result) == expected
        if storage == "nullable":
            assert result["value"].dtype == frame["value"].dtype
        else:
            pa = pytest.importorskip("pyarrow")
            assert result["value"].dtype == pd.ArrowDtype(pa.float32() if bits == 32 else pa.float64())
        if not empty:
            assert result["partition"].tolist() == ["a", "b", "missing", "finite"]
            assert result["count"].tolist() == [2, 2, 0, 2]
            assert result["nUnique"].tolist() == [1, 1, 0, 1]
            assert np.signbit(result["value"].iloc[:2].to_numpy(dtype=float)).tolist() == [True, True]
            assert np.signbit(result["first"].iloc[:2].to_numpy(dtype=float)).tolist() == [True, False]
            assert np.signbit(result["last"].iloc[:2].to_numpy(dtype=float)).tolist() == [False, True]
        pd.testing.assert_frame_equal(frame, original)
    pd.testing.assert_frame_equal(results[0], results[1])


@pytest.mark.parametrize("storage", ["arrow", "dictionary", "nullable"])
@pytest.mark.parametrize("bits", [32, 64])
@pytest.mark.parametrize("unrelated_empty_group", [False, True])
def test_pandas_floating_aggregates_exclude_input_nan_and_preserve_computed_nan(
    storage: str, bits: int, unrelated_empty_group: bool
) -> None:
    values = [float("nan"), None, 1.0, float("inf"), -float("inf"), None]
    groups = ["input"] * 3 + ["computed"] * 3
    if unrelated_empty_group:
        values += [float("nan"), None]
        groups += ["empty", "empty"]
    frame = pd.DataFrame({"group": groups, "value": _native_floating_series(values, storage, bits)})
    frame.attrs["annotation"] = "source"
    original = frame.copy(deep=True)
    runtime = PandasEngine()
    operation = _group_operation(
        runtime, frame, ("count", "nUnique", "sum", "mean", "median", "min", "max", "first", "last")
    )
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    for result in (runtime.apply_transform(frame, operation), _execute_generated(runtime, frame, operation)):
        typed = _typed_rows(runtime, result)
        for name in ("sum", "mean", "median", "min", "max", "first", "last"):
            assert typed[0][name]["kind"] == "number"
            assert typed[0][name]["raw"] == 1.0
        assert result["count"].tolist() == ([1, 2, 0] if unrelated_empty_group else [1, 2])
        assert result["nUnique"].tolist() == ([1, 2, 0] if unrelated_empty_group else [1, 2])
        for name in ("sum", "mean", "median"):
            assert typed[1][name]["kind"] == "nan"
        if unrelated_empty_group:
            assert typed[2]["sum"]["raw"] == 0.0
            for name in ("mean", "median", "min", "max", "first", "last"):
                assert typed[2][name]["kind"] == "null"
        pd.testing.assert_frame_equal(frame, original)


@pytest.mark.parametrize(
    ("values", "expected"),
    [
        ([], []),
        ([None, None], [0]),
        ([1.0, 2.0, 3.0], [2, 1]),
        ([1.0, float("nan"), 2.0, None], [1, 1]),
        ([-0.0, 0.0, float("inf"), -float("inf")], [2, 2]),
    ],
)
def test_pandas_arrow_half_float_count_keeps_finite_values(values: list[float | None], expected: list[int]) -> None:
    pa = pytest.importorskip("pyarrow")
    frame = pd.DataFrame(
        {
            "group": pd.Series(["a" if i < 2 else "b" for i in range(len(values))], dtype="string"),
            "value": pd.Series(pd.arrays.ArrowExtensionArray(pa.array(values, type=pa.float16(), from_pandas=False))),
        }
    )
    original = frame.copy(deep=True)
    runtime = PandasEngine()
    operation = _group_operation(runtime, frame, ("count",))
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    for result in (runtime.apply_transform(frame, operation), _execute_generated(runtime, frame, operation)):
        assert result["count"].tolist() == expected
        pd.testing.assert_frame_equal(frame, original)


@pytest.mark.parametrize("fill", [0.0, float("nan")])
def test_pandas_sparse_float_group_sum_retains_native_missing_values(fill: float) -> None:
    frame = pd.DataFrame(
        {
            "group": ["a", "a", "b"],
            "value": pd.Series([1.0, float("nan"), 2.0], dtype=pd.SparseDtype("float32", fill)),
        }
    )
    original = frame.copy(deep=True)
    runtime = PandasEngine()
    operation = _group_operation(runtime, frame, ("sum",))
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    for result in (runtime.apply_transform(frame, operation), _execute_generated(runtime, frame, operation)):
        assert result["sum"].tolist() == [1.0, 2.0]
        assert result["sum"].dtype == frame["value"].dtype
        pd.testing.assert_frame_equal(frame, original)


@pytest.mark.parametrize(
    ("storage", "fill", "values", "expected"),
    [
        ("int8", 0, [1] * 300, 300),
        ("uint64", 0, [2**64 - 1, 0, 2**53 + 3], 3),
        ("int64", float("nan"), [2**53 + 1, None, 0], 2),
        ("float32", 0.0, [1.0, float("nan"), float("inf"), 0.0], 3),
        ("float64", float("nan"), [None, None], 0),
        ("bool", False, [False, True] * 150, 300),
        ("bool", True, [False, True], 2),
        ("object", float("nan"), ["value", None, ""], 2),
    ],
)
@pytest.mark.parametrize("empty", [False, True])
def test_pandas_sparse_count_preserves_presence_and_count_width(
    storage: str, fill: Any, values: list[Any], expected: int, empty: bool
) -> None:
    import numpy as np

    value = pd.Series(np.array(values, dtype=object), dtype=pd.SparseDtype(storage, fill))
    if empty:
        value = value.iloc[:0]
    frame = pd.concat([pd.Series(["group"] * len(value), dtype="string"), value], axis=1)
    frame.columns = ["same", "same"]
    frame.index = pd.MultiIndex.from_tuples([("source", i % 2) for i in range(len(frame))], names=["outer", "inner"])
    frame.attrs["annotation"] = "source"
    original = frame.copy(deep=True)
    runtime = PandasEngine()
    operation = _group_operation(runtime, frame, ("count",))
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    for result in (runtime.apply_transform(frame, operation), _execute_generated(runtime, frame, operation)):
        assert result["count"].tolist() == ([] if empty else [expected])
        assert result["count"].dtype == np.dtype("int64")
        assert result.columns.tolist() == ["same", "count"]
        pd.testing.assert_frame_equal(frame, original)


def test_pandas_sparse_count_preserves_other_aggregates_of_the_same_column() -> None:
    import numpy as np

    frame = pd.DataFrame(
        {
            "group": ["a", "a", "b", "b"],
            "value": pd.Series(
                np.array([2**64 - 1, 0, 2**53 + 3, 0], dtype=np.uint64), dtype=pd.SparseDtype("uint64", 0)
            ),
        }
    )
    frame.attrs["annotation"] = "source"
    original = frame.copy(deep=True)
    runtime = PandasEngine()
    operation = _group_operation(runtime, frame, ("sum", "count", "min", "nUnique"))
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    for result in (runtime.apply_transform(frame, operation), _execute_generated(runtime, frame, operation)):
        assert result["group"].tolist() == ["a", "b"]
        assert result["count"].tolist() == [2, 2]
        assert result["sum"].tolist() == [2**64 - 1, 2**53 + 3]
        assert result["min"].tolist() == [0, 0]
        assert result["nUnique"].tolist() == [2, 2]
        pd.testing.assert_frame_equal(frame, original)


@pytest.mark.parametrize("missing_fill", [False, True])
def test_pandas_sparse_count_can_share_its_exact_column_with_the_group_key(missing_fill: bool) -> None:
    import numpy as np

    fill = float("nan") if missing_fill else 0
    values = [2**64 - 1, None if missing_fill else 0, 2**53 + 3, None if missing_fill else 0]
    frame = pd.DataFrame({"key": pd.Series(np.array(values, dtype=object), dtype=pd.SparseDtype("uint64", fill))})
    original = frame.copy(deep=True)
    runtime = PandasEngine()
    schema = runtime.schema(frame)
    lineage = source_lineage(schema)
    operation = bind_step(
        validate_step(
            {
                "id": "sparse-key-count",
                "kind": "groupBy",
                "params": {
                    "keys": lineage,
                    "aggregations": [{"column": lineage[0], "operation": "count", "alias": "count"}],
                },
            }
        ),
        schema,
        lineage,
    )
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    for result in (runtime.apply_transform(frame, operation), _execute_generated(runtime, frame, operation)):
        assert result["count"].tolist() == [1, 0 if missing_fill else 2, 1]
        assert result["key"].iloc[0] == 2**64 - 1
        assert result["key"].iloc[2] == 2**53 + 3
        assert pd.isna(result["key"].iloc[1]) if missing_fill else result["key"].iloc[1] == 0
        pd.testing.assert_frame_equal(frame, original)


@pytest.mark.skipif(int(pd.__version__.split(".")[0]) >= 3, reason="Pandas 3 rejects incompatible Sparse fills")
@pytest.mark.parametrize("fill", [-1, 2**64, 1.5])
def test_pandas_sparse_count_retains_legacy_logical_fill_values(fill: int | float) -> None:
    import numpy as np

    with pytest.warns(FutureWarning, match="arbitrary scalar fill_value"):
        value = pd.Series(
            np.array([fill, 2**64 - 1, 2**53 + 3, fill], dtype=object), dtype=pd.SparseDtype("uint64", fill)
        )
    frame = pd.DataFrame({"group": ["a"] * 4, "value": value})
    frame.attrs["annotation"] = "source"
    original = frame.copy(deep=True)
    runtime = PandasEngine()
    operation = _group_operation(runtime, frame, ("count",))
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    for result in (runtime.apply_transform(frame, operation), _execute_generated(runtime, frame, operation)):
        assert result["count"].tolist() == [4]
        assert result["count"].dtype == np.dtype("int64")
        actual_array = cast(Any, frame["value"].array)
        original_array = cast(Any, original["value"].array)
        assert actual_array.dtype == original_array.dtype
        np.testing.assert_array_equal(actual_array.sp_values, original_array.sp_values)
        np.testing.assert_array_equal(actual_array.sp_index.indices, original_array.sp_index.indices)
        pd.testing.assert_series_equal(frame["group"], original["group"])
        pd.testing.assert_index_equal(frame.index, original.index)
        pd.testing.assert_index_equal(frame.columns, original.columns)
        assert frame.attrs == original.attrs
