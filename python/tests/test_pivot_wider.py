from __future__ import annotations

import sys
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd
import polars as pl
import pytest
from polars.testing import assert_frame_equal

from openwrangler_runtime._column_binding import ColumnBindingError, bind_step
from openwrangler_runtime.engines.base import EngineError, typed_selection_value
from openwrangler_runtime.engines.duckdb_engine import DuckDBEngine
from openwrangler_runtime.engines.pandas_engine import PandasEngine
from openwrangler_runtime.engines.polars_engine import PolarsEngine
from openwrangler_runtime.lineage import derive_lineage
from openwrangler_runtime.operations import OperationError, validate_step
from openwrangler_runtime.session import SessionManager


@pytest.mark.parametrize("family", ["float32", "float64", "longdouble"])
@pytest.mark.parametrize("names", [["x", "x", "x", "x", "y"], ["x", "y", "x", "x", "y"]])
def test_pandas_mixed_numeric_pivot_keys_preserve_distinct_original_identifiers(family, names):
    import numpy as np

    power = {"float32": 90, "float64": 120, "longdouble": 126}[family]
    first = getattr(np, family)(2**power)
    exact = 2**power + sys.hash_info.modulus
    source = pd.DataFrame(
        {
            "id": pd.Series([first, exact, 0.5, None, np.nan], dtype=object),
            "key": pd.Series(names, dtype="string"),
            "value": pd.Series([10, 20, 30, 40, 50], dtype="Int64"),
        }
    )
    source.index = pd.Index(["same"] * len(source), name="source")
    original = source.copy(deep=True)
    runtime = PandasEngine()
    operation = bind(runtime, source)
    runtime.validate_transform_preflight(source, operation, runtime.shape(source))
    for result in (runtime.apply_transform(source, operation), execute_generated(runtime, source, operation)):
        assert len(result) == 4
        assert result["id"].iloc[0] is first
        assert type(result["id"].iloc[1]) is int and result["id"].iloc[1] == exact
        assert result["id"].iloc[2] == 0.5 and result["id"].iloc[3] is pd.NA
        pd.testing.assert_series_equal(
            result["x_value"], pd.Series([10, 20 if names[1] == "x" else None, 30, 40], name="x_value", dtype="Int64")
        )
        pd.testing.assert_series_equal(
            result["y_value"],
            pd.Series([None, 20 if names[1] == "y" else None, None, 50], name="y_value", dtype="Int64"),
        )
        pd.testing.assert_frame_equal(source, original)


def token(value: str) -> dict[str, Any]:
    result = typed_selection_value(value, "string")
    assert result is not None
    return result


def test_pandas_mixed_numeric_pivot_retains_each_joint_groups_first_identifier_row(monkeypatch):
    from unittest.mock import Mock

    import numpy as np

    from openwrangler_runtime.engines import pandas_engine

    preparation = Mock(wraps=pandas_engine._pandas_pivot_wider_identifier_frame)
    monkeypatch.setattr(pandas_engine, "_pandas_pivot_wider_identifier_frame", preparation)

    identifiers = [np.float32(-0.0), np.float32(0.0), 1, np.float32(1.0)]
    id_column = ("id", "raw")
    partition_column = ("partition", "raw")
    source = pd.DataFrame(
        {
            id_column: pd.Series(identifiers, dtype=object),
            partition_column: ["a", "b", "c", "d"],
            "key": pd.Series(["x"] * 4, dtype="string"),
            "value": pd.Series([10, 20, 30, 40], dtype="Int64"),
        }
    )
    source.index = pd.Index(["same"] * 4, name="source")
    before = source.copy(deep=True)
    runtime = PandasEngine()
    operation = bind(runtime, source, public_step(names_id="c:source:2", values_id="c:source:3"))
    runtime.validate_transform_preflight(source, operation, runtime.shape(source))
    assert preparation.call_count == 1
    live = runtime.apply_transform(source, operation)
    assert preparation.call_count == 2
    for result in (live, execute_generated(runtime, source, operation)):
        pd.testing.assert_index_equal(
            result.columns,
            pd.Index([id_column, partition_column, "x_value", "y_value"], dtype="object", tupleize_cols=False),
        )
        assert result[partition_column].tolist() == ["a", "b", "c", "d"]
        assert all(actual is expected for actual, expected in zip(result[id_column].array, identifiers, strict=True))
        pd.testing.assert_series_equal(result["x_value"], pd.Series([10, 20, 30, 40], dtype="Int64", name="x_value"))
        assert result["y_value"].isna().all()
    pd.testing.assert_frame_equal(source, before)


@pytest.mark.parametrize("names", [["x", "x"], ["x", "y"]])
def test_pandas_pivot_preserves_distinct_fractional_sparse_identifiers(names: list[str]) -> None:
    import warnings

    import numpy as np

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always", FutureWarning)
        try:
            identifiers = pd.Series(np.array([1.5, 1], dtype=object), dtype=pd.SparseDtype("uint64", 1.5))
        except ValueError as error:
            assert "fill_value must be a valid value" in str(error)
            return
    assert all(
        issubclass(item.category, FutureWarning) and "arbitrary scalar fill_value" in str(item.message)
        for item in caught
    )
    frame = pd.DataFrame(
        {"id": identifiers, "key": pd.Series(names, dtype="string"), "value": pd.Series([10, 20], dtype="Int64")}
    )
    original = frame.copy(deep=True)
    runtime = PandasEngine()
    operation = bind(runtime, frame)
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    expected = pd.DataFrame(
        {
            "id": pd.Series([1.5, 1], dtype=object),
            "x_value": pd.Series([10, 20 if names[1] == "x" else None], dtype="Int64"),
            "y_value": pd.Series([None, 20 if names[1] == "y" else None], dtype="Int64"),
        }
    )
    for result in (runtime.apply_transform(frame, operation), execute_generated(runtime, frame, operation)):
        pd.testing.assert_frame_equal(result, expected)
    pd.testing.assert_frame_equal(frame, original)


