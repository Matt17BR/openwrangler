from __future__ import annotations

import datetime as dt
import json
import re
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import duckdb
import polars as pl
import pytest

from openwrangler_runtime._column_binding import ColumnBindingError, bind_step
from openwrangler_runtime.engines import EngineError
from openwrangler_runtime.engines.base import DataFrameEngine
from openwrangler_runtime.engines.duckdb_engine import DuckDBEngine, DuckDBSqlPlan
from openwrangler_runtime.engines.pandas_engine import PandasEngine
from openwrangler_runtime.engines.polars_engine import PolarsEngine
from openwrangler_runtime.lineage import source_lineage
from openwrangler_runtime.operations import OperationError, validate_step
from openwrangler_runtime.protocol import ProtocolError, decode_request
from openwrangler_runtime.session import SessionManager

pa = pytest.importorskip("pyarrow")
pq = pytest.importorskip("pyarrow.parquet")

BACKENDS = ["pandas", "polars", "polars-lazy", "duckdb"]


@pytest.fixture
def forbid_conversions(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("Look up columns must stay engine-native")

    for frame_type in (pl.DataFrame, pl.LazyFrame):
        monkeypatch.setattr(frame_type, "to_pandas", refuse, raising=False)
    for method in ("df", "fetchdf", "fetch_df", "pl", "arrow", "fetch_arrow_table", "to_arrow_table"):
        monkeypatch.setattr(duckdb.DuckDBPyRelation, method, refuse, raising=False)


def source(backend: str, tmp_path: Path, table: Any) -> tuple[DataFrameEngine, Any]:
    """Open one Parquet source the way each engine opens a file."""

    path = tmp_path / "source.parquet"
    pq.write_table(table, path)
    engine: DataFrameEngine
    if backend == "pandas":
        engine = PandasEngine()
    elif backend.startswith("polars"):
        engine = PolarsEngine()
    else:
        engine = DuckDBEngine()
    frame = engine.read_file(str(path))
    return engine, frame.collect() if backend == "polars" else frame


def write_lookup(tmp_path: Path, file_format: str, table: Any, name: str = "lookup") -> dict[str, str]:
    path = tmp_path / f"{name}.{file_format}"
    if file_format == "parquet":
        pq.write_table(table, path)
    elif file_format == "jsonl":
        path.write_text("".join(json.dumps(row) + "\n" for row in table.to_pylist()), encoding="utf-8")
    else:
        separator = "\t" if file_format == "tsv" else ","
        lines = [separator.join(table.column_names)]
        for row in table.to_pylist():
            lines.append(separator.join("" if value is None else str(value) for value in row.values()))
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {"path": str(path), "format": file_format}


def lookup_step(
    engine: DataFrameEngine,
    frame: Any,
    file: dict[str, str],
    keys: Sequence[tuple[str, str]],
    columns: Sequence[tuple[str, str]],
) -> dict[str, Any]:
    schema = engine.schema(frame)
    lineage = source_lineage(schema)
    references = {column["name"]: column for column in lineage}
    step = {
        "id": "lookup",
        "kind": "lookupColumns",
        "params": {
            "file": file,
            "keys": [{"column": references[column], "lookupColumn": name} for column, name in keys],
            "columns": [{"lookupColumn": name, "newColumn": new_column} for name, new_column in columns],
        },
    }
    return bind_step(validate_step(step), schema, lineage)


def generated(engine: DataFrameEngine, frame: Any, step: dict[str, Any]) -> Any:
    namespace: dict[str, Any] = {}
    exec(compile(engine.compile_plan([step]), "<lookup-columns>", "exec"), namespace, namespace)
    # Generated DuckDB code receives the user's relation, not the engine's replayable plan.
    return namespace["clean_data"](duckdb.sql(frame.sql) if isinstance(frame, DuckDBSqlPlan) else frame)


def both(engine: DataFrameEngine, frame: Any, step: dict[str, Any]) -> list[Any]:
    return [engine.apply_transform(frame, step), generated(engine, frame, step)]


def cells(engine: DataFrameEngine, frame: Any, names: Sequence[str]) -> list[list[str | None]]:
    positions = [
        next(column["position"] for column in engine.schema(frame) if column["name"] == name) for name in names
    ]
    rows = engine.page(frame, 0, 1_000)["rows"]
    return [
        [
            None if cell["isNull"] else "NaN" if cell.get("isNaN") else cell["display"]
            for cell in (row["values"][position] for position in positions)
        ]
        for row in rows
    ]


def types(engine: DataFrameEngine, frame: Any, names: Sequence[str]) -> list[tuple[str, str]]:
    by_name = {column["name"]: column for column in engine.schema(frame)}
    return [(by_name[name]["type"], by_name[name]["rawType"]) for name in names]


def refuses(engine: DataFrameEngine, frame: Any, step: dict[str, Any], message: str) -> None:
    for attempt in (lambda: engine.apply_transform(frame, step), lambda: generated(engine, frame, step)):
        with pytest.raises((EngineError, ValueError), match=re.escape(message)):
            engine.page(attempt(), 0, 1_000)


PEOPLE = pa.table(
    {
        "id": pa.array([1, 2, 3, None], pa.int64()),
        "label": ["one", "two", "ünï", "none"],
        "score": pa.array([1.5, None, 3.25, 9.0]),
    }
)


@pytest.mark.parametrize("file_format", ["csv", "tsv", "parquet", "jsonl"])
@pytest.mark.parametrize("backend", BACKENDS)
def test_every_row_keeps_its_place_and_gets_its_match(
    tmp_path: Path, backend: str, file_format: str, forbid_conversions: None
) -> None:
    engine, frame = source(
        backend, tmp_path, pa.table({"id": pa.array([3, 1, None, 4, 1], pa.int64()), "x": list("abcde")})
    )
    step = lookup_step(
        engine, frame, write_lookup(tmp_path, file_format, PEOPLE), [("id", "id")], [("label", "label"), ("score", "s")]
    )
    for result in both(engine, frame, step):
        assert cells(engine, result, ["x", "id", "label", "s"]) == [
            ["a", "3", "ünï", "3.25"],
            ["b", "1", "one", "1.5"],
            ["c", None, None, None],
            ["d", "4", None, None],
            ["e", "1", "one", "1.5"],
        ]
        assert [kind for kind, _ in types(engine, result, ["label", "s"])] == ["string", "float"]


@pytest.mark.parametrize("backend", BACKENDS)
def test_every_part_of_a_composite_key_must_match(tmp_path: Path, backend: str, forbid_conversions: None) -> None:
    day = dt.date(2026, 1, 2)
    engine, frame = source(
        backend,
        tmp_path,
        pa.table(
            {
                "name": ["a", "a", "b", None, "a"],
                "flag": [True, False, True, True, None],
                "day": pa.array([day, day, day, day, day], pa.date32()),
            }
        ),
    )
    lookup = pa.table(
        {
            "name": ["a", "a", "b", None, "a"],
            "flag": [True, False, False, True, None],
            "day": pa.array([day, day, day, day, day], pa.date32()),
            "value": [1, 2, 3, 4, 5],
        }
    )
    step = lookup_step(
        engine,
        frame,
        write_lookup(tmp_path, "parquet", lookup),
        [("name", "name"), ("flag", "flag"), ("day", "day")],
        [("value", "value")],
    )
    for result in both(engine, frame, step):
        assert cells(engine, result, ["value"]) == [["1"], ["2"], [None], [None], [None]]


@pytest.mark.parametrize("backend", BACKENDS)
def test_eight_part_keys_with_many_distinct_values_match(tmp_path: Path, backend: str) -> None:
    rows = 300
    # 300 distinct values in each of eight parts give more combined codes than 64 bits can hold.
    multipliers = [1, 7, 11, 13, 17, 19, 23, 29]
    parts = {
        f"k{part}": [(row * multiplier) % rows for row in range(rows)] for part, multiplier in enumerate(multipliers)
    }
    engine, frame = source(backend, tmp_path, pa.table({name: values[::-1] for name, values in parts.items()}))
    lookup = pa.table({**parts, "row": list(range(rows))})
    step = lookup_step(
        engine,
        frame,
        write_lookup(tmp_path, "parquet", lookup),
        [(name, name) for name in parts],
        [("row", "row")],
    )
    for result in both(engine, frame, step):
        assert cells(engine, result, ["row"]) == [[str(row)] for row in reversed(range(rows))]


@pytest.mark.parametrize("backend", BACKENDS)
def test_text_keys_match_exactly(tmp_path: Path, backend: str, forbid_conversions: None) -> None:
    engine, frame = source(backend, tmp_path, pa.table({"key": ["A", "a", "é", "e\u0301", " a"]}))
    lookup = pa.table({"key": ["a", "e\u0301"], "hit": ["lower a", "combining e"]})
    step = lookup_step(engine, frame, write_lookup(tmp_path, "parquet", lookup), [("key", "key")], [("hit", "hit")])
    for result in both(engine, frame, step):
        assert cells(engine, result, ["hit"]) == [[None], ["lower a"], [None], ["combining e"], [None]]


@pytest.mark.parametrize("backend", BACKENDS)
def test_integer_keys_of_different_widths_match_by_value(tmp_path: Path, backend: str) -> None:
    big = 2**63 + 5
    engine, frame = source(
        backend,
        tmp_path,
        pa.table({"small": pa.array([1, 7, None], pa.int32()), "big": pa.array([big, 1, 2], pa.uint64())}),
    )
    small_lookup = write_lookup(
        tmp_path, "parquet", pa.table({"k": pa.array([7, 1], pa.int64()), "v": ["seven", "one"]}), "small"
    )
    big_lookup = write_lookup(
        tmp_path, "parquet", pa.table({"k": pa.array([2, big], pa.uint64()), "v": ["two", "big"]}), "big"
    )
    signed_lookup = write_lookup(
        tmp_path, "parquet", pa.table({"k": pa.array([-1, 1], pa.int64()), "v": ["minus", "one"]}), "signed"
    )
    for file, key, expected in (
        (small_lookup, "small", [["one"], ["seven"], [None]]),
        (big_lookup, "big", [["big"], [None], ["two"]]),
        (signed_lookup, "big", [[None], ["one"], [None]]),
    ):
        step = lookup_step(engine, frame, file, [(key, "k")], [("v", "v")])
        for result in both(engine, frame, step):
            assert cells(engine, result, ["v"]) == expected


@pytest.mark.parametrize("backend", BACKENDS)
def test_added_columns_keep_their_type_nan_and_missing_values(tmp_path: Path, backend: str) -> None:
    lookup = pa.table(
        {
            "k": pa.array([1, 2], pa.int64()),
            "ratio": pa.array([float("nan"), None], pa.float64()),
            "count": pa.array([7, None], pa.int64()),
            "ok": pa.array([False, None]),
            "day": pa.array([dt.date(2026, 3, 4), None], pa.date32()),
            "at": pa.array([dt.datetime(2026, 3, 4, 5, 6, 7, 8000), None], pa.timestamp("ms")),
        }
    )
    file = write_lookup(tmp_path, "parquet", lookup)
    names = ["ratio", "count", "ok", "day", "at"]
    outputs = [(name, name) for name in names]
    matched_types = None
    for keys in ([1, 2, 3], [8, 9, 10]):
        engine, frame = source(backend, tmp_path, pa.table({"k": pa.array(keys, pa.int64())}))
        step = lookup_step(engine, frame, file, [("k", "k")], outputs)
        for result in both(engine, frame, step):
            if keys[0] == 1:
                matched, *unmatched = cells(engine, result, names)
                assert matched[:2] + [str(matched[2]).lower(), matched[3]] == ["NaN", "7", "false", "2026-03-04"]
                assert re.fullmatch(r"2026-03-04[ T]05:06:07\.008(000)?", str(matched[4]))
                assert unmatched == [[None] * 5] * 2
                matched_types = types(engine, result, names)
            else:
                assert cells(engine, result, names) == [[None] * 5] * 3
                assert types(engine, result, names) == matched_types
    assert matched_types is not None
    assert [kind for kind, _ in matched_types] == ["float", "integer", "boolean", "date", "datetime"]


@pytest.mark.parametrize("backend", BACKENDS)
def test_a_repeated_lookup_key_names_its_first_row(tmp_path: Path, backend: str) -> None:
    engine, frame = source(backend, tmp_path, pa.table({"name": ["a", "b"], "n": pa.array([1, 2], pa.int64())}))
    lookup = pa.table(
        {
            "name": ["x", 'b "q"', None, "a", 'b "q"', None, "a"],
            "n": pa.array([9, 2, 5, 1, 2, 5, 1], pa.int64()),
            "v": list("abcdefg"),
        }
    )
    step = lookup_step(
        engine, frame, write_lookup(tmp_path, "parquet", lookup), [("name", "name"), ("n", "n")], [("v", "v")]
    )
    refuses(
        engine,
        frame,
        step,
        'The lookup file has more than one row where name = "b \\"q\\"" and n = 2. '
        "Each key must match at most one row.",
    )


@pytest.mark.parametrize("backend", BACKENDS)
def test_lookup_files_that_cant_serve_the_step_are_refused(tmp_path: Path, backend: str) -> None:
    engine, frame = source(
        backend,
        tmp_path,
        pa.table({"id": pa.array([1, 2], pa.int64()), "x": ["a", "b"], "score": [1.5, 2.5]}),
    )
    lookup = pa.table(
        {"id": ["1", "2"], "n": pa.array([1, 2], pa.int64()), "point": [{"x": 1}, {"x": 2}], "X": ["p", "q"]}
    )
    file = write_lookup(tmp_path, "parquet", lookup)
    for keys, columns, message in (
        ([("id", "nope")], [("n", "n")], "The lookup file has no column named 'nope'."),
        (
            [("id", "id")],
            [("n", "n")],
            "Can't match 'id' (integer) with lookup column 'id' (text). Key columns must have the same type.",
        ),
        ([("x", "id")], [("point", "point")], "Lookup column 'point' holds struct values, which can't be added."),
        ([("x", "id")], [("X", "X")], "Look up columns would add 'X', but the data already has a column named 'x'."),
    ):
        refuses(engine, frame, lookup_step(engine, frame, file, keys, columns), message)
    missing = {"path": str(tmp_path / "missing.csv"), "format": "csv"}
    refuses(
        engine, frame, lookup_step(engine, frame, missing, [("x", "id")], [("n", "n")]), "Couldn't read the lookup file"
    )
    with pytest.raises(
        ColumnBindingError, match=re.escape("Look up columns can match text, integer, Boolean or date keys, not float")
    ):
        lookup_step(engine, frame, file, [("score", "n")], [("X", "copy")])


def test_step_parameters_are_validated_before_any_file_is_read() -> None:
    reference = {"id": "c:source:0", "name": "id"}
    other = {"id": "c:source:1", "name": "other"}

    def validate(**overrides: Any) -> None:
        params = {
            "file": {"path": "/data/people.csv", "format": "csv"},
            "keys": [{"column": reference, "lookupColumn": "id"}],
            "columns": [{"lookupColumn": "label", "newColumn": "label"}],
            **overrides,
        }
        validate_step({"id": "lookup", "kind": "lookupColumns", "params": params})

    validate()
    for overrides, message in (
        ({"keys": []}, "between 1 and 8 key pairs"),
        ({"keys": [{"column": reference, "lookupColumn": f"k{index}"} for index in range(9)]}, "between 1 and 8"),
        ({"columns": [{"lookupColumn": f"c{index}", "newColumn": f"n{index}"} for index in range(65)]}, "1 and 64"),
        (
            {"columns": [{"lookupColumn": "a", "newColumn": "Name"}, {"lookupColumn": "b", "newColumn": "name"}]},
            "newColumn names must be unique, ignoring case.",
        ),
        (
            {"keys": [{"column": reference, "lookupColumn": "k"}, {"column": other, "lookupColumn": "k"}]},
            "keys lookupColumn names must be unique.",
        ),
        (
            {"keys": [{"column": reference, "lookupColumn": "a"}, {"column": reference, "lookupColumn": "b"}]},
            "keys must reference distinct columns.",
        ),
        ({"columns": [{"lookupColumn": "a", "newColumn": "line\nbreak"}]}, "newColumn"),
        ({"file": {"path": "people.csv", "format": "csv"}}, "path must be absolute."),
        ({"file": {"path": "/data/people.txt", "format": "csv"}}, "path must end in .csv."),
        ({"file": {"path": "/data/people.csv", "format": "xlsx"}}, "format must be csv, tsv, parquet or jsonl."),
        ({"file": {"path": "/data/people.csv"}}, "must contain exactly path and format."),
    ):
        with pytest.raises(OperationError, match=re.escape(message)):
            validate(**overrides)


def test_describe_requests_are_validated() -> None:
    request = {
        "kind": "describeLookupFile",
        "sessionId": "s",
        "revision": 0,
        "file": {"path": "/a.csv", "format": "csv"},
    }
    assert decode_request(request)["file"] == {"path": "/a.csv", "format": "csv"}
    for file in ({"path": "a.csv", "format": "csv"}, {"path": "/a.csv", "format": "parquet"}, {"path": "/a.csv"}):
        with pytest.raises(ProtocolError):
            decode_request({**request, "file": file})
    with pytest.raises(ProtocolError, match="unknown fields"):
        decode_request({**request, "extra": True})


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_session_describes_previews_applies_and_rereads_a_changed_lookup_file(tmp_path: Path, backend: str) -> None:
    source_path = tmp_path / "orders.csv"
    source_path.write_text("customer,total\nc1,10\nc2,20\nc3,30\n", encoding="utf-8")
    lookup_path = tmp_path / "customers.csv"
    lookup_path.write_text("customer,region\nc1,north\nc3,south\n", encoding="utf-8")
    file = {"path": str(lookup_path), "format": "csv"}
    manager = SessionManager()
    opened = manager.open_session({"kind": "file", "path": str(source_path)}, backend=backend, mode="editing")
    session_id = opened["metadata"]["sessionId"]
    customer = next(
        {"id": column["id"], "name": "customer"}
        for column in opened["metadata"]["schema"]
        if column["name"] == "customer"
    )
    step = {
        "id": "lookup",
        "kind": "lookupColumns",
        "params": {
            "file": file,
            "keys": [{"column": customer, "lookupColumn": "customer"}],
            "columns": [{"lookupColumn": "region", "newColumn": "region"}],
        },
    }

    def regions(response: dict[str, Any]) -> list[str | None]:
        return [None if row["values"][2]["isNull"] else row["values"][2]["display"] for row in response["page"]["rows"]]

    try:
        described = manager.describe_lookup_file(session_id, 0, file)
        assert described["kind"] == "lookupFileDescribed"
        assert described["rowCount"] == 2
        assert [(column["name"], column["type"]) for column in described["columns"]] == [
            ("customer", "string"),
            ("region", "string"),
        ]
        preview = manager.preview_step(session_id, 0, step, 0, 10)
        assert regions(preview) == ["north", None, "south"]
        applied = manager.apply_draft(session_id, preview["revision"], 0, 10)
        assert "lookup" in applied["code"] and str(lookup_path) in applied["code"]
        assert regions(applied) == ["north", None, "south"]
        undone = manager.undo_step(session_id, applied["revision"], 0, 10)
        lookup_path.write_text("customer,region\nc2,east\nc3,west\nc4,far\n", encoding="utf-8")
        assert manager.describe_lookup_file(session_id, undone["revision"], file)["rowCount"] == 3
        preview = manager.preview_step(session_id, undone["revision"], step, 0, 10)
        assert regions(preview) == [None, "east", "west"]
        with pytest.raises(EngineError, match="Couldn't read the lookup file"):
            manager.describe_lookup_file(session_id, preview["revision"], {**file, "path": str(tmp_path / "gone.csv")})
    finally:
        engine = manager.sessions[session_id].engine
        manager.close_session(session_id, manager.sessions[session_id].revision)
    if isinstance(engine, DuckDBEngine):
        assert engine._lookup_copies is None


def test_duckdb_steps_read_their_own_copy_of_the_lookup_file(tmp_path: Path) -> None:
    lookup = pa.table(
        {
            "k": pa.array([1, 2], pa.int64()),
            "at": pa.array([dt.datetime(2026, 1, 2, 3, 4, 5), None], pa.timestamp("ms")),
            "kind": pa.array(["x", "y"]).dictionary_encode(),
        }
    )
    file = write_lookup(tmp_path, "parquet", lookup)
    engine, frame = source("duckdb", tmp_path, pa.table({"k": pa.array([2, 1], pa.int64())}))
    step = lookup_step(engine, frame, file, [("k", "k")], [("at", "at"), ("kind", "kind")])
    live, code = both(engine, frame, step)
    assert types(engine, live, ["at", "kind"]) == types(engine, code, ["at", "kind"])
    Path(file["path"]).unlink()
    assert cells(engine, live, ["at", "kind"]) == [[None, "y"], ["2026-01-02T03:04:05", "x"]]
    engine.close()
