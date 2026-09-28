"""Shared rules for Look up columns: one lookup file, typed keys and appended columns.

``check_lookup_columns`` and ``lookup_duplicate_message`` are also copied into generated code, so they use only
builtins.
"""

from __future__ import annotations

import ntpath
import os
from collections import OrderedDict
from collections.abc import Callable, Hashable, Mapping
from threading import Lock
from typing import Any

from .pivot_longer import (
    PivotLongerContractError,
    portable_pivot_longer_name_key,
    validate_pivot_longer_output_name,
)

LOOKUP_FORMAT_EXTENSIONS: dict[str, tuple[str, ...]] = {
    "csv": (".csv",),
    "tsv": (".tsv",),
    "parquet": (".parquet",),
    "jsonl": (".jsonl", ".ndjson"),
}
LOOKUP_KEY_TYPES = frozenset({"string", "integer", "boolean", "date"})
MAX_LOOKUP_KEYS = 8
MAX_LOOKUP_OUTPUTS = 64
MAX_LOOKUP_PATH_CHARACTERS = 4096
MAX_LOOKUP_DESCRIBED_COLUMNS = 2048


class LookupContractError(ValueError):
    """A lookupColumns step or lookup file outside the supported domain."""


class LookupFileCache:
    """Reuse what a session read from a lookup file while the file keeps its identity, size and timestamps."""

    def __init__(self, limit: int = 2) -> None:
        self._limit = limit
        self._entries: OrderedDict[Hashable, tuple[tuple[int, ...], Any]] = OrderedDict()
        self._lock = Lock()

    def get(self, path: str, key: Hashable, read: Callable[[], Any]) -> Any:
        before = _file_version(path)
        with self._lock:
            entry = self._entries.get(key)
            if entry is not None and before is not None and entry[0] == before:
                self._entries.move_to_end(key)
                return entry[1]
        value = read()
        if before is not None and _file_version(path) == before:
            with self._lock:
                self._entries[key] = (before, value)
                self._entries.move_to_end(key)
                while len(self._entries) > self._limit:
                    self._entries.popitem(last=False)
        return value

    def clear(self) -> list[Any]:
        with self._lock:
            values = [value for _, value in self._entries.values()]
            self._entries.clear()
        return values


def _file_version(path: str) -> tuple[int, ...] | None:
    try:
        status = os.stat(path)
    except OSError:
        return None
    return (status.st_dev, status.st_ino, status.st_size, status.st_mtime_ns, status.st_ctime_ns)


def validate_lookup_file(value: Any, label: str = "lookupColumns.file") -> dict[str, str]:
    if not isinstance(value, Mapping) or set(value) != {"path", "format"}:
        raise LookupContractError(f"{label} must contain exactly path and format.")
    path, file_format = value["path"], value["format"]
    if not isinstance(file_format, str) or file_format not in LOOKUP_FORMAT_EXTENSIONS:
        raise LookupContractError(f"{label}.format must be csv, tsv, parquet or jsonl.")
    if not isinstance(path, str) or not path or len(path) > MAX_LOOKUP_PATH_CHARACTERS or "\x00" in path:
        raise LookupContractError(
            f"{label}.path must be a non-empty path of at most {MAX_LOOKUP_PATH_CHARACTERS:,} characters."
        )
    absolute = ntpath.isabs(path) and bool(ntpath.splitdrive(path)[0]) if os.name == "nt" else path.startswith("/")
    if not absolute:
        raise LookupContractError(f"{label}.path must be absolute.")
    if not path.lower().endswith(LOOKUP_FORMAT_EXTENSIONS[file_format]):
        raise LookupContractError(f"{label}.path must end in {' or '.join(LOOKUP_FORMAT_EXTENSIONS[file_format])}.")
    return {"path": path, "format": file_format}


