from __future__ import annotations

from copy import deepcopy

import pytest

from openwrangler_runtime.engines.base import reconcile_view_filter_model
from openwrangler_runtime.session import SessionManager


def source_ref(position: int, name: str) -> dict[str, str]:
    return {"id": f"c:source:{position}", "name": name}


def transform(step_id: str, kind: str, **params):
    return {"id": step_id, "kind": kind, "params": params}


def full_view() -> dict:
    return {
        "logic": "and",
        "filters": [
            {
                "column": "market",
                "type": "string",
                "logic": "and",
                "valueFilter": {
                    "kind": "values",
                    "selectedValues": ["DACH"],
                    "includeNulls": False,
                    "includeNaN": False,
                    "search": "da",
                },
                "predicates": [{"kind": "predicate", "operator": "contains", "value": "a"}],
            },
            {
                "column": "revenue",
                "type": "integer",
                "predicates": [
                    {
                        "kind": "predicate",
                        "operator": "between",
                        "value": 10,
                        "secondValue": 35,
                    }
                ],
            },
            {
                "column": "region",
                "type": "string",
                "predicates": [{"kind": "predicate", "operator": "notEquals", "value": "blocked"}],
            },
        ],
        "sort": [
            {"column": "revenue", "direction": "desc", "nulls": "last"},
            {"column": "market", "direction": "asc", "nulls": "last"},
            {"column": "region", "direction": "asc", "nulls": "first"},
        ],
    }


