from __future__ import annotations

import json
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pandas as pd
import polars as pl
import pytest

import openwrangler_runtime.engines.base as engine_base
import openwrangler_runtime.session as session_runtime
from openwrangler_runtime.engines import (
    DuckDBEngine,
    EngineError,
    EngineRegistry,
    PandasEngine,
    PolarsEngine,
    SessionDataShape,
)
from openwrangler_runtime.engines.base import (
    EngineCapabilities,
    LivePagePayloadError,
    SummaryColumnProjection,
    validate_live_page_payload,
)
from openwrangler_runtime.session import PAGE_CACHE_LIMIT, LiveSourceInvalidatedError, SessionManager


class CountingPandasEngine(PandasEngine):
    def __init__(self) -> None:
        self.filter_calls = 0
        self.page_calls: list[tuple[int, int, int | None]] = []
        self.page_projections: list[list[tuple[int, str]] | None] = []
        self.shape_calls = 0
        self.schema_calls = 0
        self.summary_calls = 0

    def shape(self, frame: Any) -> SessionDataShape:
        self.shape_calls += 1
        return super().shape(frame)

    def schema(self, frame: Any) -> list[dict[str, Any]]:
        self.schema_calls += 1
        return super().schema(frame)

    def apply_filter_model(self, frame: Any, model: Mapping[str, Any]) -> Any:
        self.filter_calls += 1
        return super().apply_filter_model(frame, model)

    def page(
        self,
        frame: Any,
        offset: int,
        limit: int,
        *,
        total_rows: int | None = None,
        column_projection=None,
    ) -> dict[str, Any]:
        self.page_calls.append((offset, limit, total_rows))
        self.page_projections.append(None if column_projection is None else list(column_projection))
        return super().page(
            frame,
            offset,
            limit,
            total_rows=total_rows,
            column_projection=column_projection,
        )

    def summaries(
        self,
        frame: Any,
        column_projection: SummaryColumnProjection | None = None,
    ) -> list[dict[str, Any]]:
        self.summary_calls += 1
        return super().summaries(frame, column_projection)


class LiveNotebookPandasEngine(CountingPandasEngine):
    """A cheap dataframe adapter for exercising live-source session ownership."""

    name = "pyspark"
    capabilities = EngineCapabilities(
        source_kinds=frozenset({"notebookVariable"}),
        supports_editing=False,
        lazy_file_extensions=frozenset(),
        export_formats=frozenset(),
        supports_shutdown_interrupt=False,
        supports_request_cancellation=False,
    )

    @staticmethod
    def live_source_is_stopped(frame: Any) -> bool:
        return bool(frame.attrs.get("sparkStopped", False))


class CorruptSummaryPandasEngine(PandasEngine):
    def __init__(self, corruption: str) -> None:
        self.corruption = corruption

    def summaries(
        self,
        frame: Any,
        column_projection: SummaryColumnProjection | None = None,
    ) -> list[dict[str, Any]]:
        summaries = super().summaries(frame, column_projection)
        if self.corruption == "reverse":
            summaries.reverse()
        elif self.corruption == "missing":
            summaries.pop()
        elif self.corruption == "duplicate":
            summaries[1]["columnId"] = summaries[0]["columnId"]
        elif self.corruption == "unknown":
            summaries[0]["columnId"] = "c:unknown"
        elif self.corruption == "name":
            summaries[0]["column"] = "renamed"
        elif self.corruption == "type":
            summaries[0]["type"] = "string"
        elif self.corruption == "rawType":
            summaries[0]["rawType"] = "String"
        else:
            raise AssertionError(f"Unknown summary corruption: {self.corruption}")
        return summaries


def counting_manager() -> tuple[SessionManager, list[CountingPandasEngine]]:
    created: list[CountingPandasEngine] = []

    def create() -> CountingPandasEngine:
        engine = CountingPandasEngine()
        created.append(engine)
        return engine

    return SessionManager(EngineRegistry((("pandas", create),))), created


def live_notebook_manager() -> tuple[SessionManager, list[LiveNotebookPandasEngine]]:
    created: list[LiveNotebookPandasEngine] = []

    def create() -> LiveNotebookPandasEngine:
        engine = LiveNotebookPandasEngine()
        created.append(engine)
        return engine

    return SessionManager(EngineRegistry((("pyspark", create),))), created


def write_values(tmp_path, count: int = 12):
    path = tmp_path / "values.csv"
    rows = "\n".join(f"row-{value},{value}" for value in range(count))
    path.write_text(f"name,value\n{rows}\n", encoding="utf-8")
    return path


def write_wide_unicode_values(tmp_path, rows: int = 4, columns: int = 12):
    path = tmp_path / "wide-unicode.csv"
    names = ["value", *[f"text-{index}" for index in range(columns)]]
    content = [",".join(names)]
    for row in range(rows):
        content.append(",".join([str(row), *[("😀" * 40) for _ in range(columns)]]))
    path.write_text("\n".join(content) + "\n", encoding="utf-8")
    return path


