from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal, cast
from uuid import UUID
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import pytest

from openwrangler_runtime._column_binding import bind_step
from openwrangler_runtime.engines import EngineError, PandasEngine
from openwrangler_runtime.engines.base import infer_semantic_type, normalize_cell, typed_selection_value
from openwrangler_runtime.lineage import source_lineage
from openwrangler_runtime.operations import validate_step
from openwrangler_runtime.session import SessionManager


@pytest.mark.parametrize("floating,power", [(np.float32, 90), (np.float64, 120), (np.longdouble, 126)])
def test_mixed_numeric_keys_preserve_profiles_duplicates_and_original_rows(floating, power):
    first = floating(2**power)
    distinct = 2**power + sys.hash_info.modulus
    values = [distinct, first, 0.5, first, None, floating(np.nan), float("nan")]
    source = pd.DataFrame({"value": pd.Series(values, dtype=object), "_open_wrangler_numeric_key": range(len(values))})
    source.index = pd.MultiIndex.from_tuples([("same", i % 2) for i in range(len(values))], names=["outer", "inner"])
    source.attrs = {"origin": "retained"}
    before = source.copy(deep=True)
    engine = PandasEngine()
    summary = engine.summaries(source.iloc[[0, 1, 3, 4, 5, 6]])[0]
    assert summary["distinctCount"] == 2
    assert summary["topValues"][0] == {"value": str(first), "count": 2}
    assert summary["nullCount"] == 1 and summary["nanCount"] == 2
    assert engine.header_stats(source[["value"]])["duplicateRows"] == 1
    view = engine.apply_filter_model(
        source, {"filters": [], "sort": [{"column": "value", "direction": "asc", "nulls": "last"}]}
    )
    pd.testing.assert_frame_equal(view, source.iloc[[2, 1, 3, 0, 4, 5, 6]])
    schema = engine.schema(source)
    lineage = source_lineage(schema)
    steps = [
        bind_step(
            validate_step({"id": "unique", "kind": "dropDuplicates", "params": {"columns": [lineage[0]]}}),
            schema,
            lineage,
        ),
        bind_step(
            validate_step(
                {
                    "id": "sort",
                    "kind": "sortRows",
                    "params": {"rules": [{"column": lineage[0], "direction": "asc", "nulls": "last"}]},
                }
            ),
            schema,
            lineage,
        ),
    ]
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan(steps), namespace)
    live = source
    for step in steps:
        engine.validate_transform_preflight(live, step, engine.shape(live))
        live = engine.apply_transform(live, step)
    positions = [2, 1, 0, 4, 5, 6]
    for actual in (live, namespace["clean_data"](source)):
        pd.testing.assert_frame_equal(actual, source.iloc[positions])
        assert all(actual["value"].iloc[i] is values[p] for i, p in enumerate(positions))
    pd.testing.assert_frame_equal(source, before)


@pytest.mark.parametrize("integer", [np.int64, np.uint64])
def test_mixed_numeric_keys_sort_boxed_adjacent_integers_exactly(integer):
    source = pd.DataFrame({"value": pd.Series([integer(2**53 + 1), np.float64(2**53)], dtype=object), "row": [0, 1]})
    source.index = pd.Index(["same", "same"], name="original")
    engine = PandasEngine()
    schema = engine.schema(source)
    lineage = source_lineage(schema)
    rule = {"column": "value", "direction": "asc", "nulls": "last"}
    step = bind_step(
        validate_step({"id": "sort", "kind": "sortRows", "params": {"rules": [{**rule, "column": lineage[0]}]}}),
        schema,
        lineage,
    )
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([step]), namespace)
    for actual in (
        engine.apply_filter_model(source, {"filters": [], "sort": [rule]}),
        engine.apply_transform(source, step),
        namespace["clean_data"](source),
    ):
        pd.testing.assert_frame_equal(actual, source.iloc[[1, 0]])


@pytest.mark.parametrize("first", [1, 1.0, True, Decimal("1"), np.bool_(True)])
@pytest.mark.parametrize("reverse", [False, True])
def test_mixed_numeric_counts_retain_first_labels_and_native_containers(first, reverse):
    numpy_one = np.float32(1)
    fraction = np.float32(1.2)
    values = [
        first,
        numpy_one,
        fraction,
        "1",
        [],
        {},
        np.array([9]),
        None,
        pd.NA,
        np.float64(np.nan),
        float("nan"),
        Decimal("NaN"),
    ]
    if reverse:
        values.reverse()
    source = pd.DataFrame({"value": pd.Series(values, dtype=object)})
    source.index = pd.Index(["same"] * len(source), name="source")
    before = source.copy(deep=True)
    engine = PandasEngine()
    counts, truncated = engine.column_values(source, "value")
    representative = numpy_one if reverse else first
    assert not truncated
    assert len(counts) == 6
    assert counts[0]["value"] == str(representative) and counts[0]["count"] == 2
    assert counts[0]["selectionValue"] == typed_selection_value(representative, "string")
    assert any(item["value"] == str(fraction) and item["count"] == 1 for item in counts)
    summary = engine.summaries(source)[0]
    assert summary["distinctCount"] == 6
    assert summary["topValues"][0] == {"value": str(representative), "count": 2}
    assert summary["nullCount"] == 2 and summary["nanCount"] == 3
    pd.testing.assert_frame_equal(source, before)
    assert all(actual is original for actual, original in zip(source["value"].array, values, strict=True))

    # Equal counts and displayed labels must retain the first typed resident at
    # a cutoff, even when a later tied item replaces an earlier larger label.
    tied = [first, str(first)]
    if reverse:
        tied.reverse()
    tied_source = pd.DataFrame({"value": pd.Series(["z", *tied], dtype=object)})
    selected, more = engine.column_values(tied_source, "value", limit=1)
    assert more
    assert selected == [{"value": str(first), "count": 1, "selectionValue": typed_selection_value(tied[0], "string")}]


@pytest.mark.parametrize("limit", [1, 100, 10_000])
def test_pandas_picker_limit_boundaries_keep_exact_values_and_has_more(limit: int) -> None:
    engine = PandasEngine()
    for distinct in (limit - 1, limit, limit + 1):
        source = pd.DataFrame({"value": pd.Series(range(distinct - 1, -1, -1), dtype=object)})
        source.attrs["origin"] = "retained"
        before = source.copy(deep=True)
        choices, more = engine.column_values(source, "value", limit=limit)
        expected = sorted(range(distinct), key=str)[:limit]
        assert choices == [
            {"value": str(value), "count": 1, "selectionValue": typed_selection_value(value, "integer")}
            for value in expected
        ]
        assert more is (distinct > limit)
        pd.testing.assert_frame_equal(source, before, check_exact=True)
        assert source.attrs == before.attrs


@pytest.mark.parametrize("limit", [1, 7])
def test_pandas_picker_retains_only_bounded_temporary_labels(monkeypatch: pytest.MonkeyPatch, limit: int) -> None:
    import weakref

    from openwrangler_runtime.engines import pandas_engine

    class ObservedLabel(str):
        __slots__ = ("__weakref__",)

    live_labels: weakref.WeakSet[ObservedLabel] = weakref.WeakSet()
    peak_labels = 0
    evaluated_labels = 0
    original_format = pandas_engine._pandas_temporal_text

    def observe_label(value: Any, scalar: Any) -> str:
        nonlocal peak_labels, evaluated_labels
        label = ObservedLabel(original_format(value, scalar))
        live_labels.add(label)
        peak_labels = max(peak_labels, len(live_labels))
        evaluated_labels += 1
        return label

    monkeypatch.setattr(pandas_engine, "_pandas_temporal_text", observe_label)
    source = pd.DataFrame({"value": range(511, -1, -1)})
    before = source.copy(deep=True)
    choices, more = PandasEngine().column_values(source, "value", limit=limit)
    expected = sorted(range(512), key=str)[:limit]
    assert choices == [
        {"value": str(value), "count": 1, "selectionValue": typed_selection_value(value, "integer")}
        for value in expected
    ]
    assert more and evaluated_labels == len(source)
    # Allow scratch labels as well as selected results without fixing the
    # selection algorithm's internal buffer shape or allocator behavior.
    assert peak_labels <= 4 * (limit + 1)
    assert len(live_labels) <= limit
    del choices
    assert not live_labels
    pd.testing.assert_frame_equal(source, before, check_exact=True)


