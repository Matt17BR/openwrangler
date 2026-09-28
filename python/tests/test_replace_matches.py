from __future__ import annotations

import datetime as dt
import decimal
import json
import random
import re
import warnings
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

import duckdb
import numpy as np
import pandas as pd
import polars as pl
import pytest
from test_find_cells import DUCKDB_ROWS, pandas_frame, polars_frame

from openwrangler_runtime._column_binding import ColumnBindingError, bind_step
from openwrangler_runtime.engines import EngineError
from openwrangler_runtime.engines.base import (
    REPLACE_MATCHES_TYPES,
    DataFrameEngine,
    FindQuery,
    _open_wrangler_replace_pattern,
    replace_matches_is_portable,
)
from openwrangler_runtime.engines.duckdb_engine import DuckDBEngine
from openwrangler_runtime.engines.pandas_engine import PandasEngine
from openwrangler_runtime.engines.polars_engine import PolarsEngine
from openwrangler_runtime.lineage import source_lineage
from openwrangler_runtime.operations import OperationError, validate_step
from openwrangler_runtime.session import SessionManager

pa = pytest.importorskip("pyarrow")
pq = pytest.importorskip("pyarrow.parquet")

BACKENDS = ["pandas", "polars", "polars-lazy", "duckdb"]
PORTABILITY = json.loads(
    (Path(__file__).resolve().parents[2] / "fixtures" / "replace-portability-contract.json").read_text(encoding="utf-8")
)
EMPTY: dict[str, Any] = {"logic": "and", "filters": [], "sort": []}


