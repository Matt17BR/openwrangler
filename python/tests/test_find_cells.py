from __future__ import annotations

import datetime as dt
import decimal
from pathlib import Path
from typing import Any

import duckdb
import numpy as np
import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime.engines import EngineError
from openwrangler_runtime.engines.base import DataFrameEngine, FindQuery
from openwrangler_runtime.engines.duckdb_engine import DuckDBEngine
from openwrangler_runtime.engines.pandas_engine import PandasEngine
from openwrangler_runtime.engines.polars_engine import PolarsEngine
from openwrangler_runtime.find_cells import Cell, FindMatches
from openwrangler_runtime.session import SessionManager

pa = pytest.importorskip("pyarrow")
pq = pytest.importorskip("pyarrow.parquet")

EMPTY: dict[str, Any] = {"logic": "and", "filters": [], "sort": []}
BY_INTEGER = {"logic": "and", "filters": [], "sort": [{"column": "integer", "direction": "desc", "nulls": "last"}]}
ABOVE_FIVE = {
    "logic": "and",
    "filters": [
        {
            "column": "integer",
            "type": "integer",
            "logic": "and",
            "predicates": [{"kind": "predicate", "operator": "gt", "value": 5}],
        }
    ],
    "sort": [],
}
QUERIES = [
    "1",
    "12",
    "alpha",
    "ALPHA",
    "-0",
    "0.0",
    "Infinity",
    "inf",
    "true",
    "True",
    "2024-10-01 00:05",
    "2024-10-01T00:05",
    "T00",
    "café",
    "a",
    "1.5",
    "e-05",
    "NaN",
    "12.5",
    "00:05",
    "+01:00",
    "day",
    "1.50",
    "b",
    "2024",
    "5",
]


def masks(*bits: str | None) -> list[bytes | None]:
    return [None if value is None else value.encode("ascii") for value in bits]


def test_navigation_walks_rows_then_columns_and_wraps() -> None:
    # Column 0 matches rows 1 and 3; column 2 matches rows 1 and 2; column 1 never matches.
    matches = FindMatches.from_masks([2, 0, 1], masks("0110", "0101", None))
    assert (matches.rows, matches.count) == (4, 4)
    assert [position for position, _bits in matches.columns] == [0, 2]

    def walk(backward: bool) -> list[Cell]:
        cells: list[Cell] = []
        cell: Cell | None = None
        for _ in range(5):
            cell = matches.step(cell, backward=backward, inclusive=False)
            assert cell is not None
            cells.append(cell)
        return cells

    forward = walk(backward=False)
    assert forward == [(1, 0), (1, 2), (2, 2), (3, 0), (1, 0)]
    assert [matches.ordinal(cell) for cell in forward[:4]] == [1, 2, 3, 4]
    assert walk(backward=True) == [(3, 0), (2, 2), (1, 2), (1, 0), (3, 0)]


def test_navigation_starts_from_any_cell_and_can_include_it() -> None:
    matches = FindMatches.from_masks([0, 1], masks("0101", "0010"))
    assert matches.step((1, 0), backward=False, inclusive=True) == (1, 0)
    assert matches.step((1, 0), backward=False, inclusive=False) == (2, 1)
    assert matches.step((1, 0), backward=True, inclusive=True) == (1, 0)
    assert matches.step((1, 0), backward=True, inclusive=False) == (3, 0)
    # A cell that does not match, outside the scope, or past the last row is only a starting point.
    assert matches.step((0, 7), backward=False, inclusive=True) == (1, 0)
    assert matches.step((2, 0), backward=True, inclusive=False) == (1, 0)
    assert matches.step((10**12, 0), backward=False, inclusive=False) == (1, 0)
    assert matches.step((10**12, 0), backward=True, inclusive=False) == (3, 0)


def test_navigation_reports_no_match_and_a_single_match() -> None:
    assert FindMatches.from_masks([0, 1], [None, None]).step(None, backward=False, inclusive=False) is None
    single = FindMatches.from_masks([0], masks("001"))
    assert single.count == 1
    assert single.step((2, 0), backward=False, inclusive=False) == (2, 0)
    assert single.step((2, 0), backward=True, inclusive=False) == (2, 0)


