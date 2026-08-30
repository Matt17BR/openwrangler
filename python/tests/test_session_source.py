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
    resolve_notebook_variable,
)


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
    details = path.stat()

    assert source.is_same_path(str(path))
    assert source.matches_file_identity(details.st_dev, details.st_ino)
    assert not source.matches_file_identity(details.st_dev, details.st_ino + 1)

    value: Any = object()
    monkeypatch.setattr(__main__, "orders", value, raising=False)
    assert resolve_notebook_variable(notebook_source()) is value
