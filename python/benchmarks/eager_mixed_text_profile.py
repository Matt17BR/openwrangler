from __future__ import annotations

import argparse
import json
import math
import os
import platform
import subprocess
import sys
from pathlib import Path
from time import perf_counter_ns
from typing import Any

import eager_numeric_profile as probe_support

SCHEMA = "openwrangler-eager-pandas-mixed-text-profile-v1"
BACKEND = "pandas"


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Measure eager Pandas mixed-display text summary time and incremental RSS in fresh processes.",
    )
    parser.add_argument("--rows", type=int, default=probe_support.DEFAULT_ROWS)
    parser.add_argument("--samples", type=int, default=probe_support.DEFAULT_SAMPLES)
    parser.add_argument("--timeout-seconds", type=float, default=probe_support.DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--baseline-report", type=Path)
    parser.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    arguments = parser.parse_args()
    if not probe_support.MIN_ROWS <= arguments.rows <= probe_support.MAX_ROWS:
        parser.error(f"--rows must be between {probe_support.MIN_ROWS} and {probe_support.MAX_ROWS}.")
    if not 1 <= arguments.samples <= probe_support.MAX_SAMPLES:
        parser.error(f"--samples must be between 1 and {probe_support.MAX_SAMPLES}.")
    if (
        not math.isfinite(arguments.timeout_seconds)
        or not 1.0 <= arguments.timeout_seconds <= probe_support.MAX_TIMEOUT_SECONDS
    ):
        parser.error(f"--timeout-seconds must be between 1 and {probe_support.MAX_TIMEOUT_SECONDS}.")
    if arguments.child and arguments.baseline_report is not None:
        parser.error("--baseline-report is unavailable in child mode.")
    return arguments


def _expected_counts(rows: int) -> tuple[int, int, int]:
    pattern = (-1, 0, 1, 0, 1, -1, 0, 1, 0, 1)
    complete_patterns, remainder = divmod(rows, len(pattern))
    tail = pattern[:remainder]
    missing_count = complete_patterns * 2 + tail.count(-1)
    short_count = complete_patterns * 4 + tail.count(0)
    long_count = complete_patterns * 4 + tail.count(1)
    return missing_count, short_count, long_count


def _build_fixture(rows: int) -> tuple[Any, Any, str]:
    import numpy as np
    import pandas as pd

    from openwrangler_runtime.engines.pandas_engine import PandasEngine

    pattern = np.array([-1, 0, 1, 0, 1, -1, 0, 1, 0, 1], dtype=np.int8)
    codes = np.tile(pattern, (rows + len(pattern) - 1) // len(pattern))[:rows]
    values = pd.Categorical.from_codes(codes, categories=[1, 200])
    return PandasEngine(), pd.DataFrame({"value": values}, copy=False), pd.__version__


def _validate_summary(summary: dict[str, Any], rows: int) -> None:
    missing_count, short_count, long_count = _expected_counts(rows)
    present_count = short_count + long_count
    expected_top_values = [
        {"value": "1", "count": short_count},
        {"value": "200", "count": long_count},
    ]
    expected_text = {
        "emptyCount": 0,
        "minLength": 1,
        "maxLength": 3,
        "meanLength": float((short_count + (3 * long_count)) / present_count),
    }
    expected_visualization = {
        "kind": "categorical",
        "categories": expected_top_values,
        "otherCount": 0,
    }
    if (
        summary.get("type") != "string"
        or summary.get("rawType") != "category"
        or summary.get("totalCount") != rows
        or summary.get("nullCount") != 0
        or summary.get("nanCount") != missing_count
        or summary.get("distinctCount") != 2
        or summary.get("topValues") != expected_top_values
        or summary.get("text") != expected_text
        or summary.get("visualization") != expected_visualization
        or "numeric" in summary
    ):
        raise RuntimeError("The eager Pandas mixed-display text profile probe received an unexpected summary.")


def _run_child(rows: int) -> None:
    engine, frame, backend_version = _build_fixture(rows)
    before = probe_support._rss_snapshot()
    started = perf_counter_ns()
    summary = engine.summaries(frame, [(0, "c:value")])[0]
    elapsed_ms = (perf_counter_ns() - started) / 1_000_000
    after = probe_support._rss_snapshot()
    _validate_summary(summary, rows)
    print(
        json.dumps(
            {
                "backendVersion": backend_version,
                "elapsedMs": elapsed_ms,
                "rssBefore": before,
                "rssAfter": after,
            }
        )
    )


def _run_sample(rows: int, timeout_seconds: float) -> dict[str, Any]:
    completed = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve()),
            "--rows",
            str(rows),
            "--samples",
            "1",
            "--timeout-seconds",
            str(timeout_seconds),
            "--child",
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
        env=dict(os.environ),
    )
    try:
        sample = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("The eager Pandas mixed-display text profile child returned malformed JSON.") from error
    if not isinstance(sample, dict) or not isinstance(sample.get("elapsedMs"), (int, float)):
        raise RuntimeError("The eager Pandas mixed-display text profile child returned an invalid sample.")
    return sample


def _load_baseline(path: Path, candidate: dict[str, Any]) -> dict[str, Any]:
    try:
        report = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(
            "The eager Pandas mixed-display text baseline report is unavailable or malformed."
        ) from error
    if (
        not isinstance(report, dict)
        or report.get("schema") != SCHEMA
        or report.get("backend") != candidate["backend"]
        or report.get("backendVersion") != candidate["backendVersion"]
        or report.get("rows") != candidate["rows"]
        or report.get("sampleCount") != candidate["sampleCount"]
        or report.get("python") != candidate["python"]
        or report.get("platform") != candidate["platform"]
    ):
        raise RuntimeError("The eager Pandas mixed-display text baseline does not match this workload or runtime.")
    return report


def main() -> None:
    arguments = _parse_args()
    if arguments.child:
        _run_child(arguments.rows)
        return

    samples = [_run_sample(arguments.rows, arguments.timeout_seconds) for _index in range(arguments.samples)]
    report: dict[str, Any] = {
        "schema": SCHEMA,
        "backend": BACKEND,
        "backendVersion": samples[0]["backendVersion"],
        "rows": arguments.rows,
        "sampleCount": arguments.samples,
        "childTimeoutSeconds": arguments.timeout_seconds,
        "measurementBoundary": (
            "Fresh child processes build one eager native Pandas categorical frame before measuring one complete "
            "mixed-display text summary; elapsed time and incremental current/peak RSS exclude interpreter, Pandas "
            "import, and fixture construction."
        ),
        "python": {
            "implementation": platform.python_implementation(),
            "version": platform.python_version(),
            "platform": sys.platform,
        },
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "processor": platform.processor(),
        },
        "measurements": probe_support._measurement_summary(samples),
    }
    if arguments.baseline_report is not None:
        report["comparison"] = probe_support._comparison(report, _load_baseline(arguments.baseline_report, report))
    print(json.dumps(report, indent=2, sort_keys=True))
    if "comparison" in report and not report["comparison"]["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
