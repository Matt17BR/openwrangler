from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any, cast
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


def _arrow_dictionary_fixture(family: str, shape: str = "chunked") -> tuple[pd.DataFrame, pd.DataFrame, str]:
    import pyarrow as pa

    value_type, values, semantic = {
        "string": (pa.string(), ["É", None, "a[.", "É"], "string"),
        "large_string": (pa.large_string(), ["É", None, "a[.", "É"], "string"),
        "signed": (pa.int64(), [2**53 + 1, None, -1, 2**53 + 1], "integer"),
        "unsigned": (pa.uint64(), [2**32 + 1, None, 1, 2**32 + 1], "integer"),
        "float": (pa.float64(), [2.5, None, -0.5, 2.5], "float"),
        "decimal": (
            pa.decimal128(30, 6),
            [Decimal("2.000001"), None, Decimal("-1.123456"), Decimal("2.000001")],
            "decimal",
        ),
        "boolean": (pa.bool_(), [True, None, False, True], "boolean"),
        "date": (pa.date32(), [date(2024, 2, 29), None, date(1960, 1, 1), date(2024, 2, 29)], "date"),
        "timestamp": (
            pa.timestamp("us", "UTC"),
            [
                pd.Timestamp("2024-02-29", tz="UTC"),
                None,
                pd.Timestamp("1960-01-01", tz="UTC"),
                pd.Timestamp("2024-02-29", tz="UTC"),
            ],
            "datetime",
        ),
        "duration": (
            pa.duration("us"),
            [timedelta(days=2), None, timedelta(seconds=-1), timedelta(days=2)],
            "duration",
        ),
    }[family]
    indices = [0, 1, 2, 3, None] if shape == "chunked" else ([] if shape == "empty" else [1, None, 1])
    first = pa.DictionaryArray.from_arrays(
        pa.array(indices, type=pa.int8()), pa.array(values, type=value_type), ordered=True
    )
    second_values = list(reversed(values)) if shape == "chunked" else values
    second = pa.DictionaryArray.from_arrays(
        pa.array(indices, type=pa.int8()), pa.array(second_values, type=value_type), ordered=True
    )
    encoded = pd.Series(pd.arrays.ArrowExtensionArray(pa.chunked_array([first, second])), name="value")
    source = pd.DataFrame({"value": encoded, "row": range(len(encoded))})
    source.index = pd.MultiIndex.from_tuples(
        [("same", index % 2) for index in range(len(source))], names=["group", "label"]
    )
    logical = source.copy()
    logical.isetitem(0, pd.Series(encoded.astype(pd.ArrowDtype(value_type)).array, index=source.index))
    return source, logical, semantic


def _assert_dictionary_source_unchanged(source: pd.DataFrame, before: pd.DataFrame) -> None:
    assert source.index.equals(before.index)
    assert source.columns.equals(before.columns)
    assert source.dtypes.equals(before.dtypes)
    assert source.iloc[:, 0].array.__arrow_array__().equals(before.iloc[:, 0].array.__arrow_array__())
    assert source.iloc[:, 1].tolist() == before.iloc[:, 1].tolist()


