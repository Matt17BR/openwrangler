from __future__ import annotations

import json
import math
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd
import polars as pl
import pyarrow as pa
import pytest

from openwrangler_runtime._column_binding import ColumnBindingError, bind_step
from openwrangler_runtime.convert_type import CAST_SOURCE_TYPES
from openwrangler_runtime.engines import DuckDBEngine, PandasEngine, PolarsEngine
from openwrangler_runtime.lineage import source_lineage
from openwrangler_runtime.operations import validate_step

_CONTRACT = json.loads(
    (Path(__file__).resolve().parents[2] / "fixtures" / "convert-type-contract.json").read_text(encoding="utf-8")
)
_SPECIAL_FLOATS = {"NaN": math.nan, "Infinity": math.inf, "-Infinity": -math.inf, "-0": -0.0}
_DUCKDB_TYPES = {
    "string": "VARCHAR",
    "integer": "BIGINT",
    "float": "DOUBLE",
    "decimal": "DECIMAL(10, 2)",
    "boolean": "BOOLEAN",
}


def _values(case: dict[str, Any]) -> list[Any]:
    if case["source"] == "float":
        return [None if value is None else _SPECIAL_FLOATS.get(value, value) for value in case["values"]]
    if case["source"] == "decimal":
        return [None if value is None else Decimal(value) for value in case["values"]]
    return list(case["values"])


def _pandas_frames(case: dict[str, Any]) -> list[pd.DataFrame]:
    values = _values(case)
    dtypes: dict[str, list[Any]] = {
        "string": [object, "string"],
        "integer": ["Int64", pd.ArrowDtype(pa.int64())],
        "float": ["float64"],
        "decimal": [object, pd.ArrowDtype(pa.decimal128(10, 2))],
        "boolean": ["boolean"],
    }
    if case["source"] == "float":
        values = [math.nan if value is None else value for value in values]
    return [pd.Series(values, dtype=dtype).to_frame("value") for dtype in dtypes[case["source"]]]


def _polars_frames(case: dict[str, Any]) -> list[pl.DataFrame | pl.LazyFrame]:
    dtype = {
        "string": pl.String,
        "integer": pl.Int64,
        "float": pl.Float64,
        "decimal": pl.Decimal(10, 2),
        "boolean": pl.Boolean,
    }
    frame = pl.DataFrame({"value": pl.Series(_values(case), dtype=dtype[case["source"]])})
    return [frame, frame.lazy()]


def _duckdb_literal(value: Any, source: str) -> str:
    sql_type = _DUCKDB_TYPES[source]
    if value is None:
        return f"NULL::{sql_type}"
    if isinstance(value, bool):
        return f"{str(value).lower()}::{sql_type}"
    text = repr(value) if isinstance(value, float) else str(value)
    return "'" + text.replace("'", "''") + f"'::{sql_type}"


def _duckdb_relation(case: dict[str, Any]) -> duckdb.DuckDBPyRelation:
    rows = ", ".join(
        f"({index}, {_duckdb_literal(value, case['source'])})" for index, value in enumerate(_values(case))
    )
    return duckdb.sql(f"SELECT value FROM (VALUES {rows}) AS source(position, value) ORDER BY position")


def _plain(values: list[Any]) -> list[Any]:
    return [
        None if value is None or value is pd.NA or (isinstance(value, float) and math.isnan(value)) else value
        for value in values
    ]


def _column(engine: Any, result: Any) -> list[Any]:
    if isinstance(engine, PandasEngine):
        return _plain(result["value"].tolist())
    if isinstance(engine, PolarsEngine):
        return _plain((result.collect() if isinstance(result, pl.LazyFrame) else result)["value"].to_list())
    rows = (
        result.fetchall()
        if isinstance(result, duckdb.DuckDBPyRelation)
        else engine._terminal_rows(result, "SELECT * FROM ow")
    )
    return _plain([row[0] for row in rows])


def _generated(engine: Any, frame: Any, operation: dict[str, Any]) -> Any:
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([operation]), namespace, namespace)
    return namespace["clean_data"](frame)


def _bound(engine: Any, frame: Any, target: str) -> dict[str, Any]:
    schema = engine.schema(frame)
    lineage = source_lineage(schema)
    operation = validate_step(
        {"id": "convert", "kind": "castColumn", "params": {"column": lineage[0], "dtype": target}}
    )
    return bind_step(operation, schema, lineage)


