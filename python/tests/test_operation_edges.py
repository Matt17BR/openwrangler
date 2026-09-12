from __future__ import annotations

from datetime import date, datetime, timezone
from math import copysign, isnan
from typing import Any, cast

import pandas as pd
import polars as pl
import pytest
from polars.testing import assert_frame_equal as assert_polars_frame_equal

from openwrangler_runtime._column_binding import ColumnBindingError, bind_step
from openwrangler_runtime.engines import EngineError, PandasEngine, PolarsEngine
from openwrangler_runtime.engines.base import typed_selection_value
from openwrangler_runtime.lineage import derive_lineage, source_lineage
from openwrangler_runtime.operations import OperationError, validate_step


@pytest.fixture(params=["pandas", "polars"])
def engine(request, monkeypatch):
    if request.param == "pandas":
        return PandasEngine()
    monkeypatch.setattr(
        pl.DataFrame,
        "to_pandas",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Polars must stay native")),
        raising=False,
    )
    return PolarsEngine()


def step(kind: str, **params: Any) -> dict[str, Any]:
    return validate_step({"id": f"edge-{kind}", "kind": kind, "params": params})


def bound_ref(identifier: str, name: str, position: int) -> dict[str, str | int]:
    return {"id": identifier, "name": name, "position": position}


def public_ref(identifier: str, name: str) -> dict[str, str]:
    return {"id": identifier, "name": name}


def bound_step(kind: str, **params: Any) -> dict[str, Any]:
    return {"id": f"edge-{kind}", "kind": kind, "params": params}


def frame_for(engine: PandasEngine | PolarsEngine, data: dict[str, list[Any]]) -> Any:
    return pd.DataFrame(data) if isinstance(engine, PandasEngine) else pl.DataFrame(data)


def records(frame: Any) -> list[dict[str, Any]]:
    if isinstance(frame, pl.LazyFrame):
        frame = frame.collect()
    return frame.to_dicts() if isinstance(frame, pl.DataFrame) else frame.to_dict(orient="records")


def execute_generated(engine: PandasEngine | PolarsEngine, frame: Any, operation: dict[str, Any]) -> Any:
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([operation]), namespace, namespace)
    return namespace["clean_data"](frame)


def normalized(value: Any) -> Any:
    if value is None or value is pd.NA or value is pd.NaT:
        return None
    if isinstance(value, float) and isnan(value):
        return None
    return value


def assert_records_equal(left: Any, right: Any) -> None:
    left_rows = records(left)
    right_rows = records(right)
    assert [list(row) for row in left_rows] == [list(row) for row in right_rows]
    assert [{key: normalized(value) for key, value in row.items()} for row in left_rows] == [
        {key: normalized(value) for key, value in row.items()} for row in right_rows
    ]


def typed_records(engine: PandasEngine | PolarsEngine, frame: Any) -> list[dict[str, dict[str, Any]]]:
    schema = engine.schema(frame)
    row_count = engine.shape(frame)["rows"]
    assert row_count is not None
    page = engine.page(
        frame,
        0,
        row_count,
        column_projection=[(column["position"], column["id"]) for column in schema],
    )
    return [{column["name"]: cell for column, cell in zip(schema, row["values"], strict=True)} for row in page["rows"]]


def test_column_values_break_equal_counts_by_display_text(engine) -> None:
    frame = frame_for(engine, {"city": ["Milan", "Berlin", "Milan", "Berlin", "Paris"]})

    values, has_more = engine.column_values(frame, "city")

    assert values == [
        {"value": "Berlin", "count": 2, "selectionValue": typed_selection_value("Berlin", "string")},
        {"value": "Milan", "count": 2, "selectionValue": typed_selection_value("Milan", "string")},
        {"value": "Paris", "count": 1, "selectionValue": typed_selection_value("Paris", "string")},
    ]
    assert has_more is False


def test_multi_sort_honors_per_column_null_order_and_stable_ties(engine) -> None:
    frame = frame_for(
        engine,
        {
            "id": [0, 1, 2, 3, 4, 5],
            "primary": [1, None, 1, 1, None, 1],
            "secondary": [2, 1, None, 2, None, 1],
        },
    )
    operation = bound_step(
        "sortRows",
        rules=[
            {
                "column": bound_ref("c:source:1", "primary", 1),
                "direction": "asc",
                "nulls": "last",
            },
            {
                "column": bound_ref("c:source:2", "secondary", 2),
                "direction": "desc",
                "nulls": "first",
            },
        ],
    )

    transformed = engine.apply_transform(frame, operation)
    assert [row["id"] for row in records(transformed)] == [2, 0, 3, 5, 4, 1]
    assert_records_equal(transformed, execute_generated(engine, frame, operation))

    filter_operation = bound_step(
        "filterRows",
        filterModel={"filters": [], "sort": operation["params"]["rules"]},
    )
    filtered = engine.apply_transform(frame, filter_operation)
    assert [row["id"] for row in records(filtered)] == [2, 0, 3, 5, 4, 1]
    assert_records_equal(filtered, execute_generated(engine, frame, filter_operation))


def test_non_float_include_nan_value_filter_is_an_explicit_false_condition(engine) -> None:
    frame = frame_for(engine, {"value": [1, 2]})
    operation = bound_step(
        "filterRows",
        filterModel={
            "filters": [
                {
                    "column": bound_ref("c:source:0", "value", 0),
                    "type": "integer",
                    "valueFilter": {
                        "kind": "values",
                        "selectedValues": [],
                        "includeNulls": False,
                        "includeNaN": True,
                    },
                    "predicates": [],
                }
            ],
            "sort": [],
        },
    )

    transformed = engine.apply_transform(frame, operation)
    generated = execute_generated(engine, frame, operation)

    assert records(transformed) == []
    assert_records_equal(transformed, generated)


def test_min_max_scale_preserves_null_and_nan_for_constant_columns(engine) -> None:
    frame = frame_for(engine, {"value": [5.0, None, 5.0, float("nan")]})
    operation = bound_step(
        "minMaxScale",
        column=bound_ref("c:source:0", "value", 0),
        newColumn="scaled",
    )

    transformed = engine.apply_transform(frame, operation)
    assert [normalized(row["scaled"]) for row in records(transformed)] == [0.0, None, 0.0, None]
    assert_records_equal(transformed, execute_generated(engine, frame, operation))


def test_numeric_operations_handle_non_finite_values_deterministically(engine) -> None:
    frame = frame_for(
        engine,
        {"value": [1.2, 3.2, None, float("nan"), float("inf"), float("-inf")]},
    )
    operations = [
        bound_step("minMaxScale", column=bound_ref("c:source:0", "value", 0), newColumn="scaled"),
        bound_step(
            "roundNumber",
            column=bound_ref("c:source:0", "value", 0),
            decimals=0,
            newColumn="rounded",
        ),
        bound_step("floorNumber", column=bound_ref("c:source:0", "value", 0), newColumn="floored"),
        bound_step("ceilNumber", column=bound_ref("c:source:0", "value", 0), newColumn="ceiled"),
    ]
    transformed = frame
    for operation in operations:
        transformed = engine.apply_transform(transformed, operation)

    result = records(transformed)
    assert [normalized(row["scaled"]) for row in result] == [0.0, 1.0, None, None, None, None]
    assert [normalized(row["floored"]) for row in result] == [1.0, 3.0, None, None, float("inf"), float("-inf")]
    assert [normalized(row["ceiled"]) for row in result] == [2.0, 4.0, None, None, float("inf"), float("-inf")]

    namespace: dict[str, Any] = {}
    exec(engine.compile_plan(operations), namespace, namespace)
    assert_records_equal(transformed, namespace["clean_data"](frame))


def test_missing_and_duplicate_row_modes_match_generated_code(engine) -> None:
    missing_frame = frame_for(
        engine,
        {
            "left": [1.0, None, None, float("nan"), 4.0],
            "right": [None, 2.0, None, 3.0, 4.0],
        },
    )
    missing_columns = [
        bound_ref("c:source:0", "left", 0),
        bound_ref("c:source:1", "right", 1),
    ]
    drop_any = bound_step("dropMissingRows", columns=missing_columns, how="any")
    drop_all = bound_step("dropMissingRows", columns=missing_columns, how="all")
    any_result = engine.apply_transform(missing_frame, drop_any)
    all_result = engine.apply_transform(missing_frame, drop_all)

    assert len(records(any_result)) == 1
    assert len(records(all_result)) == 4
    assert_records_equal(any_result, execute_generated(engine, missing_frame, drop_any))
    assert_records_equal(all_result, execute_generated(engine, missing_frame, drop_all))
    all_columns = bound_step("dropMissingRows", columns=[], how="any")
    all_columns_result = engine.apply_transform(missing_frame, all_columns)
    assert len(records(all_columns_result)) == 1
    assert_records_equal(all_columns_result, execute_generated(engine, missing_frame, all_columns))

    duplicate_frame = frame_for(
        engine,
        {"key": ["a", "a", "b", "b", "c"], "value": [1.0, 1.0, None, None, 3.0]},
    )
    duplicate_columns = [
        bound_ref("c:source:0", "key", 0),
        bound_ref("c:source:1", "value", 1),
    ]
    keep_last = bound_step("dropDuplicates", columns=duplicate_columns, keep="last")
    keep_none = bound_step("dropDuplicates", columns=duplicate_columns, keep="none")
    last_result = engine.apply_transform(duplicate_frame, keep_last)
    none_result = engine.apply_transform(duplicate_frame, keep_none)

    assert [row["key"] for row in records(last_result)] == ["a", "b", "c"]
    assert [row["key"] for row in records(none_result)] == ["c"]
    assert_records_equal(last_result, execute_generated(engine, duplicate_frame, keep_last))
    assert_records_equal(none_result, execute_generated(engine, duplicate_frame, keep_none))
    keep_all = bound_step("dropDuplicates", keep="first")
    keep_all_result = engine.apply_transform(duplicate_frame, keep_all)
    assert [row["key"] for row in records(keep_all_result)] == ["a", "b", "c"]
    assert_records_equal(keep_all_result, execute_generated(engine, duplicate_frame, keep_all))


@pytest.mark.parametrize(
    ("kind", "options", "kept_rows"),
    [
        ("dropMissingRows", {"how": "any"}, [0, 2, 3]),
        ("dropDuplicates", {"keep": "first"}, [0, 1, 3]),
        ("markDuplicates", {"newColumn": "duplicate"}, [0, 1, 2, 3]),
    ],
)
def test_pandas_row_selection_maps_visible_positions_once_per_operation(
    monkeypatch: pytest.MonkeyPatch, kind: str, options: dict[str, Any], kept_rows: list[int]
) -> None:
    engine = PandasEngine()
    source = pd.DataFrame(
        [[10.0, 1.0, "a"], [20.0, None, "b"], [None, 1.0, "a"], [40.0, 2.0, "c"]],
        columns=cast(Any, ["same", "same", 7]),
        index=pd.Index([7, 7, 2, 9], name="source_index"),
    )
    source.attrs = {"owned": "sentinel"}
    source_before = source.copy(deep=True)
    identified = engine.ensure_row_ids(source, "row-selection-map").iloc[:, [0, 3, 1, 2]]
    row_id = engine.internal_row_id_column(identified)
    assert row_id is not None
    before = identified.copy(deep=True)
    operation = bound_step(
        kind,
        columns=[bound_ref("c:source:2", "7", 2), bound_ref("c:source:1", "same", 1)],
        **options,
    )
    visible_positions = engine._visible_positions
    scans = 0

    def counted_visible_positions(frame: Any) -> list[int]:
        nonlocal scans
        scans += 1
        return visible_positions(frame)

    with monkeypatch.context() as context:
        context.setattr(engine, "_visible_positions", counted_visible_positions)
        actual = engine.apply_transform(identified, operation)
        assert scans == 1

    expected = source.iloc[kept_rows].copy()
    if kind == "markDuplicates":
        expected["duplicate"] = [True, False, True, False]
    generated = execute_generated(engine, source, operation)
    pd.testing.assert_frame_equal(actual.drop(columns=[row_id]), expected, check_exact=True)
    pd.testing.assert_frame_equal(actual.drop(columns=[row_id]), generated, check_exact=True)
    assert actual.attrs == generated.attrs
    if kind != "markDuplicates":
        assert actual.attrs == source.attrs
    pd.testing.assert_series_equal(actual[row_id], before.iloc[kept_rows][row_id], check_exact=True)
    pd.testing.assert_frame_equal(identified, before, check_exact=True)
    pd.testing.assert_frame_equal(source, source_before, check_exact=True)
    assert identified.attrs == before.attrs == source.attrs == source_before.attrs


def test_pandas_row_order_operations_target_duplicate_and_integer_labels_positionally() -> None:
    engine = PandasEngine()
    frame = pd.DataFrame(
        [
            [1, 20.0, "x", "r0"],
            [1, 10.0, "x", "r1"],
            [2, None, "y", "r2"],
            [1, 10.0, "x", "r3"],
        ],
        columns=cast(Any, ["duplicate", "duplicate", 7, "label"]),
    )
    plan = [
        bound_step(
            "sortRows",
            rules=[
                {
                    "column": bound_ref("c:source:1", "duplicate", 1),
                    "direction": "asc",
                    "nulls": "last",
                }
            ],
        ),
        bound_step(
            "filterRows",
            filterModel={
                "filters": [
                    {
                        "column": bound_ref("c:source:0", "duplicate", 0),
                        "type": "integer",
                        "predicates": [{"kind": "predicate", "operator": "equals", "value": 1}],
                    }
                ],
                "sort": [
                    {
                        "column": bound_ref("c:source:2", "7", 2),
                        "direction": "asc",
                        "nulls": "last",
                    }
                ],
            },
        ),
        bound_step(
            "dropMissingRows",
            columns=[bound_ref("c:source:1", "duplicate", 1)],
            how="any",
        ),
        bound_step(
            "dropDuplicates",
            columns=[
                bound_ref("c:source:1", "duplicate", 1),
                bound_ref("c:source:2", "7", 2),
            ],
            keep="first",
        ),
    ]

    transformed = frame
    for operation in plan:
        transformed = engine.apply_transform(transformed, operation)
    code = engine.compile_plan(plan)
    namespace: dict[str, Any] = {}
    exec(code, namespace, namespace)
    generated = namespace["clean_data"](frame)

    pd.testing.assert_frame_equal(transformed, generated)
    assert transformed["label"].tolist() == ["r1", "r0"]
    assert list(transformed.columns) == ["duplicate", "duplicate", 7, "label"]
    assert code.count(".iloc") >= 4


@pytest.mark.parametrize("family", ["string", "integer", "decimal", "float"])
@pytest.mark.parametrize(
    "kind,options,expected_rows",
    [
        ("dropMissingRows", {"how": "any"}, [0, 4, 5, 8, 9]),
        ("dropMissingRows", {"how": "all"}, [0, 1, 3, 4, 5, 7, 8, 9]),
        ("dropDuplicates", {"keep": "first"}, [0, 1, 3]),
        ("dropDuplicates", {"keep": "last"}, [7, 8, 9]),
        ("dropDuplicates", {"keep": "none"}, []),
    ],
)
def test_pandas_row_removal_uses_dictionary_values_and_preserves_sparse_payload(
    family: str, kind: str, options: dict[str, str], expected_rows: list[int]
) -> None:
    from decimal import Decimal

    import pyarrow as pa

    from openwrangler_runtime.engines.base import normalize_cell

    value_type, first, second = {
        "string": (pa.string(), "É", "a[."),
        "integer": (pa.uint64(), 2**64 - 1, 2**53 + 3),
        "decimal": (pa.decimal128(30, 3), Decimal("9007199254740993.125"), Decimal("-0.125")),
        "float": (pa.float64(), float("nan"), -0.0),
    }[family]
    encoded = pa.chunked_array(
        [
            pa.DictionaryArray.from_arrays(
                pa.array([0, 1, None, 2, 3], type=pa.int8()),
                pa.array([left, None, right, left], type=value_type),
            )
            for left, right in [(first, second), (second, first)]
        ]
    )
    source = pd.DataFrame(
        {
            "key": pd.Series(encoded, dtype=pd.ArrowDtype(encoded.type)),
            "present": pd.Series([1, 1, None, None, 1, 1, None, 1, 1, 1], dtype="Int64"),
            "payload": pd.Series([0, 2**53 + 3, 2**53 + 4, 2**64 - 1, 0] * 2, dtype=pd.SparseDtype("uint64", 0)),
        }
    )
    source.index = pd.MultiIndex.from_tuples([("row", i % 3) for i in range(10)], names=["group", "number"])
    source.attrs = {"origin": "row-removal"}
    before = source.copy(deep=True)
    engine = PandasEngine()
    schema = engine.schema(source)
    lineage = source_lineage(schema)
    operation = bind_step(
        step(kind, columns=lineage[:2] if kind == "dropMissingRows" else lineage[:1], **options), schema, lineage
    )
    engine.validate_transform_preflight(source, operation, engine.shape(source))
    for actual in [engine.apply_transform(source, operation), execute_generated(engine, source, operation)]:
        assert actual.index.equals(source.index.take(expected_rows))
        assert actual.columns.equals(source.columns)
        assert actual.attrs == source.attrs
        assert list(actual.dtypes) == list(source.dtypes)
        for position in range(source.shape[1]):
            assert [normalize_cell(value) for value in actual.iloc[:, position].array] == [
                normalize_cell(source.iloc[:, position].array[row]) for row in expected_rows
            ]
    assert source.iloc[:, 0].array.__arrow_array__().equals(before.iloc[:, 0].array.__arrow_array__())
    pd.testing.assert_frame_equal(source.iloc[:, 1:], before.iloc[:, 1:])
    assert source.attrs == before.attrs


@pytest.mark.parametrize("keep,expected_rows", [("first", [0, 1, 2, 3]), ("last", [1, 3, 4, 5]), ("none", [1, 3])])
def test_pandas_drop_duplicates_keeps_distinct_sparse_integer_neighbors(keep: str, expected_rows: list[int]) -> None:
    source = pd.DataFrame(
        {
            "key": pd.Series([0, 2**53 + 4, 2**53 + 3, 2**64 - 1, 0, 2**53 + 3], dtype=pd.SparseDtype("uint64", 0)),
            "constant": [1] * 6,
            "row": range(6),
        },
    )
    source.index = pd.Index([0, 0, 1, 1, 2, 2], name="duplicate")
    before = source.copy(deep=True)
    engine = PandasEngine()
    schema = engine.schema(source)
    lineage = source_lineage(schema)
    operation = bind_step(step("dropDuplicates", columns=lineage[:2], keep=keep), schema, lineage)
    engine.validate_transform_preflight(source, operation, engine.shape(source))
    for actual in [engine.apply_transform(source, operation), execute_generated(engine, source, operation)]:
        assert actual["row"].tolist() == expected_rows
        assert actual["key"].tolist() == [int(source["key"].array[row]) for row in expected_rows]
        assert actual["key"].dtype == source["key"].dtype
        assert actual.index.equals(source.index.take(expected_rows))
    pd.testing.assert_frame_equal(source, before)


