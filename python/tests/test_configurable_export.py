from __future__ import annotations

from pathlib import Path
from typing import Any

import duckdb
import pandas as pd
import polars as pl
import pytest

from openwrangler_runtime.engines import EngineError
from openwrangler_runtime.engines.duckdb_engine import DuckDBEngine
from openwrangler_runtime.engines.pandas_engine import PandasEngine
from openwrangler_runtime.engines.polars_engine import PolarsEngine
from openwrangler_runtime.export_target import ExportTarget
from openwrangler_runtime.session import SessionManager


def test_pandas_csv_export_applies_the_exact_dialect_encoding_header_and_index_policy(tmp_path: Path) -> None:
    engine = PandasEngine()
    source = pd.DataFrame(
        {"city": ["café;Nord", "Berlin"], "value": [1, 2]},
        index=pd.Index(["invoice-a", "invoice-b"], name="invoice_id"),
    )
    frame = engine.ensure_row_ids(source, "configured-pandas")
    destination = tmp_path / "configured-latin-1.csv"

    engine.export_data(
        frame,
        destination,
        {
            "format": "csv",
            "delimiter": ";",
            "quoteChar": "'",
            "encoding": "latin-1",
            "header": False,
            "rowAxisPolicy": "preserve",
        },
    )

    assert b"caf\xe9" in destination.read_bytes()
    loaded = pd.read_csv(destination, sep=";", quotechar="'", encoding="latin-1", header=None, index_col=0)
    assert loaded.index.tolist() == ["invoice-a", "invoice-b"]
    assert loaded.iloc[:, 0].tolist() == ["café;Nord", "Berlin"]
    assert loaded.iloc[:, 1].tolist() == [1, 2]
    assert source.index.tolist() == ["invoice-a", "invoice-b"]


@pytest.mark.parametrize("backend", ["polars", "duckdb"])
def test_native_utf8_csv_export_applies_ascii_dialect_and_header_options(tmp_path: Path, backend: str) -> None:
    destination = tmp_path / f"configured-{backend}.csv"
    options = {
        "format": "csv",
        "delimiter": ";",
        "quoteChar": "'",
        "encoding": "utf-8",
        "header": False,
    }
    if backend == "polars":
        engine = PolarsEngine()
        frame: Any = pl.LazyFrame({"city": ["Milan;'North", "Berlin"], "value": [1, 2]})
    else:
        engine = DuckDBEngine()
        frame = engine._relation_from_sql(
            "SELECT 'Milan;''North' AS city, 1 AS value UNION ALL SELECT 'Berlin' AS city, 2 AS value"
        )

    engine.export_data(frame, destination, options)

    loaded = pl.read_csv(destination, separator=";", quote_char="'", has_header=False, new_columns=["city", "value"])
    assert loaded.to_dict(as_series=False) == {"city": ["Milan;'North", "Berlin"], "value": [1, 2]}


@pytest.mark.parametrize(
    ("backend", "options", "message"),
    [
        (
            "pandas",
            {
                "format": "csv",
                "delimiter": ",",
                "quoteChar": '"',
                "encoding": "not-a-real-codec",
                "header": True,
                "rowAxisPolicy": "omit",
            },
            "does not support CSV text encoding",
        ),
        (
            "pandas",
            {
                "format": "csv",
                "delimiter": ",",
                "quoteChar": '"',
                "encoding": "x" * 65,
                "header": True,
                "rowAxisPolicy": "omit",
            },
            "at most 64",
        ),
        (
            "pandas",
            {
                "format": "csv",
                "delimiter": ",",
                "quoteChar": '"',
                "encoding": "base64_codec",
                "header": True,
                "rowAxisPolicy": "omit",
            },
            "does not support CSV text encoding",
        ),
        (
            "pandas",
            {
                "format": "csv",
                "delimiter": ",",
                "quoteChar": ",",
                "encoding": "utf-8",
                "header": True,
                "rowAxisPolicy": "omit",
            },
            "delimiter and quoteChar must differ",
        ),
        (
            "pandas",
            {
                "format": "csv",
                "delimiter": "\n",
                "quoteChar": '"',
                "encoding": "utf-8",
                "header": True,
                "rowAxisPolicy": "omit",
            },
            "non-NUL, non-line-break",
        ),
        (
            "polars",
            {"format": "csv", "delimiter": ",", "quoteChar": '"', "encoding": "latin-1", "header": True},
            "supports UTF-8 encoding only",
        ),
        (
            "duckdb",
            {"format": "csv", "delimiter": "§", "quoteChar": '"', "encoding": "utf-8", "header": True},
            "delimiter must encode as exactly one UTF-8 byte",
        ),
        (
            "duckdb",
            {"format": "parquet", "delimiter": ","},
            "invalid for parquet",
        ),
    ],
)
def test_unsupported_export_options_fail_before_target_reservation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    backend: str,
    options: dict[str, object],
    message: str,
) -> None:
    source = tmp_path / f"source-{backend}.csv"
    source.write_text("city,value\nMilan,1\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session({"kind": "file", "label": source.name, "path": str(source)}, backend=backend)
    destination = tmp_path / f"must-not-exist-{backend}.csv"
    monkeypatch.setattr(
        ExportTarget,
        "from_request",
        staticmethod(lambda *_args, **_kwargs: pytest.fail("unsupported options reached ExportTarget reservation")),
    )

    with pytest.raises(EngineError, match=message):
        manager.export_data(str(opened["metadata"]["sessionId"]), 0, str(destination), options)

    assert not destination.exists()
    manager.close_session(str(opened["metadata"]["sessionId"]), 0)


def test_duckdb_configured_csv_export_remains_native(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    for method in ("arrow", "df", "fetch_arrow_table", "fetchdf", "pl", "to_arrow_table", "to_df"):
        if hasattr(duckdb.DuckDBPyRelation, method):
            monkeypatch.setattr(
                duckdb.DuckDBPyRelation,
                method,
                lambda *_args, method=method, **_kwargs: pytest.fail(
                    f"DuckDB configured export must not convert through {method}"
                ),
            )
    engine = DuckDBEngine()
    destination = tmp_path / "native.csv"
    engine.export_data(
        engine._relation_from_sql("SELECT 7 AS value"),
        destination,
        {"format": "csv", "delimiter": "|", "quoteChar": '"', "encoding": "utf-8", "header": True},
    )
    assert destination.read_text(encoding="utf-8") == "value\n7\n"
