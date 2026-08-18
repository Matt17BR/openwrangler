from __future__ import annotations

import io
import os
import weakref
from pathlib import Path
from typing import Any, NoReturn

import duckdb
import pytest
from fsspec.implementations.local import LocalFileSystem

from openwrangler_runtime.engines.base import INTERNAL_ROW_ID_PREFIX
from openwrangler_runtime.engines.duckdb_engine import DuckDBEngine
from openwrangler_runtime.engines.duckdb_export_filesystem import (
    DuckDBExportFileSystemError,
    _NonClosingBinaryWriter,
    _OneShotDuckDBWriterFileSystem,
    registered_duckdb_export_writer,
)
from openwrangler_runtime.export_target import ExportWriterPath, _regular_file_identity


def reserved_writer_path(path: Path) -> ExportWriterPath:
    descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
    os.close(descriptor)
    device, inode = _regular_file_identity(path)
    return ExportWriterPath(path, device, inode)


@pytest.mark.parametrize("format_name", ["csv", "parquet"])
def test_duckdb_native_export_streams_to_exact_writer_without_conversion(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    format_name: str,
) -> None:
    for method in ("arrow", "df", "fetch_arrow_table", "fetchdf", "pl", "to_arrow_table", "to_df"):
        if hasattr(duckdb.DuckDBPyRelation, method):
            monkeypatch.setattr(
                duckdb.DuckDBPyRelation,
                method,
                lambda *_args, method=method, **_kwargs: (_ for _ in ()).throw(
                    AssertionError(f"DuckDB export must not convert through {method}")
                ),
            )

    private_row_id = f"{INTERNAL_ROW_ID_PREFIX}fixture"
    engine = DuckDBEngine()
    frame = engine._relation_from_sql(
        f"SELECT 7 AS value, 'native|safe' AS label, 19 AS \"{private_row_id}\" UNION ALL "
        f"SELECT 8 AS value, 'stream''line' AS label, 20 AS \"{private_row_id}\""
    )
    destination = tmp_path / f"reserved.{format_name}"
    writer_path = reserved_writer_path(destination)
    identity = (writer_path.device, writer_path.inode)

    options = (
        {"format": "csv", "delimiter": "|", "quoteChar": "'", "encoding": "utf-8", "header": False}
        if format_name == "csv"
        else {"format": "parquet"}
    )
    engine.export_data(frame, writer_path, options)  # type: ignore[arg-type]

    assert _regular_file_identity(destination) == identity
    if format_name == "csv":
        assert destination.read_text() == "7|'native|safe'\n8|'stream''line'\n"
    else:
        connection = duckdb.connect()
        try:
            assert connection.read_parquet(str(destination)).fetchall() == [(7, "native|safe"), (8, "stream'line")]
            assert connection.read_parquet(str(destination)).columns == ["value", "label"]
        finally:
            connection.close()


def test_one_shot_filesystem_grants_only_the_exact_write_capability() -> None:
    writer = io.BytesIO()
    filesystem = _OneShotDuckDBWriterFileSystem(writer, "csv")
    uri = filesystem.uri
    token = uri.split("://", 1)[1]

    assert filesystem.info(uri) == {"name": token, "size": 0, "type": "file"}
    assert filesystem.info(uri) == {"name": token, "size": 0, "type": "file"}
    with pytest.raises(DuckDBExportFileSystemError, match="invalid export target"):
        filesystem.info(uri)
    with pytest.raises(DuckDBExportFileSystemError, match="invalid export target"):
        _OneShotDuckDBWriterFileSystem(io.BytesIO(), "csv").info(f"foreign://{token}")
    with pytest.raises(DuckDBExportFileSystemError, match="invalid export target"):
        _OneShotDuckDBWriterFileSystem(io.BytesIO(), "csv").info(token)

    proxy = filesystem._open(token, "wb", autocommit=True, block_size=None, cache_options=None)
    assert proxy.write(b"native") == 6
    proxy.flush()
    proxy.close()
    proxy.close()
    assert writer.getvalue() == b"native"
    assert not writer.closed
    filesystem.assert_completed()

    with pytest.raises(DuckDBExportFileSystemError, match="invalid export writer"):
        filesystem._open(token, "wb", autocommit=True, block_size=None, cache_options=None)
    with pytest.raises(DuckDBExportFileSystemError, match="invalid export writer"):
        _OneShotDuckDBWriterFileSystem(io.BytesIO(), "csv")._open(
            token, "rb", autocommit=True, block_size=None, cache_options=None
        )
    with pytest.raises(DuckDBExportFileSystemError, match="invalid export writer"):
        _OneShotDuckDBWriterFileSystem(io.BytesIO(), "csv")._open(
            uri, "wb", autocommit=True, block_size=None, cache_options=None
        )


