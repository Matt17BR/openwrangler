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

DEFAULT_COLUMNS = large_fixture.DEFAULT_COLUMNS
LargeFixtureSpec = large_fixture.LargeFixtureSpec
assert_large_study_capacity = large_fixture.assert_large_study_capacity
build_row_group = large_fixture.build_row_group
column_contract = large_fixture.column_contract
generate_fixture = large_fixture.generate_fixture
validate_fixture = large_fixture.validate_fixture
DURATION_TOP_VALUE_MS = large_fixture.DURATION_TOP_VALUE_MS


def test_column_contract_is_exactly_100_mixed_columns() -> None:
    columns = column_contract()
    assert len(columns) == DEFAULT_COLUMNS
    assert [column["name"] for column in columns] == [f"c{index:02d}" for index in range(DEFAULT_COLUMNS)]
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


def test_small_fixture_is_deterministic_and_streamed_in_row_groups(tmp_path: Path) -> None:
    spec = LargeFixtureSpec(rows=257, row_group_rows=64, seed=123)
    first = tmp_path / "first.parquet"
    second = tmp_path / "second.parquet"

    first_manifest = generate_fixture(first, spec, check_capacity=False)
    second_manifest = generate_fixture(second, spec, check_capacity=False)

    assert first_manifest["sha256"] == second_manifest["sha256"]
    assert first_manifest["schema"] == column_contract()
    assert first_manifest["profileSentinels"]["numericExtrema"] == [-900_000_000, 900_000_000]
    assert first_manifest["profileSentinels"]["durationTopValueMs"] == DURATION_TOP_VALUE_MS
    assert first_manifest["capacityAtStart"] is None
    assert pq.ParquetFile(first).metadata.num_row_groups == 5
    assert pq.ParquetFile(first).metadata.num_rows == 257
    assert json.loads(first.with_suffix(".parquet.json").read_text(encoding="utf-8")) == first_manifest
    validate_fixture(first, spec)


def test_mixed_column_families_contain_the_profile_sentinels() -> None:
    table = build_row_group(0, 512, LargeFixtureSpec(rows=512, row_group_rows=512, seed=123))

    for name in ["c00", "c35", "c36", "c65"]:
        values = [value for value in table[name].to_pylist() if value is not None]
        assert min(values) == -900_000_000
        assert max(values) == 900_000_000

    categories = Counter(value for value in table["c66"].to_pylist() if value is not None)
    assert categories["enterprise"] > max(count for value, count in categories.items() if value != "enterprise")
    assert "popular-c74" in table["c74"].to_pylist()

    for name in ["c80", "c83"]:
        values = [value for value in table[name].to_pylist() if value is not None]
        assert min(values).date() == date(2000, 1, 1)
        assert max(values).date() == date(2099, 12, 31)
    dates = [value for value in table["c86"].to_pylist() if value is not None]
    assert min(dates) == date(2000, 1, 1)
    assert max(dates) == date(2099, 12, 31)

    for name in ["c89", "c90", "c91"]:
        durations = [value for value in table[name].to_pylist() if value is not None]
        counts = Counter(durations)
        assert min(durations).days == -1
        assert max(durations).days == 365
        assert counts.most_common(1)[0][0].total_seconds() * 1000 == DURATION_TOP_VALUE_MS
    assert set(value for value in table["c92"].to_pylist() if value is not None) == {False, True}


def test_duration_marker_reaches_pandas_and_polars_top_value_profiles() -> None:
    table = build_row_group(0, 512, LargeFixtureSpec(rows=512, row_group_rows=512, seed=123)).select(["c89"])
    summaries = [
        PandasEngine().summaries(table.to_pandas(), [(0, "duration-column")])[0],
        PolarsEngine().summaries(pl.from_arrow(table), [(0, "duration-column")])[0],
    ]

    assert summaries[0]["visualization"]["categories"][0]["value"] == "2 days 00:00:00"
    assert summaries[1]["visualization"]["categories"][0]["value"] == "2 days, 0:00:00"
    for summary in summaries:
        assert summary["type"] == "duration"
        assert summary["visualization"]["categories"][0] == summary["topValues"][0]


def test_generator_refuses_to_replace_a_fixture(tmp_path: Path) -> None:
    output = tmp_path / "fixture.parquet"
    output.write_bytes(b"owned")
    with pytest.raises(FileExistsError, match="Refusing to replace"):
        generate_fixture(output, LargeFixtureSpec(rows=10, row_group_rows=5), check_capacity=False)


def test_capacity_check_fails_before_writing(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(large_fixture, "available_memory_bytes", lambda: 1024)
    with pytest.raises(RuntimeError, match="available memory"):
        assert_large_study_capacity(tmp_path / "fixture.parquet")
    assert list(tmp_path.iterdir()) == []
