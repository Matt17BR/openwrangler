from __future__ import annotations

import math
from decimal import Decimal
from typing import Any
from uuid import UUID

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
from openwrangler_runtime.operations import OperationError, validate_step

KEY = 'key\'s "value"'
TARGET = 'flag\'s "value"'


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


def materialize(frame: Any) -> Any:
    if isinstance(frame, pl.LazyFrame):
        return frame.collect()
    if isinstance(frame, DuckDBSqlPlan):
        return duckdb.sql(frame.sql)
    return frame


def native_frame(engine: tuple[Any, bool], values: list[Any], kind: str) -> Any:
    adapter, lazy = engine
    if isinstance(adapter, PandasEngine):
        dtype = {"BIGINT": "Int64", "UBIGINT": "UInt64", "DOUBLE": "float64", "BOOLEAN": "boolean"}.get(kind, object)
        frame = pd.DataFrame({KEY: pd.Series(values, dtype=dtype), "__ow_dupe_order": range(len(values))})
        frame.index = pd.MultiIndex.from_tuples([("same", i % 2) for i in range(len(frame))], names=["group", "row"])
        return frame
    if isinstance(adapter, PolarsEngine):
        dtype = {
            "BIGINT": pl.Int64,
            "UBIGINT": pl.UInt64,
            "DOUBLE": pl.Float64,
            "BOOLEAN": pl.Boolean,
            "DECIMAL(38,2)": pl.Decimal(38, 2),
        }[kind]
        frame = pl.DataFrame({KEY: pl.Series(values, dtype=dtype), "__ow_dupe_order": range(len(values))})
        return frame.lazy() if lazy else frame
    identifier = '"' + KEY.replace('"', '""') + '"'
    if not values:
        return duckdb.sql(f"SELECT NULL::{kind} AS {identifier}, 0 AS __ow_dupe_order WHERE FALSE")
    rows = ", ".join(f"(NULL::{kind}, {i})" if v is None else f"('{v}'::{kind}, {i})" for i, v in enumerate(values))
    return duckdb.sql(f"SELECT * FROM (VALUES {rows}) data({identifier}, __ow_dupe_order)")


def marked(adapter: Any, source: Any, positions: list[int]) -> tuple[Any, Any, dict[str, Any], str]:
    schema = adapter.schema(source)
    lineage = source_lineage(schema)
    public = validate_step(
        {
            "id": "mark",
            "kind": "markDuplicates",
            "params": {
                "columns": [lineage[position] for position in positions],
                "newColumn": TARGET,
            },
        }
    )
    bound = bind_step(public, schema, lineage)
    code = adapter.compile_plan([bound])
    assert "openwrangler_runtime" not in code
    if isinstance(adapter, PandasEngine):
        assert "def _open_wrangler_take_rows(" not in code
    namespace: dict[str, Any] = {}
    exec(code, namespace)
    return adapter.apply_transform(source, bound), namespace["clean_data"](source), bound, code


def exact_value(value: Any) -> Any:
    if isinstance(value, float):
        return ("float", value.hex())
    if isinstance(value, list):
        return [exact_value(item) for item in value]
    if isinstance(value, dict):
        return {key: exact_value(item) for key, item in value.items()}
    return value


def assert_marked(adapter: Any, source: Any, result: Any, expected: list[bool]) -> None:
    result, source = materialize(result), materialize(source)
    if isinstance(result, pd.DataFrame):
        assert result.iloc[:, -1].tolist() == expected
        assert result.iloc[:, -1].dtype == np.dtype(bool)
        original = result.iloc[:, :-1].copy(deep=False)
        assert [(type(value), value) for value in original.columns] == [
            (type(value), value) for value in source.columns
        ]
        original.columns = source.columns  # Appending a string label widens an integer column Index to object.
        assert_frame_equal(original, source)
        for position in range(source.shape[1]):
            for actual, expected_value in zip(original.iloc[:, position], source.iloc[:, position], strict=True):
                if isinstance(expected_value, float):
                    assert actual.hex() == expected_value.hex()
    elif isinstance(result, pl.DataFrame):
        assert result[TARGET].to_list() == expected
        assert result.schema[TARGET] == pl.Boolean
        assert_polars_frame_equal(result.drop(TARGET), source)
        for actual_row, source_row in zip(result.drop(TARGET).rows(), source.rows(), strict=True):
            for actual, expected_value in zip(actual_row, source_row, strict=True):
                if isinstance(expected_value, float):
                    assert actual.hex() == expected_value.hex()
    else:
        actual = result.fetchall()
        assert [row[-1] for row in actual] == expected
        assert [exact_value(list(row[:-1])) for row in actual] == [exact_value(list(row)) for row in source.fetchall()]
        assert list(result.types[:-1]) == list(source.types)
        assert str(result.types[-1]) == "BOOLEAN"
    schema = adapter.schema(result)
    assert schema[-1]["type"] == "boolean"
    assert schema[-1]["name"] == TARGET


