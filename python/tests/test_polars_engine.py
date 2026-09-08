from __future__ import annotations

import glob
import io
import json
import os
import subprocess
import sys
from copy import deepcopy
from decimal import Decimal
from math import nextafter
from pathlib import Path, PureWindowsPath
from textwrap import dedent
from types import SimpleNamespace
from typing import Any, Literal, cast

import polars as pl
import pytest

import openwrangler_runtime.engines.base as engine_base
import openwrangler_runtime.engines.polars_engine as polars_engine
from openwrangler_runtime._column_binding import bind_step
from openwrangler_runtime.engines.base import EngineError, typed_selection_value
from openwrangler_runtime.engines.polars_engine import PolarsEngine
from openwrangler_runtime.export_target import ExportWriterPath, _regular_file_identity
from openwrangler_runtime.lineage import source_lineage
from openwrangler_runtime.operations import validate_step
from openwrangler_runtime.session import SessionManager
from openwrangler_runtime.session_source import SourceChangedError

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("label", ["integer", "decimal", "bool", "array", "struct", "datetime", "plain"])
@pytest.mark.parametrize("lazy", [False, True])
def test_polars_enum_labels_do_not_change_profiles_or_typed_filters(label: str, lazy: bool) -> None:
    engine = PolarsEngine()
    source = pl.DataFrame({"value": pl.Series([label, "other", None], dtype=pl.Enum([label, "other"]))})
    before = source.clone()
    frame = source.lazy() if lazy else source
    assert engine.schema(frame)[0]["type"] == "string"
    summary = engine.summaries(frame)[0]
    assert summary["type"] == "string"
    assert summary["nullCount"] == 1
    values, truncated = engine.column_values(frame, "value")
    selected = next(item["selectionValue"] for item in values if item["value"] == label)
    assert not truncated
    assert selected == typed_selection_value(label, "string")
    column_filter = {
        "column": "value",
        "type": "string",
        "predicates": [],
        "valueFilter": {"kind": "values", "selectedValues": [selected], "includeNulls": False, "includeNaN": False},
    }
    filtered = engine.apply_filter_model(frame, {"filters": [column_filter], "sort": []})
    assert isinstance(filtered, pl.LazyFrame) == lazy
    assert (filtered.collect() if lazy else filtered).rows() == [(label,)]
    schema = engine.schema(frame)
    lineage = source_lineage(schema)
    operation = bind_step(
        validate_step(
            {
                "id": "enum-filter",
                "kind": "filterRows",
                "params": {
                    "filterModel": {
                        "filters": [{**column_filter, "column": lineage[0]}],
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
    generated = namespace["clean_data"](frame)
    assert isinstance(generated, pl.LazyFrame) == lazy
    assert (generated.collect() if lazy else generated).rows() == [(label,)]
    assert source.equals(before)


@pytest.mark.parametrize("lazy", [False, True])
def test_polars_nested_array_does_not_replace_outer_struct_family(lazy: bool) -> None:
    engine = PolarsEngine()
    source = pl.DataFrame(
        {"value": pl.Series([{"payload": [1, 2]}, None], dtype=pl.Struct({"payload": pl.Array(pl.Int64, 2)}))}
    )
    before = source.clone()
    frame = source.lazy() if lazy else source
    assert engine.schema(frame)[0]["type"] == "struct"
    summary = engine.summaries(frame)[0]
    assert summary["type"] == "struct"
    assert summary["nullCount"] == 1
    with pytest.raises(EngineError, match="sorting is unavailable for struct columns"):
        engine.apply_filter_model(frame, {"filters": [], "sort": [{"column": "value", "direction": "asc"}]})
    assert source.equals(before)


def reserve_export_target(path: Path) -> dict[str, str]:
    path.touch(exist_ok=False)
    device, inode = _regular_file_identity(path)
    return {"device": str(device), "inode": str(inode)}


def export_options(format_name: str) -> dict[str, object]:
    return (
        {"format": "csv", "delimiter": ",", "quoteChar": '"', "encoding": "utf-8", "header": True}
        if format_name == "csv"
        else {"format": "parquet"}
    )


def _write_polars_file(path: Path, extension: str, values: list[int]) -> None:
    frame = pl.DataFrame({"value": values, "label": [f"row-{index}" for index in range(len(values))]})
    if extension == "csv":
        frame.write_csv(path)
    elif extension == "tsv":
        frame.write_csv(path, separator="\t")
    elif extension == "parquet":
        frame.write_parquet(path)
    else:
        assert extension == "jsonl"
        frame.write_ndjson(path)


@pytest.mark.parametrize(
    ("source", "pyarrow_available", "expected_imports"),
    (
        ({"kind": "file", "path": "sample.XLSX"}, True, ["polars", "pyarrow"]),
        ({"kind": "file", "path": "legacy.xls"}, True, ["polars", "pyarrow"]),
        ({"kind": "file", "path": "sample.xlsx"}, False, ["polars"]),
        ({"kind": "file", "path": "sample.csv"}, True, ["polars"]),
        ({"kind": "notebookVariable", "variableName": "frame"}, True, ["polars"]),
    ),
)
def test_polars_preparation_preloads_only_an_installed_excel_pyarrow_bridge(
    source: dict[str, Any],
    pyarrow_available: bool,
    expected_imports: list[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    imported: list[str] = []

    def find_optional_module(name: str) -> object | None:
        assert name == "pyarrow"
        return object() if pyarrow_available else None

    monkeypatch.setattr(engine_base, "import_module", imported.append)
    monkeypatch.setattr(polars_engine, "find_spec", find_optional_module)
    monkeypatch.setattr(polars_engine, "import_module", imported.append)

    PolarsEngine().prepare(source)

    assert imported == expected_imports


def test_polars_file_session_pages_filters_and_summarizes_without_pandas(monkeypatch):
    def fail_to_pandas(*_args, **_kwargs):
        raise AssertionError("Polars sessions must not convert to pandas")

    monkeypatch.setattr(pl.DataFrame, "to_pandas", fail_to_pandas, raising=False)

    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": "sample.csv", "path": str(ROOT / "fixtures" / "sample.csv")},
        backend="polars",
        page_size=2,
    )

    assert opened["metadata"]["backend"] == "polars"
    assert opened["metadata"]["shape"] == {"rows": 4, "columns": 4}
    assert "stats" not in opened["metadata"]
    assert opened["page"]["rows"][0]["values"][0]["display"] == "Milan"

    session = manager.sessions[opened["metadata"]["sessionId"]]
    assert isinstance(session.original, pl.LazyFrame)
    stats = manager.get_dataset_stats(opened["metadata"]["sessionId"], 0, {"filters": [], "sort": []})
    assert stats["stats"]["missingValuesByColumn"][0] == {"column": "city", "count": 0}

    filter_model = {
        "filters": [
            {
                "column": "city",
                "type": "string",
                "valueFilter": None,
                "predicates": [{"kind": "predicate", "operator": "contains", "value": "i"}],
            }
        ],
        "sort": [{"column": "sales", "direction": "desc", "nulls": "last"}],
    }
    page = manager.get_page(opened["metadata"]["sessionId"], 0, 0, 10, filter_model)

    assert page["metadata"]["filteredShape"]["rows"] == 3
    assert [row["values"][0]["display"] for row in page["page"]["rows"]] == ["Berlin", "Milan", "Paris"]

    sales_id = next(column["id"] for column in opened["metadata"]["schema"] if column["name"] == "sales")
    summary = manager.get_summary(opened["metadata"]["sessionId"], 0, filter_model, [sales_id])
    assert summary["summaries"][0]["numeric"]["max"] == 12.0
    assert summary["summaries"][0]["visualization"]["kind"] == "numeric"
    assert summary["summaries"][0]["visualization"]["bins"]


@pytest.mark.parametrize("extension", ["csv", "tsv", "parquet", "jsonl"])
def test_polars_file_scans_treat_glob_metacharacters_as_literal_path_characters(
    extension: str,
    tmp_path: Path,
) -> None:
    path = tmp_path / f"[published] source.{extension}"
    _write_polars_file(path, extension, [17, 18])
    _write_polars_file(tmp_path / f"p source.{extension}", extension, [99])

    options = {"delimiter": "\t"} if extension == "tsv" else None
    if extension == "jsonl" and os.name == "nt":
        with pytest.raises(EngineError, match="Windows.*glob"):
            PolarsEngine().read_file(str(path), options)
        return
    frame = PolarsEngine().read_file(str(path), options)

    assert isinstance(frame, pl.LazyFrame)
    assert frame.collect().get_column("value").to_list() == [17, 18]


@pytest.mark.parametrize(
    ("name", "verbatim"),
    [
        *[
            pytest.param(name, False, marks=pytest.mark.skipif(os.name == "nt", reason="Unix literal-path read."))
            for name in [
                "[selected].jsonl",
                "question?.ndjson",
                "star*.ndjson",
                "space %20 {x}].ndjson",
                "[nested]/source.ndjson",
                "back\\slash.ndjson",
            ]
        ],
        *[
            pytest.param(name, True, marks=pytest.mark.skipif(os.name != "nt", reason="Native Windows path read."))
            for name in ["plain.jsonl", "space %20 {x}].ndjson"]
        ],
    ],
)
def test_polars_ndjson_session_reads_only_the_selected_file_and_invalidates_replacement(
    name: str, verbatim: bool, tmp_path: Path
) -> None:
    path = tmp_path / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b'{"value":17}\n{"value":18}\n')
    before = path.read_bytes()
    escaped = Path(glob.escape(str(path)))
    if escaped != path:
        escaped.mkdir(parents=True)
        (escaped / "other.ndjson").write_bytes(b'{"value":99}\n')
    encoded = tmp_path / path.as_uri().rsplit("/", 1)[1]
    if encoded != path:
        encoded.write_bytes(b'{"value":99}\n')
    selected_path = "\\\\?\\" + str(path.absolute()) if verbatim else str(path)
    manager = SessionManager()
    opened = manager.open_session({"kind": "file", "label": name, "path": selected_path}, backend="polars", page_size=1)
    session_id = opened["metadata"]["sessionId"]
    try:
        assert opened["page"]["rows"][0]["values"][0]["display"] == "17"
        assert opened["metadata"]["shape"] == {"rows": 2, "columns": 1}
        page = manager.get_page(session_id, 0, 1, 1, {"filters": [], "sort": []})
        assert page["page"]["rows"][0]["values"][0]["display"] == "18"
        frame = manager.sessions[session_id].original
        engine = PolarsEngine()
        schema = engine.schema(frame)
        lineage = source_lineage(schema)
        operation = bind_step(
            validate_step(
                {
                    "id": "sort",
                    "kind": "sortRows",
                    "params": {"rules": [{"column": lineage[0], "direction": "desc", "nulls": "last"}]},
                }
            ),
            schema,
            lineage,
        )
        engine.validate_transform_preflight(frame, operation, engine.shape(frame))
        namespace: dict[str, Any] = {}
        exec(engine.compile_plan([operation]), namespace)
        for result in (engine.apply_transform(frame, operation), namespace["clean_data"](frame)):
            assert isinstance(result, pl.LazyFrame)
            assert result.collect().get_column("value").to_list() == [18, 17]
        assert path.read_bytes() == before
        path.rename(tmp_path / "original.ndjson")
        path.write_bytes(b'{"value":99}\n')
        with pytest.raises(SourceChangedError):
            manager.get_page(session_id, 0, 0, 1, {"filters": [], "sort": []})
    finally:
        manager.close_session(session_id, 0)
    assert not manager.sessions


@pytest.mark.skipif(os.name == "nt", reason="The native descriptor bridge is Unix-only.")
def test_polars_ndjson_native_plan_outlives_the_closed_builtin_stream(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "lifetime.ndjson"
    path.write_bytes(b'{"value":17}\n{"value":18}\n')
    native_scan = pl.scan_ndjson
    streams: list[io.BufferedReader] = []

    def scan(source: Any) -> pl.LazyFrame:
        assert type(source) is io.BufferedReader
        assert not source.closed
        streams.append(source)
        return native_scan(source)

    monkeypatch.setattr(pl, "scan_ndjson", scan)
    frame = PolarsEngine().read_file(str(path))
    assert streams[0].closed
    clone = frame.clone()
    del frame
    assert clone.select("value").limit(1).collect().to_dicts() == [{"value": 17}]
    assert clone.collect().get_column("value").to_list() == [17, 18]


@pytest.mark.parametrize(
    ("name", "accepted"),
    [
        (r"C:\plain.ndjson", True),
        (r"C:\space %20 {x}].jsonl", True),
        (r"C:\[selected].jsonl", False),
        (r"C:\question?.jsonl", False),
        (r"C:\star*.jsonl", False),
        (r"\\?\C:\plain.jsonl", True),
        (r"\\?\c:\space %20 {x}].ndjson", True),
        (r"\\?\C:\[selected].jsonl", False),
        (r"\\?\C:\[parent]\plain.jsonl", False),
        (r"\\?\C:\question?.jsonl", False),
        (r"\\?\C:\star*.jsonl", False),
        (r"\\?\UNC\server\share\plain.jsonl", False),
        (r"\\server\share\plain.jsonl", True),
        (r"\\?\Volume{fixture}\plain.jsonl", False),
        (r"\\?\C:plain.jsonl", False),
    ],
)
def test_polars_ndjson_windows_branch_uses_direct_paths_or_refuses_glob_syntax(
    name: str, accepted: bool, monkeypatch: pytest.MonkeyPatch
) -> None:
    # This checks dispatch on every platform; native Windows qualification is separate.
    class WindowsPath(PureWindowsPath):
        def expanduser(self) -> WindowsPath:
            return self

        def absolute(self) -> WindowsPath:
            return self

    calls: list[str] = []
    monkeypatch.setattr(polars_engine, "Path", WindowsPath)
    monkeypatch.setattr(polars_engine, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(pl, "scan_ndjson", lambda source: calls.append(source))
    if not accepted:
        with pytest.raises(EngineError):
            PolarsEngine().read_file(name)
        assert not calls
    else:
        PolarsEngine().read_file(name)
        assert calls == [name]


@pytest.mark.skipif(os.name == "nt", reason="Resource limits and native file duplication are Unix-only.")
@pytest.mark.parametrize("exhaust", [False, True])
@pytest.mark.parametrize("constructor_failure", [False, True])
def test_polars_ndjson_native_handle_failure_refuses_buffering_in_an_isolated_process(
    exhaust: bool, constructor_failure: bool, tmp_path: Path
) -> None:
    path = tmp_path / "source.ndjson"
    path.write_bytes(b'{"value":17}\n' * 100_000)
    script = dedent("""
        import gc, os, resource, sys, tracemalloc
        from pathlib import Path
        import polars as pl
        from openwrangler_runtime.engines.polars_engine import PolarsEngine
        from openwrangler_runtime.engines.base import EngineError

        path, exhaust, constructor_failure = sys.argv[1], sys.argv[2] == 'True', sys.argv[3] == 'True'
        engine = PolarsEngine()
        engine.read_file(path).limit(1).collect()
        gc.collect()
        native_scan = pl.scan_ndjson
        if constructor_failure:
            def fail_after_source(*args, **kwargs):
                native_scan(*args, **kwargs)
                raise ValueError('owned constructor failure')
            pl.scan_ndjson = fail_after_source
        limit = resource.getrlimit(resource.RLIMIT_NOFILE)
        fillers = []
        frame = None
        outcome = 'returned'
        try:
            if exhaust:
                soft = 64 if limit[0] == resource.RLIM_INFINITY else min(64, limit[0])
                resource.setrlimit(resource.RLIMIT_NOFILE, (soft, limit[1]))
                while True:
                    try:
                        fillers.append(os.open(os.devnull, os.O_RDONLY))
                    except OSError:
                        break
                os.close(fillers.pop())  # Builtin open succeeds, but native duplication cannot.
            tracemalloc.start()
            try:
                frame = engine.read_file(path)
            except EngineError as error:
                assert 'native file handle' in str(error), str(error)
                outcome = 'refused'
            except ValueError as error:
                assert str(error) == 'owned constructor failure'
                outcome = 'constructor failure'
            finally:
                peak = tracemalloc.get_traced_memory()[1]
                tracemalloc.stop()
        finally:
            for descriptor in fillers:
                os.close(descriptor)
            resource.setrlimit(resource.RLIMIT_NOFILE, limit)
        expected = 'refused' if exhaust else 'constructor failure' if constructor_failure else 'returned'
        assert outcome == expected, (outcome, expected)
        assert peak < Path(path).stat().st_size // 2, peak
        if frame is not None:
            assert frame.limit(1).collect().to_dicts() == [{'value': 17}]
        del frame
        gc.collect()
        if sys.platform.startswith('linux'):
            selected = Path(path).stat()
            for entry in Path('/proc/self/fd').iterdir():
                try:
                    metadata = os.fstat(int(entry.name))
                except OSError:
                    continue
                assert (metadata.st_dev, metadata.st_ino) != (selected.st_dev, selected.st_ino)
    """)
    result = subprocess.run(
        [sys.executable, "-c", script, str(path), str(exhaust), str(constructor_failure)],
        env={**os.environ, "PYTHONPATH": str(ROOT / "python")},
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stderr == ""


def test_polars_literal_file_scan_disables_a_native_glob_option(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "[published] source.parquet"
    _write_polars_file(path, "parquet", [17, 18])
    native_scan_parquet = pl.scan_parquet
    calls: list[tuple[str, bool]] = []

    def scan_parquet(source: str, *, glob: bool = True, **options: Any) -> pl.LazyFrame:
        calls.append((source, glob))
        return native_scan_parquet(source, glob=glob, **options)

    monkeypatch.setattr(pl, "scan_parquet", scan_parquet)

    frame = PolarsEngine().read_file(str(path))

    assert isinstance(frame, pl.LazyFrame)
    assert frame.collect().height == 2
    assert calls == [(str(path), False)]


def test_polars_session_opens_pages_and_closes_a_literal_bracket_path(tmp_path: Path) -> None:
    path = tmp_path / "[Live] customer snapshot.csv"
    _write_polars_file(path, "csv", [17, 18])
    source_bytes = path.read_bytes()
    manager = SessionManager()

    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend="polars",
        page_size=1,
    )
    session_id = opened["metadata"]["sessionId"]

    assert opened["metadata"]["shape"] == {"rows": 2, "columns": 2}
    assert isinstance(manager.sessions[session_id].original, pl.LazyFrame)
    second_page = manager.get_page(session_id, 0, 1, 1, {"filters": [], "sort": []})
    assert len(second_page["page"]["rows"]) == 1
    assert manager.close_session(session_id, 0) == {"kind": "sessionClosed", "sessionId": session_id}
    assert session_id not in manager.sessions
    assert path.read_bytes() == source_bytes


def test_lazy_polars_page_projects_before_the_terminal_collect(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = PolarsEngine()
    frame = engine.ensure_row_ids(
        pl.DataFrame({"omitted": [10, 20], "selected": [30, 40], "also_omitted": [50, 60]}).lazy(),
        "projection-order",
    )
    events: list[str] = []
    selected_columns: list[list[str]] = []
    native_select = pl.LazyFrame.select
    native_collect = pl.LazyFrame.collect

    def tracked_select(lazy_frame: pl.LazyFrame, *columns: Any, **kwargs: Any) -> pl.LazyFrame:
        events.append("select")
        values = columns[0] if len(columns) == 1 and isinstance(columns[0], list) else columns
        selected_columns.append([str(value) for value in values])
        return native_select(lazy_frame, *columns, **kwargs)

    def tracked_collect(lazy_frame: pl.LazyFrame, *args: Any, **kwargs: Any) -> pl.DataFrame:
        events.append("collect")
        return cast(pl.DataFrame, native_collect(lazy_frame, *args, **kwargs))

    monkeypatch.setattr(pl.LazyFrame, "select", tracked_select)
    monkeypatch.setattr(pl.LazyFrame, "collect", tracked_collect)

    page = engine.page(
        frame,
        0,
        2,
        total_rows=2,
        column_projection=[(1, "stable:selected")],
    )

    assert events == ["select", "collect"]
    assert selected_columns and "selected" in selected_columns[0]
    assert "omitted" not in selected_columns[0]
    assert "also_omitted" not in selected_columns[0]
    assert page["columnIds"] == ["stable:selected"]
    assert [row["values"][0]["display"] for row in page["rows"]] == ["30", "40"]


@pytest.mark.parametrize("extension", ["csv", "parquet", "jsonl"])
def test_real_polars_scan_selects_only_the_page_projection_before_collect(
    extension: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / f"projection.{extension}"
    source = pl.DataFrame({"omitted": [10, 20], "selected": [30, 40], "also_omitted": [50, 60]})
    if extension == "csv":
        source.write_csv(path)
    elif extension == "parquet":
        source.write_parquet(path)
    else:
        source.write_ndjson(path)

    engine = PolarsEngine()
    frame = engine.ensure_row_ids(engine.read_file(str(path)), f"real-{extension}-projection")
    assert isinstance(frame, pl.LazyFrame)
    private_columns = set(frame.collect_schema().names()) - {"omitted", "selected", "also_omitted"}
    assert len(private_columns) == 1
    row_id = next(iter(private_columns))
    events: list[str] = []
    selected_columns: list[list[str]] = []
    native_select = pl.LazyFrame.select
    native_collect = pl.LazyFrame.collect

    def tracked_select(lazy_frame: pl.LazyFrame, *columns: Any, **kwargs: Any) -> pl.LazyFrame:
        events.append("select")
        values = columns[0] if len(columns) == 1 and isinstance(columns[0], list) else columns
        selected_columns.append([str(value) for value in values])
        return native_select(lazy_frame, *columns, **kwargs)

    def tracked_collect(lazy_frame: pl.LazyFrame, *args: Any, **kwargs: Any) -> pl.DataFrame:
        events.append("collect")
        return cast(pl.DataFrame, native_collect(lazy_frame, *args, **kwargs))

    monkeypatch.setattr(pl.LazyFrame, "select", tracked_select)
    monkeypatch.setattr(pl.LazyFrame, "collect", tracked_collect)

    page = engine.page(
        frame,
        0,
        2,
        total_rows=2,
        column_projection=[(1, "stable:selected")],
    )

    assert events == ["select", "collect"]
    assert selected_columns == [[row_id, "selected"]]
    assert page["columnIds"] == ["stable:selected"]
    assert [row["values"][0]["display"] for row in page["rows"]] == ["30", "40"]


def test_polars_column_values_and_parquet(tmp_path):
    frame = pl.DataFrame({"group": ["a", "a", "b"], "value": [1, 2, 3]})
    path = tmp_path / "sample.parquet"
    frame.write_parquet(path)

    manager = SessionManager()
    opened = manager.open_session({"kind": "file", "label": "sample.parquet", "path": str(path)}, backend="polars")
    values = manager.get_column_values(opened["metadata"]["sessionId"], 0, "group", {"filters": [], "sort": []})

    assert values["values"] == [
        {"value": "a", "count": 2, "selectionValue": typed_selection_value("a", "string")},
        {"value": "b", "count": 1, "selectionValue": typed_selection_value("b", "string")},
    ]


def test_polars_excel_reader_pins_the_probed_calamine_engine(monkeypatch):
    calls: list[tuple[str, dict[str, object]]] = []

    def read_excel(path: str, **options: object) -> pl.DataFrame:
        calls.append((path, options))
        return pl.DataFrame({"value": [1]})

    monkeypatch.setattr(pl, "read_excel", read_excel)
    runtime = PolarsEngine()

    runtime.read_file("default.xlsx")
    runtime.read_file("modern.xlsx", {"sheetIndex": 1})
    runtime.read_file("legacy.xls", {"sheetName": " résumé "})

    assert calls == [
        ("default.xlsx", {"sheet_id": 1, "engine": "calamine"}),
        ("modern.xlsx", {"sheet_id": 2, "engine": "calamine"}),
        ("legacy.xls", {"sheet_name": " résumé ", "engine": "calamine"}),
    ]


def test_lazy_polars_schema_discovery_does_not_collect_column_profiles(monkeypatch):
    frame = pl.DataFrame({"complete": [1, 2], "with_null": [1, None]}).lazy()

    def reject_collect(*_args, **_kwargs):
        raise AssertionError("Lazy schema discovery must not execute the data plan")

    monkeypatch.setattr(pl.LazyFrame, "collect", reject_collect)

    schema = PolarsEngine().schema(frame)

    assert [(column["name"], column["rawType"], column["nullable"]) for column in schema] == [
        ("complete", "Int64", True),
        ("with_null", "Int64", True),
    ]


def test_polars_normalize_keeps_lazyframes_and_converts_series() -> None:
    engine = PolarsEngine()
    lazy = pl.DataFrame({"value": [1, 2]}).lazy()

    assert engine.normalize(lazy) is lazy
    normalized_series = engine.normalize(pl.Series("value", [1, 2]))
    assert isinstance(normalized_series, pl.DataFrame)
    assert normalized_series.to_dict(as_series=False) == {"value": [1, 2]}


@pytest.mark.parametrize("format_name", ["csv", "parquet"])
def test_lazy_polars_export_streams_to_the_exact_reserved_file_object(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    format_name: Literal["csv", "parquet"],
) -> None:
    frame = pl.LazyFrame({"value": [1, 2, 3]})
    destination = tmp_path / f"lazy-stream.{format_name}"
    destination.touch()
    identity = _regular_file_identity(destination)
    writer_path = ExportWriterPath(destination, *identity)
    observed_writers: list[Any] = []
    native_sink = pl.LazyFrame.sink_csv if format_name == "csv" else pl.LazyFrame.sink_parquet

    def observed_sink(lazy_frame: pl.LazyFrame, writer: Any, *args: Any, **kwargs: Any) -> Any:
        assert not isinstance(writer, (str, Path))
        assert callable(getattr(writer, "write", None))
        observed_writers.append(writer)
        return native_sink(lazy_frame, writer, *args, **kwargs)

    monkeypatch.setattr(pl.LazyFrame, f"sink_{format_name}", observed_sink)

    monkeypatch.setattr(
        pl.DataFrame,
        "to_pandas",
        lambda *_args, **_kwargs: pytest.fail("Polars export must not convert to Pandas"),
        raising=False,
    )

    PolarsEngine().export_data(frame, writer_path, export_options(format_name))

    assert len(observed_writers) == 1
    assert observed_writers[0].closed is True
    assert _regular_file_identity(destination) == identity
    result = pl.read_csv(destination) if format_name == "csv" else pl.read_parquet(destination)
    assert result.to_dict(as_series=False) == {"value": [1, 2, 3]}


def test_live_notebook_lazyframe_stays_lazy_through_bounded_queries_edit_export_and_close(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import __main__

    row_count = 1_000_003
    source_path = tmp_path / "large-live-source.parquet"
    (
        pl.LazyFrame()
        .select(pl.int_range(0, row_count).alias("row"))
        .with_columns(
            [
                (pl.col("row") % 7).alias("group"),
                (pl.lit("ROW-") + (pl.col("row") % 17).cast(pl.String)).alias("label"),
                ((pl.col("row") * 13) % 10_000).alias("score"),
            ]
        )
        .sink_parquet(source_path)
    )
    live = pl.scan_parquet(source_path)
    original_schema = live.collect_schema()
    original_plan = live.explain(optimized=False)
    monkeypatch.setattr(__main__, "large_live_lazyframe", live, raising=False)

    native_collect = pl.LazyFrame.collect
    native_collect_all = pl.collect_all
    native_to_list = pl.Series.to_list
    collected_heights: list[int] = []
    to_list_lengths: list[int] = []

    def bounded_collect(frame: pl.LazyFrame, *args: Any, **kwargs: Any) -> pl.DataFrame:
        result = cast(pl.DataFrame, native_collect(frame, *args, **kwargs))
        collected_heights.append(result.height)
        assert result.height <= 20, "A live LazyFrame query collected an unbounded result."
        return result

    def bounded_collect_all(frames: Any, *args: Any, **kwargs: Any) -> list[pl.DataFrame]:
        results = native_collect_all(frames, *args, **kwargs)
        collected_heights.extend(result.height for result in results)
        assert all(result.height <= 20 for result in results), "A live LazyFrame profile collected unbounded results."
        return results

    def bounded_to_list(series: pl.Series) -> list[Any]:
        to_list_lengths.append(len(series))
        assert len(series) <= 20, "A live LazyFrame query converted an unbounded series to a list."
        return native_to_list(series)

    def reject_to_pandas(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("A live Polars LazyFrame must remain Polars-native.")

    monkeypatch.setattr(pl.LazyFrame, "collect", bounded_collect)
    monkeypatch.setattr(pl, "collect_all", bounded_collect_all)
    monkeypatch.setattr(pl.Series, "to_list", bounded_to_list)
    monkeypatch.setattr(pl.DataFrame, "to_pandas", reject_to_pandas, raising=False)

    manager = SessionManager()
    opened = manager.open_session(
        {
            "kind": "notebookVariable",
            "label": "large_live_lazyframe",
            "variableName": "large_live_lazyframe",
        },
        backend="polars",
        mode="editing",
        page_size=3,
        column_offset=2,
        column_limit=1,
    )
    session_id = opened["metadata"]["sessionId"]
    runtime = manager.sessions[session_id]

    assert opened["metadata"]["shape"] == {"rows": row_count, "columns": 4}
    assert opened["metadata"]["capabilities"]["lazy"] is True
    assert opened["summaries"] == []
    assert [column["name"] for column in opened["metadata"]["schema"]] == ["row", "group", "label", "score"]
    assert opened["page"]["columnIds"] == [opened["metadata"]["schema"][2]["id"]]
    assert [row["values"][0]["display"] for row in opened["page"]["rows"]] == ["ROW-0", "ROW-1", "ROW-2"]
    assert isinstance(runtime.original, pl.LazyFrame)
    assert isinstance(runtime.committed, pl.LazyFrame)

    filter_model = {
        "logic": "and",
        "filters": [
            {
                "column": "group",
                "type": "integer",
                "logic": "and",
                "valueFilter": None,
                "predicates": [{"kind": "predicate", "operator": "equals", "value": 3}],
            }
        ],
        "sort": [{"column": "score", "direction": "desc", "nulls": "last"}],
    }
    filtered_page = manager.get_page(
        session_id,
        0,
        120,
        5,
        filter_model,
        column_offset=0,
        column_limit=2,
    )
    assert filtered_page["metadata"]["capabilities"]["lazy"] is True
    assert filtered_page["page"]["columnIds"] == [
        opened["metadata"]["schema"][0]["id"],
        opened["metadata"]["schema"][1]["id"],
    ]
    assert len(filtered_page["page"]["rows"]) == 5
    assert all(row["values"][1]["display"] == "3" for row in filtered_page["page"]["rows"])

    score_id = opened["metadata"]["schema"][3]["id"]
    summary = manager.get_summary(session_id, 0, filter_model, [score_id])
    assert summary["summaries"][0]["totalCount"] == filtered_page["metadata"]["filteredShape"]["rows"]
    assert summary["summaries"][0]["numeric"]["max"] == 9999.0
    stats = manager.get_dataset_stats(session_id, 0, filter_model)
    assert stats["stats"]["missingCells"] == 0
    assert len(stats["stats"]["missingValuesByColumn"]) == 4

    label_column = opened["metadata"]["schema"][2]
    preview = manager.preview_step(
        session_id,
        0,
        {
            "id": "lower-live-label",
            "kind": "lowerText",
            "params": {
                "column": {"id": label_column["id"], "name": label_column["name"]},
                "newColumn": "label_lower",
            },
        },
        0,
        4,
        column_offset=3,
        column_limit=2,
    )
    assert preview["metadata"]["capabilities"]["lazy"] is True
    assert isinstance(runtime.draft_frame, pl.LazyFrame)
    assert preview["diff"]["addedColumns"] == ["label_lower"]
    assert preview["page"]["rows"][0]["values"][1]["display"].startswith("row-")

    applied = manager.apply_draft(session_id, 1, 0, 4, column_offset=3, column_limit=2)
    assert applied["metadata"]["capabilities"]["lazy"] is True
    assert isinstance(runtime.committed, pl.LazyFrame)

    export_path = tmp_path / "large-live-cleaned.parquet"
    exported = manager.export_data(
        session_id,
        2,
        str(export_path),
        export_options("parquet"),
        reserve_export_target(export_path),
    )
    assert exported["shape"] == {"rows": row_count, "columns": 5}
    exported_metrics = (
        pl.scan_parquet(export_path)
        .select(
            [
                pl.len().alias("rows"),
                pl.col("label_lower").first().alias("first_label"),
            ]
        )
        .collect(engine="streaming")
    )
    assert exported_metrics.row(0) == (row_count, "row-0")

    assert manager.close_session(session_id, 2) == {"kind": "sessionClosed", "sessionId": session_id}
    assert session_id not in manager.sessions
    assert live.collect_schema() == original_schema
    assert live.explain(optimized=False) == original_plan
    assert collected_heights
    assert max(collected_heights) <= 20
    assert all(length <= 20 for length in to_list_lengths)


@pytest.mark.parametrize("kind", ["oneHotEncode", "multiLabelBinarize"])
def test_live_notebook_lazyframe_materializes_only_after_explicit_dynamic_encoder_preview(
    kind: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import __main__

    source_path = tmp_path / f"explicit-{kind}.parquet"
    pl.DataFrame({"category": ["a", "b", "a"], "tags": ["x|y", "y", "x"]}).write_parquet(source_path)
    live = pl.scan_parquet(source_path)
    monkeypatch.setattr(__main__, "explicit_lazy_encoder", live, raising=False)
    native_collect = pl.LazyFrame.collect
    collected_heights: list[int] = []

    def tracked_collect(frame: pl.LazyFrame, *args: Any, **kwargs: Any) -> pl.DataFrame:
        result = cast(pl.DataFrame, native_collect(frame, *args, **kwargs))
        collected_heights.append(result.height)
        return result

    monkeypatch.setattr(pl.LazyFrame, "collect", tracked_collect)
    manager = SessionManager()
    opened = manager.open_session(
        {
            "kind": "notebookVariable",
            "label": "explicit_lazy_encoder",
            "variableName": "explicit_lazy_encoder",
        },
        backend="polars",
        mode="editing",
        page_size=2,
    )
    session_id = opened["metadata"]["sessionId"]
    assert opened["metadata"]["capabilities"]["lazy"] is True
    assert max(collected_heights) <= 2
    collected_heights.clear()

    schema = {column["name"]: column for column in opened["metadata"]["schema"]}
    if kind == "oneHotEncode":
        params = {
            "columns": [{"id": schema["category"]["id"], "name": "category"}],
            "dropOriginal": False,
        }
    else:
        params = {
            "column": {"id": schema["tags"]["id"], "name": "tags"},
            "delimiter": "|",
            "dropOriginal": False,
        }
    preview = manager.preview_step(
        session_id,
        0,
        {"id": f"explicit-{kind}", "kind": kind, "params": params},
        0,
        2,
    )

    assert collected_heights[0] == 3
    assert max(collected_heights) == 3
    assert isinstance(manager.sessions[session_id].draft_frame, pl.DataFrame)
    assert preview["metadata"]["capabilities"]["lazy"] is False
    manager.close_session(session_id, 1)


def test_lazy_polars_numeric_summary_is_exact_with_only_bounded_collections(monkeypatch):
    row_count = 12_305
    values = pl.concat(
        [
            pl.int_range(0, row_count - 1, eager=True) % 101,
            pl.Series([1_000_000]),
        ]
    )
    source = pl.DataFrame({"value": pl.concat([pl.Series([-1] * 500), values])}).lazy()
    frame = PolarsEngine().apply_filter_model(
        source,
        {
            "logic": "and",
            "filters": [
                {
                    "column": "value",
                    "type": "integer",
                    "logic": "and",
                    "predicates": [{"operator": "gte", "value": 0}],
                }
            ],
            "sort": [],
        },
    )
    eager = values.cast(pl.Float64)
    collected_heights: list[int] = []
    original_collect = pl.LazyFrame.collect
    original_to_list = pl.Series.to_list

    def bounded_collect(lazy_frame: pl.LazyFrame, *args: Any, **kwargs: Any) -> pl.DataFrame:
        result = cast(pl.DataFrame, original_collect(lazy_frame, *args, **kwargs))
        assert isinstance(result, pl.DataFrame)
        collected_heights.append(result.height)
        assert result.height <= 20
        return result

    monkeypatch.setattr(pl.LazyFrame, "collect", bounded_collect)

    def bounded_to_list(series):
        assert len(series) <= 20
        return original_to_list(series)

    monkeypatch.setattr(pl.Series, "to_list", bounded_to_list)

    summary = PolarsEngine().summaries(frame, [(0, "c:value")])[0]

    assert collected_heights
    assert max(collected_heights) <= 20
    assert summary["totalCount"] == row_count
    assert summary["nullCount"] == 0
    assert summary["nanCount"] == 0
    assert summary["distinctCount"] == 102
    assert summary["numeric"] == {
        "min": 0.0,
        "max": 1_000_000.0,
        "mean": pytest.approx(eager.mean()),
        "median": pytest.approx(eager.median()),
        "std": pytest.approx(eager.std()),
        "sum": pytest.approx(eager.sum()),
        "exactSum": {
            "kind": "integer",
            "raw": 1_614_453,
            "display": "1614453",
            "isNull": False,
            "isNaN": False,
        },
        "exactMin": {
            "kind": "integer",
            "raw": 0,
            "display": "0",
            "isNull": False,
            "isNaN": False,
        },
        "exactMax": {
            "kind": "integer",
            "raw": 1_000_000,
            "display": "1000000",
            "isNull": False,
            "isNaN": False,
        },
    }
    visualization = summary["visualization"]
    assert "sampled" not in visualization
    assert len(visualization["bins"]) == 20
    assert visualization["bins"][0]["min"] == summary["numeric"]["min"]
    assert visualization["bins"][-1]["max"] == summary["numeric"]["max"]
    assert visualization["bins"][-1]["count"] == 1
    assert sum(bin_["count"] for bin_ in visualization["bins"]) == row_count


@pytest.mark.parametrize("lazy", [False, True])
def test_polars_profiles_a_wide_int64_projection_with_exact_native_sums(
    lazy: bool,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    column_count = 64
    row_count = 257
    frame = pl.DataFrame(
        {
            f"value_{column}": pl.Series(
                [(row % 17) + column for row in range(row_count)],
                dtype=pl.Int64,
            )
            for column in range(column_count)
        }
    )
    source = frame.lazy() if lazy else frame
    native_collect = pl.LazyFrame.collect
    native_collect_all = pl.collect_all
    collected_heights: list[int] = []

    def bounded_collect(lazy_frame: pl.LazyFrame, *args: Any, **kwargs: Any) -> pl.DataFrame:
        result = cast(pl.DataFrame, native_collect(lazy_frame, *args, **kwargs))
        collected_heights.append(result.height)
        assert result.height <= 20
        return result

    def bounded_collect_all(frames: Any, *args: Any, **kwargs: Any) -> list[pl.DataFrame]:
        results = native_collect_all(frames, *args, **kwargs)
        collected_heights.extend(result.height for result in results)
        assert all(result.height <= 20 for result in results)
        return results

    if lazy:
        monkeypatch.setattr(pl.LazyFrame, "collect", bounded_collect)
        monkeypatch.setattr(pl, "collect_all", bounded_collect_all)
    projection = [(position, f"c:{position}") for position in range(column_count)]

    summaries = PolarsEngine().summaries(source, projection)

    base_sum = sum(row % 17 for row in range(row_count))
    assert [summary["columnId"] for summary in summaries] == [column_id for _, column_id in projection]
    assert [summary["numeric"]["exactSum"]["raw"] for summary in summaries] == [
        base_sum + (position * row_count) for position in range(column_count)
    ]
    if lazy:
        assert collected_heights
        assert max(collected_heights) <= 20


def test_live_lazy_polars_profiles_many_horizontal_column_windows_without_unbounded_collection(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import __main__

    row_count = 10_003
    column_count = 40
    window_size = 8
    source_path = tmp_path / "wide-live-profile.parquet"
    rows = pl.int_range(0, row_count, eager=True)
    pl.DataFrame(
        {f"value_{column}": ((rows % 17) + column).cast(pl.Int64) for column in range(column_count)}
    ).write_parquet(source_path)
    live = pl.scan_parquet(source_path)
    original_schema = live.collect_schema()
    original_plan = live.explain(optimized=False)
    monkeypatch.setattr(__main__, "wide_live_profile", live, raising=False)

    native_collect = pl.LazyFrame.collect
    native_collect_all = pl.collect_all
    native_to_list = pl.Series.to_list
    collected_heights: list[int] = []
    to_list_lengths: list[int] = []

    def bounded_collect(lazy_frame: pl.LazyFrame, *args: Any, **kwargs: Any) -> pl.DataFrame:
        result = cast(pl.DataFrame, native_collect(lazy_frame, *args, **kwargs))
        collected_heights.append(result.height)
        assert result.height <= 20, "A horizontal LazyFrame profile collected an unbounded result."
        return result

    def bounded_collect_all(frames: Any, *args: Any, **kwargs: Any) -> list[pl.DataFrame]:
        results = native_collect_all(frames, *args, **kwargs)
        collected_heights.extend(result.height for result in results)
        assert all(result.height <= 20 for result in results), "A horizontal profile collected unbounded results."
        return results

    def bounded_to_list(series: pl.Series) -> list[Any]:
        to_list_lengths.append(len(series))
        assert len(series) <= 20, "A horizontal profile converted an unbounded Series to a list."
        return native_to_list(series)

    monkeypatch.setattr(pl.LazyFrame, "collect", bounded_collect)
    monkeypatch.setattr(pl, "collect_all", bounded_collect_all)
    monkeypatch.setattr(pl.Series, "to_list", bounded_to_list)

    manager = SessionManager()
    opened = manager.open_session(
        {
            "kind": "notebookVariable",
            "label": "wide_live_profile",
            "variableName": "wide_live_profile",
        },
        backend="polars",
        mode="editing",
        page_size=2,
        column_limit=window_size,
    )
    session_id = opened["metadata"]["sessionId"]
    schema = opened["metadata"]["schema"]
    empty_view = {"filters": [], "sort": []}
    profiled_ids: list[str] = []
    pages = [opened]
    for column_offset in range(window_size, column_count, window_size):
        pages.append(
            manager.get_page(
                session_id,
                0,
                0,
                2,
                empty_view,
                column_offset=column_offset,
                column_limit=window_size,
            )
        )

    base_sum = sum(row % 17 for row in range(row_count))
    for page_response in pages:
        for column_id in page_response["page"]["columnIds"]:
            position = next(column["position"] for column in schema if column["id"] == column_id)
            response = manager.get_summary(session_id, 0, empty_view, [column_id])
            summary = response["summaries"][0]
            assert summary["numeric"]["exactSum"]["raw"] == base_sum + (position * row_count)
            profiled_ids.append(column_id)

    assert opened["metadata"]["capabilities"]["lazy"] is True
    assert isinstance(manager.sessions[session_id].original, pl.LazyFrame)
    assert profiled_ids == [column["id"] for column in schema]
    assert manager.close_session(session_id, 0) == {"kind": "sessionClosed", "sessionId": session_id}
    assert live.collect_schema() == original_schema
    assert live.explain(optimized=False) == original_plan
    assert collected_heights and max(collected_heights) <= 20
    assert all(length <= 20 for length in to_list_lengths)


@pytest.mark.parametrize("lazy", [False, True])
def test_polars_numeric_summaries_publish_lossless_wide_extrema_and_sums(
    lazy: bool,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def reject_conversion(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("Polars summaries must remain native.")

    monkeypatch.setattr(pl.DataFrame, "to_pandas", reject_conversion, raising=False)
    wide_values = [-(10**30) + 2, 10**30 + 3, 10**30 + 1]
    unsigned_values = [10**30 + 5, 7, None]
    decimal_values = [
        Decimal("-12345678901234567890.123456789012345678"),
        Decimal("98765432109876543210.987654321098765432"),
        None,
    ]
    frame = pl.DataFrame(
        {
            "wide": pl.Series(wide_values, dtype=pl.Int128),
            "unsigned": pl.Series(unsigned_values, dtype=pl.UInt128),
            "amount": pl.Series(decimal_values, dtype=pl.Decimal(38, 18)),
        }
    )

    summaries = PolarsEngine().summaries(frame.lazy() if lazy else frame)

    assert summaries[0]["numeric"]["exactMin"] == {
        "kind": "integer",
        "raw": str(min(wide_values)),
        "display": str(min(wide_values)),
        "isNull": False,
        "isNaN": False,
    }
    assert summaries[0]["numeric"]["exactMax"] == {
        "kind": "integer",
        "raw": str(max(wide_values)),
        "display": str(max(wide_values)),
        "isNull": False,
        "isNaN": False,
    }
    assert summaries[0]["numeric"]["exactSum"]["display"] == str(sum(wide_values))
    assert summaries[1]["numeric"]["exactSum"]["display"] == str(sum(value or 0 for value in unsigned_values))
    assert summaries[2]["numeric"]["exactMin"]["display"] == str(decimal_values[0])
    assert summaries[2]["numeric"]["exactMax"]["display"] == str(decimal_values[1])
    assert summaries[2]["numeric"]["exactSum"]["display"] == "86419753208641975320.864197532086419754"
    assert summaries[2]["numeric"]["exactMin"]["kind"] == "decimal"
    assert summaries[2]["numeric"]["exactMax"]["kind"] == "decimal"


@pytest.mark.parametrize("lazy", [False, True])
def test_polars_summary_omits_non_finite_statistics_but_keeps_finite_histogram_values(lazy: bool):
    frame = pl.DataFrame({"value": [1.0, float("inf")]})
    summary = PolarsEngine().summaries(frame.lazy() if lazy else frame)[0]

    assert summary["numeric"] == {"min": 1.0}
    assert summary["visualization"] == {"kind": "numeric", "bins": [{"min": 1.0, "max": 1.0, "count": 1}]}


@pytest.mark.parametrize("lazy", [False, True])
def test_polars_numeric_histogram_counts_all_valid_values_after_nulls(lazy: bool):
    row_count = 16_384
    values = [None if index % 2 == 0 else float(index) for index in range(row_count)]
    frame = pl.DataFrame({"value": values})
    source = frame.lazy() if lazy else frame

    first = PolarsEngine().summaries(source, [(0, "c:value")])[0]
    second = PolarsEngine().summaries(source, [(0, "c:value")])[0]

    assert first["numeric"]["min"] == 1.0
    assert first["numeric"]["max"] == float(row_count - 1)
    assert first["distinctCount"] == row_count // 2
    assert first["visualization"] == second["visualization"]
    assert first["visualization"]["bins"]
    histogram_count = sum(bin_["count"] for bin_ in first["visualization"]["bins"])
    assert histogram_count == row_count // 2
    assert "sampled" not in first["visualization"]


def test_polars_eager_numeric_histogram_preserves_boundary_and_rounded_edge_assignment() -> None:
    adjacent_extremes = [1e308]
    for _index in range(24):
        adjacent_extremes.append(nextafter(adjacent_extremes[-1], float("inf")))

    for values in ([float(value) for value in range(21)], adjacent_extremes):
        summary = PolarsEngine().summaries(pl.DataFrame({"value": values}))[0]

        assert summary["visualization"] == engine_base.numeric_visualization(values)


def test_polars_eager_numeric_summaries_never_materialize_python_value_lists(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def reject_list_materialization(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("Eager Polars numeric summaries must remain in native expressions.")

    monkeypatch.setattr(pl.Series, "to_list", reject_list_materialization)
    monkeypatch.setattr(engine_base, "numeric_visualization", reject_list_materialization)
    monkeypatch.setattr(polars_engine, "numeric_visualization", reject_list_materialization, raising=False)
    frame = pl.DataFrame(
        {
            "integer": pl.Series([None, *[value % 101 for value in range(4_096)]], dtype=pl.Int64),
            "floating": pl.Series(
                [None, float("nan"), float("-inf"), float("inf"), *[float(value % 101) for value in range(4_093)]],
                dtype=pl.Float64,
            ),
        }
    )

    summaries = {summary["column"]: summary for summary in PolarsEngine().summaries(frame)}

    integer = summaries["integer"]
    assert (integer["totalCount"], integer["nullCount"], integer["nanCount"]) == (4_097, 1, 0)
    assert integer["distinctCount"] == 101
    assert integer["topValues"][0] == {"value": "0", "count": 41}
    assert integer["numeric"]["exactMin"]["display"] == "0"
    assert integer["numeric"]["exactMax"]["display"] == "100"
    assert len(integer["visualization"]["bins"]) == 20
    assert sum(bin_["count"] for bin_ in integer["visualization"]["bins"]) == 4_096
    floating = summaries["floating"]
    assert (floating["totalCount"], floating["nullCount"], floating["nanCount"]) == (4_097, 1, 1)
    assert floating["topValues"][0] == {"value": "0.0", "count": 41}
    assert sum(bin_["count"] for bin_ in floating["visualization"]["bins"]) == 4_093


def test_polars_eager_boolean_summaries_reuse_native_counts_without_materializing_lists(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def reject_list_materialization(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("Eager Polars boolean summaries must reuse native value counts.")

    monkeypatch.setattr(pl.Series, "to_list", reject_list_materialization)
    monkeypatch.setattr(engine_base, "boolean_visualization", reject_list_materialization)
    monkeypatch.setattr(polars_engine, "boolean_visualization", reject_list_materialization, raising=False)
    frame = pl.DataFrame(
        {
            "native": pl.Series([True, False, True, True, False, True], dtype=pl.Boolean),
            "nullable": pl.Series([True, False, True, None, True, None], dtype=pl.Boolean),
            "all_null": pl.Series([None] * 6, dtype=pl.Boolean),
        }
    )

    summaries = {summary["column"]: summary for summary in PolarsEngine().summaries(frame)}

    expected = {
        "native": (0, 2, {"kind": "boolean", "trueCount": 4, "falseCount": 2}),
        "nullable": (2, 2, {"kind": "boolean", "trueCount": 3, "falseCount": 1}),
        "all_null": (6, 0, {"kind": "boolean", "trueCount": 0, "falseCount": 0}),
    }
    for column, (null_count, distinct_count, visualization) in expected.items():
        summary = summaries[column]
        assert summary["type"] == "boolean"
        assert summary["totalCount"] == 6
        assert summary["nullCount"] == null_count
        assert summary["nanCount"] == 0
        assert summary["distinctCount"] == distinct_count
        assert {item["value"]: item["count"] for item in summary["topValues"]} == {
            str(value): count
            for value, count in ((True, visualization["trueCount"]), (False, visualization["falseCount"]))
            if count
        }
        assert summary["visualization"] == visualization


def test_lazy_polars_header_stats_collect_only_scalar_results(monkeypatch):
    frame = pl.DataFrame(
        {
            "value": [1.0, 1.0, None, float("nan"), float("nan")],
            "group": ["x", "x", "y", "z", "z"],
        }
    ).lazy()
    collected_shapes: list[tuple[int, int]] = []
    original_collect_all = pl.collect_all

    def scalar_collect_all(queries, *args: Any, **kwargs: Any):
        results = original_collect_all(queries, *args, **kwargs)
        collected_shapes.extend(result.shape for result in results)
        assert all(result.height <= 1 for result in results)
        return results

    monkeypatch.setattr(pl, "collect_all", scalar_collect_all)

    stats = PolarsEngine().header_stats(frame)

    assert collected_shapes == [(1, 4), (1, 1)]
    assert stats == {
        "missingCells": 3,
        "missingRows": 3,
        "duplicateRows": 2,
        "missingValuesByColumn": [
            {"column": "value", "count": 3},
            {"column": "group", "count": 0},
        ],
    }


@pytest.mark.parametrize("lazy", [False, True])
def test_polars_summary_excludes_null_and_nan_from_values_and_numeric_metrics(lazy: bool):
    frame = pl.DataFrame({"value": [1.0, None, float("nan"), 1.0]})
    source = frame.lazy() if lazy else frame

    summary = PolarsEngine().summaries(source, [(0, "c:value")])[0]

    assert summary["nullCount"] == 1
    assert summary["nanCount"] == 1
    assert summary["distinctCount"] == 1
    assert summary["topValues"] == [{"value": "1.0", "count": 2}]
    assert summary["numeric"] == {
        "min": 1.0,
        "max": 1.0,
        "mean": 1.0,
        "median": 1.0,
        "std": 0.0,
        "sum": 2.0,
    }


@pytest.mark.parametrize("lazy", [False, True])
def test_polars_text_summaries_are_exact_for_unicode_empty_and_all_null_without_pandas(
    lazy: bool,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_to_pandas(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("Polars text summaries must not convert to Pandas")

    monkeypatch.setattr(pl.DataFrame, "to_pandas", fail_to_pandas, raising=False)
    frame = pl.DataFrame(
        {
            "text": pl.Series([None, "", "A", "é", "e\u0301", "😀"], dtype=pl.String),
            "all_null": pl.Series([None, None, None, None, None, None], dtype=pl.String),
        }
    )

    summaries = {summary["column"]: summary for summary in PolarsEngine().summaries(frame.lazy() if lazy else frame)}

    assert summaries["text"]["text"] == {
        "emptyCount": 1,
        "minLength": 0,
        "maxLength": 2,
        "meanLength": 1.0,
    }
    assert summaries["all_null"]["text"] == {"emptyCount": 0}


def test_lazy_polars_nested_summaries_keep_exact_display_counts():
    frame = pl.DataFrame(
        {
            "items": [[1, 2], [1, 2], [3], None],
            "record": [{"x": 1}, {"x": 1}, {"x": 2}, None],
        }
    ).lazy()

    summaries = PolarsEngine().summaries(frame)

    assert summaries[0]["distinctCount"] == 2
    assert summaries[0]["topValues"] == [
        {"value": "[1,2]", "count": 2},
        {"value": "[3]", "count": 1},
    ]
    assert summaries[1]["distinctCount"] == 2
    assert summaries[1]["topValues"] == [
        {"value": '{"x":1}', "count": 2},
        {"value": '{"x":2}', "count": 1},
    ]


@pytest.mark.parametrize("lazy", [False, True])
def test_polars_column_values_excludes_null_and_nan_special_values(lazy: bool):
    frame = pl.DataFrame({"value": [1.0, None, float("nan"), float("nan")]})
    source = frame.lazy() if lazy else frame

    values, has_more = PolarsEngine().column_values(source, "value")

    assert values == [{"value": "1.0", "count": 1, "selectionValue": typed_selection_value(1.0, "float")}]
    assert has_more is False


def _polars_formula_literal_operation(
    frame: Any, operator: str, value: Any, *, right_column: bool = False
) -> dict[str, Any]:
    schema = PolarsEngine().schema(frame)
    lineage = source_lineage(schema)
    return bind_step(
        validate_step(
            {
                "id": "exact-literal",
                "kind": "formula",
                "params": {
                    "leftColumn": lineage[0],
                    "operator": operator,
                    **({"rightColumn": lineage[1]} if right_column else {"value": value}),
                    "newColumn": "result",
                },
            }
        ),
        schema,
        lineage,
    )


@pytest.mark.parametrize("lazy", [False, True])
@pytest.mark.parametrize(
    ("left", "right", "operator", "value"),
    [
        (pl.Series([False, True, None]), pl.Series([2, 127, None], dtype=pl.Int8), "add", None),
        (pl.Series([2, 255, None], dtype=pl.UInt8), pl.Series([False, True, None]), "add", None),
        (pl.Series([True, False, None]), pl.Series([1, 2, None], dtype=pl.UInt8), "subtract", None),
        (pl.Series([2, -128, None], dtype=pl.Int8), pl.Series([False, True, None]), "subtract", None),
        (pl.Series([False, True, None]), None, "add", str(2**127 - 1)),
        (pl.Series([False, True, None]), None, "add", str(2**128 - 1)),
        (pl.Series([False, True, None]), None, "subtract", str(-(2**127))),
    ],
)
def test_polars_formula_boolean_operands_refuse_native_integer_overflow(
    lazy: bool, left: Any, right: Any, operator: str, value: str | None
) -> None:
    source = pl.DataFrame({"left": left, **({"right": right} if right is not None else {})})
    before = source.serialize()
    frame = source.lazy() if lazy else source
    engine = PolarsEngine()
    operation = _polars_formula_literal_operation(frame, operator, value, right_column=right is not None)
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([operation]), namespace)
    for run in (lambda: engine.apply_transform(frame, operation), lambda: namespace["clean_data"](frame)):
        with pytest.raises((EngineError, ValueError), match="native integer capacity"):
            run()
        assert source.serialize() == before


@pytest.mark.parametrize("lazy", [False, True])
@pytest.mark.parametrize(
    ("left", "right", "operator", "value", "expected"),
    [
        (
            pl.Series([False, True, None]),
            pl.Series([-(2**63)] * 3, dtype=pl.Int64),
            "multiply",
            None,
            [0, -(2**63), None],
        ),
        (
            pl.Series([-(2**63)] * 3, dtype=pl.Int64),
            pl.Series([False, True, None]),
            "multiply",
            None,
            [0, -(2**63), None],
        ),
        (pl.Series([], dtype=pl.Boolean), pl.Series([], dtype=pl.Int8), "multiply", None, []),
        (pl.Series([None], dtype=pl.Boolean), pl.Series([255], dtype=pl.UInt8), "add", None, [None]),
        (pl.Series([False]), None, "add", str(2**127 - 1), [2**127 - 1]),
        (pl.Series([None], dtype=pl.Boolean), None, "add", str(2**128 - 1), [None]),
        (pl.Series([], dtype=pl.Boolean), None, "subtract", str(-(2**127)), []),
        (pl.Series([True, False, None]), pl.Series([False, True, None]), "add", None, [1, 1, None]),
        (pl.Series([True, False, None]), pl.Series([0.5, 1.5, None]), "add", None, [1.5, 1.5, None]),
        (
            pl.Series([Decimal("0.50"), Decimal("1.50"), None], dtype=pl.Decimal(10, 2)),
            None,
            "add",
            "2",
            [Decimal("2.50"), Decimal("3.50"), None],
        ),
        (pl.Series([True, False, None]), None, "divide", "2", [0.5, 0.0, None]),
        (pl.Series([True, False, None]), None, "modulo", "2", [1, 0, None]),
    ],
)
def test_polars_formula_boolean_operands_preserve_native_results(
    lazy: bool, left: Any, right: Any, operator: str, value: str | None, expected: list[Any]
) -> None:
    source = pl.DataFrame({"left": left, **({"right": right} if right is not None else {})})
    before = source.serialize()
    frame = source.lazy() if lazy else source
    engine = PolarsEngine()
    operation = _polars_formula_literal_operation(frame, operator, value, right_column=right is not None)
    if right is not None:
        operand = pl.col("right")
    else:
        assert value is not None
        integer = int(value)
        literal_type = pl.Int64 if -(2**63) <= integer < 2**63 else pl.Int128 if integer < 2**127 else pl.UInt128
        operand = pl.lit(value).cast(literal_type)
    native = source.with_columns(polars_engine._polars_formula(pl.col("left"), operand, operator).alias("result"))
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([operation]), namespace)
    for result in (engine.apply_transform(frame, operation), namespace["clean_data"](frame)):
        assert isinstance(result, pl.LazyFrame) == lazy
        eager = result.collect() if lazy else result
        assert eager["result"].to_list() == expected
        assert eager.schema == native.schema
        assert eager.equals(native)
        assert source.serialize() == before


@pytest.mark.parametrize("boolean_base", [False, True])
def test_polars_formula_boolean_power_keeps_native_refusal(boolean_base: bool) -> None:
    columns = {"boolean": [True, False, None], "integer": [2, 3, None]}
    source = pl.DataFrame(columns if boolean_base else dict(reversed(list(columns.items()))))
    engine = PolarsEngine()
    operation = _polars_formula_literal_operation(source, "power", None, right_column=True)
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([operation]), namespace)
    for run in (lambda: engine.apply_transform(source, operation), lambda: namespace["clean_data"](source)):
        with pytest.raises(pl.exceptions.InvalidOperationError, match="not supported.*bool"):
            run()


@pytest.mark.parametrize(
    ("right", "operator", "error", "message"),
    [
        (pl.Series([False, True, None]), "multiply", pl.exceptions.InvalidOperationError, "not supported.*bool"),
        (
            pl.Series([Decimal("0.50"), Decimal("1.50"), None]),
            "add",
            pl.exceptions.SchemaError,
            "supertype of bool and decimal",
        ),
    ],
)
def test_polars_formula_boolean_unsupported_types_keep_native_refusal(
    right: Any, operator: str, error: type[Exception], message: str
) -> None:
    source = pl.DataFrame({"left": [True, False, None], "right": right})
    before = source.serialize()
    engine = PolarsEngine()
    operation = _polars_formula_literal_operation(source, operator, None, right_column=True)
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([operation]), namespace)
    for run in (lambda: engine.apply_transform(source, operation), lambda: namespace["clean_data"](source)):
        with pytest.raises(error, match=message):
            run()
        assert source.serialize() == before


def test_polars_saved_formula_refuses_boolean_source_replay_without_publishing(tmp_path: Path) -> None:
    path = tmp_path / "saved-formula.csv"
    path.write_text("a,b\n-1,-9223372036854775808\n", encoding="utf-8")
    manager = SessionManager()
    try:
        opened = manager.open_session({"kind": "file", "path": str(path)}, backend="polars", page_size=1)
        session_id = opened["metadata"]["sessionId"]
        left, right = opened["metadata"]["schema"]
        step = {
            "id": "saved-formula",
            "kind": "formula",
            "params": {
                "leftColumn": {"id": left["id"], "name": left["name"]},
                "rightColumn": {"id": right["id"], "name": right["name"]},
                "operator": "subtract",
                "newColumn": "result",
            },
        }
        manager.preview_step(session_id, 0, step, 0, 1)
        confirmed = manager.apply_draft(session_id, 1, 0, 1)
        assert confirmed["page"]["rows"][0]["values"][-1]["raw"] == str(2**63 - 1)
        namespace: dict[str, Any] = {}
        exec(confirmed["code"], namespace)
        assert namespace["clean_data"](pl.read_csv(path))["result"].to_list() == [2**63 - 1]
        saved_plan = deepcopy(manager.sessions[session_id].plan)
        manager.close_session(session_id, 2)

        source_bytes = b"a,b\ntrue,-9223372036854775808\n"
        path.write_bytes(source_bytes)
        reopened = manager.open_session({"kind": "file", "path": str(path)}, backend="polars", page_size=1)
        session_id = reopened["metadata"]["sessionId"]
        assert [column["type"] for column in reopened["metadata"]["schema"]] == ["boolean", "integer"]
        session = manager.sessions[session_id]
        committed = session.committed
        with pytest.raises(EngineError, match="native integer capacity"):
            manager.preview_step(session_id, 0, saved_plan[0], 0, 1)
        with pytest.raises(ValueError, match="native integer capacity"):
            namespace["clean_data"](pl.read_csv(path))
        assert session.revision == 0
        assert session.committed is committed
        assert session.plan == [] and session.bound_plan == []
        assert session.draft_step is None and session.draft_frame is None
        current = manager.get_page(session_id, 0, 0, 1, {"filters": [], "sort": []})
        assert current["metadata"] == reopened["metadata"]
        assert current["page"] == reopened["page"]
        assert saved_plan == [step]
        assert path.read_bytes() == source_bytes
    finally:
        manager.close_all()


@pytest.mark.parametrize("lazy", [False, True])
@pytest.mark.parametrize(
    ("dtype", "values", "value", "operator", "expected", "result_dtype"),
    [
        (pl.Int64, [0, 7, None], 2**63, "add", [2**63, 2**63 + 7, None], pl.UInt64),
        (pl.Int64, [0, 7, None], 2**126, "add", [2**126, 2**126 + 7, None], pl.Int128),
        (pl.Int128, [0, 7, None], 2**127 - 8, "add", [2**127 - 8, 2**127 - 1, None], pl.Int128),
        (pl.Int128, [-1, 1, None], 2**127 - 1, "add", None, None),
        (pl.Int128, [1, None], 2**127 - 1, "add", [2**127, None], pl.UInt128),
        (pl.UInt128, [0, None], 2**128 - 1, "add", [2**128 - 1, None], pl.UInt128),
        (pl.UInt128, [1, None], 2**128 - 1, "add", None, None),
        (pl.Int128, [-1, None], 2**127, "add", None, None),
        (pl.Int8, [120, None], 10, "add", [130, None], pl.UInt8),
        (pl.UInt8, [0, 255, None], 1, "subtract", [-1, 254, None], pl.Int16),
        (pl.UInt8, [1, 255, None], -2, "multiply", [-2, -510, None], pl.Int16),
        (pl.Int128, [2**126, None], 4, "multiply", None, None),
        (pl.Int128, [-(2**127), None], -1, "modulo", [0, None], pl.Int128),
        (pl.Int64, [-7, 7, None], -3, "modulo", [-1, -2, None], pl.Int64),
        (pl.Int64, [7, None], 0, "modulo", [None, None], pl.Int64),
        (pl.Int8, [-2, None], 127, "power", [-(2**127), None], pl.Int128),
        (pl.Int8, [2, None], 127, "power", [2**127, None], pl.UInt128),
        (pl.Int8, [2, None], 128, "power", None, None),
        (pl.Int8, [-1, 0, 1, None], 2**32 - 1, "power", [-1, 0, 1, None], pl.Int64),
        (pl.Int8, [1, None], 2**32, "power", None, None),
        (pl.Int8, [2, None], -1, "power", None, None),
        (pl.UInt128, [None], -1, "add", [None], pl.Int128),
        (pl.Int64, [], 2**126, "add", [], pl.Int128),
        (pl.Int8, [None], 2**32, "power", None, None),
    ],
)
def test_polars_formula_integer_string_native_capacity(
    lazy: bool,
    dtype: Any,
    values: list[Any],
    value: int,
    operator: str,
    expected: list[Any] | None,
    result_dtype: Any,
) -> None:
    source = pl.DataFrame({"minimum": pl.Series(values, dtype=dtype)})
    before = source.clone()
    frame = source.lazy() if lazy else source
    engine = PolarsEngine()
    operation = _polars_formula_literal_operation(frame, operator, str(value))
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([operation]), namespace)
    for run in (lambda: engine.apply_transform(frame, operation), lambda: namespace["clean_data"](frame)):
        if expected is None:
            with pytest.raises((EngineError, ValueError), match="native integer.*capacity"):
                run()
        else:
            result = run()
            assert isinstance(result, pl.LazyFrame) == lazy
            eager = result.collect() if lazy else result
            assert eager["result"].to_list() == expected
            assert eager.schema["result"] == result_dtype
            assert eager.select(source.columns).equals(before)
        assert source.equals(before)
    assert operation["params"]["value"] == str(value)


@pytest.mark.parametrize("lazy", [False, True])
@pytest.mark.parametrize("dtype", [pl.Int64, pl.Float64])
def test_polars_formula_integer_string_division_retains_native_float(lazy: bool, dtype: Any) -> None:
    source = pl.DataFrame({"value": pl.Series([0, 7, None], dtype=dtype)})
    frame = source.lazy() if lazy else source
    engine = PolarsEngine()
    value = 2**63 + 1
    operation = _polars_formula_literal_operation(frame, "divide", str(value))
    expected = source.with_columns((pl.col("value") / pl.lit(str(value)).cast(pl.Int128)).alias("result"))
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([operation]), namespace)
    for result in (engine.apply_transform(frame, operation), namespace["clean_data"](frame)):
        assert isinstance(result, pl.LazyFrame) == lazy
        assert (result.collect() if lazy else result).equals(expected)
        assert (result.collect_schema() if lazy else result.schema)["result"] == pl.Float64


@pytest.mark.parametrize("value", [str(2**128), str(-(2**127) - 1), "1" + "0" * 308])
def test_polars_formula_integer_string_refuses_literal_outside_native_capacity(value: str) -> None:
    engine = PolarsEngine()
    frame = pl.DataFrame({"value": [1, None]}).lazy()
    operation = _polars_formula_literal_operation(frame, "add", value)
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([operation]), namespace)
    for run in (lambda: engine.apply_transform(frame, operation), lambda: namespace["clean_data"](frame)):
        with pytest.raises((EngineError, ValueError), match="native integer.*capacity"):
            run()


@pytest.mark.parametrize("right_column", [False, True])
def test_polars_formula_native_integer_collects_only_one_guard_boolean(
    right_column: bool, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = pl.DataFrame({"value": pl.Series([100, None], dtype=pl.Int8), "other": pl.Series([10, 2], dtype=pl.Int8)})
    frame = source.lazy()
    engine = PolarsEngine()
    operation = _polars_formula_literal_operation(frame, "add", 10)
    right = pl.lit(10)
    if right_column:
        schema = engine.schema(frame)
        lineage = source_lineage(schema)
        operation = bind_step(
            validate_step(
                {
                    "id": "column-formula",
                    "kind": "formula",
                    "params": {
                        "leftColumn": lineage[0],
                        "rightColumn": lineage[1],
                        "operator": "add",
                        "newColumn": "result",
                    },
                }
            ),
            schema,
            lineage,
        )
        right = pl.col("other")
    expected = source.with_columns((pl.col("value") + right).alias("result"))
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([operation]), namespace)
    native_collect = pl.LazyFrame.collect
    observed: list[tuple[int, int]] = []

    def guard_collect(query: Any, *args: Any, **kwargs: Any) -> Any:
        result = cast(pl.DataFrame, native_collect(query, *args, **kwargs))
        observed.append(result.shape)
        assert result.shape == (1, 1) and result.item() is False
        return result

    with monkeypatch.context() as guard:
        guard.setattr(pl.LazyFrame, "collect", guard_collect)
        live = engine.apply_transform(frame, operation)
        generated = namespace["clean_data"](frame)
    assert observed == [(1, 1), (1, 1)]
    assert live.collect().equals(expected)
    assert generated.collect().equals(expected)


def test_polars_formula_integer_string_preflights_only_selected_native_bounds(monkeypatch: pytest.MonkeyPatch) -> None:
    source = pl.DataFrame({"minimum": list(range(100)), "maximum": ["untouched"] * 100})
    frame = source.lazy()
    engine = PolarsEngine()
    operation = _polars_formula_literal_operation(frame, "add", str(2**63))
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([operation]), namespace)
    native_collect = pl.LazyFrame.collect
    observed: list[tuple[int, int]] = []

    def bounded_collect(query: Any, *args: Any, **kwargs: Any) -> Any:
        result = cast(pl.DataFrame, native_collect(query, *args, **kwargs))
        observed.append(result.shape)
        assert result.shape == (1, 2)
        assert result.row(0) == (0, 99)
        return result

    with monkeypatch.context() as guard:
        guard.setattr(pl.LazyFrame, "collect", bounded_collect)
        live = engine.apply_transform(frame, operation)
        generated = namespace["clean_data"](frame)
    assert observed == [(1, 2), (1, 2)]
    for result in (live, generated):
        eager = result.collect()
        assert eager["result"].to_list() == [2**63 + value for value in range(100)]
        assert eager.select(source.columns).equals(source)


def test_polars_formula_integer_string_small_page_overflow_preserves_confirmed_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import __main__

    source = pl.DataFrame({"value": pl.Series([-1, 2**127 - 1], dtype=pl.Int128)})
    before = source.clone()
    monkeypatch.setattr(__main__, "formula_bounds_source", source.lazy(), raising=False)
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "notebookVariable", "label": "formula_bounds_source", "variableName": "formula_bounds_source"},
        backend="polars",
        mode="editing",
        page_size=1,
    )
    session_id = opened["metadata"]["sessionId"]
    session = manager.sessions[session_id]
    committed = session.committed
    column = opened["metadata"]["schema"][0]
    try:
        with pytest.raises(EngineError, match="native integer.*capacity"):
            manager.preview_step(
                session_id,
                0,
                {
                    "id": "overflow",
                    "kind": "formula",
                    "params": {
                        "leftColumn": {"id": column["id"], "name": column["name"]},
                        "operator": "add",
                        "value": "1",
                        "newColumn": "result",
                    },
                },
                0,
                1,
            )
        assert session.revision == 0
        assert session.committed is committed
        assert session.draft_step is None
        assert session.draft_frame is None
        assert session.plan == []
        assert session.bound_plan == []
        current = manager.get_page(session_id, 0, 0, 1, {"filters": [], "sort": []})
        assert current["metadata"] == opened["metadata"]
        assert current["page"] == opened["page"]
        assert source.equals(before)
    finally:
        manager.close_all()


@pytest.mark.parametrize("lazy", [False, True])
@pytest.mark.parametrize(
    ("dtype", "values", "first_value", "first_dtype", "second_value", "expected", "final_dtype"),
    [
        (pl.Int8, [120, None], "10", pl.UInt8, "200", [-70, None], pl.Int16),
        (pl.Int64, [0, 7, None], str(2**63), pl.UInt64, str(2**63 + 1), [-1, 6, None], pl.Int128),
    ],
)
def test_polars_formula_integer_string_downstream_signedness(
    lazy: bool,
    dtype: Any,
    values: list[Any],
    first_value: str,
    first_dtype: Any,
    second_value: str,
    expected: list[Any],
    final_dtype: Any,
) -> None:
    source = pl.DataFrame({"value": pl.Series(values, dtype=dtype)})
    before = source.clone()
    frame = source.lazy() if lazy else source
    engine = PolarsEngine()
    first_step = _polars_formula_literal_operation(frame, "add", first_value)
    intermediate = engine.apply_transform(frame, first_step)
    assert (intermediate.collect_schema() if lazy else intermediate.schema)["result"] == first_dtype
    schema = engine.schema(intermediate)
    lineage = source_lineage(schema)
    second_step = bind_step(
        validate_step(
            {
                "id": "negative-result",
                "kind": "formula",
                "params": {
                    "leftColumn": lineage[1],
                    "value": second_value,
                    "operator": "subtract",
                    "newColumn": "next",
                },
            }
        ),
        schema,
        lineage,
    )
    live = engine.apply_transform(intermediate, second_step)
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([first_step, second_step]), namespace)
    generated = namespace["clean_data"](frame)
    for result in (live, generated):
        assert isinstance(result, pl.LazyFrame) == lazy
        eager = result.collect() if lazy else result
        assert eager["next"].to_list() == expected
        assert eager.schema["next"] == final_dtype
        assert eager.select(source.columns).equals(before)
    assert source.equals(before)


@pytest.mark.parametrize("lazy", [False, True])
@pytest.mark.parametrize(
    ("left_dtype", "left_values", "right_dtype", "right_values", "operator"),
    [
        (pl.Int8, [1, 120, None], None, 10, "add"),
        (pl.UInt8, [2, 0, None], None, 1, "subtract"),
        (pl.Int16, [2, 30000, None], None, 3, "multiply"),
        (pl.Int8, [1, None], None, 2**127 - 1, "add"),
        (pl.Int128, [0, 2**127 - 1, None], pl.Int128, [1, 1, None], "add"),
        (pl.Int128, [0, -(2**127), None], pl.Int128, [1, 1, None], "subtract"),
        (pl.Int128, [1, 2**127 - 1, None], pl.Int128, [2, 2, None], "multiply"),
        (pl.Int128, [2, 2**64, None], pl.UInt32, [3, 2, None], "power"),
        (pl.UInt128, [1, 2, None], pl.UInt128, [2**32 - 1, 128, None], "power"),
        (pl.Int8, [2, None], None, 7, "power"),
        (pl.Int128, [None], pl.UInt128, [2**32], "power"),
        (pl.Int128, [-1, None], pl.UInt128, [2**127, None], "add"),
        (pl.UInt64, [2**64 - 1, None], pl.Int64, [-(2**63), None], "add"),
        (pl.UInt64, [2**64 - 1, None], pl.Int64, [2, None], "modulo"),
    ],
)
def test_polars_formula_native_integer_rejects_unsafe_rows(
    lazy: bool,
    left_dtype: Any,
    left_values: list[Any],
    right_dtype: Any,
    right_values: Any,
    operator: str,
) -> None:
    source = pl.DataFrame({"value": pl.Series(left_values, dtype=left_dtype)})
    if right_dtype is not None:
        source = source.with_columns(pl.Series("right", right_values, dtype=right_dtype))
    before = source.clone()
    frame = source.lazy() if lazy else source
    engine = PolarsEngine()
    operation = _polars_formula_literal_operation(frame, operator, right_values, right_column=right_dtype is not None)
    engine.validate_transform_preflight(frame, operation, engine.shape(frame))
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([operation]), namespace)
    for run in (lambda: engine.apply_transform(frame, operation), lambda: namespace["clean_data"](frame)):
        with pytest.raises((EngineError, ValueError), match="native integer capacity|loses precision"):
            run()
        assert source.equals(before)


@pytest.mark.parametrize("lazy", [False, True])
@pytest.mark.parametrize(
    ("left_dtype", "left_values", "right_dtype", "right_values", "operator", "expected", "dtype"),
    [
        (pl.Int8, [120, None], None, 128, "add", [248, None], pl.Int16),
        (pl.Int8, [120, None], None, 10.0, "add", [130.0, None], pl.Float64),
        (pl.Int8, [7, None], None, 2, "divide", [3.5, None], pl.Float64),
        (
            pl.Int128,
            [2**127 - 1, 0, None],
            pl.Int128,
            [-(2**127) + 1, 2**127 - 1, 1],
            "add",
            [0, 2**127 - 1, None],
            pl.Int128,
        ),
        (
            pl.Int128,
            [-(2**127), 2**127 - 1, None],
            pl.Int128,
            [-(2**127), 2**127 - 1, 1],
            "subtract",
            [0, 0, None],
            pl.Int128,
        ),
        (
            pl.Int128,
            [2**127 - 1, 1, 0, None],
            pl.Int128,
            [1, 2**127 - 1, 2**127 - 1, 2],
            "multiply",
            [2**127 - 1, 2**127 - 1, 0, None],
            pl.Int128,
        ),
        (pl.Int128, [-(2**127), None], None, 1, "multiply", [-(2**127), None], pl.Int128),
        (pl.UInt128, [2**128 - 1, None], None, 1, "multiply", [2**128 - 1, None], pl.UInt128),
        (
            pl.Int128,
            [-2, 2, 1, 0, None],
            pl.UInt32,
            [127, 3, 2**32 - 1, 1, 2],
            "power",
            [-(2**127), 8, 1, 0, None],
            pl.Int128,
        ),
        (pl.Int8, [-2, 2, 0, None], pl.Int64, [7, 6, 0, 1], "power", [-128, 64, 1, None], pl.Int8),
        (pl.Int8, [4, None], None, 0.5, "power", [2.0, None], pl.Float64),
        (pl.Int128, [None, -1], pl.UInt128, [2**127, None], "add", [None, None], pl.Int128),
        (pl.UInt64, [2**64 - 1, None], pl.Int64, [1, None], "add", [float(2**64), None], pl.Float64),
        (pl.UInt64, [9, 1, None], pl.Int64, [-4, 0, 2], "modulo", [-3.0, float("nan"), None], pl.Float64),
        (pl.Int128, [1, None], None, 0, "modulo", [None, None], pl.Int128),
        (pl.Int128, [], pl.UInt128, [], "multiply", [], pl.Int128),
        (pl.UInt128, [None, None], pl.UInt128, [0, None], "power", [None, None], pl.UInt128),
        (pl.Decimal(12, 2), [Decimal("1.25"), None], None, 2, "multiply", [Decimal("2.50"), None], pl.Decimal(38, 2)),
    ],
)
def test_polars_formula_native_integer_keeps_correlated_and_native_results(
    lazy: bool,
    left_dtype: Any,
    left_values: list[Any],
    right_dtype: Any,
    right_values: Any,
    operator: str,
    expected: list[Any],
    dtype: Any,
) -> None:
    source = pl.DataFrame({"value": pl.Series(left_values, dtype=left_dtype)})
    if right_dtype is not None:
        source = source.with_columns(pl.Series("right", right_values, dtype=right_dtype))
    before = source.clone()
    frame = source.lazy() if lazy else source
    engine = PolarsEngine()
    operation = _polars_formula_literal_operation(frame, operator, right_values, right_column=right_dtype is not None)
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([operation]), namespace)
    for result in (engine.apply_transform(frame, operation), namespace["clean_data"](frame)):
        assert isinstance(result, pl.LazyFrame) == lazy
        eager = result.collect(engine="streaming") if lazy else result
        assert eager["result"].equals(pl.Series("result", expected, dtype=dtype))
        assert eager.select(source.columns).equals(before)
        assert source.equals(before)


@pytest.mark.parametrize("lazy", [False, True])
def test_polars_formula_native_integer_hidden_overflow_restores_session(
    monkeypatch: pytest.MonkeyPatch, lazy: bool
) -> None:
    import __main__

    source = pl.DataFrame({"value": pl.Series([1, 120], dtype=pl.Int8)})
    before = source.clone()
    monkeypatch.setattr(__main__, "formula_native_source", source.lazy() if lazy else source, raising=False)
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "notebookVariable", "variableName": "formula_native_source"},
        backend="polars",
        mode="editing",
        page_size=1,
    )
    session_id = opened["metadata"]["sessionId"]
    session = manager.sessions[session_id]
    committed = session.committed
    column = opened["metadata"]["schema"][0]
    try:
        with pytest.raises(EngineError, match="native integer capacity"):
            manager.preview_step(
                session_id,
                0,
                {
                    "id": "hidden-overflow",
                    "kind": "formula",
                    "params": {
                        "leftColumn": {"id": column["id"], "name": column["name"]},
                        "operator": "add",
                        "value": 10,
                        "newColumn": "result",
                    },
                },
                0,
                1,
            )
        assert session.revision == 0
        assert session.committed is committed
        assert session.draft_step is None and session.draft_frame is None
        assert session.plan == [] and session.bound_plan == []
        current = manager.get_page(session_id, 0, 0, 1, {"filters": [], "sort": []})
        assert current["metadata"] == opened["metadata"] and current["page"] == opened["page"]
        assert source.equals(before)
    finally:
        manager.close_all()


@pytest.mark.parametrize("lazy", [False, True])
def test_polars_formula_native_integer_mixed_plan_isolates_generated_helpers(lazy: bool) -> None:
    source = pl.DataFrame({"value": pl.Series([3, -4, None], dtype=pl.Int8), "invalid": [False, True, None]})
    before = source.clone()
    frame = source.lazy() if lazy else source
    engine = PolarsEngine()
    plan = [_polars_formula_literal_operation(frame, "add", 2)]
    current = engine.apply_transform(frame, plan[0])
    custom = validate_step(
        {
            "id": "helper-collision",
            "kind": "customCode",
            "params": {
                "code": (
                    "def _ow_polars_check_formula(*args):\n    raise AssertionError('custom local escaped')\n"
                    "def root_limit(*args):\n    return 0\n"
                    "result = df.with_columns(pl.col('result').alias('copied'))"
                )
            },
        }
    )
    schema = engine.schema(current)
    plan.append(bind_step(custom, schema, source_lineage(schema)))
    current = engine.apply_transform(current, plan[-1])
    for value, operator, output in [("200", "add", "wide"), (3, "power", "cube")]:
        schema = engine.schema(current)
        lineage = source_lineage(schema)
        selected = next(reference for reference in lineage if reference["name"] == "copied")
        step = bind_step(
            validate_step(
                {
                    "id": output,
                    "kind": "formula",
                    "params": {
                        "leftColumn": selected,
                        "value": value,
                        "operator": operator,
                        "newColumn": output,
                    },
                }
            ),
            schema,
            lineage,
        )
        plan.append(step)
        current = engine.apply_transform(current, step)
    namespace: dict[str, Any] = {}
    code = engine.compile_plan(plan)
    exec(code, namespace)
    generated = namespace["clean_data"](frame)
    for result in (current, generated):
        assert isinstance(result, pl.LazyFrame) == lazy
        eager = result.collect(engine="streaming") if lazy else result
        assert eager["cube"].equals(pl.Series("cube", [125, -8, None], dtype=pl.Int8))
        assert eager["wide"].equals(pl.Series("wide", [205, 198, None], dtype=pl.Int16))
        assert eager.select(source.columns).equals(before)
    assert source.equals(before)


@pytest.mark.parametrize("dtype", [pl.Float32, pl.Float64, pl.Decimal(12, 2)])
def test_polars_formula_native_noninteger_has_no_row_guard(dtype: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    source = pl.DataFrame({"value": pl.Series([1, 2, None], dtype=dtype)})
    frame = source.lazy()
    engine = PolarsEngine()
    step = _polars_formula_literal_operation(frame, "multiply", 3)
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([step]), namespace)
    with monkeypatch.context() as guard:
        guard.setattr(pl.LazyFrame, "collect", lambda *_args, **_kwargs: pytest.fail("Floating/Decimal rows scanned."))
        live = engine.apply_transform(frame, step)
        generated = namespace["clean_data"](frame)
    expected = source.with_columns((pl.col("value") * pl.lit(3)).alias("result"))
    assert live.collect().equals(expected)
    assert generated.collect().equals(expected)


@pytest.mark.parametrize("lazy", [False, True])
@pytest.mark.parametrize("operator", ["add", "subtract", "multiply"])
def test_polars_uint128_column_formula_has_correlated_preview_and_safe_later_pages(
    lazy: bool, operator: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    import __main__
    from openwrangler_runtime import kernel_agent

    source = pl.DataFrame(
        {"value": pl.Series([1, 2, None], dtype=pl.UInt64), "right": pl.Series([3, 4, None], dtype=pl.UInt64)}
    )
    original = source.clone()
    frame = source.lazy() if lazy else source
    monkeypatch.setattr(__main__, "uint128_formula_source", frame, raising=False)
    manager = SessionManager()
    monkeypatch.setattr(kernel_agent, "_manager", manager)
    opened = manager.open_session(
        {"kind": "notebookVariable", "variableName": "uint128_formula_source"},
        backend="polars",
        mode="editing",
        page_size=1,
    )
    session_id = opened["metadata"]["sessionId"]
    first = opened["metadata"]["schema"][0]
    try:
        preview = manager.preview_step(
            session_id,
            0,
            {
                "id": "wide",
                "kind": "formula",
                "params": {
                    "leftColumn": {"id": first["id"], "name": first["name"]},
                    "value": str(2**64),
                    "operator": "add",
                    "newColumn": "wide",
                },
            },
            0,
            1,
        )
        confirmed = manager.apply_draft(session_id, preview["revision"], 0, 3)
        session = manager.sessions[session_id]
        committed, revision, plan = session.committed, session.revision, deepcopy(session.plan)
        refs = {
            column["name"]: {"id": column["id"], "name": column["name"]} for column in confirmed["metadata"]["schema"]
        }
        operation = {
            "id": "column-arithmetic",
            "kind": "formula",
            "params": {
                "leftColumn": refs["wide"],
                "rightColumn": refs["right"],
                "operator": operator,
                "newColumn": "result",
            },
        }
        bound = bind_step(validate_step(operation), session.committed_schema, session.committed_lineage)
        namespace: dict[str, Any] = {}
        exec(session.engine.compile_plan([*session.bound_plan, bound]), namespace)
        request_id = f"uint128-{operator}-{lazy}"
        response = json.loads(
            kernel_agent.dispatch_json(
                json.dumps(
                    {
                        "protocolVersion": 2,
                        "requestId": request_id,
                        "priority": "interactive",
                        "request": {
                            "kind": "previewStep",
                            "sessionId": session_id,
                            "revision": revision,
                            "step": operation,
                            "offset": 0,
                            "limit": 1,
                            "columnOffset": 0,
                            "columnLimit": 64,
                        },
                    }
                )
            )
        )
        assert response["requestId"] == request_id
        if pl.__version__.startswith("1.35."):
            assert response["response"]["kind"] == "error"
            assert "Polars 1.36" in response["response"]["message"]
            assert session.committed is committed and session.revision == revision and session.plan == plan
            assert session.draft_step is None and session.draft_frame is None
            actual = manager.get_page(session_id, revision, 0, 3, {"filters": [], "sort": []})
            assert actual["metadata"] == confirmed["metadata"] and actual["page"] == confirmed["page"]
            with pytest.raises(ValueError, match="Polars 1.36"):
                namespace["clean_data"](frame)
            # A corrected scalar operation still works on the preserved UInt128 result.
            corrected = {**operation, "params": {**operation["params"], "value": 1}}
            corrected["params"].pop("rightColumn")
            retry = manager.preview_step(session_id, revision, corrected, 0, 1)
            manager.apply_draft(session_id, retry["revision"], 0, 3)
        else:
            assert response["response"]["kind"] == "stepPreview"
            manager.apply_draft(session_id, response["response"]["revision"], 0, 1)
            page = manager.get_page(session_id, session.revision, 0, 3, {"filters": [], "sort": []})
            generated = namespace["clean_data"](frame)
            generated = generated.collect() if lazy else generated
            expected = {
                "add": [2**64 + 4, 2**64 + 6, None],
                "subtract": [2**64 - 2, 2**64 - 2, None],
                "multiply": [(2**64 + 1) * 3, (2**64 + 2) * 4, None],
            }[operator]
            assert generated["result"].to_list() == expected and generated.schema["result"] == pl.UInt128
            assert [row["values"][-1]["raw"] for row in page["page"]["rows"]] == [
                str(value) if value is not None else None for value in expected
            ]
        assert source.equals(original)
    finally:
        manager.close_all()


@pytest.mark.parametrize("release", ["1.35.2", "1.36.0rc1", "custom"])
@pytest.mark.parametrize("values", [[], [None, None], [1], [1, 2]])
def test_polars_uint128_column_formula_refuses_unqualified_release_for_every_shape(
    release: str, values: list[int | None], monkeypatch: pytest.MonkeyPatch
) -> None:
    source = pl.DataFrame({"value": pl.Series(values, dtype=pl.UInt128), "right": pl.Series(values, dtype=pl.UInt128)})
    original = source.clone()
    engine = PolarsEngine()
    operation = _polars_formula_literal_operation(source, "add", None, right_column=True)
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([operation]), namespace)
    monkeypatch.setattr(pl, "__version__", release)
    for frame in (source, source.lazy()):
        for run in (
            lambda frame=frame: engine.apply_transform(frame, operation),
            lambda frame=frame: namespace["clean_data"](frame),
        ):
            with pytest.raises((EngineError, ValueError), match="stable Polars 1.36"):
                run()
    assert source.equals(original)


@pytest.mark.parametrize("other_dtype", [pl.Boolean, pl.Null])
@pytest.mark.parametrize("operator", ["add", "subtract", "multiply"])
@pytest.mark.parametrize("unsigned_left", [False, True])
def test_polars_uint128_kernel_refusal_includes_noninteger_operands(
    other_dtype: Any, operator: str, unsigned_left: bool, monkeypatch: pytest.MonkeyPatch
) -> None:
    unsigned = pl.Series([3, None], dtype=pl.UInt128)
    other = pl.Series([True, None] if other_dtype == pl.Boolean else [None, None], dtype=other_dtype)
    source = pl.DataFrame(
        {"value": unsigned if unsigned_left else other, "right": other if unsigned_left else unsigned}
    )
    original = source.clone()
    engine = PolarsEngine()
    operation = _polars_formula_literal_operation(source, operator, None, right_column=True)
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([operation]), namespace)
    monkeypatch.setattr(pl, "__version__", "1.35.2")
    for frame in (source, source.lazy()):
        for run in (
            lambda frame=frame: engine.apply_transform(frame, operation),
            lambda frame=frame: namespace["clean_data"](frame),
        ):
            with pytest.raises((EngineError, ValueError), match="stable Polars 1.36"):
                run()
    assert source.equals(original)
