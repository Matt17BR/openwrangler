from __future__ import annotations

import argparse
import json
import math
import os
import platform
import statistics
import subprocess
import sys
from typing import Any

IMPLEMENTATION_MODULES = (
    "openwrangler_runtime.engines.duckdb_engine",
    "openwrangler_runtime.engines.pandas_engine",
    "openwrangler_runtime.engines.polars_engine",
    "openwrangler_runtime.engines.pyspark_engine",
)
BACKENDS = ("polars", "pyspark", "duckdb", "pandas")
DEFAULT_SAMPLES = 9
DEFAULT_WARMUPS = 1
DEFAULT_TIMEOUT_SECONDS = 20.0
MAX_SAMPLES = 30
MAX_WARMUPS = 5
MAX_TIMEOUT_SECONDS = 120.0

_CHILD_SOURCE = r"""
import json
import os
import sys
from time import perf_counter_ns

IMPLEMENTATION_MODULES = (
    "openwrangler_runtime.engines.duckdb_engine",
    "openwrangler_runtime.engines.pandas_engine",
    "openwrangler_runtime.engines.polars_engine",
    "openwrangler_runtime.engines.pyspark_engine",
)


def current_rss_bytes():
    try:
        with open("/proc/self/statm", encoding="ascii") as stream:
            resident_pages = int(stream.read().split()[1])
        return resident_pages * os.sysconf("SC_PAGE_SIZE")
    except (AttributeError, IndexError, OSError, ValueError):
        return None


def peak_rss_bytes():
    try:
        import resource
    except ImportError:
        return None
    maximum = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    return maximum if sys.platform == "darwin" else maximum * 1024


backend = sys.argv[1]
started = perf_counter_ns()
from openwrangler_runtime.server import dispatch
from openwrangler_runtime.session import SessionManager

manager = SessionManager()
response = dispatch(manager, {"kind": "initialize"})
initialized = perf_counter_ns()
initialize_modules = [name for name in IMPLEMENTATION_MODULES if name in sys.modules]
initialize_rss = current_rss_bytes()
initialize_peak_rss = peak_rss_bytes()

backend_started = perf_counter_ns()
manager.prepare_backend({"kind": "file", "path": "open-wrangler-startup-probe.csv"}, backend)
backend_prepared = perf_counter_ns()
selected_modules = [name for name in IMPLEMENTATION_MODULES if name in sys.modules]

print(json.dumps({
    "initializeKind": response["kind"],
    "initializeMs": (initialized - started) / 1_000_000,
    "initializeRssBytes": initialize_rss,
    "initializePeakRssBytes": initialize_peak_rss,
    "initializeModules": initialize_modules,
    "selectedBackendMs": (backend_prepared - backend_started) / 1_000_000,
    "firstSelectedFromStartMs": (backend_prepared - started) / 1_000_000,
    "selectedBackendRssBytes": current_rss_bytes(),
    "selectedBackendPeakRssBytes": peak_rss_bytes(),
    "selectedModules": selected_modules,
}))
manager.close_all()
"""


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Measure fresh-process Open Wrangler initialize and first selected-backend preparation.",
    )
    parser.add_argument("--backend", choices=BACKENDS, default="polars")
    parser.add_argument("--samples", type=int, default=DEFAULT_SAMPLES)
    parser.add_argument("--warmups", type=int, default=DEFAULT_WARMUPS)
    parser.add_argument("--timeout-seconds", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    arguments = parser.parse_args()
    if not 1 <= arguments.samples <= MAX_SAMPLES:
        parser.error(f"--samples must be between 1 and {MAX_SAMPLES}.")
    if not 0 <= arguments.warmups <= MAX_WARMUPS:
        parser.error(f"--warmups must be between 0 and {MAX_WARMUPS}.")
    if not math.isfinite(arguments.timeout_seconds) or not 1.0 <= arguments.timeout_seconds <= MAX_TIMEOUT_SECONDS:
        parser.error(f"--timeout-seconds must be between 1 and {MAX_TIMEOUT_SECONDS}.")
    return arguments


def _run_sample(backend: str, timeout_seconds: float) -> dict[str, Any]:
    completed = subprocess.run(
        [sys.executable, "-c", _CHILD_SOURCE, backend],
        check=True,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
        env=dict(os.environ),
    )
    try:
        sample = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("The startup probe child returned malformed JSON.") from error
    if not isinstance(sample, dict) or sample.get("initializeKind") != "initialized":
        raise RuntimeError("The startup probe child did not initialize the runtime.")
    expected_module = f"openwrangler_runtime.engines.{backend}_engine"
    if sample.get("initializeModules") != []:
        raise RuntimeError("Fresh runtime initialize imported a backend implementation module.")
    if sample.get("selectedModules") != [expected_module]:
        raise RuntimeError("Explicit backend preparation imported an unexpected implementation module set.")
    return sample


def _nearest_rank_p95(values: list[float]) -> float:
    ordered = sorted(values)
    return ordered[math.ceil(0.95 * len(ordered)) - 1]


def _timing_summary(samples: list[dict[str, Any]], field: str) -> dict[str, Any]:
    values = [float(sample[field]) for sample in samples]
    return {
        "samples": [round(value, 3) for value in values],
        "median": round(statistics.median(values), 3),
        "p95": round(_nearest_rank_p95(values), 3),
    }


def _memory_summary(samples: list[dict[str, Any]], initialized_field: str, selected_field: str) -> dict[str, Any]:
    initialized = [sample.get(initialized_field) for sample in samples]
    selected = [sample.get(selected_field) for sample in samples]
    if any(not isinstance(value, int) or value <= 0 for value in (*initialized, *selected)):
        return {
            "supported": False,
            "initializeMedianBytes": None,
            "selectedBackendMedianBytes": None,
            "selectedBackendDeltaMedianBytes": None,
        }
    initialized_values = [value for value in initialized if isinstance(value, int)]
    selected_values = [value for value in selected if isinstance(value, int)]
    return {
        "supported": True,
        "initializeMedianBytes": int(statistics.median(initialized_values)),
        "selectedBackendMedianBytes": int(statistics.median(selected_values)),
        "selectedBackendDeltaMedianBytes": int(
            statistics.median(
                selected_value - initialized_value
                for initialized_value, selected_value in zip(initialized_values, selected_values, strict=True)
            )
        ),
    }


def main() -> None:
    arguments = _parse_args()
    for _index in range(arguments.warmups):
        _run_sample(arguments.backend, arguments.timeout_seconds)
    samples = [_run_sample(arguments.backend, arguments.timeout_seconds) for _index in range(arguments.samples)]
    expected_module = f"openwrangler_runtime.engines.{arguments.backend}_engine"
    report = {
        "schema": "openwrangler-runtime-startup-probe-v1",
        "backend": arguments.backend,
        "sampleCount": arguments.samples,
        "warmupCount": arguments.warmups,
        "childTimeoutSeconds": arguments.timeout_seconds,
        "measurementBoundary": (
            "Fresh interpreter subprocesses measure runtime package import plus initialize, then the first explicit "
            "backend implementation import and top-level native-module preparation; interpreter launch is excluded."
        ),
        "python": {
            "implementation": platform.python_implementation(),
            "version": platform.python_version(),
            "platform": sys.platform,
        },
        "lazyImportContract": {
            "freshInitializeModules": [],
            "selectedBackendModules": [expected_module],
            "passed": True,
        },
        "timingsMs": {
            "initialize": _timing_summary(samples, "initializeMs"),
            "selectedBackend": _timing_summary(samples, "selectedBackendMs"),
            "firstSelectedFromStart": _timing_summary(samples, "firstSelectedFromStartMs"),
        },
        "memory": {
            "currentRss": _memory_summary(samples, "initializeRssBytes", "selectedBackendRssBytes"),
            "peakRss": _memory_summary(samples, "initializePeakRssBytes", "selectedBackendPeakRssBytes"),
        },
    }
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