def public_step(
    *,
    output_names: tuple[str, str] = ("x_value", "y_value"),
    keys: tuple[str, str] = ("x", "y"),
    names_id: str = "c:source:1",
    values_id: str = "c:source:2",
) -> dict[str, Any]:
    return {
        "id": "pivot-wider",
        "kind": "pivotWider",
        "params": {
            "namesFrom": {"id": names_id, "name": "key"},
            "valuesFrom": {"id": values_id, "name": "value"},
            "outputs": [
                {"key": token(keys[0]), "name": output_names[0]},
                {"key": token(keys[1]), "name": output_names[1]},
            ],
        },
    }


def source_lineage(schema: list[dict[str, Any]]) -> list[dict[str, str]]:
    return [{"id": f"c:source:{index}", "name": str(column["name"])} for index, column in enumerate(schema)]


def bind(engine: Any, frame: Any, step: dict[str, Any] | None = None) -> dict[str, Any]:
    schema = engine.schema(frame)
    return bind_step(validate_step(step or public_step()), schema, source_lineage(schema))


def rows(frame: Any) -> list[tuple[Any, ...]]:
    if isinstance(frame, pd.DataFrame):
        return [tuple(None if pd.isna(value) else value for value in row) for row in frame.itertuples(index=False)]
    if isinstance(frame, pl.LazyFrame):
        frame = frame.collect()
    if isinstance(frame, pl.DataFrame):
        return list(frame.iter_rows())
    if hasattr(frame, "sql"):
        return duckdb.sql(frame.sql).fetchall()
    return frame.fetchall()


def execute_generated(engine: Any, frame: Any, step: dict[str, Any]) -> Any:
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([step]), namespace, namespace)
    return namespace["clean_data"](frame)


@pytest.mark.parametrize(
    ("name", "occupied"),
    [
        ("__ow_pivot_wider_source_order", None),
        ("__OW_PIVOT_WIDER_SOURCE_ORDER", None),
        ("__ow_pivot_wider_source_order_1", "__ow_pivot_wider_source_order"),
        ("__ow_pivot_wider_identifier_0", None),
        ("__ow_pivot_wider_names_key", None),
    ],
)
def test_duckdb_pivot_wider_preserves_requested_auxiliary_output_names(name, occupied):
    connection = duckdb.connect()
    engine = DuckDBEngine()
    try:
        keep = occupied or "keep"
        query = f"SELECT * FROM (VALUES ('k', 'x', 10::BIGINT), ('k', 'y', NULL)) t(\"{keep}\", key, value)"
        connection.execute("CREATE TABLE owned_source AS " + query)
        source = connection.table("owned_source")
        live_source = duckdb.sql(query)
        assert source.fetchall() == live_source.fetchall()
        assert source.columns == live_source.columns and source.types == live_source.types
        before = (source.sql_query(), source.fetchall(), source.columns, list(map(str, source.types)))
        operation = bind(engine, source, public_step(output_names=(name, "wide_y")))
        live = engine.apply_transform(live_source, operation)
        generated = execute_generated(engine, source, operation)
        for result in (live, generated):
            assert result.columns == [keep, name, "wide_y"]
            assert list(map(str, result.types)) == ["VARCHAR", "BIGINT", "BIGINT"]
        assert engine._terminal_rows(live, "SELECT * FROM ow") == [("k", 10, None)]
        assert generated.fetchall() == [("k", 10, None)]
        assert generated.aggregate("count(*), (SELECT count(*) FROM owned_source)").fetchone() == (1, 2)
        assert before == (source.sql_query(), source.fetchall(), source.columns, list(map(str, source.types)))
        assert live_source.fetchall() == source.fetchall()
        assert connection.execute("SHOW TABLES").fetchall() == [("owned_source",)]
    finally:
        engine.close()
        connection.close()


@pytest.mark.parametrize(
    ("value", "extra"),
    [
        ("__ow_pivot_wider_source_order", None),
        ("__OW_PIVOT_WIDER_SOURCE_ORDER", None),
        ("__ow_pivot_wider_group", None),
        ("__ow_pivot_wider_names_key", None),
        ("__ow_pivot_wider_identifier_0", "keep"),
        ("__ow_pivot_wider_source_order_1", "__ow_pivot_wider_source_order"),
        ("ordinary_missing", None),
    ],
)
def test_duckdb_generated_pivot_wider_refuses_missing_value_before_temporary_substitution(value, extra):
    connection = duckdb.connect()
    engine = DuckDBEngine()
    try:
        query = f"SELECT * FROM (VALUES ('x', 10::BIGINT), ('y', 20)) t(key,\"{value}\")"
        if extra:
            query = f'SELECT *, 7 AS "{extra}" FROM ({query})'
        connection.execute("CREATE TABLE owned_source AS " + query)
        source = connection.table("owned_source")
        before = (source.sql_query(), source.fetchall(), source.columns, list(map(str, source.types)))
        request = public_step(names_id="c:source:0", values_id="c:source:1")
        request["params"]["valuesFrom"]["name"] = value
        operation = bind(engine, source, request)
        namespace: dict[str, Any] = {}
        exec(engine.compile_plan([operation]), namespace, namespace)
        clean_data = namespace["clean_data"]
        original = clean_data(source)
        assert original.fetchall() == ([(7, 10, 20)] if extra else [(10, 20)])
        assert list(map(str, original.types)) == (["INTEGER", "BIGINT", "BIGINT"] if extra else ["BIGINT", "BIGINT"])
        assert original.aggregate("count(*), (SELECT count(*) FROM owned_source)").fetchone() == (1, 2)
        rebound = source.project(
            ", ".join('"' + column.replace('"', '""') + '"' for column in source.columns if column != value)
        )
        with pytest.raises(duckdb.BinderException, match="Referenced column"):
            clean_data(rebound)
        with pytest.raises(ColumnBindingError):
            bind(engine, rebound, request)
        assert before == (source.sql_query(), source.fetchall(), source.columns, list(map(str, source.types)))
        assert connection.execute("SHOW TABLES").fetchall() == [("owned_source",)]
    finally:
        engine.close()
        connection.close()


