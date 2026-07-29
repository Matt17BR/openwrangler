from __future__ import annotations

from unittest.mock import Mock

import pandas as pd
import pytest

from openwrangler_runtime.engines import EngineError
from openwrangler_runtime.session import SessionManager


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_ndjson_is_the_exact_jsonl_input_alias(backend: str, tmp_path) -> None:
    source_path = tmp_path / "events [literal].ndjson"
    source_bytes = b'{"city":"Milan","value":1}\n{"city":"Berlin","value":2}\n'
    source_path.write_bytes(source_bytes)
    manager = SessionManager()

    opened = manager.open_session(
        {"kind": "file", "label": source_path.name, "path": str(source_path)},
        backend=backend,
    )

    assert [tuple(cell["display"] for cell in row["values"]) for row in opened["page"]["rows"]] == [
        ("Milan", "1"),
        ("Berlin", "2"),
    ]
    manager.close_session(opened["metadata"]["sessionId"], 0)
    assert manager.sessions == {}
    assert source_path.read_bytes() == source_bytes


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
@pytest.mark.parametrize("extension", ["pkl", "pickle"])
def test_pickle_files_are_rejected_without_deserialization(backend: str, extension: str, tmp_path, monkeypatch) -> None:
    source_path = tmp_path / f"untrusted.{extension}"
    source_bytes = b"not a pickle and never parsed"
    source_path.write_bytes(source_bytes)
    manager = SessionManager()
    pickle_reader = Mock(side_effect=AssertionError("Open Wrangler must never deserialize a pickle file"))
    monkeypatch.setattr(pd, "read_pickle", pickle_reader)

    with pytest.raises(EngineError, match="Unsupported file extension"):
        manager.open_session(
            {"kind": "file", "label": source_path.name, "path": str(source_path)},
            backend=backend,
        )

    pickle_reader.assert_not_called()
    assert manager.sessions == {}
    assert source_path.read_bytes() == source_bytes
