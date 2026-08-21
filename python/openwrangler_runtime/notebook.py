from __future__ import annotations

import json
import re
import secrets
import weakref
from contextlib import suppress
from typing import Any

from IPython.core.getipython import get_ipython
from IPython.display import display

from .engines import EngineError, UnsupportedDataFrameError, default_engine_registry

MIME_TYPE_V2 = "application/vnd.openwrangler.viewer.v2+json"
MAX_SAVED_ROWS = 10_000
MAX_SAVED_COLUMNS = 2_048
MAX_SAVED_CELLS = 100_000
MAX_SAVED_PAYLOAD_BYTES = 16_777_216
MAX_SAVED_LABEL_CHARACTERS = 256
MAX_SAVED_COLUMN_CHARACTERS = 512
MAX_SAVED_CELL_CHARACTERS = 65_536
MAX_SAVED_PAYLOAD_NODES = 1_000_000
MAX_SAVED_PAYLOAD_DEPTH = 64
_JSON_UTF8_VALIDATION_CHUNK_CHARACTERS = 16 * 1024
_LIVE_RESULT_HANDLE_PREFIX = "__openwrangler_live_result_"
_LIVE_RESULT_HANDLE_PATTERN = re.compile(r"\A__openwrangler_live_result_[0-9a-f]{32}\Z")
_LIVE_RESULTS: weakref.WeakValueDictionary[str, Any] = weakref.WeakValueDictionary()


def show(
    value: Any,
    label: str = "dataframe",
    backend: str | None = None,
    page_size: int = 200,
    *,
    variable_name: str | None = None,
) -> None:
    """Display a deterministic dataframe snapshot using the Open Wrangler renderer."""
    payload = build_payload(value, label, backend, page_size, variable_name=variable_name)
    display({MIME_TYPE_V2: payload}, raw=True)


def build_payload(
    value: Any,
    label: str = "dataframe",
    backend: str | None = None,
    page_size: int = 200,
    *,
    variable_name: str | None = None,
) -> dict[str, Any]:
    if not isinstance(label, str) or not label:
        raise EngineError("Notebook output label must be a non-empty string.")
    _validate_text_limit(label, MAX_SAVED_LABEL_CHARACTERS, "Notebook output label")
    if not isinstance(page_size, int) or isinstance(page_size, bool) or page_size < 1 or page_size > MAX_SAVED_ROWS:
        raise EngineError(f"Notebook output page_size must be an integer between 1 and {MAX_SAVED_ROWS}.")
    if variable_name is not None:
        _validate_text_limit(variable_name, MAX_SAVED_LABEL_CHARACTERS, "Notebook variable_name")
        if not _is_python_identifier(variable_name):
            raise EngineError("Notebook variable_name must be a valid Python identifier.")

    registry = default_engine_registry()
    try:
        engine = registry.create(backend) if backend else registry.detect(value)
    except UnsupportedDataFrameError as error:
        raise EngineError(
            "Open Wrangler notebook output supports Pandas or Polars dataframes and series, and DuckDB relations."
        ) from error
    try:
        if engine.name not in {"pandas", "polars", "duckdb"}:
            raise EngineError(
                "Open Wrangler notebook output supports Pandas or Polars dataframes and series, and DuckDB relations."
            )
        if "notebookOutput" not in engine.capabilities.source_kinds:
            raise EngineError(f"The {engine.name} backend does not support notebook output sources.")
        frame = _normalize_snapshot_value(engine, value)
        filter_model = {"filters": [], "sort": []}
        source: dict[str, Any] = {"kind": "notebookOutput", "label": label}
        if variable_name:
            source["variableName"] = variable_name
        shape = engine.shape(frame)
        schema = engine.schema(frame)
        if len(schema) > MAX_SAVED_COLUMNS:
            raise EngineError(
                f"Notebook output captures at most {MAX_SAVED_COLUMNS:,} columns; received {len(schema):,}. "
                "Select fewer columns before displaying the dataframe."
            )
        _validate_snapshot_schema_fields(schema)
        filtered_shape = dict(shape)
        effective_page_size = min(
            page_size,
            MAX_SAVED_CELLS // len(schema) if schema else page_size,
        )
        page = engine.page(frame, 0, effective_page_size, total_rows=shape["rows"])
        _validate_snapshot_dimensions(schema, page)
        metadata = {
            "protocolVersion": 2,
            "sessionId": f"notebook-output:{label}",
            "revision": 0,
            "backend": engine.name,
            "mode": "viewing",
            "source": source,
            "capabilities": {
                "editable": False,
                "lazy": False,
                "cancel": False,
                "exportCsv": False,
                "exportParquet": False,
                "notebookInsert": False,
            },
            "shape": shape,
            "filteredShape": filtered_shape,
            "schema": schema,
            "filterModel": filter_model,
            "steps": [],
        }
        if engine.name == "pandas":
            metadata["rowAxis"] = engine.row_axis(frame)
        payload = {
            "mimeVersion": 2,
            "metadata": metadata,
            "page": page,
            "summaries": [],
        }
        _validate_snapshot_fields(metadata, page)
        _validate_snapshot_payload_size(payload)
    except BaseException as error:
        with suppress(Exception):
            engine.close()
        if isinstance(error, RecursionError):
            raise EngineError(
                "Notebook output contains data nested too deeply to serialize safely. "
                f"Use at most {MAX_SAVED_PAYLOAD_DEPTH} nested payload levels."
            ) from error
        raise
    try:
        engine.close()
    except Exception as error:
        raise EngineError(f"Could not close the {engine.name} notebook output engine: {error}") from error
    return payload