def validate_lookup_params(params: Mapping[str, Any]) -> dict[str, Any]:
    """Check everything that doesn't need the current data or the lookup file."""
    keys, columns = params.get("keys"), params.get("columns")
    if not isinstance(keys, list) or not 1 <= len(keys) <= MAX_LOOKUP_KEYS:
        raise LookupContractError(f"lookupColumns.keys must contain between 1 and {MAX_LOOKUP_KEYS} key pairs.")
    if not isinstance(columns, list) or not 1 <= len(columns) <= MAX_LOOKUP_OUTPUTS:
        raise LookupContractError(f"lookupColumns.columns must contain between 1 and {MAX_LOOKUP_OUTPUTS} columns.")
    normalized_keys = []
    for index, key in enumerate(keys):
        if not isinstance(key, Mapping) or set(key) != {"column", "lookupColumn"}:
            raise LookupContractError("Each lookup key must contain exactly column and lookupColumn.")
        normalized_keys.append(
            {"column": key["column"], "lookupColumn": _name(key["lookupColumn"], f"keys[{index}].lookupColumn")}
        )
    normalized_columns = []
    for index, column in enumerate(columns):
        if not isinstance(column, Mapping) or set(column) != {"lookupColumn", "newColumn"}:
            raise LookupContractError("Each looked-up column must contain exactly lookupColumn and newColumn.")
        normalized_columns.append(
            {
                "lookupColumn": _name(column["lookupColumn"], f"columns[{index}].lookupColumn"),
                "newColumn": _name(column["newColumn"], f"columns[{index}].newColumn"),
            }
        )
    for label, names in (
        ("keys lookupColumn", [key["lookupColumn"] for key in normalized_keys]),
        ("columns lookupColumn", [column["lookupColumn"] for column in normalized_columns]),
        ("columns newColumn", [portable_pivot_longer_name_key(column["newColumn"]) for column in normalized_columns]),
    ):
        if len(set(names)) != len(names):
            raise LookupContractError(
                f"lookupColumns {label} names must be unique"
                + (", ignoring case." if label == "columns newColumn" else ".")
            )
    return {
        "file": validate_lookup_file(params.get("file")),
        "keys": normalized_keys,
        "columns": normalized_columns,
    }


def _name(value: Any, label: str) -> str:
    try:
        return validate_pivot_longer_output_name(value, f"lookupColumns.{label}")
    except PivotLongerContractError as error:
        raise LookupContractError(str(error)) from error


def check_lookup_columns(lookup_columns, keys, outputs, existing):
    """Refuse lookup files whose columns can't serve these keys and outputs, and new names already in the data.

    ``lookup_columns`` lists the file's (name, type) pairs, ``keys`` the (column, type, lookup column) triples of the
    current data, ``outputs`` the (lookup column, new column) pairs to copy and ``existing`` the current column names.
    New names are compared ignoring ASCII case, as DuckDB compares identifiers.
    """

    def fold(name):
        return "".join(
            chr(ord(char) + 32) if "A" <= char <= "Z" else "ss" if char in ("\u00df", "\u1e9e") else char
            for char in name
        )

    labels = {"string": "text", "boolean": "Boolean"}
    copyable = {"string", "integer", "float", "decimal", "boolean", "date", "datetime", "duration"}
    for column, column_type, _ in keys:
        if column_type not in ("string", "integer", "boolean", "date"):
            raise ValueError(
                f"Look up columns can match text, integer, Boolean or date keys, not {column_type} column {column!r}."
            )
    types = {}
    for name, column_type in lookup_columns:
        types.setdefault(name, []).append(column_type)
    for name in [key[2] for key in keys] + [output[0] for output in outputs]:
        if name not in types:
            raise ValueError(f"The lookup file has no column named {name!r}.")
        if len(types[name]) > 1:
            raise ValueError(f"The lookup file has more than one column named {name!r}.")
    for column, column_type, lookup_column in keys:
        lookup_type = types[lookup_column][0]
        if lookup_type != column_type:
            raise ValueError(
                f"Can't match {column!r} ({labels.get(column_type, column_type)}) with lookup column "
                f"{lookup_column!r} ({labels.get(lookup_type, lookup_type)}). Key columns must have the same type."
            )
    for name, _ in outputs:
        if types[name][0] not in copyable:
            raise ValueError(f"Lookup column {name!r} holds {types[name][0]} values, which can't be added.")
    taken = {fold(str(name)): str(name) for name in existing}
    for _, new_column in outputs:
        if fold(new_column) in taken:
            raise ValueError(
                f"Look up columns would add {new_column!r}, but the data already has a column named "
                f"{taken[fold(new_column)]!r}."
            )
        taken[fold(new_column)] = new_column


def lookup_duplicate_message(names, values):
    """Name the first complete key that more than one lookup row has, spelling values the same in every engine."""

    def spell(value):
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, str):
            return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
        return str(value)

    where = " and ".join(f"{name} = {spell(value)}" for name, value in zip(names, values, strict=True))
    return f"The lookup file has more than one row where {where}. Each key must match at most one row."