@pytest.mark.parametrize("error_type", [RuntimeError, StopIteration])
def test_pandas_picker_late_label_failure_refuses_whole_public_request(
    monkeypatch: pytest.MonkeyPatch, error_type: type[Exception]
) -> None:
    import __main__
    from openwrangler_runtime import kernel_agent
    from openwrangler_runtime.protocol import PROTOCOL_VERSION

    original_error = error_type("Original picker label refusal")

    class RefusingLabel:
        def __str__(self) -> str:
            raise original_error

    source = pd.DataFrame({"value": pd.Series(["early", RefusingLabel()], dtype=object)})
    source.attrs["origin"] = "retained"
    before = source.copy(deep=True)
    monkeypatch.setattr(__main__, "picker_failure_source", source, raising=False)
    manager = SessionManager()
    monkeypatch.setattr(kernel_agent, "_manager", manager)
    query: dict[str, Any] = {"filters": [], "sort": []}
    try:
        opened = manager.open_session(
            {"kind": "notebookVariable", "label": "picker failure", "variableName": "picker_failure_source"},
            backend="pandas",
            page_size=1,
        )
        session_id = opened["metadata"]["sessionId"]
        with pytest.raises((RuntimeError, StopIteration)) as failure:
            manager.get_column_values(session_id, 0, "value", query, limit=1)
        if error_type is RuntimeError:
            assert failure.value is original_error
        else:
            # A generator may wrap StopIteration while retaining its cause;
            # it must never interpret a failed label as successful exhaustion.
            assert failure.value is original_error or failure.value.__cause__ is original_error
        response = json.loads(
            kernel_agent.dispatch_json(
                json.dumps(
                    {
                        "protocolVersion": PROTOCOL_VERSION,
                        "requestId": "picker-label-failure",
                        "priority": "interactive",
                        "request": {
                            "kind": "getColumnValues",
                            "sessionId": session_id,
                            "revision": 0,
                            "viewRequestId": "picker-view",
                            "column": "value",
                            "filterModel": query,
                            "limit": 1,
                        },
                    }
                )
            )
        )
        assert response["requestId"] == "picker-label-failure"
        error = response["response"]
        assert (error["kind"], error["code"], error["recoverable"], error["viewRequestId"]) == (
            "error",
            "runtime_error",
            True,
            "picker-view",
        )
        assert "values" not in error and "hasMore" not in error
        assert manager.get_page(session_id, 0, 0, 1, query)["page"] == opened["page"]
        manager.close_session(session_id, 0)
        assert manager.sessions == {}
    finally:
        manager.close_all()
    pd.testing.assert_frame_equal(source, before, check_exact=True)
    assert source.attrs == before.attrs and __main__.picker_failure_source is source


@pytest.mark.parametrize("offset", [0, 10**400], ids=["native", "wide"])
def test_integer_value_counts_keep_native_success_and_wide_first_labels(offset: int) -> None:
    from openwrangler_runtime.engines.pandas_engine import _pandas_value_counts

    values = [offset + key for key in range(48) for _ in range(1 + key % 3)]
    for reverse in (False, True):
        ordered = list(reversed(values)) if reverse else values
        source = pd.Series([*ordered, None, pd.NA, float("nan"), Decimal("NaN"), pd.NaT], dtype=object, name="value")
        before = source.copy(deep=True)
        for sort in (False, True):
            actual = _pandas_value_counts(source, sort=sort)
            try:
                native = source.value_counts(dropna=True, sort=sort)
            except OverflowError:
                expected = [(value, ordered.count(value)) for value in dict.fromkeys(ordered)]
                if sort:
                    expected.sort(key=lambda item: -item[1])
                assert list(actual.items()) == expected
                assert actual.index.dtype == object and actual.dtype == np.dtype("int64")
                assert actual.name == "count" and actual.index.name == "value"
            else:
                pd.testing.assert_series_equal(actual, native)
            if offset:
                assert all(
                    value is next(original for original in ordered if original == value) for value in actual.index
                )
        pd.testing.assert_series_equal(source, before)


def test_numeric_key_preserves_custom_numeric_and_temporal_native_behavior():
    from openwrangler_runtime.engines.base import normalized_numeric_sum
    from openwrangler_runtime.engines.pandas_engine import _pandas_numeric_key, _pandas_value_counts

    class UnhashableFloat(float):
        __hash__: Any = None

    class UnhashableNumpyFloat(np.float64):
        __hash__: Any = None

    original_error = OverflowError("Custom integer float refusal")

    class FloatRefusingInteger(int):
        def __float__(self) -> float:
            raise original_error

    custom_integer = pd.Series([FloatRefusingInteger(1), None], dtype=object)
    try:
        native_integer_counts = custom_integer.value_counts(sort=False)
    except OverflowError as error:
        with pytest.raises(OverflowError) as failure:
            _pandas_value_counts(custom_integer, sort=False)
        assert failure.value is error is original_error
    else:
        pd.testing.assert_series_equal(_pandas_value_counts(custom_integer, sort=False), native_integer_counts)
    for values in ([FloatRefusingInteger(1), None], [0, FloatRefusingInteger(1), 2]):
        with pytest.raises(OverflowError) as failure:
            PandasEngine().summaries(pd.DataFrame({"value": pd.Series(values, dtype=object)}))
        assert failure.value is original_error
    with pytest.raises(OverflowError) as failure:
        normalized_numeric_sum(FloatRefusingInteger(1), "integer")
    assert failure.value is original_error

    unchanged = [
        1,
        0.5,
        True,
        Decimal("1"),
        np.bool_(True),
        np.timedelta64(1, "ns"),
        np.timedelta64("NaT", "ns"),
        np.datetime64("2000-01-01"),
        UnhashableFloat(1),
        UnhashableNumpyFloat(1),
        None,
        np.float32(np.nan),
    ]
    series = pd.Series(unchanged, dtype=object)
    assert _pandas_numeric_key(series) is series
    for first in (UnhashableFloat(1), UnhashableNumpyFloat(1), np.timedelta64(1, "ns"), "1", b"1"):
        for reverse in (False, True):
            value = np.float32(1)
            values = [value, first] if reverse else [first, value]
            source = pd.Series(values, dtype=object)
            native_values = [float(value) if item is value else item for item in values]
            native = pd.Series(native_values, dtype=object).value_counts(sort=False)
            actual = _pandas_value_counts(source, sort=False)
            assert actual.tolist() == native.tolist()
            assert all(any(item is original for original in values) for item in actual.index)
            assert all(actual is original for actual, original in zip(source.array, values, strict=True))
    empty = pd.Series([], dtype=object)
    assert _pandas_numeric_key(empty) is empty
    assert _pandas_value_counts(empty).empty
    all_missing = pd.Series([None, pd.NA, np.nan, np.float32(np.nan), Decimal("NaN")], dtype=object)
    assert _pandas_value_counts(all_missing).empty


def test_numeric_key_does_not_read_custom_numpy_dtype():
    from openwrangler_runtime.engines.pandas_engine import _pandas_numeric_key

    class CustomDtype(np.float64):
        @property
        def dtype(self):
            raise AssertionError("A comparison key must not read a subclass dtype property")

    value = CustomDtype(1)
    source = pd.DataFrame({"value": pd.Series([value, "text"], dtype=object)})
    before = source.copy(deep=True)
    series = source["value"]
    assert _pandas_numeric_key(series) is series
    engine = PandasEngine()
    counts, truncated = engine.column_values(source, "value")
    assert not truncated
    assert [(item["value"], item["count"]) for item in counts] == [("1.0", 1), ("text", 1)]
    assert engine.summaries(source)[0]["distinctCount"] == 2
    assert engine.header_stats(source)["duplicateRows"] == 0
    schema = engine.schema(source)
    lineage = source_lineage(schema)
    step = bind_step(
        validate_step({"id": "unique", "kind": "dropDuplicates", "params": {"columns": [lineage[0]]}}), schema, lineage
    )
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([step]), namespace)
    for result in (engine.apply_transform(source, step), namespace["clean_data"](source)):
        pd.testing.assert_frame_equal(result, source)
        assert result["value"].iloc[0] is value
    pd.testing.assert_frame_equal(source, before)


@pytest.mark.parametrize(
    ("scalar_name", "module", "text", "attributes"),
    [
        pytest.param("NAType", __name__, "present", {}, id="NAType"),
        pytest.param("NaTType", __name__, "present", {}, id="NaTType"),
        pytest.param("bool", __name__, "present", {}, id="bool"),
        pytest.param("bool_", __name__, "present", {}, id="bool_"),
        pytest.param("datetime64", __name__, "present", {}, id="datetime64-no-item"),
        pytest.param("datetime64", __name__, "present", {"item": lambda self: None}, id="datetime64-item-none"),
        pytest.param("timedelta64", __name__, "NaT", {}, id="timedelta64-NaT"),
        pytest.param("Timedelta", __name__, "present", {"value": 1_000_000_000}, id="Timedelta"),
        pytest.param("generic", "numpy", "present", {"item": lambda self: 7}, id="numpy-generic-metadata"),
    ],
)
@pytest.mark.parametrize("nested", [False, True])
def test_scalar_type_names_preserve_cells_and_nested_json(
    monkeypatch: pytest.MonkeyPatch,
    scalar_name: str,
    module: str,
    text: str,
    attributes: dict[str, Any],
    nested: bool,
) -> None:
    import __main__

    class PresentValue:
        def __str__(self) -> str:
            return text

        def __eq__(self, _other: object) -> bool:
            raise AssertionError("sentinel recognition must not invoke scalar equality")

    value = type(scalar_name, (PresentValue,), {"__module__": module, **attributes})()
    cell_value = {"value": value, "items": [value, pd.NA, pd.NaT]} if nested else value
    expected_raw = {"value": text, "items": [text, None, None]} if nested else text
    cell = normalize_cell(cell_value)
    assert cell["kind"] == ("struct" if nested else "unknown")
    assert cell["raw"] == expected_raw
    assert not cell["isNull"] and not cell["isNaN"]
    source = pd.DataFrame({"value": pd.Series([cell_value], dtype=object)})
    source.attrs["origin"] = "retained"
    before = source.copy(deep=True)
    monkeypatch.setattr(__main__, "sentinel_cell_source", source, raising=False)
    manager = SessionManager()
    try:
        opened = manager.open_session(
            {"kind": "notebookVariable", "label": "sentinel cell", "variableName": "sentinel_cell_source"},
            backend="pandas",
            page_size=1,
        )
        actual = opened["page"]["rows"][0]["values"][0]
        assert actual == cell
        assert json.loads(json.dumps(actual, allow_nan=False))["raw"] == expected_raw
        manager.close_session(opened["metadata"]["sessionId"], 0)
    finally:
        manager.close_all()
    assert not manager.sessions
    assert source.iloc[0, 0] is cell_value
    pd.testing.assert_frame_equal(source, before)
    assert source.attrs == before.attrs