def expected_masks(engine: DataFrameEngine, view: Any, query: FindQuery) -> list[bytes | None]:
    page = engine.page(view, 0, 1_000)
    expected: list[bytes | None] = []
    for position, column in enumerate(engine.schema(view)):
        bits = []
        for row in page["rows"]:
            cell = row["values"][position]
            missing = cell["isNull"] or cell.get("isNaN") or column["type"] in {"list", "struct"}
            bits.append(
                not missing and query.label_matches([cell["display"]], datetime=column["type"] == "datetime")[0]
            )
        expected.append("".join("1" if bit else "0" for bit in bits).encode("ascii") if any(bits) else None)
    return expected


def assert_find_matches_page_displays(engine: DataFrameEngine, view: Any) -> None:
    positions = list(range(len(engine.schema(view))))
    for text in QUERIES:
        for match_case in (False, True):
            for whole_cell in (False, True):
                query = FindQuery(text, match_case, whole_cell)
                assert engine.find_masks(view, positions, query) == expected_masks(engine, view, query), query


def pandas_frame() -> pd.DataFrame:
    texts = ["Alpha", "beta", None, "ALPHA beta", "café", "Café", "", "12.5"]
    return pd.DataFrame(
        {
            "text": texts,
            "string": pd.array(texts, dtype="string"),
            "arrow_text": pd.array(texts, dtype=pd.ArrowDtype(pa.string())),
            "number": [1.5, -0.0, 0.0, np.nan, np.inf, -np.inf, 12.5, 1e-05],
            "arrow_number": pd.array(
                [1.5, -0.0, 0.0, None, 1e16, -np.inf, 12.5, 1e-05], dtype=pd.ArrowDtype(pa.float64())
            ),
            "nullable_float": pd.array([1.5, -0.0, 0.0, None, 1e16, 2.0, 12.5, 1e-05], dtype="Float64"),
            "narrow": np.array([0.1, 1.5, -0.0, 3.0, np.nan, 12.5, 2.25, 1e-05], dtype=np.float32),
            "integer": [1, 12, 125, -12, 0, 7, 8, 9],
            "nullable": pd.array([1, None, 12, 3, 4, 5, 6, 125], dtype="Int64"),
            "arrow_integer": pd.array([1, None, 12, 3, 4, 5, 6, 125], dtype=pd.ArrowDtype(pa.int32())),
            "flag": [True, False, True, False, True, True, False, False],
            "nullable_flag": pd.array([True, False, None, False, True, True, False, False], dtype="boolean"),
            "when": pd.to_datetime(
                [
                    "2024-10-01 00:05:00",
                    "2024-10-01",
                    None,
                    "2024-12-31 23:59:59.5",
                    "2024-10-01 00:05:00",
                    "2025-01-01",
                    "2024-10-02",
                    "2024-10-03",
                ],
                format="ISO8601",
            ),
            "zoned": pd.to_datetime(["2024-10-01 00:05:00"] * 8).tz_localize("Europe/Rome"),
            "elapsed": pd.to_timedelta(["1 day 5s", "1.5ms", None, "0s", "1s", "2s", "3s", "4s"]),
            "day": [dt.date(2024, 10, 1), None, dt.date(2025, 1, 5)] + [dt.date(2024, 1, 1)] * 5,
            "money": [decimal.Decimal("1.50"), decimal.Decimal("-12.25"), None] + [decimal.Decimal("5")] * 5,
            # Object cells keep 1 and True apart, and the string "1.5" apart from the float 1.5.
            "mixed": [1, 1.5, "x", None, True, 2, "1.5", 3.0],
            "category": pd.Categorical(["a", "b", "a", None, "Alpha", "b", "a", "c"]),
            "items": [[1, 2], [12], None, [], [1], [2], [3], [4]],
        }
    )