@pytest.mark.parametrize(
    "family,layout",
    [
        (family, layout)
        for family in ["integer", "unsigned", "timestamp", "timezone", "duration", "time", "date", "dictionary"]
        for layout in ["nullable", "present", "composite", "empty", "all-missing"]
    ]
    + [
        (family, layout)
        for family in ["timestamp-minimum", "timezone-minimum", "duration-minimum"]
        for layout in ["nullable", "present", "composite"]
    ],
)
@pytest.mark.parametrize("keep", ["first", "last", "none"])
def test_pandas_arrow_duplicates_keep_exact_neighbor_rows(family: str, layout: str, keep: str) -> None:
    import pyarrow as pa

    dtype, high, low = {
        "integer": (pa.int64(), 2**63 - 1, 2**63 - 2),
        "unsigned": (pa.uint64(), 2**64 - 1, 2**64 - 2),
        "timestamp": (pa.timestamp("ns"), 2**60 + 2, 2**60 + 1),
        "timezone": (pa.timestamp("ns", tz="Europe/Berlin"), 2**60 + 2, 2**60 + 1),
        "duration": (pa.duration("ns"), 2**60 + 2, 2**60 + 1),
        "timestamp-minimum": (pa.timestamp("ns"), -(2**63) + 1, -(2**63)),
        "timezone-minimum": (pa.timestamp("ns", tz="UTC"), -(2**63) + 1, -(2**63)),
        "duration-minimum": (pa.duration("ns"), -(2**63) + 1, -(2**63)),
        "time": (pa.time64("ns"), 2**40 + 2, 2**40 + 1),
        "date": (pa.date64(), 172_800_000, 86_400_000),
        "dictionary": (pa.int64(), 2**63 - 1, 2**63 - 2),
    }[family]
    values: list[int | None] = [] if layout == "empty" else [None] * 4 if layout == "all-missing" else [high, low, high]
    if layout in {"nullable", "composite"}:
        values.append(None)
    array = pa.array(values, type=dtype)
    if family == "dictionary":
        array = array.dictionary_encode()
    source = pd.concat(
        [
            pd.Series(array, dtype=pd.ArrowDtype(array.type)),
            pd.Series([1] * len(values)),
            pd.Series(range(len(values))),
        ],
        axis=1,
    )
    source.columns = pd.Index([7, 7, "row"])
    source.index = pd.MultiIndex.from_tuples([("source", i % 2) for i in range(len(values))], names=["group", "row"])
    source.attrs = {"synthetic": "unchanged"}
    before = source.copy(deep=True)
    expected_rows = {
        "nullable": {"first": [0, 1, 3], "last": [1, 2, 3], "none": [1, 3]},
        "composite": {"first": [0, 1, 3], "last": [1, 2, 3], "none": [1, 3]},
        "present": {"first": [0, 1], "last": [1, 2], "none": [1]},
        "empty": {"first": [], "last": [], "none": []},
        "all-missing": {"first": [0], "last": [3], "none": []},
    }[layout][keep]
    engine = PandasEngine()
    schema = engine.schema(source)
    lineage = source_lineage(schema)
    operation = bind_step(
        step("dropDuplicates", columns=lineage[:2] if layout == "composite" else lineage[:1], keep=keep),
        schema,
        lineage,
    )
    for actual in [engine.apply_transform(source, operation), execute_generated(engine, source, operation)]:
        assert actual["row"].tolist() == expected_rows
        pd.testing.assert_frame_equal(actual, source.iloc[expected_rows], check_exact=True)
        assert actual.iloc[:, 0].array.__arrow_array__().equals(source.iloc[expected_rows, 0].array.__arrow_array__())
        assert actual.attrs == source.attrs
    pd.testing.assert_frame_equal(source, before, check_exact=True)
    assert source.iloc[:, 0].array.__arrow_array__().equals(before.iloc[:, 0].array.__arrow_array__())


@pytest.mark.parametrize(
    "family",
    [
        "integer",
        "unsigned",
        "timestamp",
        "timezone",
        "duration",
        "timestamp-minimum",
        "timezone-minimum",
        "duration-minimum",
        "time",
    ],
)
@pytest.mark.parametrize(
    "direction,nulls,expected_rows",
    [
        ("asc", "last", [1, 0, 2, 3]),
        ("desc", "last", [0, 2, 1, 3]),
        ("asc", "first", [3, 1, 0, 2]),
        ("desc", "first", [3, 0, 2, 1]),
    ],
)
def test_pandas_nullable_arrow_row_keys_keep_value_order(
    family: str, direction: str, nulls: str, expected_rows: list[int]
) -> None:
    import pyarrow as pa

    dtype, high = {
        "integer": (pa.int64(), 2**63 - 1),
        "unsigned": (pa.uint64(), 2**64 - 1),
        "timestamp": (pa.timestamp("ns"), 2**60 + 2),
        "timezone": (pa.timestamp("ns", tz="UTC"), 2**60 + 2),
        "duration": (pa.duration("ns"), 2**60 + 2),
        "timestamp-minimum": (pa.timestamp("ns"), -(2**63) + 1),
        "timezone-minimum": (pa.timestamp("ns", tz="UTC"), -(2**63) + 1),
        "duration-minimum": (pa.duration("ns"), -(2**63) + 1),
        "time": (pa.time64("ns"), 2**40 + 2),
    }[family]
    source = pd.DataFrame(
        {
            "key": pd.Series(pa.array([high, high - 1, high, None], type=dtype), dtype=pd.ArrowDtype(dtype)),
            "row": range(4),
        }
    )
    source.index = pd.Index([3, 1, 3, 2], name="source")
    engine = PandasEngine()
    operation = bound_step(
        "sortRows", rules=[{"column": bound_ref("c:source:0", "key", 0), "direction": direction, "nulls": nulls}]
    )
    for actual in [engine.apply_transform(source, operation), execute_generated(engine, source, operation)]:
        assert actual["row"].tolist() == expected_rows
        pd.testing.assert_frame_equal(actual, source.iloc[expected_rows], check_exact=True)


def test_pandas_duplicate_keys_preserve_object_missing_kinds() -> None:
    source = pd.DataFrame(
        {"key": pd.Series([None, float("nan"), pd.NA, "a", "a", None], dtype=object), "row": range(6)}
    )
    before = source.copy(deep=True)
    engine = PandasEngine()
    schema = engine.schema(source)
    lineage = source_lineage(schema)
    operation = bind_step(step("dropDuplicates", columns=lineage[:1], keep="first"), schema, lineage)
    for actual in [engine.apply_transform(source, operation), execute_generated(engine, source, operation)]:
        assert actual["row"].tolist() == [0, 1, 2, 3]
        pd.testing.assert_frame_equal(actual, source.iloc[[0, 1, 2, 3]])
    pd.testing.assert_frame_equal(source, before)


def test_pandas_optional_all_column_row_operations_exclude_no_visible_data() -> None:
    engine = PandasEngine()
    frame = pd.DataFrame(
        [[1, "a"], [1, "a"], [None, "b"]],
        columns=cast(Any, [7, "label"]),
    )
    missing = bound_step("dropMissingRows", columns=[], how="any")
    duplicates = bound_step("dropDuplicates", keep="first")

    transformed = engine.apply_transform(engine.apply_transform(frame, missing), duplicates)
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([missing, duplicates]), namespace, namespace)
    generated = namespace["clean_data"](frame)

    pd.testing.assert_frame_equal(transformed, generated)
    assert transformed.to_dict(orient="records") == [{7: 1.0, "label": "a"}]


def test_polars_all_column_row_operations_are_safe_for_a_zero_column_frame() -> None:
    engine = PolarsEngine()
    source = pl.DataFrame()
    runtime = engine.ensure_row_ids(source, "zero-columns")
    plan = [
        bound_step("dropMissingRows", columns=[], how="any"),
        bound_step("dropDuplicates", keep="first"),
    ]

    transformed = runtime
    for operation in plan:
        transformed = engine.apply_transform(transformed, operation)
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan(plan), namespace, namespace)
    generated = namespace["clean_data"](source)

    assert engine.shape(transformed) == {"rows": 0, "columns": 0}
    assert generated.shape == (0, 0)


@pytest.mark.parametrize("private_position", [0, 1, 3])
def test_pandas_one_hot_maps_visible_positions_once_per_operation(
    monkeypatch: pytest.MonkeyPatch, private_position: int
) -> None:
    engine = PandasEngine()
    source = pd.DataFrame(
        [["left-a", "u", 1], ["left-b", "v", 2]],
        columns=cast(Any, ["same", "same", 7]),
        index=pd.Index([7, 7], name="source_index"),
    )
    source.attrs = {"owned": "sentinel"}
    source_before = source.copy(deep=True)
    identified = engine.ensure_row_ids(source, "one-hot-map")
    row_id = engine.internal_row_id_column(identified)
    assert row_id is not None
    positions = list(range(3))
    positions.insert(private_position, 3)
    identified = identified.iloc[:, positions]
    before = identified.copy(deep=True)
    operation = bound_step(
        "oneHotEncode",
        columns=[bound_ref("c:source:2", "7", 2), bound_ref("c:source:1", "same", 1)],
        dropOriginal=True,
    )
    visible_positions = engine._visible_positions
    scans = 0

    def counted_visible_positions(frame: Any) -> list[int]:
        nonlocal scans
        scans += 1
        return visible_positions(frame)

    with monkeypatch.context() as context:
        context.setattr(engine, "_visible_positions", counted_visible_positions)
        actual = engine.apply_transform(identified, operation)
        assert scans == 1
        with pytest.raises(EngineError, match="outside its input schema"):
            engine._bound_frame_position(
                identified, operation["params"]["columns"][0], "oneHotEncode", visible_positions=[]
            )
        assert scans == 1

    generated = execute_generated(engine, source, operation)
    pd.testing.assert_frame_equal(actual.drop(columns=[row_id]), generated, check_exact=True)
    assert list(generated.columns) == ["same", "7_1", "7_2", "same_u", "same_v"]
    assert generated["same"].tolist() == ["left-a", "left-b"]
    assert generated["7_1"].tolist() == generated["same_u"].tolist() == [1, 0]
    assert generated["7_2"].tolist() == generated["same_v"].tolist() == [0, 1]
    assert actual.attrs == generated.attrs == source.attrs
    pd.testing.assert_series_equal(actual[row_id], before[row_id], check_exact=True)
    pd.testing.assert_frame_equal(identified, before, check_exact=True)

    empty_operation = bound_step("oneHotEncode", columns=[], dropOriginal=True)
    empty_selection = engine.apply_transform(identified, empty_operation)
    pd.testing.assert_frame_equal(empty_selection, before, check_exact=True)
    empty_generated = execute_generated(engine, source, empty_operation)
    pd.testing.assert_frame_equal(empty_selection.drop(columns=[row_id]), empty_generated, check_exact=True)
    assert empty_selection.attrs == empty_generated.attrs
    pd.testing.assert_frame_equal(source, source_before, check_exact=True)
    assert source.attrs == source_before.attrs
    assert identified.attrs == before.attrs


def test_categorical_encoders_ignore_missing_labels_and_match_generated_code(engine) -> None:
    if isinstance(engine, PandasEngine):
        one_hot_frame = pd.DataFrame(
            {
                "group": pd.Categorical(["a", None, "β", ""], categories=["a", "β", "", "unused"]),
                "value": [1, 2, 3, 4],
            }
        )
    else:
        one_hot_frame = pl.DataFrame({"group": ["a", None, "β", ""], "value": [1, 2, 3, 4]}).with_columns(
            pl.col("group").cast(pl.Categorical)
        )
    one_hot = bound_step(
        "oneHotEncode",
        columns=[bound_ref("c:source:0", "group", 0)],
        prefixSeparator="_",
        dropOriginal=False,
    )
    one_hot_result = engine.apply_transform(one_hot_frame, one_hot)
    one_hot_rows = records(one_hot_result)

    assert list(one_hot_rows[0]) == ["group", "value", "group_a", "group_β"]
    assert [row["group_a"] for row in one_hot_rows] == [1, 0, 0, 0]
    assert [row["group_β"] for row in one_hot_rows] == [0, 0, 1, 0]
    assert_records_equal(one_hot_result, execute_generated(engine, one_hot_frame, one_hot))

    scalar_frame = frame_for(
        engine,
        {
            "value": [1.0, float("nan"), None],
            "flag": [True, False, None],
            "day": [date(2024, 1, 2), date(2024, 1, 3), None],
        },
    )
    scalar_hot = bound_step(
        "oneHotEncode",
        columns=[
            bound_ref("c:source:2", "day", 2),
            bound_ref("c:source:1", "flag", 1),
            bound_ref("c:source:0", "value", 0),
        ],
        prefixSeparator="_",
        dropOriginal=False,
    )
    scalar_result = engine.apply_transform(scalar_frame, scalar_hot)
    assert list(records(scalar_result)[0]) == [
        "value",
        "flag",
        "day",
        "day_2024-01-02",
        "day_2024-01-03",
        "flag_False",
        "flag_True",
        "value_1.0",
    ]
    assert [row["value_1.0"] for row in records(scalar_result)] == [1, 0, 0]
    assert [row["flag_True"] for row in records(scalar_result)] == [1, 0, 0]
    assert [row["day_2024-01-03"] for row in records(scalar_result)] == [0, 1, 0]
    assert_records_equal(scalar_result, execute_generated(engine, scalar_frame, scalar_hot))

    ordering_frame = frame_for(engine, {"zeta": ["b", "a"], "alpha": ["y", "x"]})
    ordering = bound_step(
        "oneHotEncode",
        columns=[
            bound_ref("c:source:0", "zeta", 0),
            bound_ref("c:source:1", "alpha", 1),
        ],
        dropOriginal=False,
    )
    ordering_result = engine.apply_transform(ordering_frame, ordering)
    assert list(records(ordering_result)[0]) == ["zeta", "alpha", "alpha_x", "alpha_y", "zeta_a", "zeta_b"]
    assert_records_equal(ordering_result, execute_generated(engine, ordering_frame, ordering))

    if isinstance(engine, PandasEngine):
        labels_frame = pd.DataFrame(
            {
                "tags": pd.Categorical([None, "", "red|β", "β"]),
                "value": [1, 2, 3, 4],
            }
        )
    else:
        labels_frame = pl.DataFrame({"tags": [None, "", "red|β", "β"], "value": [1, 2, 3, 4]}).with_columns(
            pl.col("tags").cast(pl.Categorical)
        )
    labels = bound_step(
        "multiLabelBinarize",
        column=bound_ref("c:source:0", "tags", 0),
        delimiter="|",
        prefix="tag_",
        dropOriginal=False,
    )
    labels_result = engine.apply_transform(labels_frame, labels)
    label_rows = records(labels_result)

    assert list(label_rows[0]) == ["tags", "value", "tag_red", "tag_β"]
    assert [row["tag_red"] for row in label_rows] == [0, 0, 1, 0]
    assert [row["tag_β"] for row in label_rows] == [0, 0, 1, 1]
    assert_records_equal(labels_result, execute_generated(engine, labels_frame, labels))

    empty_labels_frame = frame_for(engine, {"tags": [None, ""], "value": [1, 2]})
    empty_result = engine.apply_transform(empty_labels_frame, labels)
    assert [list(row) for row in records(empty_result)] == [["tags", "value"], ["tags", "value"]]
    assert_records_equal(empty_result, execute_generated(engine, empty_labels_frame, labels))


@pytest.mark.parametrize("kind", ["oneHotEncode", "multiLabelBinarize"])
@pytest.mark.parametrize("missing_labels", [False, True])
@pytest.mark.parametrize("retained", [False, True])
@pytest.mark.parametrize("lazy", [False, True])
def test_polars_categorical_drop_matches_generated_on_public_source(kind, missing_labels, retained, lazy) -> None:
    engine = PolarsEngine()
    if kind == "oneHotEncode":
        values = ["a", None, "β", ""] if missing_labels else ["a", "b", "a"]
        operation = bound_step(kind, columns=[bound_ref("c:source:0", "category", 0)])
        labels = sorted({value for value in values if value})
        expected_values = {label: [int(value == label) for value in values] for label in labels}
    else:
        values = ["a|β", None, "β|β", "||"] if missing_labels else ["a|b", "b", "a"]
        operation = bound_step(kind, column=bound_ref("c:source:0", "category", 0), delimiter="|", dropOriginal=True)
        labels = sorted({label for value in values if value for label in value.split("|") if label})
        expected_values = {
            label: [int(value is not None and label in value.split("|")) for value in values] for label in labels
        }
    original = pl.DataFrame({"category": values})
    expected = pl.DataFrame(
        {f"category_{label}": pl.Series(indicators, dtype=pl.Int8) for label, indicators in expected_values.items()}
    )
    if retained:
        original = original.with_columns(pl.Series("retained", range(len(values))))
        expected = expected.select(pl.Series("retained", range(len(values))), pl.all())
    source = original.lazy() if lazy else original
    identified = engine.ensure_row_ids(source, "categorical-drop")
    row_id = engine.internal_row_id_column(identified)
    assert row_id is not None
    identified_before = identified.collect() if isinstance(identified, pl.LazyFrame) else identified

    live = engine.apply_transform(identified, operation)
    assert isinstance(live, pl.DataFrame)
    assert live[row_id].equals(identified_before[row_id])
    assert_polars_frame_equal(live.drop(row_id), expected)
    for result in (execute_generated(engine, source, operation), engine.apply_transform(source, operation)):
        assert isinstance(result, pl.DataFrame)
        assert_polars_frame_equal(result, expected)
    assert_polars_frame_equal(source.collect() if isinstance(source, pl.LazyFrame) else source, original)
    assert_polars_frame_equal(
        identified.collect() if isinstance(identified, pl.LazyFrame) else identified, identified_before
    )


@pytest.mark.parametrize("values", [[], [None, None], ["", "|", "||"], ["red||blue", "red|red", None]])
@pytest.mark.parametrize("lazy", [False, True])
def test_polars_multi_label_empty_and_repeated_labels_match_generated_code(values, lazy) -> None:
    runtime = PolarsEngine()
    original = pl.DataFrame({"tags": pl.Series(values, dtype=pl.String), "value": range(len(values))})
    source = original.lazy() if lazy else original
    operation = bound_step(
        "multiLabelBinarize",
        column=bound_ref("c:source:0", "tags", 0),
        delimiter="|",
        prefix="tag_",
        dropOriginal=True,
    )
    labels = sorted({label for value in values if value is not None for label in value.split("|") if label})
    for result in (runtime.apply_transform(source, operation), execute_generated(runtime, source, operation)):
        assert isinstance(result, pl.DataFrame)
        assert result.columns == ["value", *[f"tag_{label}" for label in labels]]
        assert result["value"].to_list() == list(range(len(values)))
        for label in labels:
            assert result[f"tag_{label}"].dtype == pl.Int8
            assert result[f"tag_{label}"].to_list() == [
                int(value is not None and label in value.split("|")) for value in values
            ]
    assert (source.collect() if isinstance(source, pl.LazyFrame) else source).equals(original)


@pytest.mark.parametrize(
    ("operation", "data", "message"),
    [
        (
            bound_step(
                "oneHotEncode",
                columns=[bound_ref("c:source:0", "group", 0)],
                prefixSeparator="_",
                dropOriginal=False,
            ),
            {"group": ["a"], "group_a": [7]},
            "One-hot encoding would create duplicate column names: group_a",
        ),
        (
            bound_step(
                "multiLabelBinarize",
                column=bound_ref("c:source:0", "tags", 0),
                delimiter="|",
                prefix="tag_",
                dropOriginal=False,
            ),
            {"tags": ["red"], "tag_red": [7]},
            "Multi-label binarization would create duplicate column names: tag_red",
        ),
    ],
)
def test_categorical_output_collisions_fail_before_creating_duplicate_columns(engine, operation, data, message) -> None:
    frame = frame_for(engine, data)

    with pytest.raises(EngineError, match=message):
        engine.apply_transform(frame, operation)
    with pytest.raises(ValueError, match=message):
        execute_generated(engine, frame, operation)


@pytest.mark.parametrize("early_collision", [False, True])
def test_pandas_one_hot_preflight_refusal_and_corrected_prefix(early_collision, monkeypatch) -> None:
    source = pd.DataFrame(
        {
            "first": pd.Categorical(["b", "a", None], categories=["unused", "b", "a"]),
            "second": ["b", "a", None],
            **({"first_a": [4, 5, 6]} if early_collision else {}),
            "second_a": [7, 8, 9],
        }
    )
    source.index = pd.Index([7, 7, 2], name="original-row")
    source.attrs = {"origin": "one-hot-source"}
    original = source.copy(deep=True)
    runtime = PandasEngine()
    operation = bound_step(
        "oneHotEncode",
        columns=[bound_ref("c:source:0", "first", 0), bound_ref("c:source:1", "second", 1)],
    )
    comparisons = []
    native_eq = pd.Series.eq

    def record_comparison(series, value, *args, **kwargs):
        comparisons.append(series.name)
        return native_eq(series, value, *args, **kwargs)

    monkeypatch.setattr(pd.Series, "eq", record_comparison)
    collision = "first_a" if early_collision else "second_a"
    expected_comparisons = [] if early_collision else ["first", "first"]
    with pytest.raises(EngineError, match=f"duplicate column names: {collision}") as live_error:
        runtime.apply_transform(source, operation)
    assert comparisons == expected_comparisons

    comparisons.clear()
    with pytest.raises(ValueError, match=f"duplicate column names: {collision}") as generated_error:
        execute_generated(runtime, source, operation)
    assert comparisons == expected_comparisons
    if early_collision:
        # Name validation stops at the first bad selected column.
        assert "second_a" not in str(live_error.value)
        assert "second_a" not in str(generated_error.value)

    operation = {**operation, "params": {**operation["params"], "prefixSeparator": "::"}}
    expected = original.drop(columns=["first", "second"])
    for name in ["first", "second"]:
        expected[f"{name}::a"] = pd.array([0, 1, 0], dtype="int8")
        expected[f"{name}::b"] = pd.array([1, 0, 0], dtype="int8")
    for result in (runtime.apply_transform(source, operation), execute_generated(runtime, source, operation)):
        pd.testing.assert_frame_equal(result, expected, check_exact=True)
        assert result.attrs == expected.attrs == source.attrs
    pd.testing.assert_frame_equal(source, original, check_exact=True)


