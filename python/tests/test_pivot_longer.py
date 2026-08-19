from __future__ import annotations

from types import SimpleNamespace
from typing import Any, cast

import duckdb
import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime._column_binding import ColumnBindingError, bind_step
from openwrangler_runtime.engines.base import EngineError
from openwrangler_runtime.engines.duckdb_engine import DuckDBEngine
from openwrangler_runtime.engines.pandas_engine import PandasEngine
from openwrangler_runtime.engines.polars_engine import PolarsEngine
from openwrangler_runtime.lineage import derive_lineage
from openwrangler_runtime.operations import OperationError, validate_step
from openwrangler_runtime.pivot_longer import PivotLongerContractError, checked_pivot_longer_row_count
from openwrangler_runtime.session import Session, SessionManager


def public_step(
    *,
    columns: list[dict[str, str]] | None = None,
    label_column: str = "metric",
    value_column: str = "reading",
) -> dict[str, Any]:
    return {
        "id": "pivot-longer",
        "kind": "pivotLonger",
        "params": {
            "columns": columns
            or [
                {"id": "c:source:1", "name": "alpha"},
                {"id": "c:source:2", "name": "beta"},
            ],
            "labelColumn": label_column,
            "valueColumn": value_column,
        },
    }


def source_lineage(schema: list[dict[str, Any]]) -> list[dict[str, str]]:
    return [{"id": f"c:source:{index}", "name": str(column["name"])} for index, column in enumerate(schema)]


def bind(engine: Any, frame: Any, step: dict[str, Any] | None = None) -> dict[str, Any]:
    schema = engine.schema(frame)
    return bind_step(step or public_step(), schema, source_lineage(schema))


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
    "candidate",
    [
        public_step(columns=[{"id": "c:source:1", "name": "alpha"}]),
        public_step(columns=[{"id": f"c:source:{index}", "name": f"c{index}"} for index in range(65)]),
        public_step(label_column="same", value_column="SAME"),
        public_step(label_column="Straße", value_column="STRASSE"),
        public_step(label_column="bad\nname"),
        public_step(value_column="\ud800"),
        public_step(value_column="x" * 1_025),
    ],
)
def test_pivot_longer_public_decoder_rejects_nonportable_contract(candidate: dict[str, Any]) -> None:
    with pytest.raises(OperationError):
        validate_step(candidate)


@pytest.mark.parametrize("lazy", [False, True])
def test_pivot_longer_polars_live_and_generated_are_column_major_and_preserve_nulls(lazy: bool) -> None:
    frame = pl.DataFrame({"keep": ["k1", "k2"], "alpha": [1, None], "beta": [3, 4]})
    source = frame.lazy() if lazy else frame
    step = bind(PolarsEngine(), source)
    expected = [("k1", "alpha", 1), ("k2", "alpha", None), ("k1", "beta", 3), ("k2", "beta", 4)]

    assert rows(PolarsEngine().apply_transform(source, step)) == expected
    assert rows(execute_generated(PolarsEngine(), source, step)) == expected
    assert rows(source) == [("k1", 1, 3), ("k2", None, 4)]


def test_pivot_longer_pandas_live_and_generated_are_column_major_and_preserve_nulls() -> None:
    frame = pd.DataFrame(
        {
            "keep": ["k1", "k2"],
            "alpha": pd.Series([1, None], dtype="Int64"),
            "beta": pd.Series([3, 4], dtype="Int64"),
        }
    )
    step = bind(PandasEngine(), frame)
    expected = [("k1", "alpha", 1), ("k2", "alpha", None), ("k1", "beta", 3), ("k2", "beta", 4)]

    live = PandasEngine().apply_transform(frame, step)
    generated = execute_generated(PandasEngine(), frame, step)
    assert rows(live) == expected
    assert rows(generated) == expected
    assert str(live["reading"].dtype) == "Int64"
    assert str(generated["reading"].dtype) == "Int64"
    assert list(frame.columns) == ["keep", "alpha", "beta"]