def polars_frame() -> pl.DataFrame:
    return pl.DataFrame(
        {
            "text": ["Alpha", "beta", None, "ALPHA beta", "café", "Café", "", "12.5"],
            "number": [1.5, -0.0, 0.0, float("nan"), float("inf"), float("-inf"), 12.5, 1e-05],
            "narrow": pl.Series([0.1, 1.5, -0.0, 3.0, None, 12.5, 2.25, 1e-05], dtype=pl.Float32),
            "integer": [1, 12, 125, -12, 0, 7, 8, 9],
            "nullable": pl.Series([1, None, 12, 3, 4, 5, 6, 125], dtype=pl.UInt16),
            "flag": [True, False, True, None, True, True, False, False],
            "when": [
                dt.datetime(2024, 10, 1, 0, 5),
                dt.datetime(2024, 10, 1),
                None,
                dt.datetime(2024, 12, 31, 23, 59, 59, 500000),
                dt.datetime(2024, 10, 1, 0, 5),
                dt.datetime(2025, 1, 1),
                dt.datetime(2024, 10, 2),
                dt.datetime(2024, 10, 3),
            ],
            "zoned": pl.Series([dt.datetime(2024, 10, 1, 0, 5)] * 8).dt.replace_time_zone("Europe/Rome"),
            "ms": pl.Series(
                [dt.datetime(2024, 10, 1, 0, 5, 0, 123000)] * 4 + [dt.datetime(2024, 10, 1)] * 4,
                dtype=pl.Datetime("ms"),
            ),
            "day": [dt.date(2024, 10, 1), None, dt.date(2025, 1, 5)] + [dt.date(2024, 1, 1)] * 5,
            "clock": pl.Series([dt.time(0, 5), dt.time(12, 30, 1, 5)] + [None] * 6),
            "elapsed": pl.Series([dt.timedelta(days=1, seconds=5), dt.timedelta(microseconds=1500)] + [None] * 6),
            "money": pl.Series(
                [decimal.Decimal("1.50"), decimal.Decimal("-12.25")] + [None] * 6, dtype=pl.Decimal(10, 2)
            ),
            "category": pl.Series(["a", "b", "a", None, "Alpha", "b", "a", "c"], dtype=pl.Categorical),
            "enum": pl.Series(["a", "b", "a", None, "b", "b", "a", "a"], dtype=pl.Enum(["a", "b"])),
            "bytes": pl.Series([b"ab", b"\x00\x01", None] + [b"x"] * 5),
            "items": pl.Series([[1, 2], [12]] + [None] * 6),
        }
    )


DUCKDB_ROWS = """
SELECT * FROM (VALUES
 ('Alpha', 1.5::DOUBLE, 0.1::FLOAT, 1, 1::UTINYINT, true, TIMESTAMP '2024-10-01 00:05:00',
  TIMESTAMPTZ '2024-10-01 00:05:00+02', TIMESTAMP_MS '2024-10-01 00:05:00.123',
  TIMESTAMP_NS '2024-10-01 00:05:00.123456789', DATE '2024-10-01', TIME '00:05:00',
  INTERVAL 1 DAY + INTERVAL 5 SECOND, 1.50::DECIMAL(10,2), 'a'::ENUM('a','b'), '\\x00\\x01'::BLOB, [1, 2], {'k': 1},
  'e5e5e5e5-0000-0000-0000-000000000001'::UUID, 12::HUGEINT),
 ('beta', -0.0, 1.5, 12, NULL, false, TIMESTAMP '2024-10-01 00:00:00', NULL, TIMESTAMP_MS '2024-10-01 00:00:00',
  TIMESTAMP_NS '2024-10-01 00:00:00', NULL, TIME '12:30:01.000005', INTERVAL 1500 MICROSECOND, -12.25, 'b', NULL,
  [12], NULL, NULL, -12),
 (NULL, 0.0, -0.0, 125, 12, NULL, NULL, TIMESTAMPTZ '2024-12-31 23:59:59.5+00', NULL, NULL, DATE '2025-01-05', NULL,
  NULL, NULL, NULL, 'ab'::BLOB, NULL, NULL, NULL, NULL),
 ('ALPHA beta', 'NaN'::DOUBLE, 1e-05, -12, 3, true, TIMESTAMP '2024-12-31 23:59:59.5', NULL, NULL, NULL, NULL, NULL,
  NULL, 5, NULL, NULL, NULL, NULL, NULL, 125),
 ('café', 'Infinity'::DOUBLE, 'NaN'::FLOAT, 0, 4, true, TIMESTAMP '2025-01-01', NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL, 0),
 ('Café', '-Infinity'::DOUBLE, 12.5, 7, 5, false, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, 7),
 ('', 12.5, 2.25, 8, 6, false, TIMESTAMP '2024-10-02', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, 8),
 ('12.5', 1e-05, 1e16, 9, 125, false, TIMESTAMP '2024-10-03', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, 9)
) AS t(text, number, narrow, integer, small, flag, "when", zoned, ms, ns, day, clock, elapsed, money, choice, bytes,
       items, record, identity, huge)
"""