def test_duckdb_pivot_wider_public_page_retains_declared_output_and_undo(tmp_path: Path):
    path = tmp_path / "pivot.csv"
    path.write_text("key,value\nx,10\ny,20\n")
    before = path.read_bytes()
    manager = SessionManager()
    try:
        opened = manager.open_session(
            {"kind": "file", "label": path.name, "path": str(path)}, backend="duckdb", mode="editing", page_size=10
        )
        sid = opened["metadata"]["sessionId"]
        session = manager.sessions[sid]
        assert isinstance(session.engine, DuckDBEngine)
        original = session.engine._terminal_rows(session.original, "SELECT * FROM ow")
        refs = {c["name"]: {"id": c["id"], "name": c["name"]} for c in opened["metadata"]["schema"]}
        operation = public_step(output_names=("__ow_pivot_wider_source_order", "wide_y"))
        operation["params"].update(namesFrom=refs["key"], valuesFrom=refs["value"])
        preview = manager.preview_step(sid, session.revision, operation, 0, 10)
        applied = manager.apply_draft(sid, preview["revision"], 0, 10)
        for response in (preview, applied):
            assert [c["name"] for c in response["metadata"]["schema"]] == ["__ow_pivot_wider_source_order", "wide_y"]
            assert [[cell["raw"] for cell in row["values"]] for row in response["page"]["rows"]] == [[10, 20]]
        with duckdb.connect() as connection:
            source = connection.read_csv(str(path))
            namespace: dict[str, Any] = {}
            exec(applied["code"], namespace, namespace)
            generated = namespace["clean_data"](source)
            assert generated.columns == ["__ow_pivot_wider_source_order", "wide_y"]
            assert generated.fetchall() == [(10, 20)]
        undone = manager.undo_step(sid, session.revision, 0, 10)
        assert undone["page"]["rows"] == opened["page"]["rows"]
        assert session.engine._terminal_rows(session.original, "SELECT * FROM ow") == original
        assert path.read_bytes() == before
    finally:
        manager.close_all()


@pytest.mark.parametrize(
    "candidate",
    [
        {**public_step(), "params": {**public_step()["params"], "valuesFrom": {"id": "c:source:1", "name": "key"}}},
        {**public_step(), "params": {**public_step()["params"], "outputs": [public_step()["params"]["outputs"][0]]}},
        {
            **public_step(),
            "params": {
                **public_step()["params"],
                "outputs": [
                    {"key": token("x"), "name": "one"},
                    {"key": token("x"), "name": "two"},
                ],
            },
        },
        {
            **public_step(),
            "params": {
                **public_step()["params"],
                "outputs": [
                    {"key": token("x"), "name": "Straße"},
                    {"key": token("y"), "name": "STRASSE"},
                ],
            },
        },
    ],
)
def test_pivot_wider_public_contract_rejects_ambiguous_shapes(candidate: dict[str, Any]) -> None:
    with pytest.raises(OperationError):
        validate_step(candidate)


@pytest.mark.parametrize("lazy", [False, True])
def test_pivot_wider_polars_live_and_generated_preserve_order_nulls_and_laziness(lazy: bool) -> None:
    frame = pl.DataFrame({"group": ["b", "a", "b"], "key": ["x", "x", "y"], "value": [3, 1, 4]})
    source = frame.lazy() if lazy else frame
    step = bind(PolarsEngine(), source)
    expected = [("b", 3, 4), ("a", 1, None)]

    live = PolarsEngine().apply_transform(source, step)
    generated = execute_generated(PolarsEngine(), source, step)
    assert isinstance(live, pl.LazyFrame) is lazy
    assert isinstance(generated, pl.LazyFrame) is lazy
    assert rows(live) == expected
    assert rows(generated) == expected
    assert rows(source) == [("b", "x", 3), ("a", "x", 1), ("b", "y", 4)]