@pytest.mark.parametrize("dtype", ["float32", "Float32"])
@pytest.mark.parametrize("retained", ["keep", "category_0.1", "category_0.10000000149011612"])
def test_pandas_one_hot_float_labels_match_live_formatting(dtype, retained) -> None:
    source = pd.DataFrame({"category": pd.Series([0.1, 0.2, None], dtype=dtype), retained: [7, 8, 9]})
    source.index = pd.Index([7, 7, 2], name="original-row")
    source.attrs = {"origin": "one-hot-float-source"}
    original = source.copy(deep=True)
    runtime = PandasEngine()
    operation = bound_step("oneHotEncode", columns=[bound_ref("c:source:0", "category", 0)])
    names = ["category_0.10000000149011612", "category_0.20000000298023224"]

    if retained == names[0]:
        with pytest.raises(EngineError, match="duplicate column names"):
            runtime.apply_transform(source, operation)
        with pytest.raises(ValueError, match="duplicate column names"):
            execute_generated(runtime, source, operation)
    else:
        expected = original.drop(columns=["category"])
        expected[names[0]] = pd.array([1, 0, 0], dtype="int8")
        expected[names[1]] = pd.array([0, 1, 0], dtype="int8")
        for result in (runtime.apply_transform(source, operation), execute_generated(runtime, source, operation)):
            pd.testing.assert_frame_equal(result, expected, check_exact=True)
            assert result.attrs == source.attrs
    pd.testing.assert_frame_equal(source, original, check_exact=True)


@pytest.mark.parametrize("case", ["duplicate", "private", "prior-column", "numeric-label", "native-and-collision"])
def test_pandas_one_hot_preflight_names_before_current_column_comparison(case, monkeypatch) -> None:
    if case == "duplicate":
        source = pd.DataFrame({"category": pd.Series([1, "1", None], dtype=object), "keep": [1, 2, 3]})
        message = "duplicate column names: category_1"
    elif case == "private":
        source = pd.DataFrame({"_": ["open_wrangler_internal_row_id_forged", None, ""], "keep": [1, 2, 3]})
        message = "reserved private row-identity column"
    elif case == "prior-column":
        source = pd.DataFrame({"a": ["b_c"] * 3, "a_b": ["c"] * 3, "keep": [1, 2, 3]})
        message = "duplicate column names: a_b_c"
    elif case == "numeric-label":
        source = pd.DataFrame({"": ["7"] * 3, 7: [1, 2, 3]})
        message = "duplicate column names: 7"
    else:
        source = pd.DataFrame({"category": pd.Series([("a", "b")] * 3, dtype=object), "category_('a', 'b')": [1, 2, 3]})
        message = "duplicate column names: category_"
    original = source.copy(deep=True)
    selected = 2 if case == "prior-column" else 1
    operation = bound_step(
        "oneHotEncode",
        columns=[bound_ref(f"c:source:{i}", str(name), i) for i, name in enumerate(source.columns[:selected])],
        prefixSeparator="" if case == "numeric-label" else "_",
    )
    expected_comparisons = ["a"] if case == "prior-column" else []
    comparisons = []
    native_eq = pd.Series.eq

    def record_comparison(series, value, *args, **kwargs):
        comparisons.append(series.name)
        return native_eq(series, value, *args, **kwargs)

    monkeypatch.setattr(pd.Series, "eq", record_comparison)
    with pytest.raises(EngineError, match=message):
        PandasEngine().apply_transform(source, operation)
    assert comparisons == expected_comparisons
    comparisons.clear()
    with pytest.raises(ValueError, match=message):
        execute_generated(PandasEngine(), source, operation)
    assert comparisons == expected_comparisons
    pd.testing.assert_frame_equal(source, original, check_exact=True)


@pytest.mark.parametrize("value", [("a", "b"), ["a", "b"]])
def test_pandas_one_hot_preflight_keeps_native_errors_for_available_names(value) -> None:
    source = pd.DataFrame({"category": pd.Series([value] * 3, dtype=object), "keep": [1, 2, 3]})
    original = source.copy(deep=True)
    operation = bound_step("oneHotEncode", columns=[bound_ref("c:source:0", "category", 0)])
    error, message = (ValueError, "Lengths must be equal") if isinstance(value, tuple) else (TypeError, "unhashable")
    with pytest.raises(error, match=message):
        PandasEngine().apply_transform(source, operation)
    with pytest.raises(error, match=message):
        execute_generated(PandasEngine(), source, operation)
    pd.testing.assert_frame_equal(source, original, check_exact=True)


def test_dynamic_categorical_outputs_cannot_enter_the_private_row_identity_namespace(engine) -> None:
    private_suffix = "open_wrangler_internal_row_id_forged"
    frame = frame_for(engine, {"tags": [private_suffix], "value": [1]})
    operation = bound_step(
        "multiLabelBinarize",
        column=bound_ref("c:source:0", "tags", 0),
        delimiter="|",
        prefix="__",
        dropOriginal=False,
    )

    with pytest.raises(EngineError, match="reserved private row-identity column"):
        engine.apply_transform(frame, operation)
    with pytest.raises(ValueError, match="reserved private row-identity column"):
        execute_generated(engine, frame, operation)


def test_pandas_multi_label_categorical_null_does_not_require_a_blank_category() -> None:
    engine = PandasEngine()
    frame = pd.DataFrame(
        {
            "tags": pd.Categorical(["red|β", None], categories=["red|β"]),
            "value": [1, 2],
        }
    )
    operation = bound_step(
        "multiLabelBinarize",
        column=bound_ref("c:source:0", "tags", 0),
        delimiter="|",
        prefix="tag_",
        dropOriginal=False,
    )

    transformed = engine.apply_transform(frame, operation)

    assert transformed["tag_red"].tolist() == [1, 0]
    assert transformed["tag_β"].tolist() == [1, 0]
    pd.testing.assert_frame_equal(transformed, execute_generated(engine, frame, operation))


def test_grouping_is_ordered_and_nullable_aggregations_match(engine) -> None:
    frame = frame_for(
        engine,
        {
            "group": ["b", "b", "a", "a", None, None],
            "value": [None, 2, None, 1, None, None],
            "text": [None, "B", "A", None, "Z", None],
        },
    )
    operation = bound_step(
        "groupBy",
        keys=[bound_ref("c:source:0", "group", 0)],
        aggregations=[
            {"column": bound_ref("c:source:1", "value", 1), "operation": "nUnique", "alias": "unique_values"},
            {"column": bound_ref("c:source:2", "text", 2), "operation": "first", "alias": "first_text"},
            {"column": bound_ref("c:source:2", "text", 2), "operation": "last", "alias": "last_text"},
            {"column": bound_ref("c:source:1", "value", 1), "operation": "count", "alias": "value_count"},
            {"column": bound_ref("c:source:1", "value", 1), "operation": "sum", "alias": "value_sum"},
        ],
    )

    transformed = engine.apply_transform(frame, operation)
    result = records(transformed)
    assert [normalized(row["group"]) for row in result] == ["b", "a", None]
    assert [
        {
            "unique_values": row["unique_values"],
            "first_text": normalized(row["first_text"]),
            "last_text": normalized(row["last_text"]),
            "value_count": row["value_count"],
            "value_sum": row["value_sum"],
        }
        for row in result
    ] == [
        {"unique_values": 1, "first_text": "B", "last_text": "B", "value_count": 1, "value_sum": 2},
        {"unique_values": 1, "first_text": "A", "last_text": "A", "value_count": 1, "value_sum": 1},
        {"unique_values": 0, "first_text": "Z", "last_text": "Z", "value_count": 0, "value_sum": 0},
    ]
    assert_records_equal(transformed, execute_generated(engine, frame, operation))


def test_group_aliases_are_unique_and_cannot_replace_keys() -> None:
    with pytest.raises(OperationError, match="aliases must be unique"):
        step(
            "groupBy",
            keys=[public_ref("c:source:0", "group")],
            aggregations=[
                {"column": public_ref("c:source:1", "value"), "operation": "sum", "alias": "result"},
                {"column": public_ref("c:source:1", "value"), "operation": "mean", "alias": "result"},
            ],
        )
    with pytest.raises(OperationError, match="cannot duplicate a group key"):
        step(
            "groupBy",
            keys=[public_ref("c:source:0", "group")],
            aggregations=[{"column": public_ref("c:source:1", "value"), "operation": "sum", "alias": "group"}],
        )


def test_grouping_treats_nan_as_missing_for_keys_and_every_aggregate(engine) -> None:
    frame = frame_for(
        engine,
        {
            "key": [None, float("nan"), 1.0, None, float("nan"), 1.0],
            "value": [None, float("nan"), 2.0, None, float("nan"), 3.0],
        },
    )
    value = bound_ref("c:source:1", "value", 1)
    operation = bound_step(
        "groupBy",
        keys=[bound_ref("c:source:0", "key", 0)],
        aggregations=[
            {"column": value, "operation": "sum", "alias": "total"},
            {"column": value, "operation": "mean", "alias": "average"},
            {"column": value, "operation": "min", "alias": "minimum"},
            {"column": value, "operation": "max", "alias": "maximum"},
            {"column": value, "operation": "median", "alias": "middle"},
            {"column": value, "operation": "count", "alias": "count"},
            {"column": value, "operation": "nUnique", "alias": "unique"},
            {"column": value, "operation": "first", "alias": "first"},
            {"column": value, "operation": "last", "alias": "last"},
        ],
    )

    transformed = engine.apply_transform(frame, operation)
    result = [{key: normalized(value) for key, value in row.items()} for row in records(transformed)]

    assert result == [
        {
            "key": None,
            "total": 0.0,
            "average": None,
            "minimum": None,
            "maximum": None,
            "middle": None,
            "count": 0,
            "unique": 0,
            "first": None,
            "last": None,
        },
        {
            "key": 1.0,
            "total": 5.0,
            "average": 2.5,
            "minimum": 2.0,
            "maximum": 3.0,
            "middle": 2.5,
            "count": 2,
            "unique": 2,
            "first": 2.0,
            "last": 3.0,
        },
    ]
    assert_records_equal(transformed, execute_generated(engine, frame, operation))


def test_grouping_emits_typed_nulls_without_erasing_a_computed_nan(engine) -> None:
    text_values = ["x", None, None, "z"]
    frame = frame_for(
        engine,
        {
            "group": ["a", "a", "b", None],
            "number": [float("inf"), float("-inf"), None, 2.0],
            "text": text_values,
        },
    )
    if isinstance(engine, PandasEngine):
        # Pandas 2.x inferred object here and failed native string min/max when
        # the group contained a missing value. Keep that boundary exercised
        # after Pandas 3 switched its default inference to StringDtype.
        frame.isetitem(2, pd.Series(text_values, dtype=object))
    number = bound_ref("c:source:1", "number", 1)
    text = bound_ref("c:source:2", "text", 2)
    operation = bound_step(
        "groupBy",
        keys=[bound_ref("c:source:0", "group", 0)],
        aggregations=[
            {"column": number, "operation": operation_name, "alias": f"number_{operation_name}"}
            for operation_name in ("mean", "median", "min", "max", "first", "last")
        ]
        + [
            {"column": text, "operation": operation_name, "alias": f"text_{operation_name}"}
            for operation_name in ("min", "max", "first", "last")
        ],
    )

    live = typed_records(engine, engine.apply_transform(frame, operation))
    generated = typed_records(engine, execute_generated(engine, frame, operation))

    assert live == generated
    by_group = {row["group"]["display"]: row for row in live}
    assert by_group[""]["group"]["kind"] == "null"
    assert by_group["a"]["number_mean"]["kind"] == "nan"
    for name, cell in by_group["b"].items():
        if name != "group":
            assert cell["kind"] == "null"


@pytest.mark.parametrize(
    ("program", "expected_kinds"),
    [
        (
            {"kind": "column", "column": bound_ref("c:source:0", "value", 0)},
            ["string", "null", "string"],
        ),
        (
            {
                "kind": "datetimeFormat",
                "input": {"kind": "column", "column": bound_ref("c:source:0", "value", 0)},
                "inputFormat": "%Y-%m-%d",
                "outputFormat": "%Y",
            },
            ["string", "null", "null"],
        ),
    ],
)
def test_by_example_string_and_datetime_results_use_typed_nulls(
    engine: PandasEngine | PolarsEngine,
    program: dict[str, Any],
    expected_kinds: list[str],
) -> None:
    frame = frame_for(engine, {"value": ["2024-01-02", None, "invalid"]})
    operation = bound_step(
        "byExample",
        sourceColumns=[bound_ref("c:source:0", "value", 0)],
        newColumn="result",
        examples=[],
        program=program,
    )

    live = typed_records(engine, engine.apply_transform(frame, operation))
    generated = typed_records(engine, execute_generated(engine, frame, operation))

    assert live == generated
    assert [row["result"]["kind"] for row in live] == expected_kinds


def test_pandas_grouping_targets_duplicate_and_non_string_labels_positionally() -> None:
    engine = PandasEngine()
    frame = pd.DataFrame(
        [
            ["ignored", "a", 1, 100],
            ["ignored", "a", 2, 200],
            ["ignored", "b", 3, 300],
            ["ignored", "b", 4, 400],
        ],
        columns=cast(Any, ["duplicate", "duplicate", 7, "metric"]),
    )
    operation = bound_step(
        "groupBy",
        keys=[bound_ref("c:source:1", "duplicate", 1)],
        aggregations=[
            {
                "column": bound_ref("c:source:2", "7", 2),
                "operation": "sum",
                "alias": "__ow_group_key_0",
            }
        ],
    )

    transformed = engine.apply_transform(frame, operation)

    assert list(transformed.columns) == ["duplicate", "__ow_group_key_0"]
    assert transformed.to_dict(orient="records") == [
        {"duplicate": "a", "__ow_group_key_0": 3},
        {"duplicate": "b", "__ow_group_key_0": 7},
    ]
    pd.testing.assert_frame_equal(transformed, execute_generated(engine, frame, operation))


@pytest.mark.parametrize(
    ("kind", "params", "message"),
    [
        (
            "oneHotEncode",
            {"columns": [public_ref("c:source:0", "group")], "dropOriginal": "yes"},
            "dropOriginal must be a boolean",
        ),
        (
            "multiLabelBinarize",
            {"column": public_ref("c:source:0", "tags"), "delimiter": "", "prefix": "tag_"},
            "delimiter must be a non-empty string",
        ),
        (
            "findReplace",
            {"column": public_ref("c:source:0", "text"), "find": 1, "replacement": "x"},
            "find and replacement must be strings",
        ),
        (
            "stripText",
            {"column": public_ref("c:source:0", "text"), "characters": ""},
            "characters must be a non-empty string or null",
        ),
        (
            "splitText",
            {
                "column": public_ref("c:source:0", "text"),
                "delimiter": "-",
                "index": True,
                "newColumn": "part",
            },
            "index must be a non-negative integer",
        ),
        (
            "roundNumber",
            {"column": public_ref("c:source:0", "value"), "decimals": True},
            "decimals must be an integer",
        ),
        (
            "formatDatetime",
            {"column": public_ref("c:source:0", "date"), "format": ""},
            "format must be a non-empty string",
        ),
        (
            "filterRows",
            {
                "filterModel": {
                    "filters": [
                        {
                            "column": {"id": "c:source:0", "name": "value"},
                            "type": "integer",
                            "predicates": [{"kind": "predicate", "operator": "between", "value": 1}],
                        }
                    ],
                    "sort": [],
                }
            },
            "between requires a secondValue",
        ),
        (
            "filterRows",
            {
                "filterModel": {
                    "filters": [
                        {
                            "column": {"id": "c:source:0", "name": "value"},
                            "type": "integer",
                            "predicates": [{"kind": "predicate", "operator": "mystery"}],
                        }
                    ],
                    "sort": [],
                }
            },
            "Unsupported filter operator",
        ),
    ],
)
def test_operation_parameters_are_rejected_before_engine_execution(kind, params, message) -> None:
    with pytest.raises(OperationError, match=message):
        step(kind, **params)


def test_unicode_text_operations_preserve_nulls_and_match_generated_code(engine) -> None:
    frame = frame_for(engine, {"text": ["straße", "İSTANBUL", "élAN", None]})
    operations = [
        bound_step("upperText", column=bound_ref("c:source:0", "text", 0), newColumn="upper"),
        bound_step("lowerText", column=bound_ref("c:source:0", "text", 0), newColumn="lower"),
        bound_step(
            "capitalizeText",
            column=bound_ref("c:source:0", "text", 0),
            newColumn="capitalized",
        ),
    ]
    transformed = frame
    for operation in operations:
        transformed = engine.apply_transform(transformed, operation)

    result = records(transformed)
    assert result[0]["upper"] == "STRASSE"
    assert result[1]["lower"] == "i̇stanbul"
    assert result[2]["capitalized"] == "Élan"
    assert normalized(result[3]["upper"]) is None

    namespace: dict[str, Any] = {}
    exec(engine.compile_plan(operations), namespace, namespace)
    assert_records_equal(transformed, namespace["clean_data"](frame))


def test_pandas_value_transforms_target_duplicate_and_non_string_labels_positionally() -> None:
    engine = PandasEngine()
    frame = pd.DataFrame(
        [
            ["élan", "red|blue", 1.2, "2024-01-02"],
            [None, "blue", 2.8, "2024-02-03"],
        ],
        columns=cast(Any, ["duplicate", "duplicate", 7, "when"]),
    )
    operations = [
        bound_step("upperText", column=bound_ref("c:source:0", "duplicate", 0)),
        bound_step(
            "multiLabelBinarize",
            column=bound_ref("c:source:1", "duplicate", 1),
            delimiter="|",
            prefix="tag_",
            dropOriginal=False,
        ),
        bound_step(
            "oneHotEncode",
            columns=[bound_ref("c:source:1", "duplicate", 1)],
            prefixSeparator="_",
            dropOriginal=False,
        ),
        bound_step("roundNumber", column=bound_ref("c:source:2", "7", 2)),
        bound_step(
            "formatDatetime",
            column=bound_ref("c:source:3", "when", 3),
            format="%Y/%m",
            newColumn="month",
        ),
    ]

    transformed = frame
    for operation in operations:
        transformed = engine.apply_transform(transformed, operation)
    namespace: dict[str, Any] = {}
    code = engine.compile_plan(operations)
    exec(code, namespace, namespace)
    generated = namespace["clean_data"](frame)

    pd.testing.assert_frame_equal(transformed, generated)
    assert transformed.iloc[0, 0] == "ÉLAN"
    assert pd.isna(transformed.iloc[1, 0])
    assert transformed.iloc[:, 1].tolist() == ["red|blue", "blue"]
    assert transformed.iloc[:, 2].tolist() == [1.0, 3.0]
    assert transformed["tag_red"].tolist() == [1, 0]
    assert transformed["duplicate_blue"].tolist() == [0, 1]
    assert transformed["month"].tolist() == ["2024/01", "2024/02"]
    assert "df.iloc[:, 0]" in code
    assert "df.iloc[:, 1]" in code
    assert "df.iloc[:, 2]" in code
    assert "df.iloc[:, 3]" in code
    assert list(frame.columns) == ["duplicate", "duplicate", 7, "when"]


def test_value_transforms_preserve_documented_coercive_inputs(engine) -> None:
    frame = frame_for(
        engine,
        {
            "text": [123, None],
            "number": ["1.2", "2.8"],
            "date": ["2024-01-02", "invalid"],
        },
    )
    operations = [
        bound_step("upperText", column=bound_ref("c:source:0", "text", 0), newColumn="upper"),
        bound_step(
            "roundNumber",
            column=bound_ref("c:source:1", "number", 1),
            decimals=0,
            newColumn="rounded",
        ),
        bound_step(
            "formatDatetime",
            column=bound_ref("c:source:2", "date", 2),
            format="%Y",
            newColumn="year",
        ),
    ]

    transformed = frame
    for operation in operations:
        transformed = engine.apply_transform(transformed, operation)

    result = records(transformed)
    assert result[0]["upper"] in {"123", "123.0"}
    assert normalized(result[1]["upper"]) is None
    assert result[0]["rounded"] == 1.0
    assert result[1]["rounded"] == 3.0
    assert result[0]["year"] == "2024"
    assert normalized(result[1]["year"]) is None
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan(operations), namespace, namespace)
    assert_records_equal(transformed, namespace["clean_data"](frame))


