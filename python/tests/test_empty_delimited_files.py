from __future__ import annotations

from pathlib import Path

import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime.engines.base import EngineError
from openwrangler_runtime.engines.duckdb_engine import DuckDBSqlPlan
from openwrangler_runtime.session import SessionManager


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
@pytest.mark.parametrize(("suffix", "delimiter"), [(".csv", ","), (".tsv", "\t")])
@pytest.mark.parametrize("contents", [b"", b"\xef\xbb\xbf"], ids=["zero-bytes", "bom-only"])
def test_empty_delimited_sources_open_as_native_zero_by_zero_datasets(
    backend: str,
    suffix: str,
    delimiter: str,
    contents: bytes,
    tmp_path: Path,
) -> None:
    path = tmp_path / f"blank{suffix}"
    path.write_bytes(contents)
    before = path.stat()
    manager = SessionManager()

    opened = manager.open_session(
        {
            "kind": "file",
            "label": path.name,
            "path": str(path),
            "importOptions": {
                "delimiter": delimiter,
                "encoding": "utf-8",
                "quoteChar": '"',
                "hasHeader": False,
            },
        },
        backend=backend,
    )

    metadata = opened["metadata"]
    assert metadata["backend"] == backend
    assert metadata["shape"] == {"rows": 0, "columns": 0}
    assert metadata["schema"] == []
    native_frame = manager.sessions[metadata["sessionId"]].original
    assert isinstance(
        native_frame,
        {
            "pandas": pd.DataFrame,
            "polars": pl.LazyFrame,
            "duckdb": DuckDBSqlPlan,
        }[backend],
    )
    assert opened["page"] == {
        "offset": 0,
        "limit": 200,
        "totalRows": 0,
        "columnIds": [],
        "rows": [],
    }
    stats = manager.get_dataset_stats(metadata["sessionId"], 0, {"filters": [], "sort": []})
    assert stats["stats"] == {
        "missingCells": 0,
        "missingRows": 0,
        "duplicateRows": 0,
        "missingValuesByColumn": [],
    }

    manager.close_session(metadata["sessionId"], 0)
    after = path.stat()
    assert path.read_bytes() == contents
    assert (after.st_size, after.st_mtime_ns) == (before.st_size, before.st_mtime_ns)


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
@pytest.mark.parametrize(
    ("suffix", "delimiter", "contents", "expected"),
    [
        (".tsv", "\t", "\t\n\t\n", [[None, None], [None, None]]),
        (".csv", " ", " \n \n", [[None, None], [None, None]]),
        (".csv", ",", ",\n,\n", [[None, None], [None, None]]),
        (".csv", ",", "\u00a0\n", [["\u00a0"]]),
        (".csv", ",", "\ufeff\ufeff\n", [["\ufeff"]]),
        (".csv", ",", " \ufeff\n", [[" \ufeff"]]),
    ],
    ids=["empty-tsv-fields", "empty-space-separated-fields", "empty-csv-fields", "nbsp", "second-bom", "later-bom"],
)
def test_delimited_records_preserve_empty_fields_and_whitespace_values(
    backend: str,
    suffix: str,
    delimiter: str,
    contents: str,
    expected: list[list[str | None]],
    tmp_path: Path,
) -> None:
    path = tmp_path / f"records{suffix}"
    raw = contents.encode("utf-8")
    path.write_bytes(raw)
    before = path.stat()
    manager = SessionManager()
    try:
        opened = manager.open_session(
            {
                "kind": "file",
                "label": path.name,
                "path": str(path),
                "importOptions": {"delimiter": delimiter, "hasHeader": False},
            },
            backend=backend,
        )
        metadata = opened["metadata"]
        assert metadata["shape"] == {"rows": len(expected), "columns": len(expected[0])}
        assert [[cell["raw"] for cell in row["values"]] for row in opened["page"]["rows"]] == expected
        assert len(metadata["schema"]) == len(expected[0])
        stats = manager.get_dataset_stats(metadata["sessionId"], 0, {"filters": [], "sort": []})["stats"]
        assert stats["missingCells"] == sum(value is None for row in expected for value in row)
        assert stats["missingRows"] == sum(any(value is None for value in row) for row in expected)
        assert stats["duplicateRows"] == len(expected) - len({tuple(row) for row in expected})
    finally:
        manager.close_all()
    assert manager.sessions == {}
    assert path.read_bytes() == raw
    after = path.stat()
    assert (after.st_size, after.st_mtime_ns) == (before.st_size, before.st_mtime_ns)


@pytest.mark.parametrize("backend", ["polars", "duckdb"])
@pytest.mark.parametrize("value", [" ", "\t", ""], ids=["space", "tab", "newline"])
def test_native_blank_records_keep_their_rows(backend: str, value: str, tmp_path: Path) -> None:
    path = tmp_path / "records.csv"
    raw = f"{value}\n{value}\n".encode()
    path.write_bytes(raw)
    # Minimum Polars retains two zero-column rows for newline-only input;
    # newer Polars and DuckDB retain one null column instead.
    native_rows = (
        [list(row) for row in pl.scan_csv(path, has_header=False, raise_if_empty=False).collect().rows()]
        if backend == "polars"
        else [[value or None], [value or None]]
    )
    assert len(native_rows) == 2
    if value:
        assert native_rows == [[value], [value]]
    else:
        assert native_rows in ([[None], [None]], [[], []])
    manager = SessionManager()
    try:
        opened = manager.open_session(
            {"kind": "file", "label": path.name, "path": str(path), "importOptions": {"hasHeader": False}},
            backend=backend,
        )
        assert opened["metadata"]["shape"] == {"rows": 2, "columns": len(native_rows[0])}
        assert [[cell["raw"] for cell in row["values"]] for row in opened["page"]["rows"]] == native_rows
    finally:
        manager.close_all()
    assert path.read_bytes() == raw


@pytest.mark.parametrize("contents", [b"", b"\xef\xbb\xbf"], ids=["zero-bytes", "bom-only"])
@pytest.mark.parametrize(
    ("backend", "options"),
    [("pandas", {"delimiter": "\n"}), ("polars", {"delimiter": "é"}), ("duckdb", {"quoteChar": ","})],
)
def test_empty_sources_still_validate_native_csv_options(
    backend: str, options: dict[str, str], contents: bytes, tmp_path: Path
) -> None:
    path = tmp_path / "empty.csv"
    path.write_bytes(contents)
    manager = SessionManager()
    with pytest.raises(EngineError):
        manager.open_session(
            {"kind": "file", "label": path.name, "path": str(path), "importOptions": options}, backend=backend
        )
    assert manager.sessions == {}
    assert path.read_bytes() == contents


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_nonempty_malformed_csv_still_fails_in_its_native_reader(backend: str, tmp_path: Path) -> None:
    path = tmp_path / "malformed.csv"
    contents = b'a,b\n"unterminated,1\n'
    path.write_bytes(contents)
    manager = SessionManager()

    with pytest.raises(EngineError):
        manager.open_session(
            {"kind": "file", "label": path.name, "path": str(path)},
            backend=backend,
        )

    assert manager.sessions == {}
    assert path.read_bytes() == contents
