from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest

import __main__
from openwrangler_runtime.engines import DataFrameEngine, EngineError
from openwrangler_runtime.session_source import (
    LiveSourceInvalidatedError,
    SessionSource,
    SourceChangedError,
    resolve_duckdb_connection,
    resolve_notebook_variable,
)
from openwrangler_runtime.trusted_pickle_to_parquet import _confirmed_source_path_fingerprint


def engine(name: str, *, lazy_extensions: frozenset[str] = frozenset(), stopped: bool = False) -> DataFrameEngine:
    return cast(
        DataFrameEngine,
        SimpleNamespace(
            name=name,
            capabilities=SimpleNamespace(lazy_file_extensions=lazy_extensions),
            live_source_is_stopped=lambda _value: stopped,
        ),
    )


def file_source(path: Path) -> dict[str, str]:
    return {"kind": "file", "label": path.name, "path": str(path)}


def notebook_source() -> dict[str, str]:
    return {"kind": "notebookVariable", "label": "orders", "variableName": "orders"}


def test_duckdb_owner_selection_uses_only_the_explicit_kernel_variable(monkeypatch):
    import duckdb

    with duckdb.connect() as connection:
        monkeypatch.setattr(__main__, "selected_duckdb_connection", connection, raising=False)
        source = {**notebook_source(), "duckdbConnection": {"kind": "variable", "name": "selected_duckdb_connection"}}
        captured = SessionSource.capture("owner", source, engine("duckdb"))
        source["duckdbConnection"]["name"] = "another_connection"
        assert resolve_duckdb_connection(captured.metadata) is connection

        def unexpected_default():
            raise AssertionError("A named or missing selection must never create the default connection")

        monkeypatch.setattr(duckdb, "default_connection", unexpected_default)
        assert resolve_duckdb_connection(captured.metadata) is connection
        with pytest.raises(EngineError, match="Select the DuckDB connection"):
            resolve_duckdb_connection(notebook_source())
        monkeypatch.setattr(__main__, "selected_duckdb_connection", object())
        with pytest.raises(EngineError, match="no longer available"):
            resolve_duckdb_connection(captured.metadata)
        captured.release()
        assert connection.sql("SELECT 17").fetchone() == (17,)


def test_duckdb_default_connection_requires_an_explicit_selection(monkeypatch):
    import duckdb

    selected = object()
    calls = []

    def default_connection():
        calls.append(True)
        return selected

    monkeypatch.setattr(duckdb, "default_connection", default_connection)
    assert resolve_duckdb_connection({**notebook_source(), "duckdbConnection": {"kind": "default"}}) is selected
    assert calls == [True]


def test_capture_versions_only_lazy_files_and_pins_the_resolved_read_path(tmp_path: Path) -> None:
    path = tmp_path / "orders.csv"
    path.write_text("value\n1\n", encoding="utf-8")

    eager = SessionSource.capture("eager", file_source(path), engine("pandas"))
    lazy = SessionSource.capture("lazy", file_source(path), engine("polars", lazy_extensions=frozenset({".csv"})))

    assert eager.resolved_metadata == file_source(path)
    assert lazy.resolved_metadata == {**file_source(path), "path": str(path.resolve())}
    assert lazy.matches_public_source(file_source(path))

    path.replace(tmp_path / "old.csv")
    path.write_text("value\n2\n", encoding="utf-8")
    eager.validate(engine("pandas"))
    with pytest.raises(SourceChangedError):
        lazy.validate(engine("polars", lazy_extensions=frozenset({".csv"})))


def test_database_table_source_versions_files_without_a_known_suffix(tmp_path: Path) -> None:
    path = tmp_path / "database"
    path.write_bytes(b"original owned fixture")
    metadata = {**file_source(path), "importOptions": {"duckdbSchema": "main", "duckdbTable": "orders"}}
    source = SessionSource.capture("database", metadata, engine("duckdb"))
    assert source.matches_public_source(metadata)
    assert source.resolved_metadata == {**metadata, "path": str(path.resolve())}
    path.replace(tmp_path / "old-database")
    path.write_bytes(b"changed owned fixture")
    with pytest.raises(SourceChangedError, match="Reopen"):
        source.validate(engine("duckdb"))


def test_lazy_version_detects_replacement_and_preserves_backend_failure_as_cause(tmp_path: Path) -> None:
    path = tmp_path / "orders.csv"
    path.write_text("value\n1\n", encoding="utf-8")
    source = SessionSource.capture(
        "lazy",
        file_source(path),
        engine("polars", lazy_extensions=frozenset({".csv"})),
    )

    with (
        pytest.raises(SourceChangedError, match=r"changed or is no longer available.*Reopen") as caught,
        source.validated_read(engine("polars", lazy_extensions=frozenset({".csv"}))),
    ):
        path.replace(tmp_path / "old.csv")
        path.write_text("value\n2\n", encoding="utf-8")
        raise EngineError("backend scan failed")

    assert isinstance(caught.value.__cause__, EngineError)
    assert str(caught.value.__cause__) == "backend scan failed"


def test_live_source_clone_keeps_exact_identity_and_release_is_per_session(monkeypatch: pytest.MonkeyPatch) -> None:
    original = object()
    replacement = object()
    monkeypatch.setattr(__main__, "orders", original, raising=False)
    pyspark = engine("pyspark")
    source = SessionSource.capture("first", notebook_source(), pyspark)
    source.bind_loaded_value(pyspark, original)
    clone = source.clone_for("second")

    source.validate(pyspark)
    clone.validate(pyspark)
    source.release()

    monkeypatch.setattr(__main__, "orders", replacement)
    source.validate(pyspark)
    with pytest.raises(LiveSourceInvalidatedError, match="was replaced") as invalidated:
        clone.validate(pyspark)
    assert invalidated.value.session_id == "second"


def test_live_source_reports_stopped_and_missing_kernel_values(monkeypatch: pytest.MonkeyPatch) -> None:
    original = object()
    monkeypatch.setattr(__main__, "orders", original, raising=False)
    source = SessionSource.capture("spark", notebook_source(), engine("pyspark"))
    source.bind_loaded_value(engine("pyspark"), original)

    with pytest.raises(LiveSourceInvalidatedError, match="session that has stopped"):
        source.validate(engine("pyspark", stopped=True))

    monkeypatch.delattr(__main__, "orders")
    with pytest.raises(LiveSourceInvalidatedError, match="no longer available"):
        source.validate(engine("pyspark"))


def test_source_owns_export_identity_checks_and_notebook_resolution(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "orders.csv"
    path.write_text("value\n1\n", encoding="utf-8")
    source = SessionSource.capture(
        "lazy",
        file_source(path),
        engine("polars", lazy_extensions=frozenset({".csv"})),
    )
    fingerprint = _confirmed_source_path_fingerprint(path)

    assert source.is_same_path(str(path))
    assert source.matches_file_identity(fingerprint.device, fingerprint.inode)
    assert not source.matches_file_identity(fingerprint.device, fingerprint.inode + 1)

    value: Any = object()
    monkeypatch.setattr(__main__, "orders", value, raising=False)
    assert resolve_notebook_variable(notebook_source()) is value