@pytest.mark.parametrize("lazy", [False, True], ids=["eager", "lazy"])
@pytest.mark.parametrize("replace", [False, True], ids=["append", "replace"])
@pytest.mark.parametrize(
    ("values", "dtype", "format", "expected"),
    [
        pytest.param(
            [
                datetime(2024, 1, 2, 8, 4, 5, tzinfo=timezone.utc),
                datetime(2024, 7, 2, 7, 4, 5, tzinfo=timezone.utc),
                None,
            ],
            pl.Datetime("us", "America/New_York"),
            "%Y-%m-%d %H:%M:%S %Z",
            ["2024-01-02 03:04:05 EST", "2024-07-02 03:04:05 EDT", None],
            id="timezone",
        ),
        pytest.param(
            [1700000000123456789, None],
            pl.Datetime("ns"),
            "%Y-%m-%d %H:%M:%S%.9f",
            ["2023-11-14 22:13:20.123456789", None],
            id="nanoseconds",
        ),
        pytest.param(
            [datetime(2024, 1, 2, 3, 4, 5, 123456), None],
            pl.Datetime("us"),
            "%Y-%m-%d %H:%M:%S%.6f",
            ["2024-01-02 03:04:05.123456", None],
            id="microseconds",
        ),
        pytest.param([date(2024, 1, 2), None], pl.Date, "%Y/%m/%d", ["2024/01/02", None], id="date"),
        pytest.param([None, None], pl.Datetime("ns", "UTC"), "%Y", [None, None], id="all-null"),
        pytest.param([], pl.Date, "%Y", [], id="empty-date"),
        pytest.param([], pl.Datetime("ns", "UTC"), "%Y", [], id="empty-datetime"),
        pytest.param(["2024-01-02", "invalid", None], pl.String, "%Y/%m/%d", ["2024/01/02", None, None], id="text"),
    ],
)
def test_polars_datetime_format_preserves_native_values_in_generated_code(
    lazy: bool, replace: bool, values: list[Any], dtype: Any, format: str, expected: list[str | None]
) -> None:
    engine = PolarsEngine()
    original = pl.DataFrame(
        {"when's value": pl.Series(values, dtype=dtype), "kept": list(reversed(range(len(values))))}
    )
    source = original.lazy() if lazy else original.clone()
    schema = engine.schema(source)
    lineage = source_lineage(schema)
    target = "when's value" if replace else "formatted"
    operation = bind_step(
        step("formatDatetime", column=lineage[0], format=format, **({} if replace else {"newColumn": target})),
        schema,
        lineage,
    )

    for result in (engine.apply_transform(source, operation), execute_generated(engine, source, operation)):
        assert isinstance(result, pl.LazyFrame) is lazy
        output = result.collect() if lazy else result
        assert output[target].to_list() == expected
        assert output["kept"].equals(original["kept"])
        assert output.columns == [*original.columns, *([] if replace else [target])]
        if not replace:
            assert output["when's value"].equals(original["when's value"])
        output_lineage = derive_lineage(lineage, engine.schema(result), operation)
        assert output_lineage[:2] == lineage
        if not replace:
            assert output_lineage[2]["id"] not in {column["id"] for column in lineage}
    unchanged = source.collect() if isinstance(source, pl.LazyFrame) else source
    assert unchanged.equals(original)


@pytest.mark.parametrize(
    ("replacement", "expected"),
    [
        ("\\", ["\\a\\b\\", "\\", None, "\\é\\🙂\\"]),
        (r"\1", [r"\1a\1b\1", r"\1", None, r"\1é\1🙂\1"]),
        ("$1", ["$1a$1b$1", "$1", None, "$1é$1🙂$1"]),
    ],
)
def test_empty_literal_find_replaces_text_boundaries_and_matches_generated_code(
    engine, replacement: str, expected: list[str | None]
) -> None:
    frame = frame_for(engine, {"text": ["ab", "", None, "é🙂"]})
    operation = bound_step(
        "findReplace",
        column=bound_ref("c:source:0", "text", 0),
        find="",
        replacement=replacement,
        regex=False,
        newColumn="expanded",
    )

    transformed = engine.apply_transform(frame, operation)

    assert [normalized(row["expanded"]) for row in records(transformed)] == expected
    assert_records_equal(transformed, execute_generated(engine, frame, operation))


def test_default_strip_normalizes_control_and_unicode_whitespace(engine) -> None:
    padded = "\t\n\r\v\f\u00a0\u2003X\t\n\r\v\f\u00a0\u2003"
    frame = frame_for(engine, {"text": [padded, None]})
    operation = bound_step(
        "stripText",
        column=bound_ref("c:source:0", "text", 0),
        newColumn="clean",
    )

    transformed = engine.apply_transform(frame, operation)

    assert records(transformed)[0]["clean"] == "X"
    assert normalized(records(transformed)[1]["clean"]) is None
    assert_records_equal(transformed, execute_generated(engine, frame, operation))


def test_custom_code_exceptions_are_structured_engine_errors(engine) -> None:
    frame = frame_for(engine, {"value": [1]})
    backend = "Pandas" if isinstance(engine, PandasEngine) else "Polars"

    with pytest.raises(EngineError, match=rf"Custom {backend} code failed: boom"):
        engine.apply_transform(frame, step("customCode", code="raise ValueError('boom')"))
    with pytest.raises(EngineError, match=rf"Custom {backend} code must assign"):
        engine.apply_transform(frame, step("customCode", code="result = 42"))


def floor_ceil_results(adapter: Any, source: Any, kind: str, replace: bool) -> tuple[Any, Any]:
    schema = adapter.schema(source)
    lineage = source_lineage(schema)
    operation = bind_step(
        step(kind, column=lineage[0], **({} if replace else {"newColumn": "integral"})), schema, lineage
    )
    results = (adapter.apply_transform(source, operation), execute_generated(adapter, source, operation))
    for result in results:
        assert derive_lineage(lineage, adapter.schema(result), operation)[: len(lineage)] == lineage
        if isinstance(source, pd.DataFrame):
            pd.testing.assert_index_equal(result.index, source.index)
        elif isinstance(source, pl.LazyFrame):
            assert isinstance(result, pl.LazyFrame)
    return results


@pytest.mark.parametrize("kind", ["floorNumber", "ceilNumber"])
@pytest.mark.parametrize("replace", [False, True])
@pytest.mark.parametrize("dtype", ["int64", "Int64", "int64[pyarrow]", "uint64[pyarrow]", "object"])
def test_pandas_floor_ceil_preserve_exact_integers(kind: str, replace: bool, dtype: str) -> None:
    values: list[Any] = [2**53 + 1, 2**53 + 3, 2**100 + 1] if dtype == "object" else [2**53 + 1, 2**53 + 3]
    if dtype != "int64":
        values.append(None)
    series = pd.Series(values, dtype=dtype, name="same")
    source = pd.concat([series, pd.Series(range(len(series)), name="same")], axis=1)
    source.index = pd.Index(["duplicate"] * len(source), name="source index")
    before = source.copy(deep=True)
    for result in floor_ceil_results(PandasEngine(), source, kind, replace):
        output = result.iloc[:, 0 if replace else -1]
        assert output.dropna().tolist() == source.iloc[:, 0].dropna().tolist()
        pd.testing.assert_series_equal(output, source.iloc[:, 0], check_names=replace)
        pd.testing.assert_series_equal(result.iloc[:, 1], source.iloc[:, 1])
    pd.testing.assert_frame_equal(source, before)


@pytest.mark.parametrize("kind, expected", [("floorNumber", [1, 0, -2, -1]), ("ceilNumber", [2, 1, -1, 0])])
@pytest.mark.parametrize("storage", ["object", "arrow128", "arrow256"])
@pytest.mark.parametrize("empty", [False, True])
def test_pandas_floor_ceil_decimal_values_and_nulls(kind: str, expected: list[int], storage: str, empty: bool) -> None:
    from decimal import Decimal, localcontext

    import pyarrow as pa

    values: list[Any] = [Decimal(text) for text in ["1.0000000000000000000000000001", "0.9999999999999999999999999999"]]
    values += [value.copy_negate() for value in values]
    values += [None]
    dtype = (
        object
        if storage == "object"
        else pd.ArrowDtype(pa.decimal128(38, 28) if storage == "arrow128" else pa.decimal256(76, 28))
    )
    source = pd.DataFrame({"value": pd.Series([] if empty else values, dtype=dtype)})
    before = source.copy(deep=True)
    with localcontext() as context:
        context.prec = 2
        for result in floor_ceil_results(PandasEngine(), source, kind, True):
            actual = result.iloc[:, 0].tolist()
            if empty:
                assert actual == []
            else:
                assert actual[:-1] == expected
                assert pd.isna(actual[-1])
            if storage != "object":
                assert result.iloc[:, 0].dtype.pyarrow_dtype.scale == 0
                result.iloc[:, 0].array.__arrow_array__().validate(full=True)
    pd.testing.assert_frame_equal(source, before)


@pytest.mark.parametrize("kind, finite", [("floorNumber", 1.0), ("ceilNumber", 2.0)])
@pytest.mark.parametrize("bits", [32, 64])
def test_pandas_floor_ceil_preserve_arrow_nan_validity(kind: str, finite: float, bits: int) -> None:
    from math import copysign

    import pyarrow as pa

    dtype = pa.float32() if bits == 32 else pa.float64()
    values = [None, float("nan"), 1.25, float("inf"), float("-inf"), -0.0]
    source = pd.DataFrame({"value": pd.arrays.ArrowExtensionArray(pa.array(values, type=dtype, from_pandas=False))})
    expected = pd.Series(
        pd.arrays.ArrowExtensionArray(pa.array([*values[:2], finite, *values[3:]], type=dtype, from_pandas=False)),
        name="integral",
    )
    for result in floor_ceil_results(PandasEngine(), source, kind, False):
        pd.testing.assert_series_equal(result["integral"], expected)
        assert result["integral"].isna().tolist() == [True, False, False, False, False, False]
        assert copysign(1, result["integral"].iloc[-1]) == -1
    assert source["value"].isna().tolist() == [True, False, False, False, False, False]


@pytest.mark.parametrize("kind", ["floorNumber", "ceilNumber"])
@pytest.mark.parametrize("lazy", [False, True])
@pytest.mark.parametrize("replace", [False, True])
@pytest.mark.parametrize("dtype", [pl.Int64, pl.UInt64, pl.Int128])
def test_polars_floor_ceil_preserve_exact_integer_type(kind: str, lazy: bool, replace: bool, dtype: Any) -> None:
    values = [2**53 + 1, 2**100 + 1 if dtype == pl.Int128 else 2**53 + 3, None]
    frame = pl.DataFrame({"value": pl.Series(values, dtype=dtype), "kept": [1, 2, 3]})
    source = frame.lazy() if lazy else frame
    for result in floor_ceil_results(PolarsEngine(), source, kind, replace):
        result = result.collect() if lazy else result
        output = result["value" if replace else "integral"]
        assert output.to_list() == values
        assert output.dtype == dtype
        assert result["kept"].to_list() == [1, 2, 3]
    assert frame["value"].to_list() == values


@pytest.mark.parametrize("kind, expected", [("floorNumber", [0, -1, None]), ("ceilNumber", [1, 0, None])])
@pytest.mark.parametrize("lazy", [False, True])
@pytest.mark.parametrize("scale", [28, 38])
def test_polars_floor_ceil_decimal_output_has_valid_capacity(
    kind: str, expected: list[int | None], lazy: bool, scale: int
) -> None:
    from decimal import Decimal

    value = Decimal("0." + "9" * scale)
    source = pl.DataFrame({"value": pl.Series([value, value.copy_negate(), None], dtype=pl.Decimal(38, scale))})
    before = source.clone()
    source = source.lazy() if lazy else source
    engine = PolarsEngine()
    with pl.Config(engine_affinity="streaming" if lazy else None):
        configuration = pl.Config.state()
        results = floor_ceil_results(engine, source, kind, False)
        engine.validate_transformation_result(results[0])
        assert pl.Config.state() == configuration
    for result in results:
        result = result.collect() if lazy else result
        assert result["integral"].to_list() == expected
        assert result["integral"].dtype == pl.Decimal(38, 0)
        result["integral"].to_arrow().validate(full=True)
    assert (source.collect() if isinstance(source, pl.LazyFrame) else source).equals(before)


@pytest.mark.parametrize("kind", ["floorNumber", "ceilNumber"])
@pytest.mark.parametrize(
    "scale, population", [(0, "values"), (1, "values"), (38, "values"), (38, "empty"), (38, "null")]
)
def test_polars_floor_ceil_decimal_intermediates_remain_valid_in_file_queries(
    tmp_path, kind: str, scale: int, population: str
) -> None:
    from decimal import ROUND_CEILING, ROUND_FLOOR, Context, Decimal

    from polars.testing import assert_frame_equal

    maximum = 10**38 - 1
    coefficients = [maximum, -maximum, 1, -1, 0]
    values = [Decimal((int(c < 0), tuple(map(int, str(abs(c)))), -scale)) for c in coefficients] + [None]
    if population != "values":
        values = [] if population == "empty" else [None, None]
    frame = pl.DataFrame({"value": pl.Series(values, dtype=pl.Decimal(38, scale)), "kept": range(len(values))})
    before = frame.clone()
    context = Context(prec=80, rounding=ROUND_FLOOR if kind == "floorNumber" else ROUND_CEILING)
    expected = [None if value is None else value.quantize(Decimal(1), context=context) for value in values]
    if population == "values":
        assert frame["value"].to_physical().dtype == pl.Int128
        assert frame["value"].to_physical().to_list() == [*coefficients, None]
    path = tmp_path / "integral.parquet"
    frame.write_parquet(path)
    source_bytes = path.read_bytes()
    for source in [frame, frame.lazy(), pl.scan_parquet(path)]:
        for result in floor_ceil_results(PolarsEngine(), source, kind, False):
            for mode in ("streaming", "in-memory"):
                actual = pl.collect_all([result], engine=mode)[0] if isinstance(result, pl.LazyFrame) else result
                assert actual["integral"].to_list() == expected
                assert actual["integral"].dtype == pl.Decimal(38, 0)
                actual["integral"].to_arrow().validate(full=True)
                assert_frame_equal(actual.select(frame.columns), before, check_exact=True)
    assert path.read_bytes() == source_bytes
    assert_frame_equal(frame, before, check_exact=True)


def _dictionary_numeric_buffers(series: pd.Series) -> list[Any]:
    return [
        (
            chunk.type,
            len(chunk),
            chunk.offset,
            len(chunk.dictionary),
            chunk.dictionary.offset,
            tuple(
                None if value is None else value.to_pybytes()
                for value in [*chunk.buffers(), *chunk.dictionary.buffers()]
            ),
        )
        for chunk in cast(Any, series.array).__arrow_array__().chunks
    ]


@pytest.fixture(params=["integer", "unsigned", "decimal", "float"])
def pandas_dictionary_numeric_source(request: pytest.FixtureRequest) -> pd.DataFrame:
    from decimal import Decimal

    pa = pytest.importorskip("pyarrow")
    dtype, values = {
        "integer": (pa.int64(), [2**53 + 1, None, -3, 2**53 + 1]),
        "unsigned": (pa.uint64(), [2**64 - 1, None, 2**53 + 1, 2**64 - 1]),
        "decimal": (pa.decimal128(30, 3), [Decimal("9007199254740993.125"), None, Decimal("-2.500"), None]),
        "float": (pa.float64(), [float("nan"), None, -0.0, float("inf"), float("-inf"), 3.5]),
    }[request.param]
    indices = pa.array([*range(len(values)), None], type=pa.int8())
    chunks = [
        pa.DictionaryArray.from_arrays(indices, pa.array(book, type=dtype), ordered=True)
        for book in (values, list(reversed(values)))
    ]
    selected = pd.Series(pd.arrays.ArrowExtensionArray(pa.chunked_array(chunks)))
    frame = pd.concat([pd.Series(range(len(selected))), selected, selected], axis=1)
    frame.columns = ["value", "value", "encoded companion"]
    frame.index = pd.MultiIndex.from_tuples([("same", i % 2) for i in range(len(frame))], names=["a", "b"])
    frame.attrs["annotation"] = "retained source"
    return frame


@pytest.mark.parametrize("kind", ["roundNumber", "floorNumber", "ceilNumber", "minMaxScale"])
@pytest.mark.parametrize("replace", [False, True])
def test_pandas_dictionary_numeric_operand_preserves_values_and_source(
    pandas_dictionary_numeric_source: pd.DataFrame, kind: str, replace: bool
) -> None:
    frame = pandas_dictionary_numeric_source
    runtime = PandasEngine()
    schema = runtime.schema(frame)
    lineage = source_lineage(schema)
    operation = bind_step(
        step(kind, column=lineage[1], **({} if replace else {"newColumn": "result"})), schema, lineage
    )
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    encoded = frame.iloc[:, 1].array.__arrow_array__()
    original_buffers = _dictionary_numeric_buffers(frame.iloc[:, 1])
    logical = frame.copy()
    logical.isetitem(1, frame.iloc[:, 1].astype(pd.ArrowDtype(encoded.type.value_type)))
    expected = runtime.apply_transform(logical, operation)
    output_position = 1 if replace else 3

    for actual in (runtime.apply_transform(frame, operation), execute_generated(runtime, frame, operation)):
        pd.testing.assert_series_equal(actual.iloc[:, output_position], expected.iloc[:, output_position])
        pd.testing.assert_series_equal(actual.iloc[:, 0], frame.iloc[:, 0])
        assert _dictionary_numeric_buffers(actual.iloc[:, 2]) == original_buffers
        if not replace:
            assert _dictionary_numeric_buffers(actual.iloc[:, 1]) == original_buffers
        for left, right in zip(actual.iloc[:, output_position], expected.iloc[:, output_position], strict=True):
            if isinstance(left, float) and left == 0:
                assert copysign(1, left) == copysign(1, right)
        result_lineage = derive_lineage(lineage, runtime.schema(actual), operation)
        assert result_lineage[:3] == lineage
        assert _dictionary_numeric_buffers(frame.iloc[:, 1]) == original_buffers
        assert frame.attrs == {"annotation": "retained source"}
        pd.testing.assert_index_equal(frame.index, logical.index)


@pytest.mark.parametrize("decimals", [-(10**12), 10**12])
def test_pandas_empty_dictionary_round_keeps_logical_native_type(
    pandas_dictionary_numeric_source: pd.DataFrame, decimals: int
) -> None:
    frame = pandas_dictionary_numeric_source.iloc[:0]
    runtime = PandasEngine()
    lineage = source_lineage(runtime.schema(frame))
    operation = bind_step(
        step("roundNumber", column=lineage[1], decimals=decimals, newColumn="result"), runtime.schema(frame), lineage
    )
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    value_type = frame.iloc[:, 1].dtype.pyarrow_dtype.value_type
    for actual in (runtime.apply_transform(frame, operation), execute_generated(runtime, frame, operation)):
        assert actual.empty
        assert actual.iloc[:, -1].dtype == pd.ArrowDtype(value_type)
        assert actual.iloc[:, 2].dtype == frame.iloc[:, 2].dtype
        pd.testing.assert_index_equal(actual.index, frame.index)


@pytest.mark.parametrize("operation", ["divide-left", "divide-right", "wide-odd-power"])
def test_pandas_dictionary_formula_uses_logical_operands(operation: str) -> None:
    pa = pytest.importorskip("pyarrow")
    right_column = operation == "divide-right"
    wide_power = operation == "wide-odd-power"
    array = pa.DictionaryArray.from_arrays(
        pa.array([0, 1, 2, None], type=pa.int8()), pa.array([-1, None, 1] if wide_power else [-3, None, 7])
    )
    frame = pd.DataFrame({"value": pd.arrays.ArrowExtensionArray(pa.chunked_array([array, array])), "other": 2})
    runtime = PandasEngine()
    schema = runtime.schema(frame)
    lineage = source_lineage(schema)
    params: dict[str, Any] = (
        {"leftColumn": lineage[1], "rightColumn": lineage[0]}
        if right_column
        else {"leftColumn": lineage[0], "value": 2}
    )
    if wide_power:
        params["value"] = str(2**64 - 1)
    bound = bind_step(
        step("formula", **params, operator="power" if wide_power else "divide", newColumn="result"), schema, lineage
    )
    runtime.validate_transform_preflight(frame, bound, runtime.shape(frame))
    logical = frame.copy()
    logical["value"] = logical["value"].astype("int64[pyarrow]")
    expected = (
        pd.Series([-1, None, 1, None] * 2, name="result", dtype="int64[pyarrow]")
        if wide_power
        else runtime.apply_transform(logical, bound)["result"]
    )
    for actual in (runtime.apply_transform(frame, bound), execute_generated(runtime, frame, bound)):
        pd.testing.assert_series_equal(actual["result"], expected)
        if not wide_power:
            assert actual["result"].iloc[0] == pytest.approx(-2 / 3 if right_column else -1.5)
        assert actual["value"].array.__arrow_array__().equals(cast(Any, frame["value"].array).__arrow_array__())