@pytest.mark.parametrize("pandas_duration", [False, True])
@pytest.mark.parametrize("nested", [False, True])
def test_duration_subclasses_preserve_native_value_in_cells(pandas_duration: bool, nested: bool) -> None:
    if pandas_duration:

        class WrappedDuration(pd.Timedelta):
            pass

        value = WrappedDuration(1, unit="ns")
        expected = 1e-9
    else:

        class Timedelta(timedelta):
            value = 7_000_000_000

        value = Timedelta(seconds=2)
        expected = 2.0
    cell_value = {"value": value} if nested else value
    cell = normalize_cell(cell_value)
    assert cell["kind"] == ("struct" if nested else "duration")
    assert cell["raw"] == ({"value": expected} if nested else expected)
    source = pd.DataFrame({"value": pd.Series([cell_value], dtype=object)})
    engine = PandasEngine()
    try:
        schema = engine.schema(source)
        page = engine.page(source, 0, 1, column_projection=[(0, schema[0]["id"])])
        assert page["rows"][0]["values"][0] == cell
        assert source.iloc[0, 0] is cell_value
    finally:
        engine.close()


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


@pytest.mark.parametrize(
    "zone,clock,offset",
    [
        (timezone.utc, "1890-01-01T00:00:00", "+00:00"),
        (timezone(timedelta(seconds=3208)), "1890-01-01T00:53:28", "+00:53:28"),
        (timezone(timedelta(seconds=-3208)), "1889-12-31T23:06:32", "-00:53:28"),
        (timezone(timedelta(minutes=330)), "1890-01-01T05:30:00", "+05:30"),
        (ZoneInfo("Europe/Berlin"), "1890-01-01T00:53:28", "+00:53:28"),
    ],
)
@pytest.mark.parametrize("nanoseconds", [0, 123, 123456789])
def test_timestamp_cells_preserve_fraction_offset_and_instant(zone, clock, offset, nanoseconds) -> None:
    value = cast(
        pd.Timestamp, pd.Timestamp("1890-01-01T00:00:00Z").tz_convert(zone) + pd.Timedelta(nanoseconds, unit="ns")
    )
    expected = clock + (f".{nanoseconds:09d}" if nanoseconds else "") + offset
    cell = normalize_cell(value)
    assert cell == {"kind": "datetime", "raw": expected, "display": expected, "isNull": False, "isNaN": False}
    # Python 3.10 parses microseconds; retain the remaining output digits for the exact instant check.
    clock_text, separator, fraction_and_offset = cell["raw"].partition(".")
    submicrosecond = 0
    microsecond_text = cell["raw"]
    if separator:
        microsecond_text = f"{clock_text}.{fraction_and_offset[:6]}{fraction_and_offset[9:]}"
        submicrosecond = int(fraction_and_offset[6:9])
    parsed = datetime.fromisoformat(microsecond_text)
    assert parsed.utcoffset() == value.utcoffset()
    delta = parsed - datetime(1970, 1, 1, tzinfo=timezone.utc)
    assert (
        delta.days * 86_400 + delta.seconds
    ) * 1_000_000_000 + delta.microseconds * 1_000 + submicrosecond == value.value
    nested = normalize_cell({"when": value, "values": [value, pd.NaT]})
    assert nested["raw"] == {"when": expected, "values": [expected, None]}
    json.dumps(nested, allow_nan=False)
    source = pd.DataFrame({"when": pd.Series([value, pd.NaT], dtype=object)})
    source.index = pd.Index(["same", "same"], name="source row")
    source.attrs = {"origin": "retained"}
    before = source.copy(deep=True)
    page = PandasEngine().page(source, 0, 2, column_projection=[(0, "stable:when")])
    assert page["columnIds"] == ["stable:when"]
    assert [row["values"] for row in page["rows"]] == [[cell], [normalize_cell(pd.NaT)]]
    assert [row["rowLabel"] for row in page["rows"]] == ["same", "same"]
    pd.testing.assert_frame_equal(source, before, check_exact=True)
    assert source.attrs == before.attrs
    label = expected.replace("T", " ")
    engine = PandasEngine()
    summary = engine.summaries(source)[0]
    assert summary["topValues"] == [{"value": label, "count": 1}]
    assert summary["visualization"] == {"kind": "datetime", "min": label, "max": label}
    choices, more = engine.column_values(source, "when")
    assert not more and len(choices) == 1
    assert choices[0]["value"] == label and choices[0]["count"] == 1
    assert choices[0].get("selectionValue") == typed_selection_value(value, "datetime")
    assert engine.column_values(source, "when", search=label) == (choices, False)
    pd.testing.assert_frame_equal(source, before, check_exact=True)
    assert source.attrs == before.attrs


@pytest.mark.parametrize("unit,fraction", [("s", ""), ("ms", ".123000"), ("us", ".123456"), ("ns", ".123456789")])
def test_timestamp_cells_retain_native_unit_precision(unit: Literal["s", "ms", "us", "ns"], fraction: str) -> None:
    value = pd.Timestamp("2000-02-29T00:00:00.123456789Z").tz_convert(timezone(timedelta(seconds=-30))).as_unit(unit)
    expected = "2000-02-28T23:59:30" + fraction + "-00:00:30"
    assert normalize_cell(value)["raw"] == expected
    assert normalize_cell([value])["raw"] == [expected]


def test_datetime_subclasses_do_not_acquire_timestamp_metadata() -> None:
    class TaggedDatetime(datetime):
        nanosecond = 123

    class Timestamp(datetime):
        @property
        def nanosecond(self):
            raise AssertionError("An unrelated datetime property must not be read")

    for cls in (
        datetime,
        TaggedDatetime,
        Timestamp,
        type("NoModuleDatetime", (datetime,), {"__module__": None}),
        type("NumericModuleDatetime", (datetime,), {"__module__": 42}),
    ):
        value = cls(2020, 2, 29, 3, 4, 5, 123456, tzinfo=timezone(timedelta(seconds=-30, microseconds=-456789)))
        expected = "2020-02-29T03:04:05.123456-00:00:30.456789"
        assert normalize_cell(value)["raw"] == expected
        assert normalize_cell({"when": value})["raw"] == {"when": expected}
        source = pd.DataFrame({"when": pd.Series([value], dtype=object)})
        assert PandasEngine().page(source, 0, 1)["rows"][0]["values"][0]["raw"] == expected


