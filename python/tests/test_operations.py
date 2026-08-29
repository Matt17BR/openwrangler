from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from math import isnan
from typing import Any

import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime._column_binding import bind_step
from openwrangler_runtime.engines import EngineError, PandasEngine, PolarsEngine
from openwrangler_runtime.engines.base import INTERNAL_ROW_ID_PREFIX
from openwrangler_runtime.lineage import source_lineage
from openwrangler_runtime.operations import OperationError, operation_catalog, validate_step
from openwrangler_runtime.protocol_limits_generated import MAX_PYTHON_CUSTOM_CODE_UTF8_BYTES

PRIVATE_COLUMN = f"{INTERNAL_ROW_ID_PREFIX}guessed"


@pytest.fixture(params=["pandas", "polars"])
def engine_and_frame(request, monkeypatch):
    records = {
        "group": ["a", "a", "b", "b"],
        "text": [" alpha-one ", "BETA-two", None, "alpha-one"],
        "tags": ["red|blue", "blue", None, "red"],
        "value": [1.2, 2.8, None, 2.8],
        "other": [2, 3, 4, 3],
        "date": ["2024-01-02", "2024-02-03", "2024-03-04", "2024-02-03"],
    }
    if request.param == "pandas":
        return PandasEngine(), pd.DataFrame(records)

    def fail_to_pandas(*_args, **_kwargs):
        raise AssertionError("Polars transformations must never convert to Pandas")

    monkeypatch.setattr(pl.DataFrame, "to_pandas", fail_to_pandas, raising=False)
    return PolarsEngine(), pl.DataFrame(records)


def step(step_id: str, kind: str, **params):
    return validate_step({"id": step_id, "kind": kind, "params": params})


def public_ref(identifier: str, name: str) -> dict[str, str]:
    return {"id": identifier, "name": name}


def bound_ref(identifier: str, name: str, position: int) -> dict[str, str | int]:
    return {"id": identifier, "name": name, "position": position}


def bound_step(step_id: str, kind: str, **params):
    return {"id": step_id, "kind": kind, "params": params}


def test_operation_registry_is_complete_and_validation_is_strict():
    catalog = operation_catalog()
    assert len(catalog) == 32
    assert {item["kind"] for item in catalog} >= {
        "sortRows",
        "fillMissingValues",
        "oneHotEncode",
        "groupBy",
        "byExample",
        "customCode",
    }
    with pytest.raises(OperationError, match="Unsupported"):
        validate_step({"id": "bad", "kind": "unknown", "params": {}})
    with pytest.raises(OperationError, match="exactly one"):
        step(
            "bad-formula",
            "formula",
            leftColumn=public_ref("c:source:3", "value"),
            operator="add",
            newColumn="result",
        )
    with pytest.raises(OperationError, match="exactly one"):
        step(
            "bool-formula",
            "formula",
            leftColumn=public_ref("c:source:3", "value"),
            operator="add",
            value=True,
            newColumn="result",
        )