@pytest.mark.parametrize("model", [EMPTY, BY_INTEGER, ABOVE_FIVE], ids=["source", "sorted", "filtered"])
def test_pandas_find_matches_page_displays(model: dict[str, Any]) -> None:
    engine = PandasEngine()
    frame = pandas_frame()
    assert_find_matches_page_displays(engine, engine.filter_view(frame, model))


@pytest.mark.parametrize("lazy", [False, True], ids=["eager", "lazy"])
@pytest.mark.parametrize("model", [EMPTY, BY_INTEGER, ABOVE_FIVE], ids=["source", "sorted", "filtered"])
def test_polars_find_matches_page_displays(model: dict[str, Any], lazy: bool) -> None:
    # A lazy sort must survive the match plan, including the signed-zero branches.
    engine = PolarsEngine()
    frame = polars_frame()
    assert_find_matches_page_displays(engine, engine.filter_view(frame.lazy() if lazy else frame, model))


@pytest.mark.parametrize("model", [EMPTY, BY_INTEGER, ABOVE_FIVE], ids=["source", "sorted", "filtered"])
def test_duckdb_find_matches_page_displays(model: dict[str, Any]) -> None:
    engine = DuckDBEngine()
    connection = duckdb.connect()
    try:
        frame = engine.normalize(connection.sql(DUCKDB_ROWS))
        assert_find_matches_page_displays(engine, engine.filter_view(frame, model))
    finally:
        connection.close()


def write_people(tmp_path: Path) -> Path:
    path = tmp_path / "people.parquet"
    pq.write_table(
        pa.table(
            {
                "name": ["alpha", "Beta", "gamma", "ALPHA", None],
                "code": ["a1", "b2", "a3", "x", "alpha"],
                "score": [12, 5, 120, 7, 12],
            }
        ),
        path,
    )
    return path


def walk(manager: SessionManager, session_id: str, model: dict[str, Any], text: str, **options: Any) -> list[Any]:
    names: dict[str, str] = {}
    for column in manager.get_page(session_id, 0, 0, 1, EMPTY, 0, 3)["metadata"]["schema"]:
        names[column["id"]] = column["name"]
    found = manager.find_cells(session_id, 0, model, text, **options)
    cells = []
    for _ in range(found["matchCount"] + 1):
        match = found["match"]
        cells.append((match["row"], names[match["columnId"]], match["ordinal"]))
        found = manager.find_cells(
            session_id, 0, model, text, start={"row": match["row"], "columnId": match["columnId"]}, **options
        )
    return cells


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_session_finds_cells_in_view_order(tmp_path: Path, backend: str) -> None:
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "path": str(write_people(tmp_path))}, backend=backend, mode="editing"
    )
    metadata = opened["metadata"]
    session_id = metadata["sessionId"]
    ids = {column["name"]: column["id"] for column in metadata["schema"]}
    by_code = {"logic": "and", "filters": [], "sort": [{"column": "code", "direction": "asc", "nulls": "last"}]}
    try:
        assert metadata["capabilities"]["find"] is True
        assert walk(manager, session_id, EMPTY, "alpha") == [
            (0, "name", 1),
            (3, "name", 2),
            (4, "code", 3),
            (0, "name", 1),
        ]
        assert walk(manager, session_id, EMPTY, "alpha", backward=True) == [
            (4, "code", 3),
            (3, "name", 2),
            (0, "name", 1),
            (4, "code", 3),
        ]
        # Sorted by code: (alpha, a1), (gamma, a3), (None, alpha), (Beta, b2), (ALPHA, x).
        assert walk(manager, session_id, by_code, "alpha") == [
            (0, "name", 1),
            (2, "code", 2),
            (4, "name", 3),
            (0, "name", 1),
        ]
        assert walk(manager, session_id, EMPTY, "alpha", match_case=True) == [
            (0, "name", 1),
            (4, "code", 2),
            (0, "name", 1),
        ]
        assert walk(manager, session_id, EMPTY, "12", column_ids=[ids["score"]]) == [
            (0, "score", 1),
            (2, "score", 2),
            (4, "score", 3),
            (0, "score", 1),
        ]
        assert walk(manager, session_id, EMPTY, "12", whole_cell=True) == [
            (0, "score", 1),
            (4, "score", 2),
            (0, "score", 1),
        ]
        assert manager.find_cells(session_id, 0, EMPTY, "alph", whole_cell=True) == {
            "kind": "cellsFound",
            "revision": 0,
            "matchCount": 0,
        }
        included = manager.find_cells(
            session_id, 0, EMPTY, "alpha", start={"row": 3, "columnId": ids["name"]}, include_start=True
        )
        assert included["match"] == {"row": 3, "columnId": ids["name"], "ordinal": 2}
        # Find reads the requested view without replacing the one the grid confirmed.
        assert manager.sessions[session_id].filter_model == EMPTY
    finally:
        manager.close_session(session_id, 0)


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_session_reports_each_match_position_in_the_dataframe(tmp_path: Path, backend: str) -> None:
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "path": str(write_people(tmp_path))}, backend=backend, mode="editing"
    )
    metadata = opened["metadata"]
    session_id = metadata["sessionId"]
    ids = {column["name"]: column["id"] for column in metadata["schema"]}
    names = ["alpha", "Beta", "gamma", "ALPHA", None]
    codes = ["a1", "b2", "a3", "x", "alpha"]
    by_code = {"logic": "and", "filters": [], "sort": [{"column": "code", "direction": "asc", "nulls": "last"}]}
    above_six = {
        "logic": "and",
        "filters": [
            {
                "column": "score",
                "type": "integer",
                "logic": "and",
                "predicates": [{"kind": "predicate", "operator": "gt", "value": 6}],
            }
        ],
        "sort": [{"column": "score", "direction": "desc", "nulls": "last"}],
    }
    try:
        # Sorted by code the rows are 0, 2, 4, 1, 3; above six by descending score they are 2, 0, 4, 3.
        for model, positions in [
            (EMPTY, [0, 0, 1, 2, 2, 3, 4]),
            (by_code, [0, 0, 2, 2, 4, 1, 3]),
            (above_six, [2, 2, 0, 0, 4, 3]),
        ]:
            found = manager.find_cells(session_id, 0, model, "a", include_position=True)
            seen = []
            for _ in range(found["matchCount"]):
                match = found["match"]
                seen.append(match["position"])
                column = next(name for name, identifier in ids.items() if identifier == match["columnId"])
                text = (names if column == "name" else codes)[match["position"]]
                assert text is not None and "a" in text.lower()
                found = manager.find_cells(
                    session_id,
                    0,
                    model,
                    "a",
                    start={"row": match["row"], "columnId": match["columnId"]},
                    include_position=True,
                )
            assert seen == positions
        assert "position" not in manager.find_cells(session_id, 0, by_code, "a")["match"]
    finally:
        manager.close_session(session_id, 0)