@pytest.mark.parametrize("zone", ["Europe/Berlin", "UTC"])
def test_timestamp_parquet_session_preserves_exact_page_text(tmp_path: Path, zone: str) -> None:
    pa = pytest.importorskip("pyarrow")
    pq = pytest.importorskip("pyarrow.parquet")
    ticks = pd.Timestamp("1890-01-01T00:00:00Z").value + 123
    values = pa.array([ticks, None], type=pa.timestamp("ns", tz=zone))
    path = tmp_path / "timestamp.parquet"
    pq.write_table(pa.table({"when": values}), path)
    original = path.read_bytes()
    scalar = values[0].as_py()
    # The minimum cohort's named Berlin zone has a minute-aligned historical
    # offset. Preserve that producer's instant too; explicit ZoneInfo is above.
    coarse = datetime(1890, 1, 1, tzinfo=timezone.utc).astimezone(scalar.tzinfo)
    clock = (
        f"{coarse.year:04d}-{coarse.month:02d}-{coarse.day:02d}T"
        f"{coarse.hour:02d}:{coarse.minute:02d}:{coarse.second:02d}"
    )
    offset_seconds = int(cast(timedelta, coarse.utcoffset()).total_seconds())
    hours, remainder = divmod(abs(offset_seconds), 3600)
    minutes, seconds = divmod(remainder, 60)
    suffix = f"{'-' if offset_seconds < 0 else '+'}{hours:02d}:{minutes:02d}" + (f":{seconds:02d}" if seconds else "")
    expected = clock + ".000000123" + suffix
    manager = SessionManager()
    try:
        opened = manager.open_session(
            {"kind": "file", "path": str(path), "label": path.name}, backend="pandas", page_size=2
        )
        metadata = opened["metadata"]
        cell = opened["page"]["rows"][0]["values"][0]
        assert cell == {"kind": "datetime", "raw": expected, "display": expected, "isNull": False, "isNaN": False}
        assert opened["page"]["rows"][1]["values"][0] == normalize_cell(None)
        repeated = manager.get_page(metadata["sessionId"], metadata["revision"], 0, 2, {"filters": [], "sort": []})
        assert repeated["page"] == opened["page"]
        assert opened["page"]["columnIds"] == [metadata["schema"][0]["id"]]
        query = {"filters": [], "sort": []}
        label = expected.replace("T", " ")
        summary = manager.get_summary(
            metadata["sessionId"], metadata["revision"], query, [metadata["schema"][0]["id"]]
        )["summaries"][0]
        assert summary["topValues"] == [{"value": label, "count": 1}]
        assert summary["visualization"] == {"kind": "datetime", "min": label, "max": label}
        choices = manager.get_column_values(metadata["sessionId"], metadata["revision"], "when", query)
        assert choices["values"] == [{"value": label, "count": 1}]
        assert (
            manager.get_column_values(metadata["sessionId"], metadata["revision"], "when", query, search=label)[
                "values"
            ]
            == choices["values"]
        )
        json.dumps(opened, allow_nan=False)
    finally:
        manager.close_all()
    assert path.read_bytes() == original
    assert pq.read_table(path)["when"].cast(pa.int64()).to_pylist() == [ticks, None]


@pytest.mark.parametrize("dictionary", [False, True])
@pytest.mark.parametrize("unit,fraction", [("ns", "000000001"), ("us", "000001")])
def test_pandas_duration_search_preserves_native_row_text(dictionary: bool, unit: str, fraction: str) -> None:
    pa = pytest.importorskip("pyarrow")
    value_type = pa.duration(unit)
    array = (
        pa.DictionaryArray.from_arrays(pa.array([0, 1, 0, None], type=pa.int8()), pa.array([1, 2], type=value_type))
        if dictionary
        else pa.array([1, 2, 1, None], type=value_type)
    )
    source = pd.DataFrame({"value": pd.Series(array, dtype=pd.ArrowDtype(array.type))})
    source.index = pd.Index(["same"] * 4, name="source row")
    before = source.copy(deep=True)
    engine = PandasEngine()
    first = {"value": f"0 days 00:00:00.{fraction}", "count": 2}
    choices, more = engine.column_values(source, "value", limit=1)
    assert choices == [first] and more
    assert engine.column_values(source, "value", search="1") == ([first], False)
    # Pandas 2 and 3 have different native vector text for Arrow durations.
    # Search follows those original row representations, before counted values box as Timedelta.
    native_text = pd.Series(pa.array([1], type=value_type), dtype=pd.ArrowDtype(value_type)).astype(str).iloc[0]
    assert native_text in {"1 nanoseconds" if unit == "ns" else "1 microseconds", first["value"]}
    for search in ("0", "days", "00:00"):
        expected = ([first], True) if native_text == first["value"] else ([], False)
        assert engine.column_values(source, "value", search=search, limit=1) == expected
    pd.testing.assert_frame_equal(source, before, check_exact=True)


@pytest.mark.parametrize(
    "values,search,expected_value,count,column_type",
    [
        ([1, 1.0, True, 1.0], "1.0", 1.0, 2, "string"),
        ([1, True, 1], "True", True, 1, "string"),
        ([Decimal("1.00"), Decimal("1.0"), Decimal("1.00")], "1.00", Decimal("1.00"), 2, "decimal"),
        (
            [
                pd.Timestamp("2020-01-01T00:00:00+00:00"),
                pd.Timestamp("2020-01-01T01:00:00+01:00"),
                pd.Timestamp("2020-01-01T00:00:00+00:00"),
            ],
            "+01:00",
            pd.Timestamp("2020-01-01T01:00:00+01:00"),
            1,
            "datetime",
        ),
    ],
)
def test_pandas_value_search_filters_original_representations_before_counting(
    values, search, expected_value, count, column_type
) -> None:
    source = pd.DataFrame({"value": pd.Series(values, dtype=object)})
    source.index = pd.Index(["same"] * len(values), name="source row")
    before = source.copy(deep=True)
    choices, more = PandasEngine().column_values(source, "value", search=search)
    assert not more
    assert choices == [
        {
            "value": str(expected_value),
            "count": count,
            "selectionValue": typed_selection_value(expected_value, column_type),
        }
    ]
    pd.testing.assert_frame_equal(source, before, check_exact=True)


@pytest.mark.parametrize("include_fraction", [False, True])
def test_pandas_datetime_search_retains_native_midnight_and_padded_fraction_text(include_fraction: bool) -> None:
    midnight = pd.Timestamp("2020-01-01")
    other = pd.Timestamp("2020-01-01T00:00:00.000000123") if include_fraction else pd.Timestamp("2020-01-02")
    source = pd.DataFrame({"value": [midnight, other]})
    before = source.copy(deep=True)
    engine = PandasEngine()
    if include_fraction:
        assert engine.column_values(source, "value", search=".000000000") == (
            [
                {
                    "value": "2020-01-01 00:00:00",
                    "count": 1,
                    "selectionValue": typed_selection_value(midnight, "datetime"),
                }
            ],
            False,
        )
    else:
        choices, more = engine.column_values(source, "value")
        assert not more and len(choices) == 2
        assert engine.column_values(source, "value", search="00:00:00") == (choices, False)
        assert engine.column_values(source, "value", search="00:00:00", limit=1) == (choices[:1], True)
    for choice in engine.column_values(source, "value")[0]:
        matches, more = engine.column_values(source, "value", search=choice["value"])
        assert not more and choice in matches
    pd.testing.assert_frame_equal(source, before, check_exact=True)