def test_pandas_dictionary_by_example_division_and_direct_copy_keep_their_result_types() -> None:
    pa = pytest.importorskip("pyarrow")
    array = pa.DictionaryArray.from_arrays(pa.array([0, 1, 2, None], type=pa.int8()), pa.array([2**53 + 1, None, -3]))
    frame = pd.DataFrame({"value": pd.arrays.ArrowExtensionArray(pa.chunked_array([array, array]))})
    runtime = PandasEngine()
    schema = runtime.schema(frame)
    lineage = source_lineage(schema)
    for examples in (
        [{"inputs": [2], "output": 1}, {"inputs": [6], "output": 3}],
        [{"inputs": [2], "output": 2}, {"inputs": [6], "output": 6}],
    ):
        operation = bind_step(
            step("byExample", sourceColumns=lineage, examples=examples, newColumn="result"), schema, lineage
        )
        runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
        copied = operation["params"]["program"]["kind"] == "column"
        for actual in (runtime.apply_transform(frame, operation), execute_generated(runtime, frame, operation)):
            if copied:
                assert (
                    actual["result"].array.__arrow_array__().equals(cast(Any, frame["value"].array).__arrow_array__())
                )
            else:
                expected = frame["value"].astype("int64[pyarrow]").astype("Float64") / 2
                pd.testing.assert_series_equal(actual["result"], expected.rename("result"))
                assert actual["result"].iloc[2] == -1.5
            assert actual["value"].array.__arrow_array__().equals(cast(Any, frame["value"].array).__arrow_array__())


def test_pandas_dictionary_numeric_plan_agrees_after_derived_column_binding() -> None:
    pa = pytest.importorskip("pyarrow")
    values = pa.DictionaryArray.from_arrays(pa.array([0, 1, 2, None], type=pa.int8()), pa.array([2**53 + 1, None, -15]))
    frame = pd.DataFrame({"value": pd.arrays.ArrowExtensionArray(pa.chunked_array([values, values]))})
    runtime = PandasEngine()
    source_array = cast(Any, frame["value"].array).__arrow_array__()
    live = frame
    logical = frame.astype({"value": "int64[pyarrow]"})
    lineage = source_lineage(runtime.schema(frame))
    plan = []
    for kind in ("roundNumber", "formula", "byExample"):
        params: dict[str, Any]
        if kind == "roundNumber":
            params = {"column": lineage[0], "decimals": -1, "newColumn": "rounded"}
        elif kind == "formula":
            params = {"leftColumn": lineage[1], "operator": "divide", "value": 2, "newColumn": "ratio"}
        else:
            params = {
                "sourceColumns": [lineage[0]],
                "newColumn": "inferred",
                "examples": [{"inputs": [2], "output": 1}, {"inputs": [6], "output": 3}],
            }
        operation = bind_step(step(kind, **params), runtime.schema(live), lineage)
        runtime.validate_transform_preflight(live, operation, runtime.shape(live))
        live = runtime.apply_transform(live, operation)
        logical = runtime.apply_transform(logical, operation)
        lineage = derive_lineage(lineage, runtime.schema(live), operation)
        plan.append(operation)
    namespace: dict[str, Any] = {}
    exec(runtime.compile_plan(plan), namespace)
    for actual in (live, namespace["clean_data"](frame)):
        pd.testing.assert_frame_equal(actual.iloc[:, 1:], logical.iloc[:, 1:])
        assert actual["value"].array.__arrow_array__().equals(source_array)
        assert cast(Any, frame["value"].array).__arrow_array__().equals(source_array)
    with pytest.raises(ColumnBindingError, match="collides"):
        bind_step(step("roundNumber", column=lineage[0], newColumn="ratio"), runtime.schema(live), lineage)


@pytest.mark.parametrize("bits", [8, 16, 32, 64])
@pytest.mark.parametrize("unsigned", [False, True])
def test_pandas_arrow_integer_modulo_preserves_exact_width_and_masks(bits: int, unsigned: bool) -> None:
    pa = pytest.importorskip("pyarrow")
    dtype = f"{'u' if unsigned else ''}int{bits}[pyarrow]"
    largest = 2**bits - 1 if unsigned else 2 ** (bits - 1) - 1
    values = [largest, 0, None, largest - 1]
    frame = pd.DataFrame({"value": pd.Series(values, dtype=dtype)})
    frame.index = pd.MultiIndex.from_tuples([("same", 2)] * len(frame), names=["group", "row"])
    frame.attrs = {"source": "retained"}
    before = frame.copy(deep=True)
    runtime = PandasEngine()
    lineage = source_lineage(runtime.schema(frame))
    operation = bind_step(
        step("formula", leftColumn=lineage[0], value=3, operator="modulo", newColumn="result"),
        runtime.schema(frame),
        lineage,
    )
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    expected = pd.Series(
        [None if value is None else value % 3 for value in values], index=frame.index, name="result", dtype=dtype
    )
    for actual in (runtime.apply_transform(frame, operation), execute_generated(runtime, frame, operation)):
        pd.testing.assert_series_equal(actual["result"], expected)
        pd.testing.assert_frame_equal(actual.iloc[:, :-1], before)
        assert pa.types.is_integer(actual["result"].dtype.pyarrow_dtype)
        pd.testing.assert_frame_equal(frame, before)


@pytest.mark.parametrize("native_dtype", ["int64", "Int64", "uint64", "UInt64"])
@pytest.mark.parametrize("arrow_on_right", [False, True])
def test_pandas_arrow_integer_modulo_accepts_native_selected_operands(native_dtype: str, arrow_on_right: bool) -> None:
    pytest.importorskip("pyarrow")
    unsigned = native_dtype.lower().startswith("u")
    native_values: list[int | None] = [2**64 - 1, 3, 7, 1] if unsigned else [-(2**63), -3, 7, 1]
    if native_dtype[0].isupper():
        native_values[-2] = None
    arrow_values = [-1, -7, 2**53 + 1, None]
    frame = pd.DataFrame(
        {
            "native": pd.Series(native_values, dtype=native_dtype),
            "arrow": pd.Series(arrow_values, dtype="int64[pyarrow]"),
        }
    )
    frame.index = pd.Index(["same"] * len(frame), name="source")
    before = frame.copy(deep=True)
    runtime = PandasEngine()
    lineage = source_lineage(runtime.schema(frame))
    left, right = (0, 1) if arrow_on_right else (1, 0)
    operation = bind_step(
        step("formula", leftColumn=lineage[left], rightColumn=lineage[right], operator="modulo", newColumn="result"),
        runtime.schema(frame),
        lineage,
    )
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    pairs = (
        zip(native_values, arrow_values, strict=True)
        if arrow_on_right
        else zip(arrow_values, native_values, strict=True)
    )
    values = [None if a is None or b is None else a % b for a, b in pairs]
    dtype = "uint64[pyarrow]" if unsigned and not arrow_on_right else "int64[pyarrow]"
    expected = pd.Series(values, index=frame.index, name="result", dtype=dtype)
    for actual in (runtime.apply_transform(frame, operation), execute_generated(runtime, frame, operation)):
        pd.testing.assert_series_equal(actual["result"], expected)
        pd.testing.assert_frame_equal(actual.iloc[:, :-1], before)
        pd.testing.assert_frame_equal(frame, before)


@pytest.mark.parametrize(
    "dtype,values,divisor,result_dtype",
    [
        ("int8[pyarrow]", [-127, 127, None], 256, "int64[pyarrow]"),
        ("uint64[pyarrow]", [2**64 - 1, 2**53 + 1, None], -3, "int64[pyarrow]"),
        ("int64[pyarrow]", [-(2**63), 2**53 + 1, None], -1, "int64[pyarrow]"),
        ("int64[pyarrow]", [-1, -(2**63), None], 2**64 - 1, "uint64[pyarrow]"),
        ("uint8[pyarrow]", [0, 255, None], -129, "int64[pyarrow]"),
    ],
)
def test_pandas_arrow_integer_modulo_scalar_capacity(dtype, values, divisor, result_dtype) -> None:
    pytest.importorskip("pyarrow")
    frame = pd.DataFrame({"value": pd.Series(values, dtype=dtype)})
    before = frame.copy(deep=True)
    runtime = PandasEngine()
    lineage = source_lineage(runtime.schema(frame))
    operation = bind_step(
        step("formula", leftColumn=lineage[0], value=divisor, operator="modulo", newColumn="result"),
        runtime.schema(frame),
        lineage,
    )
    expected = pd.Series(
        [None if value is None else value % divisor for value in values], name="result", dtype=result_dtype
    )
    for actual in (runtime.apply_transform(frame, operation), execute_generated(runtime, frame, operation)):
        pd.testing.assert_series_equal(actual["result"], expected)
        pd.testing.assert_frame_equal(frame, before)


@pytest.mark.parametrize("values,divisors", [([], []), ([None, None], [0, None]), ([7, None], [None, 0])])
def test_pandas_arrow_integer_modulo_missing_pairs_do_not_divide_by_zero(values, divisors) -> None:
    pytest.importorskip("pyarrow")
    frame = pd.DataFrame(
        {"value": pd.Series(values, dtype="int64[pyarrow]"), "divisor": pd.Series(divisors, dtype="uint64[pyarrow]")}
    )
    runtime = PandasEngine()
    lineage = source_lineage(runtime.schema(frame))
    operation = bind_step(
        step("formula", leftColumn=lineage[0], rightColumn=lineage[1], operator="modulo", newColumn="result"),
        runtime.schema(frame),
        lineage,
    )
    for actual in (runtime.apply_transform(frame, operation), execute_generated(runtime, frame, operation)):
        pd.testing.assert_series_equal(
            actual["result"], pd.Series([None] * len(frame), dtype="uint64[pyarrow]", name="result")
        )


@pytest.mark.parametrize("divisor,message", [(0, "nonzero"), (2**64, "64-bit"), (-(2**63) - 1, "64-bit")])
def test_pandas_arrow_integer_modulo_refuses_invalid_present_divisors(divisor: int, message: str) -> None:
    pytest.importorskip("pyarrow")
    frame = pd.DataFrame({"value": pd.Series([7, None], dtype="uint64[pyarrow]")})
    before = frame.copy(deep=True)
    runtime = PandasEngine()
    lineage = source_lineage(runtime.schema(frame))
    operation = bind_step(
        step("formula", leftColumn=lineage[0], value=divisor, operator="modulo", newColumn="result"),
        runtime.schema(frame),
        lineage,
    )
    for run in (
        lambda: runtime.apply_transform(frame, operation),
        lambda: execute_generated(runtime, frame, operation),
    ):
        with pytest.raises((EngineError, ValueError), match=message):
            run()
        pd.testing.assert_frame_equal(frame, before)


def test_pandas_dictionary_integer_modulo_uses_logical_values() -> None:
    pa = pytest.importorskip("pyarrow")
    array = pa.DictionaryArray.from_arrays(
        pa.array([0, 1, 2, None], type=pa.int8()), pa.array([2**64 - 1, None, 7], type=pa.uint64())
    )
    frame = pd.DataFrame({"value": pd.arrays.ArrowExtensionArray(pa.chunked_array([array, array]))})
    runtime = PandasEngine()
    lineage = source_lineage(runtime.schema(frame))
    operation = bind_step(
        step("formula", leftColumn=lineage[0], value=3, operator="modulo", newColumn="result"),
        runtime.schema(frame),
        lineage,
    )
    for actual in (runtime.apply_transform(frame, operation), execute_generated(runtime, frame, operation)):
        pd.testing.assert_series_equal(
            actual["result"], pd.Series([0, None, 1, None] * 2, dtype="uint64[pyarrow]", name="result")
        )
        assert actual["value"].array.__arrow_array__().equals(pa.chunked_array([array, array]))


@pytest.mark.parametrize("dtype", ["int64", "Int64", "uint64", "UInt64", "float64"])
@pytest.mark.parametrize("zero_divisor", [False, True])
def test_pandas_ordinary_modulo_keeps_native_behavior(dtype: str, zero_divisor: bool) -> None:
    frame = pd.DataFrame(
        {
            "value": pd.Series([7, 2**53 + 1], dtype=dtype),
            "divisor": pd.Series([0 if zero_divisor else 3, 7], dtype=dtype),
        }
    )
    runtime = PandasEngine()
    lineage = source_lineage(runtime.schema(frame))
    operation = bind_step(
        step("formula", leftColumn=lineage[0], rightColumn=lineage[1], operator="modulo", newColumn="result"),
        runtime.schema(frame),
        lineage,
    )
    expected = (frame["value"] % frame["divisor"]).rename("result")
    for actual in (runtime.apply_transform(frame, operation), execute_generated(runtime, frame, operation)):
        pd.testing.assert_series_equal(actual["result"], expected)


@pytest.mark.parametrize(
    ("dtype", "values", "operator", "right_dtype", "right", "expected", "result_dtype"),
    [
        ("int8", [127, 0, -128], "add", "int8", [1, 127, -1], None, None),
        ("Int8", [127, None], "add", None, 1, None, None),
        ("Int64", [2**63 - 1, None], "add", None, 1, None, None),
        ("UInt64", [0, None], "subtract", None, 1, None, None),
        ("int64", [2**62], "multiply", None, 4, None, None),
        ("Int64", [2**32, None], "power", None, 2, None, None),
        ("Int64", [-2, -2, None], "power", "Int64", [63, 64, 2], None, None),
        ("uint8", [255, 0], "add", "bool", [True, False], None, None),
        (pd.SparseDtype("int8", 0), [127, 0], "add", None, 1, None, None),
        ("Int64", [-1, 1, None], "add", "UInt64", [2**63 + 1, 2**63, None], None, None),
        ("UInt64", [2**64 - 1, 2**64 - 1], "subtract", "Int64", [-1, 0], None, None),
        ("Int64", [1, 2], "multiply", "UInt64", [2**63 + 1, 2**62], None, None),
        ("Int64", [-2, 3], "power", "UInt64", [3, 34], None, None),
        ("Int64", [-1], "power", "UInt64", [2**64 - 1], None, None),
        ("UInt64", [4, 3], "power", "Int64", [-1, 34], None, None),
        ("Int64", [2], "power", None, 10**9, None, None),
        ("Int8", [127, -128, None], "add", "Int16", [1, -1, None], [128, -129, None], "Int16"),
        ("int8", [127, -128], "add", "int8", [-128, 127], [-1, -1], "int8"),
        ("UInt8", [254, 0, None], "add", "boolean", [True, False, True], [255, 0, None], "UInt8"),
        ("boolean", [True, False], "multiply", "Int8", [127, None], [127, None], "Int8"),
        ("boolean", [True, False], "add", "boolean", [True, True], [True, True], "boolean"),
        (pd.SparseDtype("int8", 0), [126, 0], "add", None, 1, [127, 1], pd.SparseDtype("int8", 1)),
        ("Int64", [None, 2**63 - 1], "add", "Int64", [1, None], [None, None], "Int64"),
        ("Int64", [None, None], "multiply", "UInt64", [2**64 - 1, 2**63 + 1], [None, None], "Float64"),
        ("Int8", [], "add", None, 1, [], "Int8"),
        ("Int8", [None], "add", None, 1, [None], "Int8"),
        ("Int64", [1, None, 0], "power", "Int64", [None, 0, 0], [1, 1, 1], "Int64"),
        ("Int64", [0, 1, -1], "power", None, 10**9, [0, 1, 1], "Int64"),
        ("Int64", [-2, 2], "power", "Int64", [63, 62], [-(2**63), 2**62], "Int64"),
        ("Int64", [-1, 2048], "add", "UInt64", [2**63 + 1, 2**63], [2**63, 2**63 + 2048], "Float64"),
        ("UInt64", [4, None], "power", "Int64", [-1, -1], [0.25, None], "Float64"),
        ("Int64", [4, None], "power", None, -0.5, [0.5, None], "Float64"),
        ("Int8", [127, None], "add", None, 1.0, [128.0, None], "Float64"),
    ],
)
def test_pandas_formula_integer_results_retain_native_values_or_refuse(
    dtype: Any,
    values: list[Any],
    operator: str,
    right_dtype: Any,
    right: Any,
    expected: list[Any] | None,
    result_dtype: Any,
) -> None:
    runtime = PandasEngine()
    frame = pd.DataFrame({"value": pd.Series(values, dtype=dtype)})
    if right_dtype is not None:
        frame["other"] = pd.Series(right, dtype=right_dtype)
    frame.index = pd.Index(["same"] * len(frame), name="source rows")
    frame.attrs = {"source": "retained"}
    original = frame.copy(deep=True)
    lineage = source_lineage(runtime.schema(frame))
    operation = bind_step(
        step(
            "formula",
            leftColumn=lineage[0],
            operator=operator,
            newColumn="result",
            **({"rightColumn": lineage[1]} if right_dtype is not None else {"value": right}),
        ),
        runtime.schema(frame),
        lineage,
    )
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    for generated in (False, True):
        if expected is None:
            with pytest.raises(ValueError if generated else EngineError, match="exact integer result"):
                execute_generated(runtime, frame, operation) if generated else runtime.apply_transform(frame, operation)
        else:
            actual = (
                execute_generated(runtime, frame, operation) if generated else runtime.apply_transform(frame, operation)
            )
            pd.testing.assert_series_equal(
                actual["result"],
                pd.Series(expected, index=frame.index, name="result", dtype=result_dtype),
                rtol=0,
                atol=0,
            )
            pd.testing.assert_frame_equal(actual.loc[:, original.columns], original)
        pd.testing.assert_frame_equal(frame, original)
        assert frame.attrs == original.attrs


@pytest.mark.parametrize("overflow", [False, True])
def test_pandas_formula_sparse_missing_fill_preserves_exact_unsigned_payloads(overflow: bool) -> None:
    import numpy as np

    runtime = PandasEngine()
    value = 2**64 - (1 if overflow else 2)
    array = pd.arrays.SparseArray(np.array([np.nan, value], dtype=object), dtype=pd.SparseDtype("uint64", np.nan))
    frame = pd.DataFrame({"value": array})
    original = frame.copy(deep=True)
    assert int(array.sp_values[0]) == value
    lineage = source_lineage(runtime.schema(frame))
    operation = bind_step(
        step("formula", leftColumn=lineage[0], operator="add", value=1, newColumn="result"),
        runtime.schema(frame),
        lineage,
    )
    for generated in (False, True):
        if overflow:
            with pytest.raises(ValueError if generated else EngineError, match="exact integer result"):
                execute_generated(runtime, frame, operation) if generated else runtime.apply_transform(frame, operation)
        else:
            actual = (
                execute_generated(runtime, frame, operation) if generated else runtime.apply_transform(frame, operation)
            )
            assert actual["result"].dtype == pd.SparseDtype("uint64", np.nan)
            assert actual["result"].isna().tolist() == [True, False]
            assert int(actual["result"].array.sp_values[0]) == 2**64 - 1
        pd.testing.assert_frame_equal(frame, original)


@pytest.mark.parametrize(
    ("dtype", "operator", "value", "error"),
    [("Int64", "power", -1, ValueError), ("int8", "add", 256, OverflowError)],
)
def test_pandas_formula_integer_guard_retains_native_refusals(
    dtype: str, operator: str, value: int, error: type[Exception]
) -> None:
    runtime = PandasEngine()
    frame = pd.DataFrame({"value": pd.Series([2], dtype=dtype)})
    lineage = source_lineage(runtime.schema(frame))
    operation = bind_step(
        step("formula", leftColumn=lineage[0], operator=operator, value=value, newColumn="result"),
        runtime.schema(frame),
        lineage,
    )
    for generated in (False, True):
        with pytest.raises(error):
            execute_generated(runtime, frame, operation) if generated else runtime.apply_transform(frame, operation)


@pytest.mark.parametrize("operator,value", [("multiply", 3), ("power", 2)])
def test_pandas_arrow_other_formula_overflow_stays_checked(operator: str, value: int) -> None:
    pa = pytest.importorskip("pyarrow")
    frame = pd.DataFrame({"value": pd.Series([2**63 - 1, None], dtype="int64[pyarrow]")})
    runtime = PandasEngine()
    lineage = source_lineage(runtime.schema(frame))
    operation = bind_step(
        step("formula", leftColumn=lineage[0], value=value, operator=operator, newColumn="result"),
        runtime.schema(frame),
        lineage,
    )
    for run in (
        lambda: runtime.apply_transform(frame, operation),
        lambda: execute_generated(runtime, frame, operation),
    ):
        with pytest.raises(pa.ArrowInvalid, match="overflow"):
            run()


@pytest.mark.parametrize("operator", ["add", "subtract", "multiply", "divide"])
def test_pandas_arrow_by_example_arithmetic_retains_live_generated_agreement(operator: str) -> None:
    import operator as arithmetic

    pytest.importorskip("pyarrow")
    function = getattr(arithmetic, {"add": "add", "subtract": "sub", "multiply": "mul", "divide": "truediv"}[operator])
    frame = pd.DataFrame(
        {
            "value": pd.Series([2, 5, 9, None], dtype="int64[pyarrow]"),
            "other": pd.Series([7, 3, 4, 2], dtype="int64[pyarrow]"),
        }
    )
    runtime = PandasEngine()
    lineage = source_lineage(runtime.schema(frame))
    operation = bind_step(
        step(
            "byExample",
            sourceColumns=lineage,
            newColumn="result",
            examples=[{"inputs": [a, b], "output": function(a, b)} for a, b in ((2, 7), (5, 3), (9, 4))],
        ),
        runtime.schema(frame),
        lineage,
    )
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    live = runtime.apply_transform(frame, operation)
    pd.testing.assert_frame_equal(execute_generated(runtime, frame, operation), live)
    assert live["result"].dropna().tolist() == [function(a, b) for a, b in ((2, 7), (5, 3), (9, 4))]