def test_pandas_dictionary_filters_preserve_all_sparse_columns_and_stable_order() -> None:
    import pyarrow as pa

    maximum = 2**64 - 1
    large = 2**53
    book = pa.array([maximum, None, large + 1, maximum], type=pa.uint64())
    codes = pa.array([0, 1, 2, 3, None], type=pa.uint8())
    chunks = [pa.DictionaryArray.from_arrays(codes, values) for values in [book, book.take([3, 2, 1, 0])]]
    sparse_values = [0, large + 4, large + 3, maximum, 0, large + 2, maximum, large + 1, large + 2, 0]
    untouched_values = list(reversed(sparse_values))
    source = pd.DataFrame(
        {
            "encoded": pd.Series(pd.arrays.ArrowExtensionArray(pa.chunked_array(chunks))),
            "sparse": pd.Series(sparse_values, dtype=object).astype(pd.SparseDtype("uint64", 0)),
            "untouched": pd.Series(untouched_values, dtype=object).astype(pd.SparseDtype("uint64", 0)),
            "row": range(10),
        }
    )
    source.index = pd.MultiIndex.from_tuples([("same", index % 2) for index in range(10)], names=["outer", "inner"])
    source.attrs = {"source": "retained"}
    before = source.copy(deep=True)
    engine = PandasEngine()
    schema = engine.schema(source)
    lineage = source_lineage(schema)
    choices, _ = engine.column_values(source, "encoded")
    token = next(choice["selectionValue"] for choice in choices if choice["value"] == str(maximum))
    filters = [
        {
            "column": "encoded",
            "type": "integer",
            "predicates": [],
            "valueFilter": {"kind": "values", "selectedValues": [token], "includeNulls": False, "includeNaN": False},
        },
        {
            "column": "sparse",
            "type": "integer",
            "predicates": [{"kind": "predicate", "operator": "gte", "value": str(large)}],
        },
    ]
    rules = [
        {"column": "sparse", "direction": "asc", "nulls": "last"},
        {"column": "row", "direction": "desc", "nulls": "last"},
    ]
    bound_filters = [{**item, "column": lineage[index]} for index, item in enumerate(filters)]
    bound_rules = [{**rule, "column": lineage[index]} for rule, index in zip(rules, [1, 3], strict=True)]
    steps = [
        bind_step(
            validate_step(
                {
                    "id": "select",
                    "kind": "filterRows",
                    "params": {"filterModel": {"filters": bound_filters, "sort": []}},
                }
            ),
            schema,
            lineage,
        ),
        bind_step(
            validate_step({"id": "order", "kind": "sortRows", "params": {"rules": bound_rules}}), schema, lineage
        ),
    ]
    live = source
    for step in steps:
        live = engine.apply_transform(live, step)
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan(steps), namespace)
    expected_rows = [8, 5, 3]
    for result in [
        engine.apply_filter_model(source, {"filters": filters, "sort": rules}),
        live,
        namespace["clean_data"](source),
    ]:
        assert result["row"].tolist() == expected_rows
        assert (
            cast(pd.arrays.ArrowExtensionArray, result["encoded"].array).__arrow_array__().to_pylist() == [maximum] * 3
        )
        for name, values in [("sparse", sparse_values), ("untouched", untouched_values)]:
            assert result[name].dtype == source[name].dtype
            assert [int(value) for value in result[name].array] == [values[index] for index in expected_rows]
        assert result.index.equals(source.index.take(expected_rows))
        assert result.columns.equals(source.columns)
        assert result.attrs == source.attrs
    assert source["encoded"].dtype == before["encoded"].dtype
    assert (
        cast(pd.arrays.ArrowExtensionArray, source["encoded"].array)
        .__arrow_array__()
        .equals(cast(pd.arrays.ArrowExtensionArray, before["encoded"].array).__arrow_array__())
    )
    pd.testing.assert_frame_equal(source.iloc[:, 1:], before.iloc[:, 1:])
    assert source.attrs == before.attrs


_ARROW_DICTIONARY_FAMILIES = [
    "string",
    "large_string",
    "signed",
    "unsigned",
    "float",
    "decimal",
    "boolean",
    "date",
    "timestamp",
    "duration",
]


@pytest.mark.parametrize("family", _ARROW_DICTIONARY_FAMILIES)
@pytest.mark.parametrize("shape", ["chunked", "empty", "all-null"])
def test_pandas_arrow_dictionary_profiles_use_logical_values(family: str, shape: str) -> None:
    source, logical, semantic = _arrow_dictionary_fixture(family, shape)
    before = source.copy(deep=True)
    engine = PandasEngine()
    schema = engine.schema(source)[0]
    assert schema["type"] == semantic
    assert schema["rawType"] == str(source.iloc[:, 0].dtype)
    assert schema["nullable"] == bool(logical.iloc[:, 0].isna().any())
    expected_summary = engine.summaries(logical, [(0, "c:0")])[0]
    expected_summary["rawType"] = str(source.iloc[:, 0].dtype)
    assert engine.summaries(source, [(0, "c:0")])[0] == expected_summary
    assert engine.column_values(source, "value") == engine.column_values(logical, "value")
    assert engine.column_values(source, "value", limit=1) == engine.column_values(logical, "value", limit=1)
    assert engine.header_stats(source[["value"]]) == engine.header_stats(logical[["value"]])
    assert engine.missing_count(source, 0) == engine.missing_count(logical, 0)
    if semantic == "string":
        for search in ["A[.", "é", "É", "missing"]:
            assert engine.column_values(source, "value", search, 1) == engine.column_values(logical, "value", search, 1)
    _assert_dictionary_source_unchanged(source, before)