def test_public_open_cannot_read_or_poison_the_authorized_write() -> None:
    writer = io.BytesIO()
    filesystem = _OneShotDuckDBWriterFileSystem(writer, "csv")

    with pytest.raises(DuckDBExportFileSystemError, match="invalid export writer"):
        filesystem.open(filesystem.uri, "rb")

    assert filesystem.info(filesystem.uri)["type"] == "file"
    assert filesystem.info(filesystem.uri)["type"] == "file"
    proxy = filesystem._open(
        filesystem.uri.split("://", 1)[1], "wb", autocommit=True, block_size=None, cache_options=None
    )
    proxy.write(b"authorized")
    proxy.close()
    filesystem.assert_completed()
    assert writer.getvalue() == b"authorized"


@pytest.mark.parametrize(
    ("operation", "arguments"),
    [
        ("ls", ("target",)),
        ("exists", ("target",)),
        ("find", ("target",)),
        ("glob", ("target",)),
        ("walk", ("target",)),
        ("_rm", ("target",)),
        ("rm", ("target",)),
        ("rmdir", ("target",)),
        ("mkdir", ("target",)),
        ("makedirs", ("target",)),
        ("mv", ("target", "other")),
        ("rename", ("target", "other")),
        ("cp_file", ("target", "other")),
        ("copy", ("target", "other")),
        ("get", ("target", "other")),
        ("get_file", ("target", "other")),
        ("download", ("target", "other")),
        ("put", ("target", "other")),
        ("put_file", ("target", "other")),
        ("upload", ("target", "other")),
        ("touch", ("target",)),
        ("pipe_file", ("target", b"data")),
        ("cat_file", ("target",)),
        ("cat", ("target",)),
    ],
)
def test_one_shot_filesystem_rejects_path_and_read_operations(operation: str, arguments: tuple[Any, ...]) -> None:
    writer = io.BytesIO()
    filesystem = _OneShotDuckDBWriterFileSystem(writer, "parquet")
    with pytest.raises(DuckDBExportFileSystemError, match="operations are disabled"):
        getattr(filesystem, operation)(*arguments)
    assert filesystem.info(filesystem.uri)["type"] == "file"
    assert filesystem.info(filesystem.uri)["type"] == "file"
    proxy = filesystem._open(
        filesystem.uri.split("://", 1)[1], "wb", autocommit=True, block_size=None, cache_options=None
    )
    proxy.write(b"authorized")
    proxy.close()
    filesystem.assert_completed()
    assert writer.getvalue() == b"authorized"


