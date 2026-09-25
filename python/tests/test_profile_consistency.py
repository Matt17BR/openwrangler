from __future__ import annotations

from pathlib import Path
from typing import Any

import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime.engines import PandasEngine, PolarsEngine
from openwrangler_runtime.session import SessionManager

pa = pytest.importorskip("pyarrow")
pq = pytest.importorskip("pyarrow.parquet")

EMPTY: dict[str, Any] = {"logic": "and", "filters": [], "sort": []}
# Every key appears twice. Source order meets c, a, b; descending rank meets b, a, c.
KEYS = ["c", "a", "b", "a", "c", "b", None]
RANKS = [1, 5, 6, 2, 3, 4, 0]
BY_RANK = {"logic": "and", "filters": [], "sort": [{"column": "rank", "direction": "desc", "nulls": "last"}]}
AT_LEAST_TWO = {
    "column": "rank",
    "type": "integer",
    "logic": "and",
    "predicates": [{"kind": "predicate", "operator": "gte", "value": 2}],
}


def top(summary: dict[str, Any]) -> list[tuple[str, int]]:
    return [(item["value"], item["count"]) for item in summary["topValues"]]


def approximate_std(summaries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for summary in summaries:
        if "std" in summary.get("numeric", {}):
            # Parallel variance may round its last bit differently under another plan.
            summary["numeric"]["std"] = pytest.approx(summary["numeric"]["std"], rel=1e-12)
    return summaries


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_profile_ties_follow_first_occurrence_and_ignore_viewing_sorts(tmp_path: Path, backend: str) -> None:
    path = tmp_path / "ties.parquet"
    pq.write_table(pa.table({"key": KEYS, "rank": RANKS}), path, row_group_size=3)
    manager = SessionManager()
    opened = manager.open_session({"kind": "file", "path": str(path)}, backend=backend, mode="editing")
    session_id, schema = opened["metadata"]["sessionId"], opened["metadata"]["schema"]
    revision = opened["metadata"]["revision"]
    ids = [column["id"] for column in schema]
    try:
        unsorted = manager.get_summary(session_id, revision, EMPTY, ids)["summaries"]
        assert top(unsorted[0]) == [("c", 2), ("a", 2), ("b", 2)]
        assert manager.get_summary(session_id, revision, BY_RANK, ids)["summaries"] == approximate_std(unsorted)
        assert manager.get_column_values(session_id, revision, "key", BY_RANK) == manager.get_column_values(
            session_id, revision, "key", EMPTY
        )

        for model in ({**EMPTY, "filters": [AT_LEAST_TWO]}, {**BY_RANK, "filters": [AT_LEAST_TWO]}):
            filtered = manager.get_summary(session_id, revision, model, ids[:1])["summaries"][0]
            assert top(filtered) == [("a", 2), ("b", 2), ("c", 1)]

        rule = {"column": {"id": ids[1], "name": "rank"}, "direction": "desc", "nulls": "last"}
        preview = manager.preview_step(
            session_id, revision, {"id": "sort", "kind": "sortRows", "params": {"rules": [rule]}}, 0, 10
        )
        revision = manager.apply_draft(session_id, preview["revision"], 0, 10)["revision"]
        # A committed sort is data order, so its ties follow the sorted rows.
        sorted_rows = manager.get_summary(session_id, revision, EMPTY, ids[:1])["summaries"][0]
        assert top(sorted_rows) == [("b", 2), ("a", 2), ("c", 2)]
    finally:
        manager.close_session(session_id, revision)


def test_value_choices_spell_grid_text_and_agree_across_engines(tmp_path: Path) -> None:
    path = tmp_path / "choices.parquet"
    moment = 1_704_067_200 * 10**6
    pq.write_table(
        pa.table(
            {
                "f32": pa.array(
                    [0.1, 0.1, 0.3, 1e-5, 16777216.0, -0.0, 0.0, float("inf"), 442674.125, None], pa.float32()
                ),
                "f64": [1e16, 1e-5, 0.1, -0.0, 0.0, 2.5, 2.5, float("-inf"), float("nan"), None],
                "text": ["v1", "V1", "v2", "", None, "v10", "v1", "\u0130", "i", "v2"],
                "when": pa.array(
                    [moment, moment, moment + 500_000, moment + 1_500_000, moment + 86_400 * 10**6, None, moment]
                    + [moment + 1, moment + 2, moment + 3],
                    pa.timestamp("us"),
                ),
            }
        ),
        path,
    )
    choices: dict[str, dict[tuple[str, str | None], list[tuple[str, int]]]] = {}
    missing: dict[str, list[tuple[int, int]]] = {}
    for backend in ("pandas", "polars", "duckdb"):
        manager = SessionManager()
        opened = manager.open_session({"kind": "file", "path": str(path)}, backend=backend)
        session_id, revision = opened["metadata"]["sessionId"], opened["metadata"]["revision"]
        schema = opened["metadata"]["schema"]
        rows = manager.get_page(session_id, revision, 0, 10, EMPTY)["page"]["rows"]
        choices[backend] = {}
        try:
            for position, column in enumerate(schema):
                cells = {row["values"][position]["display"] for row in rows}
                for search in (None, "1", "e", "0.1", "-", "v1", "i", "T00:00:01", " 00:00:01"):
                    values = manager.get_column_values(session_id, revision, column["name"], EMPTY, search, 3)
                    listed = [(item["value"], item["count"]) for item in values["values"]]
                    # Signed zeros share one choice, labelled like positive zero.
                    assert {label for label, _ in listed} <= cells | {"0.0"}
                    choices[backend][column["name"], search] = listed
            summaries = manager.get_summary(session_id, revision, EMPTY, [column["id"] for column in schema])
            missing[backend] = [(item["nullCount"], item["nanCount"]) for item in summaries["summaries"]]
        finally:
            manager.close_session(session_id, revision)
    assert choices["polars"] == choices["pandas"] and choices["duckdb"] == choices["pandas"]
    assert {backend: [sum(counts) for counts in columns] for backend, columns in missing.items()} == dict.fromkeys(
        missing, [1, 2, 1, 1]
    )
    # Pandas NumPy floats store Parquet nulls as NaN; missing text and datetimes stay null.
    assert missing["polars"] == missing["duckdb"] == [(1, 0), (1, 1), (1, 0), (1, 0)]
    assert missing["pandas"] == [(0, 1), (0, 2), (1, 0), (1, 0)]
    listed = choices["pandas"]
    assert listed["f32", None] == [("0.0", 2), ("0.1", 2), ("0.3", 1)] and listed["f32", "-"] == [("1e-05", 1)]
    assert listed["f64", "e"] == [("1e+16", 1), ("1e-05", 1)] and listed["f64", "-"] == [("-Infinity", 1), ("1e-05", 1)]
    assert listed["text", "v1"] == [("v1", 2), ("V1", 1), ("v10", 1)]
    assert listed["text", "i"] == [("i", 1)]
    fraction = [("2024-01-01T00:00:01.500000", 1)]
    assert listed["when", "T00:00:01"] == listed["when", " 00:00:01"] == fraction


def test_in_memory_profile_ties_follow_first_occurrence() -> None:
    categories = pd.CategoricalDtype(["a", "b", "c", "unused"])
    pandas_frame = pd.DataFrame({"key": pd.Series(KEYS, dtype=categories), "text": KEYS})
    for summary in PandasEngine().summaries(pandas_frame):
        assert top(summary) == [("c", 2), ("a", 2), ("b", 2)]
    polars_summary = PolarsEngine().summaries(pl.DataFrame({"key": KEYS}))[0]
    assert top(polars_summary) == [("c", 2), ("a", 2), ("b", 2)]


@pytest.mark.parametrize(
    ("values", "has_std"),
    [([1e300, -1e300, 1.0], False), ([1e150, 2e150, None], True), ([float("inf"), 1e200, -1e200], False)],
)
def test_huge_float_deviation_matches_across_engines(tmp_path: Path, values: list[float | None], has_std: bool) -> None:
    path = tmp_path / "huge.parquet"
    pq.write_table(pa.table({"value": pa.array(values, pa.float64())}), path)
    numeric = {}
    for backend in ("pandas", "polars", "duckdb"):
        manager = SessionManager()
        opened = manager.open_session({"kind": "file", "path": str(path)}, backend=backend)
        metadata = opened["metadata"]
        summary = manager.get_summary(metadata["sessionId"], metadata["revision"], EMPTY, [metadata["schema"][0]["id"]])
        numeric[backend] = summary["summaries"][0]["numeric"]
        manager.close_session(metadata["sessionId"], metadata["revision"])
    assert {backend: "std" in values for backend, values in numeric.items()} == dict.fromkeys(numeric, has_std)
    if has_std:
        assert numeric["duckdb"]["std"] == pytest.approx(numeric["pandas"]["std"], rel=1e-12)
        assert numeric["polars"]["std"] == pytest.approx(numeric["pandas"]["std"], rel=1e-12)