def test_custom_code_uses_the_canonical_utf8_byte_limit() -> None:
    exact_ascii = "x" * MAX_PYTHON_CUSTOM_CODE_UTF8_BYTES
    exact_multibyte = "é" * (MAX_PYTHON_CUSTOM_CODE_UTF8_BYTES // 2)

    assert step("custom-ascii", "customCode", code=exact_ascii)["params"]["code"] == exact_ascii
    assert step("custom-multibyte", "customCode", code=exact_multibyte)["params"]["code"] == exact_multibyte
    for code in (exact_ascii + "x", exact_multibyte + "x"):
        with pytest.raises(OperationError, match=r"65,536 UTF-8 bytes"):
            step("custom-too-large", "customCode", code=code)
    for code in ("result = df\ud800", "result = df\udfff"):
        with pytest.raises(OperationError, match=r"valid Unicode text"):
            step("custom-invalid-unicode", "customCode", code=code)


def test_generated_code_imports_counter_only_for_categorical_encoding(engine_and_frame):
    engine, _frame = engine_and_frame
    plain_plan = [
        bound_step(
            "upper",
            "upperText",
            column=bound_ref("c:source:1", "text", 1),
            newColumn="upper_text",
        )
    ]
    encoded_plan = [
        bound_step(
            "one-hot",
            "oneHotEncode",
            columns=[bound_ref("c:source:0", "group", 0)],
            prefixSeparator="_",
            dropOriginal=True,
        )
    ]

    plain_code = engine.compile_plan(plain_plan)
    assert "from collections import Counter" not in plain_code
    assert plain_code.startswith("import numpy as np" if isinstance(engine, PandasEngine) else "import polars as pl")
    assert "from collections import Counter" in engine.compile_plan(encoded_plan)


@pytest.mark.parametrize(
    "operation",
    [
        {
            "id": "sort",
            "kind": "sortRows",
            "params": {"rules": [{"column": "value", "direction": "asc", "nulls": "last"}]},
        },
        {
            "id": "filter",
            "kind": "filterRows",
            "params": {
                "filterModel": {
                    "filters": [
                        {
                            "column": "value",
                            "type": "integer",
                            "predicates": [{"kind": "predicate", "operator": "gt", "value": 1}],
                        }
                    ],
                    "sort": [],
                }
            },
        },
        {"id": "missing", "kind": "dropMissingRows", "params": {"columns": ["value"]}},
        {"id": "duplicates", "kind": "dropDuplicates", "params": {"columns": ["value"]}},
    ],
)
def test_row_order_operations_reject_name_only_transform_columns(operation) -> None:
    with pytest.raises(OperationError, match="column reference"):
        validate_step(operation)


@pytest.mark.parametrize(
    "replacement",
    [
        {"kind": "mean"},
        {"kind": "median"},
        {"kind": "mostFrequent"},
        {"kind": "string", "value": ""},
        {"kind": "integer", "value": "99999999999999999999999999999999999999"},
        {"kind": "float", "value": "-1.25e+3"},
        {"kind": "decimal", "value": "0.00000000000000000000000000000000000001"},
        {"kind": "boolean", "value": True},
        {"kind": "date", "value": "2024-02-29"},
        {"kind": "datetime", "value": "2026-08-05T18:20:00+02:00"},
    ],
)
def test_fill_missing_validation_accepts_exact_typed_replacements(replacement: dict[str, Any]) -> None:
    validated = step(
        "fill",
        "fillMissingValues",
        column=public_ref("c:source:3", "value"),
        replacement=replacement,
    )

    assert validated["params"]["replacement"] == replacement


def test_fill_missing_validation_preserves_ordered_fallback_references() -> None:
    replacement = {
        "kind": "fallbackColumns",
        "columns": [
            public_ref("c:source:4", "secondary"),
            public_ref("c:source:5", "last resort"),
        ],
    }

    validated = step(
        "fill-from-columns",
        "fillMissingValues",
        column=public_ref("c:source:3", "value"),
        replacement=replacement,
    )

    assert validated["params"]["replacement"] == replacement


def test_fill_missing_validation_preserves_directional_order_and_gap_limit() -> None:
    replacement = {
        "kind": "directional",
        "direction": "forward",
        "orderBy": [
            {
                "column": public_ref("c:source:0", "group"),
                "direction": "asc",
                "nulls": "last",
            },
            {
                "column": public_ref("c:source:1", "sequence"),
                "direction": "desc",
                "nulls": "first",
            },
        ],
        "maxGap": 2,
    }

    validated = step(
        "directional-fill",
        "fillMissingValues",
        column=public_ref("c:source:3", "value"),
        replacement=replacement,
    )

    assert validated["params"]["replacement"] == replacement


def test_fill_missing_validation_preserves_grouped_statistic_keys() -> None:
    replacement = {
        "kind": "groupedStatistic",
        "statistic": "median",
        "keys": [
            public_ref("c:source:0", "region"),
            public_ref("c:source:1", "date"),
        ],
    }

    validated = step(
        "grouped-fill",
        "fillMissingValues",
        column=public_ref("c:source:3", "value"),
        replacement=replacement,
    )

    assert validated["params"]["replacement"] == replacement


@pytest.mark.parametrize(
    "replacement",
    [
        {"kind": "groupedStatistic", "statistic": "median", "keys": []},
        {
            "kind": "groupedStatistic",
            "statistic": "future",
            "keys": [public_ref("c:source:0", "region")],
        },
        {
            "kind": "groupedStatistic",
            "statistic": "median",
            "keys": [public_ref("c:source:0", "region"), public_ref("c:source:0", "region")],
        },
        {
            "kind": "groupedStatistic",
            "statistic": "median",
            "keys": [public_ref("c:source:3", "value")],
        },
        {
            "kind": "groupedStatistic",
            "statistic": "median",
            "keys": [public_ref("c:source:0", "region")],
            "extra": True,
        },
    ],
)
def test_fill_missing_validation_rejects_invalid_grouped_statistics(replacement: dict[str, Any]) -> None:
    with pytest.raises(OperationError):
        step(
            "bad-grouped-fill",
            "fillMissingValues",
            column=public_ref("c:source:3", "value"),
            replacement=replacement,
        )


@pytest.mark.parametrize(
    "replacement",
    [
        {"kind": "directional", "direction": "forward", "orderBy": []},
        {
            "kind": "directional",
            "direction": "sideways",
            "orderBy": [
                {
                    "column": public_ref("c:source:0", "group"),
                    "direction": "asc",
                    "nulls": "last",
                }
            ],
        },
        {
            "kind": "directional",
            "direction": "forward",
            "orderBy": [
                {
                    "column": public_ref("c:source:0", "group"),
                    "direction": "asc",
                    "nulls": "last",
                }
            ],
            "maxGap": True,
        },
        {
            "kind": "directional",
            "direction": "forward",
            "orderBy": [
                {
                    "column": public_ref("c:source:0", "group"),
                    "direction": "asc",
                    "nulls": "last",
                }
            ],
            "maxGap": 0,
        },
        {
            "kind": "directional",
            "direction": "forward",
            "orderBy": [
                {
                    "column": public_ref("c:source:0", "group"),
                    "direction": "asc",
                    "nulls": "last",
                }
            ],
            "maxGap": 1_000_001,
        },
        {
            "kind": "directional",
            "direction": "forward",
            "orderBy": [
                {
                    "column": public_ref("c:source:0", "group"),
                    "direction": "asc",
                    "nulls": "last",
                }
            ],
            "extra": True,
        },
        {
            "kind": "directional",
            "direction": "forward",
            "orderBy": [
                {
                    "column": public_ref("c:source:0", "group"),
                    "direction": "asc",
                    "nulls": "last",
                },
                {
                    "column": public_ref("c:source:0", "group"),
                    "direction": "desc",
                    "nulls": "first",
                },
            ],
        },
        {
            "kind": "directional",
            "direction": "forward",
            "orderBy": [
                {
                    "column": public_ref("c:source:3", "value"),
                    "direction": "asc",
                    "nulls": "last",
                }
            ],
        },
        {
            "kind": "directional",
            "direction": "forward",
            "orderBy": [{"column": "group", "direction": "asc", "nulls": "last"}],
        },
    ],
)
def test_fill_missing_validation_rejects_invalid_directional_replacements(
    replacement: dict[str, Any],
) -> None:
    with pytest.raises(OperationError):
        step(
            "bad-directional-fill",
            "fillMissingValues",
            column=public_ref("c:source:3", "value"),
            replacement=replacement,
        )


@pytest.mark.parametrize(
    "replacement",
    [
        {"kind": "fallbackColumns", "columns": []},
        {
            "kind": "fallbackColumns",
            "columns": [public_ref("c:fallback", "fallback"), public_ref("c:fallback", "fallback")],
        },
        {
            "kind": "fallbackColumns",
            "columns": [public_ref(f"c:fallback:{index}", f"fallback_{index}") for index in range(65)],
        },
        {
            "kind": "fallbackColumns",
            "columns": [public_ref("c:source:3", "value")],
        },
    ],
)
def test_fill_missing_validation_rejects_invalid_fallback_references(replacement: dict[str, Any]) -> None:
    with pytest.raises(OperationError):
        step(
            "bad-fallback-fill",
            "fillMissingValues",
            column=public_ref("c:source:3", "value"),
            replacement=replacement,
        )


@pytest.mark.parametrize(
    "replacement",
    [
        {"kind": "mean", "value": 1},
        {"kind": "median", "value": 1},
        {"kind": "mostFrequent", "value": "x"},
        {"kind": "integer", "value": "01"},
        {"kind": "integer", "value": "100000000000000000000000000000000000000"},
        {"kind": "float", "value": "NaN"},
        {"kind": "decimal", "value": "999999999999999999999999999999999999999"},
        {"kind": "boolean", "value": "true"},
        {"kind": "date", "value": "2023-02-29"},
        {"kind": "datetime", "value": "2026-08-05T25:00"},
        {"kind": "future", "value": "x"},
        {"kind": "string", "value": "x", "extra": True},
    ],
)
def test_fill_missing_validation_rejects_ambiguous_or_out_of_range_values(replacement: dict[str, Any]) -> None:
    with pytest.raises(OperationError):
        step(
            "bad-fill",
            "fillMissingValues",
            column=public_ref("c:source:3", "value"),
            replacement=replacement,
        )


@pytest.mark.parametrize(
    ("kind", "params"),
    [
        ("oneHotEncode", {"columns": ["group"]}),
        ("fillMissingValues", {"column": "value", "replacement": {"kind": "median"}}),
        ("multiLabelBinarize", {"column": "tags", "delimiter": "|"}),
        ("findReplace", {"column": "text", "find": "a", "replacement": "b"}),
        ("stripText", {"column": "text"}),
        ("splitText", {"column": "text", "delimiter": "-", "index": 0, "newColumn": "part"}),
        ("splitTextColumns", {"column": "text", "delimiter": "-", "newColumns": ["first", "second"]}),
        ("capitalizeText", {"column": "text"}),
        ("lowerText", {"column": "text"}),
        ("upperText", {"column": "text"}),
        ("minMaxScale", {"column": "value"}),
        ("roundNumber", {"column": "value"}),
        ("floorNumber", {"column": "value"}),
        ("ceilNumber", {"column": "value"}),
        ("formatDatetime", {"column": "date", "format": "%Y"}),
    ],
)
def test_value_operations_reject_legacy_name_only_columns(kind: str, params: dict[str, Any]) -> None:
    with pytest.raises(OperationError, match="column reference"):
        validate_step({"id": f"legacy-{kind}", "kind": kind, "params": params})


def test_public_validation_rejects_repeated_one_hot_identities() -> None:
    group = public_ref("c:source:0", "group")

    with pytest.raises(OperationError, match="contains duplicate column identities"):
        step("duplicate-hot", "oneHotEncode", columns=[group, group])


def test_public_validation_scopes_nested_row_reference_uniqueness() -> None:
    value = public_ref("c:source:3", "value")
    rule = {"column": value, "direction": "asc", "nulls": "last"}
    column_filter = {
        "column": value,
        "type": "float",
        "predicates": [{"kind": "predicate", "operator": "gt", "value": 1}],
    }

    with pytest.raises(OperationError, match="sortRows.rules contains duplicate column identities"):
        step("duplicate-sort", "sortRows", rules=[rule, rule])
    with pytest.raises(OperationError, match="filterRows.filterModel.filters contains duplicate column identities"):
        step(
            "duplicate-filter",
            "filterRows",
            filterModel={"filters": [column_filter, column_filter], "sort": []},
        )
    with pytest.raises(OperationError, match="filterRows.filterModel.sort contains duplicate column identities"):
        step(
            "duplicate-filter-sort",
            "filterRows",
            filterModel={"filters": [], "sort": [rule, rule]},
        )

    normalized = step(
        "shared-filter-sort",
        "filterRows",
        filterModel={"filters": [column_filter], "sort": [rule]},
    )
    assert normalized["params"]["filterModel"]["filters"][0]["column"] == value
    assert normalized["params"]["filterModel"]["sort"][0]["column"] == value


def test_optional_row_column_lists_have_strict_empty_semantics() -> None:
    missing = validate_step({"id": "missing", "kind": "dropMissingRows", "params": {"columns": [], "how": "any"}})
    omitted = validate_step({"id": "all", "kind": "dropMissingRows", "params": {}})

    assert missing["params"]["columns"] == []
    assert "columns" not in omitted["params"]
    with pytest.raises(OperationError, match="non-empty array"):
        validate_step({"id": "duplicates", "kind": "dropDuplicates", "params": {"columns": []}})


@pytest.mark.parametrize(
    ("kind", "params"),
    [
        (
            "sortRows",
            {
                "rules": [
                    {
                        "column": public_ref("private", PRIVATE_COLUMN),
                        "direction": "asc",
                        "nulls": "last",
                    }
                ]
            },
        ),
        (
            "filterRows",
            {
                "filterModel": {
                    "filters": [
                        {
                            "column": public_ref("private", PRIVATE_COLUMN),
                            "type": "string",
                            "predicates": [{"kind": "predicate", "operator": "equals", "value": "x"}],
                        }
                    ],
                    "sort": [],
                }
            },
        ),
        ("dropMissingRows", {"columns": [public_ref("private", PRIVATE_COLUMN)]}),
        ("dropDuplicates", {"columns": [public_ref("private", PRIVATE_COLUMN)]}),
        ("selectColumns", {"columns": [public_ref("private", PRIVATE_COLUMN)]}),
        ("dropColumns", {"columns": [public_ref("private", PRIVATE_COLUMN)]}),
        (
            "renameColumn",
            {"column": public_ref("c:source:0", "value"), "newName": PRIVATE_COLUMN},
        ),
        (
            "cloneColumn",
            {"column": public_ref("c:source:0", "value"), "newName": PRIVATE_COLUMN},
        ),
        ("castColumn", {"column": public_ref("private", PRIVATE_COLUMN), "dtype": "float"}),
        (
            "fillMissingValues",
            {
                "column": public_ref("c:source:3", "value"),
                "replacement": {
                    "kind": "directional",
                    "direction": "forward",
                    "orderBy": [
                        {
                            "column": public_ref("private", PRIVATE_COLUMN),
                            "direction": "asc",
                            "nulls": "last",
                        }
                    ],
                },
            },
        ),
        (
            "formula",
            {
                "leftColumn": public_ref("private", PRIVATE_COLUMN),
                "operator": "add",
                "value": 1,
                "newColumn": "result",
            },
        ),
        (
            "textLength",
            {"column": public_ref("c:source:0", "value"), "newColumn": PRIVATE_COLUMN},
        ),
        ("oneHotEncode", {"columns": [public_ref("private", PRIVATE_COLUMN)]}),
        (
            "multiLabelBinarize",
            {"column": public_ref("c:source:2", "tags"), "delimiter": "|", "prefix": PRIVATE_COLUMN},
        ),
        ("findReplace", {"column": public_ref("private", PRIVATE_COLUMN), "find": "a", "replacement": "b"}),
        ("stripText", {"column": public_ref("private", PRIVATE_COLUMN)}),
        (
            "splitText",
            {
                "column": public_ref("private", PRIVATE_COLUMN),
                "delimiter": "-",
                "index": 0,
                "newColumn": "part",
            },
        ),
        ("capitalizeText", {"column": public_ref("private", PRIVATE_COLUMN)}),
        ("lowerText", {"column": public_ref("private", PRIVATE_COLUMN)}),
        ("upperText", {"column": public_ref("private", PRIVATE_COLUMN)}),
        ("minMaxScale", {"column": public_ref("private", PRIVATE_COLUMN)}),
        (
            "roundNumber",
            {"column": public_ref("c:source:3", "value"), "newColumn": PRIVATE_COLUMN},
        ),
        ("floorNumber", {"column": public_ref("private", PRIVATE_COLUMN)}),
        ("ceilNumber", {"column": public_ref("private", PRIVATE_COLUMN)}),
        ("formatDatetime", {"column": public_ref("private", PRIVATE_COLUMN), "format": "%Y"}),
        (
            "groupBy",
            {
                "keys": [public_ref("c:source:0", "group")],
                "aggregations": [
                    {"column": public_ref("private", PRIVATE_COLUMN), "operation": "first", "alias": "leaked"}
                ],
            },
        ),
        (
            "groupBy",
            {
                "keys": [public_ref("c:source:0", "group")],
                "aggregations": [
                    {"column": public_ref("c:source:3", "value"), "operation": "sum", "alias": PRIVATE_COLUMN}
                ],
            },
        ),
        (
            "byExample",
            {
                "sourceColumns": [public_ref("private", PRIVATE_COLUMN)],
                "newColumn": "result",
                "examples": [
                    {"inputs": ["a"], "output": "x"},
                    {"inputs": ["b"], "output": "x"},
                ],
                "program": {"kind": "literal", "value": "x"},
            },
        ),
    ],
)
def test_every_explicit_operation_column_slot_rejects_the_private_namespace(kind, params) -> None:
    with pytest.raises(OperationError, match="reserved private row-identity prefix"):
        validate_step({"id": f"private-{kind}", "kind": kind, "params": params})


def test_rows_and_order_operations(engine_and_frame):
    engine, frame = engine_and_frame
    sorted_frame = engine.apply_transform(
        frame,
        bound_step(
            "sort",
            "sortRows",
            rules=[
                {
                    "column": bound_ref("c:source:3", "value", 3),
                    "direction": "desc",
                    "nulls": "last",
                }
            ],
        ),
    )
    assert [record["value"] for record in records(sorted_frame)[:2]] == [2.8, 2.8]

    filtered = engine.apply_transform(
        frame,
        bound_step(
            "filter",
            "filterRows",
            filterModel={
                "logic": "and",
                "filters": [
                    {
                        "column": bound_ref("c:source:1", "text", 1),
                        "type": "string",
                        "logic": "and",
                        "predicates": [{"kind": "predicate", "operator": "contains", "value": "alpha"}],
                    }
                ],
                "sort": [],
            },
        ),
    )
    assert len(records(filtered)) == 2

    without_missing = engine.apply_transform(
        frame,
        bound_step(
            "missing",
            "dropMissingRows",
            columns=[bound_ref("c:source:3", "value", 3)],
            how="any",
        ),
    )
    assert len(records(without_missing)) == 3

    duplicates = engine.apply_transform(
        frame,
        bound_step(
            "duplicates",
            "dropDuplicates",
            columns=[
                bound_ref("c:source:3", "value", 3),
                bound_ref("c:source:4", "other", 4),
            ],
            keep="first",
        ),
    )
    assert len(records(duplicates)) == 3


def test_column_and_type_operations_match_generated_code(engine_and_frame):
    engine, frame = engine_and_frame
    plan = [
        bound_step(
            "clone",
            "cloneColumn",
            column=bound_ref("c:source:3", "value", 3),
            newName="value_copy",
        ),
        bound_step(
            "formula",
            "formula",
            leftColumn=bound_ref("c:source:4", "other", 4),
            operator="multiply",
            value=10,
            newColumn="score",
        ),
        bound_step(
            "length",
            "textLength",
            column=bound_ref("c:source:1", "text", 1),
            newColumn="text_length",
        ),
        bound_step(
            "cast",
            "castColumn",
            column=bound_ref("c:source:4", "other", 4),
            dtype="float",
        ),
        bound_step(
            "rename",
            "renameColumn",
            column=bound_ref("c:source:0", "group", 0),
            newName="category",
        ),
        bound_step(
            "drop",
            "dropColumns",
            columns=[
                bound_ref("c:source:2", "tags", 2),
                bound_ref("c:source:5", "date", 5),
            ],
        ),
        bound_step(
            "select",
            "selectColumns",
            columns=[
                bound_ref("c:source:0", "category", 0),
                bound_ref("c:source:1", "text", 1),
                bound_ref("c:source:3", "value", 2),
                bound_ref("c:source:4", "other", 3),
                bound_ref("c:step:clone:0", "value_copy", 4),
                bound_ref("c:step:formula:0", "score", 5),
                bound_ref("c:step:length:0", "text_length", 6),
            ],
        ),
    ]
    transformed = apply_plan(engine, frame, plan)
    result = records(transformed)
    assert list(result[0]) == ["category", "text", "value", "other", "value_copy", "score", "text_length"]
    assert result[0]["category"] == "a"
    assert result[0]["score"] == 20
    assert result[0]["text_length"] == 11
    assert_semantically_equal(transformed, execute_generated(engine, frame, plan))


@pytest.mark.parametrize(
    ("target", "values", "expected_dtype", "expected_values"),
    [
        ("string", [1, None], "string", ["1", pd.NA]),
        ("integer", ["7", None], "Int64", [7, pd.NA]),
        ("float", ["1.5", None], "Float64", [1.5, pd.NA]),
        ("boolean", [1, 0, None], "boolean", [True, False, pd.NA]),
        (
            "date",
            [0, 2**63, None],
            "object",
            [date(1970, 1, 1), pd.NaT, pd.NaT],
        ),
        (
            "datetime",
            [0, 1_000_000, 2**63, None],
            "datetime64[ns]",
            [datetime(1970, 1, 1), datetime(1970, 1, 1, 0, 0, 0, 1_000), pd.NaT, pd.NaT],
        ),
    ],
)
def test_pandas_cast_targets_match_generated_dtype_and_coercion(
    target: str,
    values: list[Any],
    expected_dtype: str,
    expected_values: list[Any],
) -> None:
    engine = PandasEngine()
    frame = pd.DataFrame({"value": pd.Series(values, dtype=object)})
    operation = bound_step(
        f"cast-{target}",
        "castColumn",
        column=bound_ref("c:source:0", "value", 0),
        dtype=target,
    )

    live = engine.apply_transform(frame, operation)
    generated = execute_generated(engine, frame, [operation])
    expected = pd.Series(expected_values, dtype=expected_dtype, name="value")

    pd.testing.assert_series_equal(live["value"], expected)
    pd.testing.assert_series_equal(generated["value"], expected)


@pytest.mark.parametrize(
    ("target", "values", "expected_dtype", "expected_values"),
    [
        ("string", [1, None], pl.String, ["1", None]),
        ("integer", ["7", "bad", None], pl.Int64, [7, None, None]),
        ("float", ["1.5", "bad", None], pl.Float64, [1.5, None, None]),
        ("boolean", [1, 0, None], pl.Boolean, [True, False, None]),
        ("date", [0, 2**31, None], pl.Date, [date(1970, 1, 1), None, None]),
        (
            "datetime",
            [0.0, 1_000_000.0, float("nan"), None],
            pl.Datetime,
            [datetime(1970, 1, 1), datetime(1970, 1, 1, 0, 0, 1), None, None],
        ),
    ],
)
def test_polars_cast_targets_match_generated_dtype_and_coercion(
    target: str,
    values: list[Any],
    expected_dtype: Any,
    expected_values: list[Any],
) -> None:
    engine = PolarsEngine()
    frame = pl.DataFrame({"value": values})
    operation = bound_step(
        f"cast-{target}",
        "castColumn",
        column=bound_ref("c:source:0", "value", 0),
        dtype=target,
    )

    live = engine.apply_transform(frame, operation)
    generated = execute_generated(engine, frame, [operation])

    assert live.get_column("value").dtype == expected_dtype
    assert generated.get_column("value").dtype == expected_dtype
    assert live.get_column("value").to_list() == expected_values
    assert_semantically_equal(live, generated)


@pytest.mark.parametrize(
    "public_step",
    [
        {
            "id": "unbound-cast",
            "kind": "castColumn",
            "params": {"column": public_ref("c:source:3", "value"), "dtype": "float"},
        },
        {
            "id": "unbound-hot",
            "kind": "oneHotEncode",
            "params": {"columns": [public_ref("c:source:0", "group")]},
        },
        {
            "id": "unbound-upper",
            "kind": "upperText",
            "params": {"column": public_ref("c:source:1", "text")},
        },
        {
            "id": "unbound-round",
            "kind": "roundNumber",
            "params": {"column": public_ref("c:source:3", "value")},
        },
        {
            "id": "unbound-date",
            "kind": "formatDatetime",
            "params": {"column": public_ref("c:source:5", "date"), "format": "%Y"},
        },
    ],
)
def test_adapters_reject_public_references_before_execution(engine_and_frame, public_step):
    engine, frame = engine_and_frame

    with pytest.raises(EngineError, match="requires a bound column reference"):
        engine.apply_transform(frame, public_step)
    with pytest.raises(EngineError, match="requires a bound column reference"):
        engine.compile_plan([public_step])


def test_pandas_live_and_generated_code_reject_stale_reordered_binding() -> None:
    engine = PandasEngine()
    frame = pd.DataFrame({"first": [1, 2], "second": [10, 20]})
    operation = bound_step(
        "clone-first",
        "cloneColumn",
        column=bound_ref("c:source:0", "first", 0),
        newName="first_copy",
    )
    reordered = frame.iloc[:, [1, 0]]

    with pytest.raises(EngineError, match="column binding no longer matches"):
        engine.apply_transform(reordered, operation)
    with pytest.raises(ValueError, match="column binding no longer matches"):
        execute_generated(engine, reordered, [operation])


def test_pandas_bound_structural_operations_target_duplicate_and_non_string_columns():
    engine = PandasEngine()
    frame = pd.DataFrame(
        [
            [1, 10, 100, "ab"],
            [2, 20, 200, "c"],
        ],
        columns=pd.Index(["duplicate", "duplicate", 7, "text"], dtype=object),
    )

    selected = assert_pandas_live_matches_generated(
        engine,
        frame,
        bound_step(
            "select-exact",
            "selectColumns",
            columns=[
                bound_ref("c:source:1", "duplicate", 1),
                bound_ref("c:source:2", "7", 2),
                bound_ref("c:source:0", "duplicate", 0),
            ],
        ),
    )
    assert list(selected.columns) == ["duplicate", 7, "duplicate"]
    assert selected.iloc[:, 0].tolist() == [10, 20]
    assert selected.iloc[:, 1].tolist() == [100, 200]
    assert selected.iloc[:, 2].tolist() == [1, 2]

    dropped = assert_pandas_live_matches_generated(
        engine,
        frame,
        bound_step(
            "drop-exact",
            "dropColumns",
            columns=[bound_ref("c:source:0", "duplicate", 0)],
        ),
    )
    assert list(dropped.columns) == ["duplicate", 7, "text"]
    assert dropped.iloc[:, 0].tolist() == [10, 20]

    renamed = assert_pandas_live_matches_generated(
        engine,
        frame,
        bound_step(
            "rename-exact",
            "renameColumn",
            column=bound_ref("c:source:1", "duplicate", 1),
            newName="renamed_duplicate",
        ),
    )
    assert list(renamed.columns) == ["duplicate", "renamed_duplicate", 7, "text"]
    assert renamed["duplicate"].tolist() == [1, 2]
    assert renamed["renamed_duplicate"].tolist() == [10, 20]

    cloned = assert_pandas_live_matches_generated(
        engine,
        frame,
        bound_step(
            "clone-exact",
            "cloneColumn",
            column=bound_ref("c:source:1", "duplicate", 1),
            newName="duplicate_copy",
        ),
    )
    assert cloned["duplicate_copy"].tolist() == [10, 20]

    cast = assert_pandas_live_matches_generated(
        engine,
        frame,
        bound_step(
            "cast-exact",
            "castColumn",
            column=bound_ref("c:source:2", "7", 2),
            dtype="float",
        ),
    )
    assert cast.iloc[:, 0].tolist() == [1, 2]
    assert cast.iloc[:, 1].tolist() == [10, 20]
    assert cast.iloc[:, 2].tolist() == [100.0, 200.0]
    assert str(cast.iloc[:, 2].dtype) == "Float64"

    formula = assert_pandas_live_matches_generated(
        engine,
        frame,
        bound_step(
            "formula-exact",
            "formula",
            leftColumn=bound_ref("c:source:0", "duplicate", 0),
            operator="add",
            rightColumn=bound_ref("c:source:1", "duplicate", 1),
            newColumn="sum",
        ),
    )
    assert formula["sum"].tolist() == [11, 22]

    lengths = assert_pandas_live_matches_generated(
        engine,
        frame,
        bound_step(
            "length-exact",
            "textLength",
            column=bound_ref("c:source:3", "text", 3),
            newColumn="text_length",
        ),
    )
    assert lengths["text_length"].tolist() == [2, 1]


@pytest.mark.parametrize(
    ("operation", "existing_position", "existing_values", "output_name", "output_values"),
    [
        (
            bound_step(
                "clone-multiindex",
                "cloneColumn",
                column=bound_ref("c:source:0", "('number', 'input')", 0),
                newName="clone_flat",
            ),
            2,
            [101, 102],
            "clone_flat",
            [1, 2],
        ),
        (
            bound_step(
                "formula-multiindex",
                "formula",
                leftColumn=bound_ref("c:source:0", "('number', 'input')", 0),
                operator="add",
                value=10,
                newColumn="formula_flat",
            ),
            3,
            [201, 202],
            "formula_flat",
            [11, 12],
        ),
        (
            bound_step(
                "length-multiindex",
                "textLength",
                column=bound_ref("c:source:1", "('text', 'input')", 1),
                newColumn="length_flat",
            ),
            4,
            [301, 302],
            "length_flat",
            [2, 1],
        ),
    ],
)
def test_pandas_multiindex_derived_columns_append_flat_labels_without_overwriting(
    operation: dict,
    existing_position: int,
    existing_values: list[int],
    output_name: str,
    output_values: list[int],
) -> None:
    engine = PandasEngine()
    frame = pd.DataFrame(
        [
            [1, "ab", 101, 201, 301],
            [2, "c", 102, 202, 302],
        ],
        columns=pd.MultiIndex.from_tuples(
            [
                ("number", "input"),
                ("text", "input"),
                ("clone_flat", "existing"),
                ("formula_flat", "existing"),
                ("length_flat", "existing"),
            ]
        ),
    )

    result = assert_pandas_live_matches_generated(engine, frame, operation)

    assert list(result.columns[:-1]) == list(frame.columns)
    assert len(result.columns) == len(frame.columns) + 1
    assert result.columns[-1] == output_name
    assert result.iloc[:, existing_position].tolist() == existing_values
    assert result.iloc[:, -1].tolist() == output_values


def test_text_operations(engine_and_frame):
    engine, frame = engine_and_frame
    plan = [
        bound_step("strip", "stripText", column=bound_ref("c:source:1", "text", 1), newColumn="clean"),
        bound_step(
            "replace",
            "findReplace",
            column=bound_ref("c:source:1", "text", 1),
            find="-",
            replacement=" ",
            newColumn="replaced",
        ),
        bound_step(
            "split",
            "splitText",
            column=bound_ref("c:source:1", "text", 1),
            delimiter="-",
            index=1,
            newColumn="suffix",
        ),
        bound_step("lower", "lowerText", column=bound_ref("c:source:1", "text", 1), newColumn="lower"),
        bound_step("upper", "upperText", column=bound_ref("c:source:1", "text", 1), newColumn="upper"),
        bound_step(
            "capitalize",
            "capitalizeText",
            column=bound_ref("c:source:1", "text", 1),
            newColumn="capitalized",
        ),
    ]
    transformed = apply_plan(engine, frame, plan)
    result = records(transformed)
    assert result[0]["clean"] == "alpha-one"
    assert result[0]["replaced"] == " alpha one "
    assert result[1]["suffix"] == "two"
    assert result[1]["lower"] == "beta-two"
    assert result[1]["upper"] == "BETA-TWO"
    assert result[1]["capitalized"] == "Beta-two"
    assert_semantically_equal(transformed, execute_generated(engine, frame, plan))


def test_categorical_encoders(engine_and_frame):
    engine, frame = engine_and_frame
    one_hot = bound_step(
        "one-hot",
        "oneHotEncode",
        columns=[bound_ref("c:source:0", "group", 0)],
        prefixSeparator="_",
        dropOriginal=False,
    )
    encoded = engine.apply_transform(frame, one_hot)
    result = records(encoded)
    assert result[0]["group_a"] == 1
    assert result[2]["group_b"] == 1
    assert_semantically_equal(encoded, execute_generated(engine, frame, [one_hot]))

    multi_label = bound_step(
        "multi-label",
        "multiLabelBinarize",
        column=bound_ref("c:source:2", "tags", 2),
        delimiter="|",
        prefix="tag_",
        dropOriginal=False,
    )
    multilabel = engine.apply_transform(frame, multi_label)
    result = records(multilabel)
    assert result[0]["tag_blue"] == 1
    assert result[0]["tag_red"] == 1
    assert result[1]["tag_red"] == 0
    assert_semantically_equal(multilabel, execute_generated(engine, frame, [multi_label]))


def test_numeric_datetime_grouping_and_custom_code(engine_and_frame):
    engine, frame = engine_and_frame
    numeric_plan = [
        bound_step(
            "scale",
            "minMaxScale",
            column=bound_ref("c:source:3", "value", 3),
            newColumn="scaled",
        ),
        bound_step(
            "round",
            "roundNumber",
            column=bound_ref("c:source:3", "value", 3),
            decimals=0,
            newColumn="rounded",
        ),
        bound_step(
            "floor",
            "floorNumber",
            column=bound_ref("c:source:3", "value", 3),
            newColumn="floored",
        ),
        bound_step(
            "ceil",
            "ceilNumber",
            column=bound_ref("c:source:3", "value", 3),
            newColumn="ceiled",
        ),
        bound_step(
            "date",
            "formatDatetime",
            column=bound_ref("c:source:5", "date", 5),
            format="%Y/%m",
            newColumn="month",
        ),
    ]
    numeric = apply_plan(engine, frame, numeric_plan)
    result = records(numeric)
    assert result[0]["scaled"] == 0.0
    assert result[1]["scaled"] == pytest.approx(1.0)
    assert result[0]["rounded"] == 1.0
    assert result[0]["floored"] == 1.0
    assert result[0]["ceiled"] == 2.0
    assert result[0]["month"] == "2024/01"
    assert_semantically_equal(numeric, execute_generated(engine, frame, numeric_plan))

    grouped = engine.apply_transform(
        frame,
        bound_step(
            "group",
            "groupBy",
            keys=[bound_ref("c:source:0", "group", 0)],
            aggregations=[
                {"column": bound_ref("c:source:3", "value", 3), "operation": "sum", "alias": "total"},
                {"column": bound_ref("c:source:4", "other", 4), "operation": "mean", "alias": "average"},
                {"column": bound_ref("c:source:1", "text", 1), "operation": "count", "alias": "texts"},
                {"column": bound_ref("c:source:2", "tags", 2), "operation": "nUnique", "alias": "tag_sets"},
            ],
        ),
    )
    grouped_result = records(grouped)
    assert grouped_result[0] == {"group": "a", "total": 4.0, "average": 2.5, "texts": 2, "tag_sets": 2}

    code = (
        "result = df[df['other'] > 2]"
        if isinstance(engine, PandasEngine)
        else "result = df.filter(pl.col('other') > 2)"
    )
    custom = engine.apply_transform(frame, step("custom", "customCode", code=code))
    assert len(records(custom)) == 3
    assert_semantically_equal(
        custom, execute_generated(engine, frame, [step("custom-generated", "customCode", code=code)])
    )


def test_pandas_group_semantic_classes_match_generated_code() -> None:
    engine = PandasEngine()
    frame = pd.DataFrame(
        {
            "group": ["a", "a", "b", "b"],
            "integer": pd.Series([2**63 - 1, 1, pd.NA, pd.NA], dtype="Int64"),
            "decimal": pd.Series([Decimal("1.10"), Decimal("2.20"), None, None], dtype=object),
            "value": [float("nan"), 1.5, float("nan"), None],
        }
    )
    operation = bound_step(
        "group-semantics",
        "groupBy",
        keys=[bound_ref("c:source:0", "group", 0)],
        aggregations=[
            {"column": bound_ref("c:source:1", "integer", 1), "operation": "sum", "alias": "total"},
            {"column": bound_ref("c:source:1", "integer", 1), "operation": "first", "alias": "first"},
            {"column": bound_ref("c:source:2", "decimal", 2), "operation": "mean", "alias": "average"},
            {"column": bound_ref("c:source:3", "value", 3), "operation": "nUnique", "alias": "unique"},
        ],
    )

    result = assert_pandas_live_matches_generated(engine, frame, operation)

    assert result["group"].tolist() == ["a", "b"]
    assert result["total"].tolist() == [2**63, 0]
    assert result["first"].iloc[0] == 2**63 - 1
    assert result["first"].iloc[1] is pd.NA
    assert result["average"].iloc[0] == pytest.approx(1.65)
    assert pd.isna(result["average"].iloc[1])
    assert result["unique"].tolist() == [1, 0]


@pytest.mark.parametrize("lazy", [False, True])
def test_polars_group_missing_value_aggregations_match_generated_code(lazy: bool) -> None:
    engine = PolarsEngine()
    eager = pl.DataFrame(
        {
            "group": ["a", "a", "a", "a", "b", "b"],
            "value": [float("nan"), None, 1.5, 2.5, float("nan"), None],
        }
    )
    frame = eager.lazy() if lazy else eager
    operation = bound_step(
        "group-missing-values",
        "groupBy",
        keys=[bound_ref("c:source:0", "group", 0)],
        aggregations=[
            {
                "column": bound_ref("c:source:1", "value", 1),
                "operation": aggregation,
                "alias": aggregation,
            }
            for aggregation in ("count", "nUnique", "first", "last")
        ],
    )

    live = engine.apply_transform(frame, operation)
    generated = execute_generated(engine, frame, [operation])

    assert records(live) == [
        {"group": "a", "count": 2, "nUnique": 2, "first": 1.5, "last": 2.5},
        {"group": "b", "count": 0, "nUnique": 0, "first": None, "last": None},
    ]
    assert_semantically_equal(live, generated)


def test_by_example_is_native_and_generated_code_matches(engine_and_frame):
    engine, frame = engine_and_frame
    public_plan = [
        step(
            "example-label",
            "byExample",
            sourceColumns=[public_ref("c:source:0", "group"), public_ref("c:source:4", "other")],
            newColumn="label",
            examples=[
                {"inputs": ["a", 2], "output": "a-2"},
                {"inputs": ["b", 4], "output": "b-4"},
            ],
        ),
        step(
            "example-month",
            "byExample",
            sourceColumns=[public_ref("c:source:5", "date")],
            newColumn="month",
            examples=[
                {"inputs": ["2024-01-02"], "output": "01/2024"},
                {"inputs": ["2024-02-03"], "output": "02/2024"},
            ],
        ),
        step(
            "example-score",
            "byExample",
            sourceColumns=[public_ref("c:source:3", "value"), public_ref("c:source:4", "other")],
            newColumn="score",
            examples=[
                {"inputs": [1.2, 2], "output": 3.2},
                {"inputs": [2.8, 3], "output": 5.8},
            ],
        ),
    ]
    assert [operation["params"]["program"]["kind"] for operation in public_plan] == [
        "concat",
        "datetimeFormat",
        "arithmetic",
    ]
    schema = engine.schema(frame)
    lineage = source_lineage(schema)
    plan = [bind_step(operation, schema, lineage) for operation in public_plan]
    transformed = apply_plan(engine, frame, plan)
    assert [row["label"] for row in records(transformed)] == ["a-2", "a-3", "b-4", "b-3"]
    assert [row["month"] for row in records(transformed)] == ["01/2024", "02/2024", "03/2024", "02/2024"]
    assert records(transformed)[0]["score"] == pytest.approx(3.2)
    assert_semantically_equal(transformed, execute_generated(engine, frame, plan))


def apply_plan(engine, frame, plan):
    result = frame
    for operation in plan:
        result = engine.apply_transform(result, operation)
    return result


def execute_generated(engine, frame, plan):
    namespace = {}
    exec(engine.compile_plan(plan), namespace, namespace)
    return namespace["clean_data"](frame)


def assert_pandas_live_matches_generated(
    engine: PandasEngine,
    frame: pd.DataFrame,
    operation: dict,
) -> pd.DataFrame:
    live = engine.apply_transform(frame, operation)
    generated = execute_generated(engine, frame, [operation])
    pd.testing.assert_frame_equal(live, generated)
    return live


def records(frame):
    if isinstance(frame, pl.LazyFrame):
        frame = frame.collect()
    if isinstance(frame, pl.DataFrame):
        return frame.to_dicts()
    return frame.to_dict(orient="records")


def assert_semantically_equal(left, right):
    left_records = records(left)
    right_records = records(right)
    assert len(left_records) == len(right_records)
    assert [list(item) for item in left_records] == [list(item) for item in right_records]
    for left_row, right_row in zip(left_records, right_records, strict=True):
        for key in left_row:
            left_value = left_row[key]
            right_value = right_row[key]
            if isinstance(left_value, float) and isnan(left_value):
                assert isinstance(right_value, float) and isnan(right_value)
            elif pd.isna(left_value) and pd.isna(right_value):
                continue
            else:
                assert left_value == right_value
