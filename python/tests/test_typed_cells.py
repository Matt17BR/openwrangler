from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID

import numpy as np
import pandas as pd
import pytest

from openwrangler_runtime._column_binding import bind_step
from openwrangler_runtime.engines import PandasEngine
from openwrangler_runtime.engines.base import infer_semantic_type, normalize_cell
from openwrangler_runtime.lineage import source_lineage
from openwrangler_runtime.operations import validate_step


def test_typed_cells_preserve_values_json_cannot_represent_directly() -> None:
    assert normalize_cell(2**63)["raw"] == str(2**63)
    assert normalize_cell(Decimal("1.2300"))["kind"] == "decimal"
    assert normalize_cell(float("nan"))["kind"] == "nan"
    assert normalize_cell(float("-inf"))["sign"] == -1
    assert normalize_cell(datetime(2026, 7, 15, 12, 30))["raw"] == "2026-07-15T12:30:00"
    assert normalize_cell(date(2026, 7, 15))["raw"] == "2026-07-15"


def test_typed_cells_normalize_numpy_and_pandas_scalars() -> None:
    assert normalize_cell(np.int64(7)) == {
        "kind": "integer",
        "raw": 7,
        "display": "7",
        "isNull": False,
        "isNaN": False,
    }
    assert normalize_cell(np.bool_(True))["kind"] == "boolean"
    assert normalize_cell(np.bool_(True))["raw"] is True
    assert normalize_cell(np.float32("nan"))["kind"] == "nan"
    assert normalize_cell(np.float64("inf"))["sign"] == 1
    assert normalize_cell(np.datetime64("2026-07-16")) == {
        "kind": "datetime",
        "raw": "2026-07-16",
        "display": "2026-07-16",
        "isNull": False,
        "isNaN": False,
    }
    assert normalize_cell(np.datetime64("NaT"))["kind"] == "null"
    assert normalize_cell(np.timedelta64(1, "D"))["raw"] == 86_400
    assert normalize_cell(np.timedelta64(1, "ns")) == {
        "kind": "duration",
        "raw": 1e-9,
        "display": "1 nanoseconds",
        "isNull": False,
        "isNaN": False,
    }
    assert normalize_cell(np.timedelta64("NaT"))["kind"] == "null"
    assert normalize_cell(np.array([1, 2]))["kind"] == "unknown"
    assert normalize_cell(np.array([1]))["kind"] == "unknown"
    assert normalize_cell(np.longdouble(1))["kind"] in {"number", "unknown"}
    assert normalize_cell(pd.NA)["kind"] == "null"
    assert normalize_cell(pd.NaT)["kind"] == "null"
    assert normalize_cell(pd.Timestamp("2026-07-15T12:30:00+02:00"))["raw"] == "2026-07-15T12:30:00+02:00"
    assert normalize_cell(timedelta(days=1))["raw"] == 86_400
    assert normalize_cell(pd.Timedelta(1, unit="ns"))["raw"] == 1e-9


def test_nested_typed_cells_are_strict_json_safe() -> None:
    cell = normalize_cell(
        {
            "values": [np.int64(3), float("nan"), float("-inf"), Decimal("1.20")],
            "when": datetime(2026, 7, 15, 12, 30),
            "missing": pd.NA,
        }
    )

    assert cell["kind"] == "struct"
    assert cell["raw"] == {
        "values": [3, "NaN", "-Infinity", "1.20"],
        "when": "2026-07-15T12:30:00",
        "missing": None,
    }
    json.dumps(cell, allow_nan=False)


def test_projected_page_retains_typed_cell_encodings_and_strict_json() -> None:
    engine = PandasEngine()
    frame = engine.ensure_row_ids(
        pd.DataFrame(
            {
                "omitted": ["wide payload"],
                "huge": [2**80],
                "missing": [float("nan")],
            }
        ),
        "typed-projection",
    )

    page = engine.page(
        frame,
        0,
        1,
        total_rows=1,
        column_projection=[(1, "stable:huge"), (2, "stable:missing")],
    )

    assert page["columnIds"] == ["stable:huge", "stable:missing"]
    assert page["rows"][0]["values"][0]["raw"] == str(2**80)
    assert page["rows"][0]["values"][1]["kind"] == "nan"
    json.dumps(page, allow_nan=False)


def test_semantic_type_inference_covers_duckdb_scalar_and_nested_types() -> None:
    assert infer_semantic_type("HUGEINT") == "integer"
    assert infer_semantic_type("DECIMAL(38, 6)") == "decimal"
    assert infer_semantic_type("TIMESTAMP WITH TIME ZONE") == "datetime"
    assert infer_semantic_type("INTERVAL") == "duration"
    assert infer_semantic_type("BLOB") == "binary"
    assert infer_semantic_type("VARCHAR") == "string"
    assert infer_semantic_type("UUID") == "string"
    assert infer_semantic_type("INTEGER[]") == "list"
    assert infer_semantic_type("MAP(VARCHAR, INTEGER)") == "struct"


