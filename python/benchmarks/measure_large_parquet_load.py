from __future__ import annotations

import argparse
import json
import resource
import time
from pathlib import Path
from typing import Any

LOAD_RESULT_PROTOCOL = "openwrangler-large-parquet-load-v1"


def _peak_rss_bytes() -> int:
    # Linux reports ru_maxrss in KiB. The large editor comparison is Linux-only.
    return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) * 1024


def measure_load(engine: str, source: Path, expected_rows: int, expected_columns: int) -> dict[str, Any]:
    if engine == "pandas":
        import pandas as pd

        reader = pd.read_parquet
    elif engine == "polars":
        import polars as pl

        reader = pl.read_parquet
    else:
        raise ValueError("The large comparison load supports pandas or polars.")

    baseline = _peak_rss_bytes()
    started = time.perf_counter_ns()
    frame = reader(source)
    finished = time.perf_counter_ns()
    rows, columns = frame.shape
    if rows != expected_rows or columns != expected_columns:
        raise RuntimeError(f"Loaded {rows} x {columns}; expected {expected_rows} x {expected_columns}.")
    peak = _peak_rss_bytes()
    return {
        "protocol": LOAD_RESULT_PROTOCOL,
        "engine": engine,
        "elapsedMs": round((finished - started) / 1_000_000, 3),
        "rows": rows,
        "columns": columns,
        "baselinePeakRssBytes": baseline,
        "peakRssBytes": peak,
        "peakRssIncreaseBytes": max(0, peak - baseline),
    }


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Measure one native load of the large comparison Parquet fixture.")
    parser.add_argument("--engine", required=True, choices=["pandas", "polars"])
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--rows", required=True, type=int)
    parser.add_argument("--columns", required=True, type=int)
    return parser.parse_args()


def main() -> None:
    arguments = parse_arguments()
    result = measure_load(arguments.engine, arguments.source, arguments.rows, arguments.columns)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
