from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path
from shutil import disk_usage
from typing import Any

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

FIXTURE_PROTOCOL = "openwrangler-large-parquet-fixture-v1"
DEFAULT_ROWS = 10_000_000
DEFAULT_COLUMNS = 100
DEFAULT_ROW_GROUP_ROWS = 100_000
DEFAULT_SEED = 17_031
MIN_AVAILABLE_MEMORY_BYTES = 40 * 1024**3
MIN_FREE_DISK_BYTES = 15 * 1024**3
NUMERIC_SENTINEL_MIN = -900_000_000
NUMERIC_SENTINEL_MAX = 900_000_000
TIMESTAMP_SENTINEL_MIN_NS = 946_684_800_000_000_000
TIMESTAMP_SENTINEL_MAX_NS = 4_102_358_400_000_000_000
DATE_SENTINEL_MIN_DAYS = 10_957
DATE_SENTINEL_MAX_DAYS = 47_481
DURATION_SENTINEL_MIN_MS = -86_400_000
DURATION_SENTINEL_MAX_MS = 31_536_000_000


@dataclass(frozen=True, slots=True)
class LargeFixtureSpec:
    rows: int = DEFAULT_ROWS
    columns: int = DEFAULT_COLUMNS
    row_group_rows: int = DEFAULT_ROW_GROUP_ROWS
    seed: int = DEFAULT_SEED

    def validate(self) -> None:
        if self.rows < 1 or self.columns != DEFAULT_COLUMNS:
            raise ValueError("The mixed Parquet fixture requires a positive row count and exactly 100 columns.")
        if self.row_group_rows < 1 or self.row_group_rows > self.rows:
            raise ValueError("The row-group size must be between one and the fixture row count.")
        if self.seed < 0 or self.seed > 2**32 - 1:
            raise ValueError("The fixture seed must fit in an unsigned 32-bit integer.")


def available_memory_bytes() -> int:
    meminfo = Path("/proc/meminfo")
    if not meminfo.is_file():
        raise RuntimeError("The large comparison fixture currently requires Linux memory reporting.")
    for line in meminfo.read_text(encoding="utf-8").splitlines():
        if line.startswith("MemAvailable:"):
            parts = line.split()
            if len(parts) == 3 and parts[2] == "kB" and parts[1].isdigit():
                return int(parts[1]) * 1024
    raise RuntimeError("Linux did not report available memory for the large comparison fixture.")


def assert_large_study_capacity(output: Path) -> dict[str, int]:
    parent = output.parent.resolve()
    if not parent.is_dir() or parent.is_symlink():
        raise RuntimeError("Create a real output directory before generating the large fixture.")
    memory = available_memory_bytes()
    disk = disk_usage(parent).free
    if memory < MIN_AVAILABLE_MEMORY_BYTES:
        raise RuntimeError(
            f"The large comparison needs at least {MIN_AVAILABLE_MEMORY_BYTES // 1024**3} GiB of available memory; "
            f"this machine currently reports {memory / 1024**3:.1f} GiB."
        )
    if disk < MIN_FREE_DISK_BYTES:
        raise RuntimeError(
            f"The large comparison needs at least {MIN_FREE_DISK_BYTES // 1024**3} GiB of free disk space; "
            f"the output filesystem currently reports {disk / 1024**3:.1f} GiB."
        )
    return {"availableMemoryBytes": memory, "freeDiskBytes": disk}


def column_contract() -> list[dict[str, Any]]:
    columns: list[dict[str, Any]] = []
    for index in range(DEFAULT_COLUMNS):
        if index < 36:
            role, arrow_type = "floating-point", "double"
        elif index < 66:
            role, arrow_type = "integer", "int64"
        elif index < 74:
            role, arrow_type = "categorical text", "string"
        elif index < 80:
            role, arrow_type = "high-cardinality text", "string"
        elif index < 86:
            role = "timestamp"
            arrow_type = "timestamp[ns]" if index < 83 else "timestamp[ns, tz=UTC]"
        elif index < 89:
            role, arrow_type = "date", "date32[day]"
        elif index < 92:
            role, arrow_type = "duration", "duration[ms]"
        else:
            role, arrow_type = "boolean", "bool"
        columns.append({"name": f"c{index:02d}", "role": role, "arrowType": arrow_type})
    return columns


def fixture_schema() -> pa.Schema:
    fields: list[pa.Field] = []
    for column in column_contract():
        arrow_type = column["arrowType"]
        if arrow_type == "double":
            data_type = pa.float64()
        elif arrow_type == "int64":
            data_type = pa.int64()
        elif arrow_type == "string":
            data_type = pa.string()
        elif arrow_type == "timestamp[ns]":
            data_type = pa.timestamp("ns")
        elif arrow_type == "timestamp[ns, tz=UTC]":
            data_type = pa.timestamp("ns", tz="UTC")
        elif arrow_type == "date32[day]":
            data_type = pa.date32()
        elif arrow_type == "duration[ms]":
            data_type = pa.duration("ms")
        elif arrow_type == "bool":
            data_type = pa.bool_()
        else:  # pragma: no cover - the contract above is exhaustive
            raise AssertionError(f"Unsupported Arrow type {arrow_type}.")
        fields.append(pa.field(column["name"], data_type, nullable=True))
    return pa.schema(fields)