@pytest.fixture
def forbid_conversions(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("Replace must stay engine-native")

    for frame_type in (pl.DataFrame, pl.LazyFrame):
        monkeypatch.setattr(frame_type, "to_pandas", refuse, raising=False)
    for method in ("df", "fetchdf", "fetch_df", "pl", "arrow", "fetch_arrow_table", "to_arrow_table"):
        monkeypatch.setattr(duckdb.DuckDBPyRelation, method, refuse, raising=False)


def engine_for(backend: str) -> DataFrameEngine:
    if backend == "pandas":
        return PandasEngine()
    if backend.startswith("polars"):
        return PolarsEngine()
    return DuckDBEngine()


def rich_frame(backend: str) -> tuple[DataFrameEngine, Any]:
    engine = engine_for(backend)
    if backend == "pandas":
        return engine, pandas_frame()
    if backend.startswith("polars"):
        frame = polars_frame()
        return engine, frame.lazy() if backend == "polars-lazy" else frame
    return engine, duckdb.sql(DUCKDB_ROWS)


def typed_frame(backend: str, columns: dict[str, tuple[str, list[Any]]]) -> tuple[DataFrameEngine, Any]:
    """One frame with the same values in each engine's native types."""

    engine = engine_for(backend)
    if backend == "pandas":
        pandas_types = {
            "string": object,
            "integer": "Int64",
            "float": "float64",
            "boolean": "boolean",
            "date": object,
            "datetime": "datetime64[us]",
            "utc": "datetime64[ns, UTC]",
            "decimal": object,
        }
        data = {}
        for name, (kind, values) in columns.items():
            if kind in {"datetime", "utc"}:
                data[name] = pd.Series(pd.to_datetime(values, utc=kind == "utc"), dtype=pandas_types[kind])
            else:
                data[name] = pd.Series(values, dtype=pandas_types[kind])
        return engine, pd.DataFrame(data)
    if backend.startswith("polars"):
        polars_types = {
            "string": pl.String,
            "integer": pl.Int64,
            "float": pl.Float64,
            "boolean": pl.Boolean,
            "date": pl.Date,
            "datetime": pl.Datetime("us"),
            "utc": pl.Datetime("us", "UTC"),
            "decimal": pl.Decimal(10, 2),
        }
        frame = pl.DataFrame(
            {name: pl.Series(name, values, dtype=polars_types[kind]) for name, (kind, values) in columns.items()}
        )
        return engine, frame.lazy() if backend == "polars-lazy" else frame
    sql_types = {
        "string": "VARCHAR",
        "integer": "BIGINT",
        "float": "DOUBLE",
        "boolean": "BOOLEAN",
        "date": "DATE",
        "datetime": "TIMESTAMP",
        "utc": "TIMESTAMPTZ",
        "decimal": "DECIMAL(10,2)",
    }

    def literal(kind: str, value: Any) -> str:
        if value is None:
            return f"NULL::{sql_types[kind]}"
        if kind == "float" and value != value:
            text = "NaN"
        elif kind == "utc":
            text = value.isoformat() + "+00:00"
        elif isinstance(value, (dt.date, dt.datetime)):
            text = value.isoformat()
        else:
            text = str(value)
        return "'" + text.replace("'", "''") + f"'::{sql_types[kind]}"

    height = len(next(iter(columns.values()))[1])
    rows = ", ".join(
        "(" + ", ".join(literal(kind, values[row]) for kind, values in columns.values()) + ")" for row in range(height)
    )
    names = ", ".join('"' + name + '"' for name in columns)
    return engine, duckdb.sql(f"SELECT * FROM (VALUES {rows}) AS source({names})")


def bind(engine: DataFrameEngine, frame: Any, names: Sequence[str], **params: Any) -> dict[str, Any]:
    schema = engine.schema(frame)
    lineage = source_lineage(schema)
    references = [next(item for item in lineage if item["name"] == name) for name in names]
    defaults = {"matchCase": False, "wholeCell": False, "spelling": "python"}
    step = {"id": "replace", "kind": "replaceMatches", "params": {**defaults, **params, "columns": references}}
    return bind_step(validate_step(step), schema, lineage)


def generated(engine: DataFrameEngine, frame: Any, step: dict[str, Any]) -> Any:
    namespace: dict[str, Any] = {}
    exec(compile(engine.compile_plan([step]), "<replace-matches>", "exec"), namespace, namespace)
    with warnings.catch_warnings():
        warnings.simplefilter("error", FutureWarning)
        return namespace["clean_data"](frame)


def both(engine: DataFrameEngine, frame: Any, step: dict[str, Any]) -> list[Any]:
    return [engine.apply_transform(frame, step), generated(engine, frame, step)]


def displays(engine: DataFrameEngine, frame: Any, name: str) -> list[str | None]:
    schema = engine.schema(frame)
    position = next(column["position"] for column in schema if column["name"] == name)
    page = engine.page(frame, 0, 1_000)
    cells = [row["values"][position] for row in page["rows"]]
    return [None if cell["isNull"] or cell.get("isNaN") else cell["display"] for cell in cells]


def raw_types(engine: DataFrameEngine, frame: Any) -> list[tuple[str, str, str]]:
    return [(column["name"], column["type"], column["rawType"]) for column in engine.schema(frame)]


def assert_replaces(
    engine: DataFrameEngine,
    frame: Any,
    names: Sequence[str],
    expected: dict[str, list[str | None]],
    **params: Any,
) -> None:
    step = bind(engine, frame, names, **params)
    for result in both(engine, frame, step):
        assert raw_types(engine, result) == raw_types(engine, frame)
        for name, values in expected.items():
            assert displays(engine, result, name) == values, name


def assert_refuses(engine: DataFrameEngine, frame: Any, names: Sequence[str], message: str, **params: Any) -> None:
    step = bind(engine, frame, names, **params)
    attempts: list[Callable[[], Any]] = [
        lambda: engine.apply_transform(frame, step),
        lambda: generated(engine, frame, step),
    ]
    for attempt in attempts:
        with pytest.raises((EngineError, ValueError), match=re.escape(message)):
            result = attempt()
            engine.page(result, 0, 1_000)


def test_pattern_matches_exactly_the_labels_find_highlights() -> None:
    rng = random.Random(1686)

    def samples(alphabet: str, extra: list[str]) -> tuple[list[str], list[str]]:
        labels = ["".join(rng.choice(alphabet) for _ in range(rng.randint(0, 8))) for _ in range(400)] + extra
        queries = [label[start:end] for label in labels[:150] for start, end in [(0, 3), (1, 4)] if label[start:end]]
        return labels, queries

    text_labels, text_queries = samples(
        "aAbBzZ09 T:.-+*?()[]{}|^$\\é\u00c9ß\u212a", ["Kelvin", "\u212aelvin", "STRASSE", "straße"]
    )
    text_queries += ["a", "A", "t", "T", " ", "\u212a", "k", ".", "\\", "$1", "(?:"]

    def moment() -> str:
        label = f"{rng.randint(1, 9999):04d}-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}"
        if rng.random() < 0.8:
            label += f"T{rng.randint(0, 23):02d}:{rng.randint(0, 59):02d}:{rng.randint(0, 59):02d}"
            if rng.random() < 0.5:
                label += "." + "".join(rng.choice("0123456789") for _ in range(rng.choice([3, 6, 9])))
            if rng.random() < 0.5:
                label += f"{rng.choice('+-')}{rng.randint(0, 14):02d}:{rng.choice(['00', '30', '45'])}"
        return label

    time_labels = [moment() for _ in range(300)]
    time_queries = [
        label[start : start + width].replace("T", separator)
        for label in time_labels[:120]
        for start, width in [(rng.randint(0, 12), rng.randint(1, 9))]
        for separator in ("T", " ", "t")
        if label[start : start + width]
    ]
    time_queries += ["t", "T", " ", "01 00", "01T00", "01t00", "T00:05", "at"]
    for labels, queries, temporal in [(text_labels, text_queries, False), (time_labels, time_queries, True)]:
        for text in queries:
            for match_case in (False, True):
                pattern = re.compile(_open_wrangler_replace_pattern(text, match_case, temporal))
                for whole_cell in (False, True):
                    found = FindQuery(text, match_case, whole_cell).label_matches(labels, datetime=temporal)
                    search = pattern.fullmatch if whole_cell else pattern.search
                    assert [search(label) is not None for label in labels] == found, (text, match_case, whole_cell)


@pytest.mark.parametrize("backend", BACKENDS)
def test_whole_cell_replace_moves_exactly_the_cells_showing_each_value(backend: str, forbid_conversions: None) -> None:
    engine, frame = rich_frame(backend)
    replaceable = [column for column in engine.schema(frame) if column["type"] in REPLACE_MATCHES_TYPES]
    assert {column["type"] for column in replaceable} == REPLACE_MATCHES_TYPES
    for column in replaceable:
        name = column["name"]
        before = displays(engine, frame, name)
        distinct = list(dict.fromkeys(label for label in before if label is not None))
        for index, old in enumerate(distinct):
            new = distinct[index - 1]
            if old == new or not old:
                continue
            step = bind(engine, frame, [name], find=old, replacement=new, matchCase=True, wholeCell=True)
            for result in both(engine, frame, step):
                assert raw_types(engine, result) == raw_types(engine, frame), name
                assert displays(engine, result, name) == [new if label == old else label for label in before], (
                    name,
                    old,
                    new,
                )


@pytest.mark.parametrize("backend", BACKENDS)
def test_text_replace_folds_only_ascii_and_keeps_replacement_literal(backend: str, forbid_conversions: None) -> None:
    engine, frame = typed_frame(
        backend, {"text": ("string", ["Apple pie", "apple", None, "Crème brûlée", "PINEAPPLE", "", "ÉCLAIR éclair"])}
    )
    assert_replaces(
        engine,
        frame,
        ["text"],
        {"text": ["$1\\ pie", "$1\\", None, "Crème brûlée", "PINE$1\\", "", "ÉCLAIR éclair"]},
        find="APPLE",
        replacement="$1\\",
    )
    assert_replaces(
        engine,
        frame,
        ["text"],
        {"text": ["Apple pie", "apple", None, "Crème brûlée", "PINEAPPLE", "", "ÉCLAIR tart"]},
        find="éclair",
        replacement="tart",
        matchCase=False,
    )
    assert_replaces(
        engine,
        frame,
        ["text"],
        {"text": ["Apple pie", "fig", None, "Crème brûlée", "PINEAPPLE", "", "ÉCLAIR éclair"]},
        find="apple",
        replacement="fig",
        matchCase=True,
        wholeCell=True,
    )
    assert_replaces(
        engine,
        frame,
        ["text"],
        {"text": ["Apple pie", "apple", None, "Crème brûlée", "PINEAPPLE", "", "ÉCLAIR éclair"]},
        find=".",
        replacement="",
    )
    assert_replaces(
        engine,
        frame,
        ["text"],
        {"text": ["Apple-pie", "apple", None, "Crème-brûlée", "PINEAPPLE", "", "ÉCLAIR-éclair"]},
        find=" ",
        replacement="-",
    )


@pytest.mark.parametrize("backend", BACKENDS)
def test_numbers_replace_the_displayed_text_then_parse_it_back(backend: str, forbid_conversions: None) -> None:
    engine, frame = typed_frame(
        backend,
        {
            "count": ("integer", [12, 120, None, 5, -12]),
            "ratio": ("float", [1.5, -0.0, 0.0, float("nan"), float("inf")]),
            "money": ("decimal", [decimal.Decimal("1.50"), decimal.Decimal("-12.25"), None, None, None]),
        },
    )
    if backend == "pandas":
        frame = frame.drop(columns="money")
    assert_replaces(engine, frame, ["count"], {"count": ["7", "70", None, "5", "-7"]}, find="12", replacement="7")
    assert_replaces(
        engine, frame, ["count"], {"count": ["7", "120", None, "5", "-12"]}, find="12", replacement="7", wholeCell=True
    )
    # Only the positive zero shows 0.0, and NaN never matches.
    assert_replaces(
        engine,
        frame,
        ["ratio"],
        {"ratio": ["1.5", "-0.0", "1.0", None, "Infinity"]},
        find="0.0",
        replacement="1",
        wholeCell=True,
    )
    assert_replaces(
        engine,
        frame,
        ["ratio"],
        {"ratio": ["1.5", "-0.0", "0.0", None, "-Infinity"]},
        find="infinity",
        replacement="-inf",
        wholeCell=True,
    )
    assert_replaces(
        engine,
        frame,
        ["ratio"],
        {"ratio": ["2.5", "-0.0", "0.0", None, "Infinity"]},
        find="1.",
        replacement="2.",
    )
    assert_refuses(
        engine,
        frame,
        ["count"],
        "Replacing in 'count' gives 'x', which isn't a whole number.",
        find="12",
        replacement="x",
        wholeCell=True,
    )
    assert_refuses(
        engine,
        frame,
        ["count"],
        "Replacing in 'count' gives '1.5', which isn't a whole number.",
        find="12",
        replacement="1.5",
        wholeCell=True,
    )
    assert_refuses(
        engine,
        frame,
        ["ratio"],
        "Replacing in 'ratio' gives '1.5x', which isn't a number.",
        find="1.5",
        replacement="1.5x",
    )
    assert_refuses(
        engine,
        frame,
        ["ratio"],
        "Replacing in 'ratio' gives '1e400', which isn't a number this column can store.",
        find="1.5",
        replacement="1e400",
        wholeCell=True,
    )
    if backend != "pandas":
        assert_replaces(
            engine, frame, ["money"], {"money": ["1.75", "-12.25", None, None, None]}, find="50", replacement="75"
        )
        assert_refuses(
            engine,
            frame,
            ["money"],
            "Replacing in 'money' gives '1.505', which isn't a decimal number with at most 2 decimal places.",
            find="1.50",
            replacement="1.505",
            wholeCell=True,
        )
        assert_refuses(
            engine,
            frame,
            ["money"],
            "Replacing in 'money' gives '123456789.50', which isn't a decimal number with at most 10 digits.",
            find="1.50",
            replacement="123456789.50",
            wholeCell=True,
        )


def test_pandas_integers_keep_their_bounds_and_decimals_their_type(forbid_conversions: None) -> None:
    engine = PandasEngine()
    frame = pd.DataFrame(
        {
            "small": pd.Series([12, 100], dtype="int8"),
            "money": [decimal.Decimal("1.50"), None],
            "narrow": np.array([0.1, 1.5], dtype=np.float32),
        }
    )
    assert_replaces(engine, frame, ["small"], {"small": ["-12", "100"]}, find="12", replacement="-12")
    assert_refuses(
        engine,
        frame,
        ["small"],
        "Replacing in 'small' gives '1000', which isn't a whole number from -128 to 127.",
        find="100",
        replacement="1000",
    )
    assert_replaces(engine, frame, ["money"], {"money": ["2.50", None]}, find="1", replacement="2")
    assert_refuses(
        engine,
        frame,
        ["money"],
        "Replacing in 'money' gives '2.x', which isn't a decimal number.",
        find="1.50",
        replacement="2.x",
    )
    assert_replaces(engine, frame, ["narrow"], {"narrow": ["0.2", "1.5"]}, find="0.1", replacement="0.2")


@pytest.mark.parametrize("backend", BACKENDS)
def test_booleans_and_dates_parse_back(backend: str, forbid_conversions: None) -> None:
    engine, frame = typed_frame(
        backend,
        {
            "flag": ("boolean", [True, False, None]),
            "day": ("date", [dt.date(2024, 1, 31), None, dt.date(2024, 3, 1)]),
        },
    )
    assert_replaces(
        engine, frame, ["flag"], {"flag": ["False", "False", None]}, find="TRUE", replacement="false", wholeCell=True
    )
    assert_refuses(
        engine,
        frame,
        ["flag"],
        "Replacing in 'flag' gives 'yes', which isn't True or False.",
        find="True",
        replacement="yes",
        wholeCell=True,
    )
    assert_replaces(
        engine, frame, ["day"], {"day": ["2025-01-31", None, "2025-03-01"]}, find="2024", replacement="2025"
    )
    assert_refuses(
        engine,
        frame,
        ["day"],
        "Replacing in 'day' gives '2024-02-31', which isn't a date like 2024-01-31.",
        find="01-31",
        replacement="02-31",
    )
    assert_refuses(
        engine,
        frame,
        ["day"],
        "Replacing in 'day' gives '2024/03/01', which isn't a date like 2024-01-31.",
        find="2024-03-01",
        replacement="2024/03/01",
        wholeCell=True,
    )


@pytest.mark.parametrize("backend", BACKENDS)
def test_datetimes_match_either_separator_and_keep_their_zone(backend: str, forbid_conversions: None) -> None:
    moments = [dt.datetime(2024, 1, 1, 10, 0), dt.datetime(2024, 2, 1, 11, 30, 0, 500000), None]
    engine, frame = typed_frame(backend, {"moment": ("datetime", moments), "utc": ("utc", moments)})
    assert_replaces(
        engine,
        frame,
        ["moment"],
        {"moment": ["2025-01-01T09:00:00", "2024-02-01T11:30:00.500000", None]},
        find="2024-01-01 10",
        replacement="2025-01-01 09",
    )
    assert_replaces(
        engine,
        frame,
        ["moment"],
        {"moment": ["2024-01-01T10:00:00", "2024-02-01T11:30:00.250000", None]},
        find=".5",
        replacement=".25",
    )
    assert_replaces(
        engine,
        frame,
        ["utc"],
        {"utc": ["2024-01-01T08:00:00+00:00", "2024-02-01T11:30:00.500000+00:00", None]},
        find="2024-01-01T10:00:00+00:00",
        replacement="2024-01-01T10:00:00+02:00",
        wholeCell=True,
    )
    assert_refuses(
        engine,
        frame,
        ["moment"],
        "Replacing in 'moment' gives '2024-01-01T10:00:00+01:00', which isn't a date and time without a UTC offset.",
        find="10:00:00",
        replacement="10:00:00+01:00",
    )
    assert_refuses(
        engine,
        frame,
        ["utc"],
        "Replacing in 'utc' gives '2024-01-01T10:00:00', which isn't a date and time with a UTC offset such as +00:00.",
        find="2024-01-01T10:00:00+00:00",
        replacement="2024-01-01T10:00:00",
        wholeCell=True,
    )
    assert_refuses(
        engine,
        frame,
        ["moment"],
        "Replacing in 'moment' gives '2024-02-01T11:30:00.5000001', which isn't a time with at most 6 decimal places.",
        find=".500000",
        replacement=".5000001",
    )
    assert_refuses(
        engine,
        frame,
        ["moment"],
        "Replacing in 'moment' gives '2024-01-01T25:00:00', which isn't a valid date and time.",
        find="T10",
        replacement="T25",
    )


@pytest.mark.parametrize("backend", BACKENDS)
def test_categories_accept_only_values_the_column_can_hold(backend: str, forbid_conversions: None) -> None:
    values = ["a", "b", None, "a"]
    engine = engine_for(backend)
    if backend == "pandas":
        frame: Any = pd.DataFrame({"open": pd.Categorical(values)})
    elif backend.startswith("polars"):
        frame = pl.DataFrame(
            {"open": pl.Series(values, dtype=pl.Categorical), "closed": pl.Series(values, dtype=pl.Enum(["a", "b"]))}
        )
        frame = frame.lazy() if backend == "polars-lazy" else frame
    else:
        frame = duckdb.sql(
            "SELECT CAST(x AS ENUM('a', 'b')) AS closed FROM (VALUES ('a'), ('b'), (NULL), ('a')) AS t(x)"
        )
    names = [column["name"] for column in engine.schema(frame)]
    for name in names:
        assert_replaces(engine, frame, [name], {name: ["b", "b", None, "b"]}, find="a", replacement="b", wholeCell=True)
    if "open" in names:
        # An open category set gains the new text.
        assert_replaces(
            engine, frame, ["open"], {"open": ["z", "b", None, "z"]}, find="a", replacement="z", wholeCell=True
        )
    if "closed" in names:
        assert_refuses(
            engine,
            frame,
            ["closed"],
            "Replacing in 'closed' gives 'z', which isn't one of the column's categories.",
            find="a",
            replacement="z",
            wholeCell=True,
        )


def test_duckdb_aware_datetimes_use_the_grid_utc_text_on_any_connection() -> None:
    connection = duckdb.connect()
    try:
        connection.execute("SET TimeZone = 'Asia/Kolkata'")
        frame = connection.sql("SELECT * FROM (VALUES (TIMESTAMPTZ '2024-01-01 10:00:00+00'), (NULL)) AS t(utc)")
        engine = DuckDBEngine()
        assert displays(engine, frame, "utc") == ["2024-01-01T10:00:00+00:00", None]
        assert_replaces(
            engine,
            frame,
            ["utc"],
            {"utc": ["2024-01-01T11:00:00+00:00", None]},
            find="T10:00:00+00",
            replacement="T11:00:00+00",
        )
    finally:
        connection.close()


@pytest.mark.parametrize("backend", BACKENDS)
def test_several_columns_change_together_and_a_row_edits_one_cell(backend: str, forbid_conversions: None) -> None:
    engine, frame = typed_frame(
        backend,
        {"label": ("string", ["a1", "b1", "a1", None]), "count": ("integer", [1, 11, 2, 1])},
    )
    assert_replaces(
        engine,
        frame,
        ["label", "count"],
        {"label": ["a9", "b9", "a9", None], "count": ["9", "99", "2", "9"]},
        find="1",
        replacement="9",
    )
    assert_replaces(
        engine,
        frame,
        ["label"],
        {"label": ["a1", "b1", "a9", None]},
        find="1",
        replacement="9",
        row=2,
    )
    # A row whose text doesn't match stays as it is.
    assert_replaces(engine, frame, ["count"], {"count": ["1", "11", "2", "1"]}, find="1", replacement="9", row=2)
    assert_refuses(
        engine,
        frame,
        ["label"],
        "Replace targets row 5, but the dataframe has 4 rows.",
        find="1",
        replacement="9",
        row=4,
    )


def test_polars_lazy_replace_stays_lazy() -> None:
    engine, frame = typed_frame("polars-lazy", {"label": ("string", ["a1", "b2"])})
    step = bind(engine, frame, ["label"], find="1", replacement="9")
    for result in both(engine, frame, step):
        assert isinstance(result, pl.LazyFrame)


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_binding_refuses_columns_replace_cannot_write(backend: str) -> None:
    engine, frame = rich_frame(backend)
    elapsed = "elapsed"
    with pytest.raises(ColumnBindingError, match="Replace can't write text back into duration column 'elapsed'."):
        bind(engine, frame, [elapsed], find="1", replacement="2")
    for name, params in [
        ("number", {"find": "Inf"}),
        ("flag", {"find": "true", "wholeCell": False}),
        ("flag", {"find": "true", "wholeCell": True, "matchCase": True}),
        ("when", {"find": "2024"}),
    ]:
        with pytest.raises(ColumnBindingError, match=f"Python and R show {name!r} differently"):
            bind(engine, frame, [name], replacement="2", spelling="portable", **params)
    bind(engine, frame, ["text", "integer", "day", "number"], find="-1.5e", replacement="2", spelling="portable")
    bind(engine, frame, ["flag"], find="TRUE", replacement="false", wholeCell=True, spelling="portable")


@pytest.mark.parametrize("case", PORTABILITY["cases"], ids=lambda case: f"{case['type']}-{case['find']}")
def test_portability_follows_the_contract_the_webview_and_r_share(case: dict[str, Any]) -> None:
    portable = replace_matches_is_portable(case["type"], case["find"], case["matchCase"], case["wholeCell"])
    assert portable is case["portable"]


def test_operation_validation_is_strict() -> None:
    def validate(**params: Any) -> None:
        base = {
            "columns": [{"id": "c:source:0", "name": "text"}],
            "find": "a",
            "replacement": "b",
            "matchCase": False,
            "wholeCell": False,
            "spelling": "portable",
        }
        validate_step({"id": "replace", "kind": "replaceMatches", "params": {**base, **params}})

    validate()
    validate(replacement="", row=0)
    for params, message in [
        ({"find": ""}, "replaceMatches.find must contain 1 to"),
        ({"replacement": 1}, "replaceMatches.replacement must contain 0 to"),
        ({"matchCase": 1}, "replaceMatches.matchCase must be a boolean."),
        ({"spelling": "r"}, "This Replace step matches R display text. Replay it with an R library."),
        ({"spelling": "sql"}, "replaceMatches.spelling must be portable, python, or r."),
        ({"row": -1}, "replaceMatches.row must be a non-negative integer."),
        ({"row": True}, "replaceMatches.row must be a non-negative integer."),
        (
            {"row": 0, "columns": [{"id": "c:source:0", "name": "a"}, {"id": "c:source:1", "name": "b"}]},
            "replaceMatches.row requires exactly one column.",
        ),
    ]:
        with pytest.raises(OperationError, match=re.escape(message)):
            validate(**params)


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_session_previews_applies_and_undoes_replace(tmp_path: Path, backend: str) -> None:
    path = tmp_path / "people.parquet"
    pq.write_table(pa.table({"name": ["alpha", "Beta", None], "score": [12, 5, 120]}), path)
    manager = SessionManager()
    opened = manager.open_session({"kind": "file", "path": str(path)}, backend=backend, mode="editing")
    metadata = opened["metadata"]
    session_id = metadata["sessionId"]
    score = next({"id": column["id"], "name": "score"} for column in metadata["schema"] if column["name"] == "score")

    def step(replacement: str, *, whole_cell: bool = False) -> dict[str, Any]:
        params = {
            "columns": [score],
            "find": "12",
            "replacement": replacement,
            "matchCase": False,
            "wholeCell": whole_cell,
            "spelling": "portable",
        }
        return {"id": f"replace-{replacement}", "kind": "replaceMatches", "params": params}

    try:
        with pytest.raises(EngineError, match="Replacing in 'score' gives 'x', which isn't a whole number."):
            manager.preview_step(session_id, 0, step("x", whole_cell=True), 0, 10)
        assert manager.sessions[session_id].draft_step is None
        preview = manager.preview_step(session_id, 0, step("7"), 0, 10)
        assert [row["values"][1]["display"] for row in preview["page"]["rows"]] == ["7", "5", "70"]
        applied = manager.apply_draft(session_id, preview["revision"], 0, 10)
        assert "replace_matches" in applied["code"]
        assert [row["values"][1]["display"] for row in applied["page"]["rows"]] == ["7", "5", "70"]
        undone = manager.undo_step(session_id, applied["revision"], 0, 10)
        assert [row["values"][1]["display"] for row in undone["page"]["rows"]] == ["12", "5", "120"]
    finally:
        manager.close_session(session_id, manager.sessions[session_id].revision)
