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
DEFAULT_ROWS, DEFAULT_COLUMNS, DEFAULT_ROW_GROUP_ROWS, DEFAULT_SEED = 1_000_000, 100, 100_000, 17_031
MIN_AVAILABLE_MEMORY_BYTES = 12 * 1024**3
MIN_GENERATION_FREE_DISK_BYTES = 6 * 1024**3
MIN_STUDY_FREE_DISK_BYTES = 4 * 1024**3
MIN_REALIZED_FIXTURE_BYTES = 400 * 1024**2
MAX_REALIZED_FIXTURE_BYTES = 640 * 1024**2
NUMERIC_MIN, NUMERIC_MAX = -900_000_000, 900_000_000
DATETIME_MIN_NS, DATETIME_MAX_NS = 946_684_800_000_000_000, 4_102_358_400_000_000_000
DATE_MIN_DAYS, DATE_MAX_DAYS = 10_957, 47_481
DURATION_MIN_MS, DURATION_MAX_MS, DURATION_TOP_VALUE_MS = -86_400_000, 31_536_000_000, 172_800_000
COLUMN_FAMILIES = (
    (
        36,
        "floating-point",
        pa.float64(),
        (
            "net_revenue_usd",
            "gross_margin_usd",
            "unit_price_usd",
            "discount_rate",
            "forecast_amount_usd",
            "tax_amount_usd",
        ),
    ),
    (
        66,
        "integer",
        pa.int64(),
        ("order_quantity", "active_users", "invoice_count", "inventory_units", "event_count", "days_overdue"),
    ),
    (
        74,
        "categorical text",
        pa.string(),
        (
            "customer_segment",
            "sales_region",
            "order_channel",
            "product_family",
            "billing_country",
            "account_tier",
            "risk_band",
            "renewal_status",
        ),
    ),
    (
        80,
        "high-cardinality text",
        pa.string(),
        (
            "account_display_name",
            "event_description",
            "product_description",
            "shipping_address",
            "support_case_subject",
            "external_reference",
        ),
    ),
    (83, "timestamp", pa.timestamp("ns"), ("order_created_at", "account_updated_at", "event_received_at")),
    (
        86,
        "timestamp",
        pa.timestamp("ns", tz="UTC"),
        ("invoice_posted_at_utc", "shipment_sent_at_utc", "renewal_scored_at_utc"),
    ),
    (89, "date", pa.date32(), ("invoice_due_date", "contract_start_date", "renewal_date")),
    (92, "duration", pa.duration("ms"), ("session_duration_ms", "fulfillment_duration_ms", "response_duration_ms")),
    (
        100,
        "boolean",
        pa.bool_(),
        (
            "is_active",
            "is_priority",
            "is_overdue",
            "has_discount",
            "is_renewal",
            "is_enterprise",
            "is_test_account",
            "is_billable",
        ),
    ),
)


@dataclass(frozen=True, slots=True)
class LargeFixtureSpec:
    rows: int = DEFAULT_ROWS
    row_group_rows: int = DEFAULT_ROW_GROUP_ROWS
    seed: int = DEFAULT_SEED

    def validate(self) -> None:
        if not 1 <= self.rows <= DEFAULT_ROWS:
            raise ValueError("The mixed Parquet fixture must contain between 1 and 1,000,000 rows.")
        if not 1 <= self.row_group_rows <= self.rows:
            raise ValueError("The row-group size must be between one and the fixture row count.")
        if not 0 <= self.seed <= 2**32 - 1:
            raise ValueError("The fixture seed must fit in an unsigned 32-bit integer.")


def available_memory_bytes() -> int:
    for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) == 3 and parts[0] == "MemAvailable:" and parts[1].isdigit():
            return int(parts[1]) * 1024
    raise RuntimeError("Linux did not report available memory for the large comparison fixture.")


