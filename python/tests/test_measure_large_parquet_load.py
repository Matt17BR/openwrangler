from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pandas as pd
import polars as pl
import pytest

benchmark_directory = Path(__file__).parents[1] / "benchmarks"
sys.path.insert(0, str(benchmark_directory))
try:
    load_measurement = importlib.import_module("measure_large_parquet_load")
finally:
    sys.path.remove(str(benchmark_directory))

LOAD_RESULT_PROTOCOL = load_measurement.LOAD_RESULT_PROTOCOL
measure_load = load_measurement.measure_load


@pytest.mark.parametrize("engine", ["pandas", "polars"])
def test_measure_load_reports_shape_and_bounded_memory(engine: str, tmp_path: Path) -> None:
    source = tmp_path / "fixture.parquet"
    pl.DataFrame({"c00": [1, 2, 3], "c01": ["a", "b", "c"]}).write_parquet(source)
    result = measure_load(engine, source, 3, 2)

    assert result["protocol"] == LOAD_RESULT_PROTOCOL
    assert result["engine"] == engine
    assert result["elapsedMs"] >= 0
    assert result["rows"] == 3
    assert result["columns"] == 2
    assert result["peakRssBytes"] >= result["baselinePeakRssBytes"]
    assert result["peakRssIncreaseBytes"] == result["peakRssBytes"] - result["baselinePeakRssBytes"]


def test_measure_load_rejects_wrong_shape(tmp_path: Path) -> None:
    source = tmp_path / "fixture.parquet"
    pd.DataFrame({"c00": [1]}).to_parquet(source)
    with pytest.raises(RuntimeError, match="expected 2 x 1"):
        measure_load("pandas", source, 2, 1)