@pytest.mark.parametrize("lazy", [False, True])
@pytest.mark.parametrize("collision", ["identifier", "namesFrom", "output"])
def test_pivot_wider_polars_accepts_names_used_by_temporary_columns(lazy: bool, collision: str) -> None:
    frame = pl.DataFrame(
        {"group": [None, None, "b"], "key": ["x", "y", "x"], "value": pl.Series([3, None, 4], dtype=pl.Int64)}
    )
    candidate = public_step()
    expected = pl.DataFrame(
        {"group": [None, "b"], "x_value": pl.Series([3, 4], dtype=pl.Int64), "y_value": [None, None]},
        schema_overrides={"group": pl.String, "y_value": pl.Int64},
    )
    if collision == "identifier":
        frame = frame.rename({"group": "len"})
        expected = expected.rename({"group": "len"})
    elif collision == "namesFrom":
        frame = frame.rename({"key": "len"})
        candidate["params"]["namesFrom"]["name"] = "len"
    else:
        frame = frame.head(2).drop("group")
        output = "__open_wrangler_pivot_wider_group"
        candidate = public_step(output_names=(output, "y_value"), names_id="c:source:0", values_id="c:source:1")
        expected = expected.head(1).drop("group").rename({"x_value": output})
    source = frame.lazy() if lazy else frame
    engine = PolarsEngine()
    step = bind(engine, source, candidate)
    baseline = frame.clone()
    engine.validate_transform_preflight(source, step, engine.shape(source))

    for result in [engine.apply_transform(source, step), execute_generated(engine, source, step)]:
        assert isinstance(result, pl.LazyFrame) is lazy
        assert_frame_equal(result.collect() if isinstance(result, pl.LazyFrame) else result, expected)
    assert_frame_equal(source.collect() if isinstance(source, pl.LazyFrame) else source, baseline)


@pytest.mark.parametrize("lazy", [False, True])
def test_pivot_wider_polars_rejects_duplicate_null_identifiers_named_len(lazy: bool) -> None:
    frame = pl.DataFrame({"len": pl.Series([None, None], dtype=pl.String), "key": ["x", "x"], "value": [1, 2]})
    source = frame.lazy() if lazy else frame
    engine = PolarsEngine()
    step = bind(engine, source)
    baseline = frame.clone()

    with pytest.raises(EngineError, match="duplicate identifier-and-key rows"):
        engine.apply_transform(source, step)
    with pytest.raises(ValueError, match="duplicate identifier-and-key rows"):
        execute_generated(engine, source, step)
    assert_frame_equal(source.collect() if isinstance(source, pl.LazyFrame) else source, baseline)


def test_pivot_wider_pandas_live_and_generated_preserve_order_nulls_and_source() -> None:
    frame = pd.DataFrame(
        {
            "group": ["b", "a", "b"],
            "key": pd.Series(["x", "x", "y"], dtype="category"),
            "value": pd.Series([3, 1, 4], dtype="int64"),
        }
    )
    step = bind(PandasEngine(), frame)
    expected = [("b", 3, 4), ("a", 1, None)]

    live = PandasEngine().apply_transform(frame, step)
    generated = execute_generated(PandasEngine(), frame, step)
    assert rows(live) == expected
    assert rows(generated) == expected
    assert str(live["x_value"].dtype) == "Int64"
    assert str(generated["y_value"].dtype) == "Int64"
    assert rows(frame) == [("b", "x", 3), ("a", "x", 1), ("b", "y", 4)]


@pytest.mark.parametrize("missing", [None, pd.NaT], ids=["None", "NaT"])
@pytest.mark.parametrize("family", ["integer", "boolean", "float", "decimal", "binary", "mixed"])
def test_pandas_pivot_wider_object_identifiers_match_generated_admission(family: str, missing: Any) -> None:
    first, second = {
        "integer": (1, 2),
        "boolean": (True, False),
        "float": (1.5, 2.5),
        "decimal": (Decimal("1.25"), Decimal("2.25")),
        "binary": (b"a", b"b"),
        "mixed": (1, "1"),
    }[family]
    frame = pd.DataFrame(
        {
            "group": pd.Series([first, missing, second, first], dtype=object),
            "key": ["x", "x", "x", "y"],
            "value": pd.Series([10, 20, 30, 40], dtype="Int64"),
        }
    )
    frame.index = pd.Index(["source"] * 4, name="retained")
    frame.attrs["annotation"] = "retained"
    before = frame.copy(deep=True)
    expected = pd.DataFrame(
        {
            "group": pd.Series([first, pd.NA, second], dtype="Int64" if family == "integer" else object),
            "x_value": pd.Series([10, 20, 30], dtype="Int64"),
            "y_value": pd.Series([40, None, None], dtype="Int64"),
        }
    )
    expected.columns = pd.Index(expected.columns, dtype="object")
    for actual in _pandas_pivot_results(frame):
        pd.testing.assert_frame_equal(actual, expected)
        pd.testing.assert_frame_equal(frame, before)
        assert frame.attrs == before.attrs


@pytest.mark.filterwarnings("error:'or' operations between boolean dtype and string are deprecated:DeprecationWarning")
@pytest.mark.parametrize("empty", [False, True])
def test_pandas_pivot_wider_empty_object_identifiers_keep_nullable_results(empty: bool) -> None:
    frame = pd.DataFrame(
        {
            "group": pd.Series([] if empty else [None, pd.NaT], dtype=object),
            "key": pd.Series([] if empty else ["x", "y"], dtype="string"),
            "value": pd.Series([] if empty else [10, 20], dtype="Int64"),
        }
    )
    before = frame.copy(deep=True)
    expected = pd.DataFrame(
        {
            "group": pd.Series([] if empty else [pd.NA], dtype=object),
            "x_value": pd.Series([] if empty else [10], dtype="Int64"),
            "y_value": pd.Series([] if empty else [20], dtype="Int64"),
        }
    )
    expected.columns = pd.Index(expected.columns, dtype="object")
    for actual in _pandas_pivot_results(frame):
        pd.testing.assert_frame_equal(actual, expected)
    pd.testing.assert_frame_equal(frame, before)