def open_viewed_session(tmp_path, backend: str) -> tuple[SessionManager, str]:
    path = tmp_path / f"view-plan-{backend}.csv"
    path.write_text(
        "market,revenue,region\nDACH,30,south\nDACH,20,north\nDACH,5,east\nIberia,40,west\n",
        encoding="utf-8",
    )
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend=backend,
        page_size=10,
    )
    session_id = opened["metadata"]["sessionId"]
    page = manager.get_page(session_id, 0, 0, 10, full_view())
    assert [row["values"][1]["display"] for row in page["page"]["rows"]] == ["30", "20"]
    return manager, session_id


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_add_edit_apply_and_undo_preserve_the_complete_compatible_view(tmp_path, backend):
    manager, session_id = open_viewed_session(tmp_path, backend)
    expected_view = full_view()

    preview = manager.preview_step(
        session_id,
        0,
        transform(
            "region-copy",
            "cloneColumn",
            column=source_ref(2, "region"),
            newName="region_shadow",
        ),
        0,
        10,
    )
    assert preview["metadata"]["filterModel"] == expected_view
    assert [row["values"][1]["display"] for row in preview["page"]["rows"]] == ["30", "20"]

    applied = manager.apply_draft(session_id, 1, 0, 10)
    assert applied["metadata"]["filterModel"] == expected_view

    edited_preview = manager.preview_step(
        session_id,
        2,
        transform(
            "region-copy",
            "cloneColumn",
            column=source_ref(2, "region"),
            newName="region_copy",
        ),
        0,
        10,
        replace_step_id="region-copy",
    )
    assert edited_preview["metadata"]["filterModel"] == expected_view

    edited = manager.apply_draft(session_id, 3, 0, 10)
    assert edited["metadata"]["filterModel"] == expected_view
    assert [rule["column"] for rule in edited["metadata"]["filterModel"]["sort"]] == [
        "revenue",
        "market",
        "region",
    ]

    undone = manager.undo_step(session_id, 4, 0, 10)
    assert undone["metadata"]["filterModel"] == expected_view
    assert [row["values"][1]["display"] for row in undone["page"]["rows"]] == ["30", "20"]


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_structural_and_type_changes_prune_only_incompatible_view_rules(tmp_path, backend):
    manager, session_id = open_viewed_session(tmp_path, backend)
    initial = full_view()

    dropped_preview = manager.preview_step(
        session_id,
        0,
        transform("drop-market", "dropColumns", columns=[source_ref(0, "market")]),
        0,
        10,
    )
    after_drop = deepcopy(initial)
    after_drop["filters"] = [item for item in after_drop["filters"] if item["column"] != "market"]
    after_drop["sort"] = [item for item in after_drop["sort"] if item["column"] != "market"]
    assert dropped_preview["metadata"]["filterModel"] == after_drop
    assert dropped_preview["diff"]["addedRows"] == 0
    assert dropped_preview["diff"]["removedRows"] == 0
    assert [row["values"][0]["display"] for row in dropped_preview["page"]["rows"]] == ["30", "20"]

    discarded = manager.discard_draft(session_id, 1, 0, 10)
    assert discarded["metadata"]["filterModel"] == initial

    manager.preview_step(
        session_id,
        2,
        transform("drop-market", "dropColumns", columns=[source_ref(0, "market")]),
        0,
        10,
    )
    dropped = manager.apply_draft(session_id, 3, 0, 10)
    assert dropped["metadata"]["filterModel"] == after_drop

    undone = manager.undo_step(session_id, 4, 0, 10)
    assert undone["metadata"]["filterModel"] == initial

    manager.preview_step(
        session_id,
        5,
        transform("drop-market", "dropColumns", columns=[source_ref(0, "market")]),
        0,
        10,
    )
    manager.apply_draft(session_id, 6, 0, 10)
    user_view = deepcopy(after_drop)
    user_view["sort"] = list(reversed(user_view["sort"]))
    manager.get_page(session_id, 7, 0, 10, user_view)

    undone_after_view_change = manager.undo_step(session_id, 7, 0, 10)
    assert undone_after_view_change["metadata"]["filterModel"] == user_view

    cast_preview = manager.preview_step(
        session_id,
        8,
        transform("cast-revenue", "castColumn", column=source_ref(1, "revenue"), dtype="string"),
        0,
        10,
    )
    after_cast = deepcopy(user_view)
    after_cast["filters"] = [item for item in after_cast["filters"] if item["column"] != "revenue"]
    after_cast["sort"] = [item for item in after_cast["sort"] if item["column"] != "revenue"]
    assert cast_preview["metadata"]["filterModel"] == after_cast
    assert [rule["column"] for rule in cast_preview["metadata"]["filterModel"]["sort"]] == [
        "region",
    ]

    discarded_cast = manager.discard_draft(session_id, 9, 0, 10)
    assert discarded_cast["metadata"]["filterModel"] == user_view

    manager.preview_step(
        session_id,
        10,
        transform("cast-revenue", "castColumn", column=source_ref(1, "revenue"), dtype="string"),
        0,
        10,
    )
    applied_cast = manager.apply_draft(session_id, 11, 0, 10)
    assert applied_cast["metadata"]["filterModel"] == after_cast

    undone_cast = manager.undo_step(session_id, 12, 0, 10)
    assert undone_cast["metadata"]["filterModel"] == user_view


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_view_edit_during_draft_remains_authoritative_after_apply_and_immediate_undo(tmp_path, backend):
    manager, session_id = open_viewed_session(tmp_path, backend)
    manager.preview_step(
        session_id,
        0,
        transform(
            "region-copy",
            "cloneColumn",
            column=source_ref(2, "region"),
            newName="region_shadow",
        ),
        0,
        10,
    )

    user_view = full_view()
    user_view["filters"] = [item for item in user_view["filters"] if item["column"] == "region"]
    user_view["sort"] = [
        {"column": "region", "direction": "desc", "nulls": "last"},
        {"column": "revenue", "direction": "asc", "nulls": "first"},
    ]
    edited_page = manager.get_page(session_id, 1, 0, 10, user_view)
    assert edited_page["metadata"]["filterModel"] == user_view

    applied = manager.apply_draft(session_id, 1, 0, 10)
    assert applied["metadata"]["filterModel"] == user_view

    undone = manager.undo_step(session_id, 2, 0, 10)
    assert undone["metadata"]["filterModel"] == user_view


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_view_edit_during_draft_remains_authoritative_when_discarded(tmp_path, backend):
    manager, session_id = open_viewed_session(tmp_path, backend)
    manager.preview_step(
        session_id,
        0,
        transform(
            "region-copy",
            "cloneColumn",
            column=source_ref(2, "region"),
            newName="region_shadow",
        ),
        0,
        10,
    )
    user_view = full_view()
    user_view["filters"] = [item for item in user_view["filters"] if item["column"] == "region"]
    user_view["sort"] = [
        {"column": "region", "direction": "desc", "nulls": "last"},
        {"column": "revenue", "direction": "asc", "nulls": "first"},
    ]
    manager.get_page(session_id, 1, 0, 10, user_view)

    discarded = manager.discard_draft(session_id, 1, 0, 10)
    assert discarded["metadata"]["filterModel"] == user_view


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_latest_step_replacement_preserves_original_undo_view_receipt(tmp_path, backend):
    manager, session_id = open_viewed_session(tmp_path, backend)
    original_view = full_view()
    manager.preview_step(
        session_id,
        0,
        transform("drop-columns", "dropColumns", columns=[source_ref(0, "market")]),
        0,
        10,
    )
    applied = manager.apply_draft(session_id, 1, 0, 10)
    assert [item["column"] for item in applied["metadata"]["filterModel"]["filters"]] == [
        "revenue",
        "region",
    ]

    edited_preview = manager.preview_step(
        session_id,
        2,
        transform(
            "drop-columns",
            "dropColumns",
            columns=[source_ref(0, "market"), source_ref(2, "region")],
        ),
        0,
        10,
        replace_step_id="drop-columns",
    )
    assert [item["column"] for item in edited_preview["metadata"]["filterModel"]["filters"]] == ["revenue"]
    manager.apply_draft(session_id, 3, 0, 10)

    undone = manager.undo_step(session_id, 4, 0, 10)
    assert undone["metadata"]["filterModel"] == original_view


def test_reconciliation_rejects_ambiguous_names_and_noncomparable_sorts_without_reordering_survivors():
    model = full_view()
    schema = [
        {"name": "market", "type": "string"},
        {"name": "market", "type": "string"},
        {"name": "revenue", "type": "list"},
        {"name": "region", "type": "string"},
    ]

    reconciled = reconcile_view_filter_model(model, schema)

    assert [item["column"] for item in reconciled["filters"]] == ["region"]
    assert [item["column"] for item in reconciled["sort"]] == ["region"]
    assert reconciled["logic"] == "and"