def test_direct_transfer_primitives_reject_before_any_local_path_side_effect(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    filesystem = _OneShotDuckDBWriterFileSystem(io.BytesIO(), "csv")
    local_target = tmp_path / "created" / "result.bin"
    local_source = tmp_path / "arbitrary-source.bin"
    touched: list[str] = []

    def reject_touch(label: str) -> Any:
        def fail(*_args: Any, **_kwargs: Any) -> NoReturn:
            touched.append(label)
            raise AssertionError(f"unexpected local path operation: {label}")

        return fail

    with monkeypatch.context() as patch:
        patch.setattr(os.path, "isdir", reject_touch("isdir"))
        patch.setattr(os, "makedirs", reject_touch("makedirs"))
        patch.setattr(LocalFileSystem, "makedirs", reject_touch("local makedirs"))
        patch.setattr("builtins.open", reject_touch("open"))
        with pytest.raises(DuckDBExportFileSystemError, match="operations are disabled"):
            filesystem.get_file(filesystem.uri, os.fspath(local_target))
        with pytest.raises(DuckDBExportFileSystemError, match="operations are disabled"):
            filesystem.put_file(os.fspath(local_source), filesystem.uri)

    assert touched == []
    assert not local_target.parent.exists()
    assert not local_source.exists()
    assert filesystem._info_calls == 0
    assert not filesystem._opened


def test_non_closing_proxy_delegates_bounded_writer_operations_without_owning_close() -> None:
    writer = io.BytesIO(b"abcdef")
    proxy = _NonClosingBinaryWriter(writer)

    assert proxy.seek(2) == 2
    assert proxy.tell() == 2
    assert proxy.write(b"XY") == 2
    assert proxy.truncate(4) == 4
    proxy.flush()
    proxy.close()

    assert writer.getvalue() == b"abXY"
    assert not writer.closed
    assert proxy.closed
    with pytest.raises(ValueError, match="closed DuckDB export writer"):
        proxy.write(b"blocked")


def test_non_closing_proxy_rejects_a_short_native_write() -> None:
    class ShortWriter(io.BytesIO):
        def write(self, data: Any) -> int:
            super().write(data[:-1])
            return len(data) - 1

    writer = ShortWriter()
    proxy = _NonClosingBinaryWriter(writer)

    with pytest.raises(OSError, match="complete native export block"):
        proxy.write(b"partial")
    assert not proxy.closed
    assert not writer.closed


def test_non_closing_proxy_flush_failure_cannot_complete_the_export() -> None:
    cleanup = OSError("writer flush failed")

    class FlushFailureWriter(io.BytesIO):
        def flush(self) -> None:
            raise cleanup

    writer = FlushFailureWriter()
    filesystem = _OneShotDuckDBWriterFileSystem(writer, "csv")
    filesystem.info(filesystem.uri)
    filesystem.info(filesystem.uri)
    proxy = filesystem._open(
        filesystem.uri.split("://", 1)[1], "wb", autocommit=True, block_size=None, cache_options=None
    )

    with pytest.raises(OSError, match="writer flush failed") as captured:
        proxy.close()

    assert captured.value is cleanup
    assert not proxy.closed
    assert not writer.closed
    with pytest.raises(DuckDBExportFileSystemError, match="did not complete"):
        filesystem.assert_completed()


def test_registration_is_connection_local_and_removed_after_native_write() -> None:
    first = duckdb.connect()
    second = duckdb.connect()
    writer = io.BytesIO()
    try:
        candidate = _OneShotDuckDBWriterFileSystem(writer, "csv")
        assert candidate.protocol not in first.list_filesystems()
        with registered_duckdb_export_writer(first, writer, "csv") as uri:
            protocols = first.list_filesystems()
            protocol = next(value for value in protocols if uri.startswith(f"{value}://"))
            with pytest.raises(duckdb.IOException):
                second.sql(f"SELECT * FROM read_csv_auto('{uri}')").fetchall()
            relation = first.sql("SELECT 1 AS value")
            try:
                relation.write_csv(uri, use_tmp_file=False)
            finally:
                relation = None
        assert protocol not in first.list_filesystems()
        with pytest.raises(duckdb.IOException):
            first.sql(f"SELECT * FROM read_csv_auto('{uri}')").fetchall()
    finally:
        first.close()
        second.close()
    assert writer.getvalue() == b"value\n1\n"


def test_relation_is_released_before_filesystem_unregisters(tmp_path: Path) -> None:
    events: list[str] = []
    relation_reference: weakref.ReferenceType[Any] | None = None

    class Relation:
        def __init__(self, connection: Connection) -> None:
            self.connection = connection

        def write_csv(
            self,
            uri: str,
            *,
            use_tmp_file: bool,
            sep: str,
            quotechar: str,
            escapechar: str,
            encoding: str,
            header: bool,
        ) -> None:
            assert use_tmp_file is False
            assert (sep, quotechar, escapechar, encoding, header) == (",", '"', '"', "utf-8", True)
            filesystem = self.connection.filesystem
            assert filesystem is not None
            filesystem.info(uri)
            filesystem.info(uri)
            proxy = filesystem._open(uri.split("://", 1)[1], "wb", autocommit=True, block_size=None, cache_options=None)
            proxy.write(b"value\n1\n")
            proxy.close()

        def __del__(self) -> None:
            events.append("relation released")

    class Connection:
        filesystem: _OneShotDuckDBWriterFileSystem | None = None

        def sql(self, _sql: str) -> Relation:
            nonlocal relation_reference
            relation = Relation(self)
            relation_reference = weakref.ref(relation)
            return relation

        def register_filesystem(self, filesystem: _OneShotDuckDBWriterFileSystem) -> None:
            events.append("registered")
            self.filesystem = filesystem

        def list_filesystems(self) -> list[str]:
            events.append("listed")
            return [] if self.filesystem is None else [self.filesystem.protocol_name]

        def unregister_filesystem(self, _protocol: str) -> None:
            assert relation_reference is not None and relation_reference() is None
            events.append("unregistered")
            self.filesystem = None

    from openwrangler_runtime.engines.duckdb_engine import _write_relation_export

    connection = Connection()
    destination = tmp_path / "reserved.csv"
    path = reserved_writer_path(destination)
    _write_relation_export(
        connection,
        "SELECT 1",
        path,
        {"format": "csv", "delimiter": ",", "quoteChar": '"', "encoding": "utf-8", "header": True},
    )

    assert events == ["listed", "registered", "relation released", "unregistered"]
    assert destination.read_bytes() == b"value\n1\n"


def test_write_failure_stays_primary_when_unregister_also_fails() -> None:
    primary = OSError("native writer failed")
    cleanup = OSError("unregister failed")

    class Connection:
        filesystem: _OneShotDuckDBWriterFileSystem | None = None

        def register_filesystem(self, filesystem: _OneShotDuckDBWriterFileSystem) -> None:
            self.filesystem = filesystem

        def list_filesystems(self) -> list[str]:
            return [] if self.filesystem is None else [self.filesystem.protocol_name]

        def unregister_filesystem(self, _protocol: str) -> None:
            raise cleanup

    connection = Connection()
    writer = io.BytesIO()

    with (
        pytest.raises(OSError, match="native writer failed") as captured,
        registered_duckdb_export_writer(connection, writer, "csv"),
    ):
        raise primary

    assert captured.value is primary
    assert captured.value.__cause__ is cleanup
    assert not writer.closed


def test_unregister_failure_appends_bounded_detail_after_an_existing_cause() -> None:
    original_cause = OSError("descriptor close failed")
    primary = OSError("native writer failed")
    primary.__cause__ = original_cause
    cleanup = OSError("unregister " + "x" * 900)

    class Connection:
        filesystem: _OneShotDuckDBWriterFileSystem | None = None

        def list_filesystems(self) -> list[str]:
            return [] if self.filesystem is None else [self.filesystem.protocol_name]

        def register_filesystem(self, filesystem: _OneShotDuckDBWriterFileSystem) -> None:
            self.filesystem = filesystem

        def unregister_filesystem(self, _protocol: str) -> None:
            raise cleanup

    connection = Connection()

    with (
        pytest.raises(OSError, match="native writer failed") as captured,
        registered_duckdb_export_writer(connection, io.BytesIO(), "csv"),
    ):
        raise primary

    assert captured.value is primary
    assert captured.value.__cause__ is original_cause
    notes = getattr(captured.value, "__notes__", [])
    assert len(notes) == 1
    assert notes[0].startswith("DuckDB export filesystem cleanup also failed: OSError: unregister ")
    assert len(notes[0]) <= 512


def test_successful_write_surfaces_unregister_failure() -> None:
    cleanup = OSError("unregister failed")

    class Connection:
        filesystem: _OneShotDuckDBWriterFileSystem | None = None

        def register_filesystem(self, filesystem: _OneShotDuckDBWriterFileSystem) -> None:
            self.filesystem = filesystem

        def list_filesystems(self) -> list[str]:
            return [] if self.filesystem is None else [self.filesystem.protocol_name]

        def unregister_filesystem(self, _protocol: str) -> None:
            raise cleanup

    connection = Connection()
    writer = io.BytesIO()

    with (
        pytest.raises(OSError, match="unregister failed") as captured,
        registered_duckdb_export_writer(connection, writer, "csv") as uri,
    ):
        filesystem = connection.filesystem
        assert filesystem is not None
        filesystem.info(uri)
        filesystem.info(uri)
        proxy = filesystem._open(uri.split("://", 1)[1], "wb", autocommit=True, block_size=None, cache_options=None)
        proxy.close()

    assert captured.value is cleanup
    assert not writer.closed


def test_registered_writer_rejects_a_protocol_that_is_already_present() -> None:
    filesystem: _OneShotDuckDBWriterFileSystem | None = None

    class Connection:
        register_calls = 0

        def list_filesystems(self) -> list[str]:
            assert filesystem is not None
            return [filesystem.protocol_name]

        def register_filesystem(self, _filesystem: _OneShotDuckDBWriterFileSystem) -> None:
            self.register_calls += 1

    connection = Connection()
    writer = io.BytesIO()
    original_init = _OneShotDuckDBWriterFileSystem.__init__

    def record_init(self: _OneShotDuckDBWriterFileSystem, *args: Any, **kwargs: Any) -> None:
        nonlocal filesystem
        original_init(self, *args, **kwargs)
        filesystem = self

    from unittest.mock import patch

    with (
        patch.object(_OneShotDuckDBWriterFileSystem, "__init__", record_init),
        pytest.raises(DuckDBExportFileSystemError, match="already registered"),
        registered_duckdb_export_writer(connection, writer, "csv"),
    ):
        pass

    assert connection.register_calls == 0
    assert not writer.closed


def test_native_write_failure_leaves_physical_close_to_outer_writer() -> None:
    primary = OSError("native write failed")
    events: list[str] = []

    class FailingWriter(io.BytesIO):
        def write(self, _data: Any) -> int:
            events.append("write failed")
            raise primary

        def close(self) -> None:
            events.append("writer closed")
            super().close()

    class Connection:
        filesystem: _OneShotDuckDBWriterFileSystem | None = None

        def list_filesystems(self) -> list[str]:
            return [] if self.filesystem is None else [self.filesystem.protocol_name]

        def register_filesystem(self, filesystem: _OneShotDuckDBWriterFileSystem) -> None:
            self.filesystem = filesystem
            events.append("registered")

        def unregister_filesystem(self, _protocol: str) -> None:
            events.append("unregistered")
            self.filesystem = None

    connection = Connection()
    writer = FailingWriter()
    proxy: _NonClosingBinaryWriter | None = None

    with (
        pytest.raises(OSError, match="native write failed") as captured,
        writer,
        registered_duckdb_export_writer(connection, writer, "csv") as uri,
    ):
        filesystem = connection.filesystem
        assert filesystem is not None
        filesystem.info(uri)
        filesystem.info(uri)
        active_proxy = filesystem._open(
            uri.split("://", 1)[1], "wb", autocommit=True, block_size=None, cache_options=None
        )
        proxy = active_proxy
        active_proxy.write(b"blocked")

    assert captured.value is primary
    assert proxy is not None and not proxy.closed
    assert writer.closed
    assert events == ["registered", "write failed", "unregistered", "writer closed"]