@pytest.mark.parametrize("family", ["categorical", "unsigned", "boolean"])
def test_pandas_pivot_wider_nullable_allocation_preserves_native_storage(family: str) -> None:
    dtype, values, x_values, y_values = {
        "categorical": (
            pd.CategoricalDtype(["unused", "large", "small"], ordered=True),
            ["large", "small", "large"],
            ["large", "small"],
            ["large", None],
        ),
        "unsigned": (pd.UInt64Dtype(), [2**63 + 1, 2, 3], [2**63 + 1, 2], [3, None]),
        "boolean": (pd.BooleanDtype(), [True, False, True], [True, False], [True, None]),
    }[family]
    frame = pd.DataFrame(
        {
            "group": pd.Series(["b", "a", "b"], dtype="string"),
            "key": ["x", "x", "y"],
            "value": pd.Series(values, dtype=dtype),
        }
    )
    frame.index = pd.Index(["same"] * 3, name="source")
    frame.attrs["annotation"] = "retained"
    before = frame.copy(deep=True)
    expected = pd.DataFrame(
        {
            "group": pd.Series(["b", "a"], dtype="string"),
            "x_value": pd.Series(x_values, dtype=dtype),
            "y_value": pd.Series(y_values, dtype=dtype),
        }
    )
    expected.columns = pd.Index(expected.columns, dtype="object")
    for actual in _pandas_pivot_results(frame):
        pd.testing.assert_frame_equal(actual, expected)
        pd.testing.assert_frame_equal(frame, before)
        assert frame.attrs == before.attrs


@pytest.mark.parametrize("empty", [False, True])
def test_pandas_pivot_wider_nullable_allocation_without_identifiers(empty: bool) -> None:
    frame = pd.DataFrame(
        {
            "key": pd.Series([] if empty else ["x"], dtype="string"),
            "value": pd.Series([] if empty else [2**63 + 1], dtype="uint64"),
        }
    )
    before = frame.copy(deep=True)
    engine = PandasEngine()
    step = bind(engine, frame, public_step(names_id="c:source:0", values_id="c:source:1"))
    expected = pd.DataFrame(
        {
            "x_value": pd.Series([] if empty else [2**63 + 1], dtype="UInt64"),
            "y_value": pd.Series([] if empty else [None], dtype="UInt64"),
        }
    )
    for actual in (engine.apply_transform(frame, step), execute_generated(engine, frame, step)):
        pd.testing.assert_frame_equal(actual, expected)
        pd.testing.assert_frame_equal(frame, before)


def test_pandas_pivot_wider_generated_allocation_keeps_caller_bindings() -> None:
    frame = pd.DataFrame({"group": ["a", "a"], "key": ["x", "y"], "value": [1, 2]})
    before = frame.copy(deep=True)
    engine = PandasEngine()
    step = bind(engine, frame)
    names = [
        "pd",
        "np",
        "Integral",
        "Real",
        "Mapping",
        "_open_wrangler_nullable_pivot_series",
        "_pandas_nullable_pivot_series",
        "_open_wrangler_pivot_wider_names_valid",
        "_open_wrangler_pivot_wider_result",
        "_open_wrangler_scalar_values",
        "_open_wrangler_restore_group_key",
        "_open_wrangler_object_semantic_type",
    ]
    namespace: dict[str, Any] = dict.fromkeys(names, frame)
    code = engine.compile_plan([step])
    assert "openwrangler_runtime" not in code
    exec(code, namespace, namespace)
    expected = engine.apply_transform(frame, step)
    for _ in range(2):
        pd.testing.assert_frame_equal(namespace["clean_data"](frame), expected)
        assert all(namespace[name] is frame for name in names)
        pd.testing.assert_frame_equal(frame, before)


def test_pivot_wider_duckdb_live_and_generated_preserve_order_nulls_and_source() -> None:
    frame = duckdb.sql(
        "SELECT * FROM (VALUES ('b', 'x', 3::BIGINT), ('a', 'x', 1::BIGINT), "
        "('b', 'y', 4::BIGINT)) source(\"group\", key, value)"
    )
    step = bind(DuckDBEngine(), frame)
    expected = [("b", 3, 4), ("a", 1, None)]

    assert rows(DuckDBEngine().apply_transform(frame, step)) == expected
    assert rows(execute_generated(DuckDBEngine(), frame, step)) == expected
    assert rows(frame) == [("b", "x", 3), ("a", "x", 1), ("b", "y", 4)]


def test_pivot_wider_pandas_uses_portable_group_key_identity_live_and_generated() -> None:
    frame = pd.DataFrame(
        {
            "missing_id": [None, float("nan"), None, Decimal("NaN")],
            "wide_id": [10**30] * 4,
            "decimal_id": [Decimal("1.00")] * 4,
            "date_id": [date(2026, 8, 19)] * 4,
            "text_id": ["Case", "Case", "case", "case"],
            "key": ["x", "y", "x", "y"],
            "value": [1, 2, 3, 4],
        }
    )
    step = bind(PandasEngine(), frame, public_step(names_id="c:source:5", values_id="c:source:6"))
    expected = [
        (None, 10**30, Decimal("1.00"), date(2026, 8, 19), "Case", 1, 2),
        (None, 10**30, Decimal("1.00"), date(2026, 8, 19), "case", 3, 4),
    ]

    assert rows(PandasEngine().apply_transform(frame, step)) == expected
    assert rows(execute_generated(PandasEngine(), frame, step)) == expected
    assert len(frame) == 4