def test_pivot_longer_pandas_multiindex_columns_keep_raw_labels_and_exact_flat_outputs() -> None:
    columns = pd.MultiIndex.from_tuples([("metric", "retained"), ("alpha", "value"), ("beta", "value")])
    frame = pd.DataFrame([["k1", 1, 3], ["k2", 2, 4]], columns=columns)
    engine = PandasEngine()
    before_schema = engine.schema(frame)
    before_lineage = source_lineage(before_schema)
    operation = public_step(
        columns=[
            {"id": "c:source:1", "name": str(columns[1])},
            {"id": "c:source:2", "name": str(columns[2])},
        ]
    )
    step = bind(engine, frame, operation)
    expected = [
        ("k1", str(columns[1]), 1),
        ("k2", str(columns[1]), 2),
        ("k1", str(columns[2]), 3),
        ("k2", str(columns[2]), 4),
    ]

    live = engine.apply_transform(frame, step)
    generated = execute_generated(engine, frame, step)
    for result in (live, generated):
        assert not isinstance(result.columns, pd.MultiIndex)
        assert list(result.columns) == [columns[0], "metric", "reading"]
        assert rows(result) == expected
        assert [column["name"] for column in engine.schema(result)] == [str(columns[0]), "metric", "reading"]
        assert derive_lineage(before_lineage, engine.schema(result), operation) == [
            {"id": "c:source:0", "name": str(columns[0])},
            {"id": "c:step:pivot-longer:0", "name": "metric"},
            {"id": "c:step:pivot-longer:1", "name": "reading"},
        ]
    assert isinstance(frame.columns, pd.MultiIndex)
    assert list(frame.columns) == list(columns)
    assert rows(frame) == [("k1", 1, 3), ("k2", 2, 4)]


def test_pivot_longer_duckdb_live_and_generated_are_column_major_and_preserve_nulls() -> None:
    frame = duckdb.sql(
        "SELECT * FROM (VALUES ('k1', 1::BIGINT, 3::BIGINT), ('k2', NULL::BIGINT, 4::BIGINT)) source(keep, alpha, beta)"
    )
    step = bind(DuckDBEngine(), frame)
    expected = [("k1", "alpha", 1), ("k2", "alpha", None), ("k1", "beta", 3), ("k2", "beta", 4)]

    assert rows(DuckDBEngine().apply_transform(frame, step)) == expected
    assert rows(execute_generated(DuckDBEngine(), frame, step)) == expected
    assert rows(frame) == [("k1", 1, 3), ("k2", None, 4)]


@pytest.mark.parametrize("label_column,value_column", [("Σ", "ς"), ("İ", "i̇"), ("K", "k")])
def test_pivot_longer_duckdb_rejects_full_casefold_output_collisions_before_query(
    label_column: str,
    value_column: str,
) -> None:
    class PreflightSpy(DuckDBEngine):
        apply_called = False

        def apply_transform(self, frame: Any, step: Any) -> Any:
            self.apply_called = True
            return super().apply_transform(frame, step)

    engine = PreflightSpy()
    frame = duckdb.sql("SELECT 'k' AS keep, 1::BIGINT AS alpha, 2::BIGINT AS beta")
    operation = public_step(label_column=label_column, value_column=value_column)
    validate_step(operation)
    step = bind(engine, frame, operation)
    baseline = rows(frame)
    session = cast(Session, SimpleNamespace(engine=engine, session_id="pivot-casefold"))

    with pytest.raises(EngineError, match="DuckDB column names|DuckDB identifier matching"):
        SessionManager._apply_transform_with_row_ids(
            session,
            frame,
            step,
            {"rows": 1, "columns": 3},
        )
    assert not engine.apply_called
    with pytest.raises(ValueError, match="DuckDB column name|DuckDB identifier matching"):
        execute_generated(engine, frame, step)
    assert rows(frame) == baseline


