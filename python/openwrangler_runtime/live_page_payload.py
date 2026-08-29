# pyright: strict
from __future__ import annotations

import json
from collections.abc import Mapping
from typing import TypeGuard

from .limits import MAX_VIEW_VALUE_TEXT_CHARACTERS

LIVE_PAGE_CELL_LIMIT = 100_000
LIVE_PAGE_PROTOCOL_BYTE_LIMIT = 16 * 1024 * 1024
LIVE_PAGE_COMPLEX_NODE_LIMIT = 100_000
LIVE_PAGE_COMPLEX_DEPTH_LIMIT = 64
LIVE_PAGE_TEXT_CHARACTER_LIMIT = MAX_VIEW_VALUE_TEXT_CHARACTERS
LIVE_PAGE_ROW_LABEL_CHARACTER_LIMIT = 1_024
_JSON_UTF8_VALIDATION_CHUNK_CHARACTERS = 16 * 1024


class LivePagePayloadError(ValueError):
    """A recoverable live-page value or serialization limit failure."""


def validate_live_page_payload(page: object) -> int:
    """Validate one engine-neutral live page and return its strict JSON byte size."""

    if not _is_mapping(page):
        raise LivePagePayloadError("Live paging returned a malformed page payload.")
    column_ids = page.get("columnIds")
    rows = page.get("rows")
    if not _is_list(column_ids) or not _is_list(rows):
        raise LivePagePayloadError("Live paging returned malformed rows or column identities.")
    for column_id in column_ids:
        _validate_live_page_text(column_id)

    cell_count = 0
    remaining_complex_nodes = LIVE_PAGE_COMPLEX_NODE_LIMIT
    for row in rows:
        if not _is_mapping(row):
            raise LivePagePayloadError("Live paging returned a malformed row payload.")
        _validate_live_page_text(row.get("id"))
        if "rowLabel" in row:
            row_label = row.get("rowLabel")
            if not isinstance(row_label, str):
                raise LivePagePayloadError("Live paging returned a malformed row label.")
            _validate_live_page_text(
                row_label,
                maximum_characters=LIVE_PAGE_ROW_LABEL_CHARACTER_LIMIT,
                subject="Live page row labels",
            )
        values = row.get("values")
        if not _is_list(values):
            raise LivePagePayloadError("Live paging returned malformed row values.")
        cell_count += len(values)
        if cell_count > LIVE_PAGE_CELL_LIMIT:
            raise LivePagePayloadError(
                f"Live pages may contain at most {LIVE_PAGE_CELL_LIMIT:,} cells; "
                f"this page contains at least {cell_count:,}. Request fewer rows or columns."
            )
        for cell in values:
            if not _is_mapping(cell):
                raise LivePagePayloadError("Live paging returned a malformed typed cell.")
            _validate_live_page_text(cell.get("kind"))
            _validate_live_page_text(cell.get("display"))
            raw = cell.get("raw")
            if isinstance(raw, str):
                _validate_live_page_text(raw)
            if _is_complex_container(raw):
                consumed_nodes = _validate_live_page_complex_graph(raw, remaining_complex_nodes)
                remaining_complex_nodes -= consumed_nodes

    encoder = json.JSONEncoder(ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    serialized_bytes = 0
    try:
        for serialized_chunk in encoder.iterencode(page):
            for offset in range(0, len(serialized_chunk), _JSON_UTF8_VALIDATION_CHUNK_CHARACTERS):
                encoded_chunk = serialized_chunk[offset : offset + _JSON_UTF8_VALIDATION_CHUNK_CHARACTERS].encode(
                    "utf-8"
                )
                serialized_bytes += len(encoded_chunk)
                if serialized_bytes > LIVE_PAGE_PROTOCOL_BYTE_LIMIT:
                    raise LivePagePayloadError(
                        f"Live pages may contain at most {LIVE_PAGE_PROTOCOL_BYTE_LIMIT:,} strict UTF-8 JSON bytes. "
                        "Request fewer rows or columns, or shorten large values."
                    )
    except LivePagePayloadError:
        raise
    except (TypeError, ValueError, UnicodeError, RecursionError) as error:
        raise LivePagePayloadError(
            "Live paging returned data that cannot be serialized as strict UTF-8 JSON."
        ) from error
    return serialized_bytes


def _validate_live_page_text(
    value: object,
    *,
    maximum_characters: int | None = None,
    subject: str = "Live page text values",
) -> None:
    if not isinstance(value, str):
        return
    maximum_characters = LIVE_PAGE_TEXT_CHARACTER_LIMIT if maximum_characters is None else maximum_characters
    if len(value) > maximum_characters:
        raise LivePagePayloadError(
            f"{subject} may contain at most {maximum_characters:,} Unicode code points. "
            "Request fewer rows or columns, or shorten large values."
        )
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise LivePagePayloadError(f"{subject} must be valid strict UTF-8.") from error


def _validate_live_page_complex_graph(value: object, remaining_nodes: int) -> int:
    nodes = 0
    active_containers: set[int] = set()
    stack: list[tuple[bool, object, int]] = [(False, value, 1)]
    while stack:
        leaving, current, depth = stack.pop()
        if leaving:
            active_containers.remove(id(current))
            continue

        nodes += 1
        if nodes > remaining_nodes:
            consumed = LIVE_PAGE_COMPLEX_NODE_LIMIT - remaining_nodes + nodes
            raise LivePagePayloadError(
                f"Live page complex values may contain at most {LIVE_PAGE_COMPLEX_NODE_LIMIT:,} JSON nodes; "
                f"this page contains at least {consumed:,}. Request fewer rows or columns, or simplify nested values."
            )
        _validate_live_page_text(current)

        if not _is_complex_container(current):
            continue
        if depth > LIVE_PAGE_COMPLEX_DEPTH_LIMIT:
            raise LivePagePayloadError(
                f"Live page complex values may contain at most {LIVE_PAGE_COMPLEX_DEPTH_LIMIT} nested levels; "
                f"encountered depth {depth}. Simplify nested values before requesting this page."
            )
        identity = id(current)
        if identity in active_containers:
            raise LivePagePayloadError("Live page complex values must not contain cyclic containers.")
        active_containers.add(identity)
        stack.append((True, current, depth))
        if _is_mapping(current):
            for key, nested in current.items():
                stack.append((False, nested, depth + 1 if _is_complex_container(nested) else depth))
                stack.append((False, key, depth))
        else:
            for nested in current:
                stack.append((False, nested, depth + 1 if _is_complex_container(nested) else depth))
    return nodes


def _is_mapping(value: object) -> TypeGuard[Mapping[object, object]]:
    return isinstance(value, Mapping)


def _is_list(value: object) -> TypeGuard[list[object]]:
    return isinstance(value, list)


def _is_complex_container(
    value: object,
) -> TypeGuard[Mapping[object, object] | list[object] | tuple[object, ...]]:
    return isinstance(value, Mapping | list | tuple)
