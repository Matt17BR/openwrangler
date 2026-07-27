from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
from importlib import import_module
from pathlib import Path
from typing import Any, cast

import pytest

benchmark_directory = Path(__file__).parents[1] / "benchmarks"
sys.path.insert(0, str(benchmark_directory))
try:
    source_cache_control = import_module("source_cache_control")
    prepare_source_cache = cast(Any, source_cache_control.prepare_source_cache)
finally:
    sys.path.remove(str(benchmark_directory))


def test_cold_source_cache_syncs_once_then_advises_once_and_verifies(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "fixture.parquet"
    source.write_bytes(b"deterministic" * 10_000)
    events: list[str] = []
    resident_counts = iter([32, 0])

    monkeypatch.setattr(source_cache_control, "_linux_cache_proof_available", lambda: True)
    monkeypatch.setattr(source_cache_control.os, "fdatasync", lambda _descriptor: events.append("fdatasync"))
    monkeypatch.setattr(
        source_cache_control.os,
        "posix_fadvise",
        lambda _descriptor, _offset, _length, _advice: events.append("fadvise"),
    )

    def residency(_descriptor: int, _size: int, _total_pages: int) -> int:
        events.append("mincore")
        return next(resident_counts)

    monkeypatch.setattr(source_cache_control, "_resident_page_count", residency)

    result = prepare_source_cache(source, "cold")

    assert events == ["fdatasync", "mincore", "fadvise", "mincore"]
    assert result == {
        "protocol": "openwrangler-source-cache-proof-v1",
        "requestedState": "evicted",
        "fdatasyncApplied": True,
        "adviceAccepted": True,
        "verification": "linux-mincore",
        "pageSizeBytes": os.sysconf("SC_PAGE_SIZE"),
        "totalPages": (source.stat().st_size + os.sysconf("SC_PAGE_SIZE") - 1) // os.sysconf("SC_PAGE_SIZE"),
        "residentPagesBefore": 32,
        "residentPagesAfter": 0,
        "identityStable": True,
        "verified": True,
    }


def test_warm_source_cache_reads_the_complete_owned_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = tmp_path / "fixture.csv"
    source.write_bytes((b"open-wrangler\n" * 100_000) + b"complete")
    total_pages = (source.stat().st_size + os.sysconf("SC_PAGE_SIZE") - 1) // os.sysconf("SC_PAGE_SIZE")
    resident_counts = iter([0, total_pages])

    monkeypatch.setattr(source_cache_control, "_linux_cache_proof_available", lambda: True)
    monkeypatch.setattr(source_cache_control, "_resident_page_count", lambda *_arguments: next(resident_counts))

    result = prepare_source_cache(source, "warm")

    assert result["requestedState"] == "resident"
    assert result["fdatasyncApplied"] is True
    assert result["adviceAccepted"] is False
    assert result["residentPagesBefore"] == 0
    assert result["residentPagesAfter"] == total_pages
    assert result["verified"] is True


def test_residual_cold_pages_are_retained_as_unverified_evidence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "fixture.parquet"
    source.write_bytes(b"deterministic" * 10_000)
    resident_counts = iter([32, 1])

    monkeypatch.setattr(source_cache_control, "_linux_cache_proof_available", lambda: True)
    monkeypatch.setattr(source_cache_control, "_resident_page_count", lambda *_arguments: next(resident_counts))

    result = prepare_source_cache(source, "cold")

    assert result["residentPagesAfter"] == 1
    assert result["verified"] is False


@pytest.mark.parametrize("failing_operation", ["fdatasync", "fadvise", "mincore"])
def test_cache_control_faults_fail_without_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failing_operation: str
) -> None:
    source = tmp_path / "fixture.parquet"
    source.write_bytes(b"deterministic" * 10_000)
    calls = {"fdatasync": 0, "fadvise": 0, "mincore": 0}

    monkeypatch.setattr(source_cache_control, "_linux_cache_proof_available", lambda: True)

    def operation(name: str) -> None:
        calls[name] += 1
        if name == failing_operation:
            raise OSError(f"{name} failed")

    monkeypatch.setattr(source_cache_control.os, "fdatasync", lambda _descriptor: operation("fdatasync"))
    monkeypatch.setattr(
        source_cache_control.os,
        "posix_fadvise",
        lambda _descriptor, _offset, _length, _advice: operation("fadvise"),
    )

    def residency(*_arguments: object) -> int:
        operation("mincore")
        return 0

    monkeypatch.setattr(source_cache_control, "_resident_page_count", residency)

    with pytest.raises(OSError, match=f"{failing_operation} failed"):
        prepare_source_cache(source, "cold")

    assert calls[failing_operation] == 1


def test_identity_drift_fails_cache_preparation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = tmp_path / "fixture.parquet"
    source.write_bytes(b"deterministic" * 10_000)
    resident_counts = iter([32, 0])

    monkeypatch.setattr(source_cache_control, "_linux_cache_proof_available", lambda: True)
    monkeypatch.setattr(source_cache_control, "_resident_page_count", lambda *_arguments: next(resident_counts))
    monkeypatch.setattr(source_cache_control, "_source_identity_stable", lambda *_arguments: False)

    with pytest.raises(ValueError, match="changed identity"):
        prepare_source_cache(source, "cold")


def test_source_cache_rejects_symlinks_and_hard_links(tmp_path: Path) -> None:
    source = tmp_path / "fixture.csv"
    source.write_text("value\n1\n", encoding="utf-8")
    symlink = tmp_path / "linked.csv"
    symlink.symlink_to(source)
    hardlink = tmp_path / "hard.csv"
    os.link(source, hardlink)

    with pytest.raises(ValueError, match="single-link regular file"):
        prepare_source_cache(symlink, "warm")
    with pytest.raises(ValueError, match="single-link regular file"):
        prepare_source_cache(source, "warm")


def test_actual_linux_cold_proof_is_path_free_and_bounded(tmp_path: Path) -> None:
    if sys.platform != "linux":
        pytest.skip("Linux mincore proof is platform-specific.")
    source = tmp_path / "private-source.parquet"
    source.write_bytes(b"deterministic" * 100_000)

    result = prepare_source_cache(source, "cold")
    serialized = json.dumps(result, sort_keys=True)

    assert result["verification"] == "linux-mincore"
    assert result["fdatasyncApplied"] is True
    assert result["adviceAccepted"] is True
    assert result["residentPagesAfter"] is not None
    assert result["verified"] is (result["residentPagesAfter"] == 0)
    assert str(source) not in serialized
    assert len(serialized.encode("utf-8")) < 2_048


def test_source_cache_cli_emits_only_the_public_result(tmp_path: Path) -> None:
    source = tmp_path / "private-source.csv"
    source.write_bytes(b"column\n1\n")
    script = Path(__file__).parents[1] / "benchmarks" / "source_cache_control.py"

    completed = subprocess.run(
        [sys.executable, str(script), "--source", str(source), "--mode", "warm"],
        check=True,
        capture_output=True,
        text=True,
    )
    result = json.loads(completed.stdout)

    assert result["protocol"] == "openwrangler-source-cache-proof-v1"
    assert result["requestedState"] == "resident"
    assert result["verification"] in {"linux-mincore", "unavailable"}
    assert str(source) not in completed.stdout
    assert stat.S_ISREG(source.stat().st_mode)
