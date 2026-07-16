from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.parametrize(
    ("backend", "expected_frame_suffix", "expected_lazy"),
    [
        ("pandas", "DataFrame", False),
        ("duckdb", "DuckDBPyRelation", True),
    ],
)
def test_opt_in_native_backend_smoke_reports_provenance_and_resource_boundaries(
    tmp_path: Path,
    backend: str,
    expected_frame_suffix: str,
    expected_lazy: bool,
) -> None:
    python_root = Path(__file__).parents[1]
    report_path = tmp_path / f"{backend}.json"
    subprocess.run(
        [
            sys.executable,
            str(python_root / "benchmarks" / "runtime_performance.py"),
            "--smoke",
            "--backend",
            backend,
            "--fixture-dir",
            str(tmp_path / "fixtures"),
            "--json-out",
            str(report_path),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    )

    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["backend"] == backend
    metadata = report["benchmarkMetadata"]
    assert metadata["selectedBackend"] == backend
    assert metadata["selectedBackendIsReleaseGated"] is False
    assert metadata["releaseLimitsApplyToBackend"] == "polars"
    assert "not VS Code, Cursor, webview, or editor first-paint timings" in metadata["measurementBoundary"]
    assert metadata["fixtures"].startswith("deterministic synthetic")

    provenance = report["provenance"]
    assert provenance["selectedBackend"] == backend
    assert provenance["packages"][backend]
    assert provenance["runtime"]["pythonVersion"]
    assert provenance["runtime"]["openWranglerRuntimeVersion"]
    logical_cpu_count = provenance["machine"]["logicalCpuCount"]
    assert logical_cpu_count is None or logical_cpu_count > 0
    assert set(provenance["source"]) == {"commit", "trackedWorktreeDirty"}
    _assert_resource_evidence(report["processResources"], {"benchmark-started", "fixtures-ready", "benchmark-complete"})

    for kind in ("csv", "parquet"):
        fixture = report[kind]
        assert fixture["backend"] == backend
        assert fixture["nativeEngineRetained"] is True
        assert fixture["lazyNativeRetained"] is expected_lazy
        assert fixture["lazyPolarsRetained"] is False
        assert all(
            frame_type.endswith(expected_frame_suffix)
            for frame_type in fixture["engineMetadata"]["frameTypes"].values()
        )
        assert all(fixture["engineMetadata"]["nativeFrames"].values())
        assert all(fixture["engineMetadata"]["lazyNativeFrames"].values()) is expected_lazy
        transport = fixture["stdioTransport"]
        assert transport["backend"] == backend
        assert transport["closedCleanly"] is True
        _assert_resource_evidence(
            transport["processResources"],
            {
                "initialized",
                "session-opened",
                "cache-miss-pages-complete",
                "profile-contention-complete",
                "session-closed",
            },
        )


def _assert_resource_evidence(evidence: dict[str, object], expected_stages: set[str]) -> None:
    assert isinstance(evidence["supported"], bool)
    assert isinstance(evidence["boundary"], str)
    samples = evidence["samples"]
    assert isinstance(samples, list)
    assert {sample["stage"] for sample in samples} == expected_stages
    for sample in samples:
        assert isinstance(sample["supported"], bool)
        assert sample["sampler"] in {"linux-proc-status", "posix-ps-rss", "resource-getrusage", "unavailable"}
        assert sample["rssBytes"] is None or sample["rssBytes"] > 0
        assert sample["peakRssBytes"] is None or sample["peakRssBytes"] > 0
    if evidence["supported"]:
        assert evidence["maxObservedRssBytes"] is not None or evidence["maxObservedPeakRssBytes"] is not None
