from __future__ import annotations

import argparse
import json
import math
import os
import platform
import statistics
import subprocess
import sys
from pathlib import Path
from time import perf_counter_ns
from typing import Any

BACKENDS = ("pandas", "polars")
DEFAULT_ROWS = 2_000_000
MIN_ROWS = 2_000_000
MAX_ROWS = 5_000_000
DEFAULT_SAMPLES = 3
MAX_SAMPLES = 5
DEFAULT_TIMEOUT_SECONDS = 120.0
MAX_TIMEOUT_SECONDS = 300.0


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Measure eager Pandas or Polars numeric summary time and incremental RSS in fresh processes.",
    )
    parser.add_argument("--backend", choices=BACKENDS, required=True)
    parser.add_argument("--rows", type=int, default=DEFAULT_ROWS)
    parser.add_argument("--samples", type=int, default=DEFAULT_SAMPLES)
    parser.add_argument("--timeout-seconds", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--baseline-report", type=Path)
    parser.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    arguments = parser.parse_args()
    if not MIN_ROWS <= arguments.rows <= MAX_ROWS:
        parser.error(f"--rows must be between {MIN_ROWS} and {MAX_ROWS}.")
    if not 1 <= arguments.samples <= MAX_SAMPLES:
        parser.error(f"--samples must be between 1 and {MAX_SAMPLES}.")
    if not math.isfinite(arguments.timeout_seconds) or not 1.0 <= arguments.timeout_seconds <= MAX_TIMEOUT_SECONDS:
        parser.error(f"--timeout-seconds must be between 1 and {MAX_TIMEOUT_SECONDS}.")
    if arguments.child and arguments.baseline_report is not None:
        parser.error("--baseline-report is unavailable in child mode.")
    return arguments


def _current_rss_bytes() -> int | None:
    try:
        with open("/proc/self/statm", encoding="ascii") as stream:
            resident_pages = int(stream.read().split()[1])
        return resident_pages * os.sysconf("SC_PAGE_SIZE")
    except (AttributeError, IndexError, OSError, ValueError):
        return None


def _peak_rss_bytes() -> int | None:
    try:
        import resource
    except ImportError:
        return None
    maximum = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    return maximum if sys.platform == "darwin" else maximum * 1024


def _rss_snapshot() -> dict[str, int | None]:
    return {"currentBytes": _current_rss_bytes(), "peakBytes": _peak_rss_bytes()}


def _build_fixture(backend: str, rows: int) -> tuple[Any, Any, str]:
    if backend == "pandas":
        import numpy as np
        import pandas as pd

        from openwrangler_runtime.engines.pandas_engine import PandasEngine

        values = np.arange(rows, dtype=np.int64) % 4096
        values[-1] = 1_000_000
        return PandasEngine(), pd.DataFrame({"value": values}, copy=False), pd.__version__

    import polars as pl

    from openwrangler_runtime.engines.polars_engine import PolarsEngine

    values = pl.int_range(0, rows, eager=True, dtype=pl.Int64) % 4096
    values[-1] = 1_000_000
    return PolarsEngine(), pl.DataFrame({"value": values}), pl.__version__


def _validate_summary(summary: dict[str, Any], rows: int) -> None:
    bins = summary.get("visualization", {}).get("bins")
    numeric = summary.get("numeric", {})
    if (
        summary.get("totalCount") != rows
        or summary.get("nullCount") != 0
        or summary.get("nanCount") != 0
        or summary.get("distinctCount") != 4097
        or not isinstance(summary.get("topValues"), list)
        or len(summary["topValues"]) != 10
        or numeric.get("min") != 0.0
        or numeric.get("max") != 1_000_000.0
        or not isinstance(bins, list)
        or len(bins) != 20
        or sum(int(item["count"]) for item in bins) != rows
    ):
        raise RuntimeError("The eager numeric profile probe received an unexpected summary.")


def _run_child(backend: str, rows: int) -> None:
    engine, frame, backend_version = _build_fixture(backend, rows)
    before = _rss_snapshot()
    started = perf_counter_ns()
    summary = engine.summaries(frame, [(0, "c:value")])[0]
    elapsed_ms = (perf_counter_ns() - started) / 1_000_000
    after = _rss_snapshot()
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
        raise RuntimeError("The eager numeric profile child returned malformed JSON.") from error
    if not isinstance(sample, dict) or not isinstance(sample.get("elapsedMs"), (int, float)):
        raise RuntimeError("The eager numeric profile child returned an invalid sample.")
    return sample


def _rss_delta(sample: dict[str, Any], field: str) -> int | None:
    before = sample.get("rssBefore", {}).get(field)
    after = sample.get("rssAfter", {}).get(field)
    if not isinstance(before, int) or not isinstance(after, int):
        return None
    return max(0, after - before)


def _measurement_summary(samples: list[dict[str, Any]]) -> dict[str, Any]:
    timings = [float(sample["elapsedMs"]) for sample in samples]
    current_deltas = [_rss_delta(sample, "currentBytes") for sample in samples]
    peak_deltas = [_rss_delta(sample, "peakBytes") for sample in samples]
    return {
        "elapsedMs": {
            "samples": [round(value, 3) for value in timings],
            "median": round(statistics.median(timings), 3),
        },
        "currentRssDeltaBytes": {
            "supported": all(value is not None for value in current_deltas),
            "samples": current_deltas,
            "median": (
                int(statistics.median(value for value in current_deltas if value is not None))
                if all(value is not None for value in current_deltas)
                else None
            ),
        },
        "peakRssDeltaBytes": {
            "supported": all(value is not None for value in peak_deltas),
            "samples": peak_deltas,
            "median": (
                int(statistics.median(value for value in peak_deltas if value is not None))
                if all(value is not None for value in peak_deltas)
                else None
            ),
        },
    }


def _load_baseline(path: Path, candidate: dict[str, Any]) -> dict[str, Any]:
    try:
        report = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError("The eager numeric profile baseline report is unavailable or malformed.") from error
    if (
        not isinstance(report, dict)
        or report.get("schema") != "openwrangler-eager-numeric-profile-v1"
        or report.get("backend") != candidate["backend"]
        or report.get("backendVersion") != candidate["backendVersion"]
        or report.get("rows") != candidate["rows"]
        or report.get("sampleCount") != candidate["sampleCount"]
        or report.get("python") != candidate["python"]
        or report.get("platform") != candidate["platform"]
    ):
        raise RuntimeError("The eager numeric profile baseline does not match this workload or runtime.")
    return report


def _change(candidate: float, baseline: float) -> dict[str, Any]:
    percent = 0.0 if baseline == 0 else ((candidate - baseline) / baseline) * 100.0
    return {
        "baseline": baseline,
        "candidate": candidate,
        "changePercent": round(percent, 3),
        "noRegression": candidate <= baseline,
    }


def _comparison(candidate: dict[str, Any], baseline: dict[str, Any]) -> dict[str, Any]:
    candidate_measurements = candidate["measurements"]
    baseline_measurements = baseline["measurements"]
    timing = _change(
        float(candidate_measurements["elapsedMs"]["median"]),
        float(baseline_measurements["elapsedMs"]["median"]),
    )
    candidate_peak = candidate_measurements["peakRssDeltaBytes"]["median"]
    baseline_peak = baseline_measurements["peakRssDeltaBytes"]["median"]
    peak = (
        _change(float(candidate_peak), float(baseline_peak))
        if isinstance(candidate_peak, int) and isinstance(baseline_peak, int)
        else None
    )
    return {
        "elapsedMs": timing,
        "peakRssDeltaBytes": peak,
        "passed": timing["noRegression"] and peak is not None and peak["noRegression"],
    }


def main() -> None:
    arguments = _parse_args()
    if arguments.child:
        _run_child(arguments.backend, arguments.rows)
        return

    samples = [
        _run_sample(arguments.backend, arguments.rows, arguments.timeout_seconds) for _index in range(arguments.samples)
    ]
    report: dict[str, Any] = {
        "schema": "openwrangler-eager-numeric-profile-v1",
        "backend": arguments.backend,
        "backendVersion": samples[0]["backendVersion"],
        "rows": arguments.rows,
        "sampleCount": arguments.samples,
        "childTimeoutSeconds": arguments.timeout_seconds,
        "measurementBoundary": (
            "Fresh child processes build one eager native integer frame before measuring one complete numeric summary; "
            "elapsed time and incremental current/peak RSS exclude interpreter, backend import, and fixture "
            "construction."
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
        "measurements": _measurement_summary(samples),
    }
    if arguments.baseline_report is not None:
        report["comparison"] = _comparison(
            report,
            _load_baseline(arguments.baseline_report, report),
        )
    print(json.dumps(report, indent=2, sort_keys=True))
    if "comparison" in report and not report["comparison"]["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