def test_pivot_wider_polars_uses_portable_group_key_identity_live_and_generated() -> None:
    frame = pl.DataFrame(
        {
            "missing_id": pl.Series([None, float("nan"), None, float("nan")], dtype=pl.Float64),
            "wide_id": pl.Series([10**30] * 4, dtype=pl.Int128),
            "decimal_id": pl.Series([Decimal("1.00")] * 4, dtype=pl.Decimal(10, 2)),
            "date_id": pl.Series([date(2026, 8, 19)] * 4, dtype=pl.Date),
            "text_id": ["Case", "Case", "case", "case"],
            "key": ["x", "y", "x", "y"],
            "value": [1, 2, 3, 4],
        }
    )
    step = bind(PolarsEngine(), frame, public_step(names_id="c:source:5", values_id="c:source:6"))
    expected = [
        (None, 10**30, Decimal("1.00"), date(2026, 8, 19), "Case", 1, 2),
        (None, 10**30, Decimal("1.00"), date(2026, 8, 19), "case", 3, 4),
    ]

    assert rows(PolarsEngine().apply_transform(frame, step)) == expected
    assert rows(execute_generated(PolarsEngine(), frame, step)) == expected
    assert frame.height == 4


def test_pivot_wider_duckdb_uses_collation_free_portable_group_key_identity() -> None:
    frame = duckdb.sql(
        "SELECT missing_id, wide_id, decimal_id, date_id, text_id COLLATE nocase AS text_id, "
        "key COLLATE nocase AS key, value FROM (VALUES "
        "(NULL::DOUBLE, 1000000000000000000000000000000::HUGEINT, 1.00::DECIMAL(10,2), "
        "DATE '2026-08-19', 'Case', 'x', 1), "
        "(CAST('NaN' AS DOUBLE), 1000000000000000000000000000000::HUGEINT, 1.00::DECIMAL(10,2), "
        "DATE '2026-08-19', 'Case', 'X', 2), "
        "(NULL::DOUBLE, 1000000000000000000000000000000::HUGEINT, 1.00::DECIMAL(10,2), "
        "DATE '2026-08-19', 'case', 'x', 3), "
        "(CAST('NaN' AS DOUBLE), 1000000000000000000000000000000::HUGEINT, 1.00::DECIMAL(10,2), "
        "DATE '2026-08-19', 'case', 'X', 4)) source(missing_id, wide_id, decimal_id, date_id, text_id, key, value)"
    )
    step = bind(
        DuckDBEngine(),
        frame,
        public_step(keys=("x", "X"), names_id="c:source:5", values_id="c:source:6"),
    )
    expected = [
        (None, 10**30, Decimal("1.00"), date(2026, 8, 19), "Case", 1, 2),
        (None, 10**30, Decimal("1.00"), date(2026, 8, 19), "case", 3, 4),
    ]

    assert rows(DuckDBEngine().apply_transform(frame, step)) == expected
    assert rows(execute_generated(DuckDBEngine(), frame, step)) == expected
    assert len(rows(frame)) == 4


@pytest.mark.parametrize("engine_name", ["pandas", "polars", "duckdb"])
@pytest.mark.parametrize("failure", ["duplicate", "unknown", "null"])
def test_pivot_wider_live_and_generated_reject_domain_failures_atomically(engine_name: str, failure: str) -> None:
    values = {
        "duplicate": [("a", "x", 1), ("a", "x", 2)],
        "unknown": [("a", "z", 1)],
        "null": [("a", None, 1)],
    }[failure]
    if engine_name == "pandas":
        engine: Any = PandasEngine()
        frame: Any = pd.DataFrame(values, columns=pd.Index(["group", "key", "value"]))
    elif engine_name == "polars":
        engine = PolarsEngine()
        frame = pl.DataFrame(values, schema=["group", "key", "value"], orient="row")
        if failure == "null":
            frame = frame.with_columns(pl.col("key").cast(pl.String))
    else:
        engine = DuckDBEngine()
        literals = ", ".join(
            f"('{group}', {('NULL::VARCHAR' if key is None else repr(key))}, {value}::BIGINT)"
            for group, key, value in values
        )
        frame = duckdb.sql(f'SELECT * FROM (VALUES {literals}) source("group", key, value)')
    step = bind(engine, frame)
    baseline = rows(frame)

    with pytest.raises(Exception, match="duplicate identifier|declared typed key"):
        engine.apply_transform(frame, step)
    with pytest.raises(Exception, match="duplicate identifier|declared typed key"):
        execute_generated(engine, frame, step)
    assert rows(frame) == baseline


def test_pivot_wider_lineage_retains_identifiers_and_assigns_outputs_by_declared_ordinal() -> None:
    before = [
        {"id": "c:source:0", "name": "group"},
        {"id": "c:source:1", "name": "key"},
        {"id": "c:source:2", "name": "value"},
    ]
    after = [
        {"name": "group", "type": "string", "rawType": "string", "nullable": False},
        {"name": "x_value", "type": "integer", "rawType": "Int64", "nullable": True},
        {"name": "y_value", "type": "integer", "rawType": "Int64", "nullable": True},
    ]
    assert derive_lineage(before, after, public_step()) == [
        {"id": "c:source:0", "name": "group"},
        {"id": "c:step:pivot-wider:0", "name": "x_value"},
        {"id": "c:step:pivot-wider:1", "name": "y_value"},
    ]


def test_pivot_wider_binding_rejects_container_values_and_output_collisions() -> None:
    schema = [
        {"name": "group", "type": "string", "rawType": "string"},
        {"name": "key", "type": "string", "rawType": "string"},
        {"name": "value", "type": "list", "rawType": "list"},
    ]
    with pytest.raises(ColumnBindingError, match="valuesFrom must be a portable scalar"):
        bind_step(validate_step(public_step()), schema, source_lineage(schema))
    scalar_schema = [*schema[:2], {**schema[2], "type": "integer", "rawType": "int64"}]
    with pytest.raises(ColumnBindingError, match="collides case-insensitively"):
        bind_step(validate_step(public_step(output_names=("GROUP", "y_value"))), scalar_schema, source_lineage(schema))