@pytest.mark.parametrize("family", ["floating", "decimal", "floating-divisor"])
def test_pandas_noninteger_arrow_modulo_keeps_native_refusal(family: str) -> None:
    from decimal import Decimal

    pa = pytest.importorskip("pyarrow")
    if family == "decimal":
        series = pd.Series([Decimal("7.5"), None], dtype=pd.ArrowDtype(pa.decimal128(3, 1)))
    else:
        series = pd.Series([7, None], dtype="double[pyarrow]" if family == "floating" else "int64[pyarrow]")
    frame = pd.DataFrame({"value": series})
    before = frame.copy(deep=True)
    runtime = PandasEngine()
    lineage = source_lineage(runtime.schema(frame))
    operation = bind_step(
        step(
            "formula",
            leftColumn=lineage[0],
            value=2.0 if family == "floating-divisor" else 2,
            operator="modulo",
            newColumn="result",
        ),
        runtime.schema(frame),
        lineage,
    )
    for run in (
        lambda: runtime.apply_transform(frame, operation),
        lambda: execute_generated(runtime, frame, operation),
    ):
        with pytest.raises(NotImplementedError):
            run()
        pd.testing.assert_frame_equal(frame, before)


@pytest.mark.parametrize(
    "values,operator,literal,expected",
    [
        ([2**64 - 1, 2**64 - 2, None], "add", 0, [2**64 - 1, 2**64 - 2, None]),
        ([2**64 - 1, 2**64 - 2, None], "subtract", 2, [2**64 - 3, 2**64 - 4, None]),
        ([2**64 - 1, 2**64 - 2, None], "multiply", 0, [0, 0, None]),
        ([2**64 - 1, 2**64 - 2, None], "power", 1, [2**64 - 1, 2**64 - 2, None]),
        ([0, 1, None], "multiply", str(2**64 - 1), [0, 2**64 - 1, None]),
        ([0, 1, None], "power", str(2**64 - 1), [0, 1, None]),
        ([2**64 - 1, 1, None], "add", "-1", [2**64 - 2, 0, None]),
        ([2**64 - 2, 0, None], "subtract", "-1", [2**64 - 1, 1, None]),
        ([2**64 - 1, 2**64 - 1, None], "add", str(-(2**64 - 1)), [0, 0, None]),
        ([0, 3, None], "subtract", str(-(2**63)), [2**63, 2**63 + 3, None]),
        ([], "add", str(-(2**64 - 1)), []),
        ([None, None], "add", str(-(2**64 - 1)), [None, None]),
    ],
)
def test_pandas_arrow_formula_capacity_repairs_unsigned_scalars(values, operator, literal, expected) -> None:
    pa = pytest.importorskip("pyarrow")
    frame = pd.DataFrame({"value": pd.Series(values, dtype="uint64[pyarrow]")})
    frame.index = pd.MultiIndex.from_tuples([("same", 2)] * len(frame), names=["group", "row"])
    frame.attrs = {"source": "retained"}
    before = frame.copy(deep=True)
    runtime = PandasEngine()
    lineage = source_lineage(runtime.schema(frame))
    operation = bind_step(
        step("formula", leftColumn=lineage[0], value=literal, operator=operator, newColumn="result"),
        runtime.schema(frame),
        lineage,
    )
    assert operation["params"]["value"] == literal
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    for actual in (runtime.apply_transform(frame, operation), execute_generated(runtime, frame, operation)):
        pd.testing.assert_series_equal(
            actual["result"], pd.Series(expected, index=frame.index, name="result", dtype="uint64[pyarrow]")
        )
        actual["result"].array.__arrow_array__().validate(full=True)
        assert actual["result"].dtype == pd.ArrowDtype(pa.uint64())
        pd.testing.assert_frame_equal(actual.iloc[:, :-1], before)
        pd.testing.assert_frame_equal(frame, before)


@pytest.mark.parametrize(
    "operator,left_dtype,left_values,right_dtype,right_values,output_dtype,expected",
    [
        ("multiply", *case)
        for case in [
            ("uint64[pyarrow]", [0, 2**63, None], None, "-1", "int64[pyarrow]", [0, -(2**63), None]),
            ("int64[pyarrow]", [-(2**63), -1, None], None, "-1", "uint64[pyarrow]", [2**63, 1, None]),
            ("int64[pyarrow]", [2**63 - 1, 0, None], None, "2", "uint64[pyarrow]", [2**64 - 2, 0, None]),
            ("int8[pyarrow]", [-100, 3, None], "int8[pyarrow]", [-2, 2, None], "int64[pyarrow]", [200, 6, None]),
            ("uint64[pyarrow]", [0, 2**64 - 1, None], "int16", [-1, 1, -2], "uint64[pyarrow]", [0, 2**64 - 1, None]),
            ("int64", [-1, 1, 0], "uint64[pyarrow]", [0, 2**64 - 1, None], "uint64[pyarrow]", [0, 2**64 - 1, None]),
            ("UInt64", [0, 2**63, None], "int64[pyarrow]", [-2, -1, None], "int64[pyarrow]", [0, -(2**63), None]),
            ("uint64", [0, 2**63, 0], "int64[pyarrow]", [-2, -1, None], "int64[pyarrow]", [0, -(2**63), None]),
            ("uint64[pyarrow]", [0, 2**64 - 1, None], "Int8", [-2, None, -1], "int64[pyarrow]", [0, None, None]),
            ("uint64[pyarrow]", [3, 2, None], "uint64[pyarrow]", [2, 3, None], "uint64[pyarrow]", [6, 6, None]),
            ("uint64[pyarrow]", [], None, "-1", "int64[pyarrow]", []),
            ("uint64[pyarrow]", [None, None], None, "-1", "int64[pyarrow]", [None, None]),
            ("uint64[pyarrow]", [1, 2**64 - 1], "int64[pyarrow]", [-1, 1], None, None),
            ("int64[pyarrow]", [0, -(2**63)], None, "2", None, None),
        ]
    ]
    + [
        ("add", *case)
        for case in [
            ("int64[pyarrow]", [2**63 - 1, 0, None], None, "1", "uint64[pyarrow]", [2**63, 1, None]),
            (
                "int64[pyarrow]",
                [2**63 - 1, 4, None],
                "int64[pyarrow]",
                [1, -1, None],
                "uint64[pyarrow]",
                [2**63, 3, None],
            ),
            ("int8[pyarrow]", [-128, 0, None], "int8[pyarrow]", [-1, 1, None], "int64[pyarrow]", [-129, 1, None]),
            ("int16[pyarrow]", [32767, 3, None], "Int16", [1, -1, None], "int64[pyarrow]", [32768, 2, None]),
            ("int32", [2**31 - 1, 3, 0], "int32[pyarrow]", [1, -1, None], "int64[pyarrow]", [2**31, 2, None]),
            ("Int64", [2**63 - 1, 4, None], "int64[pyarrow]", [1, -1, None], "uint64[pyarrow]", [2**63, 3, None]),
            ("int64[pyarrow]", [2**63 - 1, 4, None], "int64", [1, -1, 2], "uint64[pyarrow]", [2**63, 3, None]),
            ("int64[pyarrow]", [1, 0, None], None, str(2**63 - 1), "uint64[pyarrow]", [2**63, 2**63 - 1, None]),
            ("int64[pyarrow]", [2**63 - 2, -4, None], None, "1", "int64[pyarrow]", [2**63 - 1, -3, None]),
            (
                "int64[pyarrow]",
                [2**63 - 1, None, 4],
                "int64[pyarrow]",
                [None, 2**63 - 1, -1],
                "int64[pyarrow]",
                [None, None, 3],
            ),
            ("int64[pyarrow]", [], None, "1", "int64[pyarrow]", []),
            ("int64[pyarrow]", [None, None], None, "1", "int64[pyarrow]", [None, None]),
            ("int64[pyarrow]", [-(2**63), None], None, "-1", None, None),
            ("int64[pyarrow]", [2**63 - 1, -4, None], None, "1", None, None),
        ]
    ]
    + [
        (
            "subtract",
            "int64[pyarrow]",
            [-1, 1, None],
            "uint64[pyarrow]",
            [0, 2**63, 2**64 - 1],
            "int64[pyarrow]",
            [-1, -(2**63 - 1), None],
        ),
        ("subtract", "uint64[pyarrow]", [0, 2**63, None], None, "1", "int64[pyarrow]", [-1, 2**63 - 1, None]),
        (
            "subtract",
            "int64[pyarrow]",
            [2**63 - 1, 1, None],
            "uint64[pyarrow]",
            [2**63, 0, 2**64 - 1],
            "int64[pyarrow]",
            [-1, 1, None],
        ),
        (
            "subtract",
            "int64",
            [-1, 1, 0],
            "uint64[pyarrow]",
            [0, 2**63, None],
            "int64[pyarrow]",
            [-1, -(2**63 - 1), None],
        ),
        (
            "subtract",
            "Int64",
            [2**63 - 1, 0, None],
            "uint64[pyarrow]",
            [2**63, 1, 2**64 - 1],
            "int64[pyarrow]",
            [-1, -1, None],
        ),
        (
            "subtract",
            "uint64[pyarrow]",
            [0, 2**63, None],
            "Int64",
            [1, 1, None],
            "int64[pyarrow]",
            [-1, 2**63 - 1, None],
        ),
        ("subtract", "int64[pyarrow]", [3, 7, None], "uint64[pyarrow]", [0, 3, None], "int64[pyarrow]", [3, 4, None]),
        ("subtract", "uint64[pyarrow]", [2**63, 2, None], None, "1", "uint64[pyarrow]", [2**63 - 1, 1, None]),
        ("subtract", "uint64[pyarrow]", [0, None], None, str(-(2**64 - 1)), "uint64[pyarrow]", [2**64 - 1, None]),
        ("subtract", "uint64[pyarrow]", [2**64 - 1, 1], "int64[pyarrow]", [-1, 1], None, None),
        ("subtract", "uint64[pyarrow]", [2**64 - 1, 0], "uint64[pyarrow]", [0, 1], None, None),
        ("subtract", "int64[pyarrow]", [0, None], "uint64[pyarrow]", [2**64 - 1, None], None, None),
        ("power", "int8[pyarrow]", [-6, 5, None], "int8[pyarrow]", [3, 3, 3], "int64[pyarrow]", [-216, 125, None]),
        (
            "power",
            "int8[pyarrow]",
            [-6, 5, None],
            "uint8[pyarrow]",
            [7, 7, 7],
            "int64[pyarrow]",
            [-279936, 78125, None],
        ),
        (
            "power",
            "int8[pyarrow]",
            [None, 2, -6, 0],
            "UInt8",
            [7, None, 7, 0],
            "int64[pyarrow]",
            [None, None, -279936, 1],
        ),
        (
            "power",
            "int8[pyarrow]",
            [-6, 5, None],
            "uint16",
            [13, 13, 13],
            "int64[pyarrow]",
            [-13060694016, 1220703125, None],
        ),
        ("power", "int8[pyarrow]", [-6, 5, None], "uint8[pyarrow]", [3, 3, 3], "int16[pyarrow]", [-216, 125, None]),
        ("power", "int8[pyarrow]", [-6, 5, None], "UInt32", [7, 7, 7], "int64[pyarrow]", [-279936, 78125, None]),
        ("power", "int64[pyarrow]", [2, 1, None], "uint64[pyarrow]", [63, 63, 63], "uint64[pyarrow]", [2**63, 1, None]),
        ("power", "int64[pyarrow]", [-3, 2, None], "uint8[pyarrow]", [41, 64, 0], None, None),
        ("power", "int64[pyarrow]", [-3, 2, None], "uint32", [41, 64, 0], None, None),
        ("power", "int8[pyarrow]", [-128, 11, None], "int8[pyarrow]", [2, 2, 2], "int64[pyarrow]", [16384, 121, None]),
        ("power", "int8[pyarrow]", [None, 2, -6, 0], "Int8", [3, None, 3, 0], "int64[pyarrow]", [None, None, -216, 1]),
        ("power", "int8[pyarrow]", [-6, 5, None], "int8", [3, 3, 3], "int64[pyarrow]", [-216, 125, None]),
        ("power", "int8", [-6, 5, 0], "int8[pyarrow]", [3, 3, None], "int64[pyarrow]", [-216, 125, None]),
        ("power", "Int8", [-6, 5, None], "int8[pyarrow]", [3, 3, 3], "int64[pyarrow]", [-216, 125, None]),
        ("power", "int8[pyarrow]", [], "int8[pyarrow]", [], "int8[pyarrow]", []),
        ("power", "int8[pyarrow]", [None, None], "int8[pyarrow]", [None, None], "int8[pyarrow]", [None, None]),
        (
            "power",
            "int64[pyarrow]",
            [-2, -3, None],
            "int64[pyarrow]",
            [63, 2, 3],
            "int64[pyarrow]",
            [-(2**63), 9, None],
        ),
        ("power", "int64[pyarrow]", [2, 1, None], "int64[pyarrow]", [63, 63, 63], None, None),
        ("power", "int8[pyarrow]", [2, -2, None], "int8[pyarrow]", [-3, -3, -3], None, None),
        ("power", "int64[pyarrow]", [-3, 2, None], "int64[pyarrow]", [41, 64, 0], None, None),
        ("power", "int64[pyarrow]", [-3, 0, None], None, "40", "uint64[pyarrow]", [3**40, 0, None]),
        (
            "power",
            "int64[pyarrow]",
            [-3037000500, -1, None],
            None,
            "2",
            "uint64[pyarrow]",
            [3037000500**2, 1, None],
        ),
        (
            "power",
            "int64[pyarrow]",
            [-1, 0, 1, None],
            None,
            str(2**64 - 2),
            "uint64[pyarrow]",
            [1, 0, 1, None],
        ),
        ("power", "int64[pyarrow]", [2, 1, 0, None], None, "63", "uint64[pyarrow]", [2**63, 1, 0, None]),
        ("power", "int8[pyarrow]", [2, 1, None], None, "63", "uint64[pyarrow]", [2**63, 1, None]),
        ("power", "int8[pyarrow]", [-1, 0, 1, None], None, str(2**64 - 1), "int64[pyarrow]", [-1, 0, 1, None]),
        ("power", "int16[pyarrow]", [-1, None], None, str(2**63 + 1), "int64[pyarrow]", [-1, None]),
        ("power", "int32[pyarrow]", [-1, 1, None], None, str(2**64 - 1), "int64[pyarrow]", [-1, 1, None]),
        ("power", "int64[pyarrow]", [-1, 0, None], None, str(2**63 + 1), "int64[pyarrow]", [-1, 0, None]),
        ("power", "int64[pyarrow]", [1, 0, None], None, str(2**64 - 1), "uint64[pyarrow]", [1, 0, None]),
        ("power", "int64[pyarrow]", [None, None], None, str(2**64 - 1), "uint64[pyarrow]", [None, None]),
        ("power", "int8[pyarrow]", [], None, str(2**64 - 1), "uint64[pyarrow]", []),
        ("power", "int64[pyarrow]", [None, None], None, "63", "int64[pyarrow]", [None, None]),
        ("power", "int8[pyarrow]", [], None, "63", "int64[pyarrow]", []),
        ("power", "int64[pyarrow]", [2, -1, None], None, "63", None, None),
        ("power", "int64[pyarrow]", [2, 3, None], None, "63", None, None),
        ("power", "int8[pyarrow]", [-128, None], None, "2", "int64[pyarrow]", [16384, None]),
        ("power", "int64[pyarrow]", [-3, 0, None], None, "2", "int64[pyarrow]", [9, 0, None]),
        ("power", "int64[pyarrow]", [-2, None], None, "63", "int64[pyarrow]", [-(2**63), None]),
        ("power", "int64[pyarrow]", [0, None], None, "0", "int64[pyarrow]", [1, None]),
        ("power", "int8[pyarrow]", [], None, "2", "int64[pyarrow]", []),
        ("power", "int64[pyarrow]", [None, None], None, "2", "int64[pyarrow]", [None, None]),
        ("power", "int64[pyarrow]", [-(2**63), None], None, "2", None, None),
        ("power", "int64[pyarrow]", [2**32, None], None, "2", None, None),
        ("power", "int64[pyarrow]", [-1, None], None, "-2", None, None),
        ("power", "int64[pyarrow]", [-3, None], "uint64[pyarrow]", [40, None], None, None),
    ],
)
def test_pandas_arrow_integer_results_keep_exact_native_capacity(
    operator, left_dtype, left_values, right_dtype, right_values, output_dtype, expected
) -> None:
    import numpy as np

    pa = pytest.importorskip("pyarrow")
    frame = pd.DataFrame({"left": pd.Series(left_values, dtype=left_dtype)})
    if right_dtype is not None:
        frame["right"] = pd.Series(right_values, dtype=right_dtype)
    for column in frame:
        if isinstance(frame[column].dtype, pd.ArrowDtype) and len(frame) > 1:
            array = cast(pd.arrays.ArrowExtensionArray, frame[column].array).__arrow_array__()
            frame[column] = pd.Series(
                pd.arrays.ArrowExtensionArray(pa.chunked_array([array.slice(0, 1), array.slice(1)]))
            )
    frame.index = pd.MultiIndex.from_tuples([("same", 2)] * len(frame), names=["group", "row"])
    frame.attrs = {"source": "retained"}
    before = frame.copy(deep=True)
    source_arrays = {
        column: frame[column].to_numpy(copy=False) if isinstance(frame[column].dtype, np.dtype) else frame[column].array
        for column in frame
    }
    runtime = PandasEngine()
    schema = runtime.schema(frame)
    lineage = source_lineage(schema)
    operation = bind_step(
        step(
            "formula",
            leftColumn=lineage[0],
            operator=operator,
            newColumn="result",
            **({"rightColumn": lineage[1]} if right_dtype is not None else {"value": right_values}),
        ),
        schema,
        lineage,
    )
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    for run in (
        lambda: runtime.apply_transform(frame, operation),
        lambda: execute_generated(runtime, frame, operation),
    ):
        if output_dtype is None:
            with pytest.raises(pa.ArrowInvalid):
                run()
        else:
            actual = run()
            pd.testing.assert_series_equal(
                actual["result"],
                pd.Series(expected, index=frame.index, name="result", dtype=output_dtype),
                check_exact=True,
            )
            actual["result"].array.__arrow_array__().validate(full=True)
            pd.testing.assert_frame_equal(actual.iloc[:, :-1], before, check_exact=True)
        pd.testing.assert_frame_equal(frame, before, check_exact=True)
        assert frame.attrs == before.attrs
        for column, source_array in source_arrays.items():
            if isinstance(frame[column].dtype, np.dtype):
                assert np.shares_memory(frame[column].to_numpy(copy=False), source_array)
            else:
                assert frame[column].array is source_array


@pytest.mark.parametrize("bits", [8, 16, 32, 64])
@pytest.mark.parametrize("storage", ["numpy", "nullable", "arrow"])
@pytest.mark.parametrize("arrow_on_right", [False, True])
@pytest.mark.parametrize("operator", ["add", "power"])
def test_pandas_arrow_formula_capacity_accepts_nonnegative_signed_columns(
    bits: int, storage: str, arrow_on_right: bool, operator: str
) -> None:
    pytest.importorskip("pyarrow")
    signed_dtype = f"Int{bits}" if storage == "nullable" else f"int{bits}{'[pyarrow]' if storage == 'arrow' else ''}"
    frame = pd.DataFrame(
        {
            "wide": pd.Series([2**64 - 1, 2**64 - 2, None], dtype="uint64[pyarrow]"),
            "signed": pd.Series([0, 1, 2], dtype=signed_dtype),
        }
    )
    frame.index = pd.Index(["same"] * len(frame), name="source")
    before = frame.copy(deep=True)
    runtime = PandasEngine()
    lineage = source_lineage(runtime.schema(frame))
    left, right = (1, 0) if arrow_on_right else (0, 1)
    operation = bind_step(
        step("formula", leftColumn=lineage[left], rightColumn=lineage[right], operator=operator, newColumn="result"),
        runtime.schema(frame),
        lineage,
    )
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    values = (
        [2**64 - 1, 2**64 - 1, None]
        if operator == "add"
        else [0 if arrow_on_right else 1, 1 if arrow_on_right else 2**64 - 2, None]
    )
    expected = pd.Series(values, index=frame.index, name="result", dtype="uint64[pyarrow]")
    for actual in (runtime.apply_transform(frame, operation), execute_generated(runtime, frame, operation)):
        pd.testing.assert_series_equal(actual["result"], expected)
        pd.testing.assert_frame_equal(actual.iloc[:, :-1], before)
        pd.testing.assert_frame_equal(frame, before)


