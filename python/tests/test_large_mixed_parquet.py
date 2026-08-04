from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import pyarrow.parquet as pq
import pytest

benchmark_directory = Path(__file__).parents[1] / "benchmarks"
sys.path.insert(0, str(benchmark_directory))
try:
    large_fixture = importlib.import_module("large_mixed_parquet")
finally:
    sys.path.remove(str(benchmark_directory))

DEFAULT_COLUMNS = large_fixture.DEFAULT_COLUMNS
LargeFixtureSpec = large_fixture.LargeFixtureSpec
assert_large_study_capacity = large_fixture.assert_large_study_capacity
column_contract = large_fixture.column_contract
generate_fixture = large_fixture.generate_fixture
validate_fixture = large_fixture.validate_fixture


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
    assert first_manifest["capacityAtStart"] is None
    assert pq.ParquetFile(first).metadata.num_row_groups == 5
    assert pq.ParquetFile(first).metadata.num_rows == 257
    assert json.loads(first.with_suffix(".parquet.json").read_text(encoding="utf-8")) == first_manifest
    validate_fixture(first, spec)


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
