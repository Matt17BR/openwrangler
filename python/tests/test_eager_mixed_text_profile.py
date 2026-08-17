from __future__ import annotations

import json
import subprocess
import sys
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pandas as pd
import pytest

from openwrangler_runtime.engines import pandas_engine as pandas_engine_module


def _load_probe() -> Any:
    benchmarks = Path(__file__).parents[1] / "benchmarks"
    sys.path.insert(0, str(benchmarks))
    try:
        path = benchmarks / "eager_mixed_text_profile.py"
        spec = spec_from_file_location("openwrangler_eager_mixed_text_profile_probe", path)
        assert spec is not None and spec.loader is not None
        module = module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(benchmarks))


eager_mixed_text_profile = _load_probe()


@pytest.mark.parametrize(
    "arguments",
    (
        ["probe", "--rows", "1999999"],
        ["probe", "--rows", "5000001"],
        ["probe", "--samples", "0"],
        ["probe", "--samples", "6"],
        ["probe", "--timeout-seconds", "301"],
        ["probe", "--child", "--baseline-report", "baseline.json"],
    ),
)
def test_eager_mixed_text_profile_probe_rejects_unbounded_workloads(
    arguments: list[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sys, "argv", arguments)

    with pytest.raises(SystemExit):
        eager_mixed_text_profile._parse_args()


def test_eager_mixed_text_profile_probe_computes_exact_partial_pattern_counts() -> None:
    assert eager_mixed_text_profile._expected_counts(10) == (2, 4, 4)
    assert eager_mixed_text_profile._expected_counts(16) == (4, 6, 6)


def test_eager_mixed_text_profile_probe_validates_the_complete_summary_contract() -> None:
    rows = 2_000_000
    missing_count, short_count, long_count = eager_mixed_text_profile._expected_counts(rows)
    summary = {
        "type": "string",
        "rawType": "category",
        "totalCount": rows,
        "nullCount": 0,
        "nanCount": missing_count,
        "distinctCount": 2,
        "topValues": [
            {"value": "1", "count": short_count},
            {"value": "200", "count": long_count},
        ],
        "text": {"emptyCount": 0, "minLength": 1, "maxLength": 3, "meanLength": 2.0},
        "visualization": {
            "kind": "categorical",
            "categories": [
                {"value": "1", "count": short_count},
                {"value": "200", "count": long_count},
            ],
            "otherCount": 0,
        },
    }

    eager_mixed_text_profile._validate_summary(summary, rows)

    with pytest.raises(RuntimeError, match="unexpected summary"):
        eager_mixed_text_profile._validate_summary(
            summary | {"text": summary["text"] | {"meanLength": 2.5}},
            rows,
        )


def test_pandas_mixed_text_reduction_normalizes_categories_once_and_streams_objects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original_normalize_cell = pandas_engine_module.normalize_cell
    normalized: list[Any] = []

    def observe_normalize_cell(value: Any) -> dict[str, Any]:
        normalized.append(value)
        return original_normalize_cell(value)

    monkeypatch.setattr(pandas_engine_module, "normalize_cell", observe_normalize_cell)

    category_summary = pandas_engine_module._pandas_text_summary(
        pd.Series(pd.Categorical([None, 1, 200, 1, 200, 1] * 1_024, categories=[1, 200]))
    )

    assert normalized == [1, 200]
    assert category_summary == {
        "emptyCount": 0,
        "minLength": 1,
        "maxLength": 3,
        "meanLength": 1.8,
    }

    normalized.clear()
    object_summary = pandas_engine_module._pandas_text_summary(
        pd.Series([b"\x00", "x", None, float("nan"), b"\x00"], dtype="object")
    )

    assert normalized == [b"\x00", "x", b"\x00"]
    assert object_summary == {
        "emptyCount": 0,
        "minLength": 1,
        "maxLength": 4,
        "meanLength": 3.0,
    }


def test_eager_mixed_text_profile_probe_runs_one_bounded_child(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    observed: dict[str, Any] = {}

    def run(arguments: list[str], **options: Any) -> SimpleNamespace:
        observed.update({"arguments": arguments, "options": options})
        return SimpleNamespace(
            stdout=json.dumps(
                {
                    "backendVersion": "3.0.3",
                    "elapsedMs": 125.0,
                    "rssBefore": {"currentBytes": 10, "peakBytes": 20},
                    "rssAfter": {"currentBytes": 30, "peakBytes": 40},
                }
            )
        )

    monkeypatch.setattr(subprocess, "run", run)

    sample = eager_mixed_text_profile._run_sample(2_000_000, 120.0)

    assert sample["elapsedMs"] == 125.0
    assert observed["arguments"][0] == sys.executable
    assert observed["arguments"][2:] == [
        "--rows",
        "2000000",
        "--samples",
        "1",
        "--timeout-seconds",
        "120.0",
        "--child",
    ]
    assert observed["options"]["timeout"] == 120.0
    assert observed["options"]["check"] is True


def test_eager_mixed_text_profile_probe_rejects_a_different_baseline_runtime(tmp_path: Path) -> None:
    candidate = {
        "schema": eager_mixed_text_profile.SCHEMA,
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
        eager_mixed_text_profile._load_baseline(path, candidate)
