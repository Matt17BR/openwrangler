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

SCHEMA = "openwrangler-pandas-mixed-text-profile-v1"
DEFAULT_ROWS = 2_000_000
MIN_ROWS = 2_000_000
MAX_ROWS = 5_000_000
DEFAULT_SAMPLES = 3
MAX_SAMPLES = 5
DEFAULT_TIMEOUT_SECONDS = 120.0
MAX_TIMEOUT_SECONDS = 300.0


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Measure eager Pandas mixed-display text summary time and incremental RSS in fresh processes.",
    )
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
    expected_top_values = {"1": short_count, "200": long_count}
    text = summary.get("text", {})
    visualization = summary.get("visualization", {})
    categories = visualization.get("categories")
    if (
        summary.get("type") != "string"
        or summary.get("totalCount") != rows
        or summary.get("nullCount") != 0
        or summary.get("nanCount") != missing_count
        or summary.get("distinctCount") != 2
        or {item["value"]: item["count"] for item in summary.get("topValues", [])} != expected_top_values
        or text.get("emptyCount") != 0
        or text.get("minLength") != 1
        or text.get("maxLength") != 3
        or text.get("meanLength") != float((short_count + (3 * long_count)) / present_count)
        or visualization.get("kind") != "categorical"
        or not isinstance(categories, list)
        or {item["value"]: item["count"] for item in categories} != expected_top_values
        or visualization.get("otherCount") != 0
    ):
        raise RuntimeError("The eager Pandas mixed-display text profile probe received an unexpected summary.")


def _run_child(rows: int) -> None:
    engine, frame, pandas_version = _build_fixture(rows)
    before = _rss_snapshot()
    started = perf_counter_ns()
    summary = engine.summaries(frame, [(0, "c:value")])[0]
    elapsed_ms = (perf_counter_ns() - started) / 1_000_000
    after = _rss_snapshot()
    _validate_summary(summary, rows)
    print(
        json.dumps(
            {
                "pandasVersion": pandas_version,
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

    def measurement(values: list[int | None]) -> dict[str, Any]:
        supported = all(value is not None for value in values)
        return {
            "supported": supported,
            "samples": values,
            "median": int(statistics.median(value for value in values if value is not None)) if supported else None,
        }

    return {
        "elapsedMs": {
            "samples": [round(value, 3) for value in timings],
            "median": round(statistics.median(timings), 3),
        },
        "currentRssDeltaBytes": measurement(current_deltas),
        "peakRssDeltaBytes": measurement(peak_deltas),
    }


def _load_baseline(path: Path, candidate: dict[str, Any]) -> dict[str, Any]:
    try:
        report = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError("The Pandas mixed-display text baseline report is unavailable or malformed.") from error
    if (
        not isinstance(report, dict)
        or report.get("schema") != SCHEMA
        or report.get("pandasVersion") != candidate["pandasVersion"]
        or report.get("rows") != candidate["rows"]
        or report.get("sampleCount") != candidate["sampleCount"]
        or report.get("python") != candidate["python"]
        or report.get("platform") != candidate["platform"]
    ):
        raise RuntimeError("The Pandas mixed-display text baseline does not match this workload or runtime.")
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
        _run_child(arguments.rows)
        return

    samples = [_run_sample(arguments.rows, arguments.timeout_seconds) for _index in range(arguments.samples)]
    report: dict[str, Any] = {
        "schema": SCHEMA,
        "pandasVersion": samples[0]["pandasVersion"],
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
        "measurements": _measurement_summary(samples),
    }
    if arguments.baseline_report is not None:
        report["comparison"] = _comparison(report, _load_baseline(arguments.baseline_report, report))
    print(json.dumps(report, indent=2, sort_keys=True))
    if "comparison" in report and not report["comparison"]["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