@pytest.mark.parametrize(
    ("values", "kind", "expected"),
    [
        ([], "BIGINT", []),
        ([1, 2, 3], "BIGINT", [False, False, False]),
        ([None, None, None], "BIGINT", [True, True, True]),
        ([True, False, True, None, None], "BOOLEAN", [True, False, True, True, True]),
        ([2**64 - 1, 2**64 - 2, 2**64 - 1, None], "UBIGINT", [True, False, True, False]),
        (
            [
                Decimal("123456789012345678901234567890.02"),
                Decimal("123456789012345678901234567890.01"),
                Decimal("123456789012345678901234567890.02"),
            ],
            "DECIMAL(38,2)",
            [True, False, True],
        ),
        ([-0.0, 0.0, math.inf, -math.inf, math.nan, math.nan], "DOUBLE", [True, True, False, False, True, True]),
    ],
)
def test_mark_duplicates_native_generated_values_identity_and_source(
    engine: tuple[Any, bool], values: list[Any], kind: str, expected: list[bool]
) -> None:
    adapter, _ = engine
    source = native_frame(engine, values, kind)
    before = (
        source.copy(deep=True)
        if isinstance(source, pd.DataFrame)
        else source.clone()
        if isinstance(source, (pl.DataFrame, pl.LazyFrame))
        else source.sql_query()
    )
    live, generated, bound, _ = marked(adapter, source, [0])
    for result in (live, generated):
        assert_marked(adapter, source, result, expected)
        original_lineage = source_lineage(adapter.schema(source))
        lineage = derive_lineage(original_lineage, adapter.schema(result), bound)
        assert lineage == [*original_lineage, {"id": "c:step:mark:0", "name": TARGET}]
    if isinstance(source, pd.DataFrame):
        assert_frame_equal(source, before)
    elif isinstance(source, (pl.DataFrame, pl.LazyFrame)):
        assert_polars_frame_equal(materialize(source), materialize(before))
    else:
        assert source.sql_query() == before


@pytest.mark.parametrize(
    ("keys", "expected"),
    [
        (pd.Series([None, np.nan, pd.NA, pd.NaT], dtype=object), [True] * 4),
        (pd.Series([UUID(int=1), str(UUID(int=1)), UUID(int=2)], dtype=object), [True, True, False]),
        (pd.Series(pd.Categorical(["a", None, "a", None, "b"])), [True, True, True, True, False]),
        (pd.Series([2**63 - 1, 0, 2**63 - 1], dtype=pd.SparseDtype("int64", 0)), [True, False, True]),
        (
            pd.Series(
                pd.arrays.ArrowExtensionArray(
                    pa.DictionaryArray.from_arrays(pa.array([0, 1, 0, 2, None]), pa.array(["a", "b", None]))
                )
            ),
            [True, False, True, True, True],
        ),
    ],
)
def test_pandas_mark_uses_logical_keys_and_positional_append(keys: pd.Series, expected: list[bool]) -> None:
    source = pd.concat([keys, keys.copy()], axis=1)
    source.columns = pd.Index([7, 7])
    source.index = pd.MultiIndex.from_tuples([("same", i % 2) for i in range(len(source))], names=["group", "row"])
    source.attrs["owner"] = "unchanged"
    before = source.copy(deep=True)
    adapter = PandasEngine()
    live, generated, _, _ = marked(adapter, source, [0, 1])
    for result in (live, generated):
        assert_marked(adapter, source, result, expected)
    assert_frame_equal(source, before)
    assert source.attrs == before.attrs


@pytest.mark.parametrize("lazy", [False, True])
@pytest.mark.parametrize(
    "keys",
    [
        pl.Series("key", [], dtype=pl.Null),
        pl.Series("key", [None, None], dtype=pl.Null),
        pl.Series("key", [[-0.0], [0.0], None, [1.0]]),
    ],
)
def test_polars_mark_null_and_nested_native_keys(lazy: bool, keys: pl.Series) -> None:
    source = pl.DataFrame(keys)
    frame = source.lazy() if lazy else source
    adapter = PolarsEngine()
    expected = [] if len(keys) == 0 else [True, True] if len(keys) == 2 else [True, True, False, False]
    live, generated, _, _ = marked(adapter, frame, [0])
    for result in (live, generated):
        assert_marked(adapter, source, result, expected)
        if len(keys) == 4:
            assert math.copysign(1, materialize(result)["key"][0][0]) == -1


