from __future__ import annotations

from typing import Any

from openwrangler_runtime.engines._generated_checks import (
    CheckedColumn,
    NewColumnName,
    plan_check_segments,
)


def ref(identifier: str, name: str, position: int, raw_type: str = "int64", column_type: str = "integer") -> dict:
    return {"id": identifier, "name": name, "position": position, "rawType": raw_type, "type": column_type}


def step(step_id: str, kind: str, **params: Any) -> dict[str, Any]:
    return {"id": step_id, "kind": kind, "params": params}


UNITS = ref("c:source:0", "units", 0)
PRICE = ref("c:source:1", "price", 1, "float64", "float")
NAME = ref("c:source:2", "name", 2, "str", "string")


def sort(step_id: str, column: dict) -> dict[str, Any]:
    return step(step_id, "sortRows", rules=[{"column": column, "direction": "asc", "nulls": "last"}])


def test_a_single_step_checks_the_columns_it_reads_before_it_runs() -> None:
    [segment] = plan_check_segments([sort("s1", UNITS)])

    assert segment.start == 0
    assert segment.columns == (CheckedColumn(UNITS, 0),)
    assert segment.new_names == ()


def test_columns_created_by_earlier_steps_are_not_checked_but_their_names_must_be_new() -> None:
    total = ref("c:step:s2:0", "total", 3, "float64", "float")
    plan = [
        step("s1", "upperText", column=NAME),
        step("s2", "formula", leftColumn=UNITS, operator="multiply", rightColumn=PRICE, newColumn="total"),
        sort("s3", total),
        sort("s4", {**NAME, "position": 2}),
    ]

    [segment] = plan_check_segments(plan)

    assert segment.columns == (CheckedColumn(NAME, 0), CheckedColumn(UNITS, 1), CheckedColumn(PRICE, 1))
    assert segment.new_names == (NewColumnName("total", 1, False),)


def test_a_renamed_column_is_checked_under_its_input_name_and_its_new_name_must_be_new() -> None:
    renamed = {**UNITS, "name": "quantity"}
    plan = [step("s1", "renameColumn", column=UNITS, newName="quantity"), sort("s2", renamed)]

    [segment] = plan_check_segments(plan)

    assert segment.columns == (CheckedColumn(UNITS, 0),)
    assert segment.new_names == (NewColumnName("quantity", 0, False),)


def test_an_in_place_text_step_adds_no_name() -> None:
    [segment] = plan_check_segments([step("s1", "upperText", column=NAME, newColumn="name")])

    assert segment.new_names == ()


def test_custom_code_starts_a_new_segment_that_checks_its_columns_again() -> None:
    plan = [
        sort("s1", UNITS),
        step("s2", "customCode", code="df = df"),
        step("s3", "roundNumber", column={**UNITS, "rawType": "float64", "type": "float"}, decimals=0),
        step("s4", "customCode", code="df = df"),
    ]

    first, second = plan_check_segments(plan)

    assert (first.start, first.columns) == (0, (CheckedColumn(UNITS, 0),))
    assert second.start == 2
    assert second.columns == (CheckedColumn({**UNITS, "rawType": "float64", "type": "float"}, 2),)


def test_a_plan_that_starts_with_custom_code_checks_after_it() -> None:
    [segment] = plan_check_segments([step("s1", "customCode", code="df = df"), sort("s2", UNITS)])

    assert segment.start == 1
    assert segment.columns == (CheckedColumn(UNITS, 1),)


def test_names_the_plan_already_handles_or_that_cannot_survive_need_no_check() -> None:
    dropped_then_added = [
        step("s1", "dropColumns", columns=[PRICE]),
        step("s2", "formula", leftColumn=UNITS, operator="add", value="1", newColumn="price"),
    ]
    selected_then_added = [
        step("s1", "selectColumns", columns=[UNITS]),
        step("s2", "formula", leftColumn=UNITS, operator="add", value="1", newColumn="extra"),
    ]

    assert plan_check_segments(dropped_then_added)[0].new_names == ()
    assert plan_check_segments(selected_then_added)[0].new_names == ()


def test_pivot_output_names_must_be_new_ignoring_case() -> None:
    plan = [
        step(
            "s1",
            "pivotLonger",
            columns=[UNITS, {**PRICE, "rawType": "int64", "type": "integer"}],
            labelColumn="Measure",
            valueColumn="value",
        )
    ]

    [segment] = plan_check_segments(plan)

    assert segment.new_names == (NewColumnName("Measure", 0, True), NewColumnName("value", 0, True))
