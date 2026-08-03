from __future__ import annotations

import hashlib
import json
import mmap
import os
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
    prepare_study_v2_source_cache = cast(Any, source_cache_control.prepare_study_v2_source_cache)
finally:
    sys.path.remove(str(benchmark_directory))


@pytest.mark.parametrize("mode,requested_state", [("cold", "evicted"), ("warm", "resident")])
def test_study_v2_proof_binds_source_controller_and_running_interpreter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mode: str, requested_state: str
) -> None:
    source = tmp_path / "trial-copy.parquet"
    source.write_bytes(b"deterministic-study-source" * 10_000)
    total_pages = (source.stat().st_size + mmap.PAGESIZE - 1) // mmap.PAGESIZE
    resident_counts = iter([total_pages if mode == "cold" else 0, 0 if mode == "cold" else total_pages])

    monkeypatch.setattr(source_cache_control, "_linux_cache_proof_available", lambda: True)
    monkeypatch.setattr(source_cache_control, "_sync_file_data", lambda _descriptor: None)
    monkeypatch.setattr(source_cache_control, "_advise_dont_need", lambda _descriptor: None)
    monkeypatch.setattr(source_cache_control, "_resident_page_count", lambda *_arguments: next(resident_counts))

    controller = Path(cast(str, source_cache_control.__file__))
    controller_descriptor = os.open(controller, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    python_descriptor = os.open("/proc/self/exe", os.O_RDONLY)
    source_descriptor = os.open(source, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        result = prepare_study_v2_source_cache(source_descriptor, mode, controller_descriptor, python_descriptor)
    finally:
        os.close(source_descriptor)
        os.close(python_descriptor)
        os.close(controller_descriptor)
    source_metadata = source.stat()
    expected_source_identity = {
        "device": str(source_metadata.st_dev),
        "inode": str(source_metadata.st_ino),
        "sizeBytes": source_metadata.st_size,
        "mtimeNs": str(source_metadata.st_mtime_ns),
    }
    controller_metadata = controller.stat()

    assert result["protocol"] == "openwrangler-source-cache-proof-study-v2"
    assert result["requestedState"] == requested_state
    assert result["pageSizeBytes"] == mmap.PAGESIZE
    assert result["totalPages"] == total_pages
    assert result["sourceFilesystemIdentityBefore"] == expected_source_identity
    assert result["sourceFilesystemIdentityAfter"] == expected_source_identity
    assert result["controller"] == {
        "sha256": hashlib.sha256(controller.read_bytes()).hexdigest(),
        "filesystemIdentity": {
            "device": str(controller_metadata.st_dev),
            "inode": str(controller_metadata.st_ino),
            "sizeBytes": controller_metadata.st_size,
            "mtimeNs": str(controller_metadata.st_mtime_ns),
        },
    }
    assert result["pythonExecutable"]["implementation"] == "CPython"
    assert result["pythonExecutable"]["version"] == source_cache_control.platform.python_version()
    assert len(result["pythonExecutable"]["sha256"]) == 64
    assert result["pythonExecutable"]["filesystemIdentity"]["sizeBytes"] > 0
    assert result["verified"] is True


def test_study_v2_rejects_controller_drift_after_cache_preparation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "trial-copy.csv"
    source.write_bytes(b"c00\n0\n")
    controller_receipts = iter(
        [
            {"sha256": "a" * 64, "filesystemIdentity": {"device": "1", "inode": "2", "sizeBytes": 3, "mtimeNs": "4"}},
            {"sha256": "b" * 64, "filesystemIdentity": {"device": "1", "inode": "2", "sizeBytes": 3, "mtimeNs": "4"}},
        ]
    )
    interpreter = {
        "implementation": "CPython",
        "version": "3.12.13",
        "sha256": "c" * 64,
        "filesystemIdentity": {"device": "5", "inode": "6", "sizeBytes": 7, "mtimeNs": "8"},
    }
    total_pages = (source.stat().st_size + mmap.PAGESIZE - 1) // mmap.PAGESIZE
    resident_counts = iter([0, total_pages])

    monkeypatch.setattr(source_cache_control, "_linux_cache_proof_available", lambda: True)
    monkeypatch.setattr(
        source_cache_control, "_controller_descriptor_receipt", lambda _descriptor: next(controller_receipts)
    )
    monkeypatch.setattr(source_cache_control, "_running_interpreter_receipt", lambda _descriptor: interpreter)
    monkeypatch.setattr(source_cache_control, "_sync_file_data", lambda _descriptor: None)
    monkeypatch.setattr(source_cache_control, "_resident_page_count", lambda *_arguments: next(resident_counts))

    source_descriptor = os.open(source, os.O_RDONLY)
    try:
        with pytest.raises(ValueError, match="controller changed"):
            prepare_study_v2_source_cache(source_descriptor, "warm", 3, 4)
    finally:
        os.close(source_descriptor)


def test_study_v2_rejects_a_descriptor_that_is_not_the_running_controller(tmp_path: Path) -> None:
    source = tmp_path / "trial-copy.csv"
    source.write_bytes(b"c00\n0\n")
    decoy = tmp_path / "source_cache_control.py"
    decoy.write_text("raise SystemExit(1)\n", encoding="utf-8")
    descriptor = os.open(decoy, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    python_descriptor = os.open("/proc/self/exe", os.O_RDONLY)
    source_descriptor = os.open(source, os.O_RDONLY)
    try:
        with pytest.raises(ValueError, match="does not match the running controller"):
            prepare_study_v2_source_cache(source_descriptor, "warm", descriptor, python_descriptor)
    finally:
        os.close(source_descriptor)
        os.close(python_descriptor)
        os.close(descriptor)


def test_study_v2_cli_is_path_free_and_v1_remains_the_default(tmp_path: Path) -> None:
    if sys.platform != "linux":
        pytest.skip("The study-v2 contract is intentionally Linux-only.")
    source = tmp_path / "private-trial-copy.csv"
    source.write_bytes(b"c00,c01\n0,1\n1,2\n")
    script = Path(__file__).parents[1] / "benchmarks" / "source_cache_control.py"

    v1 = subprocess.run(
        [sys.executable, str(script), "--source", str(source), "--mode", "warm"],
        check=True,
        capture_output=True,
        text=True,
    )
    v1_result = json.loads(v1.stdout)
    assert v1_result["protocol"] == "openwrangler-source-cache-proof-v1"
    assert "sourceFilesystemIdentityBefore" not in v1_result
    assert "controller" not in v1_result
    assert "pythonExecutable" not in v1_result

    controller_descriptor = os.open(script, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    python_descriptor = os.open("/proc/self/exe", os.O_RDONLY)
    source_descriptor = os.open(source, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        v2 = subprocess.run(
            [
                f"/proc/self/fd/{python_descriptor}",
                f"/proc/self/fd/{controller_descriptor}",
                "--source-fd",
                str(source_descriptor),
                "--mode",
                "warm",
                "--contract",
                "study-v2",
                "--controller-fd",
                str(controller_descriptor),
                "--python-fd",
                str(python_descriptor),
            ],
            check=True,
            capture_output=True,
            text=True,
            pass_fds=(controller_descriptor, python_descriptor, source_descriptor),
        )
    finally:
        os.close(source_descriptor)
        os.close(python_descriptor)
        os.close(controller_descriptor)
    v2_result = json.loads(v2.stdout)
    assert v2_result["protocol"] == "openwrangler-source-cache-proof-study-v2"
    assert v2_result["sourceFilesystemIdentityBefore"] == v2_result["sourceFilesystemIdentityAfter"]
    assert v2_result["controller"]["sha256"] == hashlib.sha256(script.read_bytes()).hexdigest()
    assert len(v2_result["pythonExecutable"]["sha256"]) == 64
    assert str(source) not in v2.stdout
    assert str(script) not in v2.stdout