@pytest.mark.parametrize("fraction", ["000001", "000000123"])
def test_pandas_object_datetime_search_accepts_displayed_and_original_labels(fraction: str) -> None:
    first = np.datetime64(f"2024-01-01T00:00:00.{fraction}")
    second = np.datetime64(f"2024-01-02T00:00:00.{fraction}")
    source = pd.DataFrame({"value": pd.Series([first, second, first, None], dtype=object)})
    source.index = pd.Index(["same"] * 4, name="source row")
    before = source.copy(deep=True)
    engine = PandasEngine()
    choices, more = engine.column_values(source, "value", limit=1)
    assert more and len(choices) == 1
    choice = choices[0]
    assert choice["count"] == 2
    assert choice.get("selectionValue") == typed_selection_value(first, "datetime")
    for search in (choice["value"], str(first), str(first).replace("T", " ")):
        assert engine.column_values(source, "value", search=search) == ([choice], False)
    assert engine.column_values(source, "value", search="2024-01-01 00:00:01") == ([], False)
    pd.testing.assert_frame_equal(source, before, check_exact=True)


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
            "value": pd.Series(pa.array([1, 0, -1, 2, None], type=pa.bool8()), dtype=pd.ArrowDtype(pa.bool8())),
            "detail": pd.Series(
                [{nested_name: "yes"}, {nested_name: "no"}, {nested_name: "yes"}, {nested_name: "yes"}, None],
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
    for actual, expected in (
        (live, source.iloc[[0, 2, 3]].reset_index(drop=True)),
        (generated, source.iloc[[0, 2, 3]]),
        (source, before),
    ):
        pd.testing.assert_index_equal(actual.index, expected.index)
        pd.testing.assert_index_equal(actual.columns, expected.columns)
        for position in range(source.shape[1]):
            assert (
                actual.iloc[:, position]
                .array.__arrow_array__()
                .equals(expected.iloc[:, position].array.__arrow_array__())
            )


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
    assert cast(Any, source["value"].array).__arrow_array__().equals(cast(Any, before["value"].array).__arrow_array__())
    pd.testing.assert_index_equal(source.index, before.index)


@pytest.mark.parametrize("extension_name", ["arrow.uuid.extra", "example.bool8"])
def test_unrecognized_arrow_extension_keeps_its_physical_values_and_editing_refusal(extension_name: str) -> None:
    pa = pytest.importorskip("pyarrow")

    class ForeignScalar(pa.ExtensionType):
        def __init__(self) -> None:
            super().__init__(pa.binary(16), extension_name)

        def __arrow_ext_serialize__(self) -> bytes:
            return b""

        @classmethod
        def __arrow_ext_deserialize__(cls, storage_type: Any, serialized: bytes) -> Any:
            return cls()

    storage = pa.array([b"a" * 16, None], type=pa.binary(16))
    array = pa.ExtensionArray.from_storage(ForeignScalar(), storage)
    source = pd.DataFrame({"value": pd.arrays.ArrowExtensionArray(array)})
    engine = PandasEngine()
    schema = engine.schema(source)
    assert schema[0]["type"] == "unknown"
    assert engine.page(source, 0, 20)["rows"][0]["values"][0] == normalize_cell(b"a" * 16)
    with pytest.raises(ValueError, match="unsupported 'unknown' type"):
        bind_step(
            validate_step(
                {
                    "id": "unsupported",
                    "kind": "byExample",
                    "params": {
                        "sourceColumns": source_lineage(schema),
                        "newColumn": "copy",
                        "examples": [{"inputs": ["a"], "output": "a"}, {"inputs": ["b"], "output": "b"}],
                    },
                }
            ),
            schema,
            source_lineage(schema),
        )
    assert cast(Any, source["value"].array).__arrow_array__().equals(pa.chunked_array([array]))


def _known_scalar_frame(family: str, shape: str = "present") -> tuple[pd.DataFrame, pd.DataFrame]:
    pa = pytest.importorskip("pyarrow")
    identifiers = [UUID("00112233-4455-6677-8899-aabbccddeeff"), UUID("ffeeddcc-bbaa-9988-7766-554433221100")]
    dtype = pa.bool8() if family == "bool8" else pa.uuid()
    values = [1, 0, -1, 2, None, 0] if family == "bool8" else [*identifiers, None, identifiers[0], identifiers[0], None]
    if shape == "empty":
        values = []
    elif shape == "missing":
        values = [None, None]
    elif shape == "no-missing":
        values = [value for value in values if value is not None]
    array = pa.array(values, type=dtype)
    chunks = pa.chunked_array([array.slice(0, len(array) // 2), array.slice(len(array) // 2)])
    source = pd.DataFrame(
        {"value": pd.arrays.ArrowExtensionArray(chunks), "_open_wrangler_scalar_values": range(len(array))}
    )
    source.index = pd.Index([index // 2 for index in range(len(source))], name="duplicate")
    source.attrs = {"annotation": "retained"}
    logical = source.copy(deep=False)
    logical["value"] = (
        source["value"].astype(pd.ArrowDtype(pa.bool_()))
        if family == "bool8"
        else pd.Series(pd.array(chunks.to_pylist(), dtype="string"), index=source.index)
    )
    return source, logical


@pytest.mark.parametrize("family", ["bool8", "uuid"])
def test_known_arrow_scalar_page_preparation_is_bounded_and_preserves_coordinates(family: str) -> None:
    source, logical = _known_scalar_frame(family)
    source["object_uuid"] = pd.Series([UUID(int=1)] * len(source), index=source.index, dtype=object)
    engine = PandasEngine()
    frame = engine.ensure_row_ids(source, "known-scalar-page")
    original = cast(Any, frame["value"].array).__arrow_array__()
    page = engine.page(frame, 2, 2, total_rows=123, column_projection=[(0, "stable:known")])
    assert page["columnIds"] == ["stable:known"]
    assert page["offset"] == 2 and page["limit"] == 2 and page["totalRows"] == 123
    assert [row["id"] for row in page["rows"]] == ["r:known-scalar-page:2", "r:known-scalar-page:3"]
    assert [row["rowNumber"] for row in page["rows"]] == [2, 3]
    assert [row["rowLabel"] for row in page["rows"]] == ["1", "1"]
    assert [row["values"] for row in page["rows"]] == [[normalize_cell(value)] for value in logical["value"].iloc[2:4]]
    assert engine.page(frame, 2, 1, column_projection=[(2, "stable:object")])["rows"][0]["values"] == [
        normalize_cell(str(UUID(int=1)))
    ]
    assert cast(Any, frame["value"].array).__arrow_array__().equals(original)
    pd.testing.assert_index_equal(frame.index, source.index)
    assert frame.attrs == source.attrs
    json.dumps(page, allow_nan=False)


def test_projected_known_scalar_page_does_not_decode_unused_dictionary_payloads(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from openwrangler_runtime.engines import pandas_engine

    pa = pytest.importorskip("pyarrow")
    codebook = pa.array([f"unused-{index:05d}-" + "x" * 64 for index in range(10_000)])
    dictionary = pa.DictionaryArray.from_arrays(pa.array([0, 9_999, 1], type=pa.int32()), codebook)
    identifiers = pa.array([UUID(int=index) for index in range(3)], type=pa.uuid())
    source = pd.DataFrame(
        {
            "encoded": pd.arrays.ArrowExtensionArray(dictionary),
            "identifier": pd.arrays.ArrowExtensionArray(identifiers),
        },
        index=pd.Index([10, 20, 30], name="source row"),
    )
    source.attrs = {"source": "retained"}
    engine = PandasEngine()
    frame = engine.ensure_row_ids(source, "dictionary-page")
    dictionary_values = pandas_engine._pandas_dictionary_values

    def selected_scalar_values(series: Any) -> Any:
        # An Arrow row slice retains the whole codebook. Its native scalar
        # iterator already resolves the selected entries without decoding it.
        if isinstance(series.dtype, pd.ArrowDtype) and pa.types.is_dictionary(series.dtype.pyarrow_dtype):
            raise AssertionError("A page must not decode an entire dictionary payload.")
        return dictionary_values(series)

    monkeypatch.setattr(pandas_engine, "_pandas_dictionary_values", selected_scalar_values)
    page = engine.page(frame, 1, 1, column_projection=[(1, "stable:uuid"), (0, "stable:dictionary")])
    assert page["columnIds"] == ["stable:uuid", "stable:dictionary"]
    assert page["rows"] == [
        {
            "id": "r:dictionary-page:1",
            "rowNumber": 1,
            "rowLabel": "20",
            "values": [normalize_cell(str(UUID(int=1))), normalize_cell(codebook[9_999].as_py())],
        }
    ]
    assert cast(Any, frame["encoded"].array).__arrow_array__().equals(pa.chunked_array([dictionary]))
    assert cast(Any, frame["identifier"].array).__arrow_array__().equals(pa.chunked_array([identifiers]))
    pd.testing.assert_index_equal(frame.index, source.index)
    assert frame.attrs == source.attrs


@pytest.mark.parametrize("family", ["bool8", "uuid"])
@pytest.mark.parametrize("shape", ["present", "empty", "missing"])
def test_known_arrow_scalar_session_uses_its_own_typed_selections(
    monkeypatch: pytest.MonkeyPatch, family: str, shape: str
) -> None:
    import __main__

    source, logical = _known_scalar_frame(family, shape)
    original = cast(Any, source["value"].array).__arrow_array__()
    monkeypatch.setattr(__main__, "known_scalar_source", source, raising=False)
    manager = SessionManager()
    query: dict[str, Any] = {"filters": [], "sort": []}
    try:
        opened = manager.open_session(
            {"kind": "notebookVariable", "label": "known scalar", "variableName": "known_scalar_source"},
            backend="pandas",
            mode="editing",
            page_size=20,
        )
        session_id = opened["metadata"]["sessionId"]
        column = opened["metadata"]["schema"][0]
        expected_kind = "boolean" if family == "bool8" else "string"
        assert all(row["values"][0]["kind"] in {expected_kind, "null"} for row in opened["page"]["rows"])
        summary = manager.get_summary(session_id, 0, query)["summaries"][0]
        assert summary["nullCount"] == int(cast(Any, logical["value"].isna().sum()))
        assert summary["distinctCount"] == logical["value"].nunique()
        values = manager.get_column_values(session_id, 0, "value", query)["values"]
        if values:
            token = values[0]["selectionValue"]
            expected_positions = np.flatnonzero(logical["value"].eq(token["cell"]["raw"]).fillna(False))
        else:
            token = None
            expected_positions = np.flatnonzero(logical["value"].isna())
        column_filter = {
            "column": "value",
            "type": column["type"],
            "predicates": [],
            "valueFilter": {
                "kind": "values",
                "selectedValues": [token] if token else [],
                "includeNulls": token is None,
                "includeNaN": False,
            },
        }
        query["filters"] = [column_filter]
        page = manager.get_page(session_id, 0, 0, 20, query)["page"]
        assert [row["values"][1]["raw"] for row in page["rows"]] == expected_positions.tolist()
        operation = {
            "id": "selected",
            "kind": "filterRows",
            "params": {
                "filterModel": {
                    "filters": [{**column_filter, "column": {"id": column["id"], "name": "value"}}],
                    "sort": [],
                }
            },
        }
        preview = manager.preview_step(session_id, 0, operation, 0, 20)
        applied = manager.apply_draft(session_id, preview["revision"], 0, 20)
        assert len(applied["metadata"]["steps"]) == 1
        session = manager.sessions[session_id]
        namespace: dict[str, Any] = {}
        exec(session.engine.compile_plan(session.bound_plan), namespace)
        for actual in (session.committed, namespace["clean_data"](source)):
            assert actual["value"].array.__arrow_array__().equals(original.take(expected_positions))
            pd.testing.assert_index_equal(actual.index, source.index.take(expected_positions))
        assert cast(Any, source["value"].array).__arrow_array__().equals(original)
        assert source.attrs == {"annotation": "retained"}
    finally:
        manager.close_all()


@pytest.mark.parametrize("family", ["bool8", "uuid"])
@pytest.mark.parametrize("operation_kind", ["castColumn", "oneHotEncode", "groupBy", "pivotWider", "fillMissingValues"])
def test_known_arrow_scalar_operations_match_logical_values(family: str, operation_kind: str) -> None:
    source, logical = _known_scalar_frame(family)
    source["group"] = "g"
    logical["group"] = "g"
    engine = PandasEngine()
    schema = engine.schema(source)
    lineage = source_lineage(schema)
    params: dict[str, Any]
    if operation_kind == "castColumn":
        params = {"column": lineage[0], "dtype": "string"}
    elif operation_kind == "oneHotEncode":
        params = {"columns": [lineage[0]], "dropOriginal": False}
    elif operation_kind == "groupBy":
        params = {
            "keys": [lineage[0]],
            "aggregations": [{"column": lineage[1], "operation": "count", "alias": "count"}],
        }
    elif operation_kind == "pivotWider":
        params = {
            "namesFrom": lineage[2],
            "valuesFrom": lineage[0],
            "outputs": [
                {"key": typed_selection_value("g", "string"), "name": "result"},
                {"key": typed_selection_value("absent", "string"), "name": "absent"},
            ],
        }
    else:
        params = {"column": lineage[0], "replacement": {"kind": "mostFrequent"}}
    operation = bind_step(validate_step({"id": "scalar", "kind": operation_kind, "params": params}), schema, lineage)
    engine.validate_transform_preflight(source, operation, engine.shape(source))
    expected = engine.apply_transform(logical, operation)
    original = cast(Any, source["value"].array).__arrow_array__()
    namespace: dict[str, Any] = {}
    code = engine.compile_plan([operation])
    exec(code, namespace)
    for actual in (engine.apply_transform(source, operation), namespace["clean_data"](source)):
        assert [str(column) for column in actual.columns] == [str(column) for column in expected.columns]
        assert [row["values"] for row in engine.page(actual, 0, len(actual))["rows"]] == [
            row["values"] for row in engine.page(expected, 0, len(expected))["rows"]
        ]
        if operation_kind not in {"castColumn", "groupBy", "pivotWider", "fillMissingValues"}:
            assert actual["value"].array.__arrow_array__().equals(original)
    assert cast(Any, source["value"].array).__arrow_array__().equals(original)
    assert source.attrs == {"annotation": "retained"}


@pytest.mark.parametrize("family", ["bool8", "uuid"])
def test_known_arrow_scalar_noop_fill_and_by_example_copy_keep_storage(family: str) -> None:
    source, _ = _known_scalar_frame(family, "no-missing")
    engine = PandasEngine()
    schema = engine.schema(source)
    lineage = source_lineage(schema)
    samples = [row["values"][0]["raw"] for row in engine.page(source, 0, 2)["rows"]]
    for kind, params in (
        ("fillMissingValues", {"column": lineage[0], "replacement": {"kind": "mostFrequent"}}),
        (
            "byExample",
            {
                "sourceColumns": [lineage[0]],
                "newColumn": "copy",
                "examples": [{"inputs": [value], "output": value} for value in samples],
            },
        ),
    ):
        operation = bind_step(validate_step({"id": "unchanged", "kind": kind, "params": params}), schema, lineage)
        namespace: dict[str, Any] = {}
        code = engine.compile_plan([operation])
        exec(code, namespace)
        for actual in (engine.apply_transform(source, operation), namespace["clean_data"](source)):
            output = actual["copy" if kind == "byExample" else "value"]
            assert output.array.__arrow_array__().equals(cast(Any, source["value"].array).__arrow_array__())
        if kind == "byExample":
            assert "def _open_wrangler_scalar_values" not in code


@pytest.mark.parametrize("kind", ["upperText", "byExample"])
def test_arrow_uuid_text_uses_canonical_strings_and_preserves_source(kind: str) -> None:
    source, logical = _known_scalar_frame("uuid")
    engine = PandasEngine()
    schema = engine.schema(source)
    lineage = source_lineage(schema)
    params: dict[str, Any] = {"column": lineage[0], "newColumn": "result"}
    if kind == "byExample":
        params = {
            "sourceColumns": [lineage[0]],
            "newColumn": "result",
            "examples": [{"inputs": [value], "output": value.upper()} for value in logical["value"].iloc[:2]],
        }
    operation = bind_step(validate_step({"id": "text", "kind": kind, "params": params}), schema, lineage)
    engine.validate_transform_preflight(source, operation, engine.shape(source))
    namespace: dict[str, Any] = {}
    code = engine.compile_plan([operation])
    exec(code, namespace)
    for actual in (engine.apply_transform(source, operation), namespace["clean_data"](source)):
        assert [normalize_cell(value) for value in actual["result"]] == [
            normalize_cell(value) for value in engine.apply_transform(logical, operation)["result"]
        ]
        assert actual["value"].array.__arrow_array__().equals(cast(Any, source["value"].array).__arrow_array__())
        pd.testing.assert_index_equal(actual.index, source.index)
    assert code.count("def _open_wrangler_scalar_values(") == 1


@pytest.mark.parametrize("family", ["bool8", "uuid"])
def test_known_arrow_scalar_sort_and_duplicates_preserve_selected_native_rows(family: str) -> None:
    source, logical = _known_scalar_frame(family)
    engine = PandasEngine()
    schema = engine.schema(source)
    lineage = source_lineage(schema)
    order = [{"column": "value", "direction": "desc", "nulls": "first"}]
    view = engine.apply_filter_model(source, {"filters": [], "sort": order})
    expected = logical.sort_values("value", ascending=False, na_position="first", kind="stable")
    row_column = "_open_wrangler_scalar_values"
    assert view[row_column].tolist() == expected[row_column].tolist()
    steps = [
        bind_step(
            validate_step({"id": "unique", "kind": "dropDuplicates", "params": {"columns": [lineage[0]]}}),
            schema,
            lineage,
        ),
        bind_step(
            validate_step(
                {"id": "sort", "kind": "sortRows", "params": {"rules": [{**order[0], "column": lineage[0]}]}}
            ),
            schema,
            lineage,
        ),
    ]
    expected = logical.drop_duplicates("value").sort_values(
        "value", ascending=False, na_position="first", kind="stable"
    )
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan(steps), namespace)
    live = source
    for step in steps:
        live = engine.apply_transform(live, step)
    for actual in (live, namespace["clean_data"](source)):
        positions = expected[row_column].tolist()
        assert actual[row_column].tolist() == positions
        assert (
            cast(Any, actual["value"].array)
            .__arrow_array__()
            .equals(cast(Any, source["value"].array).__arrow_array__().take(positions))
        )
        pd.testing.assert_index_equal(actual.index, expected.index)
        assert actual.attrs == source.attrs


@pytest.mark.parametrize("include_nulls", [False, True])
@pytest.mark.parametrize("include_nan", [False, True])
def test_object_uuid_session_selections_use_canonical_values_and_preserve_source(
    monkeypatch: pytest.MonkeyPatch, include_nulls: bool, include_nan: bool
) -> None:
    import __main__

    identifier = UUID("92345678-9abc-4def-a123-0123456789ab")
    values = [str(identifier).upper(), identifier, str(identifier), None, pd.NA, np.nan, pd.NaT, identifier.hex]
    source = pd.DataFrame({"value": pd.Series(values, dtype=object), "row": range(len(values))})
    source.index = pd.MultiIndex.from_arrays([["same"] * len(source), [i // 2 for i in range(len(source))]])
    source.attrs = {"origin": "retained"}
    before = source.copy(deep=True)
    monkeypatch.setattr(__main__, "object_uuid_source", source, raising=False)
    manager = SessionManager()
    query: dict[str, Any] = {"filters": [], "sort": []}
    try:
        opened = manager.open_session(
            {"kind": "notebookVariable", "label": "UUID", "variableName": "object_uuid_source"},
            backend="pandas",
            mode="editing",
            page_size=20,
        )
        session_id = opened["metadata"]["sessionId"]
        column = opened["metadata"]["schema"][0]
        assert column["type"] == "string"
        assert opened["page"]["rows"][1]["values"][0] == normalize_cell(str(identifier))
        picker = manager.get_column_values(session_id, 0, "value", query)["values"]
        selected = [item for item in picker if item["value"] == str(identifier)]
        assert len(picker) == 3 and len(selected) == 1 and selected[0]["count"] == 2
        summary = manager.get_summary(session_id, 0, query)["summaries"][0]
        assert (summary["distinctCount"], summary["nullCount"], summary["nanCount"]) == (3, 3, 1)
        column_filter = {
            "column": "value",
            "type": "string",
            "predicates": [],
            "valueFilter": {
                "kind": "values",
                "selectedValues": [selected[0]["selectionValue"]],
                "includeNulls": include_nulls,
                "includeNaN": include_nan,
            },
        }
        query["filters"] = [column_filter]
        positions = sorted([1, 2] + ([3, 4, 6] if include_nulls else []) + ([5] if include_nan else []))
        page = manager.get_page(session_id, 0, 0, 20, query)["page"]
        assert [row["values"][1]["raw"] for row in page["rows"]] == positions
        step = {
            "id": "selected",
            "kind": "filterRows",
            "params": {
                "filterModel": {
                    "filters": [{**column_filter, "column": {"id": column["id"], "name": "value"}}],
                    "sort": [],
                }
            },
        }
        preview = manager.preview_step(session_id, 0, step, 0, 20)
        applied = manager.apply_draft(session_id, preview["revision"], 0, 20)
        session = manager.sessions[session_id]
        namespace: dict[str, Any] = {}
        exec(session.engine.compile_plan(session.bound_plan), namespace)
        for actual in (session.committed, namespace["clean_data"](source)):
            pd.testing.assert_frame_equal(actual[source.columns], source.iloc[positions])
            assert isinstance(actual["value"].iloc[0], UUID)
        undone = manager.undo_step(session_id, applied["revision"], 0, 20)
        assert undone["metadata"]["steps"] == []
        # Undo retains the separate viewing filter until the user clears it.
        assert len(undone["page"]["rows"]) == len(positions)
        assert len(
            manager.get_page(session_id, undone["revision"], 0, 20, {"filters": [], "sort": []})["page"]["rows"]
        ) == len(values)
        pd.testing.assert_frame_equal(source, before)
        assert source.attrs == before.attrs
        assert all(actual is expected for actual, expected in zip(source["value"].array, values, strict=True))
    finally:
        manager.close_all()


def test_object_uuid_sort_duplicates_and_copy_keep_physical_values() -> None:
    identifier = UUID("fedcba98-7654-4321-9876-abcdef123456")
    values = [str(identifier).upper(), identifier, str(identifier), None, identifier.hex, identifier]
    source = pd.DataFrame({"value": pd.Series(values, dtype=object), "_open_wrangler_scalar_values": range(6)})
    source.index = pd.Index([5, 5, 4, 4, 3, 3], name="duplicate")
    source.attrs = {"origin": "kept"}
    engine = PandasEngine()
    schema = engine.schema(source)
    lineage = source_lineage(schema)
    steps = [
        bind_step(validate_step({"id": str(i), "kind": kind, "params": params}), schema, lineage)
        for i, (kind, params) in enumerate(
            [
                ("sortRows", {"rules": [{"column": lineage[0], "direction": "asc", "nulls": "last"}]}),
                ("dropDuplicates", {"columns": [lineage[0]], "keep": "last"}),
            ]
        )
    ]
    code = engine.compile_plan(steps)
    namespace: dict[str, Any] = {}
    exec(code, namespace)
    live = source
    for step in steps:
        live = engine.apply_transform(live, step)
    for actual in (live, namespace["clean_data"](source)):
        pd.testing.assert_frame_equal(actual, source.iloc[[0, 5, 4, 3]])
        assert actual["value"].iloc[1] is identifier and actual.attrs == source.attrs
    assert code.count("def _open_wrangler_scalar_values(") == 1
    copy = bind_step(
        validate_step(
            {
                "id": "copy",
                "kind": "byExample",
                "params": {
                    "sourceColumns": [lineage[0]],
                    "newColumn": "copy",
                    "examples": [{"inputs": ["a"], "output": "a"}, {"inputs": ["b"], "output": "b"}],
                },
            }
        ),
        schema,
        lineage,
    )
    code = engine.compile_plan([copy])
    exec(code, namespace)
    assert "def _open_wrangler_scalar_values" not in code
    for actual in (engine.apply_transform(source, copy), namespace["clean_data"](source)):
        assert all(value is expected for value, expected in zip(actual["copy"].array, values, strict=True))


def test_object_uuid_preparation_preserves_other_objects_and_native_token_types() -> None:
    from openwrangler_runtime.engines.pandas_engine import _pandas_scalar_values

    identifier = UUID(int=1)
    wide = 2**100 + 7
    companions = [wide, str(wide), Decimal("3.125"), b"binary", {"nested": [1]}, np.nan, pd.NA, None]
    series = pd.Series([*companions, identifier], dtype=object, name="mixed")
    logical = _pandas_scalar_values(series)
    assert logical.dtype == object and logical.iloc[-1] == str(identifier)
    assert all(value is expected for value, expected in zip(logical.iloc[:-1].array, companions, strict=True))
    for values in (["a", None, "b"], [wide, None], companions):
        unchanged = pd.Series(values, dtype=object)
        assert _pandas_scalar_values(unchanged) is unchanged
    frame = pd.DataFrame(
        {"value": pd.Series([wide, str(wide), identifier, str(identifier)], dtype=object), "row": range(4)}
    )
    engine = PandasEngine()
    picker = engine.column_values(frame, "value")[0]
    for kind, position in [("integer", 0), ("string", 1)]:
        token = next(
            item["selectionValue"]
            for item in picker
            if item["value"] == str(wide) and item["selectionValue"]["cell"]["kind"] == kind
        )
        result = engine.apply_filter_model(
            frame,
            {
                "filters": [
                    {
                        "column": "value",
                        "type": "string",
                        "predicates": [],
                        "valueFilter": {
                            "kind": "values",
                            "selectedValues": [token],
                            "includeNulls": False,
                            "includeNaN": False,
                        },
                    }
                ],
                "sort": [],
            },
        )
        assert result["row"].tolist() == [position]


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


@pytest.mark.parametrize(
    ("books", "indices", "expected"),
    [
        ([["present"]], [[0]], False),
        ([["present", None]], [[0]], False),
        ([["present", None]], [[1]], True),
        ([["present"]], [[None]], True),
        ([[None]], [[]], False),
        ([[]], [[None]], True),
        ([["present", None], [None, "present"]], [[0], [1]], False),
        ([["present"], [None, "present"]], [[0], [0]], True),
    ],
)
@pytest.mark.parametrize("index_type", ["int8", "uint64"])
def test_dictionary_schema_nullability_does_not_decode_payloads(
    books: list[list[str | None]],
    indices: list[list[int | None]],
    expected: bool,
    index_type: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import pyarrow as pa

    from openwrangler_runtime.engines import pandas_engine

    chunks = [
        pa.DictionaryArray.from_arrays(
            pa.array(codes, type=getattr(pa, index_type)()), pa.array(book, type=pa.string())
        )
        for book, codes in zip(books, indices, strict=True)
    ]
    array = pa.chunked_array(chunks)
    frame = pd.DataFrame({"value": pd.Series(pd.arrays.ArrowExtensionArray(array))})

    def reject_payload_decode(_series: Any) -> Any:
        raise AssertionError("Schema nullability must inspect validity without decoding string payloads.")

    monkeypatch.setattr(pandas_engine, "_pandas_dictionary_values", reject_payload_decode)
    schema = PandasEngine().schema(frame)
    assert schema[0]["nullable"] is expected
    assert schema[0]["type"] == "string"
    assert schema[0]["rawType"] == str(frame["value"].dtype)
    assert cast(Any, frame["value"].array).__arrow_array__().equals(array)


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


@pytest.mark.parametrize("case", ["neighbor", "underflow", "overflow"])
@pytest.mark.parametrize("nested", [False, True])
def test_native_extended_float_transport_refuses_loss(case: str, nested: bool) -> None:
    if np.finfo(np.longdouble).nmant <= 52:
        pytest.skip("Native longdouble has no additional binary64 precision on this platform")
    value = (
        np.nextafter(np.longdouble(1), np.longdouble(2))
        if case == "neighbor"
        else np.longdouble("1e-400" if case == "underflow" else "1e400")
    )
    with pytest.raises(EngineError, match="precision or range"):
        normalize_cell({"nested": [value]} if nested else value)


def test_native_extended_float_representable_and_custom_boundaries() -> None:
    for value in [
        np.longdouble(1.25),
        np.longdouble(np.finfo(np.float64).smallest_subnormal),
        np.longdouble(np.finfo(np.float64).max),
        np.longdouble(-0.0),
        np.longdouble(0),
        np.longdouble("nan"),
        np.longdouble("inf"),
        np.longdouble("-inf"),
        np.float16(0.5),
        np.float32(0.5),
        np.float64(0.5),
    ]:
        assert normalize_cell(value) == normalize_cell(float(value))
        assert normalize_cell([value]) == normalize_cell([float(value)])

    class CustomFloat(float):
        def as_integer_ratio(self):
            raise AssertionError("Custom ratio must not be called")

    class Wrapped(np.longdouble):
        def as_integer_ratio(self):
            raise AssertionError("Custom NumPy ratio must not be called")

    assert normalize_cell(CustomFloat(1.25))["raw"] == 1.25
    assert normalize_cell(Wrapped(1.25))["raw"] == 1.25
    if np.finfo(np.longdouble).nmant > 52:
        value = Wrapped(np.nextafter(np.longdouble(1), np.longdouble(2)))
        with pytest.raises(EngineError, match="precision or range"):
            normalize_cell(value)
        with pytest.raises(EngineError, match="precision or range"):
            normalize_cell([value])


@pytest.mark.parametrize("storage", ["dense", "object", "sparse"])
@pytest.mark.parametrize("query", ["picker", "profile", "header"])
def test_extended_float_query_rejects_original_values_before_count_narrowing(storage: str, query: str) -> None:
    if np.finfo(np.longdouble).nmant <= 52:
        pytest.skip("Native longdouble aliases binary64")
    values = np.array([1, np.nextafter(np.longdouble(1), np.longdouble(2)), 2], dtype=np.longdouble)
    dtype = (
        object if storage == "object" else pd.SparseDtype(np.longdouble, 0) if storage == "sparse" else np.longdouble
    )
    frame = pd.DataFrame({"value": pd.Series(values).astype(dtype), "safe": [10, 20, 30]})
    frame.index = pd.Index(["same"] * 3, name="row")
    before = frame.copy(deep=True)
    engine = PandasEngine()
    calls = {
        "picker": lambda: engine.column_values(frame, "value"),
        "profile": lambda: engine.summaries(frame),
        "header": lambda: engine.header_stats(frame[["value"]]),
    }
    with pytest.raises(EngineError, match="precision or range"):
        calls[query]()
    assert engine.missing_count(frame, 0) == 0
    assert engine.summaries(frame, [(1, "safe")])[0]["distinctCount"] == 3
    assert engine.column_values(frame, "value", search="2")[0][0]["count"] == 1
    pd.testing.assert_frame_equal(frame, before)


def test_extended_float_profile_keeps_approximate_computed_statistics() -> None:
    source = pd.DataFrame({"value": pd.Series([np.longdouble(1), np.longdouble(2) ** -53], dtype=np.longdouble)})
    summary = PandasEngine().summaries(source)[0]
    assert summary["numeric"]["sum"] == 1.0
    assert summary["numeric"]["mean"] == 0.5
    assert summary["distinctCount"] == 2


def test_extended_float_selected_guard_keeps_fast_paths_and_sparse_storage(monkeypatch: pytest.MonkeyPatch) -> None:
    from openwrangler_runtime.engines.pandas_engine import _pandas_validate_query_values

    def unexpected_dense(*_args, **_kwargs):
        raise AssertionError("Validation must not densify Sparse storage")

    monkeypatch.setattr(pd.arrays.SparseArray, "to_dense", unexpected_dense)
    monkeypatch.setattr(pd.arrays.SparseArray, "to_numpy", unexpected_dense)
    if np.finfo(np.longdouble).nmant > 52:
        neighbor = np.nextafter(np.longdouble(1), np.longdouble(2))
        for values, fill, refuses in [
            ([1, 2], neighbor, False),
            ([neighbor, 2], neighbor, True),
            ([neighbor, 2], 0, True),
        ]:
            series = pd.Series(pd.arrays.SparseArray(np.array(values, dtype=np.longdouble), fill_value=fill))
            if refuses:
                with pytest.raises(EngineError, match="precision or range"):
                    _pandas_validate_query_values(series)
            else:
                _pandas_validate_query_values(series)

    class Custom(np.longdouble):
        def __float__(self):
            raise AssertionError("Custom floating conversion must not be called")

        def as_integer_ratio(self):
            raise AssertionError("Custom ratio must not be called")

    _pandas_validate_query_values(pd.Series([Custom(1.25), "other", None], dtype=object))
    for dtype in (np.longdouble, object):
        safe = pd.Series(np.array([1.25, -0.0, 0.0, np.nan, np.inf, -np.inf], dtype=np.longdouble), dtype=dtype)
        before = safe.copy(deep=True)
        _pandas_validate_query_values(safe)
        _pandas_validate_query_values(safe.iloc[:0])
        pd.testing.assert_series_equal(safe, before)
    narrow = [pd.Series([1.0, -0.0, np.nan], dtype=dtype) for dtype in (np.float16, np.float32, np.float64)]
    monkeypatch.setattr(
        pd.Series,
        "to_numpy",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Narrow floats require no value scan")),
    )
    for series in narrow:
        _pandas_validate_query_values(series)


def test_non_numpy_transport_does_not_require_numpy(monkeypatch: pytest.MonkeyPatch) -> None:
    import builtins

    values = [None, True, 2**70, 1.25, Decimal("1.25"), {"nested": [1.25, None]}]
    expected = [normalize_cell(value) for value in values]
    original_import = builtins.__import__

    def without_numpy(name, *args, **kwargs):
        if name == "numpy" or name.startswith("numpy."):
            raise AssertionError("Non-NumPy transport must not import NumPy")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", without_numpy)
    assert [normalize_cell(value) for value in values] == expected


@pytest.mark.parametrize("dictionary", [False, True])
@pytest.mark.parametrize(
    "family,expected_text",
    [
        ("timestamp", "1677-09-21T00:12:43.145224192"),
        ("utc", "1677-09-21T00:12:43.145224192+00:00"),
        ("berlin", "1677-09-21T01:06:11.145224192+00:53:28"),
        ("duration", "-9223372036854775808 ns"),
    ],
)
def test_pandas_arrow_temporal_validity_keeps_bounded_cells_profiles_and_filters(
    dictionary: bool, family: str, expected_text: str
) -> None:
    import pyarrow as pa

    minimum = -(2**63)
    arrow_type = (
        pa.duration("ns")
        if family == "duration"
        else pa.timestamp("ns", tz={"timestamp": None, "utc": "UTC", "berlin": "Europe/Berlin"}[family])
    )
    if dictionary:
        encoded = pa.DictionaryArray.from_arrays(
            pa.array([0, 1, None, 0, 2], type=pa.int8()), pa.array([minimum, None, 0], type=arrow_type)
        )
        array = pa.chunked_array([encoded.slice(0, 2), encoded.slice(2)])
    else:
        array = pa.chunked_array(
            [pa.array([minimum, None], type=arrow_type), pa.array([None, minimum, 0], type=arrow_type)]
        )
    source = pd.DataFrame({"value": pd.Series(array, dtype=pd.ArrowDtype(array.type)), "row": range(5)})
    source.index = pd.Index(["same", "same", "null", "same", "last"], name="original")
    source.attrs["origin"] = "unchanged"
    before = source.copy(deep=True)
    engine = PandasEngine()
    schema = engine.schema(source)
    page = engine.page(source, 1, 3, column_projection=[(1, schema[1]["id"]), (0, schema[0]["id"])])
    assert page["columnIds"] == [schema[1]["id"], schema[0]["id"]]
    assert [row["rowNumber"] for row in page["rows"]] == [1, 2, 3]
    assert [row["values"][0]["raw"] for row in page["rows"]] == [1, 2, 3]
    cells = [row["values"][1] for row in page["rows"]]
    assert [cell["isNull"] for cell in cells] == [True, True, False]
    assert cells[-1] == {
        "kind": "duration" if family == "duration" else "datetime",
        "raw": minimum / 1_000_000_000 if family == "duration" else expected_text,
        "display": expected_text,
        "isNull": False,
        "isNaN": False,
    }
    summary = engine.summaries(source, [(0, schema[0]["id"])])[0]
    assert (summary["nullCount"], summary["nanCount"], summary["distinctCount"]) == (2, 0, 2)
    assert summary["topValues"][0] == {"value": expected_text, "count": 2}
    if family != "duration":
        assert summary["visualization"]["min"] == expected_text
    choices, more = engine.column_values(source, "value", limit=1)
    # The existing datetime selection decoder does not carry nanosecond precision.
    assert choices == [{"value": expected_text, "count": 2}] and more
    assert engine.column_values(source, "value", search=expected_text) == (choices, False)
    for empty in [source.iloc[:0], source.iloc[[1, 2]]]:
        assert engine.column_values(empty, "value") == ([], False)
        assert engine.summaries(empty, [(0, schema[0]["id"])])[0]["nullCount"] == len(empty)
    lineage = source_lineage(schema)
    for operator, positions in [("isNull", [1, 2]), ("isNotNull", [0, 3, 4])]:
        operation = bind_step(
            validate_step(
                {
                    "id": "temporal-filter",
                    "kind": "filterRows",
                    "params": {
                        "filterModel": {
                            "filters": [
                                {
                                    "column": lineage[0],
                                    "type": schema[0]["type"],
                                    "predicates": [{"kind": "predicate", "operator": operator}],
                                }
                            ],
                            "sort": [],
                        }
                    },
                }
            ),
            schema,
            lineage,
        )
        namespace: dict[str, Any] = {}
        exec(engine.compile_plan([operation]), namespace)
        for actual in [engine.apply_transform(source, operation), namespace["clean_data"](source)]:
            assert actual.index.equals(source.iloc[positions].index)
            assert actual.columns.equals(source.columns) and actual.attrs == source.attrs
            pd.testing.assert_series_equal(actual["row"], source["row"].iloc[positions])
            native = cast(pd.arrays.ArrowExtensionArray, actual["value"].array).__arrow_array__()
            assert native.type == array.type
            # Existing row queries canonicalize dictionary entries referring to null.
            expected_array = array.cast(arrow_type).take(pa.array(positions))
            assert native.cast(arrow_type).equals(expected_array)
    pd.testing.assert_frame_equal(source, before)
    assert cast(pd.arrays.ArrowExtensionArray, source["value"].array).__arrow_array__().equals(array)