def replace_source_atomically(path: Path, content: str) -> None:
    original = path.stat()
    replacement = path.with_name(f".{path.name}.replacement")
    replacement.write_text(content, encoding="utf-8")
    os.utime(replacement, ns=(original.st_atime_ns, original.st_mtime_ns))
    os.replace(replacement, path)
    current = path.stat()
    assert current.st_mtime_ns == original.st_mtime_ns
    assert (current.st_dev, current.st_ino, current.st_size) != (
        original.st_dev,
        original.st_ino,
        original.st_size,
    )


def source(path) -> dict[str, str]:
    return {"kind": "file", "label": path.name, "path": str(path)}


def formula_step(step_id: str) -> dict[str, Any]:
    return {
        "id": step_id,
        "kind": "formula",
        "params": {
            "leftColumn": {"id": "c:source:1", "name": "value"},
            "operator": "multiply",
            "value": 2,
            "newColumn": "doubled",
        },
    }


def greater_than(value: int) -> dict[str, Any]:
    return {
        "logic": "and",
        "filters": [
            {
                "column": "value",
                "type": "integer",
                "predicates": [{"kind": "predicate", "operator": "gt", "value": value}],
            }
        ],
        "sort": [],
    }


def test_open_defers_summaries_and_reuses_exact_metadata_for_the_first_page(tmp_path) -> None:
    manager, created = counting_manager()
    opened = manager.open_session(source(write_values(tmp_path, 3)), backend="pandas", page_size=2)
    engine = created[0]

    assert opened["summaries"] == []
    assert engine.summary_calls == 0
    assert engine.shape_calls == 1
    assert engine.schema_calls == 1
    assert engine.page_calls == [(0, 2, 3)]

    session_id = opened["metadata"]["sessionId"]
    cached = manager.get_page(session_id, 0, 0, 2, {"filters": [], "sort": []})
    assert cached["page"] is opened["page"]
    assert cached["page"]["totalRows"] == 3
    assert engine.page_calls == [(0, 2, 3)]

    summary = manager.get_summary(
        session_id,
        0,
        {"logic": "and", "filters": [], "sort": []},
        ["c:source:1"],
    )
    assert summary["summaries"][0]["totalCount"] == 3
    assert engine.summary_calls == 1
    assert engine.shape_calls == 1
    assert engine.schema_calls == 1


@pytest.mark.parametrize(
    "corruption",
    ["reverse", "missing", "duplicate", "unknown", "name", "type", "rawType"],
)
def test_summary_results_must_match_the_exact_stable_id_projection(tmp_path, corruption) -> None:
    manager = SessionManager(EngineRegistry((("pandas", lambda: CorruptSummaryPandasEngine(corruption)),)))
    opened = manager.open_session(source(write_values(tmp_path, 3)), backend="pandas")
    schema = opened["metadata"]["schema"]

    with pytest.raises(EngineError, match="summary|summaries"):
        manager.get_summary(
            opened["metadata"]["sessionId"],
            0,
            {"filters": [], "sort": []},
            [schema[1]["id"], schema[0]["id"]],
        )


@pytest.mark.parametrize(
    ("column_ids", "message"),
    [
        ([], "non-empty unique list"),
        (["c:source:0", "c:source:0"], "non-empty unique list"),
        (["c:missing"], "Unknown summary column identity"),
    ],
)
def test_summary_requests_reject_invalid_stable_id_projections(tmp_path, column_ids, message) -> None:
    manager, created = counting_manager()
    opened = manager.open_session(source(write_values(tmp_path, 3)), backend="pandas")

    with pytest.raises(EngineError, match=message):
        manager.get_summary(
            opened["metadata"]["sessionId"],
            0,
            {"filters": [], "sort": []},
            column_ids,
        )
    assert created[0].summary_calls == 0


def test_page_cache_is_bounded_lru_and_never_shared_between_sessions(tmp_path) -> None:
    manager, created = counting_manager()
    path = write_values(tmp_path)
    first = manager.open_session(source(path), backend="pandas", page_size=1)
    first_id = first["metadata"]["sessionId"]
    first_session = manager.sessions[first_id]

    manager.get_page(first_id, 0, 0, 1, {"filters": [], "sort": []})
    assert len(created[0].page_calls) == 1
    for offset in range(1, PAGE_CACHE_LIMIT + 1):
        manager.get_page(first_id, 0, offset, 1, {"filters": [], "sort": []})

    assert len(first_session.page_cache) == PAGE_CACHE_LIMIT
    assert [key[2] for key in first_session.page_cache] == list(range(1, PAGE_CACHE_LIMIT + 1))

    manager.get_page(first_id, 0, 1, 1, {"filters": [], "sort": []})
    manager.get_page(first_id, 0, PAGE_CACHE_LIMIT + 1, 1, {"filters": [], "sort": []})
    assert [key[2] for key in first_session.page_cache] == [
        *range(3, PAGE_CACHE_LIMIT + 1),
        1,
        PAGE_CACHE_LIMIT + 1,
    ]

    second = manager.open_session(source(path), backend="pandas", page_size=1)
    second_session = manager.sessions[second["metadata"]["sessionId"]]
    assert second_session.page_cache is not first_session.page_cache
    assert len(second_session.page_cache) == 1
    assert len(first_session.page_cache) == PAGE_CACHE_LIMIT


