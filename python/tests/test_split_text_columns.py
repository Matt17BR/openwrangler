from __future__ import annotations

from typing import Any

import duckdb
import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime.engines.duckdb_engine import DuckDBEngine
from openwrangler_runtime.engines.pandas_engine import PandasEngine
from openwrangler_runtime.engines.polars_engine import PolarsEngine
from openwrangler_runtime.lineage import derive_lineage
from openwrangler_runtime.operations import OperationError, validate_step


def split_step() -> dict[str, Any]:
    return {
        "id": "split-many",
        "kind": "splitTextColumns",
        "params": {
            "column": {"id": "c:source:0", "name": "value", "position": 0},
            "delimiter": "||",
            "newColumns": ["first", "second", "third"],
        },
    }


@pytest.mark.parametrize(
    "new_columns",
    (["only"], ["same", "same"], ["name"] * 65),
)
def test_split_text_columns_public_decoder_rejects_nonportable_output_sets(new_columns: list[str]) -> None:
    candidate = split_step()
    candidate["params"]["newColumns"] = new_columns
    with pytest.raises(OperationError):
        validate_step(candidate)


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


def execute_generated(engine: Any, frame: Any, step: dict[str, Any] | None = None) -> Any:
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([step or split_step()]), namespace, namespace)
    return namespace["clean_data"](frame)


@pytest.mark.parametrize("lazy", [False, True])
def test_split_text_columns_polars_live_and_generated_preserve_literal_parts_and_source(lazy: bool) -> None:
    frame = pl.DataFrame({"value": ["a||b||c||ignored", "left||||tail", "plain", None]})
    source = frame.lazy() if lazy else frame
    expected = [
        ("a||b||c||ignored", "a", "b", "c"),
        ("left||||tail", "left", "", "tail"),
        ("plain", "plain", None, None),
        (None, None, None, None),
    ]

    assert rows(PolarsEngine().apply_transform(source, split_step())) == expected
    assert rows(execute_generated(PolarsEngine(), source)) == expected


def test_split_text_columns_pandas_live_and_generated_preserve_literal_parts_and_source() -> None:
    frame = pd.DataFrame({"value": ["a||b||c||ignored", "left||||tail", "plain", None]})
    expected = [
        ("a||b||c||ignored", "a", "b", "c"),
        ("left||||tail", "left", "", "tail"),
        ("plain", "plain", None, None),
        (None, None, None, None),
    ]

    assert rows(PandasEngine().apply_transform(frame, split_step())) == expected
    assert rows(execute_generated(PandasEngine(), frame)) == expected


def test_split_text_columns_duckdb_live_and_generated_preserve_literal_parts_and_source() -> None:
    frame = duckdb.sql("SELECT * FROM (VALUES ('a||b||c||ignored'), ('left||||tail'), ('plain'), (NULL)) source(value)")
    expected = [
        ("a||b||c||ignored", "a", "b", "c"),
        ("left||||tail", "left", "", "tail"),
        ("plain", "plain", None, None),
        (None, None, None, None),
    ]

    assert rows(DuckDBEngine().apply_transform(frame, split_step())) == expected
    assert rows(execute_generated(DuckDBEngine(), frame)) == expected


@pytest.mark.parametrize(
    ("frame", "new_columns"),
    [
        (duckdb.sql("SELECT 'a||b' AS value, 'keep' AS SECOND"), ["first", "second"]),
        (duckdb.sql("SELECT 'a||b' AS value"), ["part", "PART"]),
    ],
)
def test_split_text_columns_duckdb_rejects_case_folded_output_collisions_before_dispatch(
    frame: Any, new_columns: list[str]
) -> None:
    step = split_step()
    step["params"]["newColumns"] = new_columns
    baseline = rows(frame)

    with pytest.raises(Exception, match="differ only by case"):
        DuckDBEngine().apply_transform(frame, step)
    assert rows(frame) == baseline
    with pytest.raises(Exception, match="differ only by case"):
        execute_generated(DuckDBEngine(), frame, step)
    assert rows(frame) == baseline


def test_split_text_columns_assigns_stable_output_lineage_by_step_ordinal() -> None:
    before = [{"id": "c:source:0", "name": "value"}]
    after = [
        {"id": "c:source:0", "name": "value", "rawType": "object", "type": "string", "nullable": True, "position": 0},
        {
            "id": "temporary:first",
            "name": "first",
            "rawType": "object",
            "type": "string",
            "nullable": True,
            "position": 1,
        },
        {
            "id": "temporary:second",
            "name": "second",
            "rawType": "object",
            "type": "string",
            "nullable": True,
            "position": 2,
        },
        {
            "id": "temporary:third",
            "name": "third",
            "rawType": "object",
            "type": "string",
            "nullable": True,
            "position": 3,
        },
    ]

    assert derive_lineage(before, after, split_step()) == [
        {"id": "c:source:0", "name": "value"},
        {"id": "c:step:split-many:0", "name": "first"},
        {"id": "c:step:split-many:1", "name": "second"},
        {"id": "c:step:split-many:2", "name": "third"},
    ]


@pytest.mark.parametrize("engine", [PandasEngine(), PolarsEngine(), DuckDBEngine()])
def test_split_text_columns_rejects_all_output_collisions_before_execution(engine: Any) -> None:
    if isinstance(engine, PandasEngine):
        frame: Any = pd.DataFrame({"value": ["a||b"], "second": ["keep"]})
    elif isinstance(engine, PolarsEngine):
        frame = pl.DataFrame({"value": ["a||b"], "second": ["keep"]})
    else:
        frame = duckdb.sql("SELECT 'a||b' AS value, 'keep' AS second")
    baseline = rows(frame)

    with pytest.raises(Exception, match="duplicate column names|already exist"):
        engine.apply_transform(frame, split_step())
    assert rows(frame) == baseline
    with pytest.raises(Exception, match="duplicate column names|already exist"):
        execute_generated(engine, frame)
    assert rows(frame) == baseline


@pytest.mark.parametrize("engine", [PandasEngine(), PolarsEngine(), DuckDBEngine()])
def test_split_text_columns_rejects_private_output_names_before_execution(engine: Any) -> None:
    step = split_step()
    step["params"]["newColumns"] = ["first", "__open_wrangler_internal_row_id_0"]
    if isinstance(engine, PandasEngine):
        frame: Any = pd.DataFrame({"value": ["a||b"]})
    elif isinstance(engine, PolarsEngine):
        frame = pl.DataFrame({"value": ["a||b"]})
    else:
        frame = duckdb.sql("SELECT 'a||b' AS value")
    baseline = rows(frame)

    with pytest.raises(Exception, match="reserved private row-identity"):
        engine.apply_transform(frame, step)
    assert rows(frame) == baseline
    with pytest.raises(Exception, match="reserved private row-identity"):
        namespace: dict[str, Any] = {}
        exec(engine.compile_plan([step]), namespace, namespace)
        namespace["clean_data"](frame)
    assert rows(frame) == baseline
