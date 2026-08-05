from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
from collections.abc import Callable
from importlib import import_module
from pathlib import Path
from typing import Any, Literal, Protocol, TypedDict, cast

import polars as pl
import pytest


class _FixtureSpec(Protocol):
    kind: Literal["csv", "parquet"]
    rows: int
    columns: int

    @property
    def names(self) -> list[str]: ...

    @property
    def sentinel_rows(self) -> tuple[int, ...]: ...


class _FixtureSpecFactory(Protocol):
    def __call__(self, kind: Literal["csv", "parquet"], rows: int, columns: int) -> _FixtureSpec: ...


benchmark_directory = Path(__file__).parents[1] / "benchmarks"
sys.path.insert(0, str(benchmark_directory))
try:
    fixture_contract = import_module("fixture_contract")
    local_mixed_parquet = import_module("local_mixed_parquet")
    FixtureSpec = cast(_FixtureSpecFactory, fixture_contract.FixtureSpec)
    assert_fixture_contract = cast(
        Callable[[Path, _FixtureSpec], None],
        fixture_contract.assert_fixture_contract,
    )
finally:
    sys.path.remove(str(benchmark_directory))


def test_local_mixed_fixture_fails_early_when_resources_are_too_small(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="available memory"):
        local_mixed_parquet.require_local_resources(
            tmp_path,
            available_memory=local_mixed_parquet.MIN_AVAILABLE_MEMORY - 1,
            free_disk=local_mixed_parquet.MIN_FREE_DISK,
        )
    with pytest.raises(RuntimeError, match="free disk"):
        local_mixed_parquet.require_local_resources(
            tmp_path,
            available_memory=local_mixed_parquet.MIN_AVAILABLE_MEMORY,
            free_disk=local_mixed_parquet.MIN_FREE_DISK - 1,
        )