@pytest.mark.parametrize("family", _ARROW_DICTIONARY_FAMILIES)
@pytest.mark.parametrize("direction,nulls", [("asc", "first"), ("asc", "last"), ("desc", "first"), ("desc", "last")])
def test_pandas_arrow_dictionary_sort_filter_and_generated_code(family: str, direction: str, nulls: str) -> None:
    import pyarrow as pa

    source, logical, semantic = _arrow_dictionary_fixture(family)
    before = source.copy(deep=True)
    engine = PandasEngine()
    model = {"filters": [], "sort": [{"column": "value", "direction": direction, "nulls": nulls}]}
    expected = engine.apply_filter_model(logical, model)
    actual = engine.apply_filter_model(source, model)
    assert actual["row"].tolist() == expected["row"].tolist()
    assert actual.index.equals(expected.index)
    schema = engine.schema(source)
    lineage = source_lineage(schema)
    for kind, params in [
        ("sortRows", {"rules": [{**model["sort"][0], "column": lineage[0]}]}),
        (
            "filterRows",
            {
                "filterModel": {
                    "filters": [
                        {
                            "column": lineage[0],
                            "type": semantic,
                            "predicates": [{"kind": "predicate", "operator": "isNotNull"}],
                        }
                    ],
                    "sort": [{**model["sort"][0], "column": lineage[0]}],
                }
            },
        ),
    ]:
        operation = bind_step(validate_step({"id": "dictionary-rows", "kind": kind, "params": params}), schema, lineage)
        expected_rows = (
            expected["row"].tolist() if kind == "sortRows" else expected.loc[expected["value"].notna(), "row"].tolist()
        )
        namespace: dict[str, Any] = {}
        exec(engine.compile_plan([operation]), namespace)
        for result in [engine.apply_transform(source, operation), namespace["clean_data"](source)]:
            assert result["row"].tolist() == expected_rows
            expected_result = logical.iloc[expected_rows]
            assert result.index.equals(expected_result.index)
            source_cells = [normalize_cell(value) for value in source["value"].array]
            assert [normalize_cell(value) for value in result["value"].array] == [
                source_cells[row] for row in expected_rows
            ]
            native_type = result["value"].dtype.pyarrow_dtype
            assert pa.types.is_dictionary(native_type)
            source_dtype = source["value"].dtype
            assert isinstance(source_dtype, pd.ArrowDtype)
            assert native_type.value_type == source_dtype.pyarrow_dtype.value_type
            assert native_type.ordered is True
    _assert_dictionary_source_unchanged(source, before)


@pytest.mark.parametrize(("index_type", "entries"), [("int8", 126), ("uint8", 200)])
def test_pandas_arrow_dictionary_widens_only_result_codes_for_cross_chunk_sort(index_type: str, entries: int) -> None:
    import pyarrow as pa

    chunks = [
        pa.DictionaryArray.from_arrays(
            pa.array(range(entries), type=getattr(pa, index_type)()),
            pa.array([str(offset + value) for value in range(entries)]),
        )
        for offset in [0, entries]
    ]
    source = pd.DataFrame(
        {"value": pd.Series(pd.arrays.ArrowExtensionArray(pa.chunked_array(chunks))), "row": range(2 * entries)}
    )
    before = source.copy(deep=True)
    engine = PandasEngine()
    schema = engine.schema(source)
    operation = bind_step(
        validate_step(
            {
                "id": "dictionary-capacity",
                "kind": "sortRows",
                "params": {"rules": [{"column": source_lineage(schema)[0], "direction": "desc", "nulls": "last"}]},
            }
        ),
        schema,
        source_lineage(schema),
    )
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([operation]), namespace)
    for actual in [engine.apply_transform(source, operation), namespace["clean_data"](source)]:
        assert actual["value"].tolist() == sorted(source["value"].tolist(), reverse=True)
        assert actual["value"].dtype.pyarrow_dtype.index_type == pa.int16()
    _assert_dictionary_source_unchanged(source, before)