def test_session_reuses_matches_until_the_view_changes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "path": str(write_people(tmp_path))}, backend="polars", mode="editing"
    )
    session_id = opened["metadata"]["sessionId"]
    session = manager.sessions[session_id]
    calls = []
    find_masks = session.engine.find_masks

    def counted(*args: Any) -> Any:
        calls.append(args[2])
        return find_masks(*args)

    monkeypatch.setattr(session.engine, "find_masks", counted)
    by_score = {"logic": "and", "filters": [], "sort": [{"column": "score", "direction": "desc", "nulls": "last"}]}
    try:
        first = manager.find_cells(session_id, 0, EMPTY, "a")
        manager.find_cells(session_id, 0, EMPTY, "a", start={"row": 0, "columnId": first["match"]["columnId"]})
        assert len(calls) == 1
        manager.find_cells(session_id, 0, EMPTY, "a", match_case=True)
        assert len(calls) == 2
        manager.get_page(session_id, 0, 0, 10, by_score, 0, 3)
        assert session.find_cache is None
        assert manager.find_cells(session_id, 0, by_score, "gamma")["match"]["row"] == 0
        assert len(calls) == 3
    finally:
        manager.close_session(session_id, 0)


def test_session_rejects_columns_that_left_the_dataframe(tmp_path: Path) -> None:
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "path": str(write_people(tmp_path))}, backend="pandas", mode="editing"
    )
    session_id = opened["metadata"]["sessionId"]
    try:
        with pytest.raises(EngineError, match="no longer in the dataframe"):
            manager.find_cells(session_id, 0, EMPTY, "a", column_ids=["c:missing"])
        with pytest.raises(EngineError, match="no longer in the dataframe"):
            manager.find_cells(session_id, 0, EMPTY, "a", start={"row": 0, "columnId": "c:missing"})
    finally:
        manager.close_session(session_id, 0)
