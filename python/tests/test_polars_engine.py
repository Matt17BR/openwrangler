from __future__ import annotations

from pathlib import Path
from typing import Any, cast

import polars as pl
import pytest

from openwrangler_runtime.engines.polars_engine import SUMMARY_VISUALIZATION_SAMPLE_LIMIT, PolarsEngine
from openwrangler_runtime.session import SessionManager

ROOT = Path(__file__).resolve().parents[2]


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

    summary = manager.get_summary(opened["metadata"]["sessionId"], 0, filter_model, ["sales"])
    assert summary["summaries"][0]["numeric"]["max"] == 12.0
    assert summary["summaries"][0]["visualization"]["kind"] == "numeric"
    assert summary["summaries"][0]["visualization"]["bins"]


def test_polars_column_values_and_parquet(tmp_path):
    frame = pl.DataFrame({"group": ["a", "a", "b"], "value": [1, 2, 3]})
    path = tmp_path / "sample.parquet"
    frame.write_parquet(path)

    manager = SessionManager()
    opened = manager.open_session({"kind": "file", "label": "sample.parquet", "path": str(path)}, backend="polars")
    values = manager.get_column_values(opened["metadata"]["sessionId"], 0, "group", {"filters": [], "sort": []})

    assert values["values"] == [{"value": "a", "count": 2}, {"value": "b", "count": 1}]


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
    row_count = (SUMMARY_VISUALIZATION_SAMPLE_LIMIT * 3) + 17
    values = pl.int_range(0, row_count, eager=True) % 101
    frame = pl.DataFrame({"value": values}).lazy()
    eager = values.cast(pl.Float64)
    collected_heights: list[int] = []
    original_collect = pl.LazyFrame.collect
    original_to_list = pl.Series.to_list

    def bounded_collect(lazy_frame: pl.LazyFrame, *args: Any, **kwargs: Any) -> pl.DataFrame:
        result = cast(pl.DataFrame, original_collect(lazy_frame, *args, **kwargs))
        assert isinstance(result, pl.DataFrame)
        collected_heights.append(result.height)
        assert result.height <= SUMMARY_VISUALIZATION_SAMPLE_LIMIT
        return result

    monkeypatch.setattr(pl.LazyFrame, "collect", bounded_collect)

    def bounded_to_list(series):
        assert len(series) <= SUMMARY_VISUALIZATION_SAMPLE_LIMIT
        return original_to_list(series)

    monkeypatch.setattr(pl.Series, "to_list", bounded_to_list)

    summary = PolarsEngine().summaries(frame, ["value"])[0]

    assert collected_heights
    assert max(collected_heights) <= SUMMARY_VISUALIZATION_SAMPLE_LIMIT
    assert summary["totalCount"] == row_count
    assert summary["nullCount"] == 0
    assert summary["nanCount"] == 0
    assert summary["distinctCount"] == 101
    assert summary["topValues"][0]["count"] == (row_count + 100) // 101
    assert summary["numeric"] == {
        "min": 0.0,
        "max": 100.0,
        "mean": pytest.approx(eager.mean()),
        "median": pytest.approx(eager.median()),
        "std": pytest.approx(eager.std()),
    }
    assert summary["sampled"] is True
    assert summary["visualization"]["sampled"] is True
    assert sum(bin_["count"] for bin_ in summary["visualization"]["bins"]) <= SUMMARY_VISUALIZATION_SAMPLE_LIMIT


@pytest.mark.parametrize("lazy", [False, True])
def test_polars_numeric_histogram_samples_valid_values_after_nulls(lazy: bool):
    row_count = SUMMARY_VISUALIZATION_SAMPLE_LIMIT * 4
    values = [None if index % 2 == 0 else float(index) for index in range(row_count)]
    frame = pl.DataFrame({"value": values})
    source = frame.lazy() if lazy else frame

    first = PolarsEngine().summaries(source, ["value"])[0]
    second = PolarsEngine().summaries(source, ["value"])[0]

    assert first["numeric"]["min"] == 1.0
    assert first["numeric"]["max"] == float(row_count - 1)
    assert first["distinctCount"] == row_count // 2
    assert first["visualization"] == second["visualization"]
    assert first["visualization"]["bins"]
    histogram_count = sum(bin_["count"] for bin_ in first["visualization"]["bins"])
    assert histogram_count == (SUMMARY_VISUALIZATION_SAMPLE_LIMIT if lazy else row_count // 2)
    if lazy:
        assert first["sampled"] is True
        assert first["visualization"]["sampled"] is True


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

    summary = PolarsEngine().summaries(source, ["value"])[0]

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

    assert values == [{"value": "1.0", "count": 1}]
    assert has_more is False