def test_pandas_arrow_dictionary_float_profiles_preserve_valid_nan_and_signed_zero() -> None:
    import pyarrow as pa

    values = pa.array(
        [float("nan"), None, -0.0, 0.0, float("inf"), -float("inf")], type=pa.float64(), from_pandas=False
    )
    first = pa.DictionaryArray.from_arrays(pa.array([0, 1, 2, 3, 4, 5, None]), values)
    source = pd.DataFrame({"value": pd.Series(pd.arrays.ArrowExtensionArray(pa.chunked_array([first, first])))})
    logical = source.copy()
    logical["value"] = source["value"].astype(pd.ArrowDtype(pa.float64()))
    engine = PandasEngine()
    expected = engine.summaries(logical)[0]
    expected["rawType"] = str(source["value"].dtype)
    assert engine.summaries(source)[0] == expected
    for direction in ["asc", "desc"]:
        actual = engine.apply_filter_model(
            source, {"sort": [{"column": "value", "direction": direction, "nulls": "first"}]}
        )
        expected_order = engine.apply_filter_model(
            logical, {"sort": [{"column": "value", "direction": direction, "nulls": "first"}]}
        )
        assert [normalize_cell(value) for value in actual["value"].array] == [
            normalize_cell(value) for value in expected_order["value"].array
        ]
        assert [
            bool(np.signbit(value)) for value in actual["value"].array if isinstance(value, float) and value == 0
        ] == [
            bool(np.signbit(value))
            for value in expected_order["value"].array
            if isinstance(value, float) and value == 0
        ]


@pytest.mark.parametrize("value_type", ["string", "int64"])
def test_pandas_arrow_dictionary_empty_codebooks_and_null_indices(value_type: str) -> None:
    import pyarrow as pa

    dtype = getattr(pa, value_type)()
    chunk = pa.DictionaryArray.from_arrays(pa.array([None, None], type=pa.int8()), pa.array([], type=dtype))
    source = pd.DataFrame(
        {"value": pd.Series(pd.arrays.ArrowExtensionArray(pa.chunked_array([chunk, chunk]))), "row": range(4)}
    )
    before = source.copy(deep=True)
    engine = PandasEngine()
    assert engine.schema(source)[0]["nullable"] is True
    assert engine.summaries(source)[0]["nullCount"] == 4
    assert engine.summaries(source)[0]["distinctCount"] == 0
    assert engine.column_values(source, "value") == ([], False)
    assert engine.apply_filter_model(source, {"sort": [{"column": "value", "direction": "asc", "nulls": "first"}]})[
        "row"
    ].tolist() == [0, 1, 2, 3]
    _assert_dictionary_source_unchanged(source, before)


@pytest.mark.parametrize("family", ["binary", "list", "extension"])
def test_pandas_arrow_dictionary_does_not_advertise_unaccepted_value_families(family: str) -> None:
    import pyarrow as pa

    values = {
        "binary": pa.array([b"one", None], type=pa.binary()),
        "list": pa.array([[1], None], type=pa.list_(pa.int64())),
        "extension": pa.array([1, None], type=pa.bool8()),
    }[family]
    source = pd.DataFrame(
        {"value": pd.Series(pd.arrays.ArrowExtensionArray(pa.DictionaryArray.from_arrays(pa.array([0, 1]), values)))}
    )
    assert PandasEngine().schema(source)[0]["type"] == "struct"


def test_pandas_arrow_dictionary_generated_filters_keep_literal_and_column_logic() -> None:
    source, logical, _ = _arrow_dictionary_fixture("large_string")
    source.columns = logical.columns = ["_filter_series_0", "row"]
    before = source.copy(deep=True)
    engine = PandasEngine()
    schema = engine.schema(source)
    lineage = source_lineage(schema)
    filters = [
        {
            "column": "_filter_series_0",
            "type": "string",
            "logic": "and",
            "predicates": [
                {"kind": "predicate", "operator": "contains", "value": "A[."},
                {"kind": "predicate", "operator": "endsWith", "value": "."},
            ],
        },
        {
            "column": "row",
            "type": "integer",
            "predicates": [{"kind": "predicate", "operator": "equals", "value": 0}],
        },
    ]
    model = {"logic": "or", "filters": filters, "sort": []}
    expected = engine.apply_filter_model(logical, model)
    actual = engine.apply_filter_model(source, model)
    operation = bind_step(
        validate_step(
            {
                "id": "dictionary-literals",
                "kind": "filterRows",
                "params": {
                    "filterModel": {
                        **model,
                        "filters": [{**column, "column": lineage[index]} for index, column in enumerate(filters)],
                    }
                },
            }
        ),
        schema,
        lineage,
    )
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([operation]), namespace)
    for result in [actual, engine.apply_transform(source, operation), namespace["clean_data"](source)]:
        assert result["row"].tolist() == expected["row"].tolist() == [0, 2, 6]
        assert result.index.equals(expected.index)
    _assert_dictionary_source_unchanged(source, before)