@pytest.mark.parametrize(("semantic_type", "raw_type"), [("list", "list"), ("struct", "struct"), ("unknown", "object")])
def test_pivot_wider_binding_rejects_non_scalar_identifier_before_engine_dispatch(
    semantic_type: str,
    raw_type: str,
) -> None:
    schema = [
        {"name": "identifier", "type": semantic_type, "rawType": raw_type},
        {"name": "key", "type": "string", "rawType": "string"},
        {"name": "value", "type": "integer", "rawType": "int64"},
    ]
    with pytest.raises(ColumnBindingError, match="identifier columns must use the portable group-key scalar family"):
        bind_step(validate_step(public_step()), schema, source_lineage(schema))


@pytest.mark.parametrize("output_names", [("Σ", "ς"), ("İ", "i̇"), ("K", "k")])
def test_pivot_wider_duckdb_rejects_full_casefold_outputs_live_and_generated(output_names: tuple[str, str]) -> None:
    engine = DuckDBEngine()
    frame = duckdb.sql("SELECT 'a' AS \"group\", 'x' AS key, 1::BIGINT AS value")
    step = bind(engine, frame, public_step(output_names=output_names))
    with pytest.raises(EngineError, match="uniquely addressable"):
        engine.apply_transform(frame, step)
    with pytest.raises(ValueError, match="uniquely addressable"):
        execute_generated(engine, frame, step)


def _pandas_pivot_results(frame: Any) -> list[Any]:
    from types import SimpleNamespace
    from typing import cast

    from openwrangler_runtime.session import Session, SessionManager

    engine = PandasEngine()
    operation = bind(engine, frame)
    session = cast(Session, SimpleNamespace(engine=engine, session_id="arrow-pivot"))
    actual = SessionManager._apply_transform_with_row_ids(
        session, frame, operation, {"rows": len(frame), "columns": frame.shape[1]}
    )
    return [
        engine._visible_frame(actual),
        engine.apply_transform(frame, operation),
        execute_generated(engine, frame, operation),
    ]


@pytest.mark.parametrize("family", ["string", "large_string"])
@pytest.mark.parametrize("dictionary", [False, True])
def test_pandas_pivot_wider_arrow_names_pass_actual_session_preflight(family: str, dictionary: bool) -> None:
    import pyarrow as pa

    native = pa.array(["x", "x", "y"], type=getattr(pa, family)())
    if dictionary:
        native = native.dictionary_encode()
    frame: Any = pd.DataFrame(
        {"group": ["b", "a", "b"], "key": pd.Series(pd.arrays.ArrowExtensionArray(native)), "value": [3, 1, 4]}
    )
    before = frame["key"].array.__arrow_array__()
    for actual in _pandas_pivot_results(frame):
        assert rows(actual) == [("b", 3, 4), ("a", 1, None)]
    assert frame["key"].array.__arrow_array__().equals(before)


@pytest.mark.parametrize("dtype", ["float32", "float64", "Float32", "Float64", "float[pyarrow]", "double[pyarrow]"])
def test_pandas_pivot_wider_nullable_float_outputs_preserve_storage_and_validity(dtype: str) -> None:
    import numpy as np
    import pyarrow as pa

    if "pyarrow" in dtype:
        native = pa.array(
            [1.25, None, 2.5, float("nan")],
            type=pa.float32() if dtype == "float[pyarrow]" else pa.float64(),
            from_pandas=False,
        )
        values = pd.Series(pd.arrays.ArrowExtensionArray(native))
    else:
        values = pd.Series([1.25, None, 2.5, float("nan")], dtype=dtype)
    frame: Any = pd.DataFrame({"group": ["a", "a", "b", "c"], "key": ["x", "y", "x", "x"], "value": values})
    before = frame.copy(deep=True)
    for actual in _pandas_pivot_results(frame):
        assert actual["group"].tolist() == ["a", "b", "c"]
        assert actual["x_value"].dtype == values.dtype == actual["y_value"].dtype
        assert actual["x_value"].iloc[:2].tolist() == [1.25, 2.5]
        assert pd.isna(actual["y_value"]).all()
        if "pyarrow" in dtype:
            x = actual["x_value"].array.__arrow_array__()
            assert x.null_count == 0 and np.isnan(x[2].as_py())
            assert actual["y_value"].array.__arrow_array__().null_count == 3
        else:
            assert pd.isna(actual["x_value"].iloc[2])
    pd.testing.assert_frame_equal(frame, before)


@pytest.mark.parametrize(
    "family", ["string", "large_string", "duration", "binary", "large_binary", "fixed_size_binary"]
)
def test_pandas_pivot_wider_native_arrow_identifiers_match_generated_guard(family: str) -> None:
    from datetime import timedelta

    import pyarrow as pa

    if family == "duration":
        dtype, values = pa.duration("us"), [timedelta(days=2), timedelta(days=1), timedelta(days=2)]
    elif "binary" in family:
        dtype = pa.binary(1) if family == "fixed_size_binary" else getattr(pa, family)()
        values = [b"b", b"a", b"b"]
    else:
        dtype, values = getattr(pa, family)(), ["b", "a", "b"]
    frame: Any = pd.DataFrame(
        {
            "group": pd.Series(pd.arrays.ArrowExtensionArray(pa.array(values, type=dtype))),
            "key": ["x", "x", "y"],
            "value": [3, 1, 4],
        }
    )
    engine = PandasEngine()
    expected = engine.apply_transform(frame, bind(engine, frame))
    before = frame["group"].array.__arrow_array__()
    for actual in _pandas_pivot_results(frame):
        pd.testing.assert_frame_equal(actual, expected)
    assert frame["group"].array.__arrow_array__().equals(before)


