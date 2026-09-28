"""Decide which input columns a generated script checks before its steps run."""

from __future__ import annotations

from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .._column_binding import step_output_collision_checks
from .base import is_bound_column_reference

# Only these steps drop columns they don't name, so an unexpected input column can't reach later steps.
_SCHEMA_REPLACING_KINDS = frozenset({"selectColumns", "groupBy"})


@dataclass(frozen=True, slots=True)
class CheckedColumn:
    """The first bound reference through which a check segment reads one input column."""

    reference: Mapping[str, Any]
    step_index: int


@dataclass(frozen=True, slots=True)
class NewColumnName:
    """A column name a step adds, which must not already exist when the segment starts."""

    name: str
    step_index: int
    casefold: bool


@dataclass(frozen=True, slots=True)
class CheckSegment:
    """Checks that run before ``plan[start]``: at the top of the script or right after a Custom Code step."""

    start: int
    columns: tuple[CheckedColumn, ...]
    new_names: tuple[NewColumnName, ...]


def plan_check_segments(plan: Sequence[Mapping[str, Any]]) -> list[CheckSegment]:
    """Group a bound plan into check segments split after every Custom Code step.

    A segment lists each column it reads that no earlier step in the segment created, through the first bound
    reference that reads it, so that reference's ``rawType`` and ``type`` describe the column as the segment receives
    it. Engines check only the columns whose family their emitted code depends on.
    """

    segments: list[CheckSegment] = []
    start = 0
    for index, step in enumerate(plan):
        if step["kind"] == "customCode":
            if index > start:
                segments.append(_segment(plan, start, index))
            start = index + 1
    if start < len(plan):
        segments.append(_segment(plan, start, len(plan)))
    return segments


def iter_bound_references(value: Any) -> Iterator[Mapping[str, Any]]:
    """Yield every bound column reference inside a step's parameters, in document order."""

    if is_bound_column_reference(value):
        yield value
    elif isinstance(value, Mapping):
        for item in value.values():
            yield from iter_bound_references(item)
    elif isinstance(value, list):
        for item in value:
            yield from iter_bound_references(item)


def _segment(plan: Sequence[Mapping[str, Any]], start: int, stop: int) -> CheckSegment:
    columns: list[CheckedColumn] = []
    new_names: list[NewColumnName] = []
    seen_ids: set[str] = set()
    read_names: set[str] = set()
    created_prefixes: list[str] = []
    replaced = False
    for index in range(start, stop):
        step = plan[index]
        for reference in iter_bound_references(step["params"]):
            identifier = str(reference["id"])
            read_names.add(str(reference["name"]))
            if identifier in seen_ids:
                continue
            seen_ids.add(identifier)
            if not identifier.startswith(tuple(created_prefixes)):
                columns.append(CheckedColumn(reference, index))
        if not replaced:
            for name, casefold in _added_names(step):
                known = {read.casefold() for read in read_names} if casefold else read_names
                if (name.casefold() if casefold else name) not in known:
                    new_names.append(NewColumnName(name, index, casefold))
        created_prefixes.append(f"c:step:{step['id']}:")
        replaced = replaced or step["kind"] in _SCHEMA_REPLACING_KINDS
    return CheckSegment(start, tuple(columns), tuple(new_names))


def _added_names(step: Mapping[str, Any]) -> Iterator[tuple[str, bool]]:
    kind = step["kind"]
    params = step["params"]
    if kind == "pivotLonger":
        yield str(params["labelColumn"]), True
        yield str(params["valueColumn"]), True
        return
    if kind == "pivotWider":
        for output in params["outputs"]:
            yield str(output["name"]), True
        return
    for name, _label, replacing in step_output_collision_checks(step):
        if replacing is None or replacing["name"] != name:
            yield str(name), False
