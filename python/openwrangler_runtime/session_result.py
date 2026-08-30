from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .engines import DataFrameEngine, EngineError
from .engines.base import PageColumnProjection, SummaryColumnProjection
from .live_page_payload import (
    LIVE_PAGE_COMPLEX_DEPTH_LIMIT,
    LivePagePayloadError,
    validate_live_page_payload,
)
from .protocol import MAX_COLUMN_LIMIT
from .response_framing import MAX_STRICT_RESPONSE_PAYLOAD_BYTES, strict_json_byte_length


class ResponsePayloadError(EngineError):
    """A bounded operation-specific failure produced before response publication."""

    def __init__(self, message: str, code: str) -> None:
        self.code = code
        super().__init__(message)


def strict_response_payload_size(
    value: object,
    subject: str,
    recovery: str,
    *,
    maximum_size: int = MAX_STRICT_RESPONSE_PAYLOAD_BYTES,
    precomputed_size: int | None = None,
) -> int:
    try:
        size = precomputed_size if precomputed_size is not None else strict_json_byte_length(value, maximum_size)
    except (TypeError, ValueError, OverflowError, RecursionError, UnicodeError) as error:
        raise ResponsePayloadError(
            f"The requested {subject} could not be encoded as strict JSON. {recovery}",
            "response_encoding_failed",
        ) from error
    _assert_strict_response_payload_size(size, maximum_size, subject, recovery)
    return size


def read_live_page(
    engine: DataFrameEngine,
    frame: Any,
    offset: int,
    limit: int,
    *,
    total_rows: int | None,
    column_projection: PageColumnProjection,
) -> tuple[dict[str, Any], int]:
    try:
        page = engine.page(
            frame,
            offset,
            limit,
            total_rows=total_rows,
            column_projection=column_projection,
        )
    except RecursionError as error:
        raise ResponsePayloadError(
            "Live page complex values must not be cyclic and may contain at most "
            f"{LIVE_PAGE_COMPLEX_DEPTH_LIMIT} nested levels.",
            "page_payload_invalid",
        ) from error
    _validate_page_projection(page, column_projection)
    try:
        return page, validate_live_page_payload(page)
    except LivePagePayloadError as error:
        raise ResponsePayloadError(str(error), "page_payload_invalid") from error


def column_window(
    schema: list[dict[str, Any]],
    column_offset: int,
    column_limit: int,
) -> PageColumnProjection:
    if not isinstance(column_offset, int) or isinstance(column_offset, bool) or column_offset < 0:
        raise EngineError("columnOffset must be a non-negative integer.")
    if (
        not isinstance(column_limit, int)
        or isinstance(column_limit, bool)
        or column_limit < 1
        or column_limit > MAX_COLUMN_LIMIT
    ):
        raise EngineError(f"columnLimit must be an integer between 1 and {MAX_COLUMN_LIMIT}.")
    return [
        (int(column["position"]), str(column["id"])) for column in schema[column_offset : column_offset + column_limit]
    ]


def summary_projection(
    schema: list[dict[str, Any]],
    column_ids: list[str] | None,
) -> SummaryColumnProjection:
    if column_ids is None:
        selected = schema
    else:
        if (
            not column_ids
            or any(not isinstance(column_id, str) or not column_id for column_id in column_ids)
            or len(set(column_ids)) != len(column_ids)
        ):
            raise EngineError("Summary column identities must be a non-empty unique list.")
        schema_by_id = {str(column["id"]): column for column in schema}
        unknown = [column_id for column_id in column_ids if column_id not in schema_by_id]
        if unknown:
            raise EngineError(f"Unknown summary column identity: {unknown[0]}")
        selected = [schema_by_id[column_id] for column_id in column_ids]
    return [(int(column["position"]), str(column["id"])) for column in selected]


def validate_summary_projection(
    summaries: Any,
    schema: list[dict[str, Any]],
    projection: SummaryColumnProjection,
) -> None:
    if not isinstance(summaries, list) or len(summaries) != len(projection):
        raise EngineError("The dataframe engine returned summaries for the wrong column projection.")
    schema_by_id = {str(column["id"]): column for column in schema}
    expected_ids = [identifier for _position, identifier in projection]
    returned_ids = [summary.get("columnId") if isinstance(summary, Mapping) else None for summary in summaries]
    if returned_ids != expected_ids or len(set(returned_ids)) != len(returned_ids):
        raise EngineError("The dataframe engine returned summaries for the wrong column projection.")
    for summary in summaries:
        column = schema_by_id.get(str(summary["columnId"]))
        if (
            column is None
            or summary.get("column") != column["name"]
            or summary.get("type") != column["type"]
            or summary.get("rawType") != column["rawType"]
        ):
            raise EngineError("The dataframe engine returned a summary that does not match the active schema.")


def _validate_page_projection(
    page: Mapping[str, Any],
    projection: PageColumnProjection,
) -> None:
    expected_ids = [identifier for _position, identifier in projection]
    if not isinstance(page, Mapping):
        raise EngineError("The dataframe engine returned a malformed projected page.")
    if page.get("columnIds") != expected_ids:
        raise EngineError("The dataframe engine returned a page for the wrong column projection.")
    rows = page.get("rows")
    if not isinstance(rows, list):
        raise EngineError("The dataframe engine returned a malformed projected page.")
    for row in rows:
        values = row.get("values") if isinstance(row, Mapping) else None
        if not isinstance(values, list) or len(values) != len(expected_ids):
            raise EngineError("The dataframe engine returned a row with the wrong projected width.")


def _assert_strict_response_payload_size(
    size: int,
    maximum_size: int,
    subject: str,
    recovery: str,
) -> None:
    if size > maximum_size:
        raise ResponsePayloadError(
            f"The requested {subject} exceeds the {maximum_size:,}-byte strict response payload limit. {recovery}",
            "response_too_large",
        )