def _splitmix64(values: np.ndarray) -> np.ndarray:
    mixed = values.astype(np.uint64, copy=True)
    mixed ^= mixed >> np.uint64(30)
    mixed *= np.uint64(0xBF58476D1CE4E5B9)
    mixed ^= mixed >> np.uint64(27)
    mixed *= np.uint64(0x94D049BB133111EB)
    mixed ^= mixed >> np.uint64(31)
    return mixed


def _null_mask(row_numbers: np.ndarray, column: int) -> np.ndarray:
    period = 29 + (column % 53)
    return (row_numbers + column * 11) % period == 0


def _sentinel_rows(column: int) -> tuple[int, int]:
    candidates: list[int] = []
    row = 101 + column * 3
    period = 29 + (column % 53)
    while len(candidates) < 2:
        if (row + column * 11) % period != 0:
            candidates.append(row)
        row += 1
    return candidates[0], candidates[1]


def _set_numeric_sentinels(values: np.ndarray, rows: np.ndarray, column: int) -> None:
    minimum_row, maximum_row = _sentinel_rows(column)
    values[rows == minimum_row] = NUMERIC_SENTINEL_MIN
    values[rows == maximum_row] = NUMERIC_SENTINEL_MAX


def _string_values(prefix: str, mixed: np.ndarray, column: int) -> list[str]:
    return [f"{prefix}-{column:02d}-{int(value):016x}" for value in mixed]