def assert_large_study_capacity(output: Path, *, generating: bool = False) -> dict[str, int]:
    parent = output.parent.resolve()
    if not parent.is_dir() or parent.is_symlink():
        raise RuntimeError("Create a real output directory before generating the large fixture.")
    memory, disk = available_memory_bytes(), disk_usage(parent).free
    if memory < MIN_AVAILABLE_MEMORY_BYTES:
        raise RuntimeError("The large comparison needs at least 12 GiB of available memory.")
    required_disk = MIN_GENERATION_FREE_DISK_BYTES if generating else MIN_STUDY_FREE_DISK_BYTES
    if disk < required_disk:
        required_gib = required_disk // 1024**3
        stage = "before generating its fixture" if generating else "before starting a run"
        raise RuntimeError(f"The large comparison needs at least {required_gib} GiB free {stage}.")
    return {"availableMemoryBytes": memory, "freeDiskBytes": disk}


def _column_definition(index: int) -> tuple[str, str, pa.DataType]:
    start = 0
    for end, role, data_type, names in COLUMN_FAMILIES:
        if index < end:
            offset = index - start
            cycle, name_index = divmod(offset, len(names))
            base = names[name_index]
            return (base if cycle == 0 else f"{base}_{cycle + 1:02d}", role, data_type)
        start = end
    raise IndexError(index)


def column_contract() -> list[dict[str, Any]]:
    return [
        {"name": name, "role": role, "arrowType": str(data_type)}
        for index in range(DEFAULT_COLUMNS)
        for name, role, data_type in [_column_definition(index)]
    ]


def fixture_schema() -> pa.Schema:
    return pa.schema(
        [pa.field(name, data_type, nullable=True) for name, _, data_type in map(_column_definition, range(100))]
    )


def dictionary_columns() -> list[str]:
    return [column["name"] for column in column_contract() if column["role"] == "categorical text"]


def _marker_rows(column: int) -> tuple[int, int]:
    period, rows, candidate = 29 + column % 53, [], 101 + column * 3
    while len(rows) < 2:
        if (candidate + column * 11) % period:
            rows.append(candidate)
        candidate += 1
    return rows[0], rows[1]


def build_row_group(start: int, count: int, spec: LargeFixtureSpec) -> pa.Table:
    rows = np.arange(start, start + count, dtype=np.int64)
    rng = np.random.default_rng(spec.seed + start)
    arrays: list[pa.Array] = []
    categories = np.array(["enterprise", "mid-market", "public-sector", "consumer", "partner"], dtype=object)
    for column, field in enumerate(fixture_schema()):
        mask = (rows + column * 11) % (29 + column % 53) == 0
        minimum_row, maximum_row = _marker_rows(column)
        if column < 36:
            values = rng.normal(0, (column + 1) * 250, count)
            values[rows == minimum_row], values[rows == maximum_row] = NUMERIC_MIN, NUMERIC_MAX
        elif column < 66:
            values = rng.integers(-500_000_000, 500_000_000, count, dtype=np.int64)
            values[rows == minimum_row], values[rows == maximum_row] = NUMERIC_MIN, NUMERIC_MAX
        elif column < 74:
            positions = ((rows + column) % len(categories)).astype(np.int64)
            positions[(rows + column) % 3 == 0] = 0
            values = categories[positions].tolist()
        elif column < 80:
            random_values = rng.integers(0, np.iinfo(np.uint64).max, count, dtype=np.uint64)
            values = [f"record-{column:02d}-{int(value):016x}" for value in random_values]
            for position in np.flatnonzero((rows + column) % 97 == 0):
                values[int(position)] = f"popular-{field.name}"
        elif column < 86:
            values = 1_672_531_200_000_000_000 + rows * (column - 79) * 1_000_000_000
            values[rows == minimum_row], values[rows == maximum_row] = DATETIME_MIN_NS, DATETIME_MAX_NS
        elif column < 89:
            values = (18_000 + rows % 3_650).astype(np.int32)
            values[rows == minimum_row], values[rows == maximum_row] = DATE_MIN_DAYS, DATE_MAX_DAYS
        elif column < 92:
            values = rng.integers(0, DURATION_MAX_MS, count, dtype=np.int64)
            values[(rows + column) % 7 == 0] = DURATION_TOP_VALUE_MS
            values[rows == minimum_row], values[rows == maximum_row] = DURATION_MIN_MS, DURATION_MAX_MS
        else:
            values = rng.integers(0, 2, count, dtype=np.int8).astype(np.bool_)
        arrays.append(pa.array(values, type=field.type, mask=mask))
    return pa.Table.from_arrays(arrays, schema=fixture_schema())