@pytest.mark.parametrize(
    ("bits", "storage", "operator", "mixed", "signed_left"),
    [
        *(
            (bits, storage, operator, mixed, False)
            for bits in [8, 16, 32, 64]
            for storage in ["numpy", "nullable", "arrow"]
            for operator in ["add", "subtract"]
            for mixed in [False, True]
        ),
        (8, "numpy", "add", True, True),
        (16, "nullable", "add", False, True),
        (64, "arrow", "add", True, True),
    ],
)
def test_pandas_arrow_formula_capacity_accepts_signed_adjustment_columns(
    bits: int, storage: str, operator: str, mixed: bool, signed_left: bool
) -> None:
    pa = pytest.importorskip("pyarrow")
    minimum = -(2 ** (bits - 1))
    signed_values = [minimum, -1, 0, -2 if storage == "numpy" else None, -1]
    if mixed:
        signed_values[1] = -minimum - 1
        signed_values.extend([1, 0 if storage == "numpy" else None, 0 if storage == "numpy" else None])
    signed_dtype = f"Int{bits}" if storage == "nullable" else f"int{bits}{'[pyarrow]' if storage == 'arrow' else ''}"
    signed = pd.Series(signed_values, dtype=signed_dtype)
    if storage == "arrow":
        signed = pd.Series(
            pd.arrays.ArrowExtensionArray(
                pa.chunked_array(
                    [
                        pa.array(signed_values[:1], type=getattr(pa, f"int{bits}")()),
                        pa.array(signed_values[1:], type=getattr(pa, f"int{bits}")()),
                    ]
                )
            )
        )
    first = 2**64 - 1 if operator == "add" else 2**64 - 1 + minimum
    wide_values = [first, -minimum - 1 if mixed else 2, 7, 8, None]
    if mixed:
        wide_values.extend([None, None, 2**64 - 1])
    frame = pd.DataFrame({"wide": pd.Series(wide_values, dtype="uint64[pyarrow]"), "signed": signed})
    frame.index = pd.MultiIndex.from_tuples([("same", 2)] * len(frame), names=["group", "row"])
    frame.attrs = {"source": "retained"}
    before = frame.copy(deep=True)
    source_array = frame["wide"].array
    runtime = PandasEngine()
    lineage = source_lineage(runtime.schema(frame))
    operation = bind_step(
        step(
            "formula",
            leftColumn=lineage[1 if signed_left else 0],
            rightColumn=lineage[0 if signed_left else 1],
            operator=operator,
            newColumn="result",
        ),
        runtime.schema(frame),
        lineage,
    )
    values = (
        [2**64 - 1 + minimum, 1, 7, 6 if storage == "numpy" else None, None]
        if operator == "add"
        else [2**64 - 1, 3, 7, 10 if storage == "numpy" else None, None]
    )
    if mixed:
        values[1] = 2 * (-minimum - 1) if operator == "add" else 0
        values.extend([None, None, 2**64 - 1 if storage == "numpy" else None])
    expected = pd.Series(values, index=frame.index, name="result", dtype="uint64[pyarrow]")
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    for actual in (runtime.apply_transform(frame, operation), execute_generated(runtime, frame, operation)):
        pd.testing.assert_series_equal(actual["result"], expected)
        actual["result"].array.__arrow_array__().validate(full=True)
        pd.testing.assert_frame_equal(actual.iloc[:, :-1], before)
        pd.testing.assert_frame_equal(frame, before)
        assert frame.attrs == before.attrs
        assert frame["wide"].array is source_array


@pytest.mark.parametrize("shape", ["values", "empty", "null"])
@pytest.mark.parametrize("operator", ["multiply", "divide"])
def test_pandas_arrow_formula_capacity_widens_decimal_without_changing_declared_scale(
    shape: str, operator: str
) -> None:
    from decimal import Decimal

    pa = pytest.importorskip("pyarrow")
    values = (
        [Decimal("1.125"), Decimal("-2.500"), None] if shape == "values" else ([] if shape == "empty" else [None, None])
    )
    frame = pd.DataFrame({"value": pd.Series(values, dtype=pd.ArrowDtype(pa.decimal128(30, 3)))})
    frame.index = pd.Index(["same"] * len(frame), name="source")
    before = frame.copy(deep=True)
    runtime = PandasEngine()
    lineage = source_lineage(runtime.schema(frame))
    operation = bind_step(
        step(
            "formula",
            leftColumn=lineage[0],
            value=2 if operator == "multiply" else 3,
            operator=operator,
            newColumn="result",
        ),
        runtime.schema(frame),
        lineage,
    )
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    expected_values = (
        [Decimal("2.250"), Decimal("-5.000"), None]
        if operator == "multiply"
        else [Decimal("0.37500000000000000000000"), Decimal("-0.83333333333333333333333"), None]
    )
    expected = pd.Series(
        expected_values if shape == "values" else [None] * len(frame),
        index=frame.index,
        name="result",
        dtype=pd.ArrowDtype(pa.decimal256(50, 3 if operator == "multiply" else 23)),
    )
    for actual in (runtime.apply_transform(frame, operation), execute_generated(runtime, frame, operation)):
        pd.testing.assert_series_equal(actual["result"], expected)
        actual["result"].array.__arrow_array__().validate(full=True)
        pd.testing.assert_frame_equal(actual.iloc[:, :-1], before)
        pd.testing.assert_frame_equal(frame, before)


@pytest.mark.parametrize(
    "precision,scale,shape,operator,literal",
    [
        (precision, scale, shape, operator, literal)
        for precision, scale, shape in [
            (76, 0, "values"),
            (76, 76, "values"),
            (60, 30, "values"),
            (76, 76, "empty"),
            (76, 76, "null"),
            (76, 76, "dictionary"),
            (76, 76, "sliced"),
        ]
        for operator in ("multiply", "divide")
        for literal in (-1, 1)
    ]
    + [
        pytest.param(76, 0, "values", "add", 0, id="zero-add"),
        pytest.param(76, 76, "values", "subtract", 0, id="zero-subtract"),
        pytest.param(76, 76, "empty", "add", 0, id="zero-empty"),
        pytest.param(76, 76, "null", "subtract", 0, id="zero-null"),
        pytest.param(76, 76, "dictionary", "add", 0, id="zero-dictionary"),
        pytest.param(76, 76, "sliced", "subtract", 0, id="zero-sliced"),
        pytest.param(76, -1, "values", "add", 0, id="negative-scale-add-zero"),
        pytest.param(76, -1, "values", "subtract", 0, id="negative-scale-subtract-zero"),
        pytest.param(76, -1, "values", "multiply", 1, id="negative-scale-multiply-one"),
        pytest.param(76, -1, "values", "divide", 1, id="negative-scale-divide-one"),
        pytest.param(76, -1, "values", "multiply", -1, id="negative-scale-multiply-negative-one"),
        pytest.param(76, -1, "values", "divide", -1, id="negative-scale-divide-negative-one"),
    ],
)
def test_pandas_arrow_formula_capacity_preserves_wide_decimal_units(
    precision: int, scale: int, shape: str, operator: str, literal: int
) -> None:
    from decimal import Decimal

    pa = pytest.importorskip("pyarrow")
    dtype = pa.decimal256(precision, scale)
    maximum = Decimal((0, (9,) * precision, -scale))
    values = [maximum, maximum.copy_negate(), Decimal("-0"), None]
    if shape == "empty":
        values = []
    elif shape == "null":
        values = [None, None]
    physical = None
    if scale < 0:
        physical = pa.array(
            [Decimal((0, (9,) * precision, 0)), Decimal((1, (9,) * precision, 0)), Decimal(0), None],
            type=pa.decimal256(precision, 0),
        )
        arrow = pa.Array.from_buffers(dtype, len(physical), physical.buffers())
        arrow.validate(full=True)
        values = arrow.to_pylist()
    else:
        arrow = pa.array(values, type=dtype)
    if shape == "sliced":
        arrow = pa.array([Decimal("0"), *values, Decimal("0")], type=dtype).slice(1, len(values))
        assert arrow.offset == 1
    if shape == "dictionary":
        arrow = pa.DictionaryArray.from_arrays(pa.array([0, 1, 2, None], type=pa.int8()), arrow)
    split = len(arrow) // 2
    chunks = pa.chunked_array([arrow.slice(0, split), arrow.slice(split)])
    frame = pd.DataFrame({"value": pd.Series(pd.arrays.ArrowExtensionArray(chunks))})
    frame.index = pd.Index(["same"] * len(frame), name="source")
    frame.attrs = {"source": "retained"}
    before = frame.copy(deep=True)
    original_array = frame["value"].array
    runtime = PandasEngine()
    schema = runtime.schema(frame)
    lineage = source_lineage(schema)
    operation = bind_step(
        step("formula", leftColumn=lineage[0], value=literal, operator=operator, newColumn="result"), schema, lineage
    )
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    expected_values = [value.copy_negate() if literal == -1 and value is not None else value for value in values]
    if scale < 0:
        assert physical is not None
        coefficients = pa.array(
            [value.copy_negate() if literal == -1 and value is not None else value for value in physical.to_pylist()],
            type=physical.type,
        )
        expected_array = pa.Array.from_buffers(dtype, len(coefficients), coefficients.buffers())
        expected = pd.Series(pd.arrays.ArrowExtensionArray(expected_array), index=frame.index, name="result")
    else:
        expected = pd.Series(expected_values, index=frame.index, name="result", dtype=pd.ArrowDtype(dtype))
    for run in (
        lambda source: runtime.apply_transform(source, operation),
        lambda source: execute_generated(runtime, source, operation),
    ):
        source = frame.copy(deep=True)
        source_array = source["value"].array
        assert isinstance(source_array, pd.arrays.ArrowExtensionArray)
        actual = run(source)
        pd.testing.assert_series_equal(actual["result"], expected)
        assert actual["result"].array.__arrow_array__().to_pylist() == expected_values
        actual["result"].array.__arrow_array__().validate(full=True)
        pd.testing.assert_frame_equal(actual.iloc[:, :-1], before)
        pd.testing.assert_frame_equal(source, before)
        assert source["value"].array is source_array
        if len(source) and literal != -1 and shape != "dictionary":
            # Identity reuses native chunks, while each Pandas wrapper remains independently mutable.
            observed = actual["result"].array.__arrow_array__()
            original = source_array.__arrow_array__()
            assert observed.num_chunks == original.num_chunks
            for result_chunk, source_chunk in zip(observed.chunks, original.chunks, strict=True):
                assert (len(result_chunk), result_chunk.offset) == (len(source_chunk), source_chunk.offset)
                assert [(buffer.address, buffer.size) if buffer else None for buffer in result_chunk.buffers()] == [
                    (buffer.address, buffer.size) if buffer else None for buffer in source_chunk.buffers()
                ]
        if len(source):
            result_array = actual["result"].array
            assert result_array is not source_array
            assert result_array is not actual["value"].array
            result_array[0] = Decimal("0")
            pd.testing.assert_frame_equal(source, before)
            pd.testing.assert_series_equal(actual["value"], before["value"])
            if shape != "dictionary":
                source_array[0] = Decimal((0, (1,), -scale))
                assert actual["result"].iloc[0] == Decimal("0")
                pd.testing.assert_series_equal(actual["value"], before["value"])
        pd.testing.assert_frame_equal(frame, before)
        assert frame["value"].array is original_array
        assert frame.attrs == before.attrs


@pytest.mark.parametrize(
    "precision,scale,shape,companion,operator,literal,result_precision,result_scale",
    [
        (8, -2, "values", "scalar", "add", 1, 20, 0),
        (8, -2, "values", "scalar", "subtract", 1, 20, 0),
        (38, -10, "values", "scalar", "multiply", 2, 68, 0),
        (40, -10, "values", "scalar", "divide", 3, 70, 20),
        (40, -2, "values", "scalar", "add", 0, 43, 0),
        (40, -2, "values", "scalar", "multiply", 1, 62, 0),
        (40, -2, "values", "scalar", "multiply", -1, 62, 0),
        (8, -2, "small", "scalar", "divide", 3, 30, 20),
        (8, -2, "empty", "scalar", "divide", 3, 30, 20),
        (8, -2, "null", "scalar", "divide", 3, 30, 20),
        (8, -2, "dictionary", "scalar", "divide", 3, 30, 20),
        (8, -2, "values", "negative", "multiply", 1, 22, 0),
        (8, -2, "values", "negative", "divide", 1, 22, 12),
        (8, -2, "values", "integer-left", "subtract", 1, 20, 0),
        (8, -2, "values", "numpy-left", "subtract", 1, 20, 0),
        (8, -2, "values", "nullable-left", "subtract", 1, 20, 0),
        (8, -2, "values", "positive", "divide", 1, 21, 9),
    ],
)
def test_pandas_arrow_formula_capacity_rescales_negative_decimal(
    precision: int,
    scale: int,
    shape: str,
    companion: str,
    operator: str,
    literal: int,
    result_precision: int,
    result_scale: int,
) -> None:
    from decimal import ROUND_DOWN, Decimal, localcontext

    pa = pytest.importorskip("pyarrow")
    factory = pa.decimal128 if precision <= 38 else pa.decimal256
    maximum = Decimal((0, (9,) * precision, 0))
    coefficients = [maximum, maximum.copy_negate(), Decimal(0), None]
    if shape == "small":
        coefficients = [Decimal(1), Decimal(-1), Decimal(0), None]
    elif shape == "empty":
        coefficients = []
    elif shape == "null":
        coefficients = [None, None]
    physical = pa.array(coefficients, type=factory(precision, 0))
    array = pa.Array.from_buffers(factory(precision, scale), len(physical), physical.buffers())
    array.validate(full=True)
    if shape == "dictionary":
        array = pa.DictionaryArray.from_arrays(pa.array([0, 1, 2, None], type=pa.int8()), array)
    split = len(array) // 2
    chunks = pa.chunked_array([array.slice(0, split), array.slice(split)])
    frame = pd.DataFrame({"value": pd.Series(pd.arrays.ArrowExtensionArray(chunks)), "control": range(len(array))})
    if companion == "negative":
        frame["right"] = pd.Series(
            [Decimal("3000"), Decimal("-6000"), None, Decimal("0")], dtype=pd.ArrowDtype(pa.decimal128(8, -3))
        )
    elif companion == "positive":
        frame["right"] = pd.Series([Decimal("3")] * len(frame), dtype=pd.ArrowDtype(pa.decimal128(10, 2)))
    elif companion.endswith("-left"):
        dtype = {"integer-left": "int64[pyarrow]", "numpy-left": "int64", "nullable-left": "Int64"}[companion]
        frame["right"] = pd.Series([1200, -900, 0, 7 if companion == "numpy-left" else None], dtype=dtype)
    frame.index = pd.Index(["same"] * len(frame), name="source")
    frame.attrs = {"source": "retained"}
    before = frame.copy(deep=True)
    original_array = frame["value"].array
    runtime = PandasEngine()
    schema = runtime.schema(frame)
    lineage = source_lineage(schema)
    left_position, right_position = (2, 0) if companion.endswith("-left") else (0, 2)
    operation = bind_step(
        step(
            "formula",
            leftColumn=lineage[left_position],
            operator=operator,
            newColumn="result",
            **({"value": literal} if companion == "scalar" else {"rightColumn": lineage[right_position]}),
        ),
        schema,
        lineage,
    )
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    first = pa.array(frame.iloc[:, left_position].array).to_pylist()
    second = (
        [literal] * len(frame)
        if companion == "scalar"
        else frame.iloc[:, right_position].array.__arrow_array__().to_pylist()
    )
    with localcontext() as context:
        context.prec = 240
        arithmetic = {
            "add": lambda a, b: a + b,
            "subtract": lambda a, b: a - b,
            "multiply": lambda a, b: a * b,
            "divide": lambda a, b: a / b,
        }[operator]
        expected_values = [
            None
            if a is None or b is None
            else arithmetic(Decimal(a), Decimal(b)).quantize(Decimal((0, (1,), -result_scale)), rounding=ROUND_DOWN)
            for a, b in zip(first, second, strict=True)
        ]
    expected = pd.Series(
        expected_values,
        index=frame.index,
        name="result",
        dtype=pd.ArrowDtype(pa.decimal256(result_precision, result_scale)),
    )
    for actual in (runtime.apply_transform(frame, operation), execute_generated(runtime, frame, operation)):
        pd.testing.assert_series_equal(actual["result"], expected)
        actual["result"].array.__arrow_array__().validate(full=True)
        pd.testing.assert_frame_equal(actual.iloc[:, :-1], before)
        pd.testing.assert_frame_equal(frame, before)
        assert frame["value"].array is original_array
        assert frame.attrs == before.attrs


@pytest.mark.parametrize("right_column", [False, True])
def test_pandas_arrow_formula_capacity_widens_selected_decimal_columns(right_column: bool) -> None:
    from decimal import Decimal

    pa = pytest.importorskip("pyarrow")
    frame = pd.DataFrame(
        {
            "decimal": pd.Series(
                [Decimal("1.125"), Decimal("-2.500"), None], dtype=pd.ArrowDtype(pa.decimal128(30, 3))
            ),
            "integer": pd.Series([2, 3, 4], dtype="int64[pyarrow]"),
        }
    )
    before = frame.copy(deep=True)
    runtime = PandasEngine()
    lineage = source_lineage(runtime.schema(frame))
    left, right = (1, 0) if right_column else (0, 0)
    operation = bind_step(
        step("formula", leftColumn=lineage[left], rightColumn=lineage[right], operator="multiply", newColumn="result"),
        runtime.schema(frame),
        lineage,
    )
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    expected = pd.Series(
        [Decimal("2.250"), Decimal("-7.500"), None]
        if right_column
        else [Decimal("1.265625"), Decimal("6.250000"), None],
        name="result",
        dtype=pd.ArrowDtype(pa.decimal256(50, 3) if right_column else pa.decimal256(61, 6)),
    )
    for actual in (runtime.apply_transform(frame, operation), execute_generated(runtime, frame, operation)):
        pd.testing.assert_series_equal(actual["result"], expected)
        pd.testing.assert_frame_equal(frame, before)