@pytest.mark.parametrize("sort_kind", ["sortRows", "filterRows"])
def test_pivot_longer_duckdb_preserves_current_sorted_order_live_and_generated(sort_kind: str) -> None:
    engine = DuckDBEngine()
    frame = duckdb.sql(
        "SELECT * FROM (VALUES ('k1', 1::BIGINT, 4::BIGINT), "
        "('k3', 3::BIGINT, 6::BIGINT), ('k2', 2::BIGINT, 5::BIGINT)) source(keep, alpha, beta)"
    )
    identified_source = engine.ensure_row_ids(frame, "pivot-source")
    source_row_id = engine._row_id_column(identified_source)
    assert source_row_id is not None
    schema = engine.schema(identified_source)
    lineage = source_lineage(schema)
    sort_rule = {
        "column": {"id": "c:source:0", "name": "keep"},
        "direction": "desc",
        "nulls": "last",
    }
    public_sort = (
        {"id": "sort", "kind": "sortRows", "params": {"rules": [sort_rule]}}
        if sort_kind == "sortRows"
        else {
            "id": "filter-sort",
            "kind": "filterRows",
            "params": {"filterModel": {"logic": "and", "filters": [], "sort": [sort_rule]}},
        }
    )
    sort_step = bind_step(public_sort, schema, lineage)
    pivot_step = bind(engine, identified_source)
    expected = [
        ("k3", "alpha", 3),
        ("k2", "alpha", 2),
        ("k1", "alpha", 1),
        ("k3", "beta", 6),
        ("k2", "beta", 5),
        ("k1", "beta", 4),
    ]

    sorted_frame = engine.apply_transform(identified_source, sort_step)
    assert [row[-1] for row in rows(sorted_frame)] == [1, 2, 0]
    live = engine.apply_transform(sorted_frame, pivot_step)
    assert engine._visible_columns(live) == ["keep", "metric", "reading"]
    assert engine._row_id_column(live) is None
    assert rows(live) == expected
    identified = engine.ensure_row_ids(live, "pivot-sorted")
    row_id = engine._row_id_column(identified)
    assert row_id is not None
    assert [row[-1] for row in rows(identified)] == list(range(len(expected)))
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([sort_step, pivot_step]), namespace, namespace)
    assert rows(namespace["clean_data"](frame)) == expected
    assert rows(frame) == [("k1", 1, 4), ("k3", 3, 6), ("k2", 2, 5)]


def test_pivot_longer_binding_rejects_mixed_raw_types_and_casefold_collisions() -> None:
    schema = [
        {"name": "keep", "type": "string", "rawType": "string"},
        {"name": "alpha", "type": "integer", "rawType": "int32"},
        {"name": "beta", "type": "integer", "rawType": "int64"},
    ]
    lineage = source_lineage(schema)

    with pytest.raises(ColumnBindingError, match="exactly compatible scalar type"):
        bind_step(public_step(), schema, lineage)
    compatible_schema = [{**column, "rawType": "int64"} for column in schema[1:]]
    with pytest.raises(ColumnBindingError, match="case-insensitively with an existing column"):
        bind_step(public_step(label_column="ALPHA"), compatible_schema, lineage[1:])


@pytest.mark.parametrize("engine", [PandasEngine(), PolarsEngine(), DuckDBEngine()])
def test_pivot_longer_live_and_generated_reject_output_collisions_without_mutating_source(engine: Any) -> None:
    if isinstance(engine, PandasEngine):
        frame: Any = pd.DataFrame({"keep": ["k"], "alpha": [1], "beta": [2]})
    elif isinstance(engine, PolarsEngine):
        frame = pl.DataFrame({"keep": ["k"], "alpha": [1], "beta": [2]})
    else:
        frame = duckdb.sql("SELECT 'k' AS keep, 1::BIGINT AS alpha, 2::BIGINT AS beta")
    baseline = rows(frame)
    step = bind(engine, frame)
    step["params"]["labelColumn"] = "KEEP"

    with pytest.raises(Exception, match="duplicate|differs only by case"):
        engine.apply_transform(frame, step)
    assert rows(frame) == baseline
    with pytest.raises(Exception, match="duplicate|differs only by case"):
        execute_generated(engine, frame, step)
    assert rows(frame) == baseline


