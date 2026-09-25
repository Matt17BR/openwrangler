from __future__ import annotations

import gc
import glob
import json
import os
import subprocess
import sys
import weakref
from base64 import b64encode
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import date, datetime
from decimal import Decimal
from fractions import Fraction
from math import isnan
from pathlib import Path
from threading import Event
from typing import Any

import duckdb
import pytest
from duckdb.func import FunctionNullHandling
from duckdb.sqltypes import BIGINT, DOUBLE, TINYINT

import __main__
import openwrangler_runtime.engines.duckdb_engine as duckdb_runtime
from openwrangler_runtime._column_binding import bind_step
from openwrangler_runtime.duckdb_tables import list_duckdb_tables, validated_database_tables
from openwrangler_runtime.engines.base import DataFrameEngine, EngineError, SessionDataShape, typed_selection_value
from openwrangler_runtime.engines.duckdb_engine import DuckDBEngine, DuckDBNotebookPlan, DuckDBSqlPlan
from openwrangler_runtime.engines.registry import EngineRegistry
from openwrangler_runtime.export_target import ExportTarget, _regular_file_identity
from openwrangler_runtime.generated_helpers import select_generated_helpers
from openwrangler_runtime.lineage import derive_lineage, source_lineage
from openwrangler_runtime.operations import operation_catalog, validate_step
from openwrangler_runtime.session import SessionManager


@pytest.fixture
def database_file(tmp_path: Path) -> Path:
    quote = "'" if os.name == "nt" else '"'
    path = tmp_path / f"database {quote} exact.no-standard-suffix"
    with duckdb.connect(str(path)) as connection:
        connection.execute('CREATE SCHEMA "schema "" exact"')
        connection.execute(
            'CREATE TABLE "schema "" exact"."table; exact" '
            '(id INTEGER, "label\'exact" VARCHAR, ordinary INTEGER DEFAULT 42)'
        )
        connection.execute(
            'INSERT INTO "schema "" exact"."table; exact"(id, "label\'exact") '
            "VALUES (7, 'one'), (11, 'three'), (9, NULL)"
        )
        connection.execute("CREATE TABLE generated_values(id INTEGER, sampled DOUBLE GENERATED ALWAYS AS (random()))")
        connection.execute("INSERT INTO generated_values(id) VALUES (1), (2)")
        connection.execute('CREATE VIEW ordinary_view AS SELECT * FROM "schema "" exact"."table; exact"')
        connection.execute("CHECKPOINT")
    return path


def test_duckdb_database_table_session_retains_quoted_source_and_forces_viewing(
    database_file: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    install_conversion_guards(monkeypatch)
    source = {
        "kind": "file",
        "path": str(database_file),
        "label": database_file.name,
        "importOptions": {"duckdbSchema": 'schema " exact', "duckdbTable": "table; exact"},
    }
    before = database_file.read_bytes()
    manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))
    monkeypatch.setattr(
        duckdb_runtime, "_connect", lambda: pytest.fail("Database reads must retain their own connection")
    )
    try:
        opened = manager.open_session(source, backend="duckdb", mode="editing", page_size=2)
        session_id = opened["metadata"]["sessionId"]
        session = manager.sessions[session_id]
        native = session.engine
        assert isinstance(native, DuckDBEngine) and isinstance(session.original, DuckDBSqlPlan)
        assert opened["metadata"]["mode"] == "viewing"
        assert opened["metadata"]["capabilities"] == {
            "editable": False,
            "lazy": True,
            "cancel": False,
            "exportCsv": False,
            "exportParquet": False,
            "notebookInsert": False,
            "supportedOperations": [],
        }
        assert [column["name"] for column in opened["metadata"]["schema"]] == ["id", "label'exact", "ordinary"]
        assert [[cell["display"] for cell in row["values"]] for row in opened["page"]["rows"]] == [
            ["7", "one", "42"],
            ["11", "three", "42"],
        ]
        model = {"logic": "and", "filters": [], "sort": [{"column": "id", "direction": "desc", "nulls": "last"}]}
        page = manager.get_page(session_id, 0, 0, 10, model)["page"]
        assert [row["values"][0]["display"] for row in page["rows"]] == ["11", "9", "7"]
        assert len({row["id"] for row in page["rows"]}) == 3
        summary = manager.get_summary(session_id, 0, model, ["c:source:0"])["summaries"][0]
        assert summary["numeric"]["min"] == 7 and summary["numeric"]["max"] == 11
        assert summary["numeric"]["sum"] == 27
        counted: list[Any] = []
        shape = native.shape

        def count(frame: Any) -> SessionDataShape:
            counted.append(frame)
            return shape(frame)

        with monkeypatch.context() as patch:
            patch.setattr(native, "shape", count)
            filtered_model = {
                "filters": [
                    {
                        "column": "id",
                        "type": "integer",
                        "predicates": [{"kind": "predicate", "operator": "gt", "value": 7}],
                    }
                ],
                "sort": [],
            }
            assert manager.get_page(session_id, 0, 0, 10, filtered_model)["page"]["totalRows"] == 2
            sorted_model = {**filtered_model, "sort": model["sort"]}
            sorted_page = manager.get_page(session_id, 0, 0, 10, sorted_model)["page"]
            assert len(counted) == 2  # Database tables can have volatile computed columns.
            assert [row["values"][0]["display"] for row in sorted_page["rows"]] == ["11", "9"]
        with pytest.raises(EngineError, match="Conversion Error"):
            native._terminal_rows(session.original, "SELECT CAST('invalid' AS INTEGER) FROM ow LIMIT 1")
        assert native.shape(session.original) == {"rows": 3, "columns": 3}
        with native._tracked_connection() as connection:
            assert connection.execute(
                "SELECT current_setting('enable_external_access'), current_setting('autoload_known_extensions'), "
                "current_setting('autoinstall_known_extensions'), current_setting('enable_external_file_cache')"
            ).fetchone() == (False, False, False, False)
            with pytest.raises(duckdb.PermissionException, match="disabled"):
                connection.execute("SELECT * FROM read_csv(?)", [str(tmp_path / "external.csv")]).fetchall()
        with pytest.raises(EngineError, match="viewing-only"):
            manager.preview_step(
                session_id, 0, step("cloneColumn", column={"id": "c:source:0", "name": "id"}, newName="copy"), 0, 10
            )
        with pytest.raises(EngineError, match="viewing-only"):
            manager.apply_draft(session_id, 0, 0, 10)
        with pytest.raises(EngineError, match="viewing-only"):
            manager.export_data(session_id, 0, str(tmp_path / "output.csv"), export_options("csv"))
        with pytest.raises(EngineError, match="viewing-only"):
            native.compile_plan([])
        with pytest.raises(EngineError, match="cannot be cloned"):
            manager.open_session(source, backend="duckdb", clone_from={"sessionId": session_id, "revision": 0})
        assert list(manager.sessions) == [session_id]
        assert native._database_reservation is not None
        temporary = Path(native._database_reservation.temporary.name)
        assert temporary.exists() and temporary.parent != database_file.parent
        manager.close_session(session_id, 0)
        assert not temporary.exists() and not native._active_connections
        assert not (tmp_path / "output.csv").exists()
    finally:
        manager.close_all()
    assert database_file.read_bytes() == before


def test_duckdb_database_query_fetch_and_close_are_serialized(database_file: Path) -> None:
    engine = DuckDBEngine()
    frame = engine.read_file(str(database_file), {"duckdbSchema": "main", "duckdbTable": "generated_values"})
    first = engine._terminal_rows(frame, "SELECT * FROM ow ORDER BY id")
    second = engine._terminal_rows(frame, "SELECT * FROM ow ORDER BY id")
    assert [row[0] for row in first] == [1, 2] == [row[0] for row in second]
    assert first != second and all(0 <= row[1] < 1 for row in first + second)
    entered, attempted = Event(), Event()

    def hold_fetch() -> None:
        with engine._tracked_connection() as connection:
            connection.execute("SELECT 1 UNION ALL SELECT 2")
            entered.set()
            assert attempted.wait(5)
            assert not engine._closed
            assert connection.fetchall() == [(1,), (2,)]

    def close_after_fetch() -> None:
        assert entered.wait(5)
        assert not engine._database_query_lock.acquire(blocking=False)
        attempted.set()
        engine.close()

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            read = pool.submit(hold_fetch)
            close = pool.submit(close_after_fetch)
            read.result(timeout=10)
            close.result(timeout=10)
        assert engine._closed and not engine._active_connections
        with pytest.raises(EngineError, match="closed"):
            engine.shape(frame)
    finally:
        engine.close()


def test_duckdb_database_viewers_share_spill_until_last_reader_closes(database_file: Path) -> None:
    before = database_file.read_bytes()
    first, second, later, failed = (DuckDBEngine() for _ in range(4))
    first_options = {"duckdbSchema": "main", "duckdbTable": "generated_values"}
    second_options = {"duckdbSchema": 'schema " exact', "duckdbTable": "table; exact"}
    try:
        frame = first.read_file(str(database_file), first_options)
        second_frame = second.read_file(str(database_file), second_options)
        reservation = first._database_reservation
        assert reservation is not None and second._database_reservation is reservation
        temporary = Path(reservation.temporary.name)
        assert temporary.exists() and temporary.parent != database_file.parent
        assert first._database_connection is not second._database_connection
        assert second.header_stats(second_frame) == {
            "missingCells": 1,
            "missingRows": 1,
            "duplicateRows": 0,
            "missingValuesByColumn": [
                {"column": "id", "count": 0},
                {"column": "label'exact", "count": 1},
                {"column": "ordinary", "count": 0},
            ],
        }
        later_frame = later.read_file(str(database_file), second_options)
        assert later._database_reservation is reservation
        for engine in (first, second, later):
            with engine._tracked_connection() as connection:
                assert connection.execute(
                    "SELECT current_setting('threads'), current_setting('temp_directory'), "
                    "current_setting('enable_external_access'), current_setting('autoload_known_extensions'), "
                    "current_setting('autoinstall_known_extensions'), current_setting('enable_external_file_cache')"
                ).fetchone() == (1, str(temporary), False, False, False, False)
        with pytest.raises(EngineError, match="base table is no longer available"):
            failed.read_file(str(database_file), {"duckdbSchema": "main", "duckdbTable": "ordinary_view"})
        assert failed._closed and failed._database_reservation is None
        assert temporary.exists()
        cli = subprocess.run(
            [sys.executable, "-B", "-m", "openwrangler_runtime.duckdb_tables", "--source", str(database_file)],
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
        )
        assert json.loads(cli.stdout) == [
            {"schema": "main", "name": "generated_values"},
            {"schema": 'schema " exact', "name": "table; exact"},
        ]
        assert cli.stderr == ""
        assert first.shape(frame) == {"rows": 2, "columns": 2}
        first.close()
        first.close()
        assert first._database_reservation is None and temporary.exists()
        assert second.shape(second_frame) == {"rows": 3, "columns": 3}
        second.close()
        assert temporary.exists()
        assert later._terminal_rows(later_frame, "SELECT id, ordinary FROM ow ORDER BY id") == [
            (7, 42),
            (9, 42),
            (11, 42),
        ]
        later.close()
        assert not temporary.exists() and later._database_reservation is None
        with duckdb.connect(str(database_file)) as writer:
            assert writer.execute('SELECT id FROM "schema "" exact"."table; exact" ORDER BY id').fetchall() == [
                (7,),
                (9,),
                (11,),
            ]
    finally:
        for engine in (first, second, later, failed):
            engine.close()
    assert database_file.read_bytes() == before


def test_duckdb_database_pending_connect_retains_spill(database_file: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    before = database_file.read_bytes()
    first, pending = DuckDBEngine(), DuckDBEngine()
    options = {"duckdbSchema": "main", "duckdbTable": "generated_values"}
    first.read_file(str(database_file), options)
    reservation = first._database_reservation
    assert reservation is not None
    temporary = Path(reservation.temporary.name)
    entered, release = Event(), Event()
    connect = duckdb.connect

    def hold_connect(*args: Any, **kwargs: Any) -> Any:
        entered.set()
        assert release.wait(5)
        assert temporary.exists()
        return connect(*args, **kwargs)

    monkeypatch.setattr(duckdb, "connect", hold_connect)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            opening = pool.submit(pending.read_file, str(database_file), options)
            try:
                assert entered.wait(5)
                assert pending._database_reservation is reservation and reservation.users == 2
                first.close()
                assert temporary.exists() and reservation.users == 1
            finally:
                release.set()
            frame = opening.result(timeout=10)
        assert pending.shape(frame) == {"rows": 2, "columns": 2}
        pending.close()
        assert not temporary.exists()
    finally:
        release.set()
        first.close()
        pending.close()
    assert database_file.read_bytes() == before


def test_duckdb_database_last_release_cleans_only_its_old_directory(
    database_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = database_file.read_bytes()
    first, later = DuckDBEngine(), DuckDBEngine()
    options = {"duckdbSchema": "main", "duckdbTable": "generated_values"}
    first.read_file(str(database_file), options)
    reservation = first._database_reservation
    assert reservation is not None
    old_directory = Path(reservation.temporary.name)
    entered, release = Event(), Event()
    cleanup = reservation.temporary.cleanup
    calls: list[str] = []

    def hold_cleanup() -> None:
        calls.append("cleanup")
        entered.set()
        assert release.wait(5)
        cleanup()

    monkeypatch.setattr(reservation.temporary, "cleanup", hold_cleanup)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            closing = pool.submit(first.close)
            try:
                assert entered.wait(5)
                opening = pool.submit(later.read_file, str(database_file), options)
                frame = opening.result(timeout=5)
                assert later._database_reservation is not None and later._database_reservation is not reservation
                new_directory = Path(later._database_reservation.temporary.name)
                assert new_directory != old_directory and new_directory.exists() and old_directory.exists()
            finally:
                release.set()
            closing.result(timeout=10)
        first.close()
        assert calls == ["cleanup"] and not old_directory.exists() and new_directory.exists()
        assert later.shape(frame) == {"rows": 2, "columns": 2}
        later.close()
        assert not new_directory.exists()
    finally:
        release.set()
        first.close()
        later.close()
    assert database_file.read_bytes() == before


def test_duckdb_database_interrupt_targets_only_its_active_connection(
    database_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = database_file.read_bytes()
    first, peer = DuckDBEngine(), DuckDBEngine()
    options = {"duckdbSchema": "main", "duckdbTable": "generated_values"}
    calls: list[Any] = []
    native_interrupt = duckdb.DuckDBPyConnection.interrupt

    def record_interrupt(connection: Any) -> None:
        calls.append(connection)
        native_interrupt(connection)

    monkeypatch.setattr(duckdb.DuckDBPyConnection, "interrupt", record_interrupt)
    try:
        first_frame = first.read_file(str(database_file), options)
        peer_frame = peer.read_file(str(database_file), options)
        with first._tracked_connection() as first_connection, peer._tracked_connection() as peer_connection:
            first_connection.execute("SELECT id FROM generated_values ORDER BY id")
            peer_connection.execute("SELECT id FROM generated_values ORDER BY id")
            first.interrupt()
            assert calls == [first_connection] and first_connection is not peer_connection
            assert peer_connection.fetchall() == [(1,), (2,)]
        first.interrupt()
        assert calls == [first_connection]
        assert first.shape(first_frame) == peer.shape(peer_frame) == {"rows": 2, "columns": 2}
    finally:
        first.close()
        peer.close()
    assert database_file.read_bytes() == before


def test_duckdb_database_replaced_source_refuses_join_before_native_connect(
    database_file: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = database_file.read_bytes()
    replacement = tmp_path / "replacement.duckdb"
    retired = tmp_path / "retired.duckdb"
    with duckdb.connect(str(replacement)) as writer:
        writer.execute("CREATE TABLE generated_values AS SELECT 99 AS id")
        writer.execute("CHECKPOINT")
    replacement_before = replacement.read_bytes()
    source = {
        "kind": "file",
        "path": str(database_file),
        "label": database_file.name,
        "importOptions": {"duckdbSchema": "main", "duckdbTable": "generated_values"},
    }
    manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))
    temporary: Path | None = None
    try:
        opened = manager.open_session(source, backend="duckdb")
        session_id = opened["metadata"]["sessionId"]
        first = manager.sessions[session_id].engine
        assert isinstance(first, DuckDBEngine) and first._database_reservation is not None
        reservation = first._database_reservation
        temporary = Path(reservation.temporary.name)
        try:
            database_file.replace(retired)
        except OSError as error:
            if os.name == "nt" and getattr(error, "winerror", None) in {5, 32, 33}:
                pytest.skip(f"Windows refused replacing the open synthetic database: {error}")
            raise
        replacement.replace(database_file)
        with monkeypatch.context() as admission:
            admission.setattr(
                duckdb, "connect", lambda *_args, **_kwargs: pytest.fail("Changed source reached connect")
            )
            with pytest.raises(EngineError, match="Close the existing table viewers"):
                manager.open_session(source, backend="duckdb")
        assert list(manager.sessions) == [session_id] and not first._closed
        assert first._database_reservation is reservation and reservation.users == 1 and temporary.exists()
        manager.close_session(session_id, 0)
        assert not temporary.exists()
        reopened = manager.open_session(source, backend="duckdb")
        assert [[cell["display"] for cell in row["values"]] for row in reopened["page"]["rows"]] == [["99"]]
    finally:
        manager.close_all()
        if temporary is not None:
            assert not temporary.exists()
        if retired.exists():
            assert retired.read_bytes() == before and database_file.read_bytes() == replacement_before
        else:
            assert database_file.read_bytes() == before and replacement.read_bytes() == replacement_before


def test_duckdb_database_discovery_and_failed_selection_release_reader(
    database_file: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = database_file.read_bytes()
    expected = [{"schema": "main", "name": "generated_values"}, {"schema": 'schema " exact', "name": "table; exact"}]
    with monkeypatch.context() as discovery_patch:
        discovery_patch.setattr(
            duckdb_runtime,
            "TemporaryDirectory",
            lambda **_kwargs: pytest.fail("Discovery must not allocate spill storage"),
        )
        discovery = DuckDBEngine()
        try:
            assert discovery.list_database_tables(str(database_file)) == expected
            assert discovery._database_reservation is None
            with discovery._tracked_connection() as connection:
                assert connection.execute("SELECT current_setting('temp_directory')").fetchone() == ("",)
        finally:
            discovery.close()
    engine = DuckDBEngine()
    directories: list[Path] = []
    temporary_directory = duckdb_runtime.TemporaryDirectory

    def record_directory(**kwargs: Any) -> Any:
        directory = temporary_directory(**kwargs)
        directories.append(Path(directory.name))
        return directory

    monkeypatch.setattr(duckdb_runtime, "TemporaryDirectory", record_directory)
    try:
        with pytest.raises(EngineError, match="base table is no longer available"):
            engine.read_file(str(database_file), {"duckdbSchema": "main", "duckdbTable": "ordinary_view"})
        assert engine._closed and engine._database_reservation is None
        assert len(directories) == 1 and not directories[0].exists()
    finally:
        engine.close()
    incompatible = DuckDBEngine()
    with duckdb.connect(str(database_file), read_only=True) as caller:
        try:
            with pytest.raises(EngineError, match="incompatible connection") as failure:
                incompatible.read_file(str(database_file), {"duckdbSchema": "main", "duckdbTable": "generated_values"})
            assert isinstance(failure.value.__cause__, duckdb.ConnectionException)
            assert incompatible._closed and incompatible._database_reservation is None
            assert len(directories) == 2 and all(not path.exists() for path in directories)
            assert caller.execute("SELECT id FROM generated_values ORDER BY id").fetchall() == [(1,), (2,)]
            assert caller.execute("SELECT current_setting('enable_external_access')").fetchone() == (True,)
        finally:
            incompatible.close()
    writer = subprocess.run(
        [sys.executable, "-B", "-c", "import duckdb,sys; c=duckdb.connect(sys.argv[1]); c.close()", str(database_file)],
        check=True,
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert writer.stdout == writer.stderr == "" and database_file.read_bytes() == before
    empty = tmp_path / "empty"
    duckdb.connect(str(empty)).close()
    assert list_duckdb_tables(empty) == []
    assert validated_database_tables([("same", "name"), ("other", "name"), ("😀", "x" * 1024)]) == [
        {"schema": "same", "name": "name"},
        {"schema": "other", "name": "name"},
        {"schema": "😀", "name": "x" * 1024},
    ]
    absent = tmp_path / "does-not-exist"
    failed = DuckDBEngine()
    with pytest.raises(EngineError, match="read-only"):
        failed.list_database_tables(str(absent))
    assert failed._closed and not absent.exists() and failed._database_reservation is None
    oversized = tmp_path / "oversized-name"
    with duckdb.connect(str(oversized)) as connection:
        connection.execute(f'CREATE TABLE "{"v" * 1_024}"(value INTEGER)')
        connection.execute(f'CREATE SCHEMA "{"é" * 20_000}"')
        connection.execute(f'CREATE TABLE "{"é" * 20_000}"."{"😀" * 20_000}"(value INTEGER)')
    decode = duckdb_runtime.validated_database_tables

    def bounded_decode(rows: list[tuple[Any, ...]]) -> list[dict[str, str]]:
        assert rows == [("main", "v" * 1_024), ("é" * 1_025, "😀" * 1_025)]
        return decode(rows)

    monkeypatch.setattr(duckdb_runtime, "validated_database_tables", bounded_decode)
    with pytest.raises(ValueError, match="invalid schema or table name"):
        list_duckdb_tables(oversized)


def test_duckdb_database_read_only_wal_recovery_preserves_both_files(database_file: Path) -> None:
    writer = subprocess.run(
        [
            sys.executable,
            "-B",
            "-c",
            "import duckdb,os,sys; c=duckdb.connect(sys.argv[1]); "
            "c.execute('INSERT INTO generated_values(id) VALUES (3)'); os._exit(0)",
            str(database_file),
        ],
        check=True,
        capture_output=True,
        timeout=15,
    )
    assert writer.stdout == writer.stderr == b""
    wal = Path(str(database_file) + ".wal")
    before = (database_file.read_bytes(), wal.read_bytes())
    engine = DuckDBEngine()
    try:
        frame = engine.read_file(str(database_file), {"duckdbSchema": "main", "duckdbTable": "generated_values"})
        assert engine._terminal_rows(frame, "SELECT id FROM ow ORDER BY id") == [(1,), (2,), (3,)]
        blocked = subprocess.run(
            [sys.executable, "-B", "-c", "import duckdb,sys; duckdb.connect(sys.argv[1]).close()", str(database_file)],
            capture_output=True,
            text=True,
            timeout=15,
        )
        lock_refusal = "already open in" if os.name == "nt" else "lock"
        assert blocked.returncode != 0 and lock_refusal in blocked.stderr.lower()
    finally:
        engine.close()
    assert (database_file.read_bytes(), wal.read_bytes()) == before


@pytest.mark.parametrize(
    "rows,message",
    [
        ([("main", "same"), ("main", "same")], "duplicate"),
        ([("main", str(i)) for i in range(4097)], "too many"),
        ([("main", "x" * 1025)], "invalid"),
        ([("main", "\ud800")], "invalid"),
        ([("main", "a\0b")], "invalid"),
        ([("main", "")], "invalid"),
        ([("main", f"{i:04d}" + "😀" * 1020) for i in range(17)], "too much"),
        ([("main", f"{i:04d}" + "\x01" * 1020) for i in range(44)], "too large"),
    ],
)
def test_duckdb_database_discovery_bounds(rows: list[tuple[str, str]], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        validated_database_tables(rows)


def test_duckdb_extract_struct_fields_preserves_literal_names_and_current_input(tmp_path: Path) -> None:
    path = tmp_path / "struct.parquet"
    engine = DuckDBEngine()
    with duckdb.connect() as connection:
        source = connection.sql(
            "SELECT i AS id, CASE WHEN i = 1 THEN NULL "
            "ELSE {'*': 7, 'a.b': i, 'A': 90, 'a_1': 91} END AS \"parent\" FROM range(3) t(i)"
        )
        source.write_parquet(str(path))
        before = path.read_bytes()
        frame = engine.read_file(str(path))
        operation = bound_step(
            "extractStructFields",
            column=bound_ref("c:source:1", "parent", 1),
            fields=[{"field": "a.b", "newColumn": 'selected"value'}, {"field": "*", "newColumn": "*"}],
        )
        try:
            namespace: dict[str, Any] = {}
            exec(engine.compile_plan([operation]), namespace)
            result = engine.apply_transform(frame, operation)
            assert result.columns == ["id", "parent", 'selected"value', "*"]
            assert engine._terminal_rows(result, 'SELECT id, "selected""value", "*" FROM ow') == [
                (0, 0, 7),
                (1, None, None),
                (2, 2, 7),
            ]
            for native in (
                connection.read_parquet(str(path)),
                connection.read_parquet(str(path)).project("parent, id"),
                connection.read_parquet(str(path)).limit(0),
            ):
                generated = namespace["clean_data"](native)
                assert generated.columns == [*native.columns, 'selected"value', "*"]
                count = native.count("*").fetchone()
                assert count is not None
                assert (
                    generated.project('id, "selected""value", "*"').fetchall()
                    == [(0, 0, 7), (1, None, None), (2, 2, 7)][: count[0]]
                )
                assert generated.project("id, parent").fetchall() == native.project("id, parent").fetchall()
            assert path.read_bytes() == before
        finally:
            engine.close()


def test_duckdb_extract_struct_fields_retains_native_scalar_storage() -> None:
    values = {
        "text": "'é'::VARCHAR",
        "enum": "'one'::ENUM('one', 'two')",
        "uuid": "'123e4567-e89b-12d3-a456-426614174000'::UUID",
        "signed": "'-170141183460469231731687303715884105728'::HUGEINT",
        "unsigned": "'340282366920938463463374607431768211455'::UHUGEINT",
        "float": "'Infinity'::DOUBLE",
        "decimal": "'12345678901234567890123456.7890'::DECIMAL(30,4)",
        "boolean": "true",
        "date": "DATE '1969-12-31'",
        "zoned": "TIMESTAMPTZ '1969-12-31 23:59:59.999999+00'",
        "duration": "INTERVAL '2 months 3 days 4 microseconds'",
        "binary": "'\\x00\\xFF'::BLOB",
        "bits": "'10101'::BIT",
        **{
            f"timestamp_{unit}": f"CAST('1969-12-31 23:59:59.999999999' AS {unit})"
            for unit in ("TIMESTAMP_NS", "TIMESTAMP", "TIMESTAMP_MS", "TIMESTAMP_S")
        },
    }
    entries = ", ".join(f"{name!r}: {value}" for name, value in values.items())
    engine = DuckDBEngine()
    with duckdb.connect() as connection:
        source = connection.sql(
            f"SELECT i AS id, CASE WHEN i = 1 THEN NULL ELSE {{{entries}}} END AS record FROM range(3) t(i)"
        )
        native = source
        source_sql = source.sql_query()
        frame = engine._relation_from_sql(source_sql)
        fields = [{"field": name, "newColumn": f"out_{index}"} for index, name in enumerate(values)]
        operation = bound_step("extractStructFields", column=bound_ref("c:source:1", "record", 1), fields=fields)
        try:
            namespace: dict[str, Any] = {}
            exec(engine.compile_plan([operation]), namespace)
            current_types = dict(native.types[1].children)
            expected_sql = ", ".join(
                f"CASE WHEN i = 1 THEN NULL ELSE {values[field['field']]} END AS {field['newColumn']}"
                for field in fields
            )
            for condition in ("true", "false", "id = 1"):
                current = native.filter(condition)
                live = engine.apply_transform(engine._relation(frame, f"SELECT * FROM ow WHERE {condition}"), operation)
                generated = namespace["clean_data"](current)
                expected = f"SELECT i AS id, {expected_sql} FROM range(3) t(i) WHERE {condition.replace('id', 'i')}"
                selection = "id, " + ", ".join(field["newColumn"] for field in fields)
                for actual_sql in (live.sql, generated.sql_query()):
                    comparison = (
                        f"(SELECT {selection} FROM ({actual_sql}) EXCEPT ALL {expected}) "
                        f"UNION ALL ({expected} EXCEPT ALL SELECT {selection} FROM ({actual_sql}))"
                    )
                    assert connection.sql(comparison).fetchall() == []
                    assert (
                        connection.sql(
                            f"(SELECT id, record FROM ({actual_sql}) EXCEPT ALL "
                            f"SELECT * FROM ({current.sql_query()})) UNION ALL "
                            f"(SELECT * FROM ({current.sql_query()}) EXCEPT ALL SELECT id, record FROM ({actual_sql}))"
                        ).fetchall()
                        == []
                    )
                assert live.columns == [*frame.columns, *[field["newColumn"] for field in fields]]
                assert live.types[2:] == [str(current_types[field["field"]]) for field in fields]
                assert generated.types[2:] == [current_types[field["field"]] for field in fields]
            assert source.sql_query() == source_sql
        finally:
            engine.close()


def test_duckdb_extract_struct_fields_revalidates_current_fields_and_outputs() -> None:
    engine = DuckDBEngine()
    operation = bound_step(
        "extractStructFields",
        column=bound_ref("c:source:0", "record", 0),
        fields=[{"field": "value", "newColumn": "selected"}],
    )
    with duckdb.connect() as connection:
        namespace: dict[str, Any] = {}
        try:
            exec(engine.compile_plan([operation]), namespace)
            invalid = [
                "SELECT 1 AS other",
                "SELECT 1 AS record",
                "SELECT {'other': 1} AS record",
                "SELECT {'value': 1} AS record, 2 AS SELECTED",
                *[
                    f"SELECT CAST(NULL AS STRUCT(value {dtype})) AS record"
                    for dtype in (
                        "BIGINT[]",
                        "BIGINT[2]",
                        "STRUCT(child BIGINT)",
                        "MAP(VARCHAR, BIGINT)",
                        "UNION(a BIGINT, b VARCHAR)",
                        "TIME",
                        "TIME WITH TIME ZONE",
                        "BIGNUM",
                    )
                ],
                "SELECT MAP(['value'], [1]) AS record",
                "SELECT union_value(value := 1) AS record",
            ]
            for sql in invalid:
                with pytest.raises(EngineError, match="Extract Struct Fields"):
                    engine.apply_transform(engine._relation_from_sql(sql), operation)
                with pytest.raises(ValueError, match="Extract Struct Fields"):
                    namespace["clean_data"](connection.sql(sql))
            for changed in ("SELECT {'value': 'new'} AS record", "SELECT {'later': 4, 'value': 'new'} AS record"):
                result = namespace["clean_data"](connection.sql(changed))
                assert result.project("selected").fetchall() == [("new",)]
                assert str(result.types[1]) == "VARCHAR"
            for requested in ("a", "VALUE"):
                mismatch = bound_step(
                    "extractStructFields",
                    column=bound_ref("c:source:0", "record", 0),
                    fields=[{"field": requested, "newColumn": "selected"}],
                )
                source = connection.sql("SELECT {'A': 1, 'a_1': 2, 'value': 3} AS record")
                with pytest.raises(EngineError, match="exact current"):
                    engine.apply_transform(engine._relation_from_sql(source.sql_query()), mismatch)
                exec(engine.compile_plan([mismatch]), namespace)
                with pytest.raises(ValueError, match="exact current"):
                    namespace["clean_data"](source)
        finally:
            engine.close()


def test_duckdb_extract_struct_fields_masks_hidden_parquet_children_and_owns_catalog(tmp_path: Path) -> None:
    import pyarrow as pa
    import pyarrow.parquet as pq

    name = "__open_wrangler_internal_row_id_child"
    parent = pa.StructArray.from_arrays(
        [pa.array([-1, 123, None], type=pa.int64()).cast(pa.timestamp("ns"))],
        names=[name],
        mask=pa.array([False, True, False]),
    )
    assert parent.field(0).cast(pa.int64()).to_pylist() == [-1, 123, None]
    assert parent[1].as_py() is None
    path = tmp_path / "hidden.parquet"
    pq.write_table(pa.table({"record": parent}), path)
    before = path.read_bytes()
    operation = bound_step(
        "extractStructFields",
        column=bound_ref("c:source:0", "record", 0),
        fields=[{"field": name, "newColumn": "selected"}],
    )
    engine = DuckDBEngine()
    with duckdb.connect() as connection:
        connection.execute("CREATE MACRO struct_extract(value, key) AS 99")
        connection.execute("CREATE TABLE ow(value INTEGER)")
        connection.execute("INSERT INTO ow VALUES (123)")
        source = connection.read_parquet(str(path))
        catalog_sql = (
            "SELECT function_name, function_oid FROM duckdb_functions() "
            "WHERE function_name = 'struct_extract' ORDER BY function_oid"
        )
        catalog = connection.sql(catalog_sql).fetchall()
        try:
            namespace: dict[str, Any] = {}
            exec(engine.compile_plan([operation]), namespace)
            generated = namespace["clean_data"](source)
            live = engine.apply_transform(engine.read_file(str(path)), operation)
            assert generated.project("system.main.epoch_ns(selected)").fetchall() == [(-1,), (None,), (None,)]
            assert engine._terminal_rows(live, "SELECT system.main.epoch_ns(selected) FROM ow") == [
                (-1,),
                (None,),
                (None,),
            ]
            assert generated.project("record").fetchall() == source.fetchall()
            assert connection.sql(catalog_sql).fetchall() == catalog
            assert connection.sql("SELECT * FROM ow").fetchall() == [(123,)]
            assert path.read_bytes() == before
        finally:
            engine.close()


def test_duckdb_extract_struct_fields_enforces_output_bounds_before_append() -> None:
    entries = ", ".join(f"'field_{index}': {index}" for index in range(65))
    sql = f"SELECT {{{entries}}} AS record, 123 AS __open_wrangler_internal_row_id_test"
    fields = [{"field": f"field_{index}", "newColumn": f"selected_{index}"} for index in range(65)]
    engine = DuckDBEngine()
    with duckdb.connect() as connection:
        source = connection.sql(sql)
        frame = engine._relation_from_sql(sql)
        try:
            for selected in (
                fields[:64],
                [fields[0], {"field": "field_1", "newColumn": "SELECTED_0"}],
                [{"field": "field_0", "newColumn": "RECORD"}],
            ):
                operation = bound_step(
                    "extractStructFields", column=bound_ref("c:source:0", "record", 0), fields=selected
                )
                namespace: dict[str, Any] = {}
                exec(engine.compile_plan([operation]), namespace)
                if len(selected) == 64:
                    live = engine.apply_transform(frame, operation)
                    generated = namespace["clean_data"](source)
                    assert live.columns == [*frame.columns, *[field["newColumn"] for field in selected]]
                    assert generated.columns == live.columns
                    expected = (123, *range(64))
                    assert generated.project("* EXCLUDE (record)").fetchall() == [expected]
                    assert engine._terminal_rows(live, "SELECT * EXCLUDE (record) FROM ow") == [expected]
                else:
                    with pytest.raises(EngineError, match="Extract Struct Fields"):
                        engine.apply_transform(frame, operation)
                    with pytest.raises(ValueError, match="Extract Struct Fields"):
                        namespace["clean_data"](source)
            assert source.columns == ["record", "__open_wrangler_internal_row_id_test"]
        finally:
            engine.close()


def test_duckdb_extract_struct_fields_refuses_metadata_before_source_evaluation() -> None:
    calls = []

    def observed(value):
        calls.append(value)
        return value

    engine = DuckDBEngine()
    with duckdb.connect() as connection:
        connection.create_function("ow_observed_struct_value", observed, [BIGINT], BIGINT, side_effects=True)
        source = connection.sql("SELECT {'value': ow_observed_struct_value(i)} AS record FROM range(3) t(i)")
        try:
            invalid = bound_step(
                "extractStructFields",
                column=bound_ref("c:source:0", "record", 0),
                fields=[{"field": "absent", "newColumn": "selected"}],
            )
            namespace: dict[str, Any] = {}
            exec(engine.compile_plan([invalid]), namespace)
            with pytest.raises(ValueError, match="exact current"):
                namespace["clean_data"](source)
            assert calls == []
            valid = bound_step(
                "extractStructFields",
                column=bound_ref("c:source:0", "record", 0),
                fields=[{"field": "value", "newColumn": "selected"}],
            )
            exec(engine.compile_plan([valid]), namespace)
            result = namespace["clean_data"](source)
            # Existing generated result validation consumes the plan once, before the caller's fetch.
            assert calls == [0, 1, 2]
            assert result.project("selected").fetchall() == [(0,), (1,), (2,)]
            assert calls == [0, 1, 2, 0, 1, 2]
        finally:
            engine.close()


def step(kind: str, **params: Any) -> dict[str, Any]:
    return validate_step({"id": f"duckdb-{kind}", "kind": kind, "params": params})


def bound_ref(identifier: str, name: str, position: int) -> dict[str, str | int]:
    return {"id": identifier, "name": name, "position": position}


def bound_step(kind: str, **params: Any) -> dict[str, Any]:
    return {"id": f"duckdb-{kind}", "kind": kind, "params": params}


def export_options(format_name: str) -> dict[str, object]:
    return (
        {"format": "csv", "delimiter": ",", "quoteChar": '"', "encoding": "utf-8", "header": True}
        if format_name == "csv"
        else {"format": "parquet"}
    )


def source_relation() -> Any:
    return duckdb.sql(
        """
        SELECT * FROM (VALUES
            ('a', ' alpha-one ', 'red|blue', CAST(1.2 AS DOUBLE), 2, '2024-01-02'),
            ('a', 'BETA-two', 'blue', CAST(2.8 AS DOUBLE), 3, '2024-02-03'),
            ('b', NULL, NULL, CAST(NULL AS DOUBLE), 4, '2024-03-04'),
            ('b', 'alpha-one', 'red', CAST(2.8 AS DOUBLE), 3, '2024-02-03')
        ) AS source("group", "text", "tags", "value", "other", "date")
        """
    )


def test_duckdb_view_primitives_ignore_macros_but_preserve_source_functions() -> None:
    engine = DuckDBEngine()
    with duckdb_runtime._connect() as connection:
        try:
            for definition in (
                '"-"(x, y) AS 97',
                "length(x) AS 17",
                "isnan(x) AS TRUE",
                "isfinite(x) AS FALSE",
                "count_star() AS 97",
                "count(x) AS 97",
                "min(x) AS -99",
                "max(x) AS -99",
                "avg(x) AS -99",
                "median(x) AS -99",
                "stddev_samp(x) AS -99",
                "sum(x) AS -99",
                "contains(x, y) AS FALSE",
                "translate(x, upper_chars, lower_chars) AS 'caller'",
                "nextafter(x, y) AS 0.0",
                "map_values(x) AS [97::UBIGINT]",
                "histogram(x, boundaries) AS MAP([0.0], [97::UBIGINT])",
            ):
                connection.execute("CREATE MACRO " + definition)
            source = connection.sql(
                "SELECT *, length(text) AS from_caller FROM (VALUES "
                "('a', 1.0::DOUBLE, 0.0::DOUBLE, TRUE), ('abc', 3.0, 10.0, FALSE), "
                "('abc', 3.0, 10.0, FALSE), (NULL, NULL, 20.0, NULL), "
                "('', 'NaN'::DOUBLE, 30.0, TRUE), (NULL, 5.0, 40.0, NULL)) source(text, value, finite, flag)"
            )
            receipt_query = "text, CAST(value AS VARCHAR), finite, flag, from_caller"
            before = source.project(receipt_query).fetchall()
            assert [row[-1] for row in before] == [17] * 6
            source_identity = (source.sql_query(), source.columns, source.types)
            catalog_query = (
                "SELECT schema_name, function_name, macro_definition FROM duckdb_functions() "
                "WHERE function_type = 'macro' AND NOT internal ORDER BY schema_name, function_name"
            )
            catalog_before = connection.sql(catalog_query).fetchall()
            settings_before = connection.sql(
                "SELECT current_setting('search_path'), current_setting('threads')"
            ).fetchall()
            frame = engine.normalize_notebook_relation(source)
            assert engine.shape(frame) == {"rows": 6, "columns": 5}
            identified = engine.ensure_row_ids(frame, "view_primitives")
            identified_page = engine.page(identified, 0, 6, total_rows=6, column_projection=[(0, "text")])
            assert [row["id"] for row in identified_page["rows"]] == [
                f"r:{duckdb_runtime.INTERNAL_ROW_ID_PREFIX}view_primitives:{index}" for index in range(6)
            ]
            assert [row["rowNumber"] for row in identified_page["rows"]] == list(range(6))
            page = engine.page(identified, 1, 2, column_projection=[(0, "text")])
            assert page["totalRows"] == 6 and [row["values"][0]["raw"] for row in page["rows"]] == ["abc", "abc"]
            assert [row["id"] for row in page["rows"]] == [
                f"r:{duckdb_runtime.INTERNAL_ROW_ID_PREFIX}view_primitives:{index}" for index in (1, 2)
            ]
            assert [row["rowNumber"] for row in page["rows"]] == [1, 2]
            summaries = {summary["column"]: summary for summary in engine.summaries(frame)}
            text = summaries["text"]
            assert (text["totalCount"], text["nullCount"], text["nanCount"], text["distinctCount"]) == (6, 2, 0, 3)
            assert text["text"] == {"emptyCount": 1, "minLength": 0, "maxLength": 3, "meanLength": 1.75}
            assert text["topValues"] == [
                {"value": "abc", "count": 2},
                {"value": "a", "count": 1},
                {"value": "", "count": 1},
            ]
            numeric = summaries["value"]
            assert (numeric["nullCount"], numeric["nanCount"], numeric["distinctCount"]) == (1, 1, 3)
            assert numeric["numeric"]["min"] == 1 and numeric["numeric"]["max"] == 5
            assert numeric["numeric"]["mean"] == 3 and numeric["numeric"]["median"] == 3
            assert numeric["numeric"]["std"] == pytest.approx((8 / 3) ** 0.5)
            assert [bin["count"] for bin in numeric["visualization"]["bins"]] == [1, 2, 1]
            assert summaries["finite"]["numeric"]["mean"] == pytest.approx(110 / 6)
            assert summaries["finite"]["numeric"]["median"] == 15
            assert summaries["flag"]["visualization"] == {"kind": "boolean", "trueCount": 2, "falseCount": 2}
            assert summaries["from_caller"]["numeric"]["exactSum"]["raw"] == 102
            assert engine.missing_count(frame, 1) == 2
            assert engine.header_stats(frame) == {
                "missingCells": 6,
                "missingRows": 3,
                "duplicateRows": 1,
                "missingValuesByColumn": [
                    {"column": name, "count": count}
                    for name, count in [("text", 2), ("value", 2), ("finite", 0), ("flag", 2), ("from_caller", 0)]
                ],
            }
            choices, more = engine.column_values(frame, "text", search="A", limit=1)
            assert more and [(choice["value"], choice["count"]) for choice in choices] == [("abc", 2)]
            assert source.project(receipt_query).fetchall() == before
            assert (source.sql_query(), source.columns, source.types) == source_identity
            engine.close()
            assert source.project(receipt_query).fetchall() == before
            assert connection.sql(catalog_query).fetchall() == catalog_before
            assert (
                connection.sql("SELECT current_setting('search_path'), current_setting('threads')").fetchall()
                == settings_before
            )
        finally:
            engine.close()


def test_duckdb_view_primitives_match_generated_filters_and_conditional_values() -> None:
    engine = DuckDBEngine()
    with duckdb_runtime._connect() as connection:
        try:
            for definition in (
                "isnan(x) AS TRUE",
                "contains(x, y) AS FALSE",
                "starts_with(x, y) AS FALSE",
                "ends_with(x, y) AS FALSE",
                "translate(x, upper_chars, lower_chars) AS 'caller'",
            ):
                connection.execute("CREATE MACRO " + definition)
            source = connection.sql(
                "SELECT * FROM (VALUES (0, 'ALPHA', 1.0::DOUBLE), (1, 'alphabet', 'NaN'::DOUBLE), "
                "(2, 'beta', NULL), (3, NULL, 3.0)) source(id, text, value)"
            )
            before = source.project("id, text, CAST(value AS VARCHAR)").fetchall()
            frame = engine.normalize_notebook_relation(source)
            filters = [
                (
                    {
                        "filters": [
                            {
                                "column": "text",
                                "type": "string",
                                "predicates": [
                                    {"operator": "contains", "value": "ph"},
                                    {"operator": "startsWith", "value": "AL"},
                                    {"operator": "endsWith", "value": "HA"},
                                ],
                            }
                        ],
                        "sort": [],
                    },
                    [0],
                ),
                (
                    {
                        "filters": [
                            {
                                "column": "value",
                                "type": "float",
                                "predicates": [],
                                "valueFilter": {
                                    "kind": "values",
                                    "selectedValues": [typed_selection_value(1.0, "float")],
                                    "includeNulls": False,
                                    "includeNaN": True,
                                },
                            }
                        ],
                        "sort": [],
                    },
                    [0, 1],
                ),
                (
                    {
                        "filters": [{"column": "value", "type": "float", "predicates": [{"operator": "isNotNaN"}]}],
                        "sort": [],
                    },
                    [0, 2, 3],
                ),
            ]
            for model, expected_ids in filters:
                view = engine.apply_filter_model(frame, model)
                bound = {
                    **model,
                    "filters": [
                        {
                            **rule,
                            "column": bound_ref(
                                f"c:source:{source.columns.index(rule['column'])}",
                                rule["column"],
                                source.columns.index(rule["column"]),
                            ),
                        }
                        for rule in model["filters"]
                    ],
                }
                operation = bound_step("filterRows", filterModel=bound)
                live = engine.apply_transform(frame, operation)
                generated = execute_generated(engine, source, [operation])
                assert engine._terminal_rows(view, "SELECT id FROM ow") == [(value,) for value in expected_ids]
                assert engine._terminal_rows(live, "SELECT id FROM ow") == [(value,) for value in expected_ids]
                assert generated.project("id").fetchall() == [(value,) for value in expected_ids]
            operation = bound_step(
                "conditionalColumn",
                column=bound_ref("c:source:2", "value", 2),
                columnType="float",
                predicate={"kind": "predicate", "operator": "gt", "value": "0"},
                newColumn="positive",
                resultType="boolean",
                trueValue=True,
                falseValue=False,
                missingValue=None,
            )
            live = engine.apply_transform(frame, operation)
            generated = execute_generated(engine, source, [operation])
            expected = [(0, True), (1, None), (2, None), (3, True)]
            assert engine._terminal_rows(live, "SELECT id, positive FROM ow") == expected
            assert generated.project("id, positive").fetchall() == expected
            fill = bound_step(
                "fillMissingValues",
                column=bound_ref("c:source:2", "value", 2),
                replacement={"kind": "float", "value": "9"},
            )
            live = engine.apply_transform(frame, fill)
            generated = execute_generated(engine, source, [fill])
            expected = [(0, 1.0), (1, 9.0), (2, 9.0), (3, 3.0)]
            assert engine._terminal_rows(live, "SELECT id, value FROM ow") == expected
            assert generated.project("id, value").fetchall() == expected
            assert source.project("id, text, CAST(value AS VARCHAR)").fetchall() == before
        finally:
            engine.close()


def test_duckdb_view_primitives_keep_live_and_generated_coordinate_refusal() -> None:
    engine = DuckDBEngine()
    operation = bound_step(
        "fillMissingValues",
        column=bound_ref("c:source:1", "value", 1),
        replacement={"kind": "linearInterpolation", "coordinate": bound_ref("c:source:0", "coordinate", 0)},
    )
    with duckdb_runtime._connect() as connection:
        try:
            connection.execute("CREATE MACRO isfinite(x) AS TRUE")
            source = connection.sql(
                "SELECT * FROM (VALUES (0.0::DOUBLE, 0.0::DOUBLE), ('Infinity'::DOUBLE, NULL), "
                "(2.0, 4.0)) source(coordinate, value)"
            )
            before = source.fetchall()
            with pytest.raises(EngineError, match="every coordinate value to be present and finite"):
                engine.apply_transform(engine.normalize_notebook_relation(source), operation)
            with pytest.raises(ValueError, match="every coordinate value to be present and finite"):
                execute_generated(engine, source, [operation])
            assert source.fetchall() == before
            connection.execute("CREATE OR REPLACE MACRO isfinite(x) AS FALSE")
            source = connection.sql(
                "SELECT * FROM (VALUES (0.0::DOUBLE, 0.0::DOUBLE), (1.0, NULL), (2.0, 4.0)) source(coordinate, value)"
            )
            before = source.fetchall()
            live = engine.apply_transform(engine.normalize_notebook_relation(source), operation)
            generated = execute_generated(engine, source, [operation])
            expected = [(0.0, 0.0), (1.0, 2.0), (2.0, 4.0)]
            assert engine._terminal_rows(live, "SELECT * FROM ow") == expected
            assert generated.fetchall() == expected
            assert source.fetchall() == before
        finally:
            engine.close()


@pytest.mark.parametrize("label", ["integer", "decimal", "bool", "array", "struct", "datetime", "plain"])
def test_duckdb_enum_labels_do_not_change_profiles_or_typed_filters(label: str) -> None:
    engine = DuckDBEngine()
    source = duckdb.sql(
        f"SELECT value::ENUM('{label}', 'other') AS value FROM (VALUES ('{label}'), ('other'), (NULL)) source(value)"
    )
    before = source.fetchall()
    try:
        assert engine.schema(source)[0]["type"] == "string"
        summary = engine.summaries(source)[0]
        assert summary["type"] == "string"
        assert summary["nullCount"] == 1
        values, truncated = engine.column_values(source, "value")
        selected = next(item["selectionValue"] for item in values if item["value"] == label)
        assert not truncated
        assert selected == typed_selection_value(label, "string")
        column_filter = {
            "column": "value",
            "type": "string",
            "predicates": [],
            "valueFilter": {"kind": "values", "selectedValues": [selected], "includeNulls": False, "includeNaN": False},
        }
        filtered = engine.apply_filter_model(source, {"filters": [column_filter], "sort": []})
        assert engine._terminal_rows(filtered, "SELECT * FROM ow") == [(label,)]
        schema = engine.schema(source)
        lineage = source_lineage(schema)
        operation = bind_step(
            step(
                "filterRows",
                filterModel={
                    "filters": [{**column_filter, "column": lineage[0]}],
                    "sort": [],
                },
            ),
            schema,
            lineage,
        )
        assert execute_generated(engine, source, [operation]).fetchall() == [(label,)]
        assert source.fetchall() == before
    finally:
        engine.close()


@pytest.mark.parametrize("dtype", ["INTEGER[2]", "INTEGER[]"])
def test_duckdb_fixed_and_variable_arrays_retain_container_profiles_and_sort_restriction(dtype: str) -> None:
    engine = DuckDBEngine()
    source = duckdb.sql(f"SELECT value::{dtype} AS value FROM (VALUES ([1,2]), (NULL)) source(value)")
    before = source.fetchall()
    try:
        assert engine.schema(source)[0]["type"] == "list"
        summary = engine.summaries(source)[0]
        assert summary["type"] == "list"
        assert summary["nullCount"] == 1
        with pytest.raises(EngineError, match="sorting is unavailable for list columns"):
            engine.apply_filter_model(source, {"filters": [], "sort": [{"column": "value", "direction": "asc"}]})
        assert source.fetchall() == before
    finally:
        engine.close()


def test_duckdb_type_owner_keeps_existing_binary_and_unknown_boundaries() -> None:
    assert duckdb_runtime._semantic_type("BIT") == "binary"
    assert duckdb_runtime._semantic_type("VARINT") == "unknown"
    assert duckdb_runtime._semantic_type("TIME") == "unknown"


@pytest.mark.parametrize(
    "query,expected",
    [
        (
            "SELECT value::ENUM('integer','other') AS value FROM (VALUES ('integer'),('other'),(NULL)) t(value)",
            [None] * 3,
        ),
        ("SELECT value::INTEGER[2] AS value FROM (VALUES ([1,2]),(NULL)) t(value)", [None] * 2),
        ("SELECT value::INTEGER[] AS value FROM (VALUES ([1,2]),(NULL)) t(value)", [None] * 2),
        ("SELECT value::BIGINT AS value FROM (VALUES (1),(3),(NULL)) t(value)", [0.0, 1.0, None]),
    ],
)
def test_duckdb_min_max_generated_scalar_classification_matches_live(query: str, expected: list[float | None]) -> None:
    engine = DuckDBEngine()
    source = duckdb.sql(query)
    before = source.fetchall()
    try:
        schema = engine.schema(source)
        lineage = source_lineage(schema)
        operation = bind_step(step("minMaxScale", column=lineage[0], newColumn="scaled"), schema, lineage)
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])
        assert engine._terminal_rows(live, "SELECT * FROM ow") == [
            (*row, value) for row, value in zip(before, expected, strict=True)
        ]
        assert generated.fetchall() == [(*row, value) for row, value in zip(before, expected, strict=True)]
        assert source.fetchall() == before
    finally:
        engine.close()


def reserve_export_target(path: Path) -> dict[str, str]:
    path.touch(exist_ok=False)
    device, inode = _regular_file_identity(path)
    return {"device": str(device), "inode": str(inode)}


def rows(frame: Any) -> list[tuple[Any, ...]]:
    if not isinstance(frame, DuckDBSqlPlan):
        return list(frame.fetchall())
    engine = DuckDBEngine()
    try:
        return engine._terminal_rows(frame, "SELECT * FROM ow")
    finally:
        engine.close()


def records(frame: Any) -> list[dict[str, Any]]:
    return [dict(zip(frame.columns, row, strict=True)) for row in rows(frame)]


def assert_same_relation(left: Any, right: Any) -> None:
    assert list(left.columns) == list(right.columns)
    left_rows = rows(left)
    right_rows = rows(right)
    assert len(left_rows) == len(right_rows)
    for left_row, right_row in zip(left_rows, right_rows, strict=True):
        assert len(left_row) == len(right_row)
        for left_value, right_value in zip(left_row, right_row, strict=True):
            if isinstance(left_value, float) and isnan(left_value):
                assert isinstance(right_value, float) and isnan(right_value)
            else:
                assert left_value == right_value


def reference_header_stats(engine: DuckDBEngine, frame: Any) -> dict[str, Any]:
    """Preserve the former two-query dataset-statistics semantics for comparison."""

    plan = engine.normalize(frame)
    visible = engine._visible_columns(plan)
    types = dict(zip(engine._columns(plan), (str(item) for item in plan.types), strict=True))
    missing_expressions = [
        f"({duckdb_runtime._quote_ident(column)} IS NULL OR "
        f"{duckdb_runtime._nan_predicate(duckdb_runtime._quote_ident(column), types[column])})"
        for column in visible
    ]
    projections = ", ".join(f"count(*) FILTER (WHERE {expression})" for expression in missing_expressions)
    missing_row_expression = " OR ".join(missing_expressions)
    group_columns = ", ".join(duckdb_runtime._quote_ident(column) for column in visible)
    with engine._terminal_connection(plan) as (connection, source_sql):
        counts = duckdb_runtime._execute_rows(
            connection,
            source_sql,
            f"SELECT {projections}, count(*) FILTER (WHERE {missing_row_expression}) FROM ow",
        )[0]
        duplicate_rows = int(
            duckdb_runtime._execute_scalar(
                connection,
                source_sql,
                "SELECT coalesce(sum(group_count - 1), 0) FROM "
                f"(SELECT count(*) AS group_count FROM ow GROUP BY {group_columns}) AS groups",
            )
            or 0
        )
    per_column = [int(value or 0) for value in counts[:-1]]
    return {
        "missingCells": sum(per_column),
        "missingRows": int(counts[-1] or 0),
        "duplicateRows": duplicate_rows,
        "missingValuesByColumn": [
            {"column": column, "count": count} for column, count in zip(visible, per_column, strict=True)
        ],
    }


def execute_generated(engine: DuckDBEngine, frame: Any, plan: list[dict[str, Any]], *, connection: Any = None) -> Any:
    code = engine.compile_plan(plan)
    assert "openwrangler_runtime" not in code
    namespace: dict[str, Any] = {}
    exec(compile(code, "<generated-duckdb-plan>", "exec", dont_inherit=True), namespace, namespace)
    # Most native fixtures above use the explicit module-default source owner.
    # Private-connection fixtures pass their owner through this helper.
    options = (
        {"connection": connection if connection is not None else duckdb.default_connection()}
        if any(operation["kind"] == "customCode" for operation in plan)
        else {}
    )
    result = namespace["clean_data"](frame, **options)
    assert isinstance(result, duckdb.DuckDBPyRelation)
    return result


def export_generated_native(engine: DataFrameEngine, frame: Any, connection: Any, writer: Any, options: Any) -> None:
    owner = duckdb_runtime._DuckDBNotebookRelationOwner(frame, connection)
    try:
        plan = DuckDBNotebookPlan(
            owner, f'SELECT * FROM "{owner.alias}"', tuple(frame.columns), tuple(map(str, frame.types))
        )
        engine.export_data(plan, writer, options)
    finally:
        owner.close()


def test_duckdb_parquet_sorted_views_keep_source_tie_order_and_unordered_aggregates(tmp_path: Path) -> None:
    pa = pytest.importorskip("pyarrow")
    pq = pytest.importorskip("pyarrow.parquet")
    keys = ["b", "a", None, "a", "b", "a"] * 20
    path = tmp_path / "ties.parquet"
    pq.write_table(pa.table({"key": keys, "value": list(range(len(keys)))}), path, row_group_size=7)
    engine = DuckDBEngine()
    try:
        source = engine.ensure_row_ids(engine.read_file(str(path)), "source")
        assert source.row_id_order
        value_filter = {
            "column": "value",
            "type": "integer",
            "predicates": [{"kind": "predicate", "operator": "gt", "value": 10}],
        }
        model = {"filters": [value_filter], "sort": [{"column": "key", "direction": "desc", "nulls": "first"}]}
        view = engine.filter_view(source, model)
        page = engine.page(view, 0, len(keys))
        rank = {None: 0, "b": 1, "a": 2}
        expected = sorted((value for value in range(len(keys)) if value > 10), key=lambda value: rank[keys[value]])
        assert [row["values"][1]["raw"] for row in page["rows"]] == expected
        assert engine.page(engine.filter_view(replace(source, row_id_order=False), model), 0, len(keys)) == page

        unsorted = engine.filter_view(source, {**model, "sort": []})
        assert engine.shape(view) == engine.shape(unsorted)
        expected_summaries = engine.summaries(unsorted)
        for summary in expected_summaries:
            if "std" in summary.get("numeric", {}):
                # Parallel variance may round its last bit differently under another plan.
                summary["numeric"]["std"] = pytest.approx(summary["numeric"]["std"], rel=1e-12)
        assert engine.summaries(view) == expected_summaries
        assert engine.header_stats(view) == engine.header_stats(unsorted)
        assert engine.missing_count(view, 0) == engine.missing_count(unsorted, 0) == 18
        assert engine.column_values(view, "key") == engine.column_values(unsorted, "key")

        named = tmp_path / "named-ordinal.parquet"
        pq.write_table(pa.table({"file_row_number": [7, 8], "value": [1, 2]}), named)
        frame = engine.ensure_row_ids(engine.read_file(str(named)), "named")
        assert [column["name"] for column in engine.schema(frame)] == ["file_row_number", "value"]
        assert [row["values"][0]["raw"] for row in engine.page(frame, 0, 2)["rows"]] == [7, 8]
    finally:
        engine.close()


def test_duckdb_custom_checkpoint_retains_rows_and_stored_ids(tmp_path: Path) -> None:
    path = tmp_path / "capture.csv"
    path.write_text("id\n0\n1\n2\n3\n", encoding="utf-8")
    before = path.read_bytes()
    engine = DuckDBEngine()
    try:
        source = engine.ensure_row_ids(engine.read_file(str(path)), "source")
        captured = engine.apply_transform(
            source,
            step(
                "customCode",
                code="df.query('__custom_input', 'BEGIN')\n"
                "df.query('__custom_input', \"SET default_null_order='NULLS_FIRST'\")\n"
                "result = df.project('id, uuid() AS token, id % 2 AS tie').order('random()')",
            ),
        )
        engine.validate_internal_row_id_namespace(captured)
        frame = engine.ensure_row_ids(captured, "captured")
        original = engine.page(frame, 0, 4)
        assert engine.page(frame, 0, 4) == original
        assert engine.page(frame, 0, 2)["rows"] + engine.page(frame, 2, 2)["rows"] == original["rows"]
        clone = engine.apply_transform(
            frame, bound_step("cloneColumn", column=bound_ref("c:1", "token", 1), newName="copy")
        )
        assert engine._terminal_scalar(clone, "SELECT bool_and(token = copy) FROM ow") is True
        assert [row["id"] for row in engine.page(clone, 0, 4)["rows"]] == [row["id"] for row in original["rows"]]
        with duckdb_runtime._connect() as connection:
            assert (
                engine._terminal_scalar(clone, "SELECT current_setting('default_null_order') FROM ow LIMIT 1")
                == (connection.sql("SELECT current_setting('default_null_order')").fetchone()[0])
            )
        second = engine.apply_transform(clone, step("customCode", code="result = df.project('*, uuid() AS second')"))
        second = engine.ensure_row_ids(second, "second")
        second_clone = engine.apply_transform(
            second, bound_step("cloneColumn", column=bound_ref("c:4", "second", 4), newName="second_copy")
        )
        ordered = engine.apply_filter_model(
            second_clone,
            {"logic": "and", "filters": [], "sort": [{"column": "id", "direction": "desc", "nulls": "last"}]},
        )
        ordered_page = engine.page(ordered, 0, 4)
        assert [row["values"][0]["display"] for row in ordered_page["rows"]] == ["3", "2", "1", "0"]
        assert engine.page(ordered, 0, 4) == ordered_page
        assert engine._terminal_scalar(ordered, "SELECT bool_and(token = copy) FROM ow") is True
        assert engine._terminal_scalar(ordered, "SELECT bool_and(second = second_copy) FROM ow") is True
        captured_rows = engine.page(second_clone, 0, 4)["rows"]
        expected = sorted(
            (row for row in captured_rows if row["values"][0]["raw"] >= 1),
            key=lambda row: row["values"][2]["raw"],
        )
        filtered = engine.apply_filter_model(
            second_clone,
            {
                "filters": [
                    {
                        "column": "id",
                        "type": "integer",
                        "predicates": [{"kind": "predicate", "operator": "gte", "value": 1}],
                    }
                ],
                "sort": [{"column": "tie", "direction": "asc", "nulls": "last"}],
            },
        )
        filtered_rows = [row for offset in (0, 2) for row in engine.page(filtered, offset, 2)["rows"]]
        assert {row["values"][0]["raw"] for row in filtered_rows} == {1, 2, 3}
        assert filtered_rows == [{**row, "rowNumber": index} for index, row in enumerate(expected)]
        copied = [
            row for offset in (0, 2) for row in engine.page(filtered, offset, 2, column_projection=[(1, "c:1")])["rows"]
        ]
        assert copied == [{**row, "values": [row["values"][1]]} for row in filtered_rows]
        checkpoint = captured.checkpoint
        assert checkpoint is not None
        stored_path = Path(checkpoint.temporary.name)
        owner_ref = weakref.ref(checkpoint)
        del checkpoint, captured, frame
        gc.collect()
        assert stored_path.exists() and owner_ref() is not None
        del clone
        gc.collect()
        assert owner_ref() is None and not stored_path.exists()
        assert second.checkpoint is not None
        second_path = Path(second.checkpoint.temporary.name)
        engine.close()
        assert not second_path.exists()
        assert path.read_bytes() == before
    finally:
        engine.close()


def test_duckdb_generated_custom_captures_once_on_explicit_connection() -> None:
    engine = DuckDBEngine()
    visits: list[int] = []
    with duckdb.connect(config={"python_enable_replacements": False}) as connection:

        def observed(value: int) -> int:
            visits.append(value)
            return value

        connection.create_function("capture_observed", observed, [BIGINT], BIGINT, side_effects=True)
        source = connection.sql("SELECT i AS id FROM range(4) input(i)")
        plan = [step("customCode", code="result = df.project('capture_observed(id) AS id, uuid() AS token')")]
        namespace: dict[str, Any] = {}
        exec(engine.compile_plan(plan), namespace)
        try:
            result = namespace["clean_data"](source, connection=connection)
            assert visits == [0, 1, 2, 3]
            first = result.fetchall()
            assert result.fetchall() == first and visits == [0, 1, 2, 3]
            assert connection.sql("SELECT view_name FROM duckdb_views() WHERE NOT internal").fetchall() == []
            assert source.fetchall() == [(0,), (1,), (2,), (3,)]
        finally:
            engine.close()


def test_duckdb_notebook_capture_owns_rows_not_caller_connection() -> None:
    engine = DuckDBEngine()
    clone_engine = DuckDBEngine()
    with duckdb.connect() as connection:
        source = connection.sql("SELECT i AS id, uuid() AS token FROM range(4) input(i) ORDER BY random()")
        try:
            frame = engine.capture_notebook_source(
                engine.normalize_notebook_relation(source), connection, row_id_token="notebook:source"
            )
            first = engine.page(frame, 0, 4)
            assert engine.page(frame, 0, 2)["rows"] + engine.page(frame, 2, 2)["rows"] == first["rows"]
            assert engine.page(frame, 0, 4) == first
            assert connection.sql("SELECT view_name FROM duckdb_views() WHERE NOT internal").fetchall() == []
            cloned = clone_engine.clone_session_source(frame)
            assert cloned.owner is not frame.owner
        finally:
            engine.close()
        try:
            assert clone_engine.page(cloned, 0, 4) == first
        finally:
            clone_engine.close()
        assert connection.sql("SELECT 17").fetchone() == (17,)


@pytest.mark.parametrize("owner", ["file", "generated", "notebook"])
def test_duckdb_native_capture_preserves_difficult_types(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, owner: str
) -> None:
    install_conversion_guards(monkeypatch)
    projection = """id,
        CASE WHEN id%2=0 THEN '-170141183460469231731687303715884105728'::HUGEINT
             ELSE '170141183460469231731687303715884105727'::HUGEINT END AS signed,
        '340282366920938463463374607431768211455'::UHUGEINT AS unsigned,
        '12345678901234567890123456789.123456789'::DECIMAL(38,9) AS amount,
        INTERVAL '1 month 2 days 3 microseconds' AS span,
        '12:34:56.123456+05:30'::TIMETZ AS clock,
        '\\x00\\xFF'::BLOB AS payload,
        MAP(['12:00:00+02'::TIMETZ, '10:00:00+00'::TIMETZ], ['a', 'b']) AS clocks,
        CASE WHEN id%2=0 THEN union_value(a := 'same')::UNION(a VARCHAR, b VARCHAR)
             ELSE union_value(b := 'same')::UNION(a VARCHAR, b VARCHAR) END AS choice,
        struct_pack(span := INTERVAL '-3 microseconds',
                    choice := CASE WHEN id%2=0 THEN union_value(a := 'same')::UNION(a VARCHAR, b VARCHAR)
                              ELSE union_value(b := 'same')::UNION(a VARCHAR, b VARCHAR) END) AS nested,
        '2024-01-02 03:04:05.123456789'::TIMESTAMP_NS AS stamp,
        uuid() AS token"""
    predicate = """signed = CASE WHEN id%2=0 THEN '-170141183460469231731687303715884105728'::HUGEINT
             ELSE '170141183460469231731687303715884105727'::HUGEINT END
        AND unsigned = '340282366920938463463374607431768211455'::UHUGEINT
        AND amount = '12345678901234567890123456789.123456789'::DECIMAL(38,9)
        AND date_part('month', span)=1 AND date_part('day', span)=2 AND date_part('microseconds', span)=3
        AND clock::VARCHAR='12:34:56.123456+05:30' AND hex(payload)='00FF'
        AND map_extract_value(clocks, '12:00:00+02'::TIMETZ)='a'
        AND map_extract_value(clocks, '10:00:00+00'::TIMETZ)='b'
        AND union_tag(choice)::VARCHAR=CASE WHEN id%2=0 THEN 'a' ELSE 'b' END
        AND union_tag(nested.choice)::VARCHAR=CASE WHEN id%2=0 THEN 'a' ELSE 'b' END
        AND date_part('microseconds', nested.span)=-3
        AND epoch_ns(stamp)=1704164645123456789"""
    engine = DuckDBEngine()
    path = tmp_path / "native.csv"
    path.write_text("id\n0\n1\n2\n3\n", encoding="utf-8")
    original = path.read_bytes()
    with duckdb.connect() as connection:
        source = connection.sql("SELECT i AS id FROM range(4) input(i)")
        expected_types = tuple(map(str, source.project(projection).types))
        try:
            if owner == "file":
                frame = engine.apply_transform(
                    engine.read_file(str(path)), step("customCode", code=f"result = df.project({projection!r})")
                )
            elif owner == "notebook":
                frame = engine.capture_notebook_source(
                    engine.normalize_notebook_relation(source.project(projection)), connection, row_id_token="native"
                )
            else:
                result = execute_generated(
                    engine,
                    source,
                    [step("customCode", code=f"result = df.project({projection!r})")],
                    connection=connection,
                )
                assert tuple(map(str, result.types)) == expected_types
                assert result.aggregate(f"count(*), bool_and({predicate})").fetchone() == (4, True)
                tokens = result.project("id, token").fetchall()
                assert result.project("id, token").fetchall() == tokens
                return
            assert tuple(column["rawType"] for column in engine.schema(frame)) == expected_types
            assert engine._terminal_rows(frame, f"SELECT count(*), bool_and({predicate}) FROM ow") == [(4, True)]
            tokens = engine._terminal_rows(frame, "SELECT id, token FROM ow")
            assert engine._terminal_rows(frame, "SELECT id, token FROM ow") == tokens
        finally:
            engine.close()
            assert path.read_bytes() == original
            assert source.fetchall() == [(0,), (1,), (2,), (3,)]


def test_duckdb_capture_refusal_preserves_affinity_and_caller_rollback() -> None:
    engine = DuckDBEngine()
    with duckdb.connect() as connection, duckdb.connect() as wrong:
        connection.execute("CREATE TABLE capture_source AS SELECT 1 AS value UNION ALL SELECT 129")
        source = connection.table("capture_source")
        operation = step("customCode", code="result = df.project('CAST(value AS TINYINT) AS value')")
        namespace: dict[str, Any] = {}
        exec(engine.compile_plan([operation]), namespace)
        wrong.execute("CREATE TABLE marker AS SELECT 1 AS value")
        wrong.execute("BEGIN")
        wrong.execute("UPDATE marker SET value=2")
        try:
            with pytest.raises(ValueError, match="supplied connection"):
                namespace["clean_data"](source, connection=wrong)
            assert wrong.sql("SELECT value FROM marker").fetchone() == (2,)
            wrong.execute("ROLLBACK")
            assert wrong.sql("SELECT value FROM marker").fetchone() == (1,)
            connection.execute("BEGIN")
            connection.execute("UPDATE capture_source SET value=2 WHERE value=1")
            with pytest.raises(duckdb.ConversionException, match="129"):
                namespace["clean_data"](source, connection=connection)
            # A native evaluation error may abort the caller transaction. Only
            # the caller rolls it back; Open Wrangler must not commit or recover it.
            connection.execute("ROLLBACK")
            assert source.fetchall() == [(1,), (129,)]
            assert connection.sql("SELECT view_name FROM duckdb_views() WHERE NOT internal").fetchall() == []
            for code, message in (
                ("result = duckdb.sql('SELECT 23 AS value')", "supplied connection"),
                ("result = df.project('value AS __Open_Wrangler_Internal_Row_Id_forged')", "reserved"),
            ):
                program: dict[str, Any] = {}
                exec(engine.compile_plan([step("customCode", code=code)]), program)
                with pytest.raises(ValueError, match=message):
                    program["clean_data"](source, connection=connection)
                with pytest.raises(EngineError, match=message):
                    engine.apply_transform(
                        source_relation(), step("customCode", code=code.replace("value AS", "other AS"))
                    )
                assert connection.sql("SELECT view_name FROM duckdb_views() WHERE NOT internal").fetchall() == []
        finally:
            engine.close()


def test_duckdb_failed_checkpoint_rebind_removes_owned_storage(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "failed-capture.csv"
    path.write_text("value\n1\n2\n", encoding="utf-8")
    before = path.read_bytes()
    engine = DuckDBEngine()
    frame = engine.read_file(str(path))
    native_rebind = engine._relation_from_sql
    owned_paths: list[Path] = []

    def fail_checkpoint(sql: str, *, checkpoint: Any = None, ordinal_sql: str | None = None) -> Any:
        if checkpoint is not None:
            owned_paths.append(Path(checkpoint.temporary.name))
            raise EngineError("owned checkpoint reader failure")
        return native_rebind(sql, checkpoint=checkpoint, ordinal_sql=ordinal_sql)

    monkeypatch.setattr(engine, "_relation_from_sql", fail_checkpoint)
    try:
        with pytest.raises(EngineError, match="owned checkpoint reader failure"):
            engine.apply_transform(frame, step("customCode", code="result = df.project('value + 1 AS value')"))
        assert len(owned_paths) == 1 and not owned_paths[0].exists()
        assert not list(engine._checkpoints)
        assert engine._terminal_rows(frame, "SELECT * FROM ow") == [(1,), (2,)]
        assert path.read_bytes() == before
    finally:
        engine.close()


@pytest.mark.parametrize(
    ("input_format", "output_format", "values", "expected", "refuses"),
    [
        ("%d %B %Y", "%Y-%m-%d", ["02 marzo 2026", "03 ottobre 2027"], ["2026-03-02", "2027-10-03"], True),
        ("%Y-%m-%d", "%d %B %Y", ["2026-03-02", "2027-10-03"], ["02 marzo 2026", "03 ottobre 2027"], True),
        ("%b %d, %Y", "%Y-%m-%d", ["mar 02, 2026", "ott 03, 2027"], ["2026-03-02", "2027-10-03"], True),
        ("%Y-%m-%d", "%b %d, %Y", ["2026-03-02", "2027-10-03"], ["mar 02, 2026", "ott 03, 2027"], True),
        ("%Y-%m-%d", "%d %B %Y", [None] * 63 + ["2028-12-04"], [None] * 63 + ["04 dicembre 2028"], True),
        (
            "%d %B %Y",
            "%b %d, %Y",
            ["02 March 2026", "03 October 2027", None],
            ["Mar 02, 2026", "Oct 03, 2027", None],
            False,
        ),
        ("%Y-%m-%d", "%d/%m/%Y", ["2026-03-02", "2027-10-03", None], ["02/03/2026", "03/10/2027", None], False),
        (None, None, ["alpha", "beta", None], ["ALPHA", "BETA", None], False),
    ],
    ids=[
        "input-full",
        "output-full",
        "input-short",
        "output-short",
        "last-example",
        "english-null",
        "numeric-null",
        "case-null",
    ],
)
def test_duckdb_by_example_checks_native_month_name_examples(
    monkeypatch: pytest.MonkeyPatch,
    input_format: str | None,
    output_format: str | None,
    values: list[str | None],
    expected: list[str | None],
    refuses: bool,
) -> None:
    engine = DuckDBEngine()
    name = 'when "O\'Brien"'
    literals = ["NULL::VARCHAR" if value is None else "'" + value.replace("'", "''") + "'" for value in values]
    rows = ", ".join(f"({index}, 'ignored', {value})" for index, value in enumerate(literals))
    with duckdb.connect(":memory:") as connection:
        source = connection.sql(f'SELECT * FROM (VALUES {rows}) AS source(padding, kept, "when ""O\'Brien""")')
        before = source.fetchall()
        identity = (source.sql_query(), source.columns, source.types)
        try:
            schema = engine.schema(source)
            lineage = source_lineage(schema)
            assert lineage[2]["name"] == name
            column = {"kind": "column", "column": lineage[2]}
            program = (
                {"kind": "datetimeFormat", "input": column, "inputFormat": input_format, "outputFormat": output_format}
                if input_format is not None
                else {"kind": "case", "input": column, "style": "upper"}
            )
            # Captured normalized programs avoid requiring an Italian CI locale;
            # neither the native parser nor formatter is mocked.
            operation = bind_step(
                bound_step(
                    "byExample",
                    sourceColumns=[lineage[1], lineage[2]],
                    newColumn="result",
                    examples=[
                        {"inputs": ["ignored", value], "output": output}
                        for value, output in zip(values, expected, strict=True)
                    ],
                    program=program,
                ),
                schema,
                lineage,
            )
            if refuses:
                message = r"^DuckDB cannot reproduce these date examples\. Use numeric month values or Custom Code\.$"
                with pytest.raises(EngineError, match=message):
                    engine.apply_transform(source, operation)
                with pytest.raises(EngineError, match=message):
                    engine.compile_plan([operation])
            else:
                if input_format is None or output_format == "%d/%m/%Y":

                    def unexpected_connection() -> Any:
                        raise AssertionError(
                            "Numeric-date and nondate compilation must not acquire a native connection"
                        )

                    with monkeypatch.context() as context:
                        context.setattr(duckdb_runtime, "_connect", unexpected_connection)
                        code = engine.compile_plan([operation])
                else:
                    code = engine.compile_plan([operation])
                live = engine.apply_transform(source, operation)
                namespace: dict[str, Any] = {}
                exec(code, namespace, namespace)
                generated = namespace["clean_data"](source)
                wanted = [(*row, value) for row, value in zip(before, expected, strict=True)]
                assert engine._terminal_rows(live, "SELECT * FROM ow") == generated.fetchall() == wanted
                assert generated.columns == live.columns == [*source.columns, "result"]
                assert str(generated.types[-1]) == str(live.types[-1]) == "VARCHAR"
            assert source.fetchall() == before
            assert (source.sql_query(), source.columns, source.types) == identity
            if not refuses and input_format == "%d %B %Y":
                engine.close()
                with pytest.raises(EngineError, match="The DuckDB engine is closed"):
                    engine.compile_plan([operation])
        finally:
            engine.close()


@pytest.mark.parametrize(
    "failure_type", [duckdb.InterruptException, duckdb.ConnectionException, duckdb.InvalidInputException]
)
def test_duckdb_date_example_query_keeps_lifecycle_errors_and_hides_example_values(
    monkeypatch: pytest.MonkeyPatch, failure_type: type[Exception]
) -> None:
    column = bound_ref("c:source:0", "value", 0)
    inputs = ["2026-03-02", "2027-10-03"]
    operation = bound_step(
        "byExample",
        sourceColumns=[column],
        newColumn="result",
        examples=[
            {"inputs": [value], "output": output}
            for value, output in zip(inputs, ["02 March 2026", "03 October 2027"], strict=True)
        ],
        program={
            "kind": "datetimeFormat",
            "input": {"kind": "column", "column": column},
            "inputFormat": "%Y-%m-%d",
            "outputFormat": "%d %B %Y",
        },
    )
    failure = failure_type("synthetic private example")

    class FailedQuery:
        closed = False

        def execute(self, query: str, parameters: list[Any]) -> Any:
            assert parameters == inputs and all(value not in query for value in inputs)
            raise failure

        def close(self) -> None:
            self.closed = True

    connection = FailedQuery()
    monkeypatch.setattr(duckdb_runtime, "_connect", lambda: connection)
    engine = DuckDBEngine()
    try:
        with pytest.raises(EngineError if failure_type is duckdb.InvalidInputException else failure_type) as raised:
            engine.compile_plan([operation])
        if failure_type is duckdb.InvalidInputException:
            assert (
                str(raised.value)
                == "DuckDB cannot reproduce these date examples. Use numeric month values or Custom Code."
            )
            assert raised.value.__suppress_context__
        else:
            assert raised.value is failure
        assert connection.closed and not engine._active_connections
    finally:
        engine.close()


@pytest.mark.parametrize(
    ("operator", "left", "right", "exact", "refuse", "left_type", "right_type"),
    [
        ("add", 2**100 + 1, 1, 2**100 + 2, True, "HUGEINT", "UHUGEINT"),
        ("subtract", 2**100 + 1, 2**100, 1, True, "HUGEINT", "UHUGEINT"),
        ("multiply", -1, 2**100 + 1, -(2**100 + 1), True, "HUGEINT", "UHUGEINT"),
        ("modulo", 2**100 + 1, 2, 1, True, "HUGEINT", "UHUGEINT"),
        ("add", 2**100 + 1, 2**100 - 1, 2**101, False, "HUGEINT", "UHUGEINT"),
        ("subtract", 2**100 + 1, 2**100 + 1, 0, False, "HUGEINT", "UHUGEINT"),
        ("multiply", 3 * 2**100, 5 * 2**100, 15 * 2**200, False, "HUGEINT", "UHUGEINT"),
        ("add", -(2**127), 2**127, 0, False, "HUGEINT", "UHUGEINT"),
        ("modulo", -7, 2, -1, False, "HUGEINT", "UHUGEINT"),
        ("modulo", -(2**127), 0, None, False, "HUGEINT", "UHUGEINT"),
        ("multiply", -1, 0, 0, False, "HUGEINT", "UHUGEINT"),
        ("add", 2**100 + 1, 1, 2**100 + 2, True, "UHUGEINT", "HUGEINT"),
        ("subtract", 2**100 + 1, 2**100, 1, True, "UHUGEINT", "HUGEINT"),
        ("multiply", 2**100 + 1, -1, -(2**100 + 1), True, "UHUGEINT", "HUGEINT"),
        ("modulo", 2**100 + 1, -2, 1, True, "UHUGEINT", "HUGEINT"),
        ("modulo", 2, 2**100 + 1, 2, False, "UHUGEINT", "HUGEINT"),
        ("modulo", 2**127, -(2**127), 0, False, "UHUGEINT", "HUGEINT"),
        ("multiply", 2**100 + 1, 1, 2**100 + 1, True, "BIGNUM", "BIGINT"),
        ("multiply", 1, 2**100 + 1, 2**100 + 1, True, "UHUGEINT", "BIGNUM"),
        ("modulo", 2**100 + 1, 2, 1, True, "BIGNUM", "UHUGEINT"),
        ("modulo", 2**100, 2**100 + 1, 2**100, True, "UHUGEINT", "BIGNUM"),
        ("multiply", -(2**127), 1, -(2**127), False, "BIGNUM", "UHUGEINT"),
        ("modulo", 2**127 - 1, 3, 1, True, "BIGNUM", "UHUGEINT"),
        ("modulo", 2**127, -(2**127), 0, False, "UHUGEINT", "BIGNUM"),
        ("modulo", -(2**100 + 3), 3, -1, False, "BIGNUM", "BIGNUM"),
        ("multiply", 2**127, 1, 2**127, "outside the signed 128-bit", "BIGNUM", "BIGINT"),
        ("multiply", -(2**128), 1, -(2**128), "outside the signed 128-bit", "BIGNUM", "BIGINT"),
        ("multiply", 2**200, 2**100, 2**300, "outside the signed 128-bit", "BIGNUM", "BIGNUM"),
        ("modulo", 2**200 + 3, 3, 1, "outside the signed 128-bit", "BIGNUM", "BIGINT"),
        ("modulo", 7, 2**200 + 1, 7, "outside the signed 128-bit", "UHUGEINT", "BIGNUM"),
        ("multiply", 2**200 + 1, 0, 0, False, "BIGNUM", "UHUGEINT"),
        ("multiply", 0, 2**200 + 1, 0, False, "UHUGEINT", "BIGNUM"),
        ("modulo", 2**200 + 1, -1, 0, False, "BIGNUM", "BIGNUM"),
        ("modulo", 2**200 + 1, 0, None, False, "BIGNUM", "BIGNUM"),
    ],
)
def test_duckdb_integer_formula_checks_selected_results_without_changing_native_values(
    operator: str, left: int, right: int, exact: int | None, refuse: bool | str, left_type: str, right_type: str
) -> None:
    engine = DuckDBEngine()
    symbol = {"add": "+", "subtract": "-", "multiply": "*", "modulo": "%"}[operator]
    with duckdb.connect() as connection:
        frame = connection.sql(
            'SELECT pos AS ow, lhs AS "left""value", rhs, 17 AS actual FROM '
            f"(VALUES (0, '{left}'::{left_type}, '{right}'::{right_type}), "
            f"(1, '{left}'::{left_type}, '{right}'::{right_type}), "
            f"(2, NULL::{left_type}, '{right}'::{right_type}), "
            f"(3, '{left}'::{left_type}, NULL::{right_type})) source(pos, lhs, rhs)"
        )
        assert list(map(str, frame.types[1:3])) == [left_type, right_type]
        original = frame.fetchall()
        native = frame.project(f'*, ("left""value" {symbol} rhs) AS result')
        native_rows = native.fetchall()
        assert native.types[-1] == DOUBLE
        if exact is not None:
            # Range refusals deliberately include currently exact native results.
            assert (Fraction(native_rows[0][-1]) != exact) is (refuse is True)
        operation = bound_step(
            "formula",
            leftColumn=bound_ref("c:source:1", 'left"value', 1),
            rightColumn=bound_ref("c:source:2", "rhs", 2),
            operator=operator,
            newColumn="result",
        )
        try:
            live = engine.apply_transform(engine.normalize_notebook_relation(frame), operation)
            assert list(map(str, live.types)) == list(map(str, native.types))
            if refuse:
                message = refuse if isinstance(refuse, str) else "integer Formula result is not exact"
                with pytest.raises(EngineError, match=message):
                    engine.validate_transformation_result(live)
                # Readiness must evaluate the Formula before a later projection can prune it.
                with pytest.raises(duckdb.Error, match=message):
                    execute_generated(
                        engine,
                        frame,
                        [operation, bound_step("dropColumns", columns=[bound_ref("c:result", "result", 4)])],
                    )
            else:
                engine.validate_transformation_result(live)
                generated = execute_generated(engine, frame, [operation])
                assert generated.types == native.types
                for actual in (engine._terminal_rows(live, "SELECT * FROM ow"), generated.fetchall()):
                    assert [row[:-1] for row in actual] == original
                    assert [row[-1] for row in actual[2:]] == [None, None]
                    for index in range(2):
                        value = actual[index][-1]
                        if exact is None:
                            assert isnan(value) and isnan(native_rows[index][-1])
                        else:
                            assert Fraction(value) == exact
                            assert value.hex() == native_rows[index][-1].hex()
            if "BIGNUM" in (left_type, right_type):
                empty = frame.limit(0)
                empty_live = engine.apply_transform(engine.normalize_notebook_relation(empty), operation)
                engine.validate_transformation_result(empty_live)
                empty_generated = execute_generated(engine, empty, [operation])
                assert empty_generated.types == native.types
                assert engine._terminal_rows(empty_live, "SELECT * FROM ow") == empty_generated.fetchall() == []
            assert frame.fetchall() == original
            assert connection.sql("SELECT 19").fetchone() == (19,)
        finally:
            engine.close()


@pytest.mark.parametrize(
    ("operator", "left", "literal", "expected", "refuse", "source_type"),
    [
        ("add", 0, str(2**128 - 1), 2**128 - 1, True, "HUGEINT"),
        ("multiply", 0, str(2**128 - 1), 0, False, "HUGEINT"),
        ("add", 0, str(2**127), 2**127, False, "HUGEINT"),
        ("modulo", 2**100 + 1, str(2**127 + 1), 2**100 + 1, True, "HUGEINT"),
        ("multiply", 2**100 + 1, "1", 2**100 + 1, True, "BIGNUM"),
        ("multiply", 2**200, "0", 0, False, "BIGNUM"),
        ("modulo", 2**200, "-1", 0, False, "BIGNUM"),
        ("multiply", 2**127, "1", 2**127, "outside the signed 128-bit", "BIGNUM"),
    ],
)
def test_duckdb_integer_formula_preserves_exact_scalar_literal_intent(
    operator: str, left: int, literal: str, expected: int, refuse: bool | str, source_type: str
) -> None:
    engine = DuckDBEngine()
    frame = duckdb.sql(f"SELECT '{left}'::{source_type} AS value")
    original = frame.fetchall()
    schema = engine.schema(frame)
    lineage = source_lineage(schema)
    operation = bind_step(
        step("formula", leftColumn=lineage[0], operator=operator, value=literal, newColumn="result"), schema, lineage
    )
    try:
        live = engine.apply_transform(frame, operation)
        assert str(live.types[-1]) == "DOUBLE"
        if refuse:
            message = refuse if isinstance(refuse, str) else "integer Formula result is not exact"
            with pytest.raises(EngineError, match=message):
                engine.validate_transformation_result(live)
            with pytest.raises(duckdb.Error, match=message):
                execute_generated(engine, frame, [operation])
        else:
            generated = execute_generated(engine, frame, [operation])
            assert generated.types[-1] == DOUBLE
            assert (
                engine._terminal_rows(live, "SELECT * FROM ow")
                == generated.fetchall()
                == [(*original[0], float(expected))]
            )
            assert Fraction(generated.fetchall()[0][-1]) == expected
        assert frame.fetchall() == original == [(str(left) if source_type == "BIGNUM" else left,)]
    finally:
        engine.close()


@pytest.mark.parametrize(
    ("operator", "literal", "dtype", "expected"),
    [
        ("add", 1.0, "DECIMAL(38,1)", Decimal(2**100 + 2)),
        ("power", 2, "DOUBLE", float((2**100 + 1) ** 2)),
        ("divide", 2, "DOUBLE", float(2**99)),
    ],
)
def test_duckdb_integer_formula_retains_explicit_decimal_and_approximate_operators(
    operator: str, literal: int | float, dtype: str, expected: Decimal | float
) -> None:
    engine = DuckDBEngine()
    frame = duckdb.sql(f"SELECT '{2**100 + 1}'::HUGEINT AS value")
    operation = bound_step(
        "formula", leftColumn=bound_ref("c:source:0", "value", 0), operator=operator, value=literal, newColumn="result"
    )
    try:
        live = engine.apply_transform(frame, operation)
        generated = execute_generated(engine, frame, [operation])
        assert str(live.types[-1]) == str(generated.types[-1]) == dtype
        assert engine._terminal_rows(live, "SELECT * FROM ow") == generated.fetchall() == [(2**100 + 1, expected)]
    finally:
        engine.close()


@pytest.mark.parametrize(
    ("definition", "operator", "left", "right", "left_type"),
    [
        ("bit_count(v) AS 100", "multiply", 2**100 + 1, 2**100 + 1, "HUGEINT"),
        (f"xor(a,b) AS '{2**101 - 1}'::UHUGEINT", "multiply", 2**100 + 1, 2**100 + 1, "HUGEINT"),
        ("nullif(a,b) AS 1::UHUGEINT", "modulo", 2**100 + 1, 2, "HUGEINT"),
        ("error(message) AS 0.0::DOUBLE", "add", 2**100 + 1, 1, "HUGEINT"),
        (f'"//"(a,b) AS {2**128 - 1}::UHUGEINT', "multiply", 2**100 + 1, 2**100 + 1, "HUGEINT"),
        ('"*"(a,b) AS 0.0::DOUBLE', "multiply", 2**100, 2, "HUGEINT"),
        ('"+"(a,b) AS 0.25::DOUBLE', "add", 0, 0, "HUGEINT"),
        ('"-"(a,b) AS 0.25::DOUBLE', "subtract", 0, 0, "HUGEINT"),
        ('"%"(a,b) AS 0.25::DOUBLE', "modulo", 0, 2, "HUGEINT"),
        ("bit_count(v) AS 100", "multiply", 2**100 + 1, 1, "BIGNUM"),
        ("coalesce(a,b) AS 0::HUGEINT", "multiply", 2**100 + 1, 1, "BIGNUM"),
        ('"*"(a,b) AS 0.0::DOUBLE', "multiply", 7, 2, "BIGNUM"),
        ('"%"(a,b) AS 0.25::DOUBLE', "modulo", 0, 2, "BIGNUM"),
    ],
)
def test_duckdb_integer_formula_guard_uses_native_primitives_in_each_execution_owner(
    definition: str, operator: str, left: int, right: int, left_type: str
) -> None:
    engine = DuckDBEngine()
    with duckdb.connect() as connection:
        operation = bound_step(
            "formula",
            leftColumn=bound_ref("c:source:0", "lhs", 0),
            rightColumn=bound_ref("c:source:1", "rhs", 1),
            operator=operator,
            newColumn="result",
        )
        try:
            connection.execute("CREATE MACRO " + definition)
            frame = connection.sql(f"SELECT '{left}'::{left_type} AS lhs, '{right}'::UHUGEINT AS rhs")
            live = engine.apply_transform(engine.normalize_notebook_relation(frame), operation)
            assert str(live.types[-1]) == "DOUBLE"
            with pytest.raises(EngineError, match="integer Formula result is not exact"):
                engine.validate_transformation_result(live)
            assert frame.fetchall() == [(str(left) if left_type == "BIGNUM" else left, right)]
            with pytest.raises(duckdb.Error, match="integer Formula result is not exact"):
                execute_generated(engine, frame, [operation])
            assert frame.fetchall() == [(str(left) if left_type == "BIGNUM" else left, right)]
        finally:
            engine.close()


@pytest.mark.parametrize("generated", [False, True], ids=["live", "generated"])
def test_duckdb_integer_formula_guards_the_evaluated_volatile_pair(generated: bool) -> None:
    engine = DuckDBEngine()
    with duckdb.connect() as connection:
        connection.execute("CREATE SEQUENCE formula_pair START 2")
        connection.execute("CREATE TEMP VIEW ow AS SELECT 99 AS sentinel")
        catalog_query = "SELECT view_name, view_oid FROM duckdb_views() WHERE NOT internal ORDER BY view_name"
        catalog_before = connection.sql(catalog_query).fetchall()
        frame = connection.sql(
            f"SELECT ('{2**100}'::HUGEINT + (nextval('formula_pair') % 2)::HUGEINT) AS lhs, '{2**100}'::UHUGEINT AS rhs"
        ).set_alias('caller "formula"')
        source_before = (frame.alias, frame.sql_query(), frame.columns, frame.types)
        operation = bound_step(
            "formula",
            leftColumn=bound_ref("c:source:0", "lhs", 0),
            rightColumn=bound_ref("c:source:1", "rhs", 1),
            operator="subtract",
            newColumn="result",
        )
        try:
            if generated:
                # The complete program validates its step once before returning the lazy relation.
                result = execute_generated(engine, frame, [operation])
            else:
                result = engine.apply_transform(engine.normalize_notebook_relation(frame), operation)
                assert connection.sql(
                    "SELECT last_value FROM duckdb_sequences() WHERE sequence_name='formula_pair'"
                ).fetchone() == (None,)
                assert engine._terminal_rows(result, "SELECT * FROM ow") == [(2**100, 2**100, 0.0)]
            assert connection.sql("SELECT currval('formula_pair')").fetchone() == (2,)
            # A separate precheck would incorrectly approve the following odd pair.
            with pytest.raises((EngineError, duckdb.Error), match="integer Formula result is not exact"):
                if generated:
                    result.fetchall()
                else:
                    engine._terminal_rows(result, "SELECT * FROM ow")
            assert connection.sql("SELECT currval('formula_pair')").fetchone() == (3,)
            assert (frame.alias, frame.sql_query(), frame.columns, frame.types) == source_before
            assert connection.sql("SELECT * FROM ow").fetchall() == [(99,)]
            assert connection.sql(catalog_query).fetchall() == catalog_before
        finally:
            engine.close()


@pytest.mark.parametrize(
    ("dtype", "source_expression", "expected_type", "expected_value"),
    [
        ("string", "42::INTEGER", "VARCHAR", "42"),
        ("integer", "'42'::VARCHAR", "BIGINT", 42),
        ("float", "1.25::ow_cast_source", "DOUBLE", 1.25),
        ("boolean", "'true'::VARCHAR", "BOOLEAN", True),
        ("date", "'2024-01-02'::VARCHAR", "DATE", date(2024, 1, 2)),
        (
            "datetime",
            "'2024-01-02 03:04:05'::VARCHAR",
            "TIMESTAMP",
            datetime(2024, 1, 2, 3, 4, 5),
        ),
    ],
)
def test_duckdb_cast_targets_match_live_and_generated_code(
    dtype: str,
    source_expression: str,
    expected_type: str,
    expected_value: Any,
) -> None:
    engine = DuckDBEngine()
    source = None
    live = None
    generated = None

    try:
        duckdb.execute("CREATE TYPE ow_cast_source AS DECIMAL(9, 2)")
        source = duckdb.sql(f'SELECT {source_expression} AS "source""value"')
        operation = bound_step(
            "castColumn",
            column=bound_ref("c:source:0", 'source"value', 0),
            dtype=dtype,
        )
        live = engine.apply_transform(engine.normalize_notebook_relation(source), operation)
        generated = execute_generated(engine, source, [operation])

        assert live.types == [expected_type]
        assert [str(item) for item in generated.types] == [expected_type]
        assert engine._terminal_rows(live, "SELECT * FROM ow") == [(expected_value,)]
        assert generated.fetchall() == [(expected_value,)]
    finally:
        source = None
        live = None
        generated = None
        try:
            engine.close()
        finally:
            duckdb.execute("DROP TYPE IF EXISTS ow_cast_source")


@pytest.mark.parametrize(
    "native_type", ["TIMESTAMP_NS", "TIMESTAMP_S", "TIMESTAMP_MS", "TIMESTAMP", "TIMESTAMP WITH TIME ZONE"]
)
@pytest.mark.parametrize("generated", [False, True], ids=["live", "generated"])
def test_duckdb_datetime_cast_preserves_native_storage(native_type: str, generated: bool) -> None:
    ticks = [-1001, -1, 0, 1, 1001, 1704161045123456789]
    values = ", ".join(f"(system.main.make_timestamp_ns({tick}), {index})" for index, tick in enumerate(ticks))
    values += ", ('-infinity'::TIMESTAMP_NS, 6), ('infinity'::TIMESTAMP_NS, 7), (NULL::TIMESTAMP_NS, 8)"
    identifier = '"when\'s value"'
    projection = (
        f"system.main.epoch_ns({identifier}), {identifier} = '-infinity'::{native_type}, "
        f"{identifier} = 'infinity'::{native_type}, kept"
    )
    engine = DuckDBEngine()
    with duckdb_runtime._connect() as connection:
        try:
            source_value = "CAST(value AS TIMESTAMP)" if native_type in {"TIMESTAMP_S", "TIMESTAMP_MS"} else "value"
            original = connection.sql(
                f"SELECT CAST({source_value} AS {native_type}) AS {identifier}, kept "
                f"FROM (VALUES {values}) source(value, kept)"
            )
            assert str(original.types[0]) == native_type
            if native_type == "TIMESTAMP_NS":
                assert original.project(f"system.main.epoch_ns({identifier})").fetchall()[:6] == [
                    (tick,) for tick in ticks
                ]
            for source in (original, original.filter(f"{identifier} IS NULL"), original.limit(0)):
                before = source.project(projection).fetchall()
                identity = (source.sql_query(), source.columns, source.types)
                frame = engine.normalize_notebook_relation(source)
                schema = engine.schema(frame)
                lineage = source_lineage(schema)
                operation = bind_step(step("castColumn", column=lineage[0], dtype="datetime"), schema, lineage)
                result = (
                    execute_generated(engine, source, [operation])
                    if generated
                    else engine.apply_transform(frame, operation)
                )
                if not generated:
                    engine.validate_transformation_result(result, operation_kind="castColumn")
                actual = (
                    result.project(projection).fetchall()
                    if generated
                    else engine._terminal_rows(result, f"SELECT {projection} FROM ow")
                )
                assert actual == before
                assert result.columns == source.columns
                assert [str(dtype) for dtype in result.types] == [native_type, "INTEGER"]
                assert derive_lineage(lineage, engine.schema(result), operation) == lineage
                assert source.project(projection).fetchall() == before
                assert (source.sql_query(), source.columns, source.types) == identity
        finally:
            engine.close()


@pytest.mark.parametrize(
    ("layout", "text", "day"),
    [
        ("DD/MM/YYYY", "02/03/2024", datetime(2024, 3, 2)),
        ("MM/DD/YYYY", "02/03/2024", datetime(2024, 2, 3)),
        ("YYYY-MM-DD", "2024-03-02", datetime(2024, 3, 2)),
    ],
)
def test_duckdb_fixed_datetime_input_layout_matches_generated(layout, text, day) -> None:
    engine = DuckDBEngine()
    operation = bound_step(
        "castColumn", column=bound_ref("c:source:1", "when's value", 1), dtype="datetime", inputFormat=layout
    )
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([operation]), namespace)
    invalid = "31/02/2024" if layout == "DD/MM/YYYY" else "02/31/2024" if layout == "MM/DD/YYYY" else "2024-02-31"
    values = [text, None, invalid, "", text + "\n", " " + text, text + "Z", text.replace("2024", "0000")]
    rows = ", ".join(f"({index}, {duckdb_runtime._sql_literal(value)}::VARCHAR)" for index, value in enumerate(values))
    with duckdb_runtime._connect() as connection:
        try:
            connection.execute("SET TimeZone = 'America/New_York'")
            connection.execute("CREATE MACRO regexp_full_match(value, pattern) AS true")
            connection.execute("CREATE MACRO substr(value, first, count) AS '2000'")
            connection.execute("CREATE MACRO try_strptime(value, format) AS TIMESTAMP '1970-01-01'")
            original = connection.sql(f'SELECT * FROM (VALUES {rows}) source(kept, "when\'s value")')
            for source in (original, original.filter('"when\'s value" IS NULL'), original.limit(0)):
                before = source.fetchall()
                identity = (source.sql_query(), source.columns, source.types)
                expected = [(index, day if index == 0 else None) for index, _value in before]
                frame = engine.normalize_notebook_relation(source)
                schema = engine.schema(frame)
                lineage = source_lineage(schema)
                live = engine.apply_transform(frame, operation)
                generated = namespace["clean_data"](source)
                assert engine._terminal_rows(live, "SELECT * FROM ow") == expected
                assert generated.fetchall() == expected
                for result in (live, generated):
                    assert [str(dtype) for dtype in result.types] == ["INTEGER", "TIMESTAMP"]
                    assert result.columns == source.columns
                    assert derive_lineage(lineage, engine.schema(result), operation) == lineage
                assert source.fetchall() == before and (source.sql_query(), source.columns, source.types) == identity
            assert connection.sql("SELECT current_setting('TimeZone')").fetchone() == ("America/New_York",)
        finally:
            engine.close()


def test_duckdb_fixed_datetime_input_layout_admits_only_current_text() -> None:
    engine = DuckDBEngine()
    column = bound_ref("c:source:0", "value", 0)
    operation = bound_step("castColumn", column=column, dtype="datetime", inputFormat="YYYY-MM-DD")
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([operation]), namespace)
    with duckdb_runtime._connect() as connection:
        try:
            for expression in ("'2024-01-02'::ENUM('2024-01-02')", "NULL::INTEGER", "NULL::TIMESTAMP", "NULL::UUID"):
                original = connection.sql(f"SELECT {expression} AS value")
                for source in (original, original.limit(0)):
                    before = source.fetchall()
                    with pytest.raises(ValueError, match="requires a text column"):
                        engine.apply_transform(engine.normalize_notebook_relation(source), operation)
                    with pytest.raises(ValueError, match="requires a text column"):
                        namespace["clean_data"](source)
                    assert source.fetchall() == before
            source = connection.sql("SELECT * FROM (VALUES (DATE '2024-01-02'), (NULL::DATE)) source(value)")
            before = source.fetchall()
            to_text = bound_step("castColumn", column=column, dtype="string")
            to_text["id"] = "text-before-layout"
            live = engine.apply_transform(
                engine.apply_transform(engine.normalize_notebook_relation(source), to_text), operation
            )
            generated = execute_generated(engine, source, [to_text, operation])
            assert engine._terminal_rows(live, "SELECT * FROM ow") == [(datetime(2024, 1, 2),), (None,)]
            assert generated.fetchall() == [(datetime(2024, 1, 2),), (None,)]
            assert source.fetchall() == before
        finally:
            engine.close()


def test_duckdb_fixed_datetime_input_layout_capacity_has_exact_public_values() -> None:
    values = ["0001-01-01", "1677-09-21", "2262-04-12", "9999-12-31", "2024-02-29", "2023-02-29", None]
    rows = ", ".join(f"({duckdb_runtime._sql_literal(value)}::VARCHAR)" for value in values)
    engine = DuckDBEngine()
    with duckdb_runtime._connect() as connection:
        try:
            source = connection.sql(f"SELECT * FROM (VALUES {rows}) source(value)")
            before = source.fetchall()
            frame = engine.normalize_notebook_relation(source)
            schema = engine.schema(frame)
            lineage = source_lineage(schema)
            operation = bind_step(
                step("castColumn", column=lineage[0], dtype="datetime", inputFormat="YYYY-MM-DD"), schema, lineage
            )
            expected = [value + "T00:00:00" if value is not None else None for value in values]
            expected[5] = None
            for result in (engine.apply_transform(frame, operation), execute_generated(engine, source, [operation])):
                assert engine.schema(result)[0]["type"] == "datetime"
                page = engine.page(result, 0, len(values), column_projection=[(0, lineage[0]["id"])])
                assert [row["values"][0]["raw"] for row in page["rows"]] == expected
                summary = engine.summaries(result, column_projection=[(0, lineage[0]["id"])])[0]
                assert summary["type"] == "datetime" and summary["totalCount"] == len(values)
                assert summary["nullCount"] == 2
            assert source.fetchall() == before
        finally:
            engine.close()


@pytest.mark.parametrize("zone", ["UTC", "America/New_York"])
def test_duckdb_datetime_cast_reuses_current_types_and_connection_timezone(zone: str) -> None:
    engine = DuckDBEngine()
    column = bound_ref("c:source:0", "value", 0)
    operation = bound_step("castColumn", column=column, dtype="datetime")
    namespace: dict[str, Any] = {}
    exec(engine.compile_plan([operation]), namespace)
    projection = "system.main.epoch_us(value), CAST(value AS VARCHAR), kept"
    cases = [
        ("TIMESTAMPTZ '2024-01-01 00:30:00+00'", "value", "TIMESTAMP WITH TIME ZONE"),
        ("system.main.make_timestamp_ns(-1)", "value", "TIMESTAMP_NS"),
        ("DATE '2500-01-01'", "TRY_CAST(value AS TIMESTAMP)", "TIMESTAMP"),
        ("'2024-01-02T03:04:05+02:00'::VARCHAR", "TRY_CAST(value AS TIMESTAMP)", "TIMESTAMP"),
        ("'invalid'::VARCHAR", "TRY_CAST(value AS TIMESTAMP)", "TIMESTAMP"),
        ("42::INTEGER", "TRY_CAST(value AS TIMESTAMP)", "TIMESTAMP"),
    ]
    with duckdb_runtime._connect() as connection:
        try:
            connection.execute(f"SET TimeZone = '{zone}'")
            for expression, expected_expression, expected_type in cases:
                source = connection.sql(f"SELECT {expression} AS value, 7 AS kept")
                before = (
                    source.sql_query(),
                    source.columns,
                    source.types,
                    source.project("CAST(value AS VARCHAR), kept").fetchall(),
                )
                expected = source.project(f"{expected_expression} AS value, kept").project(projection).fetchall()
                if expected_type == "TIMESTAMP WITH TIME ZONE":
                    assert expected[0][0] == 1704069000000000
                    assert expected[0][1].startswith("2024-01-01 00:30:00" if zone == "UTC" else "2023-12-31 19:30:00")
                live = engine.apply_transform(engine.normalize_notebook_relation(source), operation)
                generated = namespace["clean_data"](source)
                assert engine._terminal_rows(live, f"SELECT {projection} FROM ow") == expected
                assert generated.project(projection).fetchall() == expected
                for result in (live, generated):
                    assert result.columns == ["value", "kept"]
                    assert [str(dtype) for dtype in result.types] == [expected_type, "INTEGER"]
                assert (
                    source.sql_query(),
                    source.columns,
                    source.types,
                    source.project("CAST(value AS VARCHAR), kept").fetchall(),
                ) == before

            source = connection.sql("SELECT system.main.make_timestamp_ns(-1) AS value, 7 AS kept")
            to_string = bound_step("castColumn", column=column, dtype="string")
            expected = (
                source.project("TRY_CAST(CAST(value AS VARCHAR) AS TIMESTAMP) AS value, kept")
                .project(projection)
                .fetchall()
            )
            live = engine.apply_transform(
                engine.apply_transform(engine.normalize_notebook_relation(source), to_string), operation
            )
            generated = execute_generated(engine, source, [to_string, operation])
            assert engine._terminal_rows(live, f"SELECT {projection} FROM ow") == expected
            assert generated.project(projection).fetchall() == expected
            assert [str(dtype) for dtype in generated.types] == ["TIMESTAMP", "INTEGER"]
            assert source.project("system.main.epoch_ns(value), kept").fetchall() == [(-1, 7)]
            assert connection.sql("SELECT current_setting('TimeZone')").fetchone() == (zone,)
        finally:
            engine.close()


@pytest.mark.parametrize("layout", ["ordinary", "collision", "case_suffix", "rebound_extra", "prior_rename"])
def test_duckdb_generated_sort_preserves_current_columns_and_stable_ties(layout: str) -> None:
    engine = DuckDBEngine()
    payload = (
        "__ow_sort_order" if layout == "collision" else "__OW_SORT_ORDER" if layout == "case_suffix" else "payload"
    )
    key = "KEY" if layout == "rebound_extra" else "key"
    extra = (
        ', 999::BIGINT AS "__ow_sort_order_1"'
        if layout == "case_suffix"
        else ", 777::BIGINT AS \"__ow_sort_order\", 'keep' AS spare"
        if layout == "rebound_extra"
        else ""
    )
    plan = []
    if layout == "prior_rename":
        plan.append(bound_step("renameColumn", column=bound_ref("c:source:0", "payload", 0), newName="__ow_sort_order"))
    plan.append(
        bound_step(
            "sortRows",
            rules=[
                {"column": bound_ref("c:source:1", "key", 1), "direction": "asc", "nulls": "last"},
                {"column": bound_ref("c:source:2", "secondary", 2), "direction": "desc", "nulls": "first"},
            ],
        )
    )
    try:
        with duckdb.connect(config={"python_enable_replacements": False}) as connection:
            frame = connection.sql(
                f"SELECT *{extra} FROM (VALUES (99::BIGINT, 2, 2, 'r0'), (88, 1, NULL, 'r1'), "
                f"(77, 1, NULL, 'r2'), (66, NULL, 5, 'r3'), (55, 1, 3, 'r4')) "
                f'input("{payload}", "{key}", secondary, tag)'
            )
            before = frame.fetchall()
            columns = list(frame.columns)
            if layout == "prior_rename":
                columns[0] = "__ow_sort_order"
            result = execute_generated(engine, frame, plan)
            assert result.columns == columns
            assert result.types == frame.types
            assert result.fetchall() == [before[index] for index in [1, 2, 4, 0, 3]]
            assert frame.fetchall() == before
    finally:
        engine.close()


@pytest.mark.parametrize("missing", ["key", "__ow_sort_order"])
def test_duckdb_generated_sort_does_not_invent_or_ignore_missing_keys(missing: str) -> None:
    engine = DuckDBEngine()
    operation = bound_step(
        "sortRows",
        rules=[{"column": bound_ref("c:source:0", missing, 0), "direction": "asc", "nulls": "last"}],
    )
    try:
        with duckdb.connect() as connection:
            frame = connection.sql("SELECT * FROM (VALUES (2), (1)) input(other)")
            with pytest.raises(duckdb.BinderException, match="Referenced column"):
                execute_generated(engine, frame, [operation])
            assert frame.fetchall() == [(2,), (1,)]
    finally:
        engine.close()


def test_duckdb_public_sort_generated_code_retains_a_sort_helper_named_column(tmp_path: Path) -> None:
    source = tmp_path / "sort-owner.csv"
    original = b"__ow_sort_order,key,tag\n99,2,r0\n88,1,r1\n77,1,r2\n"
    source.write_bytes(original)
    manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))
    try:
        opened = manager.open_session({"kind": "file", "label": source.name, "path": str(source)}, backend="duckdb")
        session_id = opened["metadata"]["sessionId"]
        key = opened["metadata"]["schema"][1]
        operation = step(
            "sortRows",
            rules=[{"column": {"id": key["id"], "name": key["name"]}, "direction": "asc", "nulls": "last"}],
        )
        preview = manager.preview_step(session_id, 0, operation, 0, 10)
        applied = manager.apply_draft(session_id, preview["revision"], 0, 10)
        expected = [(88, 1, "r1"), (77, 1, "r2"), (99, 2, "r0")]
        for response in (preview, applied):
            assert [column["name"] for column in response["metadata"]["schema"]] == ["__ow_sort_order", "key", "tag"]
            assert [tuple(cell["raw"] for cell in row["values"]) for row in response["page"]["rows"]] == expected
        namespace: dict[str, Any] = {}
        exec(compile(applied["code"], "<public-generated-sort>", "exec"), namespace)
        with duckdb.connect(config={"python_enable_replacements": False}) as connection:
            frame = connection.read_csv(str(source), header=True)
            generated = namespace["clean_data"](frame)
            assert generated.columns == frame.columns
            assert generated.types == frame.types
            assert generated.fetchall() == expected
            assert frame.fetchall() == [(99, 2, "r0"), (88, 1, "r1"), (77, 1, "r2")]
        assert source.read_bytes() == original
    finally:
        manager.close_all()


def test_duckdb_rename_only_generated_code_matches_live_with_quoted_names() -> None:
    engine = DuckDBEngine()
    frame = duckdb.sql('SELECT 1 AS "source""one", 2 AS "source""two"')
    plan = [
        bound_step(
            "renameColumn",
            column=bound_ref("c:source:0", 'source"one', 0),
            newName='renamed"one',
        ),
        bound_step(
            "renameColumn",
            column=bound_ref("c:source:1", 'source"two', 1),
            newName='renamed"two',
        ),
    ]

    try:
        live = frame
        for operation in plan:
            live = engine.apply_transform(live, operation)

        code = engine.compile_plan(plan)
        generated = execute_generated(engine, frame, plan)

        assert_same_relation(live, generated)
        assert "_ow_pivot_wider" not in code
    finally:
        engine.close()


@pytest.mark.parametrize("kind", ["formula", "customCode"])
def test_duckdb_generated_result_errors_cannot_be_hidden_by_later_drop(kind: str) -> None:
    engine = DuckDBEngine()
    frame = duckdb.sql("SELECT * FROM (VALUES (0::BIGINT), (9223372036854775807), (NULL)) source(value)")
    original = frame.fetchall()
    operation = (
        bound_step("formula", leftColumn=bound_ref("c:source:0", "value", 0), operator="add", value=1, newColumn="bad")
        if kind == "formula"
        else bound_step(
            "customCode",
            code=(
                "result = df.project(\"*, CASE WHEN value > 0 THEN error('owned result error') ELSE value END AS bad\")"
            ),
        )
    )
    try:
        with pytest.raises(duckdb.Error, match="Overflow in addition|owned result error"):
            execute_generated(
                engine, frame, [operation, bound_step("dropColumns", columns=[bound_ref("c:derived:bad", "bad", 1)])]
            )
        assert frame.columns == ["value"]
        assert frame.types == [BIGINT]
        assert frame.fetchall() == original == [(0,), (2**63 - 1,), (None,)]
    finally:
        engine.close()


def test_duckdb_result_validation_evaluates_quoted_physical_columns() -> None:
    engine = DuckDBEngine()
    frame = duckdb.sql(
        'SELECT 0 AS ow, value + 1 AS "a""b", 2 AS "hash(ow)", NULL::INTEGER AS "comma,name" '
        "FROM (VALUES (0::BIGINT), (9223372036854775807)) source(value)"
    )
    columns = list(frame.columns)
    types = list(frame.types)
    try:
        with pytest.raises(EngineError, match="Overflow in addition"):
            engine.validate_transformation_result(frame)
        with pytest.raises(duckdb.Error, match="Overflow in addition"):
            execute_generated(
                engine, frame, [bound_step("cloneColumn", column=bound_ref("c:source:0", "ow", 0), newName="copy")]
            )
        assert frame.columns == columns == ["ow", 'a"b', "hash(ow)", "comma,name"]
        assert frame.types == types
        assert frame.project('ow, "hash(ow)", "comma,name"').fetchall() == [(0, 2, None), (0, 2, None)]
    finally:
        engine.close()


@pytest.mark.parametrize("empty", [False, True])
def test_duckdb_result_validation_preserves_native_complex_values(empty: bool) -> None:
    engine = DuckDBEngine()
    frame = duckdb.sql(
        "SELECT 9223372036854775807::BIGINT AS ow, 12.50::DECIMAL(10,2) AS amount, "
        "[1,NULL,2] AS items, {'zero': CAST('-0.0' AS DOUBLE), 'missing': NULL::BIGINT} AS nested, "
        "CAST('-0.0' AS DOUBLE) AS zero, NULL::INTEGER AS missing" + (" WHERE FALSE" if empty else "")
    )
    expected = (
        [] if empty else [(2**63 - 1, Decimal("12.50"), [1, None, 2], {"zero": -0.0, "missing": None}, -0.0, None)]
    )
    types = list(frame.types)
    try:
        engine.validate_transformation_result(frame)
        generated = execute_generated(
            engine, frame, [bound_step("renameColumn", column=bound_ref("c:source:0", "ow", 0), newName="OW")]
        )
        assert generated.columns == ["OW", "amount", "items", "nested", "zero", "missing"]
        assert generated.types == types
        for rows in (frame.fetchall(), generated.fetchall()):
            assert rows == expected
            for row in rows:
                assert row[3]["zero"].hex() == row[4].hex() == "-0x0.0p+0"
        assert frame.columns[0] == "ow"
        assert frame.types == types
    finally:
        engine.close()


@pytest.mark.parametrize("shadow", [None, "hash", "bit_xor"])
def test_duckdb_generated_rename_results_use_the_private_connection(
    monkeypatch: pytest.MonkeyPatch, shadow: str | None
) -> None:
    engine = DuckDBEngine()
    with duckdb.connect() as connection:
        if shadow is not None:
            connection.execute(f"CREATE MACRO {shadow}(x) AS 0::UBIGINT")
        visits: list[int | None] = []

        def observed(value: int | None) -> int | None:
            visits.append(value)
            return value

        connection.create_function(
            "owned_result_observed",
            observed,
            ["BIGINT"],
            "BIGINT",
            null_handling=FunctionNullHandling.SPECIAL,
            side_effects=True,
        )
        frame = connection.sql(
            "SELECT owned_result_observed(value) AS ow, CAST('-0.0' AS DOUBLE) AS zero "
            "FROM (VALUES (0::BIGINT), (9223372036854775807), (NULL)) source(value)"
        )
        plan = [
            bound_step("renameColumn", column=bound_ref("c:source:0", "ow", 0), newName='a"b'),
            bound_step("renameColumn", column=bound_ref("c:source:0", 'a"b', 0), newName="OW"),
        ]

        def unexpected_global_connection(*args: Any, **kwargs: Any) -> Any:
            raise AssertionError("Generated Rename must use the source relation's connection.")

        try:
            with monkeypatch.context() as scoped:
                scoped.setattr(duckdb, "sql", unexpected_global_connection)
                scoped.setattr(duckdb, "connect", unexpected_global_connection)
                invalid = connection.sql(
                    "SELECT CASE WHEN value > 0 THEN error('owned private result error') ELSE value END AS ow "
                    "FROM (VALUES (0), (1)) source(value)"
                )
                deferred = execute_generated(engine, invalid, plan)
                with pytest.raises(duckdb.Error, match="owned private result error"):
                    deferred.fetchall()
                # Computed results still evaluate through qualified builtins,
                # even when this connection shadows a validation function.
                with pytest.raises(duckdb.Error, match="owned private result error"):
                    execute_generated(
                        engine, invalid, [bound_step("customCode", code="result = df"), *plan], connection=connection
                    )
                assert invalid.columns == ["ow"]
                generated = execute_generated(engine, frame, plan)
                assert visits == []
                assert generated.columns == ["OW", "zero"]
                assert generated.types == frame.types == [BIGINT, DOUBLE]
                actual = generated.fetchall()
                assert actual == [(0, -0.0), (2**63 - 1, -0.0), (None, -0.0)]
                assert visits == [0, 2**63 - 1, None]
                assert all(row[1].hex() == "-0x0.0p+0" for row in actual)
            assert frame.columns == ["ow", "zero"]
            assert frame.fetchall() == actual
            assert connection.sql("SELECT 17").fetchone() == (17,)
            if shadow is not None:
                assert connection.sql(f"SELECT {shadow}(17)").fetchone() == (0,)
        finally:
            engine.close()


@pytest.mark.parametrize("kind", ["renameColumn", "selectColumns", "dropColumns"])
def test_duckdb_structural_plans_preserve_deferred_input_errors_and_allow_repair(kind: str) -> None:
    engine = DuckDBEngine()
    with duckdb.connect() as connection:
        frame = connection.sql(
            "SELECT i AS safe, CASE WHEN i=1 THEN error('inherited input error') ELSE i END AS bad, "
            "17 AS unused FROM range(2) source(i)"
        )
        safe = bound_ref("c:source:0", "safe", 0)
        bad = bound_ref("c:source:1", "bad", 1)
        unused = bound_ref("c:source:2", "unused", 2)
        operation = {
            "renameColumn": bound_step("renameColumn", column=safe, newName='safe"renamed'),
            "selectColumns": bound_step("selectColumns", columns=[safe, bad]),
            "dropColumns": bound_step("dropColumns", columns=[unused]),
        }[kind]
        try:
            result = execute_generated(engine, frame, [operation])
            name = 'safe"renamed' if kind == "renameColumn" else "safe"
            assert result.project('"' + name.replace('"', '""') + '"').fetchall() == [(0,), (1,)]
            with pytest.raises(duckdb.Error, match="inherited input error"):
                result.fetchall()
            repaired = execute_generated(engine, frame, [bound_step("dropColumns", columns=[bad])])
            assert repaired.columns == ["safe", "unused"]
            assert repaired.fetchall() == [(0, 17), (1, 17)]
            assert frame.columns == ["safe", "bad", "unused"]
            assert connection.sql("SELECT 23").fetchone() == (23,)
        finally:
            engine.close()


def test_duckdb_structural_plans_leave_volatile_input_evaluation_to_the_caller() -> None:
    engine = DuckDBEngine()
    calls: list[int] = []
    with duckdb.connect() as connection:

        def once(value: int) -> int:
            calls.append(value)
            if len(calls) > 1:
                raise ValueError("owned later evaluation")
            return value

        connection.create_function("owned_once", once, ["BIGINT"], "BIGINT", side_effects=True)
        frame = connection.sql("SELECT owned_once(7) AS value")
        operation = bound_step("renameColumn", column=bound_ref("c:source:0", "value", 0), newName="renamed")
        try:
            result = execute_generated(engine, frame, [operation])
            assert calls == []
            assert result.fetchall() == [(7,)] and calls == [7]
            with pytest.raises(duckdb.Error, match="owned later evaluation"):
                result.fetchall()
            assert calls == [7, 7]
            assert frame.columns == ["value"] and frame.types == result.types == [BIGINT]
            assert connection.sql("SELECT 29").fetchone() == (29,)
        finally:
            engine.close()


@pytest.mark.parametrize("source_kind", ["table", "quoted_cte", "csv"])
def test_duckdb_public_generated_query_uses_the_input_connection(tmp_path: Path, source_kind: str) -> None:
    source_path = tmp_path / "query-owner.csv"
    source_path.write_text("key\n2\n3\n", encoding="utf-8")
    source_bytes = source_path.read_bytes()
    manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))
    duckdb.sql("CREATE TEMP TABLE generated_query_source AS SELECT 900::BIGINT AS key")
    try:
        opened = manager.open_session(
            {"kind": "file", "label": source_path.name, "path": str(source_path)}, backend="duckdb"
        )
        session_id = opened["metadata"]["sessionId"]
        preview = manager.preview_step(
            session_id,
            0,
            step("formula", leftColumn={"id": "c:source:0", "name": "key"}, operator="add", value=1, newColumn="plus"),
            0,
            10,
        )
        applied = manager.apply_draft(session_id, preview["revision"], 0, 10)
        namespace: dict[str, Any] = {}
        assert "openwrangler_runtime" not in applied["code"]
        exec(compile(applied["code"], "<public-generated-query>", "exec"), namespace)
        query_namespace: dict[str, Any] = {}
        exec(select_generated_helpers(duckdb_runtime._generated_helper_source(), "_ow_query"), query_namespace)
        with duckdb.connect(config={"python_enable_replacements": False}) as connection:
            connection.execute("CREATE TABLE generated_query_source AS SELECT * FROM (VALUES (2::BIGINT), (3)) t(key)")
            connection.execute("CREATE TEMP VIEW ow AS SELECT 99 AS sentinel")
            catalog = connection.sql("SELECT view_name, view_oid FROM duckdb_views() WHERE NOT internal").fetchall()
            if source_kind == "csv":
                frame = connection.read_csv(str(source_path), header=True)
            elif source_kind == "quoted_cte":
                frame = connection.sql(
                    'WITH prior AS (SELECT key, 17 AS "quote""field" FROM generated_query_source) SELECT * FROM prior'
                )
            else:
                frame = connection.table("generated_query_source")
            expected = [(2, 17, 3), (3, 17, 4)] if source_kind == "quoted_cte" else [(2, 3), (3, 4)]
            result = namespace["clean_data"](frame)
            assert result.fetchall() == expected
            assert str(result.types[-1]) == "BIGINT"
            later = query_namespace["_ow_query"](
                result, "WITH next AS (SELECT *, plus + 1 AS later FROM ow) SELECT * FROM next"
            )
            assert later.fetchall() == [(*row, row[-1] + 1) for row in expected]
            del later
            assert result.fetchall() == expected
            assert (
                connection.sql("SELECT view_name, view_oid FROM duckdb_views() WHERE NOT internal").fetchall()
                == catalog
            )
            assert connection.sql("SELECT * FROM ow").fetchall() == [(99,)]
            assert frame.fetchall() == [row[:-1] for row in expected]
        assert duckdb.sql("SELECT * FROM generated_query_source").fetchall() == [(900,)]
        assert source_path.read_bytes() == source_bytes
    finally:
        manager.close_all()
        duckdb.sql("DROP TABLE generated_query_source")


@pytest.mark.parametrize("mixed", [False, True])
def test_duckdb_generated_query_preserves_the_custom_module_namespace(mixed: bool) -> None:
    engine = DuckDBEngine()
    custom = step(
        "customCode",
        code="assert isinstance(df, duckdb.DuckDBPyRelation)\n"
        "assert 'uuid4' not in globals() and 'suppress' not in globals()\n"
        "assert df.columns == ['key']\nresult = df.project('key + 1 AS key')",
    )
    plan = [custom]
    if mixed:
        plan.append(
            bound_step(
                "formula", leftColumn=bound_ref("c:source:0", "key", 0), operator="add", value=1, newColumn="plus"
            )
        )
    try:
        with duckdb.connect() as connection:
            connection.execute(
                "CREATE TABLE generated_custom_source AS SELECT key, key AS __open_wrangler_internal_row_id_test "
                "FROM (VALUES (2::BIGINT), (3)) t(key)"
            )
            frame = connection.table("generated_custom_source")
            generated = execute_generated(engine, frame, plan, connection=connection)
            assert generated.fetchall() == ([(3, 4), (4, 5)] if mixed else [(3,), (4,)])
            assert generated.types == ([BIGINT, BIGINT] if mixed else [BIGINT])
            assert frame.fetchall() == [(2, 2), (3, 3)]
            assert connection.sql("SELECT view_name FROM duckdb_views() WHERE NOT internal").fetchall() == []
    finally:
        engine.close()


def test_duckdb_generated_query_catalog_work_does_not_evaluate_source_rows() -> None:
    engine = DuckDBEngine()
    namespace: dict[str, Any] = {}
    plan = [
        bound_step("formula", leftColumn=bound_ref("c:source:0", "key", 0), operator="add", value=1, newColumn="plus")
    ]
    try:
        exec(engine.compile_plan(plan), namespace)
        query_namespace: dict[str, Any] = {}
        exec(select_generated_helpers(duckdb_runtime._generated_helper_source(), "_ow_query"), query_namespace)
        with duckdb.connect() as connection:
            calls: list[int] = []

            def observed(value: int) -> int:
                calls.append(value)
                return value + 100

            connection.create_function("generated_query_observed", observed, [BIGINT], BIGINT, side_effects=True)
            frame = connection.sql("SELECT generated_query_observed(i) AS key FROM range(2, 4) t(i)")
            connection.execute("CREATE MACRO lower(value) AS 'wrong'")
            connection.execute("CREATE MACRO count(value) AS 0")
            direct = query_namespace["_ow_query"](frame, "SELECT * FROM ow")
            assert calls == []
            result = namespace["clean_data"](frame)
            assert calls == [2, 3]
            calls.clear()
            assert result.fetchall() == [(102, 103), (103, 104)]
            assert calls == [2, 3]
            calls.clear()
            with pytest.raises(duckdb.BinderException, match="absent"):
                query_namespace["_ow_query"](frame, "SELECT absent FROM ow")
            assert calls == []
            assert connection.sql("SELECT view_name FROM duckdb_views() WHERE NOT internal").fetchall() == []
            assert direct.fetchall() == [(102,), (103,)]
            assert calls == [2, 3]
    finally:
        engine.close()


@pytest.mark.parametrize(
    ("object_kind", "uppercase"),
    [("TABLE", False), ("VIEW", False), ("TEMP TABLE", False), ("TEMP VIEW", False), ("TEMP VIEW", True)],
)
def test_duckdb_generated_query_alias_collision_preserves_caller_object(object_kind: str, uppercase: bool) -> None:
    from uuid import UUID

    engine = DuckDBEngine()
    namespace: dict[str, Any] = {}
    try:
        exec(select_generated_helpers(duckdb_runtime._generated_helper_source(), "_ow_query"), namespace)
        namespace["uuid4"] = lambda: UUID(int=1)
        alias = "__open_wrangler_query_" + UUID(int=1).hex
        existing = alias.upper() if uppercase else alias
        with duckdb.connect() as connection:
            connection.execute(f'CREATE {object_kind} "{existing}" AS SELECT 99 AS sentinel')
            before = connection.sql("SELECT view_name, view_oid FROM duckdb_views() WHERE NOT internal").fetchall()
            frame = connection.sql("SELECT 7 AS key")
            with pytest.raises(ValueError, match="already exists"):
                namespace["_ow_query"](frame, "SELECT * FROM ow")
            assert connection.sql(f'SELECT * FROM "{existing}"').fetchall() == [(99,)]
            assert (
                connection.sql("SELECT view_name, view_oid FROM duckdb_views() WHERE NOT internal").fetchall() == before
            )
            assert frame.fetchall() == [(7,)]
    finally:
        engine.close()


@pytest.mark.parametrize("mode", ["replacement", "source_removed", "primary_error"])
def test_duckdb_generated_query_cleanup_observes_native_lifetime_boundaries(mode: str) -> None:
    engine = DuckDBEngine()
    namespace: dict[str, Any] = {}
    try:
        exec(select_generated_helpers(duckdb_runtime._generated_helper_source(), "_ow_query"), namespace)
        with duckdb.connect() as connection:
            connection.execute("CREATE TABLE generated_lifetime_source AS SELECT 7 AS key")
            source = connection.table("generated_lifetime_source")
            aliases: list[str] = []
            original_error = KeyboardInterrupt("owned primary failure")

            # These wrappers only schedule native DDL/errors between metadata observations.
            class MetadataBoundary:
                def __init__(self, relation: Any) -> None:
                    self.relation = relation
                    self.reads = 0

                def limit(self, count: int) -> Any:
                    self.reads += 1
                    if mode == "replacement" and self.reads == 3:
                        connection.execute(f'CREATE OR REPLACE TEMP VIEW "{aliases[0]}" AS SELECT 99 AS sentinel')
                    return self.relation.limit(count)

                def query(self, alias: str, sql: str) -> Any:
                    return self.relation.query(alias, sql)

            class InputBoundary:
                def sql_query(self) -> str:
                    return source.sql_query()

                def limit(self, count: int) -> Any:
                    return source.limit(count)

                def query(self, alias: str, sql: str) -> Any:
                    aliases.append(alias)
                    result = source.query(alias, sql)
                    if sql == "SELECT 0 AS owner_metadata":
                        return MetadataBoundary(result)
                    if mode == "primary_error":
                        connection.close()
                        raise original_error
                    if mode == "source_removed":
                        connection.execute("DROP TABLE generated_lifetime_source")
                    return result

            if mode == "primary_error":
                with pytest.raises(KeyboardInterrupt) as caught:
                    namespace["_ow_query"](InputBoundary(), "SELECT * FROM ow")
                assert caught.value is original_error
            else:
                result = namespace["_ow_query"](InputBoundary(), "SELECT * FROM ow")
                assert aliases
                if mode == "replacement":
                    assert connection.sql(f'SELECT * FROM "{aliases[0]}"').fetchall() == [(99,)]
                    assert result.fetchall() == [(7,)]
                else:
                    assert connection.sql("SELECT view_name FROM duckdb_views() WHERE NOT internal").fetchall() == []
                    with pytest.raises(duckdb.CatalogException, match="generated_lifetime_source"):
                        result.fetchall()
    finally:
        engine.close()


def test_duckdb_generated_code_emits_only_reachable_helpers() -> None:
    engine = DuckDBEngine()
    plain_plan = [
        bound_step(
            "upperText",
            column=bound_ref("c:source:1", "text", 1),
            newColumn="upper_text",
        )
    ]
    categorical_plans = [
        [
            bound_step(
                "oneHotEncode",
                columns=[bound_ref("c:source:0", "group", 0)],
                prefixSeparator="_",
                dropOriginal=True,
            )
        ],
        [
            bound_step(
                "multiLabelBinarize",
                column=bound_ref("c:source:2", "tags", 2),
                delimiter="|",
                prefix="tag_",
                dropOriginal=False,
            )
        ],
    ]

    try:
        empty_code = engine.compile_plan([])
        assert empty_code == "def clean_data(df):\n    return df\n"
        with duckdb.connect() as connection:
            calls: list[int] = []

            def observed_empty_source(value: int) -> int:
                calls.append(value)
                return value

            connection.create_function(
                "observed_empty_source", observed_empty_source, ["BIGINT"], "BIGINT", side_effects=True
            )
            empty_source = connection.sql("SELECT observed_empty_source(99::BIGINT) AS KEY, 2 AS key")
            namespace: dict[str, Any] = {}
            exec(empty_code, namespace)
            assert namespace["clean_data"](empty_source) is empty_source
            assert calls == []
            assert empty_source.fetchall() == [(99, 2)]
            assert calls == [99]
        plain_code = engine.compile_plan(plain_plan)
        assert "_registered_native_relation" not in plain_code
        assert "_OW_CAPTURED" not in plain_code
        assert "def _ow_text(" in plain_code
        assert "def _ow_assign(" in plain_code
        assert "def _ow_query(" not in plain_code
        assert "from uuid import uuid4" not in plain_code
        assert "from contextlib import suppress" not in plain_code
        assert "def _ow_fill_missing(" not in plain_code
        assert "def _ow_group_by(" not in plain_code
        assert "def _ow_pivot_wider(" not in plain_code
        assert_same_relation(
            engine.apply_transform(source_relation(), plain_plan[0]),
            execute_generated(engine, source_relation(), plain_plan),
        )
        for plan in categorical_plans:
            code = engine.compile_plan(plan)
            assert "_registered_native_relation" not in code
            assert "_OW_CAPTURED" not in code
            assert "def _ow_query(" in code
            assert "def _ow_pivot_wider(" not in code
            assert_same_relation(
                engine.apply_transform(source_relation(), plan[0]),
                execute_generated(engine, source_relation(), plan),
            )
    finally:
        engine.close()


@pytest.mark.parametrize(
    "operation",
    [
        step("oneHotEncode", columns=[{"id": "c:source:0", "name": "group"}]),
        step("upperText", column={"id": "c:source:1", "name": "text"}),
        step("roundNumber", column={"id": "c:source:3", "name": "value"}),
        step("formatDatetime", column={"id": "c:source:5", "name": "date"}, format="%Y"),
    ],
)
def test_duckdb_value_adapters_reject_unbound_public_references(operation: dict[str, Any]) -> None:
    engine = DuckDBEngine()
    try:
        with pytest.raises(EngineError, match="requires a bound column reference"):
            engine.apply_transform(source_relation(), operation)
        with pytest.raises(EngineError, match="requires a bound column reference"):
            engine.compile_plan([operation])
    finally:
        engine.close()


@pytest.mark.parametrize(
    ("kind", "params", "expected"),
    [
        ("lowerText", {}, [(" ab|cd ",), ("",), (None,), ("é🙂",)]),
        ("upperText", {}, [(" AB|CD ",), ("",), (None,), ("É🙂",)]),
        ("capitalizeText", {}, [(" ab|cd ",), ("",), (None,), ("É🙂",)]),
        ("stripText", {}, [("aB|cD",), ("",), (None,), ("é🙂",)]),
        ("splitText", {"delimiter": "|", "index": 1}, [("cD ",), (None,), (None,), (None,)]),
        (
            "splitTextColumns",
            {"delimiter": "|", "newColumns": ["first", "second"]},
            [(" aB", "cD "), ("", None), (None, None), ("é🙂", None)],
        ),
        ("findReplace", {"find": "B", "replacement": "!"}, [(" a!|cD ",), ("",), (None,), ("é🙂",)]),
        (
            "findReplace",
            {"find": "[A-Z]", "replacement": "!", "regex": True},
            [(" a!|c! ",), ("",), (None,), ("é🙂",)],
        ),
        (
            "findReplace",
            {"find": "", "replacement": "-"},
            [("- -a-B-|-c-D- -",), ("-",), (None,), ("-é-🙂-",)],
        ),
    ],
)
def test_duckdb_text_primitives_preserve_caller_functions_and_retained_results(
    kind: str, params: dict[str, Any], expected: list[tuple[str | None, ...]]
) -> None:
    engine = DuckDBEngine()
    with duckdb.connect() as connection:
        try:
            connection.execute(
                "CREATE TABLE text_source AS SELECT * FROM (VALUES "
                "(0, ' aB|cD '), (1, ''), (2, NULL), (3, 'é🙂')) input(id,text)"
            )
            connection.execute(
                "CREATE MACRO caller_text(x) AS CASE WHEN x IS NULL THEN 'caller-null' ELSE 'caller-value' END"
            )
            connection.execute("CREATE TEMP VIEW ow AS SELECT 123 AS sentinel")
            source = connection.sql("SELECT *, caller_text(text) AS declared FROM text_source ORDER BY id")
            before = source.fetchall()
            catalog_sql = "SELECT view_name,view_oid FROM system.main.duckdb_views() WHERE NOT internal ORDER BY ALL"
            views = connection.sql(catalog_sql).fetchall()
            operation = bound_step(
                kind,
                column=bound_ref("c:source:1", "text", 1),
                **({"newColumn": "output"} if kind != "splitTextColumns" else {}),
                **params,
            )
            live = generated = None
            for marker in ("first", "second"):
                for signature, body in (
                    ("lower(x)", f"'{marker}'"),
                    ("upper(x)", f"'{marker}'"),
                    ("substr(x, y)", f"'{marker}'"),
                    ("trim(x, y)", f"'{marker}'"),
                    ("string_split(x, y)", f"['{marker}']"),
                    ("array_extract(x, y)", f"'{marker}'"),
                    ("list_extract(x, y)", f"'{marker}'"),
                    ("replace(x, y, z)", f"'{marker}'"),
                    ("regexp_replace(x, y, z, w)", f"'{marker}'"),
                    ('"||"(x, y)', f"'{marker}'"),
                    ("array_to_string(x, y)", f"'{marker}'"),
                    ("len(x)", "0"),
                    ("list_aggr(x, y, z)", f"'{marker}'"),
                    ("string_agg(x, y)", f"'{marker}'"),
                ):
                    connection.execute(f"CREATE OR REPLACE MACRO {signature} AS {body}")
                if live is None:
                    live = engine.apply_transform(engine.normalize_notebook_relation(source), operation)
                    generated = execute_generated(engine, source, [operation])
                assert generated is not None
                expected_rows = [(*row, *values) for row, values in zip(before, expected, strict=True)]
                assert engine._terminal_rows(live, "SELECT * FROM ow ORDER BY id") == expected_rows
                assert generated.order("id").fetchall() == expected_rows
                expected_columns = ["id", "text", "declared", *params.get("newColumns", ["output"])]
                assert live.columns == generated.columns == expected_columns
                expected_types = ["INTEGER", *("VARCHAR" for _ in expected_columns[1:])]
                assert list(map(str, live.types)) == list(map(str, generated.types)) == expected_types
                assert source.fetchall() == before
                assert connection.sql("SELECT lower('ALPHA'), caller_text(NULL)").fetchone() == (marker, "caller-null")
            engine.close()
            assert connection.sql(catalog_sql).fetchall() == views
            assert connection.sql("SELECT sentinel FROM ow").fetchone() == (123,)
            assert connection.sql("SELECT * FROM text_source ORDER BY id").fetchall() == [row[:2] for row in before]
        finally:
            engine.close()


@pytest.mark.parametrize(
    ("replacement", "expected"),
    [
        ("\\", ["\\a\\b\\", "\\", None, "\\é\\🙂\\"]),
        (r"\1", [r"\1a\1b\1", r"\1", None, r"\1é\1🙂\1"]),
        ("$1", ["$1a$1b$1", "$1", None, "$1é$1🙂$1"]),
        ("\0'\\", ["\0'\\a\0'\\b\0'\\", "\0'\\", None, "\0'\\é\0'\\🙂\0'\\"]),
    ],
)
def test_duckdb_empty_literal_find_replaces_boundaries_and_matches_generated_code(
    replacement: str, expected: list[str | None]
) -> None:
    engine = DuckDBEngine()
    frame = duckdb.sql("SELECT * FROM (VALUES ('ab'), (''), (NULL), ('é🙂')) AS source(text)")
    before = rows(frame)
    operation = bound_step(
        "findReplace",
        column=bound_ref("c:source:0", "text", 0),
        find="",
        replacement=replacement,
        regex=False,
        newColumn="expanded",
    )

    try:
        transformed = engine.apply_transform(frame, operation)
        generated = execute_generated(engine, frame, [operation])

        assert [row["expanded"] for row in records(transformed)] == expected
        assert_same_relation(transformed, generated)
        assert list(map(str, transformed.types)) == list(map(str, generated.types)) == ["VARCHAR", "VARCHAR"]
        assert rows(frame) == before
    finally:
        engine.close()


def install_conversion_guards(monkeypatch: pytest.MonkeyPatch) -> None:
    def reject_conversion(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("DuckDB operations must never convert to Pandas, Polars, or Arrow")

    for method in ("df", "to_df", "fetchdf", "pl", "arrow"):
        monkeypatch.setattr(duckdb.DuckDBPyRelation, method, reject_conversion)


def test_duckdb_rejects_case_fold_ambiguous_source_columns() -> None:
    engine = DuckDBEngine()
    ambiguous = duckdb.sql('SELECT 1 AS "A", 2 AS "a"')

    with pytest.raises(EngineError, match="differ only by case"):
        engine.validate_column_addressability(ambiguous)


def test_duckdb_page_bounds_fetched_varchar_without_changing_source_queries(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = DuckDBEngine()
    exact = "🙂e\u0301\0" * 16_384
    fetched: list[list[tuple[Any, ...]]] = []
    queries: list[str] = []
    native_execute_rows = duckdb_runtime._execute_rows

    def observe_fetch(connection: Any, source_sql: str, query: str) -> list[tuple[Any, ...]]:
        records = native_execute_rows(connection, source_sql, query)
        fetched.append(records)
        queries.append(query)
        return records

    monkeypatch.setattr(duckdb_runtime, "_execute_rows", observe_fetch)
    try:
        source = engine._relation_from_sql(
            'SELECT id, value AS "text "" exact", repeat(\'u\', 262144) AS unselected FROM (VALUES '
            "(0, repeat('x', 262144) || 'TAIL'), "
            "(1, repeat('🙂é' || chr(0), 16384)), (2, NULL::VARCHAR), (3, ''), "
            "(4, repeat('x', 262144) || 'TAIL')) source(id, value)"
        )
        frame = engine.ensure_row_ids(source, "bounded-text")
        page = engine.page(frame, 1, 4, total_rows=5, column_projection=[(1, "stable:text")])

        # Inspect native fetch output before normalize_cell can change it.
        assert [[None if row[1] is None else len(row[1]) for row in batch] for batch in fetched] == [
            [65_536, None, 0, 65_537]
        ]
        assert len(queries) == 1 and "unselected" not in queries[0]
        assert page["columnIds"] == ["stable:text"]
        assert [row["rowNumber"] for row in page["rows"]] == [1, 2, 3, 4]
        cells = [row["values"][0] for row in page["rows"]]
        assert [cell["raw"] for cell in cells] == [exact, None, "", "x" * 65_537]
        assert [cell["display"] for cell in cells] == [exact, "", "", "x" * 65_537]
        assert [cell["kind"] for cell in cells] == ["string", "null", "string", "string"]

        filtered = engine.apply_filter_model(
            frame,
            {
                "filters": [
                    {
                        "column": 'text " exact',
                        "type": "string",
                        "predicates": [{"kind": "predicate", "operator": "endsWith", "value": "TAIL"}],
                    }
                ],
                "sort": [{"column": "id", "direction": "asc", "nulls": "last"}],
            },
        )
        safe = engine.page(filtered, 0, 2, total_rows=2, column_projection=[(0, "stable:id")])
        assert [row["values"][0]["raw"] for row in safe["rows"]] == [0, 4]
        assert len(queries) == 2 and '"text "" exact"' not in queries[-1] and "unselected" not in queries[-1]
        assert engine._terminal_scalar(source, 'SELECT length("text "" exact") FROM ow WHERE id = 4') == 262_148
    finally:
        engine.close()


def test_duckdb_page_bounds_fetched_blobs_without_changing_source_queries(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = DuckDBEngine()
    exact = b"\x00\xff" * 24_576
    overflow = exact + b"\x00"
    fetched: list[list[tuple[Any, ...]]] = []
    queries: list[str] = []
    native_execute_rows = duckdb_runtime._execute_rows

    def observe_fetch(connection: Any, source_sql: str, query: str) -> list[tuple[Any, ...]]:
        records = native_execute_rows(connection, source_sql, query)
        fetched.append(records)
        queries.append(query)
        return records

    monkeypatch.setattr(duckdb_runtime, "_execute_rows", observe_fetch)
    install_conversion_guards(monkeypatch)
    try:
        source = engine._relation_from_sql(
            'SELECT id, value AS "blob "" exact", from_hex(repeat(\'aa\', 262144)) AS unselected FROM (VALUES '
            "(0, from_hex(repeat('00ff', 131072))), "
            "(1, from_hex(repeat('00ff', 24576))), (2, NULL::BLOB), (3, ''::BLOB), "
            "(4, from_hex(repeat('00ff', 24576) || '00')), "
            "(5, from_hex(repeat('00ff', 131072)))) source(id, value) ORDER BY id"
        )
        frame = engine.ensure_row_ids(source, "bounded-binary")
        page = engine.page(frame, 1, 5, total_rows=6, column_projection=[(1, "stable:blob")])

        # These are actual native bytes before base64 normalization.
        assert [[None if row[1] is None else len(row[1]) for row in batch] for batch in fetched] == [
            [49_152, None, 0, 49_153, 49_153]
        ]
        assert [row[1] for row in fetched[0]] == [exact, None, b"", overflow, overflow]
        assert len(queries) == 1 and "unselected" not in queries[0]
        assert page["columnIds"] == ["stable:blob"]
        assert [row["rowNumber"] for row in page["rows"]] == [1, 2, 3, 4, 5]
        assert [row["id"].rsplit(":", 1)[-1] for row in page["rows"]] == ["1", "2", "3", "4", "5"]
        cells = [row["values"][0] for row in page["rows"]]
        encoded = [
            b64encode(value).decode("ascii") if value is not None else None
            for value in [exact, None, b"", overflow, overflow]
        ]
        assert [cell["raw"] for cell in cells] == encoded
        assert [cell["display"] for cell in cells] == [value or "" for value in encoded]
        assert [cell["kind"] for cell in cells] == ["binary", "null", "binary", "binary", "binary"]

        filtered = engine.apply_filter_model(
            frame,
            {
                "filters": [
                    {
                        "column": 'blob " exact',
                        "type": "binary",
                        "predicates": [{"kind": "predicate", "operator": "isNotNull"}],
                    }
                ],
                "sort": [{"column": "id", "direction": "desc", "nulls": "last"}],
            },
        )
        safe = engine.page(filtered, 0, 5, total_rows=5, column_projection=[(0, "stable:id")])
        assert [row["values"][0]["raw"] for row in safe["rows"]] == [5, 4, 3, 1, 0]
        assert len(queries) == 2 and '"blob "" exact"' not in queries[-1] and "unselected" not in queries[-1]
        assert engine._terminal_scalar(source, 'SELECT octet_length("blob "" exact") FROM ow WHERE id = 5') == 262_144
    finally:
        engine.close()


@pytest.mark.parametrize("container", ["scalar", "list", "union-map"])
def test_duckdb_page_uses_an_explicit_terminal_projection(monkeypatch: pytest.MonkeyPatch, container: str) -> None:
    engine = DuckDBEngine()
    frame = engine.ensure_row_ids(source_relation(), "projected-page")
    queries: list[str] = []
    terminal_timezones: list[str] = []
    native_execute_rows = duckdb_runtime._execute_rows

    def capture_query(connection: Any, source_sql: str, query: str) -> list[tuple[Any, ...]]:
        queries.append(query)
        terminal_timezones.append(str(connection.execute("SELECT current_setting('TimeZone')").fetchone()[0]))
        return native_execute_rows(connection, source_sql, query)

    monkeypatch.setattr(duckdb_runtime, "_execute_rows", capture_query)

    page = engine.page(
        frame,
        0,
        2,
        total_rows=4,
        column_projection=[(1, "stable:text"), (4, "stable:other")],
    )

    assert len(queries) == 1
    assert queries[0].startswith("SELECT ")
    assert "SELECT *" not in queries[0].upper()
    assert '"text"' in queries[0] and '"other"' in queries[0]
    assert '"group"' not in queries[0] and '"value"' not in queries[0]
    assert page["columnIds"] == ["stable:text", "stable:other"]
    assert [cell["display"] for cell in page["rows"][0]["values"]] == [" alpha-one ", "2"]
    assert terminal_timezones == ["UTC"]

    formatted: list[str] = []
    native_connect = duckdb_runtime._connect
    native_text = duckdb_runtime._duckdb_timestamp_ns_text

    def observe_text(value: str) -> str:
        formatted.append(value)
        return value

    def observing_connect() -> Any:
        connection = native_connect()
        connection.create_function("observe_ns_text", observe_text, ["VARCHAR"], "VARCHAR", side_effects=True)
        return connection

    monkeypatch.setattr(duckdb_runtime, "_connect", observing_connect)
    monkeypatch.setattr(
        duckdb_runtime, "_duckdb_timestamp_ns_text", lambda identifier: f"observe_ns_text({native_text(identifier)})"
    )
    try:
        value = "make_timestamp_ns(1704161045123000000 + i * 1001)"
        if container == "list":
            value = f"[{value}]"
        elif container == "union-map":
            value = f"map([union_value(text := 'key')::UNION(text VARCHAR)], [{value}])"
        source = engine._relation_from_sql(
            f"SELECT i, {value} AS __ow_value_count, make_timestamp_ns(-1) AS unselected, "
            "map([union_value(text := 'first')::UNION(text VARCHAR), "
            "union_value(text := 'second')::UNION(text VARCHAR)], [1,2]) AS other_map FROM range(100) source(i)"
        )
        source = engine.ensure_row_ids(source, "bounded-ns")
        bounded = engine.page(source, 20, 7, total_rows=100, column_projection=[(1, "stable:ns")])
        assert len(formatted) == 7
        assert bounded["columnIds"] == ["stable:ns"] and len(bounded["rows"]) == 7
        assert all(len(row["values"]) == 1 for row in bounded["rows"])
        assert "unselected" not in queries[-1]
        formatted.clear()
        identities = engine.page(source, 20, 7, total_rows=100, column_projection=[])
        assert not formatted
        assert [row["id"] for row in identities["rows"]] == [row["id"] for row in bounded["rows"]]
        assert all(row["values"] == [] for row in identities["rows"])
        values, more = engine.column_values(source, "__ow_value_count", limit=3)
        assert len(values) == 3 and more
        assert len(formatted) == 4  # Three choices plus the existing hasMore sentinel.
        formatted.clear()
        summary = engine.summaries(source, [(1, "stable:ns")])[0]
        assert summary["totalCount"] == summary["distinctCount"] == 100
        assert len(summary["topValues"]) == 10
        assert len(formatted) == (12 if container == "scalar" else 10)  # Scalar extrema add two reduced values.
        assert engine._terminal_scalar(source, "SELECT sum(i) FROM ow") == 4950
        if container == "union-map":
            reordered = engine.page(source, 20, 7, total_rows=100, column_projection=[(3, "other"), (1, "map")])
            assert reordered["columnIds"] == ["other", "map"]
            assert [row["id"] for row in reordered["rows"]] == [row["id"] for row in bounded["rows"]]
            for row, original in zip(reordered["rows"], bounded["rows"], strict=True):
                assert row["values"][0]["raw"] == {"first": 1, "second": 2}
                assert row["values"][1] == original["values"][0]
    finally:
        engine.close()


@pytest.mark.parametrize(
    ("source_sql", "expected_counts"),
    [
        pytest.param(
            """
            SELECT * FROM (VALUES
                (1::BIGINT, 1.25::DECIMAL(10, 2), 1.0::DOUBLE),
                (1::BIGINT, 1.25::DECIMAL(10, 2), 1.0::DOUBLE),
                (NULL::BIGINT, NULL::DECIMAL(10, 2), NULL::DOUBLE),
                (2::BIGINT, 2.50::DECIMAL(10, 2), 'NaN'::DOUBLE),
                (2::BIGINT, 2.50::DECIMAL(10, 2), 'NaN'::DOUBLE),
                (3::BIGINT, 3.75::DECIMAL(10, 2), 'Infinity'::DOUBLE),
                (3::BIGINT, 3.75::DECIMAL(10, 2), 'Infinity'::DOUBLE),
                (4::BIGINT, 4.00::DECIMAL(10, 2), '-Infinity'::DOUBLE),
                (4::BIGINT, 4.00::DECIMAL(10, 2), '-Infinity'::DOUBLE),
                (5::BIGINT, 5.00::DECIMAL(10, 2), -0.0::DOUBLE),
                (5::BIGINT, 5.00::DECIMAL(10, 2), 0.0::DOUBLE)
            ) AS source(integer_value, decimal_value, float_value)
            """,
            {"missingCells": 5, "missingRows": 3, "duplicateRows": 5},
            id="numeric-null-nan-infinity-signed-zero-decimal",
        ),
        pytest.param(
            """
            SELECT * FROM (VALUES
                (DATE '2024-03-31', TIMESTAMP '2024-03-31 01:30:00',
                    TIMESTAMPTZ '2024-03-31 01:30:00+01:00'),
                (DATE '2024-03-31', TIMESTAMP '2024-03-31 01:30:00',
                    TIMESTAMPTZ '2024-03-31 00:30:00+00:00'),
                (NULL::DATE, NULL::TIMESTAMP, NULL::TIMESTAMPTZ),
                (NULL::DATE, NULL::TIMESTAMP, NULL::TIMESTAMPTZ)
            ) AS source(date_value, timestamp_value, zoned_value)
            """,
            {"missingCells": 6, "missingRows": 2, "duplicateRows": 2},
            id="date-timestamp-utc-normalization",
        ),
    ],
)
def test_duckdb_header_stats_use_one_source_execution_with_exact_existing_semantics(
    monkeypatch: pytest.MonkeyPatch,
    source_sql: str,
    expected_counts: dict[str, int],
) -> None:
    engine = DuckDBEngine()
    frame = duckdb.sql(source_sql)
    reference = reference_header_stats(engine, frame)
    row_queries: list[str] = []
    scalar_queries: list[str] = []
    terminal_threads: list[int] = []
    native_execute_rows = duckdb_runtime._execute_rows
    native_execute_scalar = duckdb_runtime._execute_scalar

    def capture_rows(connection: Any, plan_sql: str, query: str) -> list[tuple[Any, ...]]:
        row_queries.append(query)
        terminal_threads.append(int(connection.execute("SELECT current_setting('threads')").fetchone()[0]))
        return native_execute_rows(connection, plan_sql, query)

    def capture_scalar(connection: Any, plan_sql: str, query: str) -> Any:
        scalar_queries.append(query)
        return native_execute_scalar(connection, plan_sql, query)

    monkeypatch.setattr(duckdb_runtime, "_execute_rows", capture_rows)
    monkeypatch.setattr(duckdb_runtime, "_execute_scalar", capture_scalar)
    try:
        actual = engine.header_stats(frame)
    finally:
        engine.close()

    assert actual == reference
    assert {key: actual[key] for key in expected_counts} == expected_counts
    assert json.dumps(actual, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True).encode(
        "utf-8"
    ) == json.dumps(reference, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True).encode(
        "utf-8"
    )
    assert len(row_queries) == 1
    assert scalar_queries == []
    assert terminal_threads == [1]
    assert "GROUP BY" in row_queries[0]


def test_duckdb_header_stats_thread_pin_is_request_local_and_connection_closes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = DuckDBEngine()
    frame = engine.normalize(
        duckdb.sql("SELECT * FROM (VALUES (1, NULL::DOUBLE), (1, 'NaN'::DOUBLE)) AS source(key, value)")
    )
    native_connect = duckdb_runtime._connect
    connections: list[Any] = []
    set_queries: list[str] = []
    observed_threads: list[int] = []

    class TrackedConnection:
        def __init__(self) -> None:
            self.inner = native_connect()
            self.closed = False
            connections.append(self)

        def execute(self, query: str, *args: Any, **kwargs: Any) -> Any:
            if query.strip().casefold() == "set threads = 1":
                set_queries.append(query)
            result = self.inner.execute(query, *args, **kwargs)
            if query.strip().casefold() == "set threads = 1":
                observed_threads.append(int(self.inner.execute("SELECT current_setting('threads')").fetchone()[0]))
            return result

        def close(self) -> None:
            self.inner.close()
            self.closed = True

        def __getattr__(self, name: str) -> Any:
            return getattr(self.inner, name)

    monkeypatch.setattr(duckdb_runtime, "_connect", TrackedConnection)
    stats = engine.header_stats(frame)

    assert stats["missingCells"] == 2
    assert set_queries == ["SET threads = 1"]
    assert observed_threads == [1]
    assert len(connections) == 1
    assert connections[0].closed is True
    with pytest.raises(duckdb.ConnectionException, match="closed"):
        connections[0].inner.execute("SELECT 1")
    with engine._lifecycle_lock:
        assert engine._active_connections == set()
    engine.close()


def test_duckdb_notebook_header_stats_keep_two_queries_without_mutating_user_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_connection = duckdb.connect()
    relation = user_connection.sql(
        "SELECT * FROM (VALUES (1, 1.0::DOUBLE), (1, 1.0::DOUBLE), "
        "(NULL::BIGINT, 'NaN'::DOUBLE), (NULL::BIGINT, 'NaN'::DOUBLE)) AS source(key, value)"
    )
    engine = DuckDBEngine()
    frame = engine.normalize_notebook_relation(relation)
    initial_thread_row = user_connection.execute("SELECT current_setting('threads')").fetchone()
    assert initial_thread_row is not None
    initial_threads = int(initial_thread_row[0])
    row_queries: list[str] = []
    scalar_queries: list[str] = []
    terminal_statements: list[str] = []
    native_execute_rows = duckdb_runtime._execute_rows
    native_execute_scalar = duckdb_runtime._execute_scalar
    native_terminal_execute = duckdb_runtime._DuckDBNotebookTerminal.execute

    def capture_rows(connection: Any, plan_sql: str, query: str) -> list[tuple[Any, ...]]:
        row_queries.append(query)
        return native_execute_rows(connection, plan_sql, query)

    def capture_scalar(connection: Any, plan_sql: str, query: str) -> Any:
        scalar_queries.append(query)
        return native_execute_scalar(connection, plan_sql, query)

    def capture_terminal_execute(terminal: Any, query: str) -> Any:
        terminal_statements.append(query)
        return native_terminal_execute(terminal, query)

    monkeypatch.setattr(duckdb_runtime, "_execute_rows", capture_rows)
    monkeypatch.setattr(duckdb_runtime, "_execute_scalar", capture_scalar)
    monkeypatch.setattr(duckdb_runtime._DuckDBNotebookTerminal, "execute", capture_terminal_execute)
    try:
        actual = engine.header_stats(frame)
        assert actual == {
            "missingCells": 4,
            "missingRows": 2,
            "duplicateRows": 2,
            "missingValuesByColumn": [
                {"column": "key", "count": 2},
                {"column": "value", "count": 2},
            ],
        }
        assert len(row_queries) == 1
        assert len(scalar_queries) == 1
        assert len(terminal_statements) == 2
        assert all("SET threads" not in statement for statement in terminal_statements)
        current_thread_row = user_connection.execute("SELECT current_setting('threads')").fetchone()
        assert current_thread_row is not None
        assert int(current_thread_row[0]) == initial_threads
    finally:
        engine.close()
        relation = None
        assert user_connection.execute("SELECT 1").fetchone() == (1,)
        user_connection.close()


def test_duckdb_header_stats_keep_unique_wide_groups_inside_one_native_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = DuckDBEngine()
    wide_columns = ", ".join(
        f"CASE WHEN i % {modulus} = 0 THEN NULL ELSE i + {modulus} END AS value_{modulus}" for modulus in range(2, 34)
    )
    frame = duckdb.sql(
        f"SELECT i AS unique_key, {wide_columns} FROM range(2048) AS source(i), range(2) AS duplicate(copy)"
    )
    reference = reference_header_stats(engine, frame)
    row_queries: list[str] = []
    result_sizes: list[int] = []
    native_execute_rows = duckdb_runtime._execute_rows

    def capture_rows(connection: Any, plan_sql: str, query: str) -> list[tuple[Any, ...]]:
        row_queries.append(query)
        result = native_execute_rows(connection, plan_sql, query)
        result_sizes.append(len(result))
        return result

    monkeypatch.setattr(duckdb_runtime, "_execute_rows", capture_rows)
    try:
        actual = engine.header_stats(frame)
    finally:
        engine.close()

    assert actual == reference
    assert actual["duplicateRows"] == 2048
    assert json.dumps(actual, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True).encode(
        "utf-8"
    ) == json.dumps(reference, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True).encode(
        "utf-8"
    )
    assert len(row_queries) == 1
    assert result_sizes == [1]


def test_duckdb_header_stats_zero_visible_columns_use_one_count(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "empty.csv"
    source.write_bytes(b"")
    engine = DuckDBEngine()
    frame = engine.read_file(str(source))
    scalar_queries: list[str] = []
    native_execute_scalar = duckdb_runtime._execute_scalar

    def capture_scalar(connection: Any, plan_sql: str, query: str) -> Any:
        scalar_queries.append(query)
        return native_execute_scalar(connection, plan_sql, query)

    monkeypatch.setattr(duckdb_runtime, "_execute_scalar", capture_scalar)
    try:
        actual = engine.header_stats(frame)
    finally:
        engine.close()

    assert actual == {
        "missingCells": 0,
        "missingRows": 0,
        "duplicateRows": 0,
        "missingValuesByColumn": [],
    }
    assert scalar_queries == ["SELECT system.main.count(*) FROM ow"]


@pytest.mark.parametrize(
    ("selected_name", "sibling_name"),
    [
        *[(f"sample[ab].{suffix}", f"samplea.{suffix}") for suffix in ("csv", "tsv", "jsonl", "ndjson", "parquet")],
        ("parent[ab]/sample.csv", "parenta/sample.csv"),
        ("open[.csv", "other.csv"),
        ("close].csv", "other.csv"),
        ("paren(.csv", "other.csv"),
        pytest.param("star*.csv", "star-other.csv", marks=pytest.mark.skipif(os.name == "nt", reason="Unix filename.")),
        pytest.param(
            "question?.csv", "questionX.csv", marks=pytest.mark.skipif(os.name == "nt", reason="Unix filename.")
        ),
    ],
)
def test_duckdb_literal_selected_file_readers_and_generated_source(
    selected_name: str, sibling_name: str, tmp_path: Path
) -> None:
    selected = tmp_path / selected_name
    options: dict[str, Any] = (
        {"delimiter": ";", "quoteChar": "'", "hasHeader": True} if selected.suffix == ".csv" else {}
    )
    before: dict[Path, bytes] = {}

    def write_source(path: Path, chosen: bool) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        values = [("selected\nline", 1), (None, 2)] if chosen else [("wrong sibling", 99)]
        if path.suffix in {".csv", ".tsv"}:
            delimiter, quote = (";", "'") if path.suffix == ".csv" else ("\t", '"')
            path.write_text(
                f"note{delimiter}count\n"
                + "".join(
                    f"{quote + note + quote if note is not None else ''}{delimiter}{count}\n" for note, count in values
                ),
                encoding="utf-8",
                newline="",
            )
        elif path.suffix in {".jsonl", ".ndjson"}:
            path.write_text(
                "".join(json.dumps({"note": note, "count": count}) + "\n" for note, count in values),
                encoding="utf-8",
                newline="",
            )
        else:
            with duckdb.connect() as connection:
                relation = connection.sql(
                    "SELECT 'selected' || chr(10) || 'line' AS note, 1::BIGINT AS count UNION ALL SELECT NULL, 2"
                    if chosen
                    else "SELECT 'wrong sibling' AS note, 99::BIGINT AS count"
                )
                relation.write_parquet(str(path))
        before[path] = path.read_bytes()

    write_source(selected, True)
    write_source(tmp_path / sibling_name, False)
    escaped_spelling = Path(glob.escape(str(selected)))
    if escaped_spelling != selected:
        write_source(escaped_spelling, False)
    engine = DuckDBEngine()
    try:
        frame = engine.read_file(str(selected), options)
        assert isinstance(frame, DuckDBSqlPlan)
        assert frame.columns == ["note", "count"]
        assert frame.types == ["VARCHAR", "BIGINT"]
        assert rows(frame) == [("selected\nline", 1), (None, 2)]
        assert engine.shape(frame) == {"rows": 2, "columns": 2}
        operation = bound_step("renameColumn", column=bound_ref("c:source:0", "note", 0), newName="renamed")
        live = engine.apply_transform(frame, operation)
        with duckdb.connect() as connection:
            source = connection.sql(frame.sql_query())
            generated = execute_generated(engine, source, [operation])
            assert_same_relation(live, generated)
            assert generated.columns == ["renamed", "count"]
            assert [str(dtype) for dtype in generated.types] == ["VARCHAR", "BIGINT"]
            assert source.fetchall() == [("selected\nline", 1), (None, 2)]
            assert connection.sql("SELECT 1").fetchone() == (1,)
        assert all(path.read_bytes() == content for path, content in before.items())
    finally:
        engine.close()


def test_duckdb_literal_selected_file_public_source_and_blank(tmp_path: Path) -> None:
    selected = tmp_path / "sample[ab].csv"
    content = b"value\n17\n18\n"
    selected.write_bytes(content)
    (tmp_path / "samplea.csv").write_bytes(b"value\n99\n")
    escaped_spelling = Path(glob.escape(str(selected)))
    escaped_spelling.write_bytes(b"value\n100\n")
    source = {"kind": "file", "label": selected.name, "path": str(selected)}
    manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))
    try:
        opened = manager.open_session(source, backend="duckdb", page_size=2)
        assert opened["metadata"]["source"] == source
        assert opened["metadata"]["shape"] == {"rows": 2, "columns": 1}
        assert [row["values"][0]["raw"] for row in opened["page"]["rows"]] == [17, 18]
        assert selected.read_bytes() == content
    finally:
        manager.close_all()
    selected.unlink()
    manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))
    try:
        with pytest.raises(EngineError, match="Could not read"):
            manager.open_session(source, backend="duckdb")
        assert not manager.sessions
    finally:
        manager.close_all()
    selected.write_bytes(b"\xef\xbb\xbf")
    engine = DuckDBEngine()
    try:
        assert engine.shape(engine.read_file(str(selected))) == {"rows": 0, "columns": 0}
        assert selected.read_bytes() == b"\xef\xbb\xbf"
    finally:
        engine.close()


@pytest.mark.skipif(os.name == "nt", reason="Unix backslash filename.")
@pytest.mark.parametrize("name", ["back\\slash.csv", "back\\slash[ab].csv"])
def test_duckdb_literal_selected_file_unix_backslash(tmp_path: Path, name: str) -> None:
    selected = tmp_path / name
    selected.write_bytes(b"value\n17\n")
    escaped_spelling = Path(glob.escape(str(selected)))
    if escaped_spelling != selected:
        escaped_spelling.write_bytes(b"value\n99\n")
    engine = DuckDBEngine()
    try:
        if "[" in name:
            with pytest.raises(EngineError, match="Unix.*backslash.*glob"):
                engine.read_file(str(selected))
        else:
            assert rows(engine.read_file(str(selected))) == [(17,)]
        assert selected.read_bytes() == b"value\n17\n"
    finally:
        engine.close()


@pytest.mark.skipif(os.name == "nt", reason="Unix native path splitting.")
@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("/first[ab]/tail[ab]/sample?.csv", "/first[ab]/tail[[]ab]/sample[?].csv"),
        ("//first[ab]/sample*.csv", "//first[ab]/sample[*].csv"),
        ("/sample[ab].csv", "/sample[ab].csv"),
        ("relative[ab]/sample?.csv", "relative[[]ab]/sample[?].csv"),
    ],
)
def test_duckdb_literal_selected_file_unix_components(path: str, expected: str) -> None:
    assert duckdb_runtime._literal_file_path(path) == expected


@pytest.mark.skipif(os.name != "nt", reason="Native Windows drive and share parsing.")
@pytest.mark.parametrize(
    "path",
    [
        r"\\server[ab]\share\source.csv",
        r"\\server\share[ab]\source.csv",
        r"\\?\C:\source.csv",
        r"\\.\share[ab]\source.csv",
    ],
)
def test_duckdb_literal_selected_file_windows_anchor_refusal(path: str) -> None:
    with pytest.raises(EngineError, match="Windows.*glob"):
        duckdb_runtime._literal_file_path(path)


@pytest.mark.parametrize(
    ("suffix", "delimiter"),
    [(".csv", ","), (".tsv", "\t")],
)
@pytest.mark.parametrize("has_header", [True, False], ids=["header", "headerless"])
def test_duckdb_delimited_hash_records_survive_pages_and_cleaning(
    tmp_path: Path, suffix: str, delimiter: str, has_header: bool
) -> None:
    path = tmp_path / f"hash-records{suffix}"
    contents = (
        (f"label{delimiter}value\n" if has_header else "") + f"1{delimiter}2\n#retained{delimiter}3\n4{delimiter}5\n"
    ).encode("utf-8")
    path.write_bytes(contents)
    before = path.stat()
    options = {"delimiter": delimiter, "hasHeader": has_header}
    expected = [("1", 2), ("#retained", 3), ("4", 5)]
    names = ["label", "value"] if has_header else ["column0", "column1"]
    manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))
    try:
        opened = manager.open_session(
            {"kind": "file", "label": path.name, "path": str(path), "importOptions": options},
            backend="duckdb",
            page_size=1,
        )
        metadata = opened["metadata"]
        session_id = metadata["sessionId"]
        session = manager.sessions[session_id]
        assert metadata["shape"] == {"rows": 3, "columns": 2}
        assert metadata["source"]["importOptions"] == options
        assert [column["name"] for column in metadata["schema"]] == names
        assert [cell["raw"] for cell in opened["page"]["rows"][0]["values"]] == list(expected[0])
        later = manager.get_page(session_id, 0, 1, 2, {"filters": [], "sort": []})
        assert [tuple(cell["raw"] for cell in row["values"]) for row in later["page"]["rows"]] == expected[1:]
        value_column = metadata["schema"][1]
        operation = step(
            "formula",
            leftColumn={"id": value_column["id"], "name": value_column["name"]},
            operator="multiply",
            value=10,
            newColumn="score",
        )
        preview = manager.preview_step(session_id, 0, operation, 0, 10)
        applied = manager.apply_draft(session_id, preview["revision"], 0, 10)
        cleaned = [(label, value, value * 10) for label, value in expected]
        for response in (preview, applied):
            assert response["metadata"]["shape"] == {"rows": 3, "columns": 3}
            assert [tuple(cell["raw"] for cell in row["values"]) for row in response["page"]["rows"]] == cleaned
        namespace: dict[str, Any] = {}
        exec(compile(applied["code"], "<hash-record-cleaning>", "exec"), namespace)
        assert isinstance(session.engine, DuckDBEngine)
        with duckdb_runtime._connect() as connection:
            source = connection.sql(session.engine._visible_relation(session.original).sql_query())
            generated = namespace["clean_data"](source)
            assert generated.columns == [*names, "score"]
            assert [str(dtype) for dtype in generated.types] == ["VARCHAR", "BIGINT", "BIGINT"]
            assert generated.fetchall() == cleaned
            assert source.fetchall() == expected
    finally:
        manager.close_all()
    assert manager.sessions == {}
    after = path.stat()
    assert path.read_bytes() == contents
    assert (after.st_ino, after.st_size, after.st_mtime_ns) == (before.st_ino, before.st_size, before.st_mtime_ns)


@pytest.mark.parametrize(
    ("suffix", "contents", "options", "message"),
    [
        (".csv", b"first,record\na,b,c\nx,y,z\np,q,r\n", {"hasHeader": True}, "could not open"),
        (".csv", b"first,record\na,b,c\nx,y,z\np,q,r\n", {"hasHeader": False}, "could not open"),
        (".tsv", b"first\trecord\na\tb\tc\nx\ty\tz\np\tq\tr\n", {"hasHeader": True}, "could not open"),
        (".tsv", b"first\trecord\na\tb\tc\nx\ty\tz\np\tq\tr\n", {"hasHeader": False}, "could not open"),
        (".csv", b"\na,b\nx,y\nz,w\n", {"hasHeader": True}, "initial line break"),
        (".csv", b"\ra,b\rx,y\rz,w\r", {"hasHeader": False}, "initial line break"),
        (".csv", b"\xef\xbb\xbf\na,b\nx,y\nz,w\n", {"hasHeader": True}, "initial line break"),
        (".csv", b"\na,b\n1,2\n3,4\n", {"hasHeader": False, "delimiter": "\n"}, "initial line break"),
        (
            ".csv",
            b'\xef\xbb\xbf"first\nline";value\n"left\nright";2\nlast;3\n',
            {"delimiter": ";", "hasHeader": True},
            "could not open",
        ),
    ],
    ids=[
        "csv-header",
        "csv-headerless",
        "tsv-header",
        "tsv-headerless",
        "lf-text",
        "cr-text",
        "bom-lf",
        "lf-delimiter",
        "bom-quoted-header",
    ],
)
def test_duckdb_delimited_preambles_refuse_before_session_publication(
    tmp_path: Path, suffix: str, contents: bytes, options: dict[str, Any], message: str
) -> None:
    path = tmp_path / f"preamble{suffix}"
    path.write_bytes(contents)
    before = path.stat()
    engines: list[DuckDBEngine] = []

    def create_engine() -> DuckDBEngine:
        engine = DuckDBEngine()
        engines.append(engine)
        return engine

    manager = SessionManager(EngineRegistry((("duckdb", create_engine),)))
    try:
        with pytest.raises(EngineError, match=message):
            manager.open_session(
                {"kind": "file", "label": path.name, "path": str(path), "importOptions": options},
                backend="duckdb",
                page_size=1,
            )
        assert manager.sessions == {}
        assert engines and all(engine._closed and not engine._active_connections for engine in engines)
    finally:
        manager.close_all()
    after = path.stat()
    assert path.read_bytes() == contents
    assert (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) == (
        before.st_dev,
        before.st_ino,
        before.st_size,
        before.st_mtime_ns,
    )


@pytest.mark.parametrize(
    ("suffix", "contents", "options", "names", "types", "expected"),
    [
        (
            ".csv",
            b" first,2\nlast,3\n",
            {"hasHeader": False},
            ["column0", "column1"],
            ["VARCHAR", "BIGINT"],
            [(" first", 2), ("last", 3)],
        ),
        (
            ".tsv",
            b"\t\nx\ty\n",
            {"hasHeader": False},
            ["column0", "column1"],
            ["VARCHAR", "VARCHAR"],
            [(None, None), ("x", "y")],
        ),
        (
            ".csv",
            b'"first\nline";value\n"left\nright";2\nlast;3\n',
            {"delimiter": ";", "hasHeader": True},
            ["first\nline", "value"],
            ["VARCHAR", "BIGINT"],
            [("left\nright", 2), ("last", 3)],
        ),
        (
            ".csv",
            b"\xef\xbb\xbflabel,value\nx,2\nlast,3\n",
            {"hasHeader": True},
            ["label", "value"],
            ["VARCHAR", "BIGINT"],
            [("x", 2), ("last", 3)],
        ),
    ],
    ids=["leading-space", "null-tsv-record", "quoted-newlines", "ordinary-bom"],
)
def test_duckdb_delimited_first_record_values_survive_native_replay_and_cleaning(
    tmp_path: Path,
    suffix: str,
    contents: bytes,
    options: dict[str, Any],
    names: list[str],
    types: list[str],
    expected: list[tuple[Any, ...]],
) -> None:
    path = tmp_path / f"first-record{suffix}"
    path.write_bytes(contents)
    before = path.stat()
    engine = DuckDBEngine()
    try:
        frame = engine.read_file(str(path), options)
        assert isinstance(frame, DuckDBSqlPlan)
        assert not engine._active_connections
        assert frame.columns == names and frame.types == types
        assert rows(frame) == expected
        operation = bound_step("renameColumn", column=bound_ref("c:source:0", names[0], 0), newName="renamed")
        live = engine.apply_transform(frame, operation)
        with duckdb_runtime._connect() as connection:
            source = connection.sql(frame.sql_query())
            generated = execute_generated(engine, source, [operation])
            assert_same_relation(live, generated)
            assert generated.columns == ["renamed", *names[1:]]
            assert [str(dtype) for dtype in generated.types] == types
            assert generated.fetchall() == expected
            assert source.fetchall() == expected
        assert not engine._active_connections
    finally:
        engine.close()
    after = path.stat()
    assert path.read_bytes() == contents
    assert (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) == (
        before.st_dev,
        before.st_ino,
        before.st_size,
        before.st_mtime_ns,
    )


@pytest.mark.parametrize(("suffix", "delimiter"), [(".csv", ","), (".tsv", "\t")])
@pytest.mark.parametrize("name", ["O'Brien", "O''Brien"], ids=["single-apostrophe", "doubled-apostrophe"])
def test_duckdb_delimited_apostrophe_headers_refuse_before_replay(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, suffix: str, delimiter: str, name: str
) -> None:
    path = tmp_path / f"headers{suffix}"
    contents = f"{name}{delimiter}value\n1{delimiter}2\n3{delimiter}4\n".encode()
    path.write_bytes(contents)
    before = path.stat()
    native_replay = DuckDBEngine._relation_from_sql
    replay_count = 0

    def record_replay(engine: DuckDBEngine, sql: str) -> DuckDBSqlPlan:
        nonlocal replay_count
        replay_count += 1
        return native_replay(engine, sql)

    monkeypatch.setattr(DuckDBEngine, "_relation_from_sql", record_replay)
    manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))
    try:
        with pytest.raises(
            EngineError, match="DuckDB CSV/TSV imports do not support column names containing apostrophes"
        ):
            manager.open_session(
                {
                    "kind": "file",
                    "label": path.name,
                    "path": str(path),
                    "importOptions": {"delimiter": delimiter, "hasHeader": True},
                },
                backend="duckdb",
                page_size=2,
            )
        assert replay_count == 0
        assert manager.sessions == {}
    finally:
        manager.close_all()
    after = path.stat()
    assert path.read_bytes() == contents
    assert (after.st_ino, after.st_size, after.st_mtime_ns) == (before.st_ino, before.st_size, before.st_mtime_ns)


@pytest.mark.parametrize(("suffix", "delimiter"), [(".csv", ","), (".tsv", "\t")])
@pytest.mark.parametrize("has_header", [True, False], ids=["header", "headerless"])
def test_duckdb_delimited_apostrophe_paths_and_values_remain_supported(
    tmp_path: Path, suffix: str, delimiter: str, has_header: bool
) -> None:
    path = tmp_path / f"O'Brien{suffix}"
    header = delimiter.join(["ordinary", "東京", '"double""quote"', "O’Brien"]) + "\n" if has_header else ""
    contents = (
        header + f"O'Brien{delimiter}2{delimiter}3{delimiter}4\nplain{delimiter}5{delimiter}6{delimiter}7\n"
    ).encode("utf-8")
    path.write_bytes(contents)
    before = path.stat()
    names = ["ordinary", "東京", 'double"quote', "O’Brien"] if has_header else [f"column{i}" for i in range(4)]
    source = {
        "kind": "file",
        "label": path.name,
        "path": str(path),
        "importOptions": {"delimiter": delimiter, "hasHeader": has_header},
    }
    manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))
    try:
        opened = manager.open_session(source, backend="duckdb", page_size=2)
        assert opened["metadata"]["source"] == source
        assert opened["metadata"]["shape"] == {"rows": 2, "columns": 4}
        assert [column["name"] for column in opened["metadata"]["schema"]] == names
        assert [column["rawType"] for column in opened["metadata"]["schema"]] == [
            "VARCHAR",
            "BIGINT",
            "BIGINT",
            "BIGINT",
        ]
        assert [[cell["raw"] for cell in row["values"]] for row in opened["page"]["rows"]] == [
            ["O'Brien", 2, 3, 4],
            ["plain", 5, 6, 7],
        ]
    finally:
        manager.close_all()
    assert manager.sessions == {}
    after = path.stat()
    assert path.read_bytes() == contents
    assert (after.st_ino, after.st_size, after.st_mtime_ns) == (before.st_ino, before.st_size, before.st_mtime_ns)


@pytest.mark.parametrize("suffix", [".jsonl", ".parquet"])
def test_duckdb_other_file_formats_preserve_apostrophe_names(tmp_path: Path, suffix: str) -> None:
    path = tmp_path / f"O'Brien{suffix}"
    names = ["O'Brien", "O''Brien"]
    if suffix == ".jsonl":
        path.write_text(
            "".join(json.dumps(dict(zip(names, row, strict=True))) + "\n" for row in [(1, 2), (3, 4)]),
            encoding="utf-8",
        )
    else:
        with duckdb_runtime._connect() as connection:
            relation = connection.sql('SELECT 1::BIGINT AS "O\'Brien", 2::BIGINT AS "O\'\'Brien" UNION ALL SELECT 3, 4')
            relation.write_parquet(str(path))
            relation = None
    contents = path.read_bytes()
    before = path.stat()
    source = {"kind": "file", "label": path.name, "path": str(path)}
    manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))
    try:
        opened = manager.open_session(source, backend="duckdb", page_size=2)
        assert opened["metadata"]["source"] == source
        assert opened["metadata"]["shape"] == {"rows": 2, "columns": 2}
        assert [column["name"] for column in opened["metadata"]["schema"]] == names
        assert [[cell["raw"] for cell in row["values"]] for row in opened["page"]["rows"]] == [[1, 2], [3, 4]]
    finally:
        manager.close_all()
    assert manager.sessions == {}
    after = path.stat()
    assert path.read_bytes() == contents
    assert (after.st_ino, after.st_size, after.st_mtime_ns) == (before.st_ino, before.st_size, before.st_mtime_ns)


@pytest.mark.parametrize(
    ("record_ending", "line_ending"),
    [("\n", None), ("\r", "cr"), ("\r\n", "lf")],
    ids=["lf-omitted", "cr", "crlf"],
)
def test_duckdb_delimited_line_options_retain_native_detection(
    tmp_path: Path, record_ending: str, line_ending: str | None
) -> None:
    path = tmp_path / "records.tsv"
    contents = (
        record_ending.join(["city\tvalue", '"Milan\ncentre"\t1', '"Berlin\r\nwest"\t2']) + record_ending
    ).encode("utf-8")
    path.write_bytes(contents)
    options = {"lineEnding": line_ending} if line_ending is not None else {}
    manager = SessionManager()
    try:
        opened = manager.open_session(
            {"kind": "file", "label": path.name, "path": str(path), "importOptions": options},
            backend="duckdb",
            page_size=1,
        )
        metadata = opened["metadata"]
        session_id = metadata["sessionId"]
        assert metadata["shape"] == {"rows": 2, "columns": 2}
        assert metadata["source"]["importOptions"] == options
        assert [column["name"] for column in metadata["schema"]] == ["city", "value"]
        assert isinstance(manager.sessions[session_id].original, DuckDBSqlPlan)
        assert [cell["raw"] for cell in opened["page"]["rows"][0]["values"]] == ["Milan\ncentre", 1]
        later = manager.get_page(session_id, 0, 1, 1, {"filters": [], "sort": []})
        assert [cell["raw"] for cell in later["page"]["rows"][0]["values"]] == ["Berlin\r\nwest", 2]
    finally:
        manager.close_all()
    assert manager.sessions == {}
    assert path.read_bytes() == contents


def test_duckdb_file_readers_are_lazy_hardened_and_export_natively(tmp_path: Path) -> None:
    csv_path = tmp_path / "sample.csv"
    csv_path.write_text('city;value\n"Milan";1\n"Berlin";2\n', encoding="utf-8")
    unicode_delimiter_path = tmp_path / "unicode-delimiter.csv"
    unicode_delimiter_path.write_text("city§value\nMilan§1\nBerlin§2\n", encoding="utf-8")
    tsv_path = tmp_path / "sample.tsv"
    tsv_path.write_text("city\tvalue\nMilan\t1\nBerlin\t2\n", encoding="utf-8")
    jsonl_path = tmp_path / "sample.jsonl"
    jsonl_path.write_text('{"city":"Milan","value":1}\n{"city":"Berlin","value":2}\n', encoding="utf-8")
    malformed_jsonl_path = tmp_path / "malformed.jsonl"
    malformed_jsonl_path.write_text('{"city":"Milan","value":1}\n{"city":\n', encoding="utf-8")
    parquet_path = tmp_path / "sample.parquet"
    duckdb.sql("SELECT * FROM (VALUES ('Milan', 1), ('Berlin', 2)) AS data(city, value)").write_parquet(
        str(parquet_path)
    )

    engine = DuckDBEngine()
    settings_connection = duckdb_runtime._connect()
    try:
        settings = settings_connection.execute(
            "SELECT current_setting('autoinstall_known_extensions'), "
            "current_setting('autoload_known_extensions'), current_setting('enable_external_file_cache'), "
            "current_setting('preserve_insertion_order'), "
            "current_setting('TimeZone')"
        ).fetchone()
        assert settings_connection.execute("FROM duckdb_external_file_cache()").fetchall() == []
    finally:
        settings_connection.close()
    assert settings == (False, False, False, True, "UTC")

    csv_frame = engine.read_file(
        str(csv_path),
        {"delimiter": ";", "encoding": "utf-8", "quoteChar": '"', "hasHeader": True},
    )
    assert isinstance(csv_frame, DuckDBSqlPlan)
    assert "read_csv" in csv_frame.sql_query().lower()
    assert engine.shape(csv_frame) == {"rows": 2, "columns": 2}
    assert rows(engine.read_file(str(unicode_delimiter_path), {"delimiter": "§"})) == [
        ("Milan", 1),
        ("Berlin", 2),
    ]
    assert rows(engine.read_file(str(tsv_path))) == [("Milan", 1), ("Berlin", 2)]
    assert rows(engine.read_file(str(jsonl_path))) == [("Milan", 1), ("Berlin", 2)]
    assert rows(engine.read_file(str(parquet_path))) == [("Milan", 1), ("Berlin", 2)]
    with pytest.raises(EngineError, match=r"newline-delimited JSON.*Malformed JSON") as malformed:
        engine.read_file(str(malformed_jsonl_path))
    assert "JSON support is unavailable" not in str(malformed.value)

    adversarial_missing_path = tmp_path / "missing" / "json extension not loaded.jsonl"
    with pytest.raises(EngineError, match="newline-delimited JSON") as adversarial_missing:
        engine.read_file(str(adversarial_missing_path))
    assert "JSON support is unavailable" not in str(adversarial_missing.value)

    adversarial_malformed_path = tmp_path / "malformed" / "json extension not loaded.jsonl"
    adversarial_malformed_path.parent.mkdir()
    adversarial_malformed_path.write_text('{"city":\n', encoding="utf-8")
    with pytest.raises(EngineError, match=r"newline-delimited JSON.*Malformed JSON") as adversarial_malformed:
        engine.read_file(str(adversarial_malformed_path))
    assert "JSON support is unavailable" not in str(adversarial_malformed.value)

    with pytest.raises(EngineError, match="does not support Excel"):
        engine.read_file(str(tmp_path / "unsupported.xlsx"))
    with pytest.raises(EngineError, match="supports UTF-8"):
        engine.read_file(str(csv_path), {"encoding": "latin-1"})

    identified = engine.ensure_row_ids(csv_frame, "export")
    csv_export = tmp_path / "cleaned.csv"
    parquet_export = tmp_path / "cleaned.parquet"
    engine.export_data(identified, str(csv_export), export_options("csv"))
    engine.export_data(identified, str(parquet_export), export_options("parquet"))
    assert duckdb.read_csv(str(csv_export)).columns == ["city", "value"]
    assert duckdb.read_parquet(str(parquet_export)).fetchall() == [("Milan", 1), ("Berlin", 2)]

    engine.close()
    engine.close()
    with pytest.raises(EngineError, match="closed"):
        engine.read_file(str(csv_path))


def test_duckdb_live_session_releases_rich_parquet_for_atomic_replacement(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "replaceable.parquet"
    replacement = tmp_path / "replaceable.parquet.replacement"
    connection = duckdb.connect()
    try:
        connection.execute(
            """
            CREATE TABLE rich AS SELECT
                CAST('123456789012345678901234567890.12345678' AS DECIMAL(38,8)) AS exact_decimal,
                TIMESTAMPTZ '2026-07-16 14:30:00+02:00' AS zoned,
                [1, 2, NULL]::INTEGER[] AS items,
                {'label': 'alpha', 'score': 7} AS record
            """
        )
        connection.execute("COPY rich TO ? (FORMAT PARQUET)", [str(source)])
        connection.execute("COPY rich TO ? (FORMAT PARQUET)", [str(replacement)])
    finally:
        connection.close()

    manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))
    opened = manager.open_session(
        {"kind": "file", "label": source.name, "path": str(source)},
        backend="duckdb",
        page_size=200,
    )
    session_id = opened["metadata"]["sessionId"]
    try:
        session = manager.sessions[session_id]
        assert isinstance(session.engine, DuckDBEngine)
        assert isinstance(session.original, DuckDBSqlPlan)
        assert isinstance(session.committed, DuckDBSqlPlan)
        assert isinstance(session.filtered, DuckDBSqlPlan)
        assert "parquet_scan" in session.original.sql_query().lower()
        assert opened["metadata"]["shape"] == {"rows": 1, "columns": 4}
        assert opened["page"]["rows"][0]["values"][0]["raw"] == "123456789012345678901234567890.12345678"

        paged = manager.get_page(
            session_id,
            0,
            0,
            20,
            {"logic": "and", "filters": [], "sort": []},
        )
        assert paged["page"]["rows"][0]["values"][0]["raw"] == "123456789012345678901234567890.12345678"
        assert isinstance(session.filtered, DuckDBSqlPlan)

        native_execute_rows = duckdb_runtime._execute_rows
        summary_read_completed = Event()
        release_summary_connection = Event()

        def hold_completed_summary_read(connection: Any, source_sql: str, query: str) -> list[tuple[Any, ...]]:
            result = native_execute_rows(connection, source_sql, query)
            if "count(DISTINCT" in query:
                summary_read_completed.set()
                if not release_summary_connection.wait(timeout=10):
                    raise AssertionError("Timed out releasing the completed DuckDB summary read.")
            return result

        monkeypatch.setattr(duckdb_runtime, "_execute_rows", hold_completed_summary_read)
        with ThreadPoolExecutor(max_workers=2) as pool:
            summary_future = pool.submit(session.engine.summaries, session.filtered, [(0, "c:exact_decimal")])
            assert summary_read_completed.wait(timeout=10)
            with session.engine._lifecycle_lock:
                assert len(session.engine._active_connections) == 1
            page_future = pool.submit(session.engine.page, session.filtered, 0, 20, total_rows=1)
            try:
                concurrent_page = page_future.result(timeout=10)
                assert concurrent_page["rows"][0]["values"][0]["raw"] == ("123456789012345678901234567890.12345678")
                with session.engine._lifecycle_lock:
                    assert len(session.engine._active_connections) == 1
            finally:
                release_summary_connection.set()
            concurrent_summary = summary_future.result(timeout=10)
        assert concurrent_summary[0]["columnId"] == "c:exact_decimal"
        with session.engine._lifecycle_lock:
            assert session.engine._active_connections == set()

        os.replace(replacement, source)
        with pytest.raises(EngineError, match="changed or is no longer available"):
            manager.get_page(
                session_id,
                0,
                0,
                20,
                {"logic": "and", "filters": [], "sort": []},
            )
    finally:
        manager.close_session(session_id, 0)
        manager.close_all()


def test_duckdb_session_releases_every_temporary_relation_before_connection_close(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "detached.csv"
    source.write_text("value\n1\n2\n", encoding="utf-8")
    destination = tmp_path / "detached.parquet"
    native_connect = duckdb_runtime._connect
    native_project = duckdb.DuckDBPyRelation.project
    relation_refs: list[weakref.ReferenceType[Any]] = []
    connections: list[Any] = []

    def reject_relation_close(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("DuckDBPyRelation.close() executes an unexecuted relation")

    class TrackedConnection:
        def __init__(self) -> None:
            self.inner = native_connect()
            self.closed = False
            connections.append(self)

        def _capture(self, relation: Any) -> Any:
            relation_refs.append(weakref.ref(relation))
            return relation

        def sql(self, *args: Any, **kwargs: Any) -> Any:
            return self._capture(self.inner.sql(*args, **kwargs))

        def read_csv(self, *args: Any, **kwargs: Any) -> Any:
            return self._capture(self.inner.read_csv(*args, **kwargs))

        def read_parquet(self, *args: Any, **kwargs: Any) -> Any:
            return self._capture(self.inner.read_parquet(*args, **kwargs))

        def read_json(self, *args: Any, **kwargs: Any) -> Any:
            return self._capture(self.inner.read_json(*args, **kwargs))

        def close(self) -> None:
            self.inner.close()
            self.closed = True

        def __getattr__(self, name: str) -> Any:
            return getattr(self.inner, name)

    def tracked_connect() -> TrackedConnection:
        return TrackedConnection()

    def tracked_project(relation: Any, *args: Any, **kwargs: Any) -> Any:
        projected = native_project(relation, *args, **kwargs)
        relation_refs.append(weakref.ref(projected))
        return projected

    def assert_fully_detached() -> None:
        assert relation_refs
        assert all(reference() is None for reference in relation_refs)
        assert all(connection.closed for connection in connections)
        for connection in connections:
            with pytest.raises(duckdb.ConnectionException, match="closed"):
                connection.inner.execute("SELECT 1")

    monkeypatch.setattr(duckdb_runtime, "_connect", tracked_connect)
    monkeypatch.setattr(duckdb.DuckDBPyRelation, "close", reject_relation_close)
    monkeypatch.setattr(duckdb.DuckDBPyRelation, "project", tracked_project)

    manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))
    opened = manager.open_session(
        {"kind": "file", "label": source.name, "path": str(source)},
        backend="duckdb",
        page_size=2,
    )
    session_id = opened["metadata"]["sessionId"]
    try:
        session = manager.sessions[session_id]
        assert all(
            isinstance(frame, DuckDBSqlPlan) for frame in (session.original, session.committed, session.filtered)
        )
        assert_fully_detached()

        manager.get_page(
            session_id,
            0,
            0,
            20,
            {"logic": "and", "filters": [], "sort": []},
        )
        assert_fully_detached()

        operation = step("customCode", code="result = df.project('value + 1 AS value')")
        preview = manager.preview_step(session_id, 0, operation, 0, 20)
        assert preview["revision"] == 1
        assert isinstance(session.draft_frame, DuckDBSqlPlan)
        assert_fully_detached()

        applied = manager.apply_draft(session_id, 1, 0, 20)
        assert applied["revision"] == 2
        assert isinstance(session.committed, DuckDBSqlPlan)
        assert isinstance(session.filtered, DuckDBSqlPlan)
        assert_fully_detached()

        manager.export_data(
            session_id, 2, str(destination), export_options("parquet"), reserve_export_target(destination)
        )
        assert rows(duckdb.read_parquet(str(destination))) == [(2,), (3,)]
        assert_fully_detached()
    finally:
        manager.close_session(session_id, manager.sessions[session_id].revision)
        manager.close_all()


def test_duckdb_jsonl_missing_reader_retains_dependency_guidance(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class MissingJsonReader:
        def read_json(self, *_args: Any, **_kwargs: Any) -> Any:
            raise duckdb.CatalogException("Catalog Error: Table Function with name read_json_auto does not exist!")

        def close(self) -> None:
            return None

    engine = DuckDBEngine()
    monkeypatch.setattr(duckdb_runtime, "_connect", MissingJsonReader)

    with pytest.raises(EngineError, match=r"JSON support is unavailable.*compatible DuckDB build"):
        engine.read_file(str(tmp_path / "sample.jsonl"))
    engine.close()


def test_duckdb_json_reader_availability_classifier_requires_anchored_duckdb_diagnostic() -> None:
    assert duckdb_runtime._json_reader_is_unavailable(
        duckdb.CatalogException("Catalog Error: Table Function with name read_json_auto does not exist!")
    )
    assert duckdb_runtime._json_reader_is_unavailable(
        duckdb.HTTPException(
            "Extension Autoloading Error: An error occurred while trying to automatically install "
            "the required extension 'json': download failed"
        )
    )

    assert not duckdb_runtime._json_reader_is_unavailable(
        RuntimeError("Catalog Error: Table Function with name read_json_auto does not exist!")
    )
    assert not duckdb_runtime._json_reader_is_unavailable(
        duckdb.IOException('IO Error: No files found that match "/tmp/json extension not loaded.jsonl"')
    )
    assert not duckdb_runtime._json_reader_is_unavailable(
        duckdb.InvalidInputException(
            "Invalid Input Error: Malformed JSON in file \"/tmp/extension 'json' not installed.jsonl\""
        )
    )


def test_duckdb_rich_parquet_is_utc_native_and_strict_json_safe(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_conversion_guards(monkeypatch)
    path = tmp_path / "rich.parquet"
    writer = duckdb.connect()
    try:
        writer.execute("SET TimeZone = 'America/New_York'")
        writer.execute(
            """
            COPY (
                SELECT * FROM (VALUES
                    (
                        'match',
                        18446744073709551615::UBIGINT,
                        1.2300::DECIMAL(10, 4),
                        TIMESTAMPTZ '2026-01-01 00:30:00+01:00',
                        INTERVAL '93784 seconds',
                        from_hex('00ff'),
                        [1, 2]::INTEGER[],
                        {'label': 'é🙂', 'score': 7},
                        'Infinity'::DOUBLE
                    ),
                    (
                        'other',
                        7::UBIGINT,
                        2.5000::DECIMAL(10, 4),
                        TIMESTAMPTZ '2026-01-02 10:00:00+00:00',
                        INTERVAL '0 seconds',
                        from_hex('61'),
                        [3]::INTEGER[],
                        {'label': 'x', 'score': 8},
                        'NaN'::DOUBLE
                    ),
                    (
                        'missing',
                        NULL::UBIGINT,
                        NULL::DECIMAL(10, 4),
                        NULL::TIMESTAMPTZ,
                        NULL::INTERVAL,
                        NULL::BLOB,
                        NULL::INTEGER[],
                        NULL::STRUCT(label VARCHAR, score INTEGER),
                        NULL::DOUBLE
                    )
                ) AS rich(label, huge, amount, occurred_at, elapsed, payload, items, record, floating)
            ) TO ? (FORMAT PARQUET)
            """,
            [str(path)],
        )
    finally:
        writer.close()

    manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend="duckdb",
        page_size=10,
    )
    session_id = opened["metadata"]["sessionId"]
    try:
        schema = {column["name"]: column["type"] for column in opened["metadata"]["schema"]}
        schema_ids = {column["name"]: column["id"] for column in opened["metadata"]["schema"]}
        first_row = opened["page"]["rows"][0]["values"]

        assert schema == {
            "label": "string",
            "huge": "integer",
            "amount": "decimal",
            "occurred_at": "datetime",
            "elapsed": "duration",
            "payload": "binary",
            "items": "list",
            "record": "struct",
            "floating": "float",
        }
        assert [cell["kind"] for cell in first_row] == [
            "string",
            "integer",
            "decimal",
            "datetime",
            "duration",
            "binary",
            "list",
            "struct",
            "infinity",
        ]
        assert first_row[1]["raw"] == "18446744073709551615"
        assert first_row[2]["raw"] == "1.2300"
        assert first_row[3]["raw"] == "2025-12-31T23:30:00+00:00"
        assert first_row[4]["raw"] == 93784.0
        assert first_row[5]["raw"] == "AP8="
        assert first_row[6]["raw"] == [1, 2]
        assert first_row[7]["raw"] == {"label": "é🙂", "score": 7}
        assert opened["page"]["rows"][1]["values"][8]["kind"] == "nan"
        assert all(cell["kind"] == "null" for cell in opened["page"]["rows"][2]["values"][1:])
        json.dumps(opened, allow_nan=False)

        summaries = manager.get_summary(
            session_id,
            0,
            {"filters": [], "sort": []},
            [schema_ids[name] for name in ["amount", "occurred_at", "items", "record"]],
        )["summaries"]
        assert [summary["type"] for summary in summaries] == ["decimal", "datetime", "list", "struct"]
        assert summaries[0]["numeric"]["min"] == 1.23
        assert summaries[1]["visualization"] == {
            "kind": "datetime",
            "min": "2025-12-31 23:30:00+00:00",
            "max": "2026-01-02 10:00:00+00:00",
        }
        assert summaries[2]["topValues"][0]["value"] == "[1,2]"
        assert {item["value"] for item in summaries[3]["topValues"]} == {
            '{"label":"x","score":8}',
            '{"label":"é🙂","score":7}',
        }

        filtered = manager.get_page(
            session_id,
            0,
            0,
            10,
            {
                "logic": "and",
                "filters": [
                    {
                        "column": "amount",
                        "type": "decimal",
                        "logic": "and",
                        "predicates": [{"operator": "gte", "value": "1.2"}],
                    }
                ],
                "sort": [{"column": "occurred_at", "direction": "desc", "nulls": "last"}],
            },
        )["page"]
        assert filtered["totalRows"] == 2
        assert [row["values"][0]["raw"] for row in filtered["rows"]] == ["other", "match"]

        exported_path = tmp_path / "rich-cleaned.parquet"
        assert manager.export_data(
            session_id,
            0,
            str(exported_path),
            export_options("parquet"),
            reserve_export_target(exported_path),
        )["shape"] == {
            "rows": 3,
            "columns": 9,
        }
        inspector = duckdb.connect()
        try:
            inspector.execute("SET TimeZone = 'UTC'")
            exported = inspector.read_parquet(str(exported_path))
            assert [str(value) for value in exported.types] == [
                "VARCHAR",
                "UBIGINT",
                "DECIMAL(10,4)",
                "TIMESTAMP WITH TIME ZONE",
                "INTERVAL",
                "BLOB",
                "INTEGER[]",
                'STRUCT("label" VARCHAR, score INTEGER)',
                "DOUBLE",
            ]
            exported_row = exported.fetchone()
            assert exported_row is not None
            assert exported_row[3].isoformat() == "2025-12-31T23:30:00+00:00"
        finally:
            inspector.close()
    finally:
        manager.close_session(session_id, 0)


def test_duckdb_view_queries_are_typed_exact_and_concurrency_safe(monkeypatch: pytest.MonkeyPatch) -> None:
    install_conversion_guards(monkeypatch)
    engine = DuckDBEngine()
    frame = duckdb.sql(
        """
        SELECT * FROM (VALUES
            (0, 'alpha', CAST(1.0 AS DOUBLE), 9007199254740993::HUGEINT, [1, 2], {'x': 1}),
            (1, 'alpha', CAST(1.0 AS DOUBLE), 2::HUGEINT, [1, 2], {'x': 1}),
            (2, 'beta', CAST(NULL AS DOUBLE), 3::HUGEINT, [3], {'x': 2}),
            (3, 'nan', CAST('NaN' AS DOUBLE), 4::HUGEINT, NULL, NULL)
        ) AS source(id, label, value, huge, items, record)
        """
    )
    frame = engine.ensure_row_ids(frame, "typed")

    assert [item["type"] for item in engine.schema(frame)] == [
        "integer",
        "string",
        "float",
        "integer",
        "list",
        "struct",
    ]
    first_page = engine.page(frame, 0, 4)
    second_page = engine.page(frame, 0, 4)
    assert first_page == second_page
    assert first_page["rows"][0]["values"][3] == {
        "kind": "integer",
        "raw": "9007199254740993",
        "display": "9007199254740993",
        "isNull": False,
        "isNaN": False,
    }
    assert first_page["rows"][3]["values"][2]["kind"] == "nan"

    model = {
        "logic": "and",
        "filters": [
            {
                "column": "value",
                "type": "float",
                "logic": "or",
                "predicates": [
                    {"operator": "isNull"},
                    {"operator": "isNaN"},
                    {"operator": "gte", "value": 1},
                ],
            }
        ],
        "sort": [{"column": "label", "direction": "desc", "nulls": "last"}],
    }
    assert [row["label"] for row in records(engine.apply_filter_model(frame, model))] == [
        "nan",
        "beta",
        "alpha",
        "alpha",
    ]

    summary = engine.summaries(frame, [(2, "c:value"), (4, "c:items")])
    assert [item["columnId"] for item in summary] == ["c:value", "c:items"]
    assert summary[0]["nullCount"] == 1
    assert summary[0]["nanCount"] == 1
    assert summary[0]["distinctCount"] == 1
    assert summary[0]["topValues"] == [{"value": "1.0", "count": 2}]
    assert summary[0]["numeric"]["mean"] == 1.0
    assert summary[1]["topValues"][0] == {"value": "[1,2]", "count": 2}
    stats = engine.header_stats(frame)
    assert stats["missingCells"] == 4
    assert stats["missingRows"] == 2
    assert stats["duplicateRows"] == 0
    values, has_more = engine.column_values(frame, "value")
    assert values == [{"value": "1.0", "count": 2, "selectionValue": typed_selection_value(1.0, "float")}]
    assert has_more is False
    nested_values, nested_more = engine.column_values(frame, "items")
    assert nested_values == [
        {"value": "[1,2]", "count": 2, "selectionValue": None},
        {"value": "[3]", "count": 1, "selectionValue": None},
    ]
    assert nested_more is False

    def read_page() -> list[str]:
        return [row["id"] for row in engine.page(frame, 0, 4)["rows"]]

    def read_summary() -> int:
        return engine.summaries(frame, [(1, "c:label")])[0]["distinctCount"]

    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = [pool.submit(read_page if index % 2 == 0 else read_summary) for index in range(24)]
        results = [future.result(timeout=10) for future in futures]
    assert all(result == first_page_ids(first_page) for result in results[::2])
    assert results[1::2] == [3] * 12
    engine.close()


def test_duckdb_nested_float_containers_use_container_missing_semantics() -> None:
    engine = DuckDBEngine()
    source = duckdb.sql(
        """
        SELECT CAST([1.0] AS DOUBLE[]) AS items,
               {'score': CAST(1.0 AS DOUBLE)} AS record
        UNION ALL
        SELECT NULL::DOUBLE[], NULL::STRUCT(score DOUBLE)
        """
    )
    columns = [
        bound_ref("c:source:0", "items", 0),
        bound_ref("c:source:1", "record", 1),
    ]
    operation = bound_step("dropMissingRows", columns=columns, how="any")

    try:
        summaries = engine.summaries(source, [(0, "c:items"), (1, "c:record")])
        assert [(summary["type"], summary["nullCount"], summary["nanCount"]) for summary in summaries] == [
            ("list", 1, 0),
            ("struct", 1, 0),
        ]
        assert engine.header_stats(source) == {
            "missingCells": 2,
            "missingRows": 1,
            "duplicateRows": 0,
            "missingValuesByColumn": [
                {"column": "items", "count": 1},
                {"column": "record", "count": 1},
            ],
        }

        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])
        assert_same_relation(live, generated)
        assert rows(live) == [([1.0], {"score": 1.0})]
    finally:
        engine.close()


def test_duckdb_text_summaries_are_exact_native_unicode_aggregates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    install_conversion_guards(monkeypatch)
    engine = DuckDBEngine()
    frame = duckdb.sql(
        """
        SELECT * FROM (VALUES
            (CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR)),
            ('', NULL),
            ('A', NULL),
            ('é', NULL),
            ('é', NULL),
            ('😀', NULL)
        ) AS source(text_value, all_null)
        """
    )

    try:
        summaries = engine.summaries(frame, [(0, "c:text"), (1, "c:all-null")])

        assert summaries[0]["text"] == pytest.approx(
            {
                "emptyCount": 1,
                "minLength": 0,
                "maxLength": 2,
                "meanLength": 1.0,
            }
        )
        assert summaries[0]["nullCount"] == 1
        assert summaries[1]["text"] == {"emptyCount": 0}
        assert summaries[1]["nullCount"] == 6
    finally:
        engine.close()


def test_duckdb_numeric_summaries_publish_lossless_wide_integer_and_decimal_extrema(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    install_conversion_guards(monkeypatch)
    engine = DuckDBEngine()
    frame = duckdb.sql(
        """
        SELECT * FROM (VALUES
            (
                CAST('-999999999999999999999999999998' AS HUGEINT),
                CAST('-12345678901234567890.123456789012345678' AS DECIMAL(38, 18))
            ),
            (
                CAST('1000000000000000000000000000003' AS HUGEINT),
                CAST('98765432109876543210.987654321098765432' AS DECIMAL(38, 18))
            )
        ) AS source(wide, amount)
        """
    )

    try:
        summaries = engine.summaries(frame, [(0, "wide-id"), (1, "amount-id")])

        assert summaries[0]["numeric"]["exactMin"]["display"] == "-999999999999999999999999999998"
        assert summaries[0]["numeric"]["exactMax"]["display"] == "1000000000000000000000000000003"
        assert summaries[0]["numeric"]["exactMin"]["kind"] == "integer"
        assert summaries[0]["numeric"]["exactMax"]["kind"] == "integer"
        assert summaries[1]["numeric"]["exactMin"]["display"] == "-12345678901234567890.123456789012345678"
        assert summaries[1]["numeric"]["exactMax"]["display"] == "98765432109876543210.987654321098765432"
        assert summaries[1]["numeric"]["exactMin"]["kind"] == "decimal"
        assert summaries[1]["numeric"]["exactMax"]["kind"] == "decimal"
    finally:
        engine.close()


def test_duckdb_numeric_histogram_is_exact_for_a_large_filtered_view() -> None:
    engine = DuckDBEngine()
    source = duckdb.sql(
        """
        SELECT CAST(-1 AS DOUBLE) AS value FROM range(500)
        UNION ALL
        SELECT CAST(value AS DOUBLE) FROM range(5000) AS source(value)
        UNION ALL
        SELECT CAST(1000000 AS DOUBLE)
        """
    )
    try:
        frame = engine.apply_filter_model(
            source,
            {
                "logic": "and",
                "filters": [
                    {
                        "column": "value",
                        "type": "float",
                        "logic": "and",
                        "predicates": [{"operator": "gte", "value": 500}],
                    }
                ],
                "sort": [],
            },
        )

        summary = engine.summaries(frame)[0]
        bins = summary["visualization"]["bins"]

        assert summary["numeric"]["min"] == 500.0
        assert summary["numeric"]["max"] == 1_000_000.0
        assert "sampled" not in summary["visualization"]
        assert len(bins) == 20
        assert bins[0]["min"] == summary["numeric"]["min"]
        assert bins[-1]["max"] == summary["numeric"]["max"]
        assert bins[-1]["count"] == 1
        assert sum(bin_["count"] for bin_ in bins) == 4_501
        assert all(left["max"] == right["min"] for left, right in zip(bins, bins[1:], strict=False))
        assert [bin_["max"] - bin_["min"] for bin_ in bins] == pytest.approx(
            [bins[0]["max"] - bins[0]["min"]] * len(bins)
        )
    finally:
        engine.close()


def test_duckdb_non_float_include_nan_value_filter_is_an_explicit_false_condition() -> None:
    engine = DuckDBEngine()
    frame = duckdb.sql("SELECT * FROM (VALUES (1), (2)) AS source(value)")
    operation = bound_step(
        "filterRows",
        filterModel={
            "filters": [
                {
                    "column": bound_ref("c:source:0", "value", 0),
                    "type": "integer",
                    "valueFilter": {
                        "kind": "values",
                        "selectedValues": [],
                        "includeNulls": False,
                        "includeNaN": True,
                    },
                    "predicates": [],
                }
            ],
            "sort": [],
        },
    )

    transformed = engine.apply_transform(frame, operation)
    generated = execute_generated(engine, frame, [operation])

    assert rows(transformed) == []
    assert_same_relation(transformed, generated)


def first_page_ids(page: dict[str, Any]) -> list[str]:
    return [row["id"] for row in page["rows"]]


@pytest.mark.parametrize("generated", [False, True], ids=["live", "generated"])
def test_duckdb_one_hot_preserves_binary_values_with_caller_from_hex_macro(generated: bool) -> None:
    values = [b"\x00\xff", b"a", b"a", b"", None]
    original = list(enumerate(values))
    expected = [
        (0, b"\x00\xff", 1, 0),
        (1, b"a", 0, 1),
        (2, b"a", 0, 1),
        (3, b"", 0, 0),
        (4, None, 0, 0),
    ]
    engine = DuckDBEngine()
    with duckdb.connect() as connection:
        try:
            connection.execute("CREATE TABLE binary_source(id INTEGER, payload BLOB)")
            connection.executemany("INSERT INTO binary_source VALUES (?, ?)", original)
            frame = connection.table("binary_source")
            connection.execute("CREATE MACRO from_hex(value) AS 'z'::BLOB")
            operation = bound_step("oneHotEncode", columns=[bound_ref("c:source:1", "payload", 1)], dropOriginal=False)
            if generated:
                result = execute_generated(engine, frame, [operation])
                actual = result.fetchall()
            else:
                result = engine.apply_transform(engine.normalize_notebook_relation(frame), operation)
                actual = engine._terminal_rows(result, "SELECT * FROM ow")
            assert actual == expected
            assert result.columns == ["id", "payload", "payload_b'\\x00\\xff'", "payload_b'a'"]
            assert [str(dtype) for dtype in result.types] == ["INTEGER", "BLOB", "TINYINT", "TINYINT"]
            assert frame.fetchall() == original
            assert frame.columns == ["id", "payload"]
            assert [str(dtype) for dtype in frame.types] == ["INTEGER", "BLOB"]
            assert connection.sql("SELECT from_hex('00ff')").fetchone() == (b"z",)
        finally:
            engine.close()


def test_duckdb_all_operations_and_generated_code_stay_native(monkeypatch: pytest.MonkeyPatch) -> None:
    install_conversion_guards(monkeypatch)
    engine = DuckDBEngine()
    source = source_relation()
    row_plan = [
        bound_step(
            "sortRows",
            rules=[
                {
                    "column": bound_ref("c:source:3", "value", 3),
                    "direction": "desc",
                    "nulls": "last",
                }
            ],
        ),
        bound_step(
            "filterRows",
            filterModel={
                "logic": "and",
                "filters": [
                    {
                        "column": bound_ref("c:source:1", "text", 1),
                        "type": "string",
                        "logic": "and",
                        "predicates": [{"operator": "contains", "value": "alpha"}],
                    }
                ],
                "sort": [],
            },
        ),
        bound_step(
            "fillMissingValues",
            column=bound_ref("c:source:3", "value", 3),
            replacement={"kind": "median"},
        ),
        bound_step(
            "dropMissingRows",
            columns=[bound_ref("c:source:3", "value", 3)],
            how="any",
        ),
        bound_step(
            "dropDuplicates",
            columns=[
                bound_ref("c:source:3", "value", 3),
                bound_ref("c:source:4", "other", 4),
            ],
            keep="first",
        ),
    ]
    column_plan = [
        bound_step(
            "conditionalColumn",
            column=bound_ref("c:source:3", "value", 3),
            columnType="float",
            predicate={"kind": "predicate", "operator": "gte", "value": "2"},
            newColumn="above_two",
            resultType="boolean",
            trueValue=True,
            falseValue=False,
            missingValue=None,
        ),
        bound_step("markDuplicates", columns=[bound_ref("c:source:3", "value", 3)], newColumn="is_duplicate"),
        bound_step(
            "cloneColumn",
            column=bound_ref("c:source:3", "value", 3),
            newName="value_copy",
        ),
        bound_step(
            "formula",
            leftColumn=bound_ref("c:source:4", "other", 4),
            operator="multiply",
            value=10,
            newColumn="score",
        ),
        bound_step(
            "textLength",
            column=bound_ref("c:source:1", "text", 1),
            newColumn="text_length",
        ),
        bound_step(
            "castColumn",
            column=bound_ref("c:source:4", "other", 4),
            dtype="float",
        ),
        bound_step(
            "renameColumn",
            column=bound_ref("c:source:0", "group", 0),
            newName="category",
        ),
        bound_step(
            "dropColumns",
            columns=[
                bound_ref("c:source:2", "tags", 2),
                bound_ref("c:source:5", "date", 5),
            ],
        ),
        bound_step(
            "selectColumns",
            columns=[
                bound_ref("c:source:0", "category", 0),
                bound_ref("c:source:1", "text", 1),
                bound_ref("c:source:3", "value", 2),
                bound_ref("c:source:4", "other", 3),
                bound_ref("c:step:duckdb-cloneColumn:0", "value_copy", 4),
                bound_ref("c:step:duckdb-formula:0", "score", 5),
                bound_ref("c:step:duckdb-textLength:0", "text_length", 6),
            ],
        ),
    ]
    text_numeric_plan = [
        bound_step("stripText", column=bound_ref("c:source:1", "text", 1), newColumn="clean"),
        bound_step(
            "findReplace",
            column=bound_ref("c:source:1", "text", 1),
            find="-",
            replacement=" ",
            newColumn="replaced",
        ),
        bound_step(
            "splitText",
            column=bound_ref("c:source:1", "text", 1),
            delimiter="-",
            index=1,
            newColumn="suffix",
        ),
        bound_step(
            "splitTextColumns",
            column=bound_ref("c:source:1", "text", 1),
            delimiter="-",
            newColumns=["text_part", "text_remainder"],
        ),
        bound_step(
            "extractRegexGroup",
            column=bound_ref("c:source:1", "text", 1),
            pattern="([A-Za-z]+)-",
            group=1,
            newColumn="regex_word",
        ),
        bound_step("lowerText", column=bound_ref("c:source:1", "text", 1), newColumn="lower"),
        bound_step("upperText", column=bound_ref("c:source:1", "text", 1), newColumn="upper"),
        bound_step("capitalizeText", column=bound_ref("c:source:1", "text", 1), newColumn="capitalized"),
        bound_step(
            "oneHotEncode",
            columns=[bound_ref("c:source:0", "group", 0)],
            prefixSeparator="_",
            dropOriginal=False,
        ),
        bound_step(
            "multiLabelBinarize",
            column=bound_ref("c:source:2", "tags", 2),
            delimiter="|",
            prefix="tag_",
            dropOriginal=False,
        ),
        bound_step("minMaxScale", column=bound_ref("c:source:3", "value", 3), newColumn="scaled"),
        bound_step("denseRank", column=bound_ref("c:source:3", "value", 3), direction="asc", newColumn="ranked"),
        bound_step(
            "roundNumber",
            column=bound_ref("c:source:3", "value", 3),
            decimals=0,
            newColumn="rounded",
        ),
        bound_step("floorNumber", column=bound_ref("c:source:3", "value", 3), newColumn="floored"),
        bound_step("ceilNumber", column=bound_ref("c:source:3", "value", 3), newColumn="ceiled"),
        bound_step(
            "formatDatetime",
            column=bound_ref("c:source:5", "date", 5),
            format="%Y/%m",
            newColumn="month",
        ),
    ]
    source_schema = engine.schema(source)
    source_columns = source_lineage(source_schema)
    group_plan = [
        bind_step(
            step(
                "groupBy",
                keys=[{"id": "c:source:0", "name": "group"}],
                aggregations=[
                    {"column": {"id": "c:source:3", "name": "value"}, "operation": "sum", "alias": "total"},
                    {"column": {"id": "c:source:4", "name": "other"}, "operation": "mean", "alias": "average"},
                    {"column": {"id": "c:source:1", "name": "text"}, "operation": "count", "alias": "texts"},
                    {"column": {"id": "c:source:2", "name": "tags"}, "operation": "nUnique", "alias": "tag_sets"},
                ],
            ),
            source_schema,
            source_columns,
        )
    ]
    example_plan = [
        bind_step(
            step(
                "byExample",
                sourceColumns=[
                    {"id": "c:source:0", "name": "group"},
                    {"id": "c:source:4", "name": "other"},
                ],
                newColumn="label",
                examples=[
                    {"inputs": ["a", 2], "output": "a-2"},
                    {"inputs": ["b", 4], "output": "b-4"},
                ],
            ),
            source_schema,
            source_columns,
        )
    ]
    pivot_plan = [
        bound_step(
            "pivotLonger",
            columns=[
                bound_ref("c:source:0", "group", 0),
                bound_ref("c:source:1", "text", 1),
            ],
            labelColumn="measure",
            valueColumn="reading",
        )
    ]
    pivot_wider_a = typed_selection_value("a", "string")
    pivot_wider_b = typed_selection_value("b", "string")
    assert pivot_wider_a is not None and pivot_wider_b is not None
    pivot_wider_plan = [
        bound_step(
            "selectColumns",
            columns=[
                bound_ref("c:source:4", "other", 4),
                bound_ref("c:source:0", "group", 0),
                bound_ref("c:source:3", "value", 3),
            ],
        ),
        bound_step(
            "pivotWider",
            namesFrom=bound_ref("c:source:0", "group", 1),
            valuesFrom=bound_ref("c:source:3", "value", 2),
            outputs=[
                {"key": pivot_wider_a, "name": "group_a_value"},
                {"key": pivot_wider_b, "name": "group_b_value"},
            ],
        ),
    ]
    custom_plan = [step("customCode", code='result = df.filter("other > 2")')]

    extraction_plan = [
        step("customCode", code="result = df.project(\"*, {'value': other} AS record\")"),
        bound_step(
            "extractStructFields",
            column=bound_ref("c:record", "record", 6),
            fields=[{"field": "value", "newColumn": "selected"}],
        ),
    ]
    plans = [
        extraction_plan,
        row_plan,
        column_plan,
        text_numeric_plan,
        pivot_plan,
        pivot_wider_plan,
        group_plan,
        example_plan,
        custom_plan,
    ]
    covered = {operation["kind"] for plan in plans for operation in plan}
    assert covered == {item["kind"] for item in operation_catalog() if item["kind"] != "explodeList"}
    for plan in plans:
        live = source
        for operation in plan:
            live = engine.apply_transform(live, operation)
        generated = execute_generated(engine, source, plan)
        assert_same_relation(live, generated)
        if plan is text_numeric_plan:
            output = records(live)
            assert output[0]["clean"] == "alpha-one"
            assert output[1]["suffix"] == "two"
            assert output[0]["group_a"] == 1
            assert output[2]["group_b"] == 1
            assert output[0]["tag_blue"] == 1
            assert output[1]["tag_red"] == 0
            assert output[0]["scaled"] == 0.0
            assert output[1]["scaled"] == 1.0
            assert output[0]["month"] == "2024/01"
        elif plan is group_plan:
            assert records(live)[0] == {"group": "a", "total": 4.0, "average": 2.5, "texts": 2, "tag_sets": 2}
    engine.close()


def test_duckdb_grouping_treats_nan_as_missing_for_keys_and_aggregates() -> None:
    engine = DuckDBEngine()
    frame = duckdb.sql(
        """
        SELECT * FROM (VALUES
            (NULL::DOUBLE, NULL::DOUBLE),
            ('NaN'::DOUBLE, 'NaN'::DOUBLE),
            (1.0, 2.0),
            (NULL::DOUBLE, NULL::DOUBLE),
            ('NaN'::DOUBLE, 'NaN'::DOUBLE),
            (1.0, 3.0)
        ) AS source("key", "value")
        """
    )
    value = bound_ref("c:source:1", "value", 1)
    operation = bound_step(
        "groupBy",
        keys=[bound_ref("c:source:0", "key", 0)],
        aggregations=[
            {"column": value, "operation": "sum", "alias": "total"},
            {"column": value, "operation": "mean", "alias": "average"},
            {"column": value, "operation": "min", "alias": "minimum"},
            {"column": value, "operation": "max", "alias": "maximum"},
            {"column": value, "operation": "median", "alias": "middle"},
            {"column": value, "operation": "count", "alias": "count"},
            {"column": value, "operation": "nUnique", "alias": "unique"},
            {"column": value, "operation": "first", "alias": "first"},
            {"column": value, "operation": "last", "alias": "last"},
        ],
    )

    try:
        transformed = engine.apply_transform(frame, operation)
        generated = execute_generated(engine, frame, [operation])

        assert records(transformed) == [
            {
                "key": None,
                "total": 0.0,
                "average": None,
                "minimum": None,
                "maximum": None,
                "middle": None,
                "count": 0,
                "unique": 0,
                "first": None,
                "last": None,
            },
            {
                "key": 1.0,
                "total": 5.0,
                "average": 2.5,
                "minimum": 2.0,
                "maximum": 3.0,
                "middle": 2.5,
                "count": 2,
                "unique": 2,
                "first": 2.0,
                "last": 3.0,
            },
        ]
        assert_same_relation(transformed, generated)
    finally:
        engine.close()


def test_duckdb_decimal_median_is_a_portable_float_and_matches_generated_code() -> None:
    engine = DuckDBEngine()
    frame = duckdb.sql(
        "SELECT * FROM (VALUES "
        "('a', 1.10::DECIMAL(10, 2)), "
        "('a', 2.20::DECIMAL(10, 2)), "
        "('b', NULL::DECIMAL(10, 2))) AS source(\"group\", value)"
    )
    operation = bound_step(
        "groupBy",
        keys=[bound_ref("c:source:0", "group", 0)],
        aggregations=[
            {
                "column": bound_ref("c:source:1", "value", 1),
                "operation": "median",
                "alias": "middle",
            }
        ],
    )

    try:
        transformed = engine.apply_transform(frame, operation)
        generated = execute_generated(engine, frame, [operation])

        assert records(transformed) == [
            {"group": "a", "middle": pytest.approx(1.65)},
            {"group": "b", "middle": None},
        ]
        assert str(transformed.types[1]) == "DOUBLE"
        assert_same_relation(transformed, generated)
    finally:
        engine.close()


def test_duckdb_column_values_break_equal_counts_by_display_text() -> None:
    engine = DuckDBEngine()
    frame = duckdb.sql("SELECT * FROM (VALUES ('Milan'), ('Berlin'), ('Milan'), ('Berlin'), ('Paris')) AS source(city)")

    try:
        values, has_more = engine.column_values(frame, "city")
        assert values == [
            {"value": "Berlin", "count": 2, "selectionValue": typed_selection_value("Berlin", "string")},
            {"value": "Milan", "count": 2, "selectionValue": typed_selection_value("Milan", "string")},
            {"value": "Paris", "count": 1, "selectionValue": typed_selection_value("Paris", "string")},
        ]
        assert has_more is False
    finally:
        engine.close()


def test_duckdb_nanosecond_session_preserves_display_and_selection_identity(tmp_path: Path) -> None:
    path = tmp_path / "nanosecond-values.parquet"
    column = 'when "ns"'
    ticks = [-1, -1, 0, 1000, 1704161045123000000, 1704161045123456789, None]
    expected = [
        "1969-12-31T23:59:59.999999999",
        "1969-12-31T23:59:59.999999999",
        "1970-01-01T00:00:00",
        "1970-01-01T00:00:00.000001",
        "2024-01-02T02:04:05.123000",
        "2024-01-02T02:04:05.123456789",
        None,
    ]
    values = ", ".join(f"({index}, {'NULL' if tick is None else tick}::BIGINT)" for index, tick in enumerate(ticks))
    with duckdb_runtime._connect() as connection:
        connection.sql(
            'SELECT make_timestamp_ns(tick) AS "when ""ns""", id FROM (VALUES ' + values + ") source(id, tick)"
        ).write_parquet(str(path))
    contents, before = path.read_bytes(), path.stat()
    manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))

    def selected(value: Any) -> dict[str, Any]:
        return {
            "filters": [
                {
                    "column": column,
                    "type": "datetime",
                    "valueFilter": {
                        "kind": "values",
                        "selectedValues": [value],
                        "includeNulls": False,
                        "includeNaN": False,
                    },
                    "predicates": [],
                }
            ],
            "sort": [],
        }

    try:
        opened = manager.open_session(
            {"kind": "file", "label": path.name, "path": str(path)}, backend="duckdb", mode="editing", page_size=10
        )
        session_id = opened["metadata"]["sessionId"]
        session = manager.sessions[session_id]
        original, committed = session.original, session.committed
        epoch_filter = selected("1970-01-01T00:00:00")
        confirmed = manager.get_page(session_id, 0, 0, 10, epoch_filter)
        assert [row["values"][1]["raw"] for row in confirmed["page"]["rows"]] == [2]
        # The grid builds its operand from the transported cell. A finer value
        # must refuse, rather than silently selecting the real epoch neighbor.
        token = {
            "kind": "typedSelection",
            "version": 1,
            "columnType": "datetime",
            "cell": opened["page"]["rows"][0]["values"][0],
        }
        with pytest.raises(EngineError, match="Invalid datetime view-filter value"):
            manager.get_page(session_id, 0, 0, 10, selected(token))
        assert manager.get_page(session_id, 0, 0, 10, epoch_filter) == confirmed
        assert session.original is original and session.committed is committed
        assert session.revision == 0 and session.plan == [] and session.draft_step is None
        cells = [row["values"][0] for row in opened["page"]["rows"]]
        assert [cell["raw"] for cell in cells] == expected
        assert [cell["display"] for cell in cells] == [value or "" for value in expected]
        assert [cell["kind"] for cell in cells] == ["datetime"] * 6 + ["null"]
        assert not any(cell["isNaN"] for cell in cells)
        empty_view = {"filters": [], "sort": []}
        choices = manager.get_column_values(session_id, 0, column, empty_view)["values"]
        assert [item["value"] for item in choices] == [expected[index] for index in [0, 2, 3, 4, 5]]
        assert [item["count"] for item in choices] == [2, 1, 1, 1, 1]
        assert [item["selectionValue"] is not None for item in choices] == [False, True, True, True, False]
        for item, expected_id in zip(choices[1:4], [2, 3, 4], strict=True):
            page = manager.get_page(session_id, 0, 0, 10, selected(item["selectionValue"]))
            assert [row["values"][1]["raw"] for row in page["page"]["rows"]] == [expected_id]
        for needle in ["1969-12-31T23:59:59.999999999", "1969-12-31 23:59:59.999999999"]:
            assert manager.get_column_values(session_id, 0, column, empty_view, needle)["values"] == choices[:1]
        summary = manager.get_summary(session_id, 0, empty_view, ["c:source:0"])["summaries"][0]
        assert (summary["totalCount"], summary["nullCount"], summary["distinctCount"]) == (7, 1, 5)
        assert summary["topValues"] == choices
        assert summary["visualization"] == {"kind": "datetime", "min": expected[0], "max": expected[5]}
        sorted_page = manager.get_page(
            session_id, 0, 0, 10, {"filters": [], "sort": [{"column": column, "direction": "desc", "nulls": "last"}]}
        )
        assert [row["values"][1]["raw"] for row in sorted_page["page"]["rows"]] == [5, 4, 3, 2, 0, 1, 6]
        assert {row["id"] for row in sorted_page["page"]["rows"]} == {row["id"] for row in opened["page"]["rows"]}
        assert isinstance(session.engine, DuckDBEngine)
        native = 'SELECT id, system.main.epoch_ns("when ""ns""") FROM ow ORDER BY id'
        assert session.engine._terminal_rows(original, native) == list(enumerate(ticks))
        model = selected(choices[1]["selectionValue"])
        model["filters"][0]["column"] = {"id": "c:source:0", "name": column}
        operation = bind_step(
            step("filterRows", filterModel=model), session.source_schema, source_lineage(session.source_schema)
        )
        with duckdb_runtime._connect() as connection:
            source = connection.read_parquet(str(path))
            generated = execute_generated(session.engine, source, [operation])
            assert generated.project('id, system.main.epoch_ns("when ""ns""")').fetchall() == [(2, 0)]
            assert source.project('id, system.main.epoch_ns("when ""ns""")').fetchall() == list(enumerate(ticks))
        json.dumps(opened, allow_nan=False)
    finally:
        manager.close_all()
    assert manager.sessions == {}
    after = path.stat()
    assert path.read_bytes() == contents
    assert (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) == (
        before.st_dev,
        before.st_ino,
        before.st_size,
        before.st_mtime_ns,
    )


@pytest.mark.parametrize(
    "container", ["list", "array", "struct", "nested", "map", "map-keys", "map-list-keys", "map-struct-keys"]
)
def test_duckdb_nested_nanosecond_transport_preserves_containers(container: str) -> None:
    epoch = "1970-01-01T00:00:00"
    texts = ["1969-12-31T23:59:59.999999999", epoch, "1970-01-01T00:00:00.000000001", None]
    expressions = {
        "list": "[v]",
        "array": "[v]",
        "struct": 'struct_pack("when ""ns""" := v, ticks := \'ordinary\', text := \'TIMESTAMP_NS\')',
        "nested": "[struct_pack(items := [v], text := 'ordinary')]",
        "map": "map(['when'], [v])",
        "map-keys": "map([coalesce(v, make_timestamp_ns(0))], ['kept'])",
        "map-list-keys": "map([[v]], ['kept'])",
        "map-struct-keys": "map([struct_pack(\"when\" := v)], ['kept'])",
    }
    expected: list[Any] = []
    for value in texts:
        if container in {"list", "array"}:
            expected.append([value])
        elif container == "struct":
            expected.append({'when "ns"': value, "ticks": "ordinary", "text": "TIMESTAMP_NS"})
        elif container == "nested":
            expected.append([{"items": [value], "text": "ordinary"}])
        elif container == "map":
            expected.append({"when": value})
        elif container == "map-keys":
            expected.append({value or epoch: "kept"})
        elif container == "map-list-keys":
            expected.append({"key": [[value]], "value": ["kept"]})
        else:
            expected.append({"key": [{"when": value}], "value": ["kept"]})
    empty_sql = {"list": "[]", "array": "[NULL]", "nested": "[]"}.get(container, "NULL")
    empty_value: Any = {"list": [], "array": [None], "nested": []}.get(container)
    if container.startswith("map"):
        empty_sql = "map()"
        empty_value = {"key": [], "value": []} if container in {"map-list-keys", "map-struct-keys"} else {}
    expected.extend([empty_value, None])
    # The count alias must not shadow the selected column when its result is wrapped.
    value_sql = f"CASE k WHEN 4 THEN {empty_sql} WHEN 5 THEN NULL ELSE {expressions[container]} END"
    if container == "array":
        value_sql = f"({value_sql})::TIMESTAMP_NS[1]"
    query = (
        f"SELECT k, {value_sql} "
        "AS value_count, 41 AS __ow_value_count FROM "
        "(SELECT k, make_timestamp_ns(t) AS v FROM (VALUES (0,-1::BIGINT), (1,0::BIGINT), "
        "(2,1::BIGINT), (3,NULL::BIGINT), (4,NULL::BIGINT), (5,NULL::BIGINT)) source(k,t))"
    )
    engine = DuckDBEngine()
    try:
        frame = engine._relation_from_sql(query)
        schema, original_query = engine.schema(frame), frame.sql_query()
        page = engine.page(frame, 0, 10)
        assert [row["values"][1]["raw"] for row in page["rows"]] == expected
        assert [row["values"][2]["raw"] for row in page["rows"]] == [41] * 6
        assert page["columnIds"] == [column["id"] for column in schema]
        expected_counts = {
            json.dumps(value, ensure_ascii=False, separators=(",", ":")): expected.count(value)
            for value in expected
            if value is not None
        }
        summary = engine.summaries(frame, [(1, "nested")])[0]
        assert (summary["totalCount"], summary["nullCount"], summary["distinctCount"]) == (
            6,
            expected.count(None),
            len(expected_counts),
        )
        assert {item["value"]: item["count"] for item in summary["topValues"]} == expected_counts
        choices, more = engine.column_values(frame, "value_count")
        assert not more and all(item["selectionValue"] is None for item in choices)
        assert {item["value"]: item["count"] for item in choices} == expected_counts
        assert engine.schema(frame) == schema and frame.sql_query() == original_query
        json.dumps(page, allow_nan=False)
    finally:
        engine.close()


def test_duckdb_nested_nanosecond_file_session_preserves_map_entries_and_export(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_conversion_guards(monkeypatch)
    path, output = tmp_path / "nested-ns.parquet", tmp_path / "cleaned.parquet"
    ticks = [-1, 0, 1, None]
    with duckdb_runtime._connect() as connection:
        connection.sql(
            'SELECT id, struct_pack("when" := make_timestamp_ns(t), items := [make_timestamp_ns(t)], '
            "clocks := map([make_timestamp_ns(-1), make_timestamp_ns(0), make_timestamp_ns(1)], "
            "['before', 'at', 'after']), "
            "list_clocks := map([[make_timestamp_ns(-1)], [make_timestamp_ns(0)], [make_timestamp_ns(1)]], "
            "['before', 'at', 'after']), "
            'struct_clocks := map([struct_pack("when" := make_timestamp_ns(-1)), '
            'struct_pack("when" := make_timestamp_ns(0)), struct_pack("when" := make_timestamp_ns(1))], '
            "['before', 'at', 'after'])) AS payload FROM "
            "(VALUES (0,-1::BIGINT), (1,0::BIGINT), (2,1::BIGINT), (3,NULL::BIGINT)) source(id,t)"
        ).write_parquet(str(path))
    before, stat = path.read_bytes(), path.stat()
    manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))
    try:
        opened = manager.open_session(
            {"kind": "file", "path": str(path), "label": path.name}, backend="duckdb", mode="editing", page_size=4
        )
        sid = opened["metadata"]["sessionId"]
        clocks = {
            "1969-12-31T23:59:59.999999999": "before",
            "1970-01-01T00:00:00": "at",
            "1970-01-01T00:00:00.000000001": "after",
        }
        for row in opened["page"]["rows"]:
            payload = row["values"][1]["raw"]
            assert payload["clocks"] == clocks
            assert payload["list_clocks"] == {"key": [[value] for value in clocks], "value": list(clocks.values())}
            assert payload["struct_clocks"] == {
                "key": [{"when": value} for value in clocks],
                "value": list(clocks.values()),
            }
        preview = manager.preview_step(
            sid,
            0,
            {
                "id": "copy-payload",
                "kind": "cloneColumn",
                "params": {"column": {"id": "c:source:1", "name": "payload"}, "newName": "copy"},
            },
            0,
            4,
        )
        applied = manager.apply_draft(sid, preview["revision"], 0, 4)
        assert [row["id"] for row in applied["page"]["rows"]] == [row["id"] for row in opened["page"]["rows"]]
        assert [row["values"][:2] for row in applied["page"]["rows"]] == [
            row["values"] for row in opened["page"]["rows"]
        ]
        assert all(row["values"][1] == row["values"][2] for row in applied["page"]["rows"])
        exported = manager.export_data(
            sid, applied["revision"], str(output), {"format": "parquet"}, reserve_export_target(output)
        )
        assert exported["kind"] == "dataExported"
        scope: dict[str, Any] = {}
        exec(applied["code"], scope)
        with duckdb_runtime._connect() as connection:
            source = connection.read_parquet(str(path))
            query = (
                "id, epoch_ns(payload.when), list_transform(payload.items, x -> epoch_ns(x)), "
                "list_transform(map_keys(payload.clocks), x -> epoch_ns(x)), map_values(payload.clocks), "
                "list_transform(map_keys(payload.list_clocks), x -> list_transform(x, t -> epoch_ns(t))), "
                "map_values(payload.list_clocks), "
                "list_transform(map_keys(payload.struct_clocks), x -> epoch_ns(x.when)), "
                "map_values(payload.struct_clocks)"
            )
            labels = ["before", "at", "after"]
            expected = [
                (index, value, [value], [-1, 0, 1], labels, [[-1], [0], [1]], labels, [-1, 0, 1], labels)
                for index, value in enumerate(ticks)
            ]
            for result in (scope["clean_data"](source), connection.read_parquet(str(output))):
                assert result.project(query).fetchall() == expected
                assert result.project("epoch_ns(copy.when)").fetchall() == [(value,) for value in ticks]
                assert result.types == [*source.types, source.types[1]]
            assert source.project(query).fetchall() == expected
    finally:
        manager.close_all()
    after = path.stat()
    assert path.read_bytes() == before and manager.sessions == {}
    assert (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) == (
        stat.st_dev,
        stat.st_ino,
        stat.st_size,
        stat.st_mtime_ns,
    )


def test_duckdb_nested_nanosecond_projection_leaves_union_members_unchanged() -> None:
    from openwrangler_runtime.engines.base import normalize_cell

    engine = DuckDBEngine()
    with duckdb_runtime._connect() as connection:
        source = connection.sql(
            "SELECT legacy, struct_pack(exact := make_timestamp_ns(1), legacy := legacy) AS mixed "
            "FROM (SELECT union_value(t := make_timestamp_ns(1))::UNION(t TIMESTAMP_NS, text VARCHAR) AS legacy "
            "UNION ALL SELECT union_value(text := 'ordinary')::UNION(t TIMESTAMP_NS, text VARCHAR) "
            "UNION ALL SELECT NULL::UNION(t TIMESTAMP_NS, text VARCHAR))"
        )
        original = source.fetchall()
        try:
            frame = engine.normalize_notebook_relation(source)
            page = engine.page(frame, 0, 3)
            for row, (legacy, _mixed) in zip(page["rows"], original, strict=True):
                assert row["values"][0] == normalize_cell(legacy)
                assert row["values"][1]["raw"] == {
                    "exact": "1970-01-01T00:00:00.000000001",
                    "legacy": normalize_cell(legacy)["raw"],
                }
            assert source.fetchall() == original
        finally:
            engine.close()


@pytest.mark.parametrize(
    ("key_type", "members"),
    [
        (
            "UNION(t TIMESTAMP_NS, text VARCHAR)",
            ["t := make_timestamp_ns(-1)", "t := make_timestamp_ns(0)", "t := make_timestamp_ns(1)"],
        ),
        ("UNION(t TIMESTAMP_NS, text VARCHAR)", ["t := NULL::TIMESTAMP_NS", "text := NULL::VARCHAR"]),
        ("UNION(number INTEGER, flag BOOLEAN)", ["number := 1", "flag := true"]),
    ],
    ids=["fractional-timestamps", "null-members", "integer-and-boolean"],
)
def test_duckdb_union_map_output_refuses_lost_entries(key_type: str, members: list[str]) -> None:
    from openwrangler_runtime.session_result import read_live_page

    engine = DuckDBEngine()
    with duckdb_runtime._connect() as connection:
        connection.execute("CREATE MACRO cardinality(value) AS 0")
        try:
            for ordered in (members, list(reversed(members))):
                keys = ", ".join(f"union_value({member})::{key_type}" for member in ordered)
                source = connection.sql(f"SELECT 0 AS id, map([{keys}], {[7] * len(members)}) AS value")
                native = (
                    "system.main.cardinality(value), list_transform(map_entries(value), item -> "
                    "struct_pack(tag := union_tag(item.key), text := CAST(item.key AS VARCHAR), value := item.value))"
                )
                original = source.project(native).fetchall()
                assert original[0][0] == len(members) > len(source.fetchone()[1])
                frame = engine.normalize_notebook_relation(source)
                schema, query = engine.schema(frame), frame.sql_query()
                with pytest.raises(EngineError, match="Map.*entries.*display"):
                    read_live_page(engine, frame, 0, 1, total_rows=1, column_projection=[(1, "map")])
                with pytest.raises(EngineError, match="Map.*entries.*display"):
                    engine.summaries(frame, [(1, "map")])
                with pytest.raises(EngineError, match="Map.*entries.*display"):
                    engine.column_values(frame, "value")
                assert engine.page(frame, 1, 1)["rows"] == []
                assert engine.page(frame, 0, 1, column_projection=[(0, "id")])["rows"][0]["values"][0]["raw"] == 0
                operation = bound_step("cloneColumn", column=bound_ref("c:source:1", "value", 1), newName="copy")
                live = engine.apply_transform(frame, operation)
                generated = execute_generated(engine, source, [operation])
                for result in (live, generated):
                    assert engine._terminal_rows(
                        result, f"SELECT {native}, {native.replace('(value)', '(copy)')} FROM ow"
                    ) == [(*original[0], *original[0])]
                assert source.project(native).fetchall() == original
                assert engine.schema(frame) == schema and frame.sql_query() == query
        finally:
            engine.close()


@pytest.mark.parametrize(
    ("key_type", "members"),
    [
        (
            "UNION(t TIMESTAMP_NS, text VARCHAR)",
            ["t := make_timestamp_ns(0)", "t := make_timestamp_ns(1000)", "text := 'ordinary'"],
        ),
        ("UNION(text VARCHAR)", ["text := 'key'", "text := 'value'"]),
        ("UNION(items INTEGER[], text VARCHAR)", ["items := [1]", "text := 'ordinary'"]),
        ("UNION(items INTEGER[], text VARCHAR)", ["text := 'key'", "text := 'value'"]),
        ("UNION(items INTEGER[], text VARCHAR)", ["items := NULL::INTEGER[]", "text := 'ordinary'"]),
        (
            "UNION(nested UNION(items INTEGER[], text VARCHAR), text VARCHAR)",
            ["nested := union_value(text := 'inside')", "text := 'outside'"],
        ),
    ],
    ids=["aligned", "literal-carrier-names", "compound", "inactive-compound", "null-compound", "nested-union"],
)
def test_duckdb_union_map_output_preserves_native_carriers(key_type: str, members: list[str]) -> None:
    from openwrangler_runtime.engines.base import normalize_cell

    engine = DuckDBEngine()
    with duckdb_runtime._connect() as connection:
        keys = ", ".join(f"union_value({member})::{key_type}" for member in members)
        source = connection.sql(
            f"SELECT map([{keys}], {[[i] for i in range(len(members))]}) AS value_count "
            f"UNION ALL SELECT map([]::{key_type}[], []::INTEGER[][]) UNION ALL SELECT NULL"
        )
        original = source.fetchall()
        expected = [normalize_cell(row[0]) for row in original]
        try:
            frame = engine.normalize_notebook_relation(source)
            assert [row["values"][0] for row in engine.page(frame, 0, 3)["rows"]] == expected
            counts = {cell["display"]: 1 for cell in expected if not cell["isNull"]}
            summary = engine.summaries(frame)[0]
            assert (summary["totalCount"], summary["nullCount"], summary["distinctCount"]) == (3, 1, 2)
            assert {item["value"]: item["count"] for item in summary["topValues"]} == counts
            choices, more = engine.column_values(frame, "value_count")
            assert not more and all(item["selectionValue"] is None for item in choices)
            assert {item["value"]: item["count"] for item in choices} == counts
            assert source.fetchall() == original
        finally:
            engine.close()


def test_duckdb_nanosecond_endpoints_and_infinities_ignore_caller_format_macros() -> None:
    expected = [
        "-infinity",
        "1677-09-21T00:12:43.145225",
        "1677-09-21T00:12:43.145225001",
        "1969-12-31T23:59:59.999998999",
        "1970-01-01T00:00:00",
        "2262-04-11T23:47:16.854775806",
        "infinity",
        None,
    ]
    engine = DuckDBEngine()
    with duckdb_runtime._connect() as connection:
        source = connection.sql(
            "SELECT * FROM (VALUES (0, '-infinity'::TIMESTAMP_NS), "
            "(1, make_timestamp_ns(-9223372036854775000)), (2, make_timestamp_ns(-9223372036854774999)), "
            "(3, make_timestamp_ns(-1001)), (4, make_timestamp_ns(0)), "
            "(5, make_timestamp_ns(9223372036854775806)), (6, 'infinity'::TIMESTAMP_NS), "
            "(7, NULL::TIMESTAMP_NS)) source(id, value_count)"
        )
        before = source.project("id, system.main.epoch_ns(value_count)").fetchall()
        for macro in [
            '"-"(x, y) AS 97',
            '"+"(x, y) AS 97',
            '"//"(x, y) AS 97',
            '"%"(x, y) AS 97',
            "\"||\"(x, y) AS 'forged'",
            "epoch_ns(x) AS 0",
            "isfinite(x) AS FALSE",
            "make_timestamp(x) AS TIMESTAMP '2000-01-01'",
            "strftime(x, f) AS 'forged'",
            "lpad(x, n, p) AS '007'",
            "replace(x, a, b) AS 'forged'",
        ]:
            connection.execute("CREATE MACRO " + macro)
        try:
            frame = engine.normalize_notebook_relation(source)
            page = engine.page(frame, 0, 10)
            assert [row["values"][1]["raw"] for row in page["rows"]] == expected
            nested = engine.normalize_notebook_relation(source.project("[value_count] AS nested"))
            assert [row["values"][0]["raw"] for row in engine.page(nested, 0, 10)["rows"]] == [
                [value] for value in expected
            ]
            choices, more = engine.column_values(frame, "value_count")
            assert not more
            assert [item["value"] for item in choices] == expected[:-1]
            assert [item["selectionValue"] is not None for item in choices] == [
                False,
                True,
                False,
                False,
                True,
                False,
                False,
            ]
            assert engine.column_values(frame, "value_count", "")[0] == choices
            assert engine.column_values(frame, "value_count", " ")[0] == choices[1:-1]
            assert engine.column_values(frame, "value_count", "InfiniTy")[0] == [choices[0], choices[-1]]
            for label in [expected[1], expected[2]]:
                assert isinstance(label, str)
                matched = [item for item in choices if label in item["value"]]
                assert engine.column_values(frame, "value_count", label)[0] == matched
                assert engine.column_values(frame, "value_count", label.replace("T", " "))[0] == matched
            summary = engine.summaries(frame, [(1, "c:ns")])[0]
            assert summary["topValues"] == choices
            assert summary["visualization"] == {"kind": "datetime", "min": "-infinity", "max": "infinity"}
            assert (summary["totalCount"], summary["nullCount"], summary["nanCount"], summary["distinctCount"]) == (
                8,
                1,
                0,
                7,
            )
            assert source.project("id, system.main.epoch_ns(value_count)").fetchall() == before
            assert connection.sql("SELECT strftime(NULL, 'ignored')").fetchone() == ("forged",)
        finally:
            engine.close()


@pytest.mark.parametrize("empty", [False, True], ids=["all-null", "empty"])
def test_duckdb_nanosecond_empty_and_null_transport(empty: bool) -> None:
    engine = DuckDBEngine()
    try:
        source = engine._relation_from_sql("SELECT NULL::TIMESTAMP_NS AS value" + (" WHERE FALSE" if empty else ""))
        page = engine.page(source, 0, 2)
        assert page["totalRows"] == (0 if empty else 1)
        assert [row["values"][0]["isNull"] for row in page["rows"]] == ([] if empty else [True])
        assert engine.column_values(source, "value") == ([], False)
        summary = engine.summaries(source)[0]
        assert summary["rawType"] == "TIMESTAMP_NS" and summary["topValues"] == []
        assert summary["visualization"] == {"kind": "datetime", "min": None, "max": None}
        assert summary["nullCount"] == summary["totalCount"] == (0 if empty else 1)
        assert engine._terminal_rows(source, "SELECT value FROM ow") == ([] if empty else [(None,)])
    finally:
        engine.close()


@pytest.mark.parametrize("raw_type", ["FLOAT", "DOUBLE"])
@pytest.mark.parametrize(
    ("keep", "expected_positions"),
    [
        ("first", [10, 9, 8, 6, 4, 3, 1]),
        ("last", [10, 9, 7, 5, 4, 2, 0]),
        ("none", [10, 9, 4]),
    ],
)
def test_duckdb_duplicates_preserve_original_float_bits(
    raw_type: str, keep: str, expected_positions: list[int]
) -> None:
    engine = DuckDBEngine()
    source = duckdb.sql(
        f"SELECT * FROM (VALUES (-0.0::{raw_type}, 'a', 0), (0.0::{raw_type}, 'a', 1), "
        f"(0.0::{raw_type}, 'b', 2), (-0.0::{raw_type}, 'b', 3), (-0.0::{raw_type}, 'unique', 4), "
        f"('NaN'::{raw_type}, 'nan', 5), ('NaN'::{raw_type}, 'nan', 6), "
        f"(NULL::{raw_type}, 'null', 7), (NULL::{raw_type}, 'null', 8), "
        f"('Infinity'::{raw_type}, 'infinity', 9), ('-Infinity'::{raw_type}, 'infinity', 10)) "
        'AS source("key""quoted", category, __ow_dupe_order)'
    ).order('"__ow_dupe_order" DESC')
    before = source.fetchall()
    original_by_position = {row[2]: row for row in before}
    operation = bound_step(
        "dropDuplicates",
        columns=[bound_ref("c:source:0", 'key"quoted', 0), bound_ref("c:source:1", "category", 1)],
        keep=keep,
    )
    try:
        for result in (engine.apply_transform(source, operation), execute_generated(engine, source, [operation])):
            actual = rows(result)
            assert [row[2] for row in actual] == expected_positions
            assert list(result.columns) == list(source.columns)
            assert list(map(str, result.types)) == list(map(str, source.types))
            for row in actual:
                expected = original_by_position[row[2]]
                assert row[1:] == expected[1:]
                assert (row[0].hex() if isinstance(row[0], float) else row[0]) == (
                    expected[0].hex() if isinstance(expected[0], float) else expected[0]
                )
        empty = source.limit(0)
        empty_live = engine.apply_transform(empty, operation)
        empty_generated = execute_generated(engine, empty, [operation])
        assert rows(empty_live) == rows(empty_generated) == []
        assert list(map(str, empty_live.types)) == list(map(str, source.types))
        assert list(map(str, empty_generated.types)) == list(map(str, source.types))
        assert repr(source.fetchall()) == repr(before)
    finally:
        engine.close()


@pytest.mark.parametrize(
    ("kind", "keep", "key", "occupied_ordinal"),
    [
        ("dropDuplicates", "first", "missing", False),
        ("dropDuplicates", "first", "__ow_dupe_order", False),
        ("dropDuplicates", "last", "__OW_DUPE_ORDER", False),
        ("dropDuplicates", "none", "__ow_dupe_order_1", True),
        ("markDuplicates", None, "missing", False),
        ("markDuplicates", None, "__ow_dupe_order", False),
        ("markDuplicates", None, "__OW_DUPE_ORDER_1", True),
    ],
)
def test_duckdb_generated_duplicates_do_not_invent_missing_selected_keys(
    kind: str, keep: str | None, key: str, occupied_ordinal: bool
) -> None:
    engine = DuckDBEngine()
    extra = ', 77 AS "__ow_dupe_order"' if occupied_ordinal else ""
    try:
        with duckdb.connect(config={"python_enable_replacements": False}) as connection:
            source = connection.sql(f'SELECT *{extra} FROM (VALUES (5, 20), (5, 10), (7, 30)) input("{key}", payload)')
            before = source.fetchall()
            schema = engine.schema(source)
            lineage = source_lineage(schema)
            public = step(
                kind,
                columns=[lineage[0]],
                **({"keep": keep} if kind == "dropDuplicates" else {"newColumn": "duplicate"}),
            )
            operation = bind_step(public, schema, lineage)
            namespace: dict[str, Any] = {}
            exec(compile(engine.compile_plan([operation]), "<generated-duplicate-keys>", "exec"), namespace)
            generated = namespace["clean_data"](source)
            expected = (
                [before[index] for index in {"first": [0, 2], "last": [1, 2], "none": [2]}[str(keep)]]
                if kind == "dropDuplicates"
                else [(*row, flag) for row, flag in zip(before, [True, True, False], strict=True)]
            )
            assert generated.fetchall() == expected
            assert generated.columns == [*source.columns, *(["duplicate"] if kind == "markDuplicates" else [])]
            assert list(map(str, generated.types)) == [
                *map(str, source.types),
                *(["BOOLEAN"] if kind == "markDuplicates" else []),
            ]
            rebound = connection.sql(f"SELECT *{extra} FROM (VALUES (20), (10), (30)) input(payload)")
            rebound_before = rebound.fetchall()
            with pytest.raises(duckdb.BinderException, match="Referenced column"):
                namespace["clean_data"](rebound)
            assert rebound.fetchall() == rebound_before
            assert source.fetchall() == before
    finally:
        engine.close()


@pytest.mark.parametrize("container", ["list", "struct"])
@pytest.mark.parametrize(
    ("keep", "expected_positions"),
    [("first", [0, 2, 3, 5, 7, 9, 10]), ("last", [1, 2, 4, 6, 8, 9, 10]), ("none", [2, 9, 10])],
)
def test_duckdb_duplicates_preserve_selected_nested_values(
    container: str, keep: str, expected_positions: list[int]
) -> None:
    engine = DuckDBEngine()
    expression = "[value]" if container == "list" else "{'item': value}"
    source = duckdb.sql(
        f"SELECT CASE WHEN seq IN (3, 4) THEN NULL ELSE {expression} END AS key, "
        "seq AS __ow_dupe_rank, -0.0::DOUBLE AS __ow_dupe_count FROM (VALUES "
        "(-0.0::DOUBLE, 0), (0.0::DOUBLE, 1), (1.0::DOUBLE, 2), (NULL::DOUBLE, 3), "
        "(NULL::DOUBLE, 4), (NULL::DOUBLE, 5), (NULL::DOUBLE, 6), ('NaN'::DOUBLE, 7), "
        "('NaN'::DOUBLE, 8), ('Infinity'::DOUBLE, 9), ('-Infinity'::DOUBLE, 10)) AS source(value, seq)"
    )
    before = source.fetchall()
    operation = bound_step("dropDuplicates", columns=[bound_ref("c:source:0", "key", 0)], keep=keep)
    try:
        for result in (engine.apply_transform(source, operation), execute_generated(engine, source, [operation])):
            actual = rows(result)
            assert [row[1] for row in actual] == expected_positions
            assert list(result.columns) == list(source.columns)
            assert list(map(str, result.types)) == list(map(str, source.types))
            for row in actual:
                expected = before[row[1]]
                assert repr(row[0]) == repr(expected[0])
                assert row[2].hex() == expected[2].hex()
        assert repr(source.fetchall()) == repr(before)
    finally:
        engine.close()


@pytest.mark.parametrize("column,extra_label", [("label", False), ("Label", False), ("tags", True), ("tags", False)])
@pytest.mark.parametrize("drop_original", [False, True])
@pytest.mark.parametrize("generated", [False, True], ids=["live", "generated"])
def test_duckdb_multi_label_discovery_uses_unnested_labels(
    column: str, extra_label: bool, drop_original: bool, generated: bool
) -> None:
    engine = DuckDBEngine()
    connection = duckdb.connect()
    query = (
        f'SELECT labels AS "{column}", pos'
        + (", pos + 10 AS label" if extra_label else "")
        + " FROM (VALUES ('b|a', 0), ('b', 1), (NULL, 2), ('', 3), ('a|a', 4)) source(labels, pos)"
    )
    live_source = duckdb.sql(query)
    connection.execute("CREATE TABLE owned_source AS " + query)
    private_source = connection.table("owned_source")
    source = private_source if generated else live_source
    before = (source.sql_query(), source.columns, source.types, source.fetchall())
    try:
        operation = bind_step(
            step(
                "multiLabelBinarize",
                column={"id": "c:source:0", "name": column},
                delimiter="|",
                prefix="tag_",
                dropOriginal=drop_original,
            ),
            engine.schema(source),
            source_lineage(engine.schema(source)),
        )
        base_columns = [name for name in source.columns if not drop_original or name != column]
        base_types = [dtype for name, dtype in zip(source.columns, source.types, strict=True) if name in base_columns]
        flags = [(1, 1), (0, 1), (0, 0), (0, 0), (1, 0)]
        for frame, expected_flags in ((source, flags), (source.limit(0), [])):
            result = (
                execute_generated(engine, frame, [operation]) if generated else engine.apply_transform(frame, operation)
            )
            expected_columns = base_columns + (["tag_a", "tag_b"] if expected_flags else [])
            expected_types = base_types + ([TINYINT] * 2 if expected_flags else [])
            expected_rows = [
                tuple(value for name, value in zip(source.columns, row, strict=True) if name in base_columns) + flag
                for row, flag in zip(frame.fetchall(), expected_flags, strict=True)
            ]
            assert result.columns == expected_columns
            assert result.types == expected_types
            assert rows(result) == expected_rows
            if generated:
                assert result.aggregate("count(*), (SELECT count(*) FROM owned_source)").fetchone() == (
                    len(expected_flags),
                    5,
                )
        assert (source.sql_query(), source.columns, source.types, source.fetchall()) == before
        assert private_source.fetchall() == live_source.fetchall()
        assert connection.sql("SHOW TABLES").fetchall() == [("owned_source",)]
    finally:
        engine.close()
        connection.close()


@pytest.mark.parametrize(
    ("value", "format", "expected", "replace"),
    [
        ("make_timestamp_ns(1704161045123456789)", "%Y-%m-%d %H:%M:%S.%n", "2024-01-02 02:04:05.123456789", False),
        ("make_timestamp_ns(-1)", "%Y-%m-%d", "1969-12-31", True),
        ("TIMESTAMP_S '2024-01-02 03:04:05'", "%S.%n", "05.000000000", False),
        ("TIMESTAMP_MS '2024-01-02 03:04:05.123'", "%S.%n", "05.123000000", False),
        ("TIMESTAMP '2024-01-02 03:04:05.123456'", "%S.%f", "05.123456", False),
        ("DATE '2024-01-02'", "%Y-%m-%d", "2024-01-02", False),
        ("DATE '500000-01-02'", "%Y-%m-%d", "500000-01-02", False),
        ("'infinity'::TIMESTAMP_NS", "%Y-%m-%d", "infinity", False),
        ("'-infinity'::TIMESTAMP_NS", "%Y-%m-%d", "-infinity", False),
        ("'2024-01-02 03:04:05.123456'", "%S.%f", "05.123456", False),
        ("'invalid'", "%Y-%m-%d", None, False),
    ],
    ids=[
        "nanoseconds",
        "negative-day",
        "seconds",
        "milliseconds",
        "microseconds",
        "date",
        "wide-date",
        "infinity",
        "negative-infinity",
        "text",
        "invalid-text",
    ],
)
def test_duckdb_format_datetime_retains_native_values(
    value: str, format: str, expected: str | None, replace: bool
) -> None:
    engine = DuckDBEngine()
    with duckdb_runtime._connect() as connection:
        source = connection.sql(f'SELECT {value} AS "when\'s value", 0 AS row UNION ALL SELECT NULL, 1')
        before = source.project('CAST("when\'s value" AS VARCHAR), row').fetchall()
        source_types = list(source.types)
        target = "when's value" if replace else "formatted's value"
        operation = bound_step(
            "formatDatetime",
            column=bound_ref("c:source:0", "when's value", 0),
            format=format,
            **({} if replace else {"newColumn": target}),
        )
        for result in (engine.apply_transform(source, operation), execute_generated(engine, source, [operation])):
            assert [record[target] for record in records(result)] == [expected, None]
            assert [record["row"] for record in records(result)] == [0, 1]
            assert list(result.columns) == ["when's value", "row", *([] if replace else [target])]
            assert str(result.types[0 if replace else 2]) == "VARCHAR"
        assert source.project('CAST("when\'s value" AS VARCHAR), row').fetchall() == before
        assert list(source.types) == source_types
    engine.close()


@pytest.mark.parametrize("generated", [False, True], ids=["live-owner", "generated"])
def test_duckdb_date_cast_preserves_nanosecond_calendar_boundaries(generated: bool) -> None:
    cases = [
        ("make_timestamp_ns(-9223372036854775000)", "1677-09-21"),
        ("make_timestamp_ns(-9223372036854774999)", "1677-09-21"),
        ("make_timestamp_ns(-86400000000001)", "1969-12-30"),
        ("make_timestamp_ns(-86400000000000)", "1969-12-31"),
        ("make_timestamp_ns(-86399999999999)", "1969-12-31"),
        ("make_timestamp_ns(-1000)", "1969-12-31"),
        ("make_timestamp_ns(-999)", "1969-12-31"),
        ("make_timestamp_ns(-1)", "1969-12-31"),
        ("make_timestamp_ns(0)", "1970-01-01"),
        ("make_timestamp_ns(1)", "1970-01-01"),
        ("make_timestamp_ns(9223372036854775806)", "2262-04-11"),
        ("'-infinity'::TIMESTAMP_NS", "-infinity"),
        ("'infinity'::TIMESTAMP_NS", "infinity"),
        ("NULL::TIMESTAMP_NS", None),
    ]
    values = ", ".join(f"({expression}, {index})" for index, (expression, _) in enumerate(cases))
    engine = DuckDBEngine()
    with duckdb_runtime._connect() as connection:
        try:
            original = connection.sql(f'SELECT * FROM (VALUES {values}) source("when\'s value", kept)')
            source_projection = (
                'system.main.epoch_ns("when\'s value"), '
                "\"when's value\" = '-infinity'::TIMESTAMP_NS, "
                "\"when's value\" = 'infinity'::TIMESTAMP_NS, kept"
            )
            for source in (original, original.filter('"when\'s value" IS NULL'), original.limit(0)):
                before = source.project(source_projection).fetchall()
                identity = (source.sql_query(), source.columns, source.types)
                frame = engine.normalize_notebook_relation(source)
                schema = engine.schema(frame)
                lineage = source_lineage(schema)
                operation = bind_step(step("castColumn", column=lineage[0], dtype="date"), schema, lineage)
                result = (
                    execute_generated(engine, source, [operation])
                    if generated
                    else engine.apply_transform(frame, operation)
                )
                actual = (
                    result.project('CAST("when\'s value" AS VARCHAR), kept').fetchall()
                    if generated
                    else engine._terminal_rows(result, 'SELECT CAST("when\'s value" AS VARCHAR), kept FROM ow')
                )
                assert actual == [(cases[row[-1]][1], row[-1]) for row in before]
                assert result.columns == source.columns
                assert [str(dtype) for dtype in result.types] == ["DATE", "INTEGER"]
                assert derive_lineage(lineage, engine.schema(result), operation) == lineage
                assert source.project(source_projection).fetchall() == before
                assert (source.sql_query(), source.columns, source.types) == identity
        finally:
            engine.close()


def test_duckdb_date_cast_reuses_current_types_and_ignores_caller_epoch_macros() -> None:
    engine = DuckDBEngine()
    with duckdb_runtime._connect() as connection:
        try:
            connection.execute("SET TimeZone = 'America/New_York'")
            column = bound_ref("c:source:0", "value", 0)
            operation = bound_step("castColumn", column=column, dtype="date")
            namespace: dict[str, Any] = {}
            exec(engine.compile_plan([operation]), namespace)
            connection.execute("CREATE MACRO epoch_ns(value) AS 0")
            connection.execute("CREATE MACRO isfinite(value) AS FALSE")
            cases = [
                ("system.main.make_timestamp_ns(-1)", "1969-12-31"),
                ("TIMESTAMP '1969-12-31 23:59:59.999999'", "1969-12-31"),
                ("TIMESTAMPTZ '2024-01-01 00:30:00+00'", "2023-12-31"),
                ("DATE '2500-01-01'", "2500-01-01"),
                ("'2024-02-29'::VARCHAR", "2024-02-29"),
                ("'invalid'::VARCHAR", None),
            ]
            for expression, expected in cases:
                source = connection.sql(f"SELECT {expression} AS value, 7 AS kept")
                before = (source.sql_query(), source.columns, source.types, source.fetchall())
                live = engine.apply_transform(engine.normalize_notebook_relation(source), operation)
                generated = namespace["clean_data"](source)
                for is_generated, result in ((False, live), (True, generated)):
                    actual = (
                        result.project("CAST(value AS VARCHAR), kept").fetchall()
                        if is_generated
                        else engine._terminal_rows(result, "SELECT CAST(value AS VARCHAR), kept FROM ow")
                    )
                    assert actual == [(expected, 7)]
                    assert result.columns == ["value", "kept"]
                    assert [str(dtype) for dtype in result.types] == ["DATE", "INTEGER"]
                assert (source.sql_query(), source.columns, source.types, source.fetchall()) == before
                if str(source.types[0]) == "TIMESTAMP_NS":
                    assert source.project("system.main.epoch_ns(value)").fetchall() == [(-1,)]
            assert connection.sql("SELECT epoch_ns(NULL), isfinite(NULL)").fetchone() == (0, False)
            assert connection.sql("SELECT current_setting('TimeZone')").fetchone() == ("America/New_York",)
        finally:
            engine.close()


@pytest.mark.parametrize("zone", ["UTC", "America/New_York"])
def test_duckdb_format_datetime_retains_the_native_connection_timezone(zone: str) -> None:
    engine = DuckDBEngine()
    sql = "SELECT TIMESTAMPTZ '2024-01-02 03:04:05.123456+01' AS value UNION ALL SELECT NULL"
    format = "%Y-%m-%d %H:%M:%S.%f %z %Z"
    operation = bound_step(
        "formatDatetime", column=bound_ref("c:source:0", "value", 0), format=format, newColumn="formatted"
    )
    live = engine.apply_transform(engine._relation_from_sql(sql), operation)
    assert engine._terminal_rows(live, "SELECT formatted FROM ow") == [
        ("2024-01-02 02:04:05.123456 +00 UTC",),
        (None,),
    ]
    with duckdb_runtime._connect() as connection:
        connection.execute(f"SET TimeZone = '{zone}'")
        source = connection.sql(sql)
        before = source.project("epoch_us(value)").fetchall()
        expected = source.project(f"strftime(value, '{format}')").fetchall()
        generated = execute_generated(engine, source, [operation])
        assert generated.project("formatted").fetchall() == expected
        assert generated.project("epoch_us(value)").fetchall() == before
        assert source.project("epoch_us(value)").fetchall() == before
        assert connection.sql("SELECT current_setting('TimeZone')").fetchone() == (zone,)
    engine.close()


@pytest.mark.parametrize("generated", [False, True], ids=["live-owner", "generated"])
def test_duckdb_format_datetime_precision_ignores_caller_epoch_macro(generated: bool) -> None:
    engine = DuckDBEngine()
    with duckdb_runtime._connect() as connection:
        try:
            source = connection.sql(
                "SELECT make_timestamp_ns(tick) AS value FROM "
                "(VALUES (1704161045123456789::BIGINT), (-1::BIGINT), (NULL::BIGINT)) input(tick)"
            )
            before = (source.sql_query(), source.columns, source.types)
            ticks = [(1704161045123456789,), (-1,), (None,)]
            connection.execute("CREATE MACRO epoch_ns(value) AS 0")
            operation = bound_step(
                "formatDatetime",
                column=bound_ref("c:source:0", "value", 0),
                format="%Y-%m-%dT%H:%M:%S.%n",
                newColumn="formatted",
            )
            if generated:
                result = execute_generated(engine, source, [operation])
                actual = result.project("formatted").fetchall()
            else:
                result = engine.apply_transform(engine.normalize_notebook_relation(source), operation)
                actual = engine._terminal_rows(result, "SELECT formatted FROM ow")
            assert actual == [("2024-01-02T02:04:05.123456789",), ("1969-12-31T23:59:59.999999999",), (None,)]
            assert result.columns == ["value", "formatted"]
            assert [str(dtype) for dtype in result.types] == ["TIMESTAMP_NS", "VARCHAR"]
            assert source.project("system.main.epoch_ns(value)").fetchall() == ticks
            assert (source.sql_query(), source.columns, source.types) == before
            assert connection.sql("SELECT epoch_ns(NULL)").fetchone() == (0,)
        finally:
            engine.close()


@pytest.mark.parametrize("empty", [False, True], ids=["all-null", "empty"])
def test_duckdb_format_datetime_keeps_nulls_and_native_refusals(empty: bool) -> None:
    engine = DuckDBEngine()
    with duckdb_runtime._connect() as connection:
        source = connection.sql(
            "SELECT NULL::TIMESTAMP_NS AS value, 'kept' AS kept" + (" WHERE FALSE" if empty else "")
        )
        before = source.fetchall()
        operation = bound_step(
            "formatDatetime", column=bound_ref("c:source:0", "value", 0), format="%Y-%m-%d", newColumn="formatted"
        )
        for result in (engine.apply_transform(source, operation), execute_generated(engine, source, [operation])):
            assert rows(result) == ([] if empty else [(None, "kept", None)])
            assert str(result.types[-1]) == "VARCHAR"
        invalid = {**operation, "params": {**operation["params"], "format": "%Q"}}
        for execute in (
            lambda: engine.apply_transform(source, invalid),
            lambda: execute_generated(engine, source, [invalid]),
        ):
            with pytest.raises((EngineError, duckdb.Error), match="Unrecognized format"):
                execute()
        collision = {**operation, "params": {**operation["params"], "newColumn": "kept"}}
        schema = engine.schema(source)
        lineage = source_lineage(schema)
        with pytest.raises(ValueError, match="collides"):
            bind_step(step("formatDatetime", column=lineage[0], format="%Y", newColumn="kept"), schema, lineage)
        with pytest.raises(ValueError, match="collides"):
            execute_generated(engine, source, [collision])
        assert source.fetchall() == before
    engine.close()


def test_duckdb_format_datetime_generated_code_uses_the_current_input_type() -> None:
    engine = DuckDBEngine()
    with duckdb_runtime._connect() as connection:
        source = connection.sql("SELECT make_timestamp_ns(1704161045123456789) AS value")
        before = source.project("epoch_ns(value)").fetchall()
        column = bound_ref("c:source:0", "value", 0)
        cast = bound_step("castColumn", column=column, dtype="string")
        format = bound_step("formatDatetime", column=column, format="%S.%n", newColumn="formatted")
        generated = execute_generated(engine, source, [cast, format])
        live = engine.apply_transform(engine.apply_transform(source, cast), format)
        assert rows(generated) == rows(live) == [("2024-01-02 02:04:05.123456789", "05.123456000")]
        namespace: dict[str, Any] = {}
        exec(engine.compile_plan([format]), namespace)
        assert namespace["clean_data"](source).project("formatted").fetchall() == [("05.123456789",)]
        changed_caller = source.project("CAST(value AS VARCHAR) AS value")
        assert namespace["clean_data"](changed_caller).project("formatted").fetchall() == [("05.123456000",)]
        assert source.project("epoch_ns(value)").fetchall() == before
    engine.close()


def test_duckdb_format_datetime_file_session_preserves_source_and_generated_result(tmp_path: Path) -> None:
    path = tmp_path / "timestamps.parquet"
    with duckdb_runtime._connect() as connection:
        source = connection.sql(
            "SELECT make_timestamp_ns(tick) AS value, row FROM "
            "(VALUES (1704161045123456789::BIGINT, 0), (-1::BIGINT, 1), (NULL::BIGINT, 2)) source(tick, row)"
        )
        source.write_parquet(str(path))
    contents, before = path.read_bytes(), path.stat()
    manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))
    try:
        opened = manager.open_session(
            {"kind": "file", "label": path.name, "path": str(path)}, backend="duckdb", mode="editing"
        )
        metadata = opened["metadata"]
        session_id = metadata["sessionId"]
        reference = {key: metadata["schema"][0][key] for key in ("id", "name")}
        preview = manager.preview_step(
            session_id,
            0,
            step("formatDatetime", column=reference, format="%Y-%m-%d %H:%M:%S.%n", newColumn="formatted"),
            0,
            3,
        )
        expected = ["2024-01-02 02:04:05.123456789", "1969-12-31 23:59:59.999999999", None]
        assert [row["values"][-1]["raw"] for row in preview["page"]["rows"]] == expected
        applied = manager.apply_draft(session_id, preview["revision"], 0, 3)
        assert [row["values"][-1]["raw"] for row in applied["page"]["rows"]] == expected
        namespace: dict[str, Any] = {}
        exec(applied["code"], namespace)
        with duckdb_runtime._connect() as connection:
            source = connection.read_parquet(str(path))
            ticks = [(1704161045123456789, 0), (-1, 1), (None, 2)]
            generated = namespace["clean_data"](source)
            assert generated.project("formatted").fetchall() == [(value,) for value in expected]
            assert generated.project("epoch_ns(value), row").fetchall() == ticks
            assert source.project("epoch_ns(value), row").fetchall() == ticks
        session = manager.sessions[session_id]
        assert isinstance(session.engine, DuckDBEngine)
        assert session.engine._terminal_rows(session.original, "SELECT epoch_ns(value), row FROM ow") == ticks
    finally:
        manager.close_all()
    assert manager.sessions == {}
    after = path.stat()
    assert path.read_bytes() == contents
    assert (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) == (
        before.st_dev,
        before.st_ino,
        before.st_size,
        before.st_mtime_ns,
    )


@pytest.mark.parametrize("aligned", [True, False], ids=["aligned", "finer-refusal"])
def test_duckdb_format_datetime_lower_endpoint_preserves_or_refuses(tmp_path: Path, aligned: bool) -> None:
    tick = -9223372036854775000 if aligned else -9223372036854774999
    path = tmp_path / "endpoint.parquet"
    with duckdb_runtime._connect() as connection:
        connection.sql(f"SELECT make_timestamp_ns({tick}) AS value UNION ALL SELECT NULL").write_parquet(str(path))
    contents, before = path.read_bytes(), path.stat()
    manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))
    try:
        opened = manager.open_session(
            {"kind": "file", "label": path.name, "path": str(path)}, backend="duckdb", mode="editing"
        )
        session_id = opened["metadata"]["sessionId"]
        session = manager.sessions[session_id]
        original, committed = session.original, session.committed
        operation = step(
            "formatDatetime",
            column={"id": "c:source:0", "name": "value"},
            format="%Y-%m-%dT%H:%M:%S.%n",
            newColumn="formatted",
        )
        if aligned:
            preview = manager.preview_step(session_id, 0, operation, 0, 2)
            applied = manager.apply_draft(session_id, preview["revision"], 0, 2)
            assert [row["values"][-1]["raw"] for row in applied["page"]["rows"]] == [
                "1677-09-21T00:12:43.145225000",
                None,
            ]
        else:
            with pytest.raises(EngineError, match="Date out of range"):
                manager.preview_step(session_id, 0, operation, 0, 2)
            assert session.revision == 0
            assert session.plan == []
            assert session.draft_step is None
            assert session.draft_frame is None
            assert session.committed is committed
        assert session.original is original
        assert isinstance(session.engine, DuckDBEngine)
        assert session.engine._terminal_rows(original, "SELECT epoch_ns(value) FROM ow") == [(tick,), (None,)]
        bound = bind_step(operation, session.source_schema, source_lineage(session.source_schema))
        with duckdb_runtime._connect() as connection:
            source = connection.read_parquet(str(path))
            if aligned:
                generated = execute_generated(session.engine, source, [bound])
                assert generated.project("formatted").fetchall() == [("1677-09-21T00:12:43.145225000",), (None,)]
            else:
                with pytest.raises((EngineError, duckdb.Error), match="Date out of range"):
                    execute_generated(session.engine, source, [bound]).project("formatted").fetchall()
            assert source.project("epoch_ns(value)").fetchall() == [(tick,), (None,)]
    finally:
        manager.close_all()
    assert manager.sessions == {}
    after = path.stat()
    assert path.read_bytes() == contents
    assert (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) == (
        before.st_dev,
        before.st_ino,
        before.st_size,
        before.st_mtime_ns,
    )


def test_duckdb_missing_modes_encoders_collisions_and_custom_failures() -> None:
    engine = DuckDBEngine()
    missing = duckdb.sql(
        "SELECT * FROM (VALUES (1.0, NULL), (NULL, 2.0), (NULL, NULL), "
        "(CAST('NaN' AS DOUBLE), 3.0), (4.0, 4.0)) AS source(left_value, right_value)"
    )
    missing_columns = [
        bound_ref("c:source:0", "left_value", 0),
        bound_ref("c:source:1", "right_value", 1),
    ]
    drop_any = bound_step("dropMissingRows", columns=missing_columns, how="any")
    drop_all = bound_step("dropMissingRows", columns=missing_columns, how="all")
    assert len(rows(engine.apply_transform(missing, drop_any))) == 1
    assert len(rows(engine.apply_transform(missing, drop_all))) == 4
    assert_same_relation(engine.apply_transform(missing, drop_any), execute_generated(engine, missing, [drop_any]))
    drop_all_columns = bound_step("dropMissingRows", columns=[], how="any")
    assert len(rows(engine.apply_transform(missing, drop_all_columns))) == 1
    assert_same_relation(
        engine.apply_transform(missing, drop_all_columns),
        execute_generated(engine, missing, [drop_all_columns]),
    )

    duplicate = duckdb.sql(
        "SELECT * FROM (VALUES ('a', 1.0), ('a', 1.0), ('b', NULL), ('b', NULL), ('c', 3.0)) AS source(key, value)"
    )
    duplicate_columns = [
        bound_ref("c:source:0", "key", 0),
        bound_ref("c:source:1", "value", 1),
    ]
    keep_last = bound_step("dropDuplicates", columns=duplicate_columns, keep="last")
    keep_none = bound_step("dropDuplicates", columns=duplicate_columns, keep="none")
    assert [row[0] for row in rows(engine.apply_transform(duplicate, keep_last))] == ["a", "b", "c"]
    assert [row[0] for row in rows(engine.apply_transform(duplicate, keep_none))] == ["c"]
    keep_all = bound_step("dropDuplicates", keep="first")
    assert [row[0] for row in rows(engine.apply_transform(duplicate, keep_all))] == ["a", "b", "c"]
    assert_same_relation(
        engine.apply_transform(duplicate, keep_all),
        execute_generated(engine, duplicate, [keep_all]),
    )

    collision = duckdb.sql("SELECT 'a' AS group_name, 7 AS group_name_a")
    operation = bound_step(
        "oneHotEncode",
        columns=[bound_ref("c:source:0", "group_name", 0)],
        prefixSeparator="_",
        dropOriginal=False,
    )
    with pytest.raises(EngineError, match="duplicate column names: group_name_a"):
        engine.apply_transform(collision, operation)
    with pytest.raises(ValueError, match="duplicate column names: group_name_a"):
        execute_generated(engine, collision, [operation])

    private_output = duckdb.sql("SELECT 'open_wrangler_internal_row_id_forged' AS tags, 1 AS keep")
    private_operation = bound_step(
        "multiLabelBinarize",
        column=bound_ref("c:source:0", "tags", 0),
        delimiter="|",
        prefix="__",
        dropOriginal=False,
    )
    with pytest.raises(EngineError, match="reserved private row-identity column"):
        engine.apply_transform(private_output, private_operation)
    with pytest.raises(ValueError, match="reserved private row-identity column"):
        execute_generated(engine, private_output, [private_operation])

    scalar_categories = duckdb.sql(
        """
        SELECT * FROM (VALUES
            (CAST(1.0 AS DOUBLE), TRUE, DATE '2024-01-02'),
            (CAST('NaN' AS DOUBLE), FALSE, DATE '2024-01-03'),
            (CAST(NULL AS DOUBLE), NULL, NULL)
        ) AS source(value, flag, day)
        """
    )
    scalar_operation = bound_step(
        "oneHotEncode",
        columns=[
            bound_ref("c:source:0", "value", 0),
            bound_ref("c:source:1", "flag", 1),
            bound_ref("c:source:2", "day", 2),
        ],
        dropOriginal=False,
    )
    scalar_result = engine.apply_transform(scalar_categories, scalar_operation)
    assert list(scalar_result.columns) == [
        "value",
        "flag",
        "day",
        "day_2024-01-02",
        "day_2024-01-03",
        "flag_False",
        "flag_True",
        "value_1.0",
    ]
    assert_same_relation(scalar_result, execute_generated(engine, scalar_categories, [scalar_operation]))

    padded = "\t\n\r\v\f\u00a0\u2003X\t\n\r\v\f\u00a0\u2003"
    whitespace = duckdb.sql(f"SELECT '{padded}' AS text")
    strip_operation = bound_step(
        "stripText",
        column=bound_ref("c:source:0", "text", 0),
        newColumn="clean",
    )
    stripped = engine.apply_transform(whitespace, strip_operation)
    assert records(stripped)[0]["clean"] == "X"
    assert_same_relation(stripped, execute_generated(engine, whitespace, [strip_operation]))

    with pytest.raises(EngineError, match="Custom DuckDB code failed: boom"):
        engine.apply_transform(source_relation(), step("customCode", code="raise ValueError('boom')"))
    with pytest.raises(EngineError, match="must assign a DuckDBPyRelation"):
        engine.apply_transform(source_relation(), step("customCode", code="result = 42"))
    engine.close()


def test_duckdb_file_session_preview_apply_profile_export_and_close(tmp_path: Path) -> None:
    source = tmp_path / "session.csv"
    source.write_text("group,value\na,1\na,2\nb,3\n", encoding="utf-8")
    manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))
    opened = manager.open_session(
        {"kind": "file", "label": source.name, "path": str(source)},
        backend="duckdb",
        page_size=2,
    )
    session_id = opened["metadata"]["sessionId"]
    assert opened["metadata"]["backend"] == "duckdb"
    assert opened["metadata"]["shape"] == {"rows": 3, "columns": 2}
    assert isinstance(manager.sessions[session_id].original, DuckDBSqlPlan)
    session_engine = manager.sessions[session_id].engine
    assert isinstance(session_engine, DuckDBEngine)
    assert "read_csv" in manager.sessions[session_id].original.sql_query().lower()

    operation = step(
        "formula",
        leftColumn={"id": "c:source:1", "name": "value"},
        operator="multiply",
        value=10,
        newColumn="score",
    )
    preview = manager.preview_step(session_id, 0, operation, 0, 10)
    assert preview["revision"] == 1
    assert preview["diff"]["addedColumns"] == ["score"]
    applied = manager.apply_draft(session_id, 1, 0, 10)
    assert applied["revision"] == 2
    namespace: dict[str, Any] = {}
    exec(compile(applied["code"], "<public-file-generated-plan>", "exec"), namespace)
    with duckdb.connect() as connection:
        generated = namespace["clean_data"](connection.read_csv(str(source), header=True))
        assert generated.fetchall() == [("a", 1, 10), ("a", 2, 20), ("b", 3, 30)]
        assert [str(dtype) for dtype in generated.types] == ["VARCHAR", "BIGINT", "BIGINT"]
    summary = manager.get_summary(
        session_id,
        2,
        {"logic": "and", "filters": [], "sort": []},
        ["c:step:duckdb-formula:0"],
    )["summaries"][0]
    assert summary["numeric"] == {
        "min": 10.0,
        "max": 30.0,
        "mean": 20.0,
        "median": 20.0,
        "std": 10.0,
        "sum": 60.0,
        "exactSum": {
            "kind": "integer",
            "raw": 60,
            "display": "60",
            "isNull": False,
            "isNaN": False,
        },
        "exactMin": {
            "kind": "integer",
            "raw": 10,
            "display": "10",
            "isNull": False,
            "isNaN": False,
        },
        "exactMax": {
            "kind": "integer",
            "raw": 30,
            "display": "30",
            "isNull": False,
            "isNaN": False,
        },
    }

    destination = tmp_path / "cleaned.parquet"
    exported = manager.export_data(
        session_id,
        2,
        str(destination),
        export_options("parquet"),
        reserve_export_target(destination),
    )
    assert exported["shape"] == {"rows": 3, "columns": 3}
    assert duckdb.read_parquet(str(destination)).fetchall() == [("a", 1, 10), ("a", 2, 20), ("b", 3, 30)]
    assert manager.close_session(session_id, 2) == {"kind": "sessionClosed", "sessionId": session_id}
    assert manager.sessions == {}
    manager.close_all()


def test_duckdb_grouped_integer_export_matches_generated_code_and_refuses_hidden_overflow(tmp_path: Path) -> None:
    source = tmp_path / "source.csv"
    original = b"group key,value\ng,9007199254740992\ng,1\nh,9007199254740992\nh,2\nmissing,\n"
    source.write_bytes(original)
    manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))
    opened = manager.open_session(
        {"kind": "file", "label": source.name, "path": str(source)}, backend="duckdb", page_size=1
    )
    session_id = opened["metadata"]["sessionId"]
    try:
        preview = manager.preview_step(
            session_id,
            0,
            step(
                "groupBy",
                keys=[{"id": "c:source:0", "name": "group key"}],
                aggregations=[
                    {
                        "column": {"id": "c:source:1", "name": "value"},
                        "operation": "sum",
                        "alias": 'total "exact"',
                    }
                ],
            ),
            0,
            1,
        )
        applied = manager.apply_draft(session_id, preview["revision"], 0, 1)
        engine = manager.sessions[session_id].engine
        expected = [("g", 2**53 + 1), ("h", 2**53 + 2), ("missing", 0)]
        namespace: dict[str, Any] = {}
        exec(compile(applied["code"], "<exported-cleaning-plan>", "exec"), namespace, namespace)
        generated = namespace["clean_data"](duckdb.read_csv(str(source), header=True))
        assert generated.fetchall() == expected
        assert [str(dtype) for dtype in generated.types] == ["VARCHAR", "HUGEINT"]
        confirmed = manager.get_page(session_id, applied["revision"], 0, 10, {"filters": [], "sort": []})
        for format_name in ("csv", "parquet"):
            live_path = tmp_path / f"live.{format_name}"
            result = manager.export_data(
                session_id,
                applied["revision"],
                str(live_path),
                export_options(format_name),
                reserve_export_target(live_path),
            )
            assert result["kind"] == "dataExported"
            generated_path = tmp_path / f"generated.{format_name}"
            identity = reserve_export_target(generated_path)
            with ExportTarget(
                generated_path, int(identity["device"]), int(identity["inode"])
            ).pinned_writer_path() as writer:
                engine.export_data(generated, writer, export_options(format_name))
            for destination in (live_path, generated_path):
                loaded = engine.read_file(str(destination))
                assert rows(loaded) == expected
                assert [column["name"] for column in engine.schema(loaded)] == ["group key", 'total "exact"']
                if format_name == "parquet":
                    assert engine.schema(loaded)[1]["rawType"] == "DECIMAL(38,0)"
                    assert all(isinstance(row[1], Decimal) for row in rows(loaded))
        assert manager.get_page(session_id, applied["revision"], 0, 10, {"filters": [], "sort": []}) == confirmed

        # The first preview row is valid; a later committed row exceeds Parquet Decimal capacity.
        expression = (
            '"group key", CASE WHEN "group key" = \'h\' '
            f'THEN \'{2**127 - 1}\'::HUGEINT ELSE "total ""exact""" END AS value'
        )
        preview = manager.preview_step(
            session_id, applied["revision"], step("customCode", code=f"result = df.project({expression!r})"), 0, 1
        )
        applied = manager.apply_draft(session_id, preview["revision"], 0, 1)
        confirmed = manager.get_page(session_id, applied["revision"], 0, 10, {"filters": [], "sort": []})
        rejected_path = tmp_path / "unpublished.parquet"
        with pytest.raises(EngineError, match="DECIMAL"):
            manager.export_data(
                session_id,
                applied["revision"],
                str(rejected_path),
                export_options("parquet"),
                reserve_export_target(rejected_path),
            )
        namespace = {}
        exec(compile(applied["code"], "<exported-cleaning-plan>", "exec"), namespace, namespace)
        generated = namespace["clean_data"](
            duckdb.read_csv(str(source), header=True), connection=duckdb.default_connection()
        )
        rejected_generated = tmp_path / "unpublished-generated.parquet"
        identity = reserve_export_target(rejected_generated)
        with (
            ExportTarget(
                rejected_generated, int(identity["device"]), int(identity["inode"])
            ).pinned_writer_path() as writer,
            pytest.raises(EngineError, match="DECIMAL"),
        ):
            export_generated_native(engine, generated, duckdb.default_connection(), writer, export_options("parquet"))
        assert manager.get_page(session_id, applied["revision"], 0, 10, {"filters": [], "sort": []}) == confirmed
        fallback = tmp_path / "exact.csv"
        assert (
            manager.export_data(
                session_id, applied["revision"], str(fallback), export_options("csv"), reserve_export_target(fallback)
            )["kind"]
            == "dataExported"
        )
        assert str(2**127 - 1) in fallback.read_text()
        assert source.read_bytes() == original
    finally:
        manager.close_all()


@pytest.mark.parametrize("invalid", ["interval", "map_key"])
def test_duckdb_temporal_export_matches_generated_code_and_refuses_hidden_loss(tmp_path: Path, invalid: str) -> None:
    source = tmp_path / "temporal.csv"
    original = b"row,micros,clock\n1,1000,12:00:00+02\n2,1,10:00:00+00\n3,,\n"
    source.write_bytes(original)
    manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))
    opened = manager.open_session(
        {"kind": "file", "label": source.name, "path": str(source)}, backend="duckdb", page_size=1
    )
    session_id = opened["metadata"]["sessionId"]
    try:
        expression = (
            'row, to_microseconds(micros * 1000) AS "elapsed ""exact""", '
            'clock::TIMETZ AS clock, 9007199254740993::HUGEINT AS "wide integer"'
        )
        preview = manager.preview_step(
            session_id, 0, step("customCode", code=f"result = df.project({expression!r})"), 0, 1
        )
        applied = manager.apply_draft(session_id, preview["revision"], 0, 1)
        engine = manager.sessions[session_id].engine
        namespace: dict[str, Any] = {}
        exec(compile(applied["code"], "<temporal-cleaning-plan>", "exec"), namespace, namespace)
        generated = namespace["clean_data"](
            duckdb.read_csv(str(source), header=True), connection=duckdb.default_connection()
        )
        text_projection = 'row, "elapsed ""exact"""::VARCHAR, clock::VARCHAR, "wide integer"::VARCHAR'
        before = generated.project(text_projection).fetchall()
        assert before == [
            (1, "00:00:01", "12:00:00+02", "9007199254740993"),
            (2, "00:00:00.001", "10:00:00+00", "9007199254740993"),
            (3, None, None, "9007199254740993"),
        ]
        confirmed = manager.get_page(session_id, applied["revision"], 0, 10, {"filters": [], "sort": []})
        for mode in ("live", "generated"):
            destination = tmp_path / f"{mode}.parquet"
            identity = reserve_export_target(destination)
            if mode == "live":
                assert (
                    manager.export_data(
                        session_id, applied["revision"], str(destination), export_options("parquet"), identity
                    )["kind"]
                    == "dataExported"
                )
            else:
                with ExportTarget(
                    destination, int(identity["device"]), int(identity["inode"])
                ).pinned_writer_path() as writer:
                    export_generated_native(
                        engine, generated, duckdb.default_connection(), writer, export_options("parquet")
                    )
            loaded = duckdb.read_parquet(str(destination))
            assert loaded.project(text_projection).fetchall() == [
                (1, "00:00:01", "10:00:00+00", "9007199254740993"),
                (2, "00:00:00.001", "10:00:00+00", "9007199254740993"),
                (3, None, None, "9007199254740993"),
            ]
            assert [str(dtype) for dtype in loaded.types] == [
                "BIGINT",
                "INTERVAL",
                "TIME WITH TIME ZONE",
                "DECIMAL(38,0)",
            ]
            assert [column["name"] for column in engine.schema(engine.read_file(str(destination)))] == generated.columns
        assert manager.get_page(session_id, applied["revision"], 0, 10, {"filters": [], "sort": []}) == confirmed
        assert generated.project(text_projection).fetchall() == before

        # Only a later committed row is unsafe; preview and Apply show the valid first row.
        bad_value = (
            "CASE WHEN row = 2 THEN [INTERVAL '1 microsecond'] ELSE [INTERVAL '1 millisecond'] END"
            if invalid == "interval"
            else "CASE WHEN row = 2 THEN MAP(['12:00:00+02'::TIMETZ, '10:00:00+00'::TIMETZ], ['a','b']) "
            "ELSE MAP(['10:00:00+00'::TIMETZ], ['safe']) END"
        )
        expression = f"*, {bad_value} AS nested"
        hidden_step = step("customCode", code=f"result = df.project({expression!r})")
        hidden_step["id"] = "temporal-hidden-loss"
        preview = manager.preview_step(session_id, applied["revision"], hidden_step, 0, 1)
        applied = manager.apply_draft(session_id, preview["revision"], 0, 1)
        confirmed = manager.get_page(session_id, applied["revision"], 0, 10, {"filters": [], "sort": []})
        namespace = {}
        exec(compile(applied["code"], "<temporal-cleaning-plan>", "exec"), namespace, namespace)
        generated = namespace["clean_data"](
            duckdb.read_csv(str(source), header=True), connection=duckdb.default_connection()
        )
        if invalid == "map_key":
            assert generated.filter("row = 2").project(
                "map_extract_value(nested,'12:00:00+02'::TIMETZ), map_extract_value(nested,'10:00:00+00'::TIMETZ)"
            ).fetchall() == [("a", "b")]
        for mode in ("live", "generated"):
            destination = tmp_path / f"unpublished-{mode}.parquet"
            identity = reserve_export_target(destination)
            with pytest.raises(EngineError, match="cannot preserve.*temporal"):
                if mode == "live":
                    manager.export_data(
                        session_id, applied["revision"], str(destination), export_options("parquet"), identity
                    )
                else:
                    with ExportTarget(
                        destination, int(identity["device"]), int(identity["inode"])
                    ).pinned_writer_path() as writer:
                        export_generated_native(
                            engine, generated, duckdb.default_connection(), writer, export_options("parquet")
                        )
            assert _regular_file_identity(destination) == (int(identity["device"]), int(identity["inode"]))
        assert manager.get_page(session_id, applied["revision"], 0, 10, {"filters": [], "sort": []}) == confirmed
        fallback = tmp_path / "exact.csv"
        assert (
            manager.export_data(
                session_id, applied["revision"], str(fallback), export_options("csv"), reserve_export_target(fallback)
            )["kind"]
            == "dataExported"
        )
        assert ("00:00:00.000001" if invalid == "interval" else "12:00:00+02") in fallback.read_text()
        assert source.read_bytes() == original
    finally:
        manager.close_all()


@pytest.mark.parametrize("source_kind", ["notebookVariable", "notebookOutput"])
def test_duckdb_live_notebook_session_owns_the_exact_relation_without_conversion_or_sql_replay(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    source_kind: str,
) -> None:
    install_conversion_guards(monkeypatch)
    connection = duckdb.connect()
    connection.execute(
        "CREATE TABLE private_orders AS "
        "SELECT * FROM (VALUES (7, 'Milan'), (11, 'Berlin'), (9, 'Paris'), (13, 'Berlin')) AS rows(order_id, city)"
    )
    relation = connection.table("private_orders").project("*, uuid() AS token").order("random()")
    monkeypatch.setattr(__main__, "duck_orders", relation, raising=False)
    monkeypatch.setattr(__main__, "orders_connection", connection, raising=False)
    source = {
        "kind": source_kind,
        "label": "duck_orders",
        "variableName": "duck_orders",
        "duckdbConnection": {"kind": "variable", "name": "orders_connection"},
    }

    def reject_unrelated_connection() -> Any:
        raise AssertionError("A live notebook relation must never replay SQL on an unrelated DuckDB connection")

    monkeypatch.setattr(duckdb_runtime, "_connect", reject_unrelated_connection)
    manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))
    owner = None
    try:
        opened = manager.open_session(
            source,
            backend="duckdb",
            mode="editing",
            page_size=2,
        )
        session_id = opened["metadata"]["sessionId"]
        assert opened["metadata"]["backend"] == "duckdb"
        assert opened["metadata"]["mode"] == "viewing"
        assert opened["metadata"]["capabilities"] == {
            "editable": False,
            "lazy": False,
            "cancel": False,
            "exportCsv": False,
            "exportParquet": False,
            "notebookInsert": False,
            "supportedOperations": [],
        }
        assert opened["metadata"]["shape"] == {"rows": 4, "columns": 3}
        view = {"logic": "and", "filters": [], "sort": []}
        full_page = manager.get_page(session_id, 0, 0, 4, view)["page"]
        adjacent = manager.get_page(session_id, 0, 2, 2, view)["page"]
        assert opened["page"]["rows"] + adjacent["rows"] == full_page["rows"]
        assert {row["values"][0]["display"] for row in full_page["rows"]} == {"7", "9", "11", "13"}
        projected = [
            row for offset in (0, 2) for row in manager.get_page(session_id, 0, offset, 2, view, 2, 1)["page"]["rows"]
        ]
        assert projected == [{**row, "values": [row["values"][2]]} for row in full_page["rows"]]
        original = manager.sessions[session_id].original
        assert isinstance(original, DuckDBNotebookPlan)
        owner = original.owner
        filtered_view = {
            "filters": [
                {
                    "column": "order_id",
                    "type": "integer",
                    "predicates": [{"kind": "predicate", "operator": "gte", "value": 9}],
                }
            ],
            "sort": [{"column": "city", "direction": "asc", "nulls": "last"}],
        }
        expected = sorted(
            (row for row in full_page["rows"] if row["values"][0]["raw"] >= 9),
            key=lambda row: row["values"][1]["raw"],
        )
        filtered_rows = [
            row
            for offset in (0, 2)
            for row in manager.get_page(session_id, 0, offset, 2, filtered_view)["page"]["rows"]
        ]
        assert {row["values"][0]["raw"] for row in filtered_rows} == {9, 11, 13}
        assert filtered_rows == [{**row, "rowNumber": index} for index, row in enumerate(expected)]
        copied = [
            row
            for offset in (0, 2)
            for row in manager.get_page(session_id, 0, offset, 2, filtered_view, 2, 1)["page"]["rows"]
        ]
        assert copied == [{**row, "values": [row["values"][2]]} for row in filtered_rows]

        sorted_page = manager.get_page(
            session_id,
            0,
            0,
            10,
            {
                "logic": "and",
                "filters": [],
                "sort": [{"column": "order_id", "direction": "desc", "nulls": "last"}],
            },
        )
        assert [row["values"][0]["display"] for row in sorted_page["page"]["rows"]] == ["13", "11", "9", "7"]
        summary = manager.get_summary(
            session_id,
            0,
            {"logic": "and", "filters": [], "sort": []},
            ["c:source:0"],
        )["summaries"][0]
        assert summary["numeric"]["min"] == 7.0
        assert summary["numeric"]["max"] == 13.0

        with pytest.raises(EngineError, match="viewing mode"):
            manager.preview_step(
                session_id,
                0,
                step(
                    "sortRows",
                    rules=[
                        {
                            "column": {"id": "c:source:0", "name": "order_id"},
                            "direction": "asc",
                            "nulls": "last",
                        }
                    ],
                ),
                0,
                10,
            )
        with pytest.raises(EngineError, match="viewing mode"):
            manager.export_data(session_id, 0, str(tmp_path / "must-not-export.csv"), export_options("csv"))

        cloned = manager.open_session(
            source,
            backend="duckdb",
            mode="viewing",
            page_size=4,
            clone_from={"sessionId": session_id, "revision": 0},
        )
        clone_id = cloned["metadata"]["sessionId"]
        assert manager.close_session(session_id, 0) == {"kind": "sessionClosed", "sessionId": session_id}
        assert owner.closed is True
        assert manager.get_page(clone_id, 0, 0, 4, view)["page"]["rows"] == full_page["rows"]
        assert vars(__main__)["duck_orders"] is relation
        assert connection.table("private_orders").fetchall() == [
            (7, "Milan"),
            (11, "Berlin"),
            (9, "Paris"),
            (13, "Berlin"),
        ]
        assert relation.project("order_id").order("order_id").fetchall() == [(7,), (9,), (11,), (13,)]
        monkeypatch.setattr(__main__, "orders_connection", object())
        with pytest.raises(EngineError, match="no longer available"):
            manager.open_session(source, backend="duckdb", page_size=2)
        assert list(manager.sessions) == [clone_id]
        assert connection.sql("SELECT 17").fetchone() == (17,)
    finally:
        manager.close_all()
        connection.close()


@pytest.mark.parametrize("mode", ["rows", "metadata", "multiple", "binding_error", "execution_error", "source_removed"])
def test_duckdb_notebook_terminal_releases_only_its_query_view(mode: str) -> None:
    calls: list[int] = []
    with duckdb.connect() as connection:

        def observed(value: int) -> int:
            calls.append(value)
            if mode == "execution_error":
                raise ValueError("owned source execution failed")
            return value

        connection.create_function("owned_observed", observed, [BIGINT], BIGINT, side_effects=True)
        connection.execute("CREATE TABLE owned_source AS SELECT * FROM (VALUES (7::BIGINT), (11)) source(value)")
        connection.execute("CREATE TEMP VIEW unrelated_view AS SELECT 29 AS sentinel")
        relation = connection.sql("SELECT owned_observed(value) AS value FROM owned_source")
        owner = duckdb_runtime._DuckDBNotebookRelationOwner(relation)
        sql = f'SELECT * FROM "{owner.alias}"'
        try:
            with owner.terminal() as terminal:
                if mode == "binding_error":
                    with pytest.raises(duckdb.BinderException, match="absent"):
                        terminal.execute(f'SELECT absent FROM "{owner.alias}"')
                elif mode == "execution_error":
                    with pytest.raises(duckdb.InvalidInputException, match="owned source execution failed"):
                        terminal.execute(sql).fetchall()
                elif mode == "metadata":
                    result = terminal.sql(sql)
                    assert result.columns == ["value"]
                    assert [str(dtype) for dtype in result.types] == ["BIGINT"]
                    result = None
                else:
                    assert terminal.execute(sql).fetchall() == [(7,), (11,)]
                    if mode == "multiple":
                        assert terminal.execute(f'SELECT sum(value) FROM "{owner.alias}"').fetchone() == (18,)
                    if mode == "source_removed":
                        connection.execute("DROP TABLE owned_source")
            expected_calls = [] if mode in {"metadata", "binding_error"} else [7]
            if mode not in {"metadata", "binding_error", "execution_error"}:
                expected_calls = [7, 11] * (2 if mode == "multiple" else 1)
            assert calls == expected_calls
            assert (
                connection.execute(
                    "SELECT view_name FROM duckdb_views() "
                    "WHERE starts_with(view_name, '__open_wrangler_notebook_source_')"
                ).fetchall()
                == []
            )
            assert connection.execute("SELECT * FROM unrelated_view").fetchall() == [(29,)]
        finally:
            owner.close()
            owner.close()
        assert owner.closed is True
        assert calls == expected_calls
        assert connection.execute("SELECT 1").fetchone() == (1,)


@pytest.mark.parametrize(
    ("object_kind", "uppercase"),
    [("TABLE", False), ("VIEW", False), ("TEMP TABLE", False), ("TEMP VIEW", False), ("TEMP VIEW", True)],
)
def test_duckdb_notebook_query_alias_collision_preserves_caller_object(
    monkeypatch: pytest.MonkeyPatch, object_kind: str, uppercase: bool
) -> None:
    from uuid import UUID

    monkeypatch.setattr(duckdb_runtime, "uuid4", lambda: UUID(int=1))
    alias = "__open_wrangler_notebook_source_" + UUID(int=1).hex
    existing_name = alias.upper() if uppercase else alias
    with duckdb.connect() as connection:
        connection.execute(f'CREATE {object_kind} "{existing_name}" AS SELECT 99 AS sentinel')
        relation = connection.sql("SELECT 7 AS value")
        engine = DuckDBEngine()
        try:
            with pytest.raises(EngineError, match="already exists"):
                engine.normalize_notebook_relation(relation)
            assert connection.execute(f'SELECT * FROM "{existing_name}"').fetchall() == [(99,)]
            assert relation.fetchall() == [(7,)]
        finally:
            engine.close()
            engine.close()
        assert connection.execute(f'SELECT * FROM "{existing_name}"').fetchall() == [(99,)]


@pytest.mark.parametrize("read_again", [False, True])
def test_duckdb_notebook_query_view_replacement_is_not_overwritten_or_removed(read_again: bool) -> None:
    with duckdb.connect() as connection:
        relation = connection.sql("SELECT 7 AS value")
        owner = duckdb_runtime._DuckDBNotebookRelationOwner(relation)
        try:
            with owner.terminal() as terminal:
                assert terminal.execute(f'SELECT * FROM "{owner.alias}"').fetchall() == [(7,)]
                original_oid = connection.execute(
                    "SELECT view_oid FROM duckdb_views() WHERE view_name = ?", [owner.alias]
                ).fetchone()
                connection.execute(f'CREATE OR REPLACE TEMP VIEW "{owner.alias}" AS SELECT 99 AS sentinel')
                replacement_oid = connection.execute(
                    "SELECT view_oid FROM duckdb_views() WHERE view_name = ?", [owner.alias]
                ).fetchone()
                assert replacement_oid != original_oid
                if read_again:
                    with pytest.raises(EngineError, match="no longer owned"):
                        terminal.execute(f'SELECT * FROM "{owner.alias}"')
            assert connection.execute(f'SELECT * FROM "{owner.alias}"').fetchall() == [(99,)]
            assert (
                connection.execute("SELECT view_oid FROM duckdb_views() WHERE view_name = ?", [owner.alias]).fetchone()
                == replacement_oid
            )
        finally:
            owner.close()
        assert relation.fetchall() == [(7,)]


def test_duckdb_notebook_terminal_cleanup_does_not_replace_the_primary_error() -> None:
    connection = duckdb.connect()
    owner = duckdb_runtime._DuckDBNotebookRelationOwner(connection.sql("SELECT 7 AS value"))
    try:
        with pytest.raises(duckdb.BinderException, match="absent"), owner.terminal() as terminal:
            try:
                terminal.execute(f'SELECT absent FROM "{owner.alias}"')
            except duckdb.BinderException:
                connection.close()
                raise
    finally:
        owner.close()
        connection.close()
    assert owner.closed is True


def test_duckdb_notebook_session_close_does_not_leave_query_views(monkeypatch: pytest.MonkeyPatch) -> None:
    with duckdb.connect() as connection:
        connection.execute("CREATE TABLE private_values AS SELECT 7 AS value UNION ALL SELECT 11")
        relation = connection.table("private_values")
        monkeypatch.setattr(__main__, "owned_values", relation, raising=False)
        monkeypatch.setattr(__main__, "values_connection", connection, raising=False)
        manager = SessionManager(EngineRegistry((("duckdb", DuckDBEngine),)))
        try:
            for _ in range(2):
                opened = manager.open_session(
                    {
                        "kind": "notebookVariable",
                        "label": "owned_values",
                        "variableName": "owned_values",
                        "duckdbConnection": {"kind": "variable", "name": "values_connection"},
                    },
                    backend="duckdb",
                    page_size=2,
                )
                session_id = opened["metadata"]["sessionId"]
                assert [row["values"][0]["display"] for row in opened["page"]["rows"]] == ["7", "11"]
                original = manager.sessions[session_id].original
                assert isinstance(original, DuckDBNotebookPlan)
                manager.close_session(session_id, opened["metadata"]["revision"])
                assert original.owner.closed is True
                assert (
                    connection.execute(
                        "SELECT view_name FROM duckdb_views() "
                        "WHERE starts_with(view_name, '__open_wrangler_notebook_source_')"
                    ).fetchall()
                    == []
                )
                assert relation.fetchall() == [(7,), (11,)]
        finally:
            manager.close_all()
            manager.close_all()


@pytest.mark.parametrize("kind", ["floorNumber", "ceilNumber"])
@pytest.mark.parametrize("replace", [False, True])
@pytest.mark.parametrize("dtype,value", [("BIGINT", 2**53 + 1), ("UBIGINT", 2**64 - 1), ("HUGEINT", 2**100 + 1)])
def test_duckdb_floor_ceil_preserve_exact_integers(kind: str, replace: bool, dtype: str, value: int) -> None:
    engine = DuckDBEngine()
    source = duckdb.sql(f"SELECT * FROM (VALUES ({value}::{dtype}, 1), (NULL::{dtype}, 2)) source(value, kept)")
    try:
        native = engine.normalize_notebook_relation(source)
        schema = engine.schema(native)
        lineage = source_lineage(schema)
        operation = bind_step(
            step(kind, column=lineage[0], **({} if replace else {"newColumn": "integral"})), schema, lineage
        )
        live = engine.apply_transform(native, operation)
        generated = execute_generated(engine, source, [operation])
        expected = [(value, 1), (None, 2)] if replace else [(value, 1, value), (None, 2, None)]
        assert engine._terminal_rows(live, "SELECT * FROM ow") == expected
        assert generated.fetchall() == expected
        assert str(live.types[0 if replace else -1]) == dtype
        assert str(generated.types[0 if replace else -1]) == dtype
        assert source.fetchall() == [(value, 1), (None, 2)]
    finally:
        engine.close()


@pytest.mark.parametrize("kind,expected", [("floorNumber", [1, 0, -2, -1, None]), ("ceilNumber", [2, 1, -1, 0, None])])
def test_duckdb_floor_ceil_keep_decimal_offsets(kind: str, expected: list[int | None]) -> None:
    engine = DuckDBEngine()
    source = duckdb.sql(
        "SELECT v::DECIMAL(38,28) AS value FROM (VALUES ('1.0000000000000000000000000001'), "
        "('0.9999999999999999999999999999'), ('-1.0000000000000000000000000001'), "
        "('-0.9999999999999999999999999999'), (NULL)) source(v)"
    )
    before = source.fetchall()
    try:
        native = engine.normalize_notebook_relation(source)
        schema = engine.schema(native)
        lineage = source_lineage(schema)
        operation = bind_step(step(kind, column=lineage[0], newColumn="integral"), schema, lineage)
        live = engine.apply_transform(native, operation)
        generated = execute_generated(engine, source, [operation])
        assert [row[-1] for row in engine._terminal_rows(live, "SELECT * FROM ow")] == expected
        assert [row[-1] for row in generated.fetchall()] == expected
        assert str(live.types[-1]) == "DECIMAL(38,0)"
        assert str(generated.types[-1]) == "DECIMAL(38,0)"
        assert source.fetchall() == before
    finally:
        engine.close()


@pytest.mark.parametrize("kind", ["floorNumber", "ceilNumber"])
@pytest.mark.parametrize(
    "value",
    [
        "[1,2]::INTEGER[]",
        "[1,2]::INTEGER[2]",
        "{'a': 1}::STRUCT(a INTEGER)",
        "[1.1]::DECIMAL(4,1)[]",
        "'integer'::ENUM('integer','other')",
        "'decimal'::ENUM('decimal','other')",
    ],
)
def test_duckdb_floor_ceil_keep_nonnumeric_coercion(kind: str, value: str) -> None:
    engine = DuckDBEngine()
    source = duckdb.sql(f"SELECT {value} AS value")
    before = source.fetchall()
    try:
        native = engine.normalize_notebook_relation(source)
        schema = engine.schema(native)
        lineage = source_lineage(schema)
        operation = bind_step(step(kind, column=lineage[0], newColumn="integral"), schema, lineage)
        live = engine.apply_transform(native, operation)
        generated = execute_generated(engine, source, [operation])
        expected = [(*before[0], None)]
        assert engine._terminal_rows(live, "SELECT * FROM ow") == expected
        assert generated.fetchall() == expected
        assert str(live.types[-1]) == str(generated.types[-1]) == "DOUBLE"
        assert source.fetchall() == before
    finally:
        engine.close()


@pytest.mark.parametrize(
    ("expression", "column_type", "predicate", "result_type", "arms", "expected"),
    [
        (
            "CASE row WHEN 0 THEN 5.0 WHEN 1 THEN 10.0 WHEN 2 THEN NULL "
            "WHEN 3 THEN 'NaN'::DOUBLE ELSE 'Infinity'::DOUBLE END",
            "float",
            {"operator": "gte", "value": "10"},
            "string",
            ("high'\n", "", " "),
            ["", "high'\n", " ", " ", "high'\n"],
        ),
        (
            "CASE WHEN row = 2 THEN NULL ELSE 9007199254740992::BIGINT + row END",
            "integer",
            {"operator": "gte", "value": "9007199254740993"},
            "boolean",
            (True, False, None),
            [False, True, None, True, True],
        ),
        (
            "CASE row WHEN 0 THEN 'alpha' WHEN 1 THEN 'Beta' WHEN 2 THEN NULL ELSE 'NaN' END",
            "string",
            {"operator": "contains", "value": "PH"},
            "string",
            ("match", "other", None),
            ["match", "other", None, "other", "other"],
        ),
        ("NULL::DOUBLE", "float", {"operator": "gt", "value": "0"}, "string", (None, None, None), [None] * 5),
    ],
    ids=["threshold", "exact-integer", "literal-text", "all-null"],
)
@pytest.mark.parametrize("empty", [False, True])
def test_duckdb_conditional_column_retains_native_source_and_declared_output(
    expression, column_type, predicate, result_type, arms, expected, empty
) -> None:
    engine = DuckDBEngine()
    source = duckdb.sql(f"SELECT {expression} AS value, row FROM range({0 if empty else 5}) source(row)")
    before = source.fetchall()
    before_sql = source.sql_query()
    operation = step(
        "conditionalColumn",
        column={"id": "c:source:0", "name": "value"},
        columnType=column_type,
        predicate={"kind": "predicate", **predicate},
        newColumn="result",
        resultType=result_type,
        trueValue=arms[0],
        falseValue=arms[1],
        missingValue=arms[2],
    )
    schema = engine.schema(source)
    operation = bind_step(operation, schema, source_lineage(schema))
    try:
        live = engine.apply_transform(source, operation)
        generated = execute_generated(engine, source, [operation])
        live_rows = engine._terminal_rows(live, "SELECT * FROM ow ORDER BY row")
        generated_rows = generated.order("row").fetchall()
        for actual in (live_rows, generated_rows):
            assert [row[-1] for row in actual] == ([] if empty else expected)
            assert [
                ["NaN" if isinstance(value, float) and isnan(value) else value for value in row[:2]] for row in actual
            ] == [["NaN" if isinstance(value, float) and isnan(value) else value for value in row] for row in before]
        assert str(live.types[-1]) == ("VARCHAR" if result_type == "string" else "BOOLEAN")
        assert str(generated.types[-1]) == ("VARCHAR" if result_type == "string" else "BOOLEAN")
        assert source.sql_query() == before_sql
    finally:
        engine.close()


@pytest.mark.parametrize(
    ("operator", "expected"),
    [
        ("isNull", [True, False, False]),
        ("isNotNull", [False, True, True]),
        ("isNaN", [False, True, False]),
        ("isNotNaN", [True, False, True]),
    ],
)
def test_duckdb_conditional_nullary_predicates_ignore_missing_arm(operator, expected) -> None:
    engine = DuckDBEngine()
    source = duckdb.sql("SELECT * FROM (VALUES (NULL::DOUBLE,0), ('NaN'::DOUBLE,1), (1.0,2)) source(value,row)")
    operation = step(
        "conditionalColumn",
        column={"id": "c:source:0", "name": "value"},
        columnType="float",
        predicate={"kind": "predicate", "operator": operator},
        newColumn="result",
        resultType="boolean",
        trueValue=True,
        falseValue=False,
        missingValue=None,
    )
    schema = engine.schema(source)
    operation = bind_step(operation, schema, source_lineage(schema))
    try:
        result = engine.apply_transform(source, operation)
        assert [row[0] for row in engine._terminal_rows(result, "SELECT result FROM ow ORDER BY row")] == expected
        assert [row[-1] for row in execute_generated(engine, source, [operation]).order("row").fetchall()] == expected
    finally:
        engine.close()


@pytest.mark.parametrize("failure", ["type", "collision"])
def test_duckdb_conditional_column_refuses_changed_generated_input(failure) -> None:
    engine = DuckDBEngine()
    source = duckdb.sql("SELECT 1::INTEGER AS value")
    schema = engine.schema(source)
    operation = bind_step(
        step(
            "conditionalColumn",
            column={"id": "c:source:0", "name": "value"},
            columnType="integer",
            predicate={"kind": "predicate", "operator": "equals", "value": "1"},
            newColumn="result",
            resultType="boolean",
            trueValue=True,
            falseValue=False,
            missingValue=None,
        ),
        schema,
        source_lineage(schema),
    )
    changed = duckdb.sql("SELECT '1' AS value" if failure == "type" else "SELECT 1::INTEGER AS value, 3 AS result")
    before = changed.fetchall()
    try:
        for execute in (
            lambda: engine.apply_transform(changed, operation),
            lambda: execute_generated(engine, changed, [operation]),
        ):
            with pytest.raises((EngineError, ValueError), match="type|declares|collid|existing"):
                execute()
            assert changed.fetchall() == before
    finally:
        engine.close()
