from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import tempfile
from pathlib import Path

LOCAL_ROWS = 1_000_000
LOCAL_COLUMNS = 100
LOCAL_MAX_BYTES = 640 * 1024 * 1024
MIN_AVAILABLE_MEMORY = 4 * 1024 * 1024 * 1024
MIN_FREE_DISK = LOCAL_MAX_BYTES + 256 * 1024 * 1024


def require_local_resources(
    directory: Path,
    *,
    available_memory: int | None = None,
    free_disk: int | None = None,
) -> None:
    memory = _available_memory() if available_memory is None else available_memory
    disk = shutil.disk_usage(directory).free if free_disk is None else free_disk
    if memory < MIN_AVAILABLE_MEMORY:
        raise RuntimeError("The local comparison requires at least 4 GiB of available memory.")
    if disk < MIN_FREE_DISK:
        raise RuntimeError("The local comparison requires at least 896 MiB of free disk space.")


def create_local_mixed_parquet(
    destination: Path,
    *,
    rows: int = LOCAL_ROWS,
    columns: int = LOCAL_COLUMNS,
    max_bytes: int = LOCAL_MAX_BYTES,
    check_resources: bool = True,
) -> dict[str, object]:
    if rows < 1 or columns < 10 or max_bytes < 1:
        raise ValueError("Rows, columns, and the output cap must be positive; at least ten columns are required.")
    destination = destination.resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    _assert_directory(destination.parent)
    if destination.exists() or destination.is_symlink():
        raise FileExistsError(f"Refusing to replace {destination.name}.")
    if check_resources:
        require_local_resources(destination.parent)

    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        _write_mixed_parquet(temporary, rows=rows, columns=columns)
        size = temporary.stat().st_size
        if size > max_bytes:
            raise RuntimeError(
                f"Generated fixture is {size / (1024 * 1024):.1f} MiB; the local cap is "
                f"{max_bytes / (1024 * 1024):.1f} MiB."
            )
        evidence = validate_local_mixed_parquet(temporary, rows=rows, columns=columns, max_bytes=max_bytes)
        os.replace(temporary, destination)
        _assert_regular_file(destination)
        return evidence
    finally:
        temporary.unlink(missing_ok=True)


def validate_local_mixed_parquet(
    path: Path,
    *,
    rows: int = LOCAL_ROWS,
    columns: int = LOCAL_COLUMNS,
    max_bytes: int = LOCAL_MAX_BYTES,
) -> dict[str, object]:
    import polars as pl

    _assert_regular_file(path)
    size = path.stat().st_size
    if size > max_bytes:
        raise AssertionError("The mixed Parquet fixture exceeds the local size cap.")
    frame = pl.scan_parquet(path)
    schema = frame.collect_schema()
    if len(schema) != columns or len(set(schema.names())) != columns:
        raise AssertionError(f"Expected {columns} unique columns, found {len(schema)}.")
    row_count = int(frame.select(pl.len()).collect(engine="streaming").item())
    if row_count != rows:
        raise AssertionError(f"Expected {rows} rows, found {row_count}.")
    type_names = {str(dtype) for dtype in schema.dtypes()}
    required = {
        "numeric": any(name.startswith(("Int", "UInt", "Float")) for name in type_names),
        "boolean": "Boolean" in type_names,
        "text": "String" in type_names,
        "temporal": any(name.startswith(("Date", "Datetime")) for name in type_names),
    }
    if not all(required.values()):
        missing = ", ".join(name for name, present in required.items() if not present)
        raise AssertionError(f"Mixed fixture is missing column families: {missing}.")
    return {"rows": rows, "columns": columns, "valuesValidated": True, "bytes": size}


def _write_mixed_parquet(path: Path, *, rows: int, columns: int) -> None:
    import polars as pl

    row = pl.col("__row")
    expressions: list[pl.Expr] = []
    for column in range(columns):
        random_number = (row * (1_103_515_245 + column * 2_003) + 12_345 + column) % 2_147_483_647
        mode = column % 10
        if mode == 0:
            value = random_number.cast(pl.Int64)
            prefix = "integer"
        elif mode == 1:
            value = (random_number.cast(pl.Float64) / (97 + column)).round(5)
            prefix = "decimal"
        elif mode == 2:
            value = (random_number % 2).eq(0)
            prefix = "flag"
        elif mode == 3:
            value = ((random_number % 20_000) + 18_262).cast(pl.Date)
            prefix = "date"
        elif mode == 4:
            value = ((random_number % 1_000_000_000) + 1_577_836_800_000).cast(pl.Datetime("ms"))
            prefix = "timestamp"
        elif mode == 5:
            value = (
                pl.when((random_number % 5) == 0)
                .then(pl.lit("Enterprise"))
                .when((random_number % 5) == 1)
                .then(pl.lit("Mid-market"))
                .when((random_number % 5) == 2)
                .then(pl.lit("Public sector"))
                .when((random_number % 5) == 3)
                .then(pl.lit("Small business"))
                .otherwise(pl.lit("Consumer"))
            )
            prefix = "segment"
        elif mode == 6:
            value = pl.concat_str([pl.lit("account-"), random_number.cast(pl.String), pl.lit("-"), row.cast(pl.String)])
            prefix = "account"
        elif mode == 7:
            value = (random_number % 10_000).cast(pl.Int32)
            prefix = "quantity"
        elif mode == 8:
            value = ((random_number % 100_000).cast(pl.Float64) / 100).round(2)
            prefix = "amount"
        else:
            value = pl.concat_str([pl.lit("note-"), random_number.cast(pl.String)])
            prefix = "note"
        if mode in {1, 3, 4, 5, 6, 8, 9}:
            value = pl.when((row + column) % 37 == 0).then(pl.lit(None)).otherwise(value)
        expressions.append(value.alias(f"{prefix}_{column:03d}"))

    (
        pl.LazyFrame()
        .select(pl.int_range(0, rows, dtype=pl.Int64).alias("__row"))
        .select(expressions)
        .sink_parquet(path, compression="zstd", compression_level=3, row_group_size=50_000)
    )


def _available_memory() -> int:
    try:
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        pass
    page_size = os.sysconf("SC_PAGE_SIZE")
    available_pages = os.sysconf("SC_AVPHYS_PAGES")
    return int(page_size) * int(available_pages)


def _assert_directory(path: Path) -> None:
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise AssertionError("The local fixture directory must be a real directory.")


def _assert_regular_file(path: Path) -> None:
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise AssertionError("The local fixture must be a single-link regular file.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Create the capped mixed-data Parquet fixture for a local comparison.")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    evidence = create_local_mixed_parquet(args.out)
    print(json.dumps(evidence, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()
