from __future__ import annotations

import json
import sys
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from typing import Any

import pytest


def _load_probe() -> Any:
    benchmarks = Path(__file__).parents[1] / "benchmarks"
    sys.path.insert(0, str(benchmarks))
    try:
        path = benchmarks / "eager_boolean_profile.py"
        spec = spec_from_file_location("openwrangler_eager_boolean_profile_probe", path)
        assert spec is not None and spec.loader is not None
        module = module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(benchmarks))


eager_boolean_profile = _load_probe()


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
def test_eager_boolean_profile_probe_rejects_unbounded_workloads(
    arguments: list[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sys, "argv", arguments)

    with pytest.raises(SystemExit):
        eager_boolean_profile._parse_args()


def test_eager_boolean_profile_probe_computes_exact_partial_pattern_counts() -> None:
    assert eager_boolean_profile._expected_counts(10) == (6, 4)
    assert eager_boolean_profile._expected_counts(16) == (10, 6)


def test_eager_boolean_profile_probe_validates_the_complete_summary_contract() -> None:
    rows = 2_000_000
    true_count, false_count = eager_boolean_profile._expected_counts(rows)
    summary = {
        "type": "boolean",
        "totalCount": rows,
        "nullCount": 0,
        "nanCount": 0,
        "distinctCount": 2,
        "topValues": [
            {"value": "True", "count": true_count},
            {"value": "False", "count": false_count},
        ],
        "visualization": {"kind": "boolean", "trueCount": true_count, "falseCount": false_count},
    }

    eager_boolean_profile._validate_summary(summary, rows)

    with pytest.raises(RuntimeError, match="unexpected summary"):
        eager_boolean_profile._validate_summary(
            summary | {"visualization": summary["visualization"] | {"trueCount": true_count - 1}},
            rows,
        )


def test_eager_boolean_profile_probe_rejects_a_different_baseline_runtime(tmp_path: Path) -> None:
    candidate = {
        "schema": eager_boolean_profile.SCHEMA,
        "backend": "pandas",
        "backendVersion": "3.0.3",
        "rows": 2_000_000,
        "sampleCount": 3,
        "python": {"implementation": "CPython", "version": "3.14.4", "platform": "linux"},
        "platform": {"system": "Linux", "release": "test", "machine": "x86_64", "processor": "x86_64"},
    }
    path = tmp_path / "baseline.json"
    path.write_text(json.dumps(candidate | {"backendVersion": "3.0.2"}), encoding="utf-8")

    with pytest.raises(RuntimeError, match="workload or runtime"):
        eager_boolean_profile._load_baseline(path, candidate)
