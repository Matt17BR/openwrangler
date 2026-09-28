from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd
import polars as pl
import pyarrow as pa
import pytest

from openwrangler_runtime.engines import DuckDBEngine, PandasEngine, PolarsEngine

_CONTRACT = json.loads(
    (Path(__file__).resolve().parents[2] / "fixtures" / "duration-text-contract.json").read_text(encoding="utf-8")
)["durations"]
_CSV = {"format": "csv", "delimiter": ",", "quoteChar": '"', "encoding": "utf-8", "header": True}


def _source(backend: str, nanoseconds: list[int | None]) -> tuple[Any, Any]:
    if backend == "pandas":
        values = pd.Series(pd.array(nanoseconds, dtype="Int64")).astype("timedelta64[ns]")
        return PandasEngine(), pd.DataFrame({"elapsed": values})
    if backend == "pandas-arrow":
        values = pd.array(pa.array(nanoseconds, type=pa.duration("ns")), dtype=pd.ArrowDtype(pa.duration("ns")))
        return PandasEngine(), pd.DataFrame({"elapsed": values})
    if backend.startswith("polars"):
        frame = pl.DataFrame({"elapsed": pl.Series(nanoseconds, dtype=pl.Int64).cast(pl.Duration("ns"))})
        return PolarsEngine(), frame.lazy() if backend == "polars-lazy" else frame
    rows = ", ".join("(NULL)" if value is None else f"(to_microseconds({value // 1_000}))" for value in nanoseconds)
    return DuckDBEngine(), duckdb.connect().sql(f"SELECT * FROM (VALUES {rows}) AS source(elapsed)")


@pytest.mark.parametrize("backend", ["pandas", "pandas-arrow", "polars", "polars-lazy", "duckdb"])
def test_durations_export_as_csv_in_the_text_every_grid_shows(tmp_path: Path, backend: str) -> None:
    # DuckDB intervals hold whole microseconds.
    cases = [
        case
        for case in _CONTRACT
        if backend != "duckdb" or case["nanoseconds"] is None or case["nanoseconds"] % 1_000 == 0
    ]
    engine, source = _source(backend, [case["nanoseconds"] for case in cases])
    frame = engine.ensure_row_ids(engine.normalize(source), "contract")
    target = tmp_path / "durations.csv"
    engine.export_data(frame, target, {**_CSV, "rowAxisPolicy": "omit"} if backend.startswith("pandas") else _CSV)

    with target.open(newline="", encoding="utf-8") as handle:
        # A missing value in a single-column CSV is an empty line.
        exported = [row[0] if row else "" for row in csv.reader(handle)][1:]
    assert exported == [case["text"] for case in cases]
    cells = [row["values"][0] for row in engine.page(frame, 0, len(cases))["rows"]]
    assert [cell["display"] for cell in cells if not cell["isNull"]] == [
        case["text"] for case in cases if case["nanoseconds"] is not None
    ]
