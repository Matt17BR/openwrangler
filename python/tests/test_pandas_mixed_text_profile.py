from __future__ import annotations

import json
import sys
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from typing import Any

import pytest


def _load_probe() -> Any:
    path = Path(__file__).parents[1] / "benchmarks" / "pandas_mixed_text_profile.py"
    spec = spec_from_file_location("openwrangler_pandas_mixed_text_profile_probe", path)
    assert spec is not None and spec.loader is not None
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


pandas_mixed_text_profile = _load_probe()


@pytest.mark.parametrize(
    "arguments",
    (
        ["probe", "--rows", "1999999"],
        ["probe", "--rows", "5000001"],
        ["probe", "--samples", "0"],
        ["probe", "--samples", "6"],
        ["probe", "--timeout-seconds", "301"],
    ),
)
def test_pandas_mixed_text_profile_probe_rejects_unbounded_workloads(
    arguments: list[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sys, "argv", arguments)

    with pytest.raises(SystemExit):
        pandas_mixed_text_profile._parse_args()


def test_pandas_mixed_text_profile_probe_computes_exact_partial_pattern_counts() -> None:
    assert pandas_mixed_text_profile._expected_counts(10) == (2, 4, 4)
    assert pandas_mixed_text_profile._expected_counts(16) == (4, 6, 6)


def test_pandas_mixed_text_profile_probe_validates_the_complete_summary_contract() -> None:
    rows = 2_000_000
    missing_count, short_count, long_count = pandas_mixed_text_profile._expected_counts(rows)
    summary = {
        "type": "string",
        "totalCount": rows,
        "nullCount": 0,
        "nanCount": missing_count,
        "distinctCount": 2,
        "topValues": [{"value": "1", "count": short_count}, {"value": "200", "count": long_count}],
        "text": {"emptyCount": 0, "minLength": 1, "maxLength": 3, "meanLength": 2.0},
        "visualization": {
            "kind": "categorical",
            "categories": [{"value": "1", "count": short_count}, {"value": "200", "count": long_count}],
            "otherCount": 0,
        },
    }

    pandas_mixed_text_profile._validate_summary(summary, rows)

    with pytest.raises(RuntimeError, match="unexpected summary"):
        pandas_mixed_text_profile._validate_summary(
            summary | {"text": summary["text"] | {"meanLength": 2.5}},
            rows,
        )


def test_pandas_mixed_text_profile_probe_requires_a_matching_runtime(tmp_path: Path) -> None:
    candidate = {
        "schema": pandas_mixed_text_profile.SCHEMA,
        "pandasVersion": "3.0.3",
        "rows": 2_000_000,
        "sampleCount": 3,
        "python": {"implementation": "CPython", "version": "3.14.4", "platform": "linux"},
        "platform": {"system": "Linux", "release": "test", "machine": "x86_64", "processor": "x86_64"},
    }
    path = tmp_path / "baseline.json"
    path.write_text(json.dumps(candidate | {"pandasVersion": "3.0.2"}), encoding="utf-8")

    with pytest.raises(RuntimeError, match="workload or runtime"):
        pandas_mixed_text_profile._load_baseline(path, candidate)


def test_pandas_mixed_text_profile_probe_requires_time_and_peak_rss_non_regression() -> None:
    baseline = {
        "measurements": {
            "elapsedMs": {"median": 800.0},
            "peakRssDeltaBytes": {"median": 20_000_000},
        }
    }
    candidate = {
        "measurements": {
            "elapsedMs": {"median": 400.0},
            "peakRssDeltaBytes": {"median": 5_000_000},
        }
    }

    comparison = pandas_mixed_text_profile._comparison(candidate, baseline)

    assert comparison["passed"] is True
    assert comparison["elapsedMs"]["changePercent"] == -50.0
    assert comparison["peakRssDeltaBytes"]["changePercent"] == -75.0