@pytest.mark.parametrize("expression", ["v", "[v]", "{'item': v}", "[v]::DOUBLE[1]", "MAP(['item'], [v])"])
def test_duckdb_mark_projects_original_scalar_nested_keys_and_payload(expression: str) -> None:
    adapter = DuckDBEngine()
    try:
        source = duckdb.sql(
            f"SELECT {expression} AS key, v AS payload, i AS __OW_DUPE_ORDER, [v] AS __ow_dupe_flag "
            "FROM (VALUES (0, '-0'::DOUBLE), (1, '0'::DOUBLE), (2, '1'::DOUBLE)) data(i, v) ORDER BY i"
        )
        live, generated, _, _ = marked(adapter, source, [0])
        for result in (live, generated):
            assert_marked(adapter, source, result, [True, True, False])
    finally:
        adapter.close()


@pytest.mark.parametrize(
    "params",
    [
        {},
        {"columns": [], "newColumn": TARGET},
        {"columns": ["key"], "newColumn": TARGET},
        {"columns": [{"id": "one", "name": "key"}] * 2, "newColumn": TARGET},
        {"columns": [{"id": "one", "name": "key"}], "newColumn": ""},
        {"columns": [{"id": "one", "name": "key"}], "newColumn": TARGET, "keep": "none"},
        {"columns": [{"id": "one", "name": "__open_wrangler_internal_row_id_x"}], "newColumn": TARGET},
        {"columns": [{"id": "one", "name": "key"}], "newColumn": "__open_wrangler_internal_row_id_x"},
    ],
)
def test_mark_duplicates_rejects_invalid_public_command(params: dict[str, Any]) -> None:
    with pytest.raises(OperationError):
        validate_step({"id": "mark", "kind": "markDuplicates", "params": params})


@pytest.mark.parametrize(
    ("identifier", "name", "target"),
    [
        ("stale", KEY, TARGET),
        ("c:source:0", "stale", TARGET),
        ("c:source:0", KEY, KEY),
    ],
)
def test_mark_duplicates_binds_exact_identity_and_fresh_output(
    engine: tuple[Any, bool], identifier: str, name: str, target: str
) -> None:
    adapter, _ = engine
    source = native_frame(engine, [1, 1], "BIGINT")
    schema = adapter.schema(source)
    public = validate_step(
        {
            "id": "mark",
            "kind": "markDuplicates",
            "params": {
                "columns": [{"id": identifier, "name": name}],
                "newColumn": target,
            },
        }
    )
    with pytest.raises(ColumnBindingError):
        bind_step(public, schema, source_lineage(schema))


@pytest.mark.parametrize("positions", [[0], [0, 1]])
def test_pandas_mark_preserves_single_and_composite_missing_equality(positions: list[int]) -> None:
    values = pd.Series([None, np.nan, pd.NA, pd.NaT], dtype=object)
    source = pd.concat([values, values.copy()], axis=1)
    source.columns = pd.Index([7, 7])
    source.index = pd.Index([2, 2, 1, 1], name="original rows")
    adapter = PandasEngine()
    live, generated, bound, _ = marked(adapter, source, positions)
    expected = [len(positions) == 2] * 4
    drop = {"id": "drop", "kind": "dropDuplicates", "params": {"columns": bound["params"]["columns"], "keep": "none"}}
    assert len(adapter.apply_transform(source, drop)) == (4 if len(positions) == 1 else 0)
    for result in (live, generated):
        assert_marked(adapter, source, result, expected)


def test_duckdb_mark_evaluates_numbered_source_once_per_execution() -> None:
    seen: list[int] = []

    def value(index: int) -> float:
        seen.append(index)
        return -0.0 if index % 2 == 0 else 0.0

    duckdb.create_function("ow_mark_test_source", value, ["BIGINT"], "DOUBLE", side_effects=True)
    adapter = DuckDBEngine()
    try:
        source = duckdb.sql("SELECT [ow_mark_test_source(i)] AS key, i AS row FROM range(7) t(i)")
        frame = adapter.normalize_notebook_relation(source)
        schema = adapter.schema(frame)
        lineage = source_lineage(schema)
        bound = bind_step(
            validate_step(
                {
                    "id": "mark",
                    "kind": "markDuplicates",
                    "params": {
                        "columns": [lineage[0]],
                        "newColumn": TARGET,
                    },
                }
            ),
            schema,
            lineage,
        )
        namespace: dict[str, Any] = {}
        exec(adapter.compile_plan([bound]), namespace)
        live = adapter.apply_transform(frame, bound)
        for read in (
            lambda: adapter._terminal_rows(live, "SELECT * FROM ow"),
            lambda: namespace["clean_data"](source).fetchall(),
        ):
            seen.clear()
            rows = read()
            assert seen == list(range(7))
            assert [row[-1] for row in rows] == [True] * 7
            assert [row[1] for row in rows] == list(range(7))
            assert [row[0][0].hex() for row in rows] == [(-0.0 if i % 2 == 0 else 0.0).hex() for i in range(7)]
    finally:
        adapter.close()
        duckdb.remove_function("ow_mark_test_source")