@pytest.mark.parametrize(
    "raw_type,expected",
    [
        ("Enum(categories=['integer', 'array', 'struct'])", "string"),
        ("ENUM('decimal', 'bool', 'timestamp')", "string"),
        ("Struct({'payload': Array(Int64, shape=(2,))})", "struct"),
        ("struct<payload:array<int>>", "struct"),
        ("map<string,array<int>>", "struct"),
        ("Array(Struct({'decimal': String}), shape=(2,))", "list"),
        ("INTEGER[2]", "list"),
        ("ENUM('integer')[2]", "list"),
        ("struct<array: list<item: int64>>[pyarrow]", "struct"),
        ("large_list<item: struct<value: int64>>[pyarrow]", "list"),
        ("Sparse[int64, 0]", "integer"),
        ("Sparse[float64, nan]", "float"),
        ("int64[pyarrow]", "integer"),
        ("decimal128(38, 6)[pyarrow]", "decimal"),
        ("datetime64[ns, America/Indiana/Indianapolis]", "datetime"),
        ("duration[us][pyarrow]", "duration"),
        ("string[pyarrow]", "string"),
        ("category", "string"),
        ("complex128", "unknown"),
        ("void", "unknown"),
        ("extension<example.bool8>[pyarrow]", "unknown"),
        ("extension<arrow.uuid.extra>[pyarrow]", "unknown"),
        ("Enum(categories=['extension<arrow.bool8>[pyarrow]'])", "string"),
        ("struct<extension<arrow.uuid>: int64>[pyarrow]", "struct"),
    ],
)
def test_semantic_type_uses_outer_family_and_preserves_wrappers(raw_type: str, expected: str) -> None:
    assert infer_semantic_type(raw_type) == expected


@pytest.mark.parametrize("dtype", [pd.SparseDtype("int64", 0), pd.SparseDtype("float64", 0.0)])
def test_pandas_sparse_schema_retains_underlying_numeric_family(dtype: pd.SparseDtype) -> None:
    source = pd.DataFrame({"value": pd.Series([0, 1, 0], dtype=dtype)})
    before = source.copy(deep=True)
    expected = "integer" if dtype.subtype.kind == "i" else "float"
    assert PandasEngine().schema(source)[0]["type"] == expected
    pd.testing.assert_frame_equal(source, before)


def test_pandas_arrow_bool8_retains_native_and_generated_equality_filtering() -> None:
    pa = pytest.importorskip("pyarrow")
    nested_name = "extension<arrow.bool8>[pyarrow]"
    source = pd.DataFrame(
        {
            "value": pd.Series(pa.array([1, 0, None], type=pa.bool8()), dtype=pd.ArrowDtype(pa.bool8())),
            "detail": pd.Series(
                [{nested_name: "yes"}, {nested_name: "no"}, None],
                dtype=pd.ArrowDtype(pa.struct([(nested_name, pa.string())])),
            ),
        }
    )
    before = source.copy(deep=True)
    engine = PandasEngine()
    schema = engine.schema(source)
    assert schema[0]["type"] == "boolean"
    assert schema[1]["type"] == "struct"
    column_filter = {
        "column": "value",
        "type": "boolean",
        "predicates": [{"kind": "predicate", "operator": "equals", "value": True}],
    }
    live = engine.apply_filter_model(source, {"filters": [column_filter], "sort": []})
    lineage = source_lineage(schema)
    operation = bind_step(
        validate_step(
            {
                "id": "bool8-filter",
                "kind": "filterRows",
                "params": {"filterModel": {"filters": [{**column_filter, "column": lineage[0]}], "sort": []}},
            }
        ),
        schema,
        lineage,
    )
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([operation]), namespace)
    generated = namespace["clean_data"](source)
    pd.testing.assert_frame_equal(live, source.iloc[[0]])
    pd.testing.assert_frame_equal(generated, live)
    pd.testing.assert_frame_equal(source, before)


def test_pandas_arrow_uuid_retains_its_scalar_schema() -> None:
    pa = pytest.importorskip("pyarrow")
    source = pd.DataFrame(
        {
            "value": pd.Series(
                pa.array([UUID("00112233-4455-6677-8899-aabbccddeeff"), None], type=pa.uuid()),
                dtype=pd.ArrowDtype(pa.uuid()),
            )
        }
    )
    before = source.copy(deep=True)
    assert PandasEngine().schema(source)[0]["type"] == "string"
    pd.testing.assert_frame_equal(source, before)