def build_row_group(start: int, count: int, spec: LargeFixtureSpec) -> pa.Table:
    rows = np.arange(start, start + count, dtype=np.int64)
    unsigned_rows = rows.astype(np.uint64)
    arrays: list[pa.Array] = []
    schema = fixture_schema()
    categories = np.asarray(
        ["enterprise", "mid-market", "public-sector", "consumer", "partner", "internal", "unknown"],
        dtype=object,
    )

    for column, field in enumerate(schema):
        mask = _null_mask(rows, column)
        if column < 36:
            mixed = _splitmix64(unsigned_rows + np.uint64(spec.seed + column * 1_000_003))
            values = ((mixed >> np.uint64(11)).astype(np.float64) / float(1 << 53) - 0.5) * (column + 1) * 250
            values += np.sin((rows + column) / (17 + column)) * (column + 1)
            _set_numeric_sentinels(values, rows, column)
            arrays.append(pa.array(values, type=field.type, mask=mask))
        elif column < 66:
            mixed = _splitmix64(unsigned_rows + np.uint64(spec.seed + column * 2_000_033))
            modulus = np.uint64(10 ** (2 + column % 7))
            values = (mixed % modulus).astype(np.int64) - int(modulus // np.uint64(3))
            _set_numeric_sentinels(values, rows, column)
            arrays.append(pa.array(values, type=field.type, mask=mask))
        elif column < 74:
            positions = ((rows // (3 + column % 5) + column) % len(categories)).astype(np.int64)
            positions[(rows + column) % 5 == 0] = 0
            arrays.append(pa.array(categories[positions].tolist(), type=field.type, mask=mask))
        elif column < 80:
            mixed = _splitmix64(unsigned_rows + np.uint64(spec.seed + column * 3_000_017))
            strings = _string_values("record", mixed, column)
            for position in np.flatnonzero((rows + column) % 97 == 0):
                strings[int(position)] = f"popular-c{column:02d}"
            arrays.append(pa.array(strings, type=field.type, mask=mask))
        elif column < 86:
            base = np.int64(1_672_531_200_000_000_000)
            stride = np.int64((column - 79) * 1_000_000_000)
            values = base + rows * stride + ((rows + column) % 86_400) * np.int64(1_000_000_000)
            minimum_row, maximum_row = _sentinel_rows(column)
            values[rows == minimum_row] = TIMESTAMP_SENTINEL_MIN_NS
            values[rows == maximum_row] = TIMESTAMP_SENTINEL_MAX_NS
            arrays.append(pa.array(values, type=field.type, mask=mask))
        elif column < 89:
            values = np.int32(18_000 + column * 17) + (rows % np.int64(3_650)).astype(np.int32)
            minimum_row, maximum_row = _sentinel_rows(column)
            values[rows == minimum_row] = DATE_SENTINEL_MIN_DAYS
            values[rows == maximum_row] = DATE_SENTINEL_MAX_DAYS
            arrays.append(pa.array(values, type=field.type, mask=mask))
        elif column < 92:
            values = ((rows * (column - 87) * 137) % np.int64(31_536_000_000)).astype(np.int64)
            minimum_row, maximum_row = _sentinel_rows(column)
            values[rows == minimum_row] = DURATION_SENTINEL_MIN_MS
            values[rows == maximum_row] = DURATION_SENTINEL_MAX_MS
            arrays.append(pa.array(values, type=field.type, mask=mask))
        else:
            mixed = _splitmix64(unsigned_rows + np.uint64(spec.seed + column * 5_000_011))
            values = (mixed & np.uint64(1)).astype(np.bool_)
            arrays.append(pa.array(values, type=field.type, mask=mask))
    return pa.Table.from_arrays(arrays, schema=schema)


def generate_fixture(
    output: Path,
    spec: LargeFixtureSpec | None = None,
    *,
    check_capacity: bool = True,
) -> dict[str, Any]:
    spec = spec or LargeFixtureSpec()
    spec.validate()
    output = output.resolve()
    if output.suffix.lower() != ".parquet":
        raise ValueError("The large comparison fixture must use a .parquet file name.")
    if output.exists() or output.is_symlink():
        raise FileExistsError(f"Refusing to replace existing fixture {output.name}.")
    manifest_path = output.with_suffix(f"{output.suffix}.json")
    if manifest_path.exists() or manifest_path.is_symlink():
        raise FileExistsError(f"Refusing to replace existing fixture manifest {manifest_path.name}.")
    capacity = assert_large_study_capacity(output) if check_capacity else None
    schema = fixture_schema()
    categorical = [column["name"] for column in column_contract() if column["role"] == "categorical text"]
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{output.name}.", suffix=".tmp", dir=output.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        writer_options: dict[str, Any] = {
            "compression": "zstd",
            "compression_level": 3,
            "use_dictionary": categorical,
            "write_statistics": True,
        }
        writer = pq.ParquetWriter(temporary, schema, **writer_options)
        try:
            for start in range(0, spec.rows, spec.row_group_rows):
                count = min(spec.row_group_rows, spec.rows - start)
                writer.write_table(build_row_group(start, count, spec), row_group_size=count)
        finally:
            writer.close()
        validate_fixture(temporary, spec)
        os.replace(temporary, output)
        os.chmod(output, stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
        manifest = fixture_manifest(output, spec, capacity)
        _write_json_exclusive(manifest_path, manifest)
        return manifest
    finally:
        temporary.unlink(missing_ok=True)


def validate_fixture(path: Path, spec: LargeFixtureSpec) -> None:
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode) or metadata.st_size < 1:
        raise AssertionError("The large comparison fixture must be a non-empty regular file.")
    parquet = pq.ParquetFile(path)
    if parquet.metadata.num_rows != spec.rows or parquet.metadata.num_columns != spec.columns:
        raise AssertionError("The large comparison fixture has the wrong shape.")
    if parquet.schema_arrow != fixture_schema():
        raise AssertionError("The large comparison fixture has the wrong Arrow schema.")
    expected_groups = (spec.rows + spec.row_group_rows - 1) // spec.row_group_rows
    if parquet.metadata.num_row_groups != expected_groups:
        raise AssertionError("The large comparison fixture has the wrong row-group count.")


def fixture_manifest(path: Path, spec: LargeFixtureSpec, capacity: dict[str, int] | None) -> dict[str, Any]:
    return {
        "protocol": FIXTURE_PROTOCOL,
        "rows": spec.rows,
        "columns": spec.columns,
        "rowGroupRows": spec.row_group_rows,
        "seed": spec.seed,
        "compression": {"codec": "zstd", "level": 3, "dictionaryColumns": [f"c{i:02d}" for i in range(66, 74)]},
        "schema": column_contract(),
        "profileSentinels": {
            "numericExtrema": [NUMERIC_SENTINEL_MIN, NUMERIC_SENTINEL_MAX],
            "categoricalTopValue": "enterprise",
            "highCardinalityTopValueTemplate": "popular-c{column}",
            "datetimeExtrema": ["2000-01-01", "2099-12-31"],
            "durationExtremaMs": [DURATION_SENTINEL_MIN_MS, DURATION_SENTINEL_MAX_MS],
            "booleanValues": ["True", "False"],
        },
        "bytes": path.stat().st_size,
        "sha256": _sha256(path),
        "capacityAtStart": capacity,
        "generator": {"implementation": "PyArrow", "version": pa.__version__, "contractVersion": 1},
    }


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _write_json_exclusive(path: Path, value: dict[str, Any]) -> None:
    with path.open("x", encoding="utf-8") as destination:
        json.dump(value, destination, indent=2, sort_keys=True)
        destination.write("\n")


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate the opt-in 10M x 100 mixed Parquet comparison fixture.")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument(
        "--confirm-large-study",
        action="store_true",
        help="Confirm that this manual command may create a multi-gigabyte fixture.",
    )
    return parser.parse_args()


def main() -> None:
    arguments = parse_arguments()
    if not arguments.confirm_large_study:
        raise SystemExit("Pass --confirm-large-study to generate the 10M x 100 fixture.")
    manifest = generate_fixture(arguments.out)
    print(json.dumps({"path": str(arguments.out.resolve()), "manifest": manifest}, sort_keys=True))


if __name__ == "__main__":
    main()
