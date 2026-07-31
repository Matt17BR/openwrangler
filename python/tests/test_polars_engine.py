from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from typing import Any, cast

import polars as pl
import pytest

import openwrangler_runtime.engines.base as engine_base
import openwrangler_runtime.engines.polars_engine as polars_engine
from openwrangler_runtime.engines.base import typed_selection_value
from openwrangler_runtime.engines.polars_engine import PolarsEngine
from openwrangler_runtime.session import SessionManager

ROOT = Path(__file__).resolve().parents[2]


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
    frame = PolarsEngine().read_file(str(path), options)

    assert isinstance(frame, pl.LazyFrame)
    assert frame.collect().get_column("value").to_list() == [17, 18]


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


def test_polars_literal_file_scan_uses_an_encoded_file_uri_when_glob_is_unavailable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "[legacy].csv"
    _write_polars_file(path, "csv", [17, 18])
    _write_polars_file(tmp_path / "l.csv", "csv", [99])
    native_scan_csv = pl.scan_csv
    calls: list[str] = []

    def legacy_scan_csv(source: str, **options: Any) -> pl.LazyFrame:
        calls.append(source)
        return native_scan_csv(source, **options)

    monkeypatch.setattr(pl, "scan_csv", legacy_scan_csv)

    frame = PolarsEngine().read_file(str(path))

    assert isinstance(frame, pl.LazyFrame)
    assert frame.collect().get_column("value").to_list() == [17, 18]
    assert calls == [path.absolute().as_uri()]


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


@pytest.mark.parametrize("extension", ["csv", "parquet"])
def test_real_polars_scan_selects_only_the_page_projection_before_collect(
    extension: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / f"projection.{extension}"
    source = pl.DataFrame({"omitted": [10, 20], "selected": [30, 40], "also_omitted": [50, 60]})
    if extension == "csv":
        source.write_csv(path)
    else:
        source.write_parquet(path)

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
def test_polars_numeric_summaries_publish_lossless_wide_integer_and_decimal_extrema(
    lazy: bool,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def reject_conversion(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("Polars summaries must remain native.")

    monkeypatch.setattr(pl.DataFrame, "to_pandas", reject_conversion, raising=False)
    wide_values = [-(10**30) + 2, 10**30 + 3, 10**30 + 1]
    decimal_values = [
        Decimal("-12345678901234567890.123456789012345678"),
        Decimal("98765432109876543210.987654321098765432"),
        None,
    ]
    frame = pl.DataFrame(
        {
            "wide": pl.Series(wide_values, dtype=pl.Int128),
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
    assert summaries[1]["numeric"]["exactMin"]["display"] == str(decimal_values[0])
    assert summaries[1]["numeric"]["exactMax"]["display"] == str(decimal_values[1])
    assert summaries[1]["numeric"]["exactMin"]["kind"] == "decimal"
    assert summaries[1]["numeric"]["exactMax"]["kind"] == "decimal"


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
