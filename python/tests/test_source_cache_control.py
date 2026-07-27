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
    prepare_source_cache = cast(Any, import_module("source_cache_control").prepare_source_cache)
finally:
    sys.path.remove(str(benchmark_directory))


def test_warm_source_cache_reads_the_complete_owned_file(tmp_path: Path) -> None:
    source = tmp_path / "fixture.csv"
    source.write_bytes((b"open-wrangler\n" * 100_000) + b"complete")

    assert prepare_source_cache(source, "warm") == {
        "supported": True,
        "applied": True,
        "method": "complete sequential read through an owned descriptor",
    }


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


def test_cold_source_cache_reports_the_linux_fadvise_capability(tmp_path: Path) -> None:
    source = tmp_path / "fixture.parquet"
    source.write_bytes(b"deterministic")

    result = prepare_source_cache(source, "cold")

    expected = sys.platform == "linux" and hasattr(os, "posix_fadvise") and hasattr(os, "POSIX_FADV_DONTNEED")
    assert result["supported"] is expected
    assert result["applied"] is expected
    assert "DONTNEED" in result["method"]


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

    assert json.loads(completed.stdout) == {
        "supported": True,
        "applied": True,
        "method": "complete sequential read through an owned descriptor",
    }
    assert str(source) not in completed.stdout
    assert stat.S_ISREG(source.stat().st_mode)