def test_local_mixed_fixture_removes_an_oversized_partial(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    destination = tmp_path / "mixed.parquet"

    def write_oversized(output: Any, *, rows: int, columns: int) -> None:
        del rows, columns
        output.write(b"x" * 129)

    monkeypatch.setattr(local_mixed_parquet, "_write_mixed_parquet", write_oversized)
    with pytest.raises(RuntimeError, match="size cap"):
        local_mixed_parquet.create_local_mixed_parquet(
            destination,
            rows=10,
            columns=10,
            max_bytes=128,
            check_resources=False,
        )
    assert not destination.exists()
    assert list(tmp_path.iterdir()) == []


def test_local_mixed_fixture_validates_exact_schema_and_nulls(tmp_path: Path) -> None:
    canonical = tmp_path / "canonical.parquet"
    local_mixed_parquet.create_local_mixed_parquet(
        canonical,
        rows=1_000,
        columns=10,
        max_bytes=8 * 1024 * 1024,
        check_resources=False,
    )
    local_mixed_parquet.validate_local_mixed_parquet(
        canonical,
        rows=1_000,
        columns=10,
        max_bytes=8 * 1024 * 1024,
    )

    frame = pl.read_parquet(canonical)
    wrong_schema = tmp_path / "wrong-schema.parquet"
    frame.rename({"date_003": "renamed_date"}).write_parquet(wrong_schema)
    with pytest.raises(AssertionError, match="column names"):
        local_mixed_parquet.validate_local_mixed_parquet(
            wrong_schema,
            rows=1_000,
            columns=10,
            max_bytes=8 * 1024 * 1024,
        )

    missing_nulls = tmp_path / "missing-nulls.parquet"
    frame.with_columns(pl.col("segment_005").fill_null("Enterprise")).write_parquet(missing_nulls)
    with pytest.raises(AssertionError, match="contain no nulls"):
        local_mixed_parquet.validate_local_mixed_parquet(
            missing_nulls,
            rows=1_000,
            columns=10,
            max_bytes=8 * 1024 * 1024,
        )


class _FixtureEvidence(TypedDict):
    fileName: str
    format: Literal["csv", "parquet"]
    rows: int
    columns: int
    columnType: Literal["Int64"]
    columnNamePattern: str
    sentinelRows: list[int]
    bytes: int
    sha256: str


class _GeneratorEvidence(TypedDict):
    contractVersion: int
    implementation: Literal["polars"]
    implementationVersion: str


class _FixtureManifest(TypedDict):
    protocol: str
    smoke: bool
    generator: _GeneratorEvidence
    license: str
    redistribution: str
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
    assert first["redistribution"] == "Deterministic synthetic integer fixtures generated by Open Wrangler."
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


def test_python_smoke_manifest_passes_the_extension_host_decoder(tmp_path: Path) -> None:
    payload, generated_output = _generate_with_output(tmp_path / "host-contract")
    node = shutil.which("node")
    assert node is not None
    decoder = Path(__file__).parents[2] / "src" / "shared" / "installedPerformanceFixtureManifest.cjs"
    decoder_program = (
        "const fs = require('node:fs');"
        "const contract = require(process.argv[1]);"
        "const strictJson = require(process.argv[2]);"
        "const value = contract.decodeInstalledPerformanceFixtureManifest("
        "strictJson.parseStrictJson(fs.readFileSync(0, 'utf8'), { maxBytes: 65536 }));"
        "process.stdout.write(JSON.stringify(value));"
    )
    strict_json = Path(__file__).parents[2] / "src" / "shared" / "strictJson.cjs"
    result = subprocess.run(
        [node, "-e", decoder_program, str(decoder), str(strict_json)],
        input=generated_output,
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert cast(_FixtureManifest, json.loads(result.stdout)) == payload


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


@pytest.mark.parametrize("kind", ["csv", "parquet"])
def test_fixture_contract_rejects_an_interior_value_tamper(tmp_path: Path, kind: Literal["csv", "parquet"]) -> None:
    spec = FixtureSpec(kind, rows=101, columns=4)
    interior_row = 37
    assert interior_row not in spec.sentinel_rows
    frame = pl.DataFrame(
        {name: pl.int_range(column, spec.rows + column, eager=True) for column, name in enumerate(spec.names)}
    ).with_row_index("row")
    frame = frame.with_columns(
        pl.when(pl.col("row") == interior_row).then(pl.lit(-1)).otherwise(pl.col("c02")).alias("c02")
    ).drop("row")
    path = tmp_path / f"tampered.{kind}"
    if kind == "csv":
        frame.write_csv(path)
    else:
        frame.write_parquet(path)

    with pytest.raises(AssertionError, match="invalid value counts by column"):
        assert_fixture_contract(path, spec)


def test_semantically_equal_csv_with_different_newlines_has_different_bytes(tmp_path: Path) -> None:
    spec = FixtureSpec("csv", rows=101, columns=4)
    frame = pl.DataFrame(
        {name: pl.int_range(column, spec.rows + column, eager=True) for column, name in enumerate(spec.names)}
    )
    canonical = tmp_path / "canonical.csv"
    alternate = tmp_path / "alternate.csv"
    frame.write_csv(canonical)
    alternate.write_bytes(canonical.read_bytes().replace(b"\n", b"\r\n"))

    assert_fixture_contract(canonical, spec)
    assert_fixture_contract(alternate, spec)
    assert hashlib.sha256(canonical.read_bytes()).digest() != hashlib.sha256(alternate.read_bytes()).digest()


def test_semantically_equal_parquet_layout_has_different_bytes(tmp_path: Path) -> None:
    spec = FixtureSpec("parquet", rows=101, columns=4)
    frame = pl.DataFrame(
        {name: pl.int_range(column, spec.rows + column, eager=True) for column, name in enumerate(spec.names)}
    )
    canonical = tmp_path / "canonical.parquet"
    alternate = tmp_path / "alternate.parquet"
    frame.write_parquet(canonical)
    frame.write_parquet(alternate, compression="uncompressed", row_group_size=17)

    assert_fixture_contract(canonical, spec)
    assert_fixture_contract(alternate, spec)
    assert hashlib.sha256(canonical.read_bytes()).digest() != hashlib.sha256(alternate.read_bytes()).digest()


def _generate(root: Path) -> _FixtureManifest:
    payload, _ = _generate_with_output(root)
    return payload


def _generate_with_output(root: Path) -> tuple[_FixtureManifest, str]:
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
    return payload, result.stdout


def _fixture_script() -> Path:
    return Path(__file__).parents[1] / "benchmarks" / "installed_editor_fixtures.py"