def test_page_cache_keys_and_rows_are_scoped_to_the_stable_column_projection(tmp_path) -> None:
    manager, created = counting_manager()
    opened = manager.open_session(source(write_values(tmp_path, 4)), backend="pandas", page_size=2)
    session_id = opened["metadata"]["sessionId"]
    session = manager.sessions[session_id]
    engine = created[0]

    names = manager.get_page(
        session_id,
        0,
        0,
        2,
        {"filters": [], "sort": []},
        column_offset=0,
        column_limit=1,
    )["page"]
    values = manager.get_page(
        session_id,
        0,
        0,
        2,
        {"filters": [], "sort": []},
        column_offset=1,
        column_limit=1,
    )["page"]
    repeated_names = manager.get_page(
        session_id,
        0,
        0,
        2,
        {"filters": [], "sort": []},
        column_offset=0,
        column_limit=1,
    )["page"]

    assert names["columnIds"] == ["c:source:0"]
    assert values["columnIds"] == ["c:source:1"]
    assert [cell["display"] for cell in names["rows"][0]["values"]] == ["row-0"]
    assert [cell["display"] for cell in values["rows"][0]["values"]] == ["0"]
    assert repeated_names is names
    assert engine.page_projections == [
        [(0, "c:source:0"), (1, "c:source:1")],
        [(0, "c:source:0")],
        [(1, "c:source:1")],
    ]
    assert {key[4] for key in session.page_cache} == {
        ("c:source:0", "c:source:1"),
        ("c:source:0",),
        ("c:source:1",),
    }


def test_projected_page_filters_and_sorts_by_an_omitted_column(tmp_path) -> None:
    manager, _ = counting_manager()
    opened = manager.open_session(source(write_values(tmp_path, 5)), backend="pandas", page_size=2)
    session_id = opened["metadata"]["sessionId"]
    model = {
        **greater_than(1),
        "sort": [{"column": "value", "direction": "desc", "nulls": "last"}],
    }

    response = manager.get_page(
        session_id,
        0,
        0,
        2,
        model,
        column_offset=0,
        column_limit=1,
    )

    assert response["page"]["columnIds"] == ["c:source:0"]
    assert response["page"]["totalRows"] == 3
    assert [[cell["display"] for cell in row["values"]] for row in response["page"]["rows"]] == [
        ["row-4"],
        ["row-3"],
    ]


def test_empty_and_invalid_column_windows_fail_closed(tmp_path) -> None:
    manager, _ = counting_manager()
    opened = manager.open_session(source(write_values(tmp_path, 2)), backend="pandas", page_size=2)
    session_id = opened["metadata"]["sessionId"]

    empty = manager.get_page(
        session_id,
        0,
        0,
        2,
        {"filters": [], "sort": []},
        column_offset=20,
        column_limit=1,
    )["page"]
    assert empty["columnIds"] == []
    assert [row["values"] for row in empty["rows"]] == [[], []]

    for column_offset, column_limit in ((-1, 1), (True, 1), (0, 0), (0, 257), (0, True)):
        with pytest.raises(EngineError, match="columnOffset|columnLimit"):
            manager.get_page(
                session_id,
                0,
                0,
                2,
                {"filters": [], "sort": []},
                column_offset=column_offset,
                column_limit=column_limit,
            )


