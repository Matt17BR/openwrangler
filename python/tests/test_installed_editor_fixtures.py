from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import TypedDict, cast


class _FixtureEvidence(TypedDict):
    fileName: str
    rows: int
    columns: int
    bytes: int
    sha256: str


class _GeneratorEvidence(TypedDict):
    contractVersion: int
    implementation: str
    implementationVersion: str


class _FixtureManifest(TypedDict):
    protocol: str
    smoke: bool
    generator: _GeneratorEvidence
    license: str
    fixtures: dict[str, _FixtureEvidence]


def test_installed_editor_fixture_manifest_is_deterministic_and_path_free(tmp_path: Path) -> None:
    first = _generate(tmp_path / "first")
    second = _generate(tmp_path / "second")

    assert first == second
    assert first["protocol"] == "openwrangler-installed-performance-fixtures-v1"
    assert first["smoke"] is True
    assert first["generator"]["contractVersion"] == 1
    assert first["generator"]["implementation"] == "polars"
    assert first["generator"]["implementationVersion"]
    assert first["license"] == "CC0-1.0"
    assert set(first["fixtures"]) == {"csv", "parquet"}
    assert first["fixtures"]["csv"]["rows"] == 2_000
    assert first["fixtures"]["csv"]["columns"] == 8
    assert first["fixtures"]["parquet"]["rows"] == 5_000
    assert first["fixtures"]["parquet"]["columns"] == 8
    serialized = json.dumps(first, sort_keys=True)
    assert str(tmp_path) not in serialized
    assert "c00" not in serialized

    for directory_name in ("first", "second"):
        directory = tmp_path / directory_name / "fixtures"
        for evidence in first["fixtures"].values():
            source = directory / evidence["fileName"]
            assert source.is_file()
            assert source.stat().st_size == evidence["bytes"]
            assert hashlib.sha256(source.read_bytes()).hexdigest() == evidence["sha256"]


def test_installed_editor_fixture_generation_rejects_a_symlink_target(tmp_path: Path) -> None:
    root = tmp_path / "fixtures"
    root.mkdir()
    outside = tmp_path / "outside.csv"
    outside.write_text("do-not-overwrite\n", encoding="utf-8")
    (root / "2000-8.csv").symlink_to(outside)
    manifest = tmp_path / "manifest.json"

    result = subprocess.run(
        [
            sys.executable,
            str(_fixture_script()),
            "--smoke",
            "--output-dir",
            str(root),
            "--manifest-out",
            str(manifest),
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert result.returncode != 0
    assert "single-link regular file" in result.stderr
    assert outside.read_text(encoding="utf-8") == "do-not-overwrite\n"
    assert not manifest.exists()


def _generate(root: Path) -> _FixtureManifest:
    fixture_directory = root / "fixtures"
    manifest = root / "manifest.json"
    result = subprocess.run(
        [
            sys.executable,
            str(_fixture_script()),
            "--smoke",
            "--output-dir",
            str(fixture_directory),
            "--manifest-out",
            str(manifest),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    payload = cast(_FixtureManifest, json.loads(result.stdout))
    assert json.loads(manifest.read_text(encoding="utf-8")) == payload
    return payload


def _fixture_script() -> Path:
    return Path(__file__).parents[1] / "benchmarks" / "installed_editor_fixtures.py"
