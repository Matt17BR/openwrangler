from __future__ import annotations

import json
import sys
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from typing import Any

import pytest


def _load_probe() -> Any:
    path = Path(__file__).parents[1] / "benchmarks" / "eager_numeric_profile.py"
    spec = spec_from_file_location("openwrangler_eager_numeric_profile_probe", path)
    assert spec is not None and spec.loader is not None
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


eager_numeric_profile = _load_probe()


def _report(elapsed_ms: float, peak_rss_delta_bytes: int) -> dict[str, Any]:
    return {
        "measurements": {
            "elapsedMs": {"median": elapsed_ms},
            "peakRssDeltaBytes": {"median": peak_rss_delta_bytes},
        }
    }


@pytest.mark.parametrize(
    "arguments",
    (
        ["probe", "--backend", "pandas", "--rows", "1999999"],
        ["probe", "--backend", "polars", "--rows", "5000001"],
        ["probe", "--backend", "pandas", "--samples", "0"],
        ["probe", "--backend", "polars", "--samples", "6"],
        ["probe", "--backend", "pandas", "--timeout-seconds", "301"],
    ),
)
def test_eager_numeric_profile_probe_rejects_unbounded_workloads(
    arguments: list[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sys, "argv", arguments)

    with pytest.raises(SystemExit):
        eager_numeric_profile._parse_args()


def test_eager_numeric_profile_probe_comparison_requires_time_and_peak_rss_non_regression() -> None:
    baseline = _report(800.0, 200_000_000)

    passing = eager_numeric_profile._comparison(_report(300.0, 50_000_000), baseline)
    slower = eager_numeric_profile._comparison(_report(801.0, 50_000_000), baseline)
    larger = eager_numeric_profile._comparison(_report(300.0, 200_000_001), baseline)

    assert passing == {
        "elapsedMs": {
            "baseline": 800.0,
            "candidate": 300.0,
            "changePercent": -62.5,
            "noRegression": True,
        },
        "peakRssDeltaBytes": {
            "baseline": 200_000_000.0,
            "candidate": 50_000_000.0,
            "changePercent": -75.0,
            "noRegression": True,
        },
        "passed": True,
    }
    assert slower["passed"] is False
    assert slower["elapsedMs"]["noRegression"] is False
    assert larger["passed"] is False
    assert larger["peakRssDeltaBytes"]["noRegression"] is False


def test_eager_numeric_profile_probe_validates_the_complete_summary_contract() -> None:
    eager_numeric_profile._validate_summary(
        {
            "totalCount": 2_000_000,
            "nullCount": 0,
            "nanCount": 0,
            "distinctCount": 4097,
            "topValues": [{"value": str(index), "count": 1} for index in range(10)],
            "numeric": {"min": 0.0, "max": 1_000_000.0},
            "visualization": {"bins": [{"count": 100_000} for _index in range(20)]},
        },
        2_000_000,
    )

    with pytest.raises(RuntimeError, match="unexpected summary"):
        eager_numeric_profile._validate_summary(
            {
                "totalCount": 2_000_000,
                "nullCount": 0,
                "nanCount": 1,
                "distinctCount": 4097,
                "topValues": [{"value": str(index), "count": 1} for index in range(10)],
                "numeric": {"min": 0.0, "max": 1_000_000.0},
                "visualization": {"bins": [{"count": 100_000} for _index in range(20)]},
            },
            2_000_000,
        )


def test_eager_numeric_profile_probe_rejects_a_different_baseline_runtime(tmp_path) -> None:
    candidate = {
        "schema": "openwrangler-eager-numeric-profile-v1",
        "backend": "pandas",
        "backendVersion": "3.0.3",
        "rows": 2_000_000,
        "sampleCount": 3,
        "python": {"implementation": "CPython", "version": "3.14.4", "platform": "linux"},
        "platform": {"system": "Linux", "release": "test", "machine": "x86_64", "processor": "x86_64"},
    }
    baseline = candidate | {"backendVersion": "3.0.2"}
    path = tmp_path / "baseline.json"
    path.write_text(json.dumps(baseline), encoding="utf-8")

    with pytest.raises(RuntimeError, match="workload or runtime"):
        eager_numeric_profile._load_baseline(path, candidate)