@pytest.mark.parametrize(
    "family",
    [
        "signed-result",
        "empty",
        "null",
        "float",
        "integer-divide",
        "decimal-add",
        "decimal-zero-add",
        "decimal-zero-capacity-add",
        "decimal-zero-floating-add",
        "decimal-power",
        "decimal-unit-multiply",
        "decimal-unit-divide",
        "decimal-unit-positive-multiply",
        "decimal-unit-positive-divide",
        "decimal-floating-unit",
        "decimal-floating-positive-unit",
        "decimal-negative-scale-power",
        "decimal-negative-scale-floating",
        "negative-add",
        "negative-subtract",
        "negative-empty",
        "negative-null",
        "negative-column-add",
        "negative-column-subtract",
        "negative-column-empty",
        "negative-column-null",
        "mixed-column-add",
        "mixed-column-subtract",
        "reversed-column-add",
        "reversed-column-empty",
        "reversed-column-null",
    ],
)
def test_pandas_arrow_formula_capacity_preserves_successful_native_results(family: str) -> None:
    import operator
    from decimal import Decimal

    pa = pytest.importorskip("pyarrow")
    value, op, operand = pd.Series([0, 3, None], dtype="uint64[pyarrow]"), "subtract", 2
    if family.startswith("negative-"):
        op, operand = "subtract" if family.endswith("subtract") else "add", -1
    if family in {
        "empty",
        "null",
        "negative-empty",
        "negative-null",
        "negative-column-empty",
        "negative-column-null",
        "reversed-column-empty",
        "reversed-column-null",
    }:
        value = pd.Series([] if family.endswith("empty") else [None, None], dtype="uint64[pyarrow]")
    elif family == "float":
        value = pd.Series(pd.arrays.ArrowExtensionArray(pa.array([1.25, float("nan"), None, -0.0], from_pandas=False)))
        op = "multiply"
    elif family == "integer-divide":
        op = "divide"
    elif family.startswith("decimal-zero-"):
        dtype = (
            pa.decimal256(76, 0)
            if "floating" in family
            else pa.decimal256(75, 0)
            if "capacity" in family
            else pa.decimal256(10, 2)
        )
        value = pd.Series([Decimal("1"), None], dtype=pd.ArrowDtype(dtype))
        op, operand = "add", 0.0 if "floating" in family else 0
    elif family in {"decimal-add", "decimal-power"}:
        value = pd.Series([Decimal("1.125"), None], dtype=pd.ArrowDtype(pa.decimal128(30, 3)))
        op = "add" if family == "decimal-add" else "power"
    elif family.startswith("decimal-negative-scale-"):
        value = pd.Series([Decimal("1200"), None], dtype=pd.ArrowDtype(pa.decimal128(8, -2)))
        op, operand = ("power", 2) if family.endswith("power") else ("multiply", 0.5)
    elif family.startswith("decimal-unit-") or family.startswith("decimal-floating-"):
        dtype = pa.decimal256(76, 76) if family.startswith("decimal-floating-") else pa.decimal256(10, 2)
        value = pd.Series([Decimal("0.25"), Decimal("-0"), None], dtype=pd.ArrowDtype(dtype))
        op = "divide" if family.endswith("divide") else "multiply"
        operand = (
            (1.0 if "positive" in family else -1.0)
            if family.startswith("decimal-floating-")
            else (1 if "positive" in family else -1)
        )
    if family.startswith("negative-column-"):
        operand = pd.Series([-1] * len(value), dtype="int64[pyarrow]")
    elif family.startswith("mixed-column-"):
        operand = pd.Series([-1, 1, None], dtype="int64[pyarrow]")
        op = family.removeprefix("mixed-column-")
    elif family.startswith("reversed-column-"):
        value, operand, op = pd.Series([-1] * len(value), dtype="int64[pyarrow]"), value, "add"
    native = {
        "add": operator.add,
        "subtract": operator.sub,
        "multiply": operator.mul,
        "divide": operator.truediv,
        "power": operator.pow,
    }[op](value, operand)
    if family.startswith("decimal-zero-"):
        expected_type = (
            pa.float64()
            if "floating" in family
            else pa.decimal256(76, 0)
            if "capacity" in family
            else pa.decimal256(22, 2)
        )
        assert native.dtype == pd.ArrowDtype(expected_type)
    frame = pd.DataFrame({"value": value})
    if isinstance(operand, pd.Series):
        frame["right"] = operand
    runtime = PandasEngine()
    lineage = source_lineage(runtime.schema(frame))
    operation = bind_step(
        step(
            "formula",
            leftColumn=lineage[0],
            operator=op,
            newColumn="result",
            **({"rightColumn": lineage[1]} if isinstance(operand, pd.Series) else {"value": operand}),
        ),
        runtime.schema(frame),
        lineage,
    )
    for actual in (runtime.apply_transform(frame, operation), execute_generated(runtime, frame, operation)):
        pd.testing.assert_series_equal(actual["result"], native.rename("result"))
        observed = actual["result"].array.__arrow_array__()
        expected = native.array.__arrow_array__()
        assert observed.is_null().to_pylist() == expected.is_null().to_pylist()
        if family == "float":
            if expected[1].is_valid:
                assert isnan(observed[1].as_py())
            assert copysign(1, observed[3].as_py()) == copysign(1, expected[3].as_py())


@pytest.mark.parametrize(
    "family",
    [
        "overflow",
        "negative-underflow",
        "negative-overflow",
        "negative-multiply",
        "negative-power",
        "negative-column-mixed-underflow",
        "negative-column-mixed-overflow",
        "negative-column-underflow",
        "negative-column-overflow",
        "negative-column-reversed-negative-output",
        "negative-column-multiply",
        "negative-column-power",
        "negative-column-sparse",
        "below-negative-uint64",
        "above-uint64",
        "signed-add-above-literal",
        "signed-add-below-literal",
        "signed-add-sparse",
        "power-above-uint64",
        "wide-odd-power-negative-overflow",
        "wide-odd-power-positive-overflow",
        "wide-odd-power-above-uint64",
        "decimal-capacity",
        "decimal-other-factor",
        "decimal-unit-column",
        "decimal-positive-unit-column",
        "decimal-zero-column",
        "decimal-negative-scale",
        "decimal-negative-scale-intermediate",
        "decimal-negative-scale-empty",
        "decimal-negative-scale-null",
    ],
)
def test_pandas_arrow_formula_capacity_retains_native_refusals(family: str) -> None:
    from decimal import Decimal

    pa = pytest.importorskip("pyarrow")
    value, operand, op = pd.Series([2**64 - 1, None], dtype="uint64[pyarrow]"), 1, "add"
    error: type[Exception] | tuple[type[Exception], ...] = pa.ArrowInvalid
    if family.startswith("negative-"):
        operand = -1
        if family == "negative-underflow":
            value = pd.Series([2**64 - 1, 0, None], dtype="uint64[pyarrow]")
        elif not family.startswith("negative-column-"):
            op = family.removeprefix("negative-")
            if op == "overflow":
                op = "subtract"
    elif family == "below-negative-uint64":
        operand, error = -(2**64), OverflowError
    elif family == "above-uint64":
        operand, op, error = 2**64, "multiply", OverflowError
    elif family.startswith("signed-add-"):
        value = pd.Series([2**63 - 1, None], dtype="int64[pyarrow]")
        operand = -(2**63) - 1 if family == "signed-add-below-literal" else 2**63
        error = pa.ArrowTypeError if family == "signed-add-sparse" else OverflowError
    elif family == "power-above-uint64":
        value = pd.Series([-1, 0, 1, None], dtype="int64[pyarrow]")
        operand, op, error = 2**64, "power", OverflowError
    elif family.startswith("wide-odd-power-"):
        outside = family == "wide-odd-power-above-uint64"
        value = pd.Series([-1, 0 if outside else -2 if "negative" in family else 2, None], dtype="int64[pyarrow]")
        operand, op, error = 2**64 + 1 if outside else 2**64 - 1, "power", OverflowError
    elif family == "decimal-capacity":
        value = pd.Series([Decimal("9" * 76), None], dtype=pd.ArrowDtype(pa.decimal256(76, 0)))
    elif family in {
        "decimal-other-factor",
        "decimal-unit-column",
        "decimal-positive-unit-column",
        "decimal-zero-column",
    }:
        value = pd.Series([Decimal("9" * 76), None], dtype=pd.ArrowDtype(pa.decimal256(76, 0)))
        operand, op = -2, "multiply"
    elif family.startswith("decimal-negative-scale"):
        values = (
            [] if family.endswith("empty") else [None, None] if family.endswith("null") else [Decimal("1200"), None]
        )
        precision = 76 if family == "decimal-negative-scale" else 75
        value = pd.Series(values, dtype=pd.ArrowDtype(pa.decimal256(precision, -1)))
        error = TypeError if precision == 76 else (TypeError, pa.ArrowInvalid)
    frame = pd.DataFrame({"value": value})
    column_operand = family.startswith("negative-column-") or family in {
        "decimal-unit-column",
        "decimal-positive-unit-column",
        "decimal-zero-column",
        "signed-add-sparse",
    }
    if column_operand:
        right = [-1, None]
        if family in {"negative-column-underflow", "negative-column-overflow"}:
            frame = pd.DataFrame({"value": pd.Series([2**64 - 1, 0, None], dtype="uint64[pyarrow]")})
            right = [-1, -1, None]
        if family == "negative-column-overflow":
            frame["value"] = pd.Series([0, 2**64 - 1, None], dtype="uint64[pyarrow]")
            op = "subtract"
        elif family in {"negative-column-multiply", "negative-column-power"}:
            op = family.removeprefix("negative-column-")
        elif family in {"negative-column-mixed-underflow", "negative-column-mixed-overflow"}:
            frame = pd.DataFrame({"value": pd.Series([2**64 - 2, 0, 2**64 - 1], dtype="uint64[pyarrow]")})
            right = [1, -1, 1] if family.endswith("underflow") else [-1, 1, 1]
        elif family == "negative-column-reversed-negative-output":
            # Mathematical [-1, 0] still needs signed output after native inference fails.
            frame = pd.DataFrame({"value": pd.Series([0, 2**63], dtype="uint64[pyarrow]")})
            right = [-1, -(2**63)]
        frame["right"] = pd.Series(right, dtype="int64[pyarrow]")
        if family == "negative-column-sparse":
            frame["right"] = pd.Series([-1, -2], dtype=pd.SparseDtype("int64", 0))
            error = pa.ArrowTypeError
    if family == "decimal-positive-unit-column":
        frame["right"] = pd.Series([1, None], dtype="int64[pyarrow]")
    if family == "decimal-zero-column":
        frame["right"] = pd.Series([0, None], dtype="int64[pyarrow]")
        op = "add"
    if family == "signed-add-sparse":
        frame["right"] = pd.Series([1, 0], dtype=pd.SparseDtype("int64", 0))
    before = frame.copy(deep=True)
    runtime = PandasEngine()
    lineage = source_lineage(runtime.schema(frame))
    operation = bind_step(
        step(
            "formula",
            leftColumn=lineage[1] if family == "negative-column-reversed-negative-output" else lineage[0],
            operator=op,
            newColumn="result",
            **(
                {"rightColumn": lineage[0] if family == "negative-column-reversed-negative-output" else lineage[1]}
                if column_operand
                else {"value": str(operand)}
            ),
        ),
        runtime.schema(frame),
        lineage,
    )
    for run in (
        lambda: runtime.apply_transform(frame, operation),
        lambda: execute_generated(runtime, frame, operation),
    ):
        with pytest.raises(error):
            run()
        pd.testing.assert_frame_equal(frame, before)


@pytest.mark.parametrize("generated", [False, True])
@pytest.mark.parametrize("column_operand", [False, True])
@pytest.mark.parametrize("decimal_zero", [False, True])
def test_pandas_arrow_formula_capacity_preserves_unrelated_type_errors(
    monkeypatch: pytest.MonkeyPatch, generated: bool, column_operand: bool, decimal_zero: bool
) -> None:
    from decimal import Decimal

    from openwrangler_runtime.engines import pandas_engine

    pa = pytest.importorskip("pyarrow")
    original = TypeError("native operand refuses this operation")

    def refuse(*_args: Any) -> Any:
        raise original

    if generated:
        namespace: dict[str, Any] = {}
        exec("\n".join(pandas_engine._generated_pandas_formula_helpers()), namespace)
        namespace["_open_wrangler_formula"] = refuse
        formula = namespace["_open_wrangler_formula_result"]
    else:
        monkeypatch.setattr(pandas_engine, "_pandas_formula", refuse)
        formula = pandas_engine._pandas_formula_result
    # Capacity repairs could succeed here, but TypeError admission remains negative-scale only.
    left = (
        pd.Series([Decimal("1"), None], dtype=pd.ArrowDtype(pa.decimal256(76, 0)))
        if decimal_zero
        else pd.Series([-1, 0, 1, None], dtype="int64[pyarrow]")
    )
    literal = 0 if decimal_zero else 2
    with pytest.raises(TypeError) as refused:
        formula(
            left,
            pd.Series([literal] * (len(left) - 1) + [None], dtype="int64[pyarrow]") if column_operand else literal,
            "add" if decimal_zero else "power",
        )
    assert refused.value is original


@pytest.mark.parametrize("generated", [False, True])
@pytest.mark.parametrize("negative_on_right", [False, True])
def test_pandas_arrow_formula_capacity_preserves_custom_decimal_refusal(
    generated: bool, negative_on_right: bool
) -> None:
    from decimal import Decimal

    from openwrangler_runtime.engines import pandas_engine

    pa = pytest.importorskip("pyarrow")
    calls: list[str] = []
    original = TypeError("custom Decimal first conversion refuses")

    class OnceRefusingDecimal(Decimal):
        def as_tuple(self) -> Any:
            calls.append("as_tuple")
            if len(calls) == 1:
                raise original
            return super().as_tuple()

    frame = pd.DataFrame(
        {
            "decimal": pd.Series([Decimal("1200")], dtype=pd.ArrowDtype(pa.decimal128(8, -2))),
            "custom": pd.Series([OnceRefusingDecimal("1")], dtype=object),
        }
    )
    before = frame.copy(deep=True)
    runtime = PandasEngine()
    schema = runtime.schema(frame)
    assert [column["type"] for column in schema] == ["decimal", "decimal"]
    lineage = source_lineage(schema)
    left, right = (1, 0) if negative_on_right else (0, 1)
    operation = bind_step(
        step("formula", leftColumn=lineage[left], rightColumn=lineage[right], operator="add", newColumn="result"),
        schema,
        lineage,
    )
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    calls.clear()
    with pytest.raises(TypeError) as native:
        pandas_engine._pandas_formula(frame.iloc[:, left], frame.iloc[:, right], "add")
    assert native.value is original
    assert calls == ["as_tuple"]
    calls.clear()
    with pytest.raises(TypeError) as refused:
        if generated:
            execute_generated(runtime, frame, operation)
        else:
            runtime.apply_transform(frame, operation)
    assert refused.value is original
    assert calls == ["as_tuple"]
    pd.testing.assert_frame_equal(frame, before)


@pytest.mark.parametrize("generated", [False, True])
def test_pandas_arrow_formula_refusal_releases_input_without_cyclic_collection(generated: bool) -> None:
    import gc
    import weakref

    pytest.importorskip("pyarrow")
    runtime = PandasEngine()
    operation = bound_step(
        "formula",
        leftColumn=bound_ref("c:source:0", "value", 0),
        operator="multiply",
        value=str(2**64 - 1),
        newColumn="result",
    )
    namespace: dict[str, Any] = {}
    if generated:
        exec(runtime.compile_plan([operation]), namespace)

    def refuse():
        frame = pd.DataFrame({"value": pd.Series([2**63 - 1], dtype="int64[pyarrow]")})
        reference = weakref.ref(frame)
        try:
            if generated:
                namespace["clean_data"](frame)
            else:
                runtime.apply_transform(frame, operation)
        except OverflowError:
            return reference
        raise AssertionError("The complete integer result must exceed supported capacity.")

    was_enabled = gc.isenabled()
    gc.disable()
    try:
        # An escaped error must not retain itself through its repair frame.
        reference = refuse()
        assert reference() is None
    finally:
        gc.collect()
        if was_enabled:
            gc.enable()


@pytest.mark.parametrize(
    "signed_value,operator,arrow_dtype",
    [
        (1, "add", "uint64[pyarrow]"),
        (-1, "add", "uint64[pyarrow]"),
        (-1, "multiply", "uint64[pyarrow]"),
        (2, "add", "int64[pyarrow]"),
        (2, "power", "int64[pyarrow]"),
    ],
)
@pytest.mark.parametrize("signed_left", [False, True])
def test_pandas_arrow_formula_capacity_does_not_convert_custom_integer_extensions(
    signed_value: int, operator: str, arrow_dtype: str, signed_left: bool
) -> None:
    import numpy as np

    pa = pytest.importorskip("pyarrow")
    casts: list[str] = []

    # The factory receives a dtype class in Pandas 2 and a dtype instance in Pandas 3.
    def domain_array_type(*_args: object, **_kwargs: object) -> type[pd.api.extensions.ExtensionArray]:
        return DomainIntArray

    class DomainIntDtype(pd.api.extensions.ExtensionDtype):
        numpy_dtype = np.dtype("int64")
        construct_array_type = domain_array_type

        @property
        def name(self) -> str:
            return "domain_integer"

        @property
        def type(self) -> Any:
            return np.int64

        @property
        def kind(self) -> str:
            return "i"

        @property
        def na_value(self) -> Any:
            return pd.NA

    class DomainIntArray(pd.arrays.IntegerArray):
        @property
        def dtype(self) -> Any:
            return DomainIntDtype()

        def astype(self, dtype: Any, copy: bool = True) -> Any:
            casts.append(str(dtype))
            return super().astype(dtype, copy=copy)

    assert domain_array_type(DomainIntDtype) is DomainIntArray
    assert DomainIntDtype().construct_array_type() is DomainIntArray
    maximum = 2**63 - 1 if arrow_dtype == "int64[pyarrow]" else 2**64 - 1
    frame = pd.DataFrame(
        {
            "wide": pd.Series([maximum, maximum - 1, None], dtype=arrow_dtype),
            "domain": pd.Series(
                DomainIntArray(np.array([0, signed_value, 0], dtype=np.int64), np.array([False, False, True]))
            ),
        }
    )
    frame.index = pd.Index(["same"] * len(frame), name="source")
    before = frame.copy(deep=True)
    runtime = PandasEngine()
    schema = runtime.schema(frame)
    assert schema[1]["type"] == "integer"
    lineage = source_lineage(schema)
    operation = bind_step(
        step(
            "formula",
            leftColumn=lineage[1 if signed_left else 0],
            rightColumn=lineage[0 if signed_left else 1],
            operator=operator,
            newColumn="result",
        ),
        schema,
        lineage,
    )
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    with pytest.raises(pa.ArrowInvalid) as native:
        left, right = (frame["domain"], frame["wide"]) if signed_left else (frame["wide"], frame["domain"])
        _ = left + right if operator == "add" else left**right if operator == "power" else left * right
    assert casts == []
    for run in (
        lambda: runtime.apply_transform(frame, operation),
        lambda: execute_generated(runtime, frame, operation),
    ):
        with pytest.raises(pa.ArrowInvalid) as refused:
            run()
        assert str(refused.value) == str(native.value)
        assert casts == []
        pd.testing.assert_frame_equal(frame, before)


@pytest.mark.parametrize("operand", ["scalar", "nonpositive", "mixed", "reversed"])
def test_pandas_arrow_formula_capacity_mixed_plan_keeps_by_example_and_custom_code_isolated(
    operand: str,
) -> None:
    pa = pytest.importorskip("pyarrow")
    dictionary = pa.DictionaryArray.from_arrays(pa.array([0, 1, None], type=pa.int8()), pa.array(["x", "y"]))
    frame = pd.DataFrame(
        {
            "value": pd.Series([2**64 - 1, 2**64 - 2, None], dtype="uint64[pyarrow]"),
            "encoded": pd.arrays.ArrowExtensionArray(dictionary),
        }
    )
    frame.index = pd.Index(["same"] * len(frame), name="source")
    if operand != "scalar":
        frame["adjustment"] = pd.Series(
            [-2, 1 if operand in {"mixed", "reversed"} else -2, None], index=frame.index, dtype="int64[pyarrow]"
        )
    frame.attrs = {"source": "unchanged"}
    before = frame.copy(deep=True)
    runtime = PandasEngine()
    lineage = source_lineage(runtime.schema(frame))
    live = frame
    plan = []
    for kind in ("formula", "customCode", "byExample", "formula"):
        if kind == "formula":
            params = {
                "leftColumn": lineage[0],
                "operator": "subtract",
                "value": 2,
                "newColumn": "repaired" if not plan else "again",
            }
            if operand != "scalar":
                params.pop("value")
                params.update({"operator": "add", "rightColumn": lineage[2]})
                if operand == "reversed":
                    params.update({"leftColumn": lineage[2], "rightColumn": lineage[0]})
        elif kind == "customCode":
            params = {
                "code": "_open_wrangler_formula_result = None\n_open_wrangler_formula = None\n"
                "_open_wrangler_arrow_formula_repair = None\n_pandas_formula = None\nresult = df"
            }
        else:
            params = {
                "sourceColumns": [lineage[-1]],
                "examples": [{"inputs": [2], "output": 4}, {"inputs": [5], "output": 7}],
                "newColumn": "inferred",
            }
        operation = bind_step(step(kind, **params), runtime.schema(live), lineage)
        runtime.validate_transform_preflight(live, operation, runtime.shape(live))
        live = runtime.apply_transform(live, operation)
        lineage = derive_lineage(lineage, runtime.schema(live), operation)
        plan.append(operation)
    code = runtime.compile_plan(plan)
    assert code.count("def _open_wrangler_formula_result(") == 1
    assert "def _open_wrangler_modulo(" not in code
    assert "def _open_wrangler_formula_result(" not in runtime.compile_plan([plan[2]])
    namespace: dict[str, Any] = {
        "_open_wrangler_formula_result": object(),
        "_open_wrangler_arrow_formula_repair": frame,
        "Any": frame,
    }
    exec(code, namespace)
    assert namespace["_open_wrangler_arrow_formula_repair"] is frame
    assert namespace["Any"] is frame
    generated = namespace["clean_data"](namespace["_open_wrangler_arrow_formula_repair"])
    assert namespace["_open_wrangler_arrow_formula_repair"] is frame
    assert namespace["Any"] is frame
    pd.testing.assert_frame_equal(generated, live)
    expected_inferred = frame["value"].astype(object)
    if operand in {"mixed", "reversed"}:
        expected_inferred.iloc[1] += 3
    assert isinstance(expected_inferred, pd.Series)
    expected_inferred = expected_inferred.rename("inferred")
    for actual in (live, generated):
        pd.testing.assert_series_equal(actual["inferred"], expected_inferred)
        pd.testing.assert_series_equal(actual["repaired"], actual["again"].rename("repaired"))
        assert actual["encoded"].array.__arrow_array__().equals(pa.chunked_array([dictionary]))
        pd.testing.assert_index_equal(actual.index, frame.index)
    pd.testing.assert_frame_equal(frame, before)