def assert_realized_fixture_size(size_bytes: int, spec: LargeFixtureSpec) -> None:
    if spec.rows == DEFAULT_ROWS and size_bytes < MIN_REALIZED_FIXTURE_BYTES:
        raise AssertionError("The full large-comparison fixture must be at least 400 MiB after compression.")
    if size_bytes > MAX_REALIZED_FIXTURE_BYTES:
        raise AssertionError("The large-comparison fixture must not exceed 640 MiB after compression.")


def validate_fixture(path: Path, spec: LargeFixtureSpec) -> None:
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise AssertionError("The fixture must be a regular file.")
    assert_realized_fixture_size(metadata.st_size, spec)
    parquet = pq.ParquetFile(path)
    expected_groups = (spec.rows + spec.row_group_rows - 1) // spec.row_group_rows
    if (parquet.metadata.num_rows, parquet.metadata.num_columns, parquet.metadata.num_row_groups) != (
        spec.rows,
        DEFAULT_COLUMNS,
        expected_groups,
    ) or parquet.schema_arrow != fixture_schema():
        raise AssertionError("The fixture shape, groups, or schema are wrong.")


def _sha256(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def fixture_manifest(path: Path, spec: LargeFixtureSpec) -> dict[str, Any]:
    return {
        "protocol": FIXTURE_PROTOCOL,
        "rows": spec.rows,
        "columns": DEFAULT_COLUMNS,
        "rowGroupRows": spec.row_group_rows,
        "seed": spec.seed,
        "compression": {"codec": "zstd", "level": 3, "dictionaryColumns": dictionary_columns()},
        "schema": column_contract(),
        "profileSentinels": {
            "numericExtrema": [NUMERIC_MIN, NUMERIC_MAX],
            "categoricalTopValue": "enterprise",
            "highCardinalityTopValueTemplate": "popular-{column}",
            "datetimeExtrema": ["2000-01-01", "2099-12-31"],
            "durationExtremaMs": [DURATION_MIN_MS, DURATION_MAX_MS],
            "durationTopValueMs": DURATION_TOP_VALUE_MS,
            "booleanValues": ["True", "False"],
        },
        "bytes": path.stat().st_size,
        "sha256": _sha256(path),
    }


def generate_fixture(
    output: Path, spec: LargeFixtureSpec | None = None, *, check_capacity: bool = True
) -> dict[str, Any]:
    spec = spec or LargeFixtureSpec()
    spec.validate()
    output = output.resolve()
    manifest_path = output.with_suffix(f"{output.suffix}.json")
    if output.suffix.lower() != ".parquet":
        raise ValueError("The large comparison fixture must use a .parquet file name.")
    if output.exists() or output.is_symlink() or manifest_path.exists() or manifest_path.is_symlink():
        raise FileExistsError(f"Refusing to replace existing fixture {output.name}.")
    if check_capacity:
        assert_large_study_capacity(output, generating=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{output.name}.", suffix=".tmp", dir=output.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with pq.ParquetWriter(
            temporary,
            fixture_schema(),
            compression="zstd",
            compression_level=3,
            use_dictionary=dictionary_columns(),  # pyright: ignore[reportArgumentType]
        ) as writer:
            for start in range(0, spec.rows, spec.row_group_rows):
                writer.write_table(build_row_group(start, min(spec.row_group_rows, spec.rows - start), spec))
        if check_capacity and disk_usage(output.parent).free < MIN_STUDY_FREE_DISK_BYTES:
            raise RuntimeError("The generated fixture would leave less than 4 GiB free for the comparison runs.")
        validate_fixture(temporary, spec)
        os.replace(temporary, output)
        os.chmod(output, stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
        manifest = fixture_manifest(output, spec)
        with manifest_path.open("x", encoding="utf-8") as destination:
            json.dump(manifest, destination, indent=2, sort_keys=True)
            destination.write("\n")
        return manifest
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate the opt-in 1M x 100 mixed Parquet fixture.")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--confirm-large-study", action="store_true")
    arguments = parser.parse_args()
    if not arguments.confirm_large_study:
        raise SystemExit("Pass --confirm-large-study to generate the 1M x 100 fixture.")
    print(json.dumps({"path": str(arguments.out.resolve()), "manifest": generate_fixture(arguments.out)}))


if __name__ == "__main__":
    main()