def test_session_rejects_malformed_adapter_row_width_before_caching(tmp_path) -> None:
    class WrongWidthPandasEngine(PandasEngine):
        corrupt = False

        def page(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
            page = super().page(*args, **kwargs)
            if self.corrupt and page["rows"]:
                page["rows"][0]["values"].append({"kind": "string", "display": "unexpected"})
            return page

    engine = WrongWidthPandasEngine()
    manager = SessionManager(EngineRegistry((("pandas", lambda: engine),)))
    opened = manager.open_session(source(write_values(tmp_path, 2)), backend="pandas", page_size=2)
    session_id = opened["metadata"]["sessionId"]
    session = manager.sessions[session_id]
    cached_keys = list(session.page_cache)
    engine.corrupt = True

    with pytest.raises(EngineError, match="wrong projected width"):
        manager.get_page(
            session_id,
            0,
            0,
            2,
            {"filters": [], "sort": []},
            column_offset=0,
            column_limit=1,
        )

    assert list(session.page_cache) == cached_keys


def test_page_cache_byte_accounting_evicts_wide_utf8_blocks(tmp_path, monkeypatch) -> None:
    manager, _ = counting_manager()
    opened = manager.open_session(source(write_wide_unicode_values(tmp_path)), backend="pandas", page_size=1)
    session_id = opened["metadata"]["sessionId"]
    session = manager.sessions[session_id]
    first_size = session.page_cache_bytes
    assert first_size == sum(entry.size_bytes for entry in session.page_cache.values())

    monkeypatch.setattr(session_runtime, "PAGE_CACHE_BYTE_LIMIT", first_size * 2)
    manager.get_page(session_id, 0, 1, 1, {"filters": [], "sort": []})
    manager.get_page(session_id, 0, 2, 1, {"filters": [], "sort": []})

    assert session.page_cache_bytes <= session_runtime.PAGE_CACHE_BYTE_LIMIT
    assert session.page_cache_bytes == sum(entry.size_bytes for entry in session.page_cache.values())
    assert [key[2] for key in session.page_cache] == [1, 2]


def test_page_cache_never_retains_a_single_oversized_block(tmp_path, monkeypatch) -> None:
    manager, created = counting_manager()
    monkeypatch.setattr(session_runtime, "PAGE_CACHE_BYTE_LIMIT", 256)
    opened = manager.open_session(source(write_wide_unicode_values(tmp_path, rows=1)), backend="pandas", page_size=1)
    session_id = opened["metadata"]["sessionId"]
    session = manager.sessions[session_id]

    assert opened["page"]["rows"]
    assert session.page_cache == {}
    assert session.page_cache_bytes == 0

    manager.get_page(session_id, 0, 0, 1, {"filters": [], "sort": []})
    assert len(created[0].page_calls) == 2
    assert session.page_cache == {}
    assert session.page_cache_bytes == 0


@pytest.mark.parametrize(
    ("backend", "engine_factory"),
    [
        ("pandas", PandasEngine),
        ("polars", PolarsEngine),
        ("duckdb", DuckDBEngine),
    ],
)
def test_live_page_text_limit_rejects_before_cross_engine_cache_insertion_and_recovers(
    tmp_path: Path,
    backend: str,
    engine_factory: type[PandasEngine] | type[PolarsEngine] | type[DuckDBEngine],
) -> None:
    path = tmp_path / f"{backend}-payload.csv"
    path.write_text(f"safe,payload\nok,{'x' * 65_537}\n", encoding="utf-8")
    manager = SessionManager(EngineRegistry(((backend, engine_factory),)))
    opened = manager.open_session(source(path), backend=backend, page_size=1, column_offset=0, column_limit=1)
    session_id = opened["metadata"]["sessionId"]
    session = manager.sessions[session_id]
    session.clear_page_cache()

    with pytest.raises(LivePagePayloadError, match="65,536 Unicode code points"):
        manager.get_page(
            session_id,
            0,
            0,
            1,
            {"filters": [], "sort": []},
            column_offset=1,
            column_limit=1,
        )
    assert session.page_cache == {}
    assert session.page_cache_bytes == 0

    recovered = manager.get_page(
        session_id,
        0,
        0,
        1,
        {"filters": [], "sort": []},
        column_offset=0,
        column_limit=1,
    )
    assert recovered["page"]["rows"][0]["values"][0]["display"] == "ok"
    assert len(session.page_cache) == 1
    assert session.page_cache_bytes > 0
    manager.close_session(session_id, 0)


def test_live_page_budget_rejects_cells_nodes_depth_cycles_and_invalid_utf8(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def page_for(*cells: dict[str, Any]) -> dict[str, Any]:
        return {
            "offset": 0,
            "limit": 1,
            "totalRows": 1,
            "columnIds": [f"c:{index}" for index in range(len(cells))],
            "rows": [{"id": "r:0", "rowNumber": 0, "values": list(cells)}],
        }

    def cell(raw: Any, *, kind: str = "list", display: str = "value") -> dict[str, Any]:
        return {
            "kind": kind,
            "raw": raw,
            "display": display,
            "isNull": False,
            "isNaN": False,
        }

    monkeypatch.setattr(engine_base, "LIVE_PAGE_CELL_LIMIT", 1)
    with pytest.raises(LivePagePayloadError, match="at most 1 cells"):
        validate_live_page_payload(page_for(cell(1, kind="integer"), cell(2, kind="integer")))

    monkeypatch.setattr(engine_base, "LIVE_PAGE_CELL_LIMIT", 100_000)
    monkeypatch.setattr(engine_base, "LIVE_PAGE_COMPLEX_NODE_LIMIT", 3)
    with pytest.raises(LivePagePayloadError, match="at most 3 JSON nodes"):
        validate_live_page_payload(page_for(cell([1, 2, 3])))

    monkeypatch.setattr(engine_base, "LIVE_PAGE_COMPLEX_NODE_LIMIT", 100_000)
    monkeypatch.setattr(engine_base, "LIVE_PAGE_COMPLEX_DEPTH_LIMIT", 2)
    with pytest.raises(LivePagePayloadError, match="at most 2 nested levels"):
        validate_live_page_payload(page_for(cell([[[0]]])))

    monkeypatch.setattr(engine_base, "LIVE_PAGE_COMPLEX_DEPTH_LIMIT", 64)
    cyclic: list[Any] = []
    cyclic.append(cyclic)
    with pytest.raises(LivePagePayloadError, match="cyclic containers"):
        validate_live_page_payload(page_for(cell(cyclic)))

    with pytest.raises(LivePagePayloadError, match="valid strict UTF-8"):
        validate_live_page_payload(page_for(cell("\ud800", kind="string", display="\ud800")))


def test_live_page_protocol_byte_limit_accepts_the_exact_multibyte_boundary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page = {
        "offset": 0,
        "limit": 1,
        "totalRows": 1,
        "columnIds": ["c:value"],
        "rows": [
            {
                "id": "r:0",
                "rowNumber": 0,
                "values": [
                    {
                        "kind": "string",
                        "raw": "é😀",
                        "display": "é😀",
                        "isNull": False,
                        "isNaN": False,
                    }
                ],
            }
        ],
    }
    exact_size = validate_live_page_payload(page)
    assert exact_size == len(
        json.dumps(page, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    )

    monkeypatch.setattr(engine_base, "LIVE_PAGE_PROTOCOL_BYTE_LIMIT", exact_size)
    assert validate_live_page_payload(page) == exact_size
    monkeypatch.setattr(engine_base, "LIVE_PAGE_PROTOCOL_BYTE_LIMIT", exact_size - 1)
    with pytest.raises(LivePagePayloadError, match=f"at most {exact_size - 1:,} strict UTF-8 JSON bytes"):
        validate_live_page_payload(page)


@pytest.mark.parametrize("invalidation", ["replaced", "missing", "stopped"])
def test_live_pyspark_source_invalidation_precedes_cached_page_reads(
    monkeypatch: pytest.MonkeyPatch,
    invalidation: str,
) -> None:
    import __main__

    variable_name = "open_wrangler_live_cache_frame"
    original = pd.DataFrame({"value": [1, 2, 3]})
    monkeypatch.setattr(__main__, variable_name, original, raising=False)
    manager, created = live_notebook_manager()
    opened = manager.open_session(
        {"kind": "notebookVariable", "label": variable_name, "variableName": variable_name},
        backend="pyspark",
        page_size=2,
    )
    session_id = opened["metadata"]["sessionId"]
    session = manager.sessions[session_id]
    assert session.live_source_value is original
    assert len(session.page_cache) == 1
    assert created[0].page_calls == [(0, 2, 3)]

    if invalidation == "replaced":
        monkeypatch.setattr(__main__, variable_name, pd.DataFrame({"value": [10, 20, 30]}))
        message = "was replaced"
    elif invalidation == "missing":
        monkeypatch.delattr(__main__, variable_name)
        message = "no longer available"
    else:
        original.attrs["sparkStopped"] = True
        message = "Spark session that has stopped"

    with pytest.raises(LiveSourceInvalidatedError, match=message) as invalidated:
        manager.get_page(session_id, 0, 0, 2, {"filters": [], "sort": []})

    assert invalidated.value.session_id == session_id
    assert "If its columns or types changed, reopen the variable instead." in str(invalidated.value)
    assert created[0].page_calls == [(0, 2, 3)]
    assert not session.page_cache
    assert session.page_cache_bytes == 0
    assert manager.close_session(session_id, 0) == {"kind": "sessionClosed", "sessionId": session_id}
    assert session.live_source_value is None


def test_live_pyspark_source_is_revalidated_after_an_uncached_read(monkeypatch: pytest.MonkeyPatch) -> None:
    import __main__

    variable_name = "open_wrangler_live_postread_frame"
    original = pd.DataFrame({"value": [1, 2, 3]})
    replacement = pd.DataFrame({"value": [10, 20, 30]})
    monkeypatch.setattr(__main__, variable_name, original, raising=False)

    class ReplacingLiveEngine(LiveNotebookPandasEngine):
        replace_after_next_page = False

        def page(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
            page = super().page(*args, **kwargs)
            if self.replace_after_next_page:
                self.replace_after_next_page = False
                monkeypatch.setattr(__main__, variable_name, replacement)
            return page

    created: list[ReplacingLiveEngine] = []

    def create() -> ReplacingLiveEngine:
        engine = ReplacingLiveEngine()
        created.append(engine)
        return engine

    manager = SessionManager(EngineRegistry((("pyspark", create),)))
    opened = manager.open_session(
        {"kind": "notebookVariable", "label": variable_name, "variableName": variable_name},
        backend="pyspark",
        page_size=1,
    )
    session_id = opened["metadata"]["sessionId"]
    session = manager.sessions[session_id]
    created[0].replace_after_next_page = True

    with pytest.raises(LiveSourceInvalidatedError, match="was replaced") as invalidated:
        manager.get_page(session_id, 0, 1, 1, {"filters": [], "sort": []})

    assert invalidated.value.session_id == session_id
    assert created[0].page_calls == [(0, 1, 3), (1, 1, 3)]
    assert not session.page_cache
    assert session.page_cache_bytes == 0
    manager.close_session(session_id, 0)


def test_filter_and_sort_changes_invalidate_pages_but_keep_total_rows_exact(tmp_path) -> None:
    manager, created = counting_manager()
    opened = manager.open_session(source(write_values(tmp_path, 5)), backend="pandas", page_size=2)
    session_id = opened["metadata"]["sessionId"]
    session = manager.sessions[session_id]
    engine = created[0]

    filtered_model = greater_than(2)
    filtered = manager.get_page(session_id, 0, 0, 2, filtered_model)
    assert filtered["page"]["totalRows"] == 2
    assert filtered["metadata"]["filteredShape"] == {"rows": 2, "columns": 2}
    assert session.filtered_shape == {"rows": 2, "columns": 2}
    assert session.view_generation == 1
    assert engine.filter_calls == 1
    assert engine.page_calls[-1] == (0, 2, 2)
    first_filtered_page = filtered["page"]

    repeated = manager.get_page(session_id, 0, 0, 2, filtered_model)
    assert repeated["page"] is first_filtered_page
    assert engine.filter_calls == 1

    sorted_model = {**filtered_model, "sort": [{"column": "value", "direction": "desc", "nulls": "last"}]}
    sorted_page = manager.get_page(session_id, 0, 0, 2, sorted_model)
    assert sorted_page["page"]["totalRows"] == 2
    assert [row["values"][1]["display"] for row in sorted_page["page"]["rows"]] == ["4", "3"]
    assert session.view_generation == 2
    assert engine.filter_calls == 2

    unfiltered = manager.get_page(session_id, 0, 0, 2, {"filters": [], "sort": []})
    assert unfiltered["page"]["totalRows"] == 5
    assert session.view_generation == 3
    assert engine.filter_calls == 2


def test_view_queries_cannot_replace_the_confirmed_page_filter_before_preview(tmp_path) -> None:
    manager, _ = counting_manager()
    opened = manager.open_session(source(write_values(tmp_path, 5)), backend="pandas", page_size=2)
    session_id = opened["metadata"]["sessionId"]
    session = manager.sessions[session_id]
    old_profile_filter = greater_than(0)
    confirmed_page_filter = greater_than(2)

    page = manager.get_page(session_id, 0, 0, 2, confirmed_page_filter)
    assert page["page"]["totalRows"] == 2
    filtered_identity = session.filtered
    filtered_shape = dict(session.filtered_shape)
    generation = session.view_generation
    cache_items = list(session.page_cache.items())

    summary = manager.get_summary(session_id, 0, old_profile_filter, ["c:source:1"])
    values = manager.get_column_values(session_id, 0, "value", old_profile_filter)
    stats = manager.get_dataset_stats(session_id, 0, old_profile_filter)

    assert summary["summaries"][0]["totalCount"] == 4
    assert {item["value"] for item in values["values"]} == {"1", "2", "3", "4"}
    assert stats["stats"]["missingCells"] == 0
    assert session.filter_model == confirmed_page_filter
    assert session.filtered is filtered_identity
    assert session.filtered_shape == filtered_shape
    assert session.view_generation == generation
    assert list(session.page_cache.items()) == cache_items

    preview = manager.preview_step(session_id, 0, formula_step("double"), 0, 2)

    assert preview["metadata"]["filterModel"] == confirmed_page_filter
    assert preview["metadata"]["filteredShape"] == {"rows": 2, "columns": 3}
    assert preview["page"]["totalRows"] == 2
    assert [row["values"][1]["display"] for row in preview["page"]["rows"]] == ["3", "4"]


def test_draft_plan_and_close_invalidate_cache_without_rebuilding_an_unchanged_draft_view(tmp_path) -> None:
    manager, created = counting_manager()
    opened = manager.open_session(source(write_values(tmp_path, 4)), backend="pandas", page_size=2)
    session_id = opened["metadata"]["sessionId"]
    session = manager.sessions[session_id]
    engine = created[0]
    model = greater_than(1)

    manager.get_page(session_id, 0, 0, 2, model)
    assert session.view_generation == 1
    assert engine.filter_calls == 1

    preview = manager.preview_step(session_id, 0, formula_step("double"), 0, 2)
    assert preview["page"]["totalRows"] == 2
    assert session.view_generation == 2
    assert session.draft_shape == {"rows": 4, "columns": 3}
    assert [column["name"] for column in session.draft_schema or []] == ["name", "value", "doubled"]
    assert session.display_shape == session.draft_shape
    assert session.filtered_shape == {"rows": 2, "columns": 3}
    assert engine.filter_calls == 2

    filtered_identity = session.filtered
    page_calls = len(engine.page_calls)
    manager.get_page(session_id, 1, 0, 2, model)
    manager.get_summary(session_id, 1, model, ["c:step:double:0"])
    assert session.filtered is filtered_identity
    assert engine.filter_calls == 2
    assert len(engine.page_calls) == page_calls

    manager.discard_draft(session_id, 1, 0, 2)
    assert session.view_generation == 3
    assert session.draft_frame is None
    assert session.draft_shape is None
    assert session.display_shape == session.committed_shape
    assert engine.filter_calls == 3

    manager.preview_step(session_id, 2, formula_step("double"), 0, 2)
    assert session.view_generation == 4
    assert engine.filter_calls == 4
    manager.apply_draft(session_id, 3, 0, 2)
    assert session.view_generation == 5
    assert session.committed_shape == {"rows": 4, "columns": 3}
    assert session.draft_shape is None
    assert engine.filter_calls == 4

    manager.undo_step(session_id, 4, 0, 2)
    assert session.view_generation == 6
    assert session.committed_shape == session.source_shape == {"rows": 4, "columns": 2}
    assert session.committed_schema == session.source_schema
    assert engine.filter_calls == 5
    assert session.page_cache

    manager.close_session(session_id, 5)
    assert session.disposed
    assert session.view_generation == 7
    assert session.page_cache == {}
    assert session.page_cache_bytes == 0


def test_polars_known_total_avoids_lazy_count_and_stays_native(monkeypatch) -> None:
    engine = PolarsEngine()
    frame = pl.DataFrame({"value": [1, 2, 3]}).lazy()

    monkeypatch.setattr(
        pl.DataFrame,
        "to_pandas",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Polars paging must stay native")),
        raising=False,
    )
    monkeypatch.setattr(
        pl,
        "len",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("known totals must skip a count query")),
    )

    page = engine.page(frame, 0, 2, total_rows=3)
    assert page["totalRows"] == 3
    assert [row["values"][0]["display"] for row in page["rows"]] == ["1", "2"]


@pytest.mark.parametrize(
    "replacement",
    [
        "name,value\nrow-0,0\nrow-1,1\nrow-2,2\nrow-3,3\nrow-4,4\n",
        "name,value\nrow-0,0\n",
        "city,value\nrow-0,0\nrow-1,1\nrow-2,2\n",
    ],
    ids=["grow", "shrink", "schema"],
)
@pytest.mark.parametrize("backend", ["polars", "duckdb"])
def test_lazy_file_rejects_grow_shrink_and_schema_replacement_before_cached_page(
    tmp_path,
    replacement: str,
    backend: str,
) -> None:
    path = write_values(tmp_path, 3)
    manager = SessionManager()
    opened = manager.open_session(source(path), backend=backend, page_size=2)
    session_id = opened["metadata"]["sessionId"]
    session = manager.sessions[session_id]
    assert session.source_fingerprint is not None

    replace_source_atomically(path, replacement)

    with pytest.raises(EngineError, match=r"changed or is no longer available.*Reopen"):
        manager.get_page(session_id, 0, 0, 2, {"filters": [], "sort": []})
    assert not session.page_cache
    assert session.page_cache_bytes == 0

    # Source invalidation must never prevent deterministic cleanup.
    assert manager.close_session(session_id, 0)["kind"] == "sessionClosed"


def test_lazy_file_missing_after_open_is_recoverable_and_does_not_block_close(tmp_path) -> None:
    path = write_values(tmp_path, 3)
    manager = SessionManager()
    opened = manager.open_session(source(path), backend="polars", page_size=2)
    session_id = opened["metadata"]["sessionId"]
    path.unlink()

    with pytest.raises(EngineError, match=r"no longer available.*Reopen"):
        manager.get_summary(session_id, 0, {"filters": [], "sort": []}, ["c:source:1"])
    manager.close_session(session_id, 0)


@pytest.mark.parametrize(
    "request_kind",
    [
        "page",
        "summary",
        "columnValues",
        "datasetStats",
        "preview",
        "apply",
        "discard",
        "undo",
        "export",
    ],
)
def test_every_lazy_data_request_validates_the_source_fingerprint(tmp_path, request_kind: str) -> None:
    path = write_values(tmp_path, 3)
    manager = SessionManager()
    opened = manager.open_session(source(path), backend="polars", page_size=2)
    session_id = opened["metadata"]["sessionId"]
    revision = 0

    if request_kind in {"apply", "discard", "undo"}:
        revision = manager.preview_step(session_id, revision, formula_step("double"), 0, 2)["revision"]
    if request_kind == "undo":
        revision = manager.apply_draft(session_id, revision, 0, 2)["revision"]

    replace_source_atomically(path, "city,value\nrow-0,0\nrow-1,1\nrow-2,2\n")
    empty_filter = {"logic": "and", "filters": [], "sort": []}

    def make_request() -> Any:
        if request_kind == "page":
            return manager.get_page(session_id, revision, 0, 2, empty_filter)
        if request_kind == "summary":
            return manager.get_summary(session_id, revision, empty_filter, ["c:source:1"])
        if request_kind == "columnValues":
            return manager.get_column_values(session_id, revision, "value", empty_filter)
        if request_kind == "datasetStats":
            return manager.get_dataset_stats(session_id, revision, empty_filter)
        if request_kind == "preview":
            return manager.preview_step(session_id, revision, formula_step("changed-source"), 0, 2)
        if request_kind == "apply":
            return manager.apply_draft(session_id, revision, 0, 2)
        if request_kind == "discard":
            return manager.discard_draft(session_id, revision, 0, 2)
        if request_kind == "undo":
            return manager.undo_step(session_id, revision, 0, 2)
        return manager.export_data(session_id, revision, str(tmp_path / "cleaned.csv"), "csv")

    with pytest.raises(EngineError, match=r"Reopen the file"):
        make_request()
    assert not (tmp_path / "cleaned.csv").exists()
    manager.close_session(session_id, revision)


def test_only_lazy_file_sources_receive_fingerprints(tmp_path, monkeypatch) -> None:
    path = write_values(tmp_path, 3)
    pandas_manager = SessionManager()
    pandas_opened = pandas_manager.open_session(source(path), backend="pandas", page_size=2)
    pandas_id = pandas_opened["metadata"]["sessionId"]
    assert pandas_manager.sessions[pandas_id].source_fingerprint is None
    replace_source_atomically(path, "city,value\nrow-0,0\nrow-1,1\nrow-2,2\n")
    assert pandas_manager.get_page(pandas_id, 0, 0, 2, {"filters": [], "sort": []})["page"]["totalRows"] == 3
    pandas_manager.close_session(pandas_id, 0)

    import __main__

    monkeypatch.setattr(__main__, "fingerprint_notebook_frame", pl.DataFrame({"value": [1, 2]}), raising=False)
    notebook_manager = SessionManager()
    notebook_opened = notebook_manager.open_session(
        {
            "kind": "notebookVariable",
            "label": "fingerprint_notebook_frame",
            "variableName": "fingerprint_notebook_frame",
        },
        backend="polars",
    )
    notebook_id = notebook_opened["metadata"]["sessionId"]
    assert notebook_manager.sessions[notebook_id].source_fingerprint is None
    notebook_manager.close_session(notebook_id, 0)


def test_open_rejects_a_source_replaced_during_initial_page_materialization(tmp_path) -> None:
    path = write_values(tmp_path, 3)

    class ReplacingPolarsEngine(PolarsEngine):
        def page(
            self,
            frame: Any,
            offset: int,
            limit: int,
            *,
            total_rows: int | None = None,
            column_projection=None,
        ) -> dict[str, Any]:
            page = super().page(
                frame,
                offset,
                limit,
                total_rows=total_rows,
                column_projection=column_projection,
            )
            replace_source_atomically(path, "city,value\nrow-0,0\nrow-1,1\nrow-2,2\n")
            return page

    manager = SessionManager(EngineRegistry((("polars", ReplacingPolarsEngine),)))
    with pytest.raises(EngineError, match=r"Reopen the file"):
        manager.open_session(source(path), backend="polars", page_size=2)
    assert manager.sessions == {}


def test_lazy_read_failure_rechecks_source_and_clears_cached_pages(tmp_path) -> None:
    path = write_values(tmp_path, 4)

    class FailingAfterReplacementEngine(PolarsEngine):
        page_calls = 0

        def page(
            self,
            frame: Any,
            offset: int,
            limit: int,
            *,
            total_rows: int | None = None,
            column_projection=None,
        ) -> dict[str, Any]:
            self.page_calls += 1
            if self.page_calls == 2:
                replace_source_atomically(path, "city,value\nrow-0,0\nrow-1,1\n")
                raise RuntimeError("backend scan failed after replacement")
            return super().page(
                frame,
                offset,
                limit,
                total_rows=total_rows,
                column_projection=column_projection,
            )

    manager = SessionManager(EngineRegistry((("polars", FailingAfterReplacementEngine),)))
    opened = manager.open_session(source(path), backend="polars", page_size=2)
    session_id = opened["metadata"]["sessionId"]
    session = manager.sessions[session_id]
    assert session.page_cache

    with pytest.raises(EngineError, match=r"changed or is no longer available.*Reopen") as raised:
        manager.get_page(session_id, 0, 2, 2, {"filters": [], "sort": []})

    assert isinstance(raised.value.__cause__, RuntimeError)
    assert session.page_cache == {}
    assert session.page_cache_bytes == 0
    manager.close_session(session_id, 0)
