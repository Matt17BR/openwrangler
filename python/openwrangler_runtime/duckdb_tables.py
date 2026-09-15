from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

MAX_DATABASE_TABLES = 4_096
MAX_DATABASE_NAME_CHARACTERS = 1_024
MAX_DATABASE_NAME_BYTES = 65_536
MAX_DATABASE_DISCOVERY_BYTES = 256 * 1_024


def validate_database_name(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > MAX_DATABASE_NAME_CHARACTERS or "\0" in value:
        raise ValueError("DuckDB returned an invalid schema or table name.")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError("DuckDB returned an invalid schema or table name.") from error
    return value


def validated_database_tables(rows: list[tuple[Any, ...]]) -> list[dict[str, str]]:
    if len(rows) > MAX_DATABASE_TABLES:
        raise ValueError("The DuckDB database contains too many tables to list.")
    tables: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    total_bytes = 0
    for row in rows:
        if len(row) != 2:
            raise ValueError("DuckDB returned invalid table metadata.")
        schema, name = (validate_database_name(value) for value in row)
        total_bytes += len(schema.encode("utf-8")) + len(name.encode("utf-8"))
        if total_bytes > MAX_DATABASE_NAME_BYTES:
            raise ValueError("The DuckDB database returned too much table-name data.")
        if (schema, name) in seen:
            raise ValueError("The DuckDB database returned duplicate table names.")
        seen.add((schema, name))
        tables.append({"schema": schema, "name": name})
    if (
        len(json.dumps(tables, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) + 1
        > MAX_DATABASE_DISCOVERY_BYTES
    ):
        raise ValueError("The DuckDB table list is too large to return.")
    return tables


def list_duckdb_tables(source: str | Path) -> list[dict[str, str]]:
    from .engines.duckdb_engine import DuckDBEngine

    engine = DuckDBEngine()
    try:
        return engine.list_database_tables(str(source))
    finally:
        engine.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    arguments = parser.parse_args()
    try:
        tables = list_duckdb_tables(arguments.source)
    except Exception as error:
        # The host owns presentation. Never put a partial catalog on stdout.
        print(str(error)[:2_048], file=sys.stderr)
        raise SystemExit(1) from None
    print(json.dumps(tables, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