def test_duckdb_mark_rejects_casefold_output_collision_live_and_generated() -> None:
    adapter = DuckDBEngine()
    try:
        source = duckdb.sql("SELECT 1 AS key")
        schema = adapter.schema(source)
        lineage = source_lineage(schema)
        bound = bind_step(
            validate_step(
                {
                    "id": "mark",
                    "kind": "markDuplicates",
                    "params": {
                        "columns": [lineage[0]],
                        "newColumn": "KEY",
                    },
                }
            ),
            schema,
            lineage,
        )
        namespace: dict[str, Any] = {}
        exec(adapter.compile_plan([bound]), namespace)
        with pytest.raises(ValueError, match="differ only by case"):
            namespace["clean_data"](source)
        with pytest.raises(EngineError, match="differ only by case"):
            adapter.apply_transform(source, bound)
        assert source.fetchall() == [(1,)]
    finally:
        adapter.close()


@pytest.mark.parametrize("values", [[], [2, 2, 1, None]], ids=["empty", "populated"])
def test_generated_mark_rechecks_occupied_outputs_after_binding(engine, values):
    adapter, _ = engine
    source = native_frame(engine, values, "BIGINT")
    lineage = source_lineage(adapter.schema(source))
    public = validate_step(
        {"id": "mark", "kind": "markDuplicates", "params": {"columns": [lineage[0]], "newColumn": TARGET}}
    )
    bound = bind_step(public, adapter.schema(source), lineage)
    namespace: dict[str, Any] = {}
    exec(adapter.compile_plan([bound]), namespace)

    def append(frame, name):
        if isinstance(frame, pd.DataFrame):
            return frame.assign(**{name: False})
        if isinstance(frame, (pl.DataFrame, pl.LazyFrame)):
            return frame.with_columns(pl.lit(False).alias(name))
        return frame.project('*, FALSE AS "' + name.replace('"', '""') + '"')

    resident = append(source, TARGET)
    before = materialize(resident)
    before = (
        before.copy(deep=True)
        if isinstance(before, pd.DataFrame)
        else before.clone()
        if isinstance(before, pl.DataFrame)
        else before.fetchall()
    )
    with pytest.raises(ColumnBindingError, match="collides"):
        bind_step(public, adapter.schema(resident), source_lineage(adapter.schema(resident)))
    try:
        with pytest.raises(ValueError, match="(?i)collid|duplicat|exist"):
            materialize(namespace["clean_data"](resident))
    finally:
        actual = materialize(resident)
        if isinstance(actual, pd.DataFrame):
            assert_frame_equal(actual, before, check_exact=True)
        elif isinstance(actual, pl.DataFrame):
            assert isinstance(before, pl.DataFrame)
            assert_polars_frame_equal(actual, before)
        else:
            assert actual.fetchall() == before

    harmless = append(source, "spare")
    bind_step(public, adapter.schema(harmless), source_lineage(adapter.schema(harmless)))
    assert_marked(adapter, harmless, namespace["clean_data"](harmless), [True, True, False, False] if values else [])


def test_generated_mark_keeps_large_retained_destination_within_code_limit(engine):
    from openwrangler_runtime.session_plan import compile_plan_with_limits, preflight_retained_plan

    adapter, _ = engine
    source = native_frame(engine, [1, 1], "BIGINT")
    lineage = source_lineage(adapter.schema(source))
    public = validate_step(
        {
            "id": "mark",
            "kind": "markDuplicates",
            "params": {"columns": [lineage[0]], "newColumn": "fresh_" + "x" * 2_150_000},
        }
    )
    preflight_retained_plan([public])
    bound = bind_step(public, adapter.schema(source), lineage)
    code = compile_plan_with_limits(adapter, [bound])
    compile(code, "<large-retained-Mark-program>", "exec")