def _normalize_snapshot_value(engine: Any, value: Any) -> Any:
    if engine.name == "polars":
        import polars as pl

        if isinstance(value, pl.LazyFrame):
            # A saved output needs only a streamed row count, metadata-only
            # schema discovery, and one bounded terminal page. Normalizing a
            # LazyFrame would collect the complete source before any limit can
            # protect the kernel.
            return value
    if engine.name == "duckdb":
        normalizer = getattr(engine, "normalize_notebook_relation", None)
        if callable(normalizer):
            return normalizer(value)
    return engine.normalize(value)


def _validate_text_limit(value: str, limit: int, label: str) -> None:
    if len(value) > limit:
        raise EngineError(
            f"{label} may contain at most {limit:,} characters; received {len(value):,}. "
            "Shorten the value before displaying the dataframe."
        )


def _validate_snapshot_schema_fields(schema: list[dict[str, Any]]) -> None:
    for position, column in enumerate(schema):
        for field_name in ("id", "name", "rawType"):
            value = column.get(field_name)
            if not isinstance(value, str):
                raise EngineError(f"Notebook output column {position + 1} has a malformed {field_name} field.")
            _validate_text_limit(
                value,
                MAX_SAVED_COLUMN_CHARACTERS,
                f"Notebook output column {position + 1} {field_name}",
            )


def _validate_snapshot_fields(metadata: dict[str, Any], page: dict[str, Any]) -> None:
    source = metadata.get("source", {})
    _validate_text_limit(source["label"], MAX_SAVED_LABEL_CHARACTERS, "Notebook output label")
    variable_name = source.get("variableName")
    if variable_name is not None:
        _validate_text_limit(variable_name, MAX_SAVED_LABEL_CHARACTERS, "Notebook variable_name")
    _validate_snapshot_schema_fields(metadata.get("schema", []))

    column_ids = page.get("columnIds", [])
    for position, column_id in enumerate(column_ids):
        if not isinstance(column_id, str):
            raise EngineError(f"Notebook output page column identity {position + 1} is malformed.")
        _validate_text_limit(
            column_id,
            MAX_SAVED_COLUMN_CHARACTERS,
            f"Notebook output page column identity {position + 1}",
        )
    for row_position, row in enumerate(page.get("rows", [])):
        row_id = row.get("id")
        if not isinstance(row_id, str):
            raise EngineError(f"Notebook output row {row_position + 1} has a malformed identity.")
        _validate_text_limit(
            row_id,
            MAX_SAVED_COLUMN_CHARACTERS,
            f"Notebook output row {row_position + 1} identity",
        )
        for column_position, cell in enumerate(row.get("values", [])):
            context = f"Notebook output cell at row {row_position + 1}, column {column_position + 1}"
            display_value = cell.get("display")
            if not isinstance(display_value, str):
                raise EngineError(f"{context} has a malformed display field.")
            _validate_text_limit(display_value, MAX_SAVED_CELL_CHARACTERS, f"{context} display")
            _validate_nested_strings(cell.get("raw"), context)


def _validate_nested_strings(value: Any, context: str) -> None:
    stack = [value]
    seen: set[int] = set()
    while stack:
        current = stack.pop()
        if isinstance(current, str):
            _validate_text_limit(current, MAX_SAVED_CELL_CHARACTERS, f"{context} nested string")
        elif isinstance(current, dict):
            identity = id(current)
            if identity in seen:
                raise EngineError(f"{context} contains a repeated or cyclic nested object.")
            seen.add(identity)
            for key, nested in current.items():
                if isinstance(key, str):
                    _validate_text_limit(key, MAX_SAVED_CELL_CHARACTERS, f"{context} nested key")
                stack.append(nested)
        elif isinstance(current, (list, tuple)):
            identity = id(current)
            if identity in seen:
                raise EngineError(f"{context} contains a repeated or cyclic nested array.")
            seen.add(identity)
            stack.extend(current)


