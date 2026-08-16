from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


def test_runtime_startup_probe_is_bounded_and_proves_lazy_polars_imports() -> None:
    python_root = Path(__file__).parents[1]
    environment = dict(os.environ)
    environment["PYTHONPATH"] = os.pathsep.join(
        item for item in (str(python_root), environment.get("PYTHONPATH", "")) if item
    )
    completed = subprocess.run(
        [
            sys.executable,
            str(python_root / "benchmarks" / "runtime_startup.py"),
            "--backend",
            "polars",
            "--samples",
            "2",
            "--warmups",
            "0",
            "--timeout-seconds",
            "20",
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
        env=environment,
    )
    report = json.loads(completed.stdout)

    assert report["schema"] == "openwrangler-runtime-startup-probe-v1"
    assert report["backend"] == "polars"
    assert report["sampleCount"] == 2
    assert report["warmupCount"] == 0
    assert report["childTimeoutSeconds"] == 20.0
    assert report["lazyImportContract"] == {
        "freshInitializeModules": [],
        "selectedBackendModules": ["openwrangler_runtime.engines.polars_engine"],
        "passed": True,
    }
    assert "interpreter launch is excluded" in report["measurementBoundary"]
    for stage in ("initialize", "selectedBackend", "firstSelectedFromStart"):
        timing = report["timingsMs"][stage]
        assert len(timing["samples"]) == 2
        assert timing["median"] >= 0
        assert timing["p95"] >= timing["median"]
    for boundary in ("currentRss", "peakRss"):
        memory = report["memory"][boundary]
        assert isinstance(memory["supported"], bool)
        if memory["supported"]:
            assert memory["initializeMedianBytes"] > 0
            assert memory["selectedBackendMedianBytes"] > 0
