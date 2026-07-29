from __future__ import annotations

from pathlib import Path

import duckdb
import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime.engines.base import EngineError
from openwrangler_runtime.session import SessionManager


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
@pytest.mark.parametrize(("suffix", "delimiter"), [(".csv", ","), (".tsv", "\t")])
@pytest.mark.parametrize("contents", [b"", b"\xef\xbb\xbf \t\r\n"], ids=["zero-bytes", "bom-and-whitespace"])
def test_blank_delimited_sources_open_as_native_zero_by_zero_datasets(
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
            "duckdb": duckdb.DuckDBPyRelation,
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
