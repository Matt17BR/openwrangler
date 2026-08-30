from __future__ import annotations

from copy import deepcopy
from typing import Any

import pytest

from openwrangler_runtime.engines import EngineError
from openwrangler_runtime.session_result import (
    column_window,
    summary_projection,
    validate_summary_projection,
)

SCHEMA: list[dict[str, Any]] = [
    {
        "id": "c:source:0",
        "position": 0,
        "name": "name",
        "type": "string",
        "rawType": "object",
    },
    {
        "id": "c:source:1",
        "position": 1,
        "name": "value",
        "type": "integer",
        "rawType": "int64",
    },
]


def test_page_column_window_preserves_schema_order_and_accepts_an_empty_tail() -> None:
    assert column_window(SCHEMA, 0, 2) == [(0, "c:source:0"), (1, "c:source:1")]
    assert column_window(SCHEMA, 1, 1) == [(1, "c:source:1")]
    assert column_window(SCHEMA, 20, 1) == []


@pytest.mark.parametrize(
    ("column_offset", "column_limit"),
    [(-1, 1), (True, 1), (0, 0), (0, 257), (0, True)],
)
def test_page_column_window_rejects_invalid_bounds(column_offset: int, column_limit: int) -> None:
    with pytest.raises(EngineError, match="columnOffset|columnLimit"):
        column_window(SCHEMA, column_offset, column_limit)


def test_summary_projection_preserves_requested_stable_identity_order() -> None:
    assert summary_projection(SCHEMA, None) == [(0, "c:source:0"), (1, "c:source:1")]
    assert summary_projection(SCHEMA, ["c:source:1", "c:source:0"]) == [
        (1, "c:source:1"),
        (0, "c:source:0"),
    ]


@pytest.mark.parametrize(
    ("column_ids", "message"),
    [
        ([], "non-empty unique list"),
        (["c:source:0", "c:source:0"], "non-empty unique list"),
        (["c:missing"], "Unknown summary column identity"),
    ],
)
def test_summary_projection_rejects_invalid_stable_identities(
    column_ids: list[str],
    message: str,
) -> None:
    with pytest.raises(EngineError, match=message):
        summary_projection(SCHEMA, column_ids)


@pytest.mark.parametrize(
    ("corruption", "message"),
    [
        ("reverse", "wrong column projection"),
        ("missing", "wrong column projection"),
        ("duplicate", "wrong column projection"),
        ("unknown", "wrong column projection"),
        ("name", "does not match the active schema"),
        ("type", "does not match the active schema"),
        ("rawType", "does not match the active schema"),
    ],
)
def test_summary_results_must_match_the_exact_projection_and_schema(
    corruption: str,
    message: str,
) -> None:
    projection = summary_projection(SCHEMA, ["c:source:1", "c:source:0"])
    summaries = [
        {
            "columnId": "c:source:1",
            "column": "value",
            "type": "integer",
            "rawType": "int64",
        },
        {
            "columnId": "c:source:0",
            "column": "name",
            "type": "string",
            "rawType": "object",
        },
    ]
    corrupted = deepcopy(summaries)
    if corruption == "reverse":
        corrupted.reverse()
    elif corruption == "missing":
        corrupted.pop()
    elif corruption == "duplicate":
        corrupted[1]["columnId"] = corrupted[0]["columnId"]
    elif corruption == "unknown":
        corrupted[0]["columnId"] = "c:unknown"
    elif corruption == "name":
        corrupted[0]["column"] = "renamed"
    elif corruption == "type":
        corrupted[0]["type"] = "string"
    elif corruption == "rawType":
        corrupted[0]["rawType"] = "String"
    else:
        raise AssertionError(f"Unknown summary corruption: {corruption}")

    with pytest.raises(EngineError, match=message):
        validate_summary_projection(corrupted, SCHEMA, projection)