def test_runtime_matrix_matches_the_shared_contract() -> None:
    assert {target: sorted(sources) for target, sources in CAST_SOURCE_TYPES.items()} == {
        target: sorted(sources) for target, sources in _CONTRACT["targets"].items()
    }


@pytest.mark.parametrize("case", _CONTRACT["cases"], ids=lambda case: f"{case['source']}-{case['target']}")
def test_python_engines_convert_the_shared_contract_values(case: dict[str, Any]) -> None:
    sources = [
        *((PandasEngine(), frame, frame) for frame in _pandas_frames(case)),
        *((PolarsEngine(), frame, frame) for frame in _polars_frames(case)),
    ]
    duckdb_engine = DuckDBEngine()
    relation = _duckdb_relation(case)
    sources.append((duckdb_engine, duckdb_engine.normalize_notebook_relation(relation), relation))
    try:
        for engine, frame, generated_input in sources:
            label = f"{type(engine).__name__} {engine.schema(frame)[0]['rawType']}"
            assert engine.schema(frame)[0]["type"] == case["source"], label
            operation = _bound(engine, frame, case["target"])
            live = engine.apply_transform(frame, operation)
            generated = _generated(engine, generated_input, operation)
            assert engine.schema(live)[0]["type"] == case["target"], label
            assert _column(engine, live) == case["expected"], label
            assert _column(engine, generated) == case["expected"], label
    finally:
        relation = None
        duckdb_engine.close()


def _typed_frames() -> list[tuple[Any, Any]]:
    day = date(2024, 1, 2)
    moment = datetime(2024, 1, 2, 3, 4, 5)
    pandas_frame = pd.DataFrame(
        {
            "string": pd.Series(["1"], dtype="string"),
            "integer": pd.Series([1], dtype="Int64"),
            "float": pd.Series([1.5]),
            "decimal": pd.Series([Decimal("1.50")], dtype=pd.ArrowDtype(pa.decimal128(10, 2))),
            "boolean": pd.Series([True], dtype="boolean"),
            "date": pd.Series([day], dtype=pd.ArrowDtype(pa.date32())),
            "datetime": pd.Series([moment]),
            "duration": pd.Series([timedelta(seconds=1)]),
        }
    )
    polars_frame = pl.DataFrame(
        {
            "string": ["1"],
            "integer": [1],
            "float": [1.5],
            "decimal": pl.Series([Decimal("1.50")], dtype=pl.Decimal(10, 2)),
            "boolean": [True],
            "date": [day],
            "datetime": [moment],
            "duration": [timedelta(seconds=1)],
        }
    )
    duckdb_frame = duckdb.sql(
        "SELECT '1' AS string, 1::BIGINT AS integer, 1.5::DOUBLE AS float, 1.50::DECIMAL(10, 2) AS decimal, "
        "true AS boolean, DATE '2024-01-02' AS date, TIMESTAMP '2024-01-02 03:04:05' AS datetime, "
        "INTERVAL 1 SECOND AS duration"
    )
    return [(PandasEngine(), pandas_frame), (PolarsEngine(), polars_frame), (DuckDBEngine(), duckdb_frame)]


def test_binding_refuses_every_pair_outside_the_shared_contract() -> None:
    labels = {"string": "Text", "integer": "Integer", "float": "Float", "decimal": "Decimal", "boolean": "Boolean"}
    labels |= {"date": "Date", "datetime": "Datetime", "duration": "Duration"}
    for engine, frame in _typed_frames():
        schema = engine.schema(frame)
        lineage = source_lineage(schema)
        assert [column["type"] for column in schema] == list(labels)
        for target, sources in _CONTRACT["targets"].items():
            for column, reference in zip(schema, lineage, strict=True):
                operation = validate_step(
                    {"id": "convert", "kind": "castColumn", "params": {"column": reference, "dtype": target}}
                )
                if column["type"] in sources:
                    bind_step(operation, schema, lineage)
                    continue
                message = f"Convert type cannot turn {labels[column['type']]} values into {labels.get(target, 'Text')}."
                with pytest.raises(ColumnBindingError, match=message.replace(".", r"\.")):
                    bind_step(operation, schema, lineage)
        engine.close()
