from __future__ import annotations

import importlib
import json
import sys
from collections import Counter
from datetime import date
from pathlib import Path
from types import SimpleNamespace

import pyarrow.parquet as pq
import pytest

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
    assert len({column["name"] for column in columns}) == 100
    assert columns[0]["name"] == "net_revenue_usd"
    assert columns[-1]["name"] == "is_billable"
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
    assert json.loads(first.with_suffix(".parquet.json").read_text(encoding="utf-8")) == first_manifest
    metadata = pq.ParquetFile(first).metadata
    assert (metadata.num_rows, metadata.num_columns, metadata.num_row_groups) == (512, 100, 4)
    large_fixture.validate_fixture(first, spec)

    table = pq.read_table(first)
    names_by_role = {
        role: [column["name"] for column in columns if column["role"] == role]
        for role in {column["role"] for column in columns}
    }
    dictionary_columns = first_manifest["compression"]["dictionaryColumns"]
    assert dictionary_columns == names_by_role["categorical text"]
    assert dictionary_columns == [
        metadata.schema.column(index).name
        for index in range(metadata.num_columns)
        if "RLE_DICTIONARY" in metadata.row_group(0).column(index).encodings
    ]
    for name in [
        names_by_role["floating-point"][0],
        names_by_role["floating-point"][-1],
        names_by_role["integer"][0],
        names_by_role["integer"][-1],
    ]:
        values = [value for value in table[name].to_pylist() if value is not None]
        assert (min(values), max(values)) == (-900_000_000, 900_000_000)
    categories = Counter(
        value for value in table[names_by_role["categorical text"][0]].to_pylist() if value is not None
    )
    assert categories["enterprise"] > max(count for value, count in categories.items() if value != "enterprise")
    text_name = names_by_role["high-cardinality text"][0]
    assert f"popular-{text_name}" in table[text_name].to_pylist()
    timestamps = names_by_role["timestamp"]
    assert min(value for value in table[timestamps[0]].to_pylist() if value is not None).date() == date(2000, 1, 1)
    assert max(value for value in table[timestamps[-1]].to_pylist() if value is not None).date() == date(2099, 12, 31)
    assert set(value for value in table[names_by_role["boolean"][0]].to_pylist() if value is not None) == {False, True}


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

    monkeypatch.setattr(large_fixture, "available_memory_bytes", lambda: 48 * 1024**3)
    monkeypatch.setattr(large_fixture, "disk_usage", lambda _path: SimpleNamespace(free=20 * 1024**3))
    assert large_fixture.assert_large_study_capacity(output)["freeDiskBytes"] == 20 * 1024**3
    with pytest.raises(RuntimeError, match="25 GiB free before generating"):
        large_fixture.assert_large_study_capacity(output, generating=True)


def test_generation_keeps_the_study_disk_reserve(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    output = tmp_path / "reserved.parquet"
    free_space = iter([30 * 1024**3, 14 * 1024**3])
    monkeypatch.setattr(large_fixture, "available_memory_bytes", lambda: 48 * 1024**3)
    monkeypatch.setattr(large_fixture, "disk_usage", lambda _path: SimpleNamespace(free=next(free_space)))

    with pytest.raises(RuntimeError, match="leave less than 15 GiB free"):
        large_fixture.generate_fixture(output, large_fixture.LargeFixtureSpec(rows=10, row_group_rows=5))

    assert not output.exists()
    assert not output.with_suffix(".parquet.json").exists()
    assert list(tmp_path.iterdir()) == []