@pytest.mark.parametrize("family", ["string", "integer", "decimal", "boolean", "date", "timestamp", "duration"])
@pytest.mark.parametrize("role", ["identifier", "values"])
def test_pandas_pivot_wider_dictionary_columns_use_logical_values(family: str, role: str) -> None:
    from datetime import datetime, timedelta

    import pyarrow as pa

    dtype, values = {
        "string": (pa.string(), ["b", None, "a", "b"]),
        "integer": (pa.int64(), [2**53 + 1, None, 1, 2**53 + 1]),
        "decimal": (pa.decimal128(30, 6), [Decimal("2.500001"), None, Decimal("1.000001"), Decimal("2.500001")]),
        "boolean": (pa.bool_(), [True, None, False, True]),
        "date": (pa.date32(), [date(2024, 1, 2), None, date(2025, 12, 31), date(2024, 1, 2)]),
        "timestamp": (pa.timestamp("us"), [datetime(2024, 1, 2), None, datetime(2025, 12, 31), datetime(2024, 1, 2)]),
        "duration": (pa.duration("us"), [timedelta(days=2), None, timedelta(days=1), timedelta(days=2)]),
    }[family]
    chunks = [
        pa.DictionaryArray.from_arrays(pa.array([0, 1, 2, None], type=pa.uint8()), pa.array(codebook, type=dtype))
        for codebook in [values, list(reversed(values))]
    ]
    encoded = pd.Series(pd.arrays.ArrowExtensionArray(pa.chunked_array(chunks)))
    frame: Any = pd.DataFrame({"group": range(len(encoded)), "key": ["x"] * len(encoded), "value": range(len(encoded))})
    column = "group" if role == "identifier" else "value"
    frame[column] = encoded
    if role == "identifier":
        frame["unique"] = range(len(encoded))
    logical = frame.copy(deep=False)
    logical[column] = encoded.astype(pd.ArrowDtype(dtype))
    if family == "string":
        logical[column] = logical[column].astype(pd.StringDtype(storage="python"))
    engine = PandasEngine()
    expected = engine.apply_transform(logical, bind(engine, logical))
    before = frame[column].array.__arrow_array__()
    for actual in _pandas_pivot_results(frame):
        pd.testing.assert_frame_equal(actual, expected)
    assert frame[column].array.__arrow_array__().equals(before)


@pytest.mark.parametrize("bits", [32, 64])
@pytest.mark.parametrize("dictionary", [False, True])
@pytest.mark.parametrize("missing", [False, True])
def test_pivot_wider_pandas_float_equality_preserves_first_identifier_rows(
    bits: int, dictionary: bool, missing: bool
) -> None:
    import numpy as np

    pa = pytest.importorskip("pyarrow")
    dtype = pa.float32() if bits == 32 else pa.float64()
    chunks = [
        pa.array([-0.0, 0.0, None], type=dtype, from_pandas=False),
        pa.array([float("nan"), 0.0, -0.0, 1.0, 1.0], type=dtype, from_pandas=False),
    ]
    if dictionary:
        chunks = [chunk.dictionary_encode() for chunk in chunks]
    frame = pd.DataFrame(
        {
            "partition": ["a", "a", "missing", "missing", "b", "b", "finite", "finite"],
            "zero": pd.Series(pd.arrays.ArrowExtensionArray(pa.chunked_array(chunks))),
            "key": ["x", "y"] * 4,
            "value": range(8),
        }
    )
    if not missing:
        frame = frame.iloc[[0, 1, 4, 5, 6, 7]]
    frame.index = pd.MultiIndex.from_tuples([("source", i % 2) for i in range(len(frame))])
    frame.attrs["annotation"] = "source"
    original = frame.copy(deep=True)
    engine = PandasEngine()
    step = bind(engine, frame, public_step(names_id="c:source:2", values_id="c:source:3"))
    engine.validate_transform_preflight(frame, step, engine.shape(frame))
    outputs = [engine.apply_transform(frame, step), execute_generated(engine, frame, step)]
    for result in outputs:
        assert result["partition"].tolist() == (["a", "missing", "b", "finite"] if missing else ["a", "b", "finite"])
        assert result["zero"].isna().tolist() == ([False, True, False, False] if missing else [False] * 3)
        assert [bool(np.signbit(result["zero"].iloc[i])) for i in ([0, 2] if missing else [0, 1])] == [True, False]
        assert result["zero"].dtype == (pd.Float64Dtype() if missing else pd.ArrowDtype(dtype))
        assert result["x_value"].tolist() == ([0, 2, 4, 6] if missing else [0, 4, 6])
        assert result["y_value"].tolist() == ([1, 3, 5, 7] if missing else [1, 5, 7])
        pd.testing.assert_frame_equal(frame, original)
    pd.testing.assert_frame_equal(*outputs)

    duplicate = frame.copy()
    duplicate["key"] = "x"
    duplicate_original = duplicate.copy(deep=True)
    with pytest.raises(EngineError, match="duplicate identifier-and-key rows"):
        engine.validate_transform_preflight(duplicate, step, engine.shape(duplicate))
    with pytest.raises(EngineError, match="duplicate identifier-and-key rows"):
        engine.apply_transform(duplicate, step)
    with pytest.raises(ValueError, match="duplicate identifier-and-key rows"):
        execute_generated(engine, duplicate, step)
    pd.testing.assert_frame_equal(duplicate, duplicate_original)
