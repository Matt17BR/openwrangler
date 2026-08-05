from __future__ import annotations

import importlib
import json
import sys
from collections import Counter
from datetime import date
from pathlib import Path

import polars as pl
import pyarrow.parquet as pq
import pytest

from openwrangler_runtime.engines.pandas_engine import PandasEngine
from openwrangler_runtime.engines.polars_engine import PolarsEngine

benchmark_directory = Path(__file__).parents[1] / "benchmarks"
sys.path.insert(0, str(benchmark_directory))
try:
    large_fixture = importlib.import_module("large_mixed_parquet")
finally:
    sys.path.remove(str(benchmark_directory))


def test_small_fixture_is_deterministic_mixed_and_profileable(tmp_path: Path) -> None:
    spec = large_fixture.LargeFixtureSpec(rows=512, row_group_rows=128, seed=123)
    first = tmp_path / "first.parquet"
    second = tmp_path / "second.parquet"
    first_manifest = large_fixture.generate_fixture(first, spec, check_capacity=False)
    second_manifest = large_fixture.generate_fixture(second, spec, check_capacity=False)

    columns = large_fixture.column_contract()
    assert len(columns) == 100
    assert [column["name"] for column in columns] == [f"c{index:02d}" for index in range(100)]
    assert {column["role"] for column in columns} == {
        "floating-point",
        "integer",
        "categorical text",
        "high-cardinality text",
        "timestamp",
        "date",
        "duration",
        "boolean",
    }
    assert first_manifest["sha256"] == second_manifest["sha256"]
    assert first_manifest["schema"] == columns
    assert first_manifest["profileSentinels"]["numericExtrema"] == [-900_000_000, 900_000_000]
    assert first_manifest["capacityAtStart"] is None
    assert json.loads(first.with_suffix(".parquet.json").read_text(encoding="utf-8")) == first_manifest
    metadata = pq.ParquetFile(first).metadata
    assert (metadata.num_rows, metadata.num_columns, metadata.num_row_groups) == (512, 100, 4)
    large_fixture.validate_fixture(first, spec)

    table = pq.read_table(first)
    for name in ["c00", "c35", "c36", "c65"]:
        values = [value for value in table[name].to_pylist() if value is not None]
        assert (min(values), max(values)) == (-900_000_000, 900_000_000)
    categories = Counter(value for value in table["c66"].to_pylist() if value is not None)
    assert categories["enterprise"] > max(count for value, count in categories.items() if value != "enterprise")
    assert "popular-c74" in table["c74"].to_pylist()
    assert min(value for value in table["c80"].to_pylist() if value is not None).date() == date(2000, 1, 1)
    assert max(value for value in table["c86"].to_pylist() if value is not None) == date(2099, 12, 31)
    assert set(value for value in table["c92"].to_pylist() if value is not None) == {False, True}

    duration = table.select(["c89"])
    summaries = [
        PandasEngine().summaries(duration.to_pandas(), [(0, "duration-column")])[0],
        PolarsEngine().summaries(pl.from_arrow(duration), [(0, "duration-column")])[0],
    ]
    for summary in summaries:
        assert summary["type"] == "duration"
        assert summary["visualization"]["categories"][0] == summary["topValues"][0]


def test_generation_stops_before_replacement_or_low_capacity(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    existing = tmp_path / "existing.parquet"
    existing.write_bytes(b"owned")
    with pytest.raises(FileExistsError, match="Refusing to replace"):
        large_fixture.generate_fixture(
            existing,
            large_fixture.LargeFixtureSpec(rows=10, row_group_rows=5),
            check_capacity=False,
        )

    monkeypatch.setattr(large_fixture, "available_memory_bytes", lambda: 1024)
    output = tmp_path / "low-memory.parquet"
    with pytest.raises(RuntimeError, match="available memory"):
        large_fixture.assert_large_study_capacity(output)
    assert not output.exists()