@pytest.mark.parametrize("family", _ARROW_DICTIONARY_FAMILIES)
def test_pandas_arrow_dictionary_selected_values_match_bound_generated_filters(family: str) -> None:
    source, logical, semantic = _arrow_dictionary_fixture(family)
    before = source.copy(deep=True)
    engine = PandasEngine()
    values, _ = engine.column_values(source, "value")
    chosen = values[0]["selectionValue"]
    model = {
        "filters": [
            {
                "column": "value",
                "type": semantic,
                "predicates": [],
                "valueFilter": {
                    "kind": "values",
                    "selectedValues": [chosen],
                    "includeNulls": True,
                    "includeNaN": False,
                },
            }
        ],
        "sort": [],
    }
    assert (
        engine.apply_filter_model(source, model)["row"].tolist()
        == engine.apply_filter_model(logical, model)["row"].tolist()
    )
    schema = engine.schema(source)
    lineage = source_lineage(schema)
    operation = bind_step(
        validate_step(
            {
                "id": "dictionary-selected",
                "kind": "filterRows",
                "params": {"filterModel": {**model, "filters": [{**model["filters"][0], "column": lineage[0]}]}},
            }
        ),
        schema,
        lineage,
    )
    expected = engine.apply_filter_model(logical, model)
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([operation]), namespace)
    for result in [engine.apply_transform(source, operation), namespace["clean_data"](source)]:
        assert result["row"].tolist() == expected["row"].tolist()
        assert result.index.equals(expected.index)
        expected_dtype = before["value"].dtype
        assert isinstance(expected_dtype, pd.ArrowDtype)
        assert result["value"].dtype.pyarrow_dtype.value_type == expected_dtype.pyarrow_dtype.value_type
    _assert_dictionary_source_unchanged(source, before)


@pytest.mark.parametrize("index_type", ["uint8", "uint16", "uint32", "uint64"])
@pytest.mark.parametrize("value_type", ["string", "large_string"])
@pytest.mark.parametrize("chunk_count", [1, 2])
def test_pandas_arrow_dictionary_unsigned_codes_preserve_logical_values(
    index_type: str, value_type: str, chunk_count: int
) -> None:
    import pyarrow as pa

    chunk = pa.DictionaryArray.from_arrays(
        pa.array([0, 1, 2, None, 3], type=getattr(pa, index_type)()),
        pa.array(["z", None, "a", "z"], type=getattr(pa, value_type)()),
        ordered=True,
    )
    source = pd.DataFrame(
        {
            "value": pd.Series(pd.arrays.ArrowExtensionArray(pa.chunked_array([chunk] * chunk_count))),
            "row": range(5 * chunk_count),
        }
    )
    before = source.copy(deep=True)
    logical = source.copy(deep=False)
    logical["value"] = source["value"].astype(pd.ArrowDtype(chunk.dictionary.type))
    engine = PandasEngine()
    assert engine.schema(source)[0]["nullable"] is True
    assert engine.summaries(source)[0]["nullCount"] == 2 * chunk_count
    assert engine.column_values(source, "value") == engine.column_values(logical, "value")
    model = {"sort": [{"column": "value", "direction": "asc", "nulls": "last"}]}
    expected = engine.apply_filter_model(logical, model)
    schema = engine.schema(source)
    lineage = source_lineage(schema)
    operation = bind_step(
        validate_step(
            {
                "id": "unsigned-dictionary-sort",
                "kind": "sortRows",
                "params": {"rules": [{"column": lineage[0], "direction": "asc", "nulls": "last"}]},
            }
        ),
        schema,
        lineage,
    )
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([operation]), namespace)
    for result in [
        engine.apply_filter_model(source, model),
        engine.apply_transform(source, operation),
        namespace["clean_data"](source),
    ]:
        assert result["row"].tolist() == expected["row"].tolist()
        actual_type = result["value"].dtype.pyarrow_dtype
        assert actual_type.value_type == chunk.dictionary.type
        assert actual_type.ordered is True
        assert [normalize_cell(value) for value in result["value"].array] == [
            normalize_cell(source["value"].iloc[position]) for position in expected["row"]
        ]
    _assert_dictionary_source_unchanged(source, before)