def test_pivot_longer_assigns_stable_two_output_lineage_and_removes_selected_inputs() -> None:
    before = [
        {"id": "c:source:0", "name": "keep"},
        {"id": "c:source:1", "name": "alpha"},
        {"id": "c:source:2", "name": "beta"},
    ]
    after = [
        {
            "id": "temporary:keep",
            "name": "keep",
            "rawType": "string",
            "type": "string",
            "nullable": False,
            "position": 0,
        },
        {
            "id": "temporary:label",
            "name": "metric",
            "rawType": "string",
            "type": "string",
            "nullable": False,
            "position": 1,
        },
        {
            "id": "temporary:value",
            "name": "reading",
            "rawType": "int64",
            "type": "integer",
            "nullable": True,
            "position": 2,
        },
    ]

    assert derive_lineage(before, after, public_step()) == [
        {"id": "c:source:0", "name": "keep"},
        {"id": "c:step:pivot-longer:0", "name": "metric"},
        {"id": "c:step:pivot-longer:1", "name": "reading"},
    ]


def test_pivot_longer_row_count_preflight_is_exact_and_fail_closed() -> None:
    assert checked_pivot_longer_row_count(0, 64) == 0
    assert checked_pivot_longer_row_count(2_147_483_647 // 64, 64) == (2_147_483_647 // 64) * 64
    with pytest.raises(PivotLongerContractError, match="row limit"):
        checked_pivot_longer_row_count((2_147_483_647 // 64) + 1, 64)


class _NoDispatchEngine:
    def __init__(self) -> None:
        self.called = False

    def __getattr__(self, name: str) -> Any:
        self.called = True
        raise AssertionError(f"Engine adapter method {name} must not run for an overflowing pivot.")


def overflow_bound_step() -> dict[str, Any]:
    return {
        **public_step(),
        "params": {
            **public_step()["params"],
            "columns": [{"id": f"c:source:{index}", "name": f"c{index}", "position": index} for index in range(64)],
        },
    }


def test_session_preflight_rejects_overflow_before_any_adapter_method() -> None:
    engine = _NoDispatchEngine()
    session = cast(Session, SimpleNamespace(engine=engine, session_id="overflow"))

    with pytest.raises(EngineError, match="row limit"):
        SessionManager._apply_transform_with_row_ids(
            session,
            object(),
            overflow_bound_step(),
            {"rows": (2_147_483_647 // 64) + 1, "columns": 64},
        )
    assert engine.called is False


def test_earlier_step_replay_rejects_overflow_before_any_adapter_method() -> None:
    engine = _NoDispatchEngine()
    schema = [
        {"name": f"c{index}", "rawType": "int64", "type": "integer", "nullable": False, "position": index}
        for index in range(64)
    ]
    session = cast(
        Session,
        SimpleNamespace(
            engine=engine,
            session_id="replay-overflow",
            original=object(),
            source_schema=schema,
            source_shape={"rows": (2_147_483_647 // 64) + 1, "columns": 64},
        ),
    )

    with pytest.raises(EngineError, match="row limit"):
        SessionManager()._replay(session, [overflow_bound_step()])
    assert engine.called is False


def test_lazy_polars_overflow_rejects_before_preflight_or_apply_dispatch() -> None:
    class SpyPolarsEngine(PolarsEngine):
        called = False

        def validate_transform_preflight(self, frame: Any, step: Any, input_shape: Any) -> None:
            self.called = True
            raise AssertionError("Polars preflight must not run after the shared overflow rejection.")

        def apply_transform(self, frame: Any, step: Any) -> Any:
            self.called = True
            raise AssertionError("Polars apply must not run after the shared overflow rejection.")

    engine = SpyPolarsEngine()
    session = cast(Session, SimpleNamespace(engine=engine, session_id="lazy-overflow"))
    with pytest.raises(EngineError, match="row limit"):
        SessionManager._apply_transform_with_row_ids(
            session,
            pl.DataFrame({f"c{index}": [index] for index in range(64)}).lazy(),
            overflow_bound_step(),
            {"rows": (2_147_483_647 // 64) + 1, "columns": 64},
        )
    assert engine.called is False


def test_pandas_category_metadata_must_match_before_apply_dispatch() -> None:
    frame = pd.DataFrame(
        {
            "keep": ["k1", "k2"],
            "alpha": pd.Series(pd.Categorical(["a", "b"], categories=["a", "b"], ordered=True)),
            "beta": pd.Series(pd.Categorical(["a", "b"], categories=["b", "a"], ordered=True)),
        }
    )
    step = bind(PandasEngine(), frame)

    class SpyPandasEngine(PandasEngine):
        called = False

        def apply_transform(self, frame: Any, step: Any) -> Any:
            self.called = True
            raise AssertionError("Pandas apply must not run for incompatible categories.")

    engine = SpyPandasEngine()
    session = cast(Session, SimpleNamespace(engine=engine, session_id="category"))
    with pytest.raises(EngineError, match="exactly compatible Pandas dtype"):
        SessionManager._apply_transform_with_row_ids(
            session,
            frame,
            step,
            {"rows": 2, "columns": 3},
        )
    assert engine.called is False


def test_pandas_matching_category_metadata_preserves_value_dtype_live_and_generated() -> None:
    dtype = pd.CategoricalDtype(categories=["a", "b"], ordered=True)
    frame = pd.DataFrame(
        {
            "keep": ["k1", "k2"],
            "alpha": pd.Series(["a", "b"], dtype=dtype),
            "beta": pd.Series(["b", "a"], dtype=dtype),
        }
    )
    step = bind(PandasEngine(), frame)
    live = PandasEngine().apply_transform(frame, step)
    generated = execute_generated(PandasEngine(), frame, step)

    assert live["reading"].dtype == dtype
    assert generated["reading"].dtype == dtype


def test_polars_enum_metadata_must_match_live_and_generated() -> None:
    frame = pl.DataFrame(
        {
            "keep": ["k1", "k2"],
            "alpha": pl.Series(["a", "b"], dtype=pl.Enum(["a", "b"])),
            "beta": pl.Series(["a", "b"], dtype=pl.Enum(["b", "a"])),
        }
    )
    step = {
        **public_step(),
        "params": {
            **public_step()["params"],
            "columns": [
                {"id": "c:source:1", "name": "alpha", "position": 1},
                {"id": "c:source:2", "name": "beta", "position": 2},
            ],
        },
    }

    with pytest.raises(EngineError, match="exactly compatible Polars dtype"):
        PolarsEngine().apply_transform(frame, step)
    with pytest.raises(ValueError, match="exactly compatible Polars dtype"):
        execute_generated(PolarsEngine(), frame, step)


def test_polars_matching_categorical_metadata_is_supported_live_and_generated() -> None:
    frame = pl.DataFrame(
        {
            "keep": ["k1", "k2"],
            "alpha": pl.Series(["a", "b"], dtype=pl.Categorical),
            "beta": pl.Series(["b", "a"], dtype=pl.Categorical),
        }
    )
    step = bind(PolarsEngine(), frame)
    assert rows(PolarsEngine().apply_transform(frame, step)) == rows(execute_generated(PolarsEngine(), frame, step))
