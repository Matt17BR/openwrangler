from __future__ import annotations

from datetime import date, datetime, timezone
from math import copysign, isnan
from typing import Any, cast

import pandas as pd
import polars as pl
import pytest

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
    if value is None or type(value).__name__ in {"NAType", "NaTType"}:
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
    source = source.lazy() if lazy else source
    for result in floor_ceil_results(PolarsEngine(), source, kind, False):
        result = result.collect() if lazy else result
        assert result["integral"].to_list() == expected
        assert result["integral"].dtype == pl.Decimal(38, 0)
        result["integral"].to_arrow().validate(full=True)


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


@pytest.mark.parametrize("right_column", [False, True])
def test_pandas_dictionary_formula_uses_logical_operands(right_column: bool) -> None:
    pa = pytest.importorskip("pyarrow")
    array = pa.DictionaryArray.from_arrays(pa.array([0, 1, 2, None], type=pa.int8()), pa.array([-3, None, 7]))
    frame = pd.DataFrame({"value": pd.arrays.ArrowExtensionArray(pa.chunked_array([array, array])), "other": 2})
    runtime = PandasEngine()
    schema = runtime.schema(frame)
    lineage = source_lineage(schema)
    params = (
        {"leftColumn": lineage[1], "rightColumn": lineage[0]}
        if right_column
        else {"leftColumn": lineage[0], "value": 2}
    )
    operation = bind_step(step("formula", **params, operator="divide", newColumn="result"), schema, lineage)
    runtime.validate_transform_preflight(frame, operation, runtime.shape(frame))
    logical = frame.copy()
    logical["value"] = logical["value"].astype("int64[pyarrow]")
    expected = runtime.apply_transform(logical, operation)
    for actual in (runtime.apply_transform(frame, operation), execute_generated(runtime, frame, operation)):
        pd.testing.assert_series_equal(actual["result"], expected["result"])
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