def _validate_snapshot_dimensions(schema: list[dict[str, Any]], page: dict[str, Any]) -> None:
    rows = page.get("rows")
    if not isinstance(rows, list):
        raise EngineError("Notebook output paging returned malformed rows.")
    if len(rows) > MAX_SAVED_ROWS:
        raise EngineError(
            f"Notebook output captures at most {MAX_SAVED_ROWS:,} rows; received {len(rows):,}. "
            "Reduce page_size before displaying the dataframe."
        )
    captured_cells = sum(len(row.get("values", [])) for row in rows if isinstance(row, dict))
    if captured_cells > MAX_SAVED_CELLS:
        raise EngineError(
            f"Notebook output captures at most {MAX_SAVED_CELLS:,} cells; received {captured_cells:,}. "
            "Reduce page_size or select fewer columns before displaying the dataframe."
        )
    expected_cells = len(rows) * len(schema)
    if captured_cells != expected_cells:
        raise EngineError("Notebook output paging did not return one complete value for every captured cell.")


def _validate_snapshot_payload_size(payload: Any) -> None:
    _validate_snapshot_payload_graph(payload)
    encoder = json.JSONEncoder(ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    serialized_bytes = 0
    try:
        for serialized_chunk in encoder.iterencode(payload):
            # ``JSONEncoder.iterencode`` avoids joining the complete payload,
            # but a token can still contain a large string. Encode bounded
            # slices so validation never creates the very oversized byte
            # string that this limit exists to prevent.
            for offset in range(0, len(serialized_chunk), _JSON_UTF8_VALIDATION_CHUNK_CHARACTERS):
                encoded_chunk = serialized_chunk[offset : offset + _JSON_UTF8_VALIDATION_CHUNK_CHARACTERS].encode(
                    "utf-8"
                )
                serialized_bytes += len(encoded_chunk)
                if serialized_bytes > MAX_SAVED_PAYLOAD_BYTES:
                    raise EngineError(
                        f"Notebook output captures at most {MAX_SAVED_PAYLOAD_BYTES:,} serialized bytes; "
                        f"received {serialized_bytes:,}. Reduce page_size or shorten large values before "
                        "displaying the dataframe."
                    )
    except (TypeError, ValueError, RecursionError) as error:
        raise EngineError(f"Notebook output could not be serialized as strict JSON: {error}") from error


def _validate_snapshot_payload_graph(payload: Any) -> None:
    stack: list[tuple[Any, int]] = [(payload, 0)]
    seen: set[int] = set()
    nodes = 0
    while stack:
        current, depth = stack.pop()
        if depth > MAX_SAVED_PAYLOAD_DEPTH:
            raise EngineError(
                f"Notebook output captures at most {MAX_SAVED_PAYLOAD_DEPTH} nested payload levels; "
                f"encountered a value at depth {depth}. Shorten nested values before displaying the dataframe."
            )
        nodes += 1
        if nodes > MAX_SAVED_PAYLOAD_NODES:
            raise EngineError(
                f"Notebook output captures at most {MAX_SAVED_PAYLOAD_NODES:,} payload nodes; "
                f"received at least {nodes:,}. Reduce page_size or simplify nested values before "
                "displaying the dataframe."
            )
        if isinstance(current, dict):
            identity = id(current)
            if identity in seen:
                raise EngineError("Notebook output must not contain repeated or cyclic nested objects.")
            seen.add(identity)
            stack.extend((nested, depth + 1) for nested in current.values())
        elif isinstance(current, (list, tuple)):
            identity = id(current)
            if identity in seen:
                raise EngineError("Notebook output must not contain repeated or cyclic nested arrays.")
            seen.add(identity)
            stack.extend((nested, depth + 1) for nested in current)


def register_formatters(shell: Any | None = None) -> bool:
    """Register v2 inline formatters after the extension has permission to use the kernel."""
    active_shell: Any = shell if shell is not None else get_ipython()
    if active_shell is None:
        return False
    display_formatter = active_shell.display_formatter
    formatter = display_formatter.mimebundle_formatter
    formatters = getattr(display_formatter, "formatters", {})
    html_formatter = formatters.get("text/html") if hasattr(formatters, "get") else None
    registered = False
    for dataframe_type in _available_dataframe_types():
        formatter.for_type(
            dataframe_type,
            lambda value, shell=active_shell: {MIME_TYPE_V2: _build_formatter_payload(value, shell)},
        )
        _suppress_default_html_formatter(html_formatter, dataframe_type)
        registered = True
    return registered


def _build_formatter_payload(value: Any, shell: Any) -> dict[str, Any]:
    variable_name = _unique_user_variable_name(value, shell)
    if variable_name is None:
        variable_name = _register_live_result(value)
    return build_payload(
        value,
        label=variable_name if not is_live_result_handle(variable_name) else type(value).__name__,
        variable_name=variable_name,
    )


def link_live_result(value: Any, shell: Any | None = None) -> dict[str, str | int]:
    """Link an already-executed IPython result without serializing or copying it."""
    active_shell: Any = shell if shell is not None else get_ipython()
    if active_shell is None:
        raise EngineError("Open Wrangler could not access the active IPython session.")

    registry = default_engine_registry()
    try:
        engine = registry.detect(value)
    except UnsupportedDataFrameError as error:
        raise EngineError(
            "This cell result is not a supported Pandas, Polars, DuckDB, or PySpark dataframe."
        ) from error
    try:
        if engine.name not in {"pandas", "polars", "duckdb", "pyspark"}:
            raise EngineError(f"Open Wrangler cannot open {engine.name} notebook results.")
        canonical_name = _unique_user_variable_name(value, active_shell)
        variable_name = _register_live_result(value)
        label = canonical_name if canonical_name is not None else type(value).__name__
        _validate_text_limit(label, MAX_SAVED_LABEL_CHARACTERS, "Notebook result label")
        return {
            "protocolVersion": 1,
            "backend": engine.name,
            "label": label,
            "variableName": variable_name,
        }
    finally:
        try:
            engine.close()
        except Exception as error:
            raise EngineError(f"Could not close the {engine.name} notebook result probe: {error}") from error


def _register_live_result(value: Any) -> str:
    """Return an opaque handle without extending the displayed value's lifetime."""
    # IPython's Out history keeps executed results alive. Reopening the same
    # result must reuse its handle instead of adding one key per panel open.
    for existing_handle, existing_value in list(_LIVE_RESULTS.items()):
        if existing_value is value:
            return existing_handle
    handle = f"{_LIVE_RESULT_HANDLE_PREFIX}{secrets.token_hex(16)}"
    try:
        _LIVE_RESULTS[handle] = value
    except TypeError as error:
        raise EngineError("This notebook dataframe cannot be linked to its live result.") from error
    return handle


def is_live_result_handle(value: str) -> bool:
    return _LIVE_RESULT_HANDLE_PATTERN.fullmatch(value) is not None


def is_reserved_live_result_name(value: str) -> bool:
    return value.startswith(_LIVE_RESULT_HANDLE_PREFIX)


def resolve_live_result(handle: str) -> Any:
    if not is_live_result_handle(handle):
        raise EngineError("The notebook output contains an invalid Open Wrangler live-result handle.")
    try:
        return _LIVE_RESULTS[handle]
    except KeyError as error:
        raise EngineError(
            "This notebook result is no longer available in the selected kernel. "
            "Run the cell again to create a new preview."
        ) from error


def _unique_user_variable_name(value: Any, shell: Any) -> str | None:
    """Return a safe live link only when one canonical user variable owns the value."""
    namespace = getattr(shell, "user_ns", None)
    if not isinstance(namespace, dict):
        return None
    matches: list[str] = []
    for name, candidate in namespace.items():
        if not isinstance(name, str) or not _is_python_identifier(name) or name.startswith("_"):
            continue
        if candidate is value:
            matches.append(name)
            if len(matches) > 1:
                return None
    return matches[0] if matches else None


def _suppress_default_html_formatter(html_formatter: Any, dataframe_type: type[Any]) -> None:
    if html_formatter is None:
        return
    type_printers = getattr(html_formatter, "type_printers", {})
    existing = type_printers.get(dataframe_type) if hasattr(type_printers, "get") else None
    if existing is not None and existing is not _no_html_representation:
        # An explicit per-type formatter is a user choice. Keep it instead of
        # silently replacing it merely because Open Wrangler acquired a kernel.
        return
    html_formatter.for_type(dataframe_type, _no_html_representation)


def _no_html_representation(_value: Any) -> None:
    # VS Code's released Jupyter extension prefers text/html over extension
    # MIME renderers. Retaining text/plain while suppressing only the default
    # dataframe HTML representation makes the validated Open Wrangler MIME the
    # rich inline view and still leaves a portable fallback.
    return None


def _available_dataframe_types() -> list[type[Any]]:
    types: list[type[Any]] = []
    try:
        import pandas as pd

        types.extend((pd.DataFrame, pd.Series))
    except ImportError:
        pass
    try:
        import polars as pl

        types.extend((pl.DataFrame, pl.LazyFrame, pl.Series))
    except ImportError:
        pass
    try:
        import duckdb

        types.append(duckdb.DuckDBPyRelation)
    except ImportError:
        pass
    return types


def _is_python_identifier(value: str) -> bool:
    return value.isascii() and value.isidentifier()
