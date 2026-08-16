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

SCHEMA = "openwrangler-eager-boolean-profile-v1"


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Measure eager Pandas or Polars boolean summary time and incremental RSS in fresh processes.",
    )
    parser.add_argument("--backend", choices=probe_support.BACKENDS, required=True)
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


def _expected_counts(rows: int) -> tuple[int, int]:
    pattern = (True, False, True, True, False, True, False, True, True, False)
    complete_patterns, remainder = divmod(rows, len(pattern))
    tail = pattern[:remainder]
    true_count = complete_patterns * 6 + sum(value is True for value in tail)
    false_count = complete_patterns * 4 + sum(value is False for value in tail)
    return true_count, false_count


def _build_fixture(backend: str, rows: int) -> tuple[Any, Any, str]:
    if backend == "pandas":
        import numpy as np
        import pandas as pd

        from openwrangler_runtime.engines.pandas_engine import PandasEngine

        pattern = np.array([True, False, True, True, False, True, False, True, True, False], dtype=np.bool_)
        values = np.tile(pattern, (rows + len(pattern) - 1) // len(pattern))[:rows]
        return PandasEngine(), pd.DataFrame({"value": values}, copy=False), pd.__version__

    import numpy as np
    import polars as pl

    from openwrangler_runtime.engines.polars_engine import PolarsEngine

    pattern = np.array([True, False, True, True, False, True, False, True, True, False], dtype=np.bool_)
    values = np.tile(pattern, (rows + len(pattern) - 1) // len(pattern))[:rows]
    return PolarsEngine(), pl.DataFrame({"value": values}), pl.__version__


def _validate_summary(summary: dict[str, Any], rows: int) -> None:
    true_count, false_count = _expected_counts(rows)
    expected_top_values = [
        {"value": "True", "count": true_count},
        {"value": "False", "count": false_count},
    ]
    expected_visualization = {
        "kind": "boolean",
        "trueCount": true_count,
        "falseCount": false_count,
    }
    if (
        summary.get("type") != "boolean"
        or summary.get("totalCount") != rows
        or summary.get("nullCount") != 0
        or summary.get("nanCount") != 0
        or summary.get("distinctCount") != 2
        or summary.get("topValues") != expected_top_values
        or summary.get("visualization") != expected_visualization
        or "numeric" in summary
        or "text" in summary
    ):
        raise RuntimeError("The eager boolean profile probe received an unexpected summary.")


def _run_child(backend: str, rows: int) -> None:
    engine, frame, backend_version = _build_fixture(backend, rows)
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


def _run_sample(backend: str, rows: int, timeout_seconds: float) -> dict[str, Any]:
    completed = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve()),
            "--backend",
            backend,
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
        raise RuntimeError("The eager boolean profile child returned malformed JSON.") from error
    if not isinstance(sample, dict) or not isinstance(sample.get("elapsedMs"), (int, float)):
        raise RuntimeError("The eager boolean profile child returned an invalid sample.")
    return sample


def _load_baseline(path: Path, candidate: dict[str, Any]) -> dict[str, Any]:
    try:
        report = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError("The eager boolean profile baseline report is unavailable or malformed.") from error
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
        raise RuntimeError("The eager boolean profile baseline does not match this workload or runtime.")
    return report


def main() -> None:
    arguments = _parse_args()
    if arguments.child:
        _run_child(arguments.backend, arguments.rows)
        return

    samples = [
        _run_sample(arguments.backend, arguments.rows, arguments.timeout_seconds) for _index in range(arguments.samples)
    ]
    report: dict[str, Any] = {
        "schema": SCHEMA,
        "backend": arguments.backend,
        "backendVersion": samples[0]["backendVersion"],
        "rows": arguments.rows,
        "sampleCount": arguments.samples,
        "childTimeoutSeconds": arguments.timeout_seconds,
        "measurementBoundary": (
            "Fresh child processes build one eager native boolean frame before measuring one complete "
            "boolean summary; elapsed time and incremental current/peak RSS exclude interpreter, backend import, "
            "and fixture construction."
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
        report["comparison"] = probe_support._comparison(
            report,
            _load_baseline(arguments.baseline_report, report),
        )
    print(json.dumps(report, indent=2, sort_keys=True))
    if "comparison" in report and not report["comparison"]["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
