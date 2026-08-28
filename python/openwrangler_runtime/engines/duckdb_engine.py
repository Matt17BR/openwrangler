from __future__ import annotations

import os
import re
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from math import inf, isfinite, isinf, isnan, nextafter
from pathlib import Path
from threading import RLock
from typing import Any
from uuid import uuid4

from ..custom_code_output import append_custom_code_output, capture_custom_code_output, custom_code_error_message
from ..custom_code_scope import (
    custom_code_definition_lines,
    custom_code_prelude_lines,
    custom_code_step_lines,
    execute_custom_code,
)
from ..export_target import ExportWriterPath
from ..pivot_longer import (
    PivotLongerContractError,
    checked_pivot_longer_row_count,
    portable_pivot_longer_name_key,
)
from ..pivot_wider import pivot_wider_key_value, portable_pivot_wider_name_key
from ..portable_regex import (
    MAX_PORTABLE_REGEX_TEXT_CODE_POINTS,
    MAX_PORTABLE_REGEX_TEXT_UTF8_BYTES,
    PORTABLE_REGEX_TEXT_LIMIT_MESSAGE,
    portable_regex_contract,
)
from .base import (
    DEFAULT_STRIP_CHARACTERS,
    INTERNAL_ROW_ID_PREFIX,
    VIEW_COMPARABLE_TYPES,
    DataFrameEngine,
    EngineCapabilities,
    EngineError,
    ExportOptions,
    PageColumnProjection,
    SessionDataShape,
    SummaryColumnProjection,
    bound_column_name,
    categorical_visualization,
    coerce_typed_view_value,
    datetime_visualization,
    decimal_at_scale,
    decode_fill_replacement,
    ensure_output_columns_available,
    exact_decimal_median,
    exact_integer_median,
    generated_fill_replacement_expression,
    generated_view_value_helper_lines,
    infer_semantic_type,
    is_blank_delimited_file,
    is_internal_row_id_label,
    normalize_cell,
    normalize_page_projection,
    normalize_summary_projection,
    normalized_numeric_sum,
    numeric_histogram_bin_count,
    numeric_histogram_edges,
    numeric_visualization_from_bin_counts,
    require_datetime_fill_awareness,
    typed_selection_value,
    validate_view_predicate_operator,
)

_ASCII_LOWER = "abcdefghijklmnopqrstuvwxyz"
_ASCII_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_ASCII_TO_LOWER = str.maketrans(_ASCII_UPPER, _ASCII_LOWER)
_PORTABLE_INTEGER_MAX = 10**38 - 1
_PORTABLE_INTEGER_MIN = -_PORTABLE_INTEGER_MAX
_DUCKDB_DECIMAL_TYPE = re.compile(r"^DECIMAL\((\d+),\s*(\d+)\)$", re.IGNORECASE)


@dataclass(frozen=True, slots=True)
class DuckDBSqlPlan:
    """Connection-free metadata for a replayable native DuckDB relation."""

    sql: str
    column_names: tuple[str, ...]
    type_names: tuple[str, ...]

    @property
    def columns(self) -> list[str]:
        return list(self.column_names)

    @property
    def types(self) -> list[str]:
        return list(self.type_names)

    def sql_query(self) -> str:
        return self.sql


class _DuckDBNotebookRelationOwner:
    """Retain one user-owned live relation without borrowing its connection.

    ``DuckDBPyRelation.sql_query()`` is not a portable serialization: a query
    can refer to tables, views, or registered objects that exist only in the
    relation's originating connection. Notebook reads therefore bind every
    derived query back to the exact live relation through ``relation.query``.
    Closing an Open Wrangler session only releases our strong reference; it
    never closes or otherwise mutates the user's relation.
    """

    def __init__(self, relation: Any) -> None:
        self.alias = f"__open_wrangler_notebook_source_{uuid4().hex}"
        self._relation: Any | None = relation
        self._closed = False

    @contextmanager
    def terminal(self) -> Iterator[_DuckDBNotebookTerminal]:
        # Jupyter serializes code execution, but runtime profile/read paths can
        # still overlap in direct tests. DuckDB relations retain their owning
        # connection, so serialize only live-notebook relation access. File
        # sessions continue to use independent short-lived connections.
        with _DUCKDB_NOTEBOOK_RELATION_LOCK:
            if self._closed or self._relation is None:
                raise EngineError("The live DuckDB notebook relation is closed.")
            yield _DuckDBNotebookTerminal(self._relation, self.alias)

    def describe(self, sql: str) -> tuple[tuple[str, ...], tuple[str, ...]]:
        with self.terminal() as terminal:
            relation = terminal.sql(sql)
            try:
                return (
                    tuple(str(column) for column in relation.columns),
                    tuple(str(column_type) for column_type in relation.types),
                )
            finally:
                relation = None

    def close(self) -> None:
        with _DUCKDB_NOTEBOOK_RELATION_LOCK:
            if self._closed:
                return
            self._closed = True
            # The relation belongs to the notebook. Dropping our reference is
            # deterministic cleanup; calling DuckDBPyRelation.close() here
            # would close a user-owned object and can execute a lazy relation.
            self._relation = None

    @property
    def closed(self) -> bool:
        return self._closed


class _DuckDBNotebookTerminal:
    def __init__(self, relation: Any, alias: str) -> None:
        self._relation = relation
        self._alias = alias

    def execute(self, sql: str) -> Any:
        return self._relation.query(self._alias, sql)

    def sql(self, sql: str) -> Any:
        return self._relation.query(self._alias, sql)


@dataclass(frozen=True, slots=True)
class DuckDBNotebookPlan:
    """A query plan rooted in the exact live DuckDB notebook relation."""

    owner: _DuckDBNotebookRelationOwner
    sql: str
    column_names: tuple[str, ...]
    type_names: tuple[str, ...]

    @property
    def columns(self) -> list[str]:
        return list(self.column_names)

    @property
    def types(self) -> list[str]:
        return list(self.type_names)

    def sql_query(self) -> str:
        return self.sql


_DUCKDB_NOTEBOOK_RELATION_LOCK = RLock()


class DuckDBEngine(DataFrameEngine):
    """Native, lazy DuckDB SQL-plan adapter.

    Session frames retain only immutable SQL and schema metadata. Native
    DuckDBPyRelation objects exist inside one bounded connection scope and are
    released before that connection closes. Every terminal read replays the
    self-contained SQL on a fresh connection, so file-backed sessions can
    profile and page in parallel without sharing a cursor or file owner.
    """

    name = "duckdb"
    runtime_modules = ("duckdb",)
    capabilities = EngineCapabilities(
        source_kinds=frozenset({"file", "notebookVariable", "notebookOutput"}),
        supports_editing=True,
        lazy_file_extensions=frozenset({".csv", ".tsv", ".parquet", ".jsonl", ".ndjson"}),
        export_formats=frozenset({"csv", "parquet"}),
        supports_shutdown_interrupt=True,
        supports_request_cancellation=False,
    )

    def __init__(self) -> None:
        self._active_connections: set[Any] = set()
        self._lifecycle_lock = RLock()
        self._closed = False
        self._empty_source_frame: DuckDBSqlPlan | None = None
        self._notebook_relation_owners: list[_DuckDBNotebookRelationOwner] = []

    def detect(self, value: Any) -> bool:
        if isinstance(value, (DuckDBSqlPlan, DuckDBNotebookPlan)):
            return True
        try:
            import duckdb
        except ImportError:
            return False
        return isinstance(value, duckdb.DuckDBPyRelation)

    def normalize(self, value: Any) -> DuckDBSqlPlan | DuckDBNotebookPlan:
        if isinstance(value, (DuckDBSqlPlan, DuckDBNotebookPlan)):
            return value
        try:
            import duckdb
        except ImportError as error:
            raise EngineError("DuckDB sessions require DuckDB.") from error
        if not isinstance(value, duckdb.DuckDBPyRelation):
            raise EngineError("DuckDB sessions require a native DuckDB SQL plan or DuckDBPyRelation.")
        try:
            return _snapshot_native_relation(value)
        except Exception as error:
            raise EngineError(f"DuckDB query failed: {error}") from error

    def normalize_notebook_relation(self, value: Any) -> DuckDBNotebookPlan:
        """Bind a notebook relation to its exact user-owned connection."""

        if isinstance(value, DuckDBNotebookPlan):
            return value
        try:
            import duckdb
        except ImportError as error:
            raise EngineError("DuckDB sessions require DuckDB.") from error
        if not isinstance(value, duckdb.DuckDBPyRelation):
            raise EngineError("DuckDB notebook sessions require a DuckDBPyRelation.")
        owner: _DuckDBNotebookRelationOwner | None = None
        try:
            with self._lifecycle_lock:
                if self._closed:
                    raise EngineError("The DuckDB engine is closed.")
                owner = _DuckDBNotebookRelationOwner(value)
                self._notebook_relation_owners.append(owner)
            sql = f"SELECT * FROM {_quote_ident(owner.alias)}"
            column_names, type_names = owner.describe(sql)
            return DuckDBNotebookPlan(owner, sql, column_names, type_names)
        except EngineError:
            if owner is not None:
                owner.close()
            with self._lifecycle_lock:
                if owner is not None and owner in self._notebook_relation_owners:
                    self._notebook_relation_owners.remove(owner)
            raise
        except Exception as error:
            if owner is not None:
                owner.close()
            with self._lifecycle_lock:
                if owner is not None and owner in self._notebook_relation_owners:
                    self._notebook_relation_owners.remove(owner)
            raise EngineError(f"DuckDB query failed: {error}") from error

    def interrupt(self) -> None:
        with self._lifecycle_lock:
            connections = list(self._active_connections)
        for connection in connections:
            try:
                connection.interrupt()
            except Exception:
                # Interrupt is best-effort. The correlated request remains the
                # authority for whether work completed or was cancelled.
                continue

    def close(self) -> None:
        with self._lifecycle_lock:
            if self._closed:
                return
            self._closed = True
            self._empty_source_frame = None
            owners = list(self._notebook_relation_owners)
            self._notebook_relation_owners.clear()
        for owner in owners:
            owner.close()

    def read_file(self, path: str, options: Mapping[str, Any] | None = None) -> Any:
        options = options or {}
        extension = Path(path).suffix.lower()
        try:
            with self._tracked_connection() as connection:
                if extension in {".csv", ".tsv"}:
                    encoding = str(options.get("encoding", "utf-8")).lower().replace("_", "-")
                    if encoding not in {"utf-8", "utf8"}:
                        raise EngineError(
                            f"DuckDB supports UTF-8 CSV input, not {encoding}. "
                            "Use the Pandas backend for this encoding."
                        )
                    if is_blank_delimited_file(path):
                        row_id = f"{INTERNAL_ROW_ID_PREFIX}empty_source"
                        frame = _snapshot_relation_factory(
                            lambda: connection.sql(f"SELECT CAST(NULL AS BIGINT) AS {_quote_ident(row_id)} WHERE FALSE")
                        )
                        self._empty_source_frame = frame
                        return frame
                    return _snapshot_relation_factory(
                        lambda: connection.read_csv(
                            path,
                            delimiter=options.get("delimiter", "\t" if extension == ".tsv" else ","),
                            encoding="utf-8",
                            quotechar=options.get("quoteChar", '"'),
                            header=options.get("hasHeader", True),
                        )
                    )
                if extension == ".parquet":
                    return _snapshot_relation_factory(lambda: connection.read_parquet(path))
                if extension in {".jsonl", ".ndjson"}:
                    try:
                        return _snapshot_relation_factory(
                            lambda: connection.read_json(path, format="newline_delimited")
                        )
                    except Exception as error:
                        if _json_reader_is_unavailable(error):
                            raise EngineError(
                                "DuckDB JSON support is unavailable in this interpreter. "
                                "Install a compatible DuckDB build explicitly; Open Wrangler will not fetch extensions."
                            ) from error
                        raise EngineError(f"DuckDB could not open {path} as newline-delimited JSON: {error}") from error
                if extension in {".xlsx", ".xls"}:
                    raise EngineError("DuckDB does not support Excel input. Use the Pandas or Polars backend.")
                raise EngineError(f"Unsupported file extension for DuckDB backend: {extension}")
        except EngineError:
            raise
        except Exception as error:
            raise EngineError(f"DuckDB could not open {path}: {error}") from error

    def shape(self, frame: Any) -> SessionDataShape:
        row_count = int(self._terminal_scalar(frame, "SELECT count(*) FROM ow") or 0)
        return {"rows": row_count, "columns": len(self._visible_columns(frame))}

    def validate_column_addressability(self, frame: Any) -> None:
        """DuckDB SQL identifiers cannot distinguish names by case alone."""

        by_casefold: dict[str, str] = {}
        for column in self._visible_columns(self.normalize(frame)):
            folded = column.casefold()
            previous = by_casefold.get(folded)
            if previous is not None:
                raise EngineError(
                    "DuckDB cannot safely address columns whose names differ only by case: "
                    f"{previous!r} and {column!r}. Rename one column or use Pandas/Polars."
                )
            by_casefold[folded] = column

    def validate_internal_row_id_namespace(self, frame: Any, allowed_internal: Any | None = None) -> None:
        # DuckDB cannot construct a relation with no columns. A blank delimited
        # source therefore uses one engine-owned, zero-row private sentinel that
        # stays invisible to schema, shape, pages, profiling, and exports.
        if allowed_internal is None and frame is self._empty_source_frame:
            return
        super().validate_internal_row_id_namespace(frame, allowed_internal)

    def ensure_row_ids(self, frame: Any, token: str) -> Any:
        frame = self.normalize(frame)
        if self._row_id_column(frame) is not None:
            return frame
        row_id = f"{INTERNAL_ROW_ID_PREFIX}{token}"
        return self._relation(frame, f"SELECT *, row_number() OVER () - 1 AS {_quote_ident(row_id)} FROM ow")

    def schema(self, frame: Any) -> list[dict[str, Any]]:
        frame = self.normalize(frame)
        visible = self._visible_columns(frame)
        type_by_column = dict(zip(self._columns(frame), frame.types, strict=True))
        return [
            {
                "id": f"c:{position}",
                "name": column,
                "position": position,
                "rawType": str(type_by_column[column]),
                "type": _semantic_type(str(type_by_column[column])),
                # DuckDB relation metadata does not carry reliable nullability.
                # Opening must remain metadata-only rather than profiling each
                # source column.
                "nullable": True,
            }
            for position, column in enumerate(visible)
        ]

    def apply_filter_model(self, frame: Any, model: Mapping[str, Any]) -> Any:
        frame = self.normalize(frame)
        type_by_column = dict(zip(self._columns(frame), (str(item) for item in frame.types), strict=True))
        for column_filter in model.get("filters", []):
            column = column_filter.get("column")
            if column not in type_by_column:
                continue
            actual_type = _semantic_type(type_by_column[column])
            if column_filter.get("type") != actual_type:
                raise EngineError(
                    f"DuckDB view filter for {column!r} declares {column_filter.get('type')!r}, "
                    f"but the relation column is {actual_type!r}."
                )
        for rule in model.get("sort", []):
            column = rule.get("column")
            if column not in type_by_column:
                continue
            column_type = _semantic_type(type_by_column[column])
            if column_type not in VIEW_COMPARABLE_TYPES:
                raise EngineError(f"DuckDB view sorting is unavailable for {column_type} columns.")
        query = _filter_query(self._columns(frame), model)
        return self._relation(frame, query)

    def page(
        self,
        frame: Any,
        offset: int,
        limit: int,
        *,
        total_rows: int | None = None,
        column_projection: PageColumnProjection | None = None,
    ) -> dict[str, Any]:
        frame = self.normalize(frame)
        if offset < 0 or limit < 0:
            raise EngineError("DuckDB page offset and limit must be non-negative.")
        visible = self._visible_columns(frame)
        projection = normalize_page_projection(len(visible), column_projection)
        selected_columns = [visible[position] for position, _identifier in projection]
        column_ids = [identifier for _position, identifier in projection]
        row_id = self._row_id_column(frame)
        terminal_columns = [*([row_id] if row_id is not None else []), *selected_columns]
        # DuckDB has no empty SELECT list. Session frames always have a private
        # row identity, while this literal preserves direct zero-column paging.
        select_list = _identifier_list(terminal_columns) if terminal_columns else "1 AS __ow_page_placeholder"
        with self._terminal_connection(frame) as (connection, source_sql):
            if total_rows is None:
                total_rows = int(_execute_scalar(connection, source_sql, "SELECT count(*) FROM ow") or 0)
            records = _execute_rows(
                connection,
                source_sql,
                f"SELECT {select_list} FROM ow LIMIT {int(limit)} OFFSET {int(offset)}",
            )
        rows = []
        for row_number, record in enumerate(records, start=offset):
            identity = record[0] if row_id is not None else row_number
            value_offset = 1 if row_id is not None else 0
            rows.append(
                {
                    "id": f"r:{row_id}:{identity}" if row_id is not None else f"r:{row_number}",
                    "rowNumber": row_number,
                    "values": [normalize_cell(record[value_offset + index]) for index in range(len(selected_columns))],
                }
            )
        return {
            "offset": offset,
            "limit": limit,
            "totalRows": int(total_rows),
            "columnIds": column_ids,
            "rows": rows,
        }

    def summaries(
        self,
        frame: Any,
        column_projection: SummaryColumnProjection | None = None,
    ) -> list[dict[str, Any]]:
        frame = self.normalize(frame)
        visible = self._visible_columns(frame)
        projection = normalize_summary_projection(len(visible), column_projection)
        selected = [(visible[position], column_id) for position, column_id in projection]
        if not selected:
            return []

        types = dict(zip(self._columns(frame), (str(item) for item in frame.types), strict=True))
        summaries: list[dict[str, Any]] = []
        with self._terminal_connection(frame) as (connection, source_sql):
            pending_histograms: list[tuple[dict[str, Any], float, float, list[str], int | None]] = []
            for column, column_id in selected:
                identifier = _quote_ident(column)
                raw_type = types[column]
                semantic_type = _semantic_type(raw_type)
                nan = _nan_predicate(identifier, raw_type)
                valid = _valid_predicate(identifier, raw_type)
                metric_fields = [
                    ("total_count", "count(*)"),
                    ("null_count", f"count(*) FILTER (WHERE {identifier} IS NULL)"),
                    ("nan_count", f"count(*) FILTER (WHERE {nan})"),
                    ("distinct_count", f"count(DISTINCT {identifier}) FILTER (WHERE {valid})"),
                ]
                if semantic_type == "string":
                    text_length = f"length(CAST({identifier} AS VARCHAR))"
                    metric_fields.extend(
                        [
                            ("empty_count", f"count(*) FILTER (WHERE {valid} AND {text_length} = 0)"),
                            ("minimum_length", f"min({text_length}) FILTER (WHERE {valid})"),
                            ("maximum_length", f"max({text_length}) FILTER (WHERE {valid})"),
                            ("mean_length", f"avg({text_length}) FILTER (WHERE {valid})"),
                        ]
                    )
                elif semantic_type in {"integer", "float", "decimal"}:
                    finite = _finite_predicate(identifier, raw_type)
                    metric_fields.extend(
                        [
                            ("minimum", f"min({identifier}) FILTER (WHERE {valid})"),
                            ("maximum", f"max({identifier}) FILTER (WHERE {valid})"),
                            ("mean", f"avg({identifier}) FILTER (WHERE {valid})"),
                            ("median", f"median({identifier}) FILTER (WHERE {valid})"),
                            ("std", f"stddev_samp({identifier}) FILTER (WHERE {valid})"),
                            ("sum", f"sum({identifier}) FILTER (WHERE {valid})"),
                            ("finite_minimum", f"min({identifier}) FILTER (WHERE {finite})"),
                            ("finite_maximum", f"max({identifier}) FILTER (WHERE {finite})"),
                            ("finite_count", f"count(*) FILTER (WHERE {finite})"),
                            (
                                "finite_distinct_count",
                                f"count(DISTINCT CAST({identifier} AS DOUBLE)) FILTER (WHERE {finite})",
                            ),
                        ]
                    )
                elif semantic_type == "boolean":
                    metric_fields.extend(
                        [
                            ("true_count", f"count(*) FILTER (WHERE {identifier} IS TRUE)"),
                            ("false_count", f"count(*) FILTER (WHERE {identifier} IS FALSE)"),
                        ]
                    )
                elif semantic_type in {"datetime", "date"}:
                    metric_fields.extend(
                        [
                            ("minimum", f"min({identifier}) FILTER (WHERE {identifier} IS NOT NULL)"),
                            ("maximum", f"max({identifier}) FILTER (WHERE {identifier} IS NOT NULL)"),
                        ]
                    )
                metric_row = _execute_rows(
                    connection,
                    source_sql,
                    f"SELECT {', '.join(expression for _name, expression in metric_fields)} FROM ow",
                )[0]
                metrics = dict(zip((name for name, _expression in metric_fields), metric_row, strict=True))
                total_count = int(metrics["total_count"] or 0)
                null_count = int(metrics["null_count"] or 0)
                nan_count = int(metrics["nan_count"] or 0)
                distinct_count = int(metrics["distinct_count"] or 0)
                top_rows = _execute_rows(
                    connection,
                    source_sql,
                    f"SELECT {identifier}, count(*) AS value_count FROM ow "
                    f"WHERE {valid} GROUP BY {identifier} "
                    f"ORDER BY value_count DESC, CAST({identifier} AS VARCHAR) ASC LIMIT 10",
                )
                top_values = [
                    {"value": normalize_cell(value)["display"], "count": int(count)} for value, count in top_rows
                ]
                summary: dict[str, Any] = {
                    "columnId": column_id,
                    "column": column,
                    "type": semantic_type,
                    "rawType": raw_type,
                    "totalCount": total_count,
                    "nullCount": null_count,
                    "nanCount": nan_count,
                    "distinctCount": distinct_count,
                    "topValues": top_values,
                }
                if semantic_type == "string":
                    text_summary: dict[str, int | float] = {"emptyCount": int(metrics["empty_count"] or 0)}
                    if metrics["minimum_length"] is not None:
                        text_summary.update(
                            {
                                "minLength": int(metrics["minimum_length"]),
                                "maxLength": int(metrics["maximum_length"]),
                                "meanLength": float(metrics["mean_length"]),
                            }
                        )
                    summary["text"] = text_summary
                    summary["visualization"] = categorical_visualization(
                        top_values, total_count - null_count - nan_count
                    )
                elif semantic_type in {"integer", "float", "decimal"}:
                    numeric_summary: dict[str, Any] = {
                        "min": _finite_float(metrics["minimum"]),
                        "max": _finite_float(metrics["maximum"]),
                        "mean": _finite_float(metrics["mean"]),
                        "median": _finite_float(metrics["median"]),
                        "std": _finite_float(metrics["std"]),
                    }
                    native_sum = metrics["sum"]
                    if total_count - null_count - nan_count == 0:
                        native_sum = _duckdb_numeric_zero(semantic_type, raw_type)
                    numeric_summary.update(normalized_numeric_sum(native_sum, semantic_type))
                    if semantic_type in {"integer", "decimal"} and metrics["minimum"] is not None:
                        numeric_summary["exactMin"] = normalize_cell(metrics["minimum"])
                        numeric_summary["exactMax"] = normalize_cell(metrics["maximum"])
                    summary["numeric"] = {key: value for key, value in numeric_summary.items() if value is not None}
                    visualization, minimum, maximum, count_expressions, native_bin_count = _numeric_histogram_plan(
                        identifier,
                        raw_type,
                        minimum=metrics["finite_minimum"],
                        maximum=metrics["finite_maximum"],
                        finite_count=int(metrics["finite_count"] or 0),
                        distinct_count=int(metrics["finite_distinct_count"] or 0),
                    )
                    if visualization is not None:
                        summary["visualization"] = visualization
                    else:
                        pending_histograms.append((summary, minimum, maximum, count_expressions, native_bin_count))
                elif semantic_type == "boolean":
                    summary["visualization"] = {
                        "kind": "boolean",
                        "trueCount": int(metrics["true_count"] or 0),
                        "falseCount": int(metrics["false_count"] or 0),
                    }
                elif semantic_type in {"datetime", "date"}:
                    summary["visualization"] = datetime_visualization(metrics["minimum"], metrics["maximum"])
                else:
                    summary["visualization"] = categorical_visualization(
                        top_values, total_count - null_count - nan_count
                    )
                summaries.append(summary)
            if pending_histograms:
                histogram_expressions = [
                    expression
                    for _summary, _minimum, _maximum, expressions, _native_bin_count in pending_histograms
                    for expression in expressions
                ]
                histogram_row = _execute_rows(
                    connection,
                    source_sql,
                    f"SELECT {', '.join(histogram_expressions)} FROM ow",
                )[0]
                histogram_offset = 0
                for summary, minimum, maximum, expressions, native_bin_count in pending_histograms:
                    histogram_end = histogram_offset + len(expressions)
                    histogram_counts = _numeric_histogram_counts(
                        histogram_row[histogram_offset:histogram_end],
                        native_bin_count,
                    )
                    summary["visualization"] = numeric_visualization_from_bin_counts(
                        minimum,
                        maximum,
                        histogram_counts,
                    )
                    histogram_offset = histogram_end
        return summaries

    def missing_count(self, frame: Any, column_position: int) -> int:
        columns = self._visible_columns(frame)
        if (
            not isinstance(column_position, int)
            or isinstance(column_position, bool)
            or column_position < 0
            or column_position >= len(columns)
        ):
            raise EngineError("The selected column is unavailable for missing-value counting.")
        column = columns[column_position]
        raw_types = dict(zip(self._columns(frame), (str(item) for item in frame.types), strict=True))
        identifier = _quote_ident(column)
        valid = _valid_predicate(identifier, raw_types[column])
        result = self._terminal_scalar(frame, f"SELECT count(*) FILTER (WHERE NOT ({valid})) FROM ow")
        return int(result or 0)

    def header_stats(self, frame: Any) -> dict[str, Any]:
        frame = self.normalize(frame)
        visible = self._visible_columns(frame)
        types = dict(zip(self._columns(frame), (str(item) for item in frame.types), strict=True))
        if not visible:
            rows = int(self._terminal_scalar(frame, "SELECT count(*) FROM ow") or 0)
            return {
                "missingCells": 0,
                "missingRows": 0,
                "duplicateRows": max(0, rows - 1),
                "missingValuesByColumn": [],
            }
        missing_expressions = [
            f"({_quote_ident(column)} IS NULL OR {_nan_predicate(_quote_ident(column), types[column])})"
            for column in visible
        ]
        missing_row_expression = " OR ".join(missing_expressions)
        group_columns = ", ".join(_quote_ident(column) for column in visible)
        group_count_column = _quote_ident(f"{INTERNAL_ROW_ID_PREFIX}header_group_count")
        # Exact duplicate detection already groups every visible value. Reuse
        # each group's multiplicity for the missing counts so the source is
        # executed once and only the final fixed-size aggregate reaches Python.
        grouped_source = f"SELECT {group_columns}, count(*) AS {group_count_column} FROM ow GROUP BY {group_columns}"
        projections = ", ".join(
            f"coalesce(sum({group_count_column}) FILTER (WHERE {expression}), 0)" for expression in missing_expressions
        )
        with self._terminal_connection(frame) as (connection, source_sql):
            if isinstance(frame, DuckDBSqlPlan):
                # The fused group can otherwise reserve one wide hash-table
                # partition per DuckDB worker. This connection is owned only
                # by the current file read and closes below, so the local pin
                # cannot change another request or a user's notebook relation.
                connection.execute("SET threads = 1")
                counts = _execute_rows(
                    connection,
                    source_sql,
                    f"SELECT {projections}, "
                    f"coalesce(sum({group_count_column}) FILTER (WHERE {missing_row_expression}), 0), "
                    f"coalesce(sum({group_count_column} - 1), 0) "
                    f"FROM ({grouped_source}) AS groups",
                )[0]
            else:
                # Live notebook relations execute on the user's connection.
                # Retain the two-query shape instead of changing its settings.
                missing_projections = ", ".join(
                    f"count(*) FILTER (WHERE {expression})" for expression in missing_expressions
                )
                missing_counts = _execute_rows(
                    connection,
                    source_sql,
                    f"SELECT {missing_projections}, count(*) FILTER (WHERE {missing_row_expression}) FROM ow",
                )[0]
                duplicate_rows = int(
                    _execute_scalar(
                        connection,
                        source_sql,
                        "SELECT coalesce(sum(group_count - 1), 0) FROM "
                        f"(SELECT count(*) AS group_count FROM ow GROUP BY {group_columns}) AS groups",
                    )
                    or 0
                )
                counts = (*missing_counts, duplicate_rows)
        per_column = [int(value or 0) for value in counts[:-2]]
        return {
            "missingCells": sum(per_column),
            "missingRows": int(counts[-2] or 0),
            "duplicateRows": int(counts[-1] or 0),
            "missingValuesByColumn": [
                {"column": column, "count": count} for column, count in zip(visible, per_column, strict=True)
            ],
        }

    def column_values(
        self, frame: Any, column: str, search: str | None = None, limit: int = 100
    ) -> tuple[list[dict[str, Any]], bool]:
        frame = self.normalize(frame)
        visible = self._visible_columns(frame)
        if column not in visible:
            raise EngineError(f"Unknown DuckDB column: {column}")
        types = dict(zip(self._columns(frame), (str(item) for item in frame.types), strict=True))
        column_type = infer_semantic_type(types[column])
        identifier = _quote_ident(column)
        conditions = [_valid_predicate(identifier, types[column])]
        if search:
            conditions.append(
                f"contains(translate(CAST({identifier} AS VARCHAR), {_sql_literal(_ASCII_UPPER)}, "
                f"{_sql_literal(_ASCII_LOWER)}), {_sql_literal(str(search).translate(_ASCII_TO_LOWER))})"
            )
        query = (
            f"SELECT {identifier}, count(*) AS value_count FROM ow WHERE {' AND '.join(conditions)} "
            f"GROUP BY {identifier} ORDER BY value_count DESC, CAST({identifier} AS VARCHAR) ASC "
            f"LIMIT {int(limit) + 1}"
        )
        rows = self._terminal_rows(frame, query)
        values = []
        for value, count in rows[:limit]:
            item: dict[str, Any] = {"value": normalize_cell(value)["display"], "count": int(count)}
            selection = typed_selection_value(value, column_type)
            if selection is not None:
                item["selectionValue"] = selection
            values.append(item)
        return values, len(rows) > limit

    def apply_transform(self, frame: Any, step: Mapping[str, Any]) -> Any:
        frame = self.normalize(frame)
        kind = str(step["kind"])
        params = step["params"]
        if kind == "sortRows":
            rules = [{**rule, "column": bound_column_name(rule["column"], kind)} for rule in params["rules"]]
            return self.apply_filter_model(frame, {"filters": [], "sort": rules})
        if kind == "filterRows":
            return self.apply_filter_model(frame, _bound_duckdb_filter_model(params["filterModel"]))
        if kind == "dropMissingRows":
            columns = (
                [bound_column_name(column, kind) for column in params["columns"]] if params.get("columns") else None
            )
            return self._drop_missing(frame, columns, params.get("how", "any"))
        if kind == "fillMissingValues":
            return self._fill_missing(
                frame,
                bound_column_name(params["column"], kind),
                params["replacement"],
            )
        if kind == "dropDuplicates":
            columns = (
                [bound_column_name(column, kind) for column in params["columns"]] if params.get("columns") else None
            )
            return self._drop_duplicates(frame, columns, params.get("keep", "first"))
        if kind == "selectColumns":
            row_id = self._row_id_column(frame)
            columns = [bound_column_name(value, kind) for value in params["columns"]]
            selected = [*([row_id] if row_id else []), *columns]
            return self._relation(frame, f"SELECT {_identifier_list(selected)} FROM ow")
        if kind == "dropColumns":
            columns = [bound_column_name(value, kind) for value in params["columns"]]
            return self._relation(frame, f"SELECT * EXCLUDE ({_identifier_list(columns)}) FROM ow")
        if kind == "renameColumn":
            column = bound_column_name(params["column"], kind)
            return self._relation(
                frame,
                f"SELECT * RENAME ({_quote_ident(column)} AS {_quote_ident(params['newName'])}) FROM ow",
            )
        if kind == "cloneColumn":
            column = bound_column_name(params["column"], kind)
            return self._assign(frame, params["newName"], _quote_ident(column))
        if kind == "castColumn":
            target_type = {
                "string": "VARCHAR",
                "integer": "BIGINT",
                "float": "DOUBLE",
                "boolean": "BOOLEAN",
                "date": "DATE",
                "datetime": "TIMESTAMP",
            }[params["dtype"]]
            column = bound_column_name(params["column"], kind)
            return self._assign(frame, column, f"try_cast({_quote_ident(column)} AS {target_type})")
        if kind == "formula":
            right = (
                _quote_ident(bound_column_name(params["rightColumn"], kind))
                if params.get("rightColumn")
                else _sql_literal(params["value"])
            )
            left = bound_column_name(params["leftColumn"], kind)
            expression = _formula_expression(_quote_ident(left), right, params["operator"])
            return self._assign(frame, params["newColumn"], expression)
        if kind == "textLength":
            column = bound_column_name(params["column"], kind)
            return self._assign(
                frame,
                params["newColumn"],
                f"length(CAST({_quote_ident(column)} AS VARCHAR))",
            )
        if kind == "oneHotEncode":
            native_params = {
                **params,
                "columns": [bound_column_name(column, kind) for column in params["columns"]],
            }
            return self._one_hot(frame, native_params)
        if kind == "multiLabelBinarize":
            native_params = {**params, "column": bound_column_name(params["column"], kind)}
            return self._multi_label(frame, native_params)
        if kind == "splitTextColumns":
            native_params = {**params, "column": bound_column_name(params["column"], kind)}
            return self._split_text_columns(frame, native_params)
        if kind == "pivotLonger":
            selected = [bound_column_name(column, kind) for column in params["columns"]]
            outputs = [params["labelColumn"], params["valueColumn"]]
            columns = self._columns(frame)
            _ensure_duckdb_pivot_output_columns_available(columns, outputs)
            types = dict(zip(columns, (str(item) for item in frame.types), strict=True))
            if any(types[name] != types[selected[0]] for name in selected[1:]):
                raise EngineError("Pivot-longer columns must have one exactly compatible DuckDB type.")
            row_count = self.shape(frame)["rows"]
            if row_count is None:
                raise EngineError("Pivot longer requires an exact input row count before execution.")
            try:
                checked_pivot_longer_row_count(row_count, len(selected))
            except PivotLongerContractError as error:
                raise EngineError(str(error)) from error
            visible = self._visible_columns(frame)
            unselected = [name for name in visible if name not in set(selected)]
            source_order = _unique_internal(columns, "__ow_pivot_source_order")
            pivot_order = _unique_internal([*columns, source_order], "__ow_pivot_selected_order")
            # The private row identity belongs to the source capture, so it may
            # no longer describe the current relation order after an earlier
            # committed sort. Pivoting creates fresh row identities anyway;
            # derive this transient ordinal from the current relation so live
            # execution preserves the same order as generated code.
            source = "SELECT *, row_number() OVER () - 1 AS " + _quote_ident(source_order) + " FROM ow"
            branches = []
            for ordinal, selected_name in enumerate(selected):
                projections = [*(_quote_ident(name) for name in unselected)]
                projections.extend(
                    (
                        f"{_sql_literal(selected_name)} AS {_quote_ident(params['labelColumn'])}",
                        f"{_quote_ident(selected_name)} AS {_quote_ident(params['valueColumn'])}",
                        f"{ordinal} AS {_quote_ident(pivot_order)}",
                        _quote_ident(source_order),
                    )
                )
                branches.append("SELECT " + ", ".join(projections) + " FROM pivot_source")
            query = (
                "WITH pivot_source AS ("
                + source
                + "), pivot_rows AS ("
                + " UNION ALL ".join(branches)
                + ") SELECT * EXCLUDE ("
                + _identifier_list([pivot_order, source_order])
                + ") FROM pivot_rows ORDER BY "
                + _identifier_list([pivot_order, source_order])
            )
            return self._relation(frame, query)
        if kind == "pivotWider":
            identifiers, output_values, output_names, identifier_expressions = self._validate_pivot_wider(frame, params)
            names_from = bound_column_name(params["namesFrom"], kind)
            values_from = bound_column_name(params["valuesFrom"], kind)
            columns = self._columns(frame)
            types = dict(zip(columns, (str(item) for item in frame.types), strict=True))
            source_order = _unique_internal(columns, "__ow_pivot_wider_source_order")
            reserved = [*columns, source_order]
            group_marker = _unique_internal(reserved, "__ow_pivot_wider_group")
            reserved.append(group_marker)
            identifier_keys = []
            for index, _identifier in enumerate(identifiers):
                key = _unique_internal(reserved, f"__ow_pivot_wider_identifier_{index}")
                reserved.append(key)
                identifier_keys.append(key)
            names_key_name = _unique_internal(reserved, "__ow_pivot_wider_names_key")
            names_key = _case_sensitive_group_value(f"CAST({_quote_ident(names_from)} AS VARCHAR)", "VARCHAR")
            group_columns = identifier_keys or [group_marker]
            source_projection = "*"
            if identifier_expressions:
                source_projection += ", " + ", ".join(
                    f"{expression} AS {_quote_ident(key)}"
                    for expression, key in zip(identifier_expressions, identifier_keys, strict=True)
                )
            source_projection += f", {names_key} AS {_quote_ident(names_key_name)}"
            if not identifiers:
                source_projection += f", 0 AS {_quote_ident(group_marker)}"
            source_projection += f", row_number() OVER () - 1 AS {_quote_ident(source_order)}"
            projections = [
                "first(CASE WHEN "
                + _valid_predicate(_quote_ident(name), types[name])
                + " THEN "
                + _quote_ident(name)
                + " ELSE NULL END ORDER BY "
                + _quote_ident(source_order)
                + ") AS "
                + _quote_ident(name)
                for name in identifiers
            ]
            projections.extend(
                (
                    "first("
                    + _quote_ident(values_from)
                    + ") FILTER (WHERE "
                    + _quote_ident(names_key_name)
                    + " = encode("
                    + _sql_literal(key_value)
                    + ")"
                    + ") AS "
                    + _quote_ident(output_name)
                )
                for key_value, output_name in zip(output_values, output_names, strict=True)
            )
            projections.append(f"min({_quote_ident(source_order)}) AS {_quote_ident(source_order)}")
            select_list = ", ".join(projections)
            query = (
                f"WITH pivot_source AS (SELECT {source_projection} FROM ow), pivot_rows AS ("
                f"SELECT {select_list} FROM pivot_source GROUP BY {_identifier_list(group_columns)}"
                f") SELECT * EXCLUDE ({_quote_ident(source_order)}) FROM pivot_rows "
                f"ORDER BY {_quote_ident(source_order)}"
            )
            return self._relation(frame, query)
        if kind == "extractRegexGroup":
            column = bound_column_name(params["column"], kind)
            _ensure_duckdb_output_columns_available(self._columns(frame), [params["newColumn"]], "Regex extraction")
            source = f"CAST({_quote_ident(column)} AS VARCHAR)"
            oversized = self._terminal_scalar(
                frame,
                f"SELECT coalesce(bool_or(length({source}) > {MAX_PORTABLE_REGEX_TEXT_CODE_POINTS} OR "
                f"octet_length(encode({source})) > {MAX_PORTABLE_REGEX_TEXT_UTF8_BYTES}), FALSE) FROM ow",
            )
            if bool(oversized):
                raise EngineError(PORTABLE_REGEX_TEXT_LIMIT_MESSAGE)
            expression = _regex_extract_expression(column, params["pattern"], params["group"])
            return self._assign(frame, params["newColumn"], expression)
        if kind in {"findReplace", "stripText", "splitText", "capitalizeText", "lowerText", "upperText"}:
            native_params = {**params, "column": bound_column_name(params["column"], kind)}
            if kind == "stripText" and native_params.get("characters") is None:
                native_params["characters"] = DEFAULT_STRIP_CHARACTERS
            return self._text_transform(frame, kind, native_params)
        if kind == "minMaxScale":
            column = bound_column_name(params["column"], kind)
            return self._min_max(frame, column, params.get("newColumn", column))
        if kind in {"roundNumber", "floorNumber", "ceilNumber"}:
            column = bound_column_name(params["column"], kind)
            target = params.get("newColumn", column)
            value = f"try_cast({_quote_ident(column)} AS DOUBLE)"
            if kind == "roundNumber":
                expression = f"round_even({value}, {int(params.get('decimals', 0))})"
            elif kind == "floorNumber":
                expression = f"floor({value})"
            else:
                expression = f"ceil({value})"
            return self._assign(frame, target, expression)
        if kind == "formatDatetime":
            column = bound_column_name(params["column"], kind)
            return self._assign(
                frame,
                params.get("newColumn", column),
                f"strftime(try_cast({_quote_ident(column)} AS TIMESTAMP), {_sql_literal(params['format'])})",
            )
        if kind == "groupBy":
            return self._group_by(frame, _bound_duckdb_group_params(params))
        if kind == "byExample":
            return self._assign(frame, params["newColumn"], _by_example_expression(params["program"]))
        if kind == "customCode":
            visible = self._visible_relation(frame)
            with self._terminal_connection(visible) as (connection, source_sql):
                result_sql = _custom_result_sql(connection, source_sql, str(params["code"]))
            # Rebind the SQL on another hardened connection. This rejects
            # results that depend on a custom connection's temporary objects
            # and guarantees no custom relation owner enters session state.
            return self._relation_from_sql(result_sql)
        raise EngineError(f"DuckDB does not implement transformation: {kind}")

    def _validate_pivot_wider(
        self,
        frame: Any,
        params: Mapping[str, Any],
    ) -> tuple[list[str], list[str], list[str], list[str]]:
        source = self.normalize(frame)
        names_from = bound_column_name(params["namesFrom"], "pivotWider")
        values_from = bound_column_name(params["valuesFrom"], "pivotWider")
        output_values = [pivot_wider_key_value(output["key"], "pivotWider.outputs.key") for output in params["outputs"]]
        output_names = [str(output["name"]) for output in params["outputs"]]
        columns = self._columns(source)
        visible = self._visible_columns(source)
        identifiers = [name for name in visible if name not in {names_from, values_from}]
        output_keys = [portable_pivot_wider_name_key(name) for name in output_names]
        existing = {portable_pivot_wider_name_key(name): name for name in identifiers}
        addressable = [name.casefold() for name in output_names]
        existing_addressable = {name.casefold(): name for name in identifiers}
        if (
            len(set(output_keys)) != len(output_keys)
            or any(key in existing for key in output_keys)
            or len(set(addressable)) != len(addressable)
            or any(key in existing_addressable for key in addressable)
        ):
            raise EngineError("Pivot wider would create a DuckDB column name that is not uniquely addressable.")
        if any(is_internal_row_id_label(name) for name in output_names):
            raise EngineError("Pivot wider would create Open Wrangler's reserved private row-identity column.")
        types = dict(zip(columns, (str(item) for item in source.types), strict=True))
        if types[names_from].upper() != "VARCHAR" and not types[names_from].upper().startswith("ENUM("):
            raise EngineError("Pivot-wider namesFrom must be a DuckDB text or enum column.")
        identifier_expressions = [_duckdb_pivot_wider_identifier_expression(name, types[name]) for name in identifiers]
        names_key = _case_sensitive_group_value(f"CAST({_quote_ident(names_from)} AS VARCHAR)", "VARCHAR")
        allowed = ", ".join(f"encode({_sql_literal(value)})" for value in output_values)
        invalid = self._terminal_scalar(
            source,
            "SELECT 1 FROM ow WHERE "
            + _quote_ident(names_from)
            + " IS NULL OR "
            + names_key
            + " NOT IN ("
            + allowed
            + ") LIMIT 1",
        )
        if invalid is not None:
            raise EngineError("Pivot wider namesFrom values must be present and match one declared typed key.")
        reserved = list(columns)
        identifier_keys = []
        for index, _identifier in enumerate(identifiers):
            key = _unique_internal(reserved, f"__ow_pivot_wider_identifier_{index}")
            reserved.append(key)
            identifier_keys.append(key)
        names_key_name = _unique_internal(reserved, "__ow_pivot_wider_names_key")
        normalized_projection = ", ".join(
            [
                *(
                    f"{expression} AS {_quote_ident(key)}"
                    for expression, key in zip(identifier_expressions, identifier_keys, strict=True)
                ),
                f"{names_key} AS {_quote_ident(names_key_name)}",
            ]
        )
        duplicate_columns = [*identifier_keys, names_key_name]
        duplicate = self._terminal_scalar(
            source,
            f"WITH normalized AS (SELECT {normalized_projection} FROM ow) SELECT 1 FROM normalized GROUP BY "
            + _identifier_list(duplicate_columns)
            + " HAVING count(*) > 1 LIMIT 1",
        )
        if duplicate is not None:
            raise EngineError("Pivot wider found duplicate identifier-and-key rows; aggregation is not supported.")
        return identifiers, output_values, output_names, identifier_expressions

    def validate_transform_preflight(
        self,
        frame: Any,
        step: Mapping[str, Any],
        input_shape: SessionDataShape,
    ) -> None:
        if step.get("kind") == "pivotWider":
            self._validate_pivot_wider(frame, step["params"])
            return
        if step.get("kind") != "pivotLonger":
            return
        source = self.normalize(frame)
        params = step["params"]
        selected = [bound_column_name(column, "pivotLonger") for column in params["columns"]]
        columns = self._columns(source)
        _ensure_duckdb_pivot_output_columns_available(
            columns,
            [params["labelColumn"], params["valueColumn"]],
        )
        types = dict(zip(columns, (str(item) for item in source.types), strict=True))
        if any(types[name] != types[selected[0]] for name in selected[1:]):
            raise EngineError("Pivot-longer columns must have one exactly compatible DuckDB type.")

    def compile_plan(self, steps: Iterable[Mapping[str, Any]]) -> str:
        plan = list(steps)
        if plan and all(step["kind"] == "renameColumn" for step in plan):
            query = "SELECT * FROM ow"
            for step in plan:
                params = step["params"]
                column = bound_column_name(params["column"], "renameColumn")
                query = f"SELECT * RENAME ({_quote_ident(column)} AS {_quote_ident(params['newName'])}) FROM ({query})"
            return f"def clean_data(df):\n    return df.query('ow', {query!r})\n"
        generated_helpers = _GENERATED_HELPERS.rstrip()
        if any(step["kind"] in {"oneHotEncode", "multiLabelBinarize"} for step in plan):
            generated_helpers = f"from collections import Counter\n\n{generated_helpers}"
        has_custom_code = any(step["kind"] == "customCode" for step in plan)
        lines = [
            *(custom_code_prelude_lines() if has_custom_code else []),
            generated_helpers,
            "",
            *generated_view_value_helper_lines(),
        ]
        for index, step in enumerate(plan):
            if step["kind"] == "customCode":
                lines.extend(custom_code_definition_lines(str(step["params"]["code"]), index=index))
        lines.append("def clean_data(df):")
        for index, step in enumerate(plan):
            lines.extend(self._compile_step(step, index))
        lines.append("    return df")
        return "\n".join(lines) + "\n"

    def export_data(
        self,
        frame: Any,
        path: str | os.PathLike[str],
        options: ExportOptions,
    ) -> None:
        normalized = self.validate_export_options(options)
        format_name = normalized["format"]
        frame = self.normalize(frame)
        row_id = self._row_id_column(frame)
        query = "SELECT * FROM ow" if row_id is None else f"SELECT * EXCLUDE ({_quote_ident(row_id)}) FROM ow"
        try:
            with self._terminal_connection(frame) as (connection, source_sql):
                destination = path if isinstance(path, ExportWriterPath) else os.fspath(path)
                _write_relation_export(connection, _compose_sql(source_sql, query), destination, normalized)
        except EngineError:
            raise
        except Exception as error:
            raise EngineError(f"DuckDB {format_name} export failed: {error}") from error

    def validate_export_options(self, options: ExportOptions) -> dict[str, Any]:
        normalized = super().validate_export_options(options)
        if normalized["format"] == "csv":
            encoding = normalized["encoding"].lower().replace("_", "-")
            if encoding not in {"utf-8", "utf8"}:
                raise EngineError("DuckDB CSV export supports UTF-8 encoding only.")
            for field in ("delimiter", "quoteChar"):
                if len(normalized[field].encode("utf-8")) != 1:
                    raise EngineError(f"DuckDB CSV export {field} must encode as exactly one UTF-8 byte.")
        return normalized

    def _compile_step(self, step: Mapping[str, Any], index: int) -> list[str]:
        kind = str(step["kind"])
        params = step["params"]
        prefix = "    "
        if kind == "sortRows":
            rules = [{**rule, "column": bound_column_name(rule["column"], kind)} for rule in params["rules"]]
            return [f"{prefix}df = _ow_query(df, {_filter_query([], {'filters': [], 'sort': rules})!r})"]
        if kind == "filterRows":
            # The runtime helper receives the current columns so unknown saved
            # filters remain ignorable after an earlier drop/rename step.
            model = _bound_duckdb_filter_model(params["filterModel"])
            for column_filter in model.get("filters", []):
                for predicate in column_filter.get("predicates", []):
                    validate_view_predicate_operator(column_filter.get("type"), predicate.get("operator"))
            return [f"{prefix}df = _ow_filter(df, {model!r})"]
        if kind == "dropMissingRows":
            columns = (
                [bound_column_name(column, kind) for column in params["columns"]] if params.get("columns") else None
            )
            return [f"{prefix}df = _ow_drop_missing(df, {columns!r}, {params.get('how', 'any')!r})"]
        if kind == "fillMissingValues":
            column = bound_column_name(params["column"], kind)
            replacement = params["replacement"]
            if replacement.get("kind") == "fallbackColumns":
                fallback_columns = [bound_column_name(fallback, kind) for fallback in replacement["columns"]]
                return [(f"{prefix}df = _ow_fill_missing_from_columns(df, {column!r}, {fallback_columns!r})")]
            if replacement.get("kind") == "directional":
                order_rules = [
                    {
                        **rule,
                        "column": bound_column_name(rule["column"], kind),
                    }
                    for rule in replacement["orderBy"]
                ]
                return [
                    (
                        f"{prefix}df = _ow_fill_missing_directional("
                        f"df, {column!r}, {order_rules!r}, {replacement['direction']!r}, "
                        f"{replacement.get('maxGap')!r})"
                    )
                ]
            if replacement.get("kind") == "groupedStatistic":
                keys = [bound_column_name(key, kind) for key in replacement["keys"]]
                return [
                    (
                        f"{prefix}df = _ow_fill_missing_grouped_statistic("
                        f"df, {column!r}, {keys!r}, {replacement['statistic']!r})"
                    )
                ]
            if replacement.get("kind") == "linearInterpolation":
                coordinate = bound_column_name(replacement["coordinate"], kind)
                return [
                    (
                        f"{prefix}df = _ow_fill_missing_linear_interpolation("
                        f"df, {column!r}, {coordinate!r}, {replacement.get('maxGap')!r})"
                    )
                ]
            if replacement.get("kind") in {"mean", "median", "mostFrequent"}:
                return [f"{prefix}df = _ow_fill_missing(df, {column!r}, {replacement['kind']!r}, None)"]
            value = generated_fill_replacement_expression(replacement)
            return [f"{prefix}df = _ow_fill_missing(df, {column!r}, {replacement['kind']!r}, {value})"]
        if kind == "dropDuplicates":
            columns = (
                [bound_column_name(column, kind) for column in params["columns"]] if params.get("columns") else None
            )
            return [f"{prefix}df = _ow_drop_duplicates(df, {columns!r}, {params.get('keep', 'first')!r})"]
        if kind == "selectColumns":
            columns = [bound_column_name(value, kind) for value in params["columns"]]
            return [f"{prefix}df = _ow_select(df, {columns!r})"]
        if kind == "dropColumns":
            columns = [bound_column_name(value, kind) for value in params["columns"]]
            return [f"{prefix}df = _ow_query(df, 'SELECT * EXCLUDE (' + _ow_identifiers({columns!r}) + ') FROM ow')"]
        if kind == "renameColumn":
            column = bound_column_name(params["column"], kind)
            return [
                f"{prefix}df = _ow_query(df, 'SELECT * RENAME (' + _ow_ident({column!r}) "
                f"+ ' AS ' + _ow_ident({params['newName']!r}) + ') FROM ow')"
            ]
        if kind == "cloneColumn":
            column = bound_column_name(params["column"], kind)
            return [f"{prefix}df = _ow_assign(df, {params['newName']!r}, _ow_ident({column!r}))"]
        if kind == "castColumn":
            target = {
                "string": "VARCHAR",
                "integer": "BIGINT",
                "float": "DOUBLE",
                "boolean": "BOOLEAN",
                "date": "DATE",
                "datetime": "TIMESTAMP",
            }[params["dtype"]]
            column = bound_column_name(params["column"], kind)
            return [f"{prefix}df = _ow_assign(df, {column!r}, 'try_cast(' + _ow_ident({column!r}) + ' AS {target})')"]
        if kind == "formula":
            right = (
                f"_ow_ident({bound_column_name(params['rightColumn'], kind)!r})"
                if params.get("rightColumn")
                else f"_ow_literal({params['value']!r})"
            )
            left = bound_column_name(params["leftColumn"], kind)
            return [
                f"{prefix}df = _ow_assign(df, {params['newColumn']!r}, "
                f"_ow_formula(_ow_ident({left!r}), {right}, {params['operator']!r}))"
            ]
        if kind == "textLength":
            column = bound_column_name(params["column"], kind)
            return [
                f"{prefix}df = _ow_assign(df, {params['newColumn']!r}, "
                f"'length(CAST(' + _ow_ident({column!r}) + ' AS VARCHAR))')"
            ]
        if kind == "oneHotEncode":
            native_params = {
                **params,
                "columns": [bound_column_name(column, kind) for column in params["columns"]],
            }
            return [f"{prefix}df = _ow_one_hot(df, {native_params!r})"]
        if kind == "multiLabelBinarize":
            native_params = {**params, "column": bound_column_name(params["column"], kind)}
            return [f"{prefix}df = _ow_multi_label(df, {native_params!r})"]
        if kind == "splitTextColumns":
            native_params = {**params, "column": bound_column_name(params["column"], kind)}
            return [f"{prefix}df = _ow_split_text_columns(df, {native_params!r})"]
        if kind == "pivotLonger":
            native_params = {
                **params,
                "columns": [bound_column_name(column, kind) for column in params["columns"]],
            }
            return [f"{prefix}df = _ow_pivot_longer(df, {native_params!r})"]
        if kind == "pivotWider":
            native_params = {
                **params,
                "namesFrom": bound_column_name(params["namesFrom"], kind),
                "valuesFrom": bound_column_name(params["valuesFrom"], kind),
            }
            return [f"{prefix}df = _ow_pivot_wider(df, {native_params!r})"]
        if kind == "extractRegexGroup":
            column = bound_column_name(params["column"], kind)
            expression = _regex_extract_expression(column, params["pattern"], params["group"])
            source = f"CAST({_quote_ident(column)} AS VARCHAR)"
            query = (
                f"SELECT coalesce(bool_or(length({source}) > {MAX_PORTABLE_REGEX_TEXT_CODE_POINTS} OR "
                f"octet_length(encode({source})) > {MAX_PORTABLE_REGEX_TEXT_UTF8_BYTES}), FALSE) FROM ow"
            )
            return [
                (
                    f"{prefix}if (not {params['newColumn']!r} or '\\0' in {params['newColumn']!r} or "
                    f"'\\r' in {params['newColumn']!r} or '\\n' in {params['newColumn']!r} or "
                    f"any(0xD800 <= ord(char) <= 0xDFFF for char in {params['newColumn']!r}) or "
                    f"len({params['newColumn']!r}.encode('utf-8')) > 1024):"
                ),
                (
                    f"{prefix}    raise ValueError('Regex extraction output name must be bounded "
                    "single-line Unicode scalar text.')"
                ),
                f"{prefix}_ow_check_outputs(_ow_columns(df), [{params['newColumn']!r}], 'Regex extraction')",
                (
                    f"{prefix}if {params['newColumn']!r}.casefold() in "
                    f"{{str(name).casefold() for name in _ow_columns(df)}}:"
                ),
                (
                    f"{prefix}    raise ValueError('Regex extraction would create a DuckDB column name "
                    "that differs only by case.')"
                ),
                f"{prefix}if bool(_ow_query(df, {query!r}).fetchone()[0]):",
                f"{prefix}    raise ValueError({PORTABLE_REGEX_TEXT_LIMIT_MESSAGE!r})",
                f"{prefix}df = _ow_assign(df, {params['newColumn']!r}, {expression!r})",
            ]
        if kind in {"findReplace", "stripText", "splitText", "capitalizeText", "lowerText", "upperText"}:
            native_params = {**params, "column": bound_column_name(params["column"], kind)}
            if kind == "stripText" and native_params.get("characters") is None:
                native_params["characters"] = DEFAULT_STRIP_CHARACTERS
            return [f"{prefix}df = _ow_text(df, {kind!r}, {native_params!r})"]
        if kind == "minMaxScale":
            column = bound_column_name(params["column"], kind)
            return [f"{prefix}df = _ow_min_max(df, {column!r}, {params.get('newColumn', column)!r})"]
        if kind in {"roundNumber", "floorNumber", "ceilNumber"}:
            column = bound_column_name(params["column"], kind)
            target = params.get("newColumn", column)
            value = f"try_cast({_quote_ident(column)} AS DOUBLE)"
            expression = (
                f"round_even({value}, {int(params.get('decimals', 0))})"
                if kind == "roundNumber"
                else f"{'floor' if kind == 'floorNumber' else 'ceil'}({value})"
            )
            return [f"{prefix}df = _ow_assign(df, {target!r}, {expression!r})"]
        if kind == "formatDatetime":
            column = bound_column_name(params["column"], kind)
            expression = f"strftime(try_cast({_quote_ident(column)} AS TIMESTAMP), {_sql_literal(params['format'])})"
            return [f"{prefix}df = _ow_assign(df, {params.get('newColumn', column)!r}, {expression!r})"]
        if kind == "groupBy":
            return [f"{prefix}df = _ow_group_by(df, {_bound_duckdb_group_params(params)!r})"]
        if kind == "byExample":
            return [
                f"{prefix}df = _ow_assign(df, {params['newColumn']!r}, {_by_example_expression(params['program'])!r})"
            ]
        if kind == "customCode":
            return custom_code_step_lines(prefix=prefix, engine_name=self.name, index=index)
        raise EngineError(f"DuckDB cannot compile transformation: {kind}")

    @contextmanager
    def _tracked_connection(self) -> Iterator[Any]:
        with self._lifecycle_lock:
            if self._closed:
                raise EngineError("The DuckDB engine is closed.")
        connection = _connect()
        with self._lifecycle_lock:
            if self._closed:
                connection.close()
                raise EngineError("The DuckDB engine is closed.")
            self._active_connections.add(connection)
        failed = False
        try:
            yield connection
        except BaseException:
            failed = True
            raise
        finally:
            with self._lifecycle_lock:
                self._active_connections.discard(connection)
            try:
                connection.close()
            except Exception:
                if not failed:
                    raise

    def _relation(self, frame: Any, query: str) -> Any:
        source = self.normalize(frame)
        if isinstance(source, DuckDBNotebookPlan):
            sql = _compose_sql(source.sql, query)
            try:
                column_names, type_names = source.owner.describe(sql)
            except EngineError:
                raise
            except Exception as error:
                raise EngineError(f"DuckDB query failed: {error}") from error
            return DuckDBNotebookPlan(source.owner, sql, column_names, type_names)
        return self._relation_from_sql(_compose_sql(source.sql, query))

    def _relation_from_sql(self, sql: str) -> DuckDBSqlPlan:
        try:
            with self._tracked_connection() as connection:
                return _snapshot_relation_factory(lambda: connection.sql(sql))
        except EngineError:
            raise
        except Exception as error:
            raise EngineError(f"DuckDB query failed: {error}") from error

    @contextmanager
    def _terminal_connection(self, frame: Any) -> Iterator[tuple[Any, str]]:
        source = self.normalize(frame)
        if isinstance(source, DuckDBNotebookPlan):
            try:
                with source.owner.terminal() as terminal:
                    yield terminal, source.sql
                return
            except EngineError:
                raise
            except Exception as error:
                raise EngineError(f"DuckDB query failed: {error}") from error
        try:
            with self._tracked_connection() as connection:
                yield connection, source.sql
        except EngineError:
            raise
        except Exception as error:
            raise EngineError(f"DuckDB query failed: {error}") from error

    def _terminal_rows(self, frame: Any, query: str) -> list[tuple[Any, ...]]:
        with self._terminal_connection(frame) as (connection, source_sql):
            return _execute_rows(connection, source_sql, query)

    def _terminal_scalar(self, frame: Any, query: str) -> Any:
        with self._terminal_connection(frame) as (connection, source_sql):
            return _execute_scalar(connection, source_sql, query)

    def _columns(self, frame: Any) -> list[str]:
        return self.normalize(frame).columns

    def _row_id_column(self, frame: Any) -> str | None:
        return next((column for column in self._columns(frame) if column.startswith(INTERNAL_ROW_ID_PREFIX)), None)

    def _visible_columns(self, frame: Any) -> list[str]:
        return [column for column in self._columns(frame) if not column.startswith(INTERNAL_ROW_ID_PREFIX)]

    def _visible_relation(self, frame: Any) -> Any:
        row_id = self._row_id_column(frame)
        if row_id is None:
            return frame
        return self._relation(frame, f"SELECT * EXCLUDE ({_quote_ident(row_id)}) FROM ow")

    def _assign(self, frame: Any, target: str, expression: str) -> Any:
        modifier = (
            f"* REPLACE ({expression} AS {_quote_ident(target)})"
            if target in self._columns(frame)
            else f"*, {expression} AS {_quote_ident(target)}"
        )
        return self._relation(frame, f"SELECT {modifier} FROM ow")

    def _drop_missing(self, frame: Any, columns: Any, how: str) -> Any:
        selected = list(columns) if columns else self._visible_columns(frame)
        if not selected:
            return frame
        types = dict(zip(self._columns(frame), (str(item) for item in frame.types), strict=True))
        valid = [_valid_predicate(_quote_ident(column), types[column]) for column in selected]
        operator = " AND " if how == "any" else " OR "
        return self._relation(frame, f"SELECT * FROM ow WHERE {operator.join(f'({item})' for item in valid)}")

    def _fill_missing(self, frame: Any, column: str, replacement: Mapping[str, Any]) -> Any:
        if replacement.get("kind") == "fallbackColumns":
            return self._fill_missing_from_columns(
                frame,
                column,
                [bound_column_name(fallback, "fillMissingValues") for fallback in replacement["columns"]],
            )
        if replacement.get("kind") == "directional":
            order_rules = [
                {
                    **rule,
                    "column": bound_column_name(rule["column"], "fillMissingValues"),
                }
                for rule in replacement["orderBy"]
            ]
            return self._fill_missing_directional(
                frame,
                column,
                order_rules,
                replacement["direction"],
                replacement.get("maxGap"),
            )
        if replacement.get("kind") == "groupedStatistic":
            return self._fill_missing_grouped_statistic(
                frame,
                column,
                [bound_column_name(key, "fillMissingValues") for key in replacement["keys"]],
                replacement["statistic"],
            )
        if replacement.get("kind") == "linearInterpolation":
            return self._fill_missing_linear_interpolation(
                frame,
                column,
                bound_column_name(replacement["coordinate"], "fillMissingValues"),
                replacement.get("maxGap"),
            )
        types = dict(zip(self._columns(frame), (str(item) for item in frame.types), strict=True))
        raw_type = types[column]
        semantic_type = _semantic_type(raw_type)
        identifier = _quote_ident(column)
        valid = _valid_predicate(identifier, raw_type)
        missing = f"NOT ({valid})"

        if replacement.get("kind") == "mean":
            if semantic_type != "float":
                raise EngineError("Mean fill requires a floating-point column.")
            missing_count = int(self._terminal_scalar(frame, f"SELECT count(*) FILTER (WHERE {missing}) FROM ow"))
            if missing_count == 0:
                return frame
            positive_infinity = "CAST('Infinity' AS DOUBLE)"
            negative_infinity = "CAST('-Infinity' AS DOUBLE)"
            stats = self._terminal_rows(
                frame,
                (
                    f"SELECT count(*) FILTER (WHERE {valid} AND {identifier} = {positive_infinity}), "
                    f"count(*) FILTER (WHERE {valid} AND {identifier} = {negative_infinity}), "
                    f"max(abs({identifier})) FILTER (WHERE {valid} AND isfinite({identifier})) FROM ow"
                ),
            )[0]
            has_positive_infinity = int(stats[0]) > 0
            has_negative_infinity = int(stats[1]) > 0
            if has_positive_infinity and has_negative_infinity:
                raise EngineError("Cannot fill with the mean because positive and negative infinity make it undefined.")
            if has_positive_infinity:
                mean = float("inf")
            elif has_negative_infinity:
                mean = float("-inf")
            else:
                scale = stats[2]
                if scale is None:
                    raise EngineError(
                        "Cannot fill with the mean because the selected column has no present numeric values."
                    )
                scale = float(scale)
                if scale == 0:
                    mean = 0.0
                else:
                    scaled_mean = float(
                        self._terminal_scalar(
                            frame,
                            (
                                f"SELECT avg({identifier} / {_sql_literal(scale)}) "
                                f"FILTER (WHERE {valid} AND isfinite({identifier})) FROM ow"
                            ),
                        )
                    )
                    mean = max(-1.0, min(1.0, scaled_mean)) * scale
            replacement_sql = f"CAST({_sql_literal(mean)} AS {raw_type})"
            expression = f"CASE WHEN {missing} THEN {replacement_sql} ELSE {identifier} END"
            return self._assign(frame, column, expression)

        if replacement.get("kind") == "mostFrequent":
            missing_count = int(self._terminal_scalar(frame, f"SELECT count(*) FILTER (WHERE {missing}) FROM ow"))
            if missing_count == 0:
                return frame
            value_name = _unique_internal(self._columns(frame), "__ow_fill_value")
            count_name = _unique_internal([*self._columns(frame), value_name], "__ow_fill_count")
            winner_name = _unique_internal([*self._columns(frame), value_name, count_name], "__ow_fill_winner")
            ties_name = _unique_internal([*self._columns(frame), value_name, count_name, winner_name], "__ow_fill_ties")
            result = self._terminal_rows(
                frame,
                (
                    f"WITH counts AS (SELECT {identifier} AS {_quote_ident(value_name)}, "
                    f"count(*) AS {_quote_ident(count_name)} FROM ow WHERE {valid} GROUP BY {identifier}), "
                    f"winners AS (SELECT {_quote_ident(value_name)} FROM counts WHERE {_quote_ident(count_name)} = "
                    f"(SELECT max({_quote_ident(count_name)}) FROM counts)) "
                    f"SELECT any_value({_quote_ident(value_name)}) AS {_quote_ident(winner_name)}, "
                    f"count(*) AS {_quote_ident(ties_name)} FROM winners"
                ),
            )
            fill_value, tie_count = result[0]
            tie_count = int(tie_count)
            if tie_count == 0:
                raise EngineError("This column has no non-missing values. Choose a specific value.")
            if tie_count != 1:
                raise EngineError(
                    f"This column has no single most common value: {tie_count} values are tied. "
                    "Choose a specific value."
                )
            literal = _sql_literal(fill_value)
            expression = f"CASE WHEN {missing} THEN CAST({literal} AS {raw_type}) ELSE {identifier} END"
            return self._assign(frame, column, expression)

        if replacement.get("kind") == "median":
            if semantic_type == "float":
                median = self._terminal_scalar(
                    frame,
                    f"SELECT median({identifier}) FILTER (WHERE {valid}) FROM ow",
                )
                if median is None or (isinstance(median, float) and isnan(median)):
                    raise EngineError(
                        "Cannot fill with the median because the selected column has no present numeric values."
                    )
            else:
                count = int(self._terminal_scalar(frame, f"SELECT count(*) FROM ow WHERE {valid}"))
                if count == 0:
                    raise EngineError(
                        "Cannot fill with the median because the selected column has no present numeric values."
                    )
                offset = (count - 1) // 2
                limit = 2 if count % 2 == 0 else 1
                middle = self._terminal_rows(
                    frame,
                    f"SELECT {identifier} FROM ow WHERE {valid} ORDER BY {identifier} LIMIT {limit} OFFSET {offset}",
                )
                if len(middle) != limit:
                    raise EngineError("DuckDB could not retrieve the exact middle values for the median fill.")
                lower, upper = middle[0][0], middle[-1][0]
                if semantic_type == "integer":
                    median = exact_integer_median(lower, upper)
                elif semantic_type == "decimal":
                    precision, scale = _duckdb_decimal_spec(raw_type)
                    median = exact_decimal_median(lower, upper, precision, scale)
                else:
                    raise EngineError(f"Cannot calculate a numeric median for DuckDB type {raw_type}.")
            median_literal = _duckdb_decimal_literal(median) if semantic_type == "decimal" else _sql_literal(median)
            replacement_sql = f"CAST({median_literal} AS {raw_type})"
            expression = f"CASE WHEN {missing} THEN {replacement_sql} ELSE {identifier} END"
            return self._assign(frame, column, expression)

        fill_value = decode_fill_replacement(replacement)
        if semantic_type == "decimal":
            precision, scale = _duckdb_decimal_spec(raw_type)
            fill_value = decimal_at_scale(Decimal(fill_value), precision, scale)
        elif semantic_type == "datetime":
            fill_value = require_datetime_fill_awareness(fill_value, _duckdb_datetime_is_aware(raw_type))
        if semantic_type == "string" and replacement.get("kind") == "string":
            missing_count = int(self._terminal_scalar(frame, f"SELECT count(*) FILTER (WHERE {missing}) FROM ow"))
            if missing_count == 0:
                return frame
        literal = _duckdb_decimal_literal(fill_value) if isinstance(fill_value, Decimal) else _sql_literal(fill_value)
        if semantic_type == "unknown":
            expression = f"CASE WHEN {identifier} IS NULL THEN {literal} ELSE {identifier} END"
        elif semantic_type == "string" and replacement.get("kind") == "string":
            expression = f"CASE WHEN {missing} THEN CAST({literal} AS VARCHAR) ELSE CAST({identifier} AS VARCHAR) END"
        else:
            expression = f"CASE WHEN {missing} THEN CAST({literal} AS {raw_type}) ELSE {identifier} END"
        try:
            return self._assign(frame, column, expression)
        except EngineError as error:
            raise EngineError(
                f"The replacement value is incompatible with the selected DuckDB column: {error}"
            ) from error

    def _fill_missing_from_columns(self, frame: Any, target: str, fallbacks: list[str]) -> Any:
        types = dict(zip(self._columns(frame), (str(item) for item in frame.types), strict=True))
        target_type = types[target]
        target_semantic = _semantic_type(target_type)
        output_type = target_type

        fallback_types = [types[column] for column in fallbacks]
        if target_semantic == "string" and any(raw_type != target_type for raw_type in fallback_types):
            # Probe only values that can win the ordered chain. Compatible
            # public strings can stay in a closed ENUM/UUID domain, while an
            # unused later fallback must not widen an exact no-op.
            probe_target = _quote_ident(target)
            probe_remaining = f"NOT ({_valid_predicate(probe_target, target_type)})"
            widening_predicates = []
            for fallback, raw_type in zip(fallbacks, fallback_types, strict=True):
                identifier = _quote_ident(fallback)
                valid = _valid_predicate(identifier, raw_type)
                if raw_type != target_type:
                    widening_predicates.append(
                        f"(({probe_remaining}) AND ({valid}) AND try_cast({identifier} AS {target_type}) IS NULL)"
                    )
                probe_remaining = f"({probe_remaining}) AND NOT ({valid})"
            widening = " OR ".join(widening_predicates)
            if widening and bool(self._terminal_scalar(frame, f"SELECT coalesce(bool_or({widening}), FALSE) FROM ow")):
                # VARCHAR is the explicit, lossless DuckDB text widening and
                # is visible in the draft schema before apply.
                output_type = "VARCHAR"
        if target_type.lower() in {"float", "real"} and any(
            raw_type.lower() == "double" for raw_type in fallback_types
        ):
            raise EngineError(
                "A DOUBLE fallback cannot be represented exactly in a FLOAT target. "
                "Convert the target column to DOUBLE first."
            )
        if target_semantic in {"decimal", "datetime"} and any(raw_type != target_type for raw_type in fallback_types):
            raise EngineError(
                f"DuckDB {target_semantic} fallback columns must use the exact target type {target_type}. "
                "Convert the columns to one exact type before filling."
            )

        target_identifier = _quote_ident(target)
        target_missing = f"NOT ({_valid_predicate(target_identifier, target_type)})"
        remaining = target_missing
        fallback_expressions = []
        for fallback, raw_type in zip(fallbacks, fallback_types, strict=True):
            identifier = _quote_ident(fallback)
            valid = _valid_predicate(identifier, raw_type)
            fallback_expressions.append(
                f"CASE WHEN ({remaining}) AND ({valid}) THEN CAST({identifier} AS {output_type}) "
                f"ELSE NULL::{output_type} END"
            )
            remaining = f"({remaining}) AND NOT ({valid})"
        fallback_value = f"coalesce({', '.join(fallback_expressions)})"
        expression = (
            f"CASE WHEN {target_missing} AND ({fallback_value}) IS NOT NULL THEN {fallback_value} "
            f"ELSE CAST({target_identifier} AS {output_type}) END"
        )
        try:
            return self._assign(frame, target, expression)
        except EngineError as error:
            raise EngineError(
                f"A fallback column is incompatible with the selected DuckDB target column: {error}"
            ) from error

    def _fill_missing_directional(
        self,
        frame: Any,
        target: str,
        order_rules: Sequence[Mapping[str, Any]],
        direction: str,
        max_gap: int | None,
    ) -> Any:
        columns = self._columns(frame)
        types = dict(zip(columns, (str(item) for item in frame.types), strict=True))
        target_identifier = _quote_ident(target)
        valid = _valid_predicate(target_identifier, types[target])

        reserved = list(columns)
        original_name = _unique_internal(reserved, "__ow_directional_original")
        reserved.append(original_name)
        calculation_name = _unique_internal(reserved, "__ow_directional_calculation")
        reserved.append(calculation_name)
        previous_name = _unique_internal(reserved, "__ow_directional_previous")
        reserved.append(previous_name)
        next_name = _unique_internal(reserved, "__ow_directional_next")
        reserved.append(next_name)
        total_name = _unique_internal(reserved, "__ow_directional_total")
        reserved.append(total_name)
        candidate_name = _unique_internal(reserved, "__ow_directional_candidate")

        original = _quote_ident(original_name)
        calculation = _quote_ident(calculation_name)
        previous = _quote_ident(previous_name)
        following = _quote_ident(next_name)
        total = _quote_ident(total_name)
        candidate = _quote_ident(candidate_name)
        order_expressions = []
        for rule in order_rules:
            identifier = _quote_ident(rule["column"])
            expression = (
                f"CASE WHEN {_valid_predicate(identifier, types[rule['column']])} THEN {identifier} ELSE NULL END"
                if _is_float_type(types[rule["column"]])
                else identifier
            )
            order_expressions.append(
                f"{expression} {str(rule['direction']).upper()} NULLS {str(rule['nulls']).upper()}"
            )
        order = ", ".join(order_expressions)
        calculation_order = f"{order}, {original}"
        present_value = f"CASE WHEN {valid} THEN {target_identifier} ELSE NULL END"
        if direction == "forward":
            candidate_expression = (
                f"last_value({present_value} IGNORE NULLS) OVER (ORDER BY {calculation} "
                "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)"
            )
        else:
            candidate_expression = (
                f"first_value({present_value} IGNORE NULLS) OVER (ORDER BY {calculation} "
                "ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING)"
            )
        gap_size = f"coalesce({following}, {total} + 1) - coalesce({previous}, 0) - 1"
        eligible = f"NOT ({valid}) AND {candidate} IS NOT NULL"
        if max_gap is not None:
            eligible += f" AND ({gap_size}) <= {int(max_gap)}"
        replacement = f"CASE WHEN {eligible} THEN {candidate} ELSE {target_identifier} END"
        temporary_names = [
            original_name,
            calculation_name,
            previous_name,
            next_name,
            total_name,
            candidate_name,
        ]
        query = (
            f"WITH numbered AS (SELECT *, row_number() OVER () AS {original} FROM ow), "
            f"ordered AS (SELECT *, row_number() OVER (ORDER BY {calculation_order}) AS {calculation} "
            "FROM numbered), "
            f"context AS (SELECT *, max(CASE WHEN {valid} THEN {calculation} END) OVER (ORDER BY "
            f"{calculation} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS {previous}, "
            f"min(CASE WHEN {valid} THEN {calculation} END) OVER (ORDER BY {calculation} "
            f"ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS {following}, "
            f"count(*) OVER () AS {total}, {candidate_expression} AS {candidate} FROM ordered) "
            f"SELECT * EXCLUDE ({_identifier_list(temporary_names)}) REPLACE ("
            f"{replacement} AS {target_identifier}) FROM context ORDER BY {original}"
        )
        return self._relation(frame, query)

    def _fill_missing_linear_interpolation(
        self,
        frame: Any,
        target: str,
        coordinate: str,
        max_gap: int | None,
    ) -> Any:
        columns = self._columns(frame)
        types = dict(zip(columns, (str(item) for item in frame.types), strict=True))
        target_type = types[target]
        coordinate_type = types[coordinate]
        if _semantic_type(target_type) != "float":
            raise EngineError("Linear interpolation requires a floating-point target column.")
        if "hugeint" in coordinate_type.lower():
            raise EngineError(
                "Linear interpolation does not support HUGEINT coordinates; "
                "convert the coordinate to a narrower exact type first."
            )
        if _semantic_type(coordinate_type) not in {"integer", "float", "decimal", "date", "datetime"}:
            raise EngineError("Linear interpolation coordinates must be numeric, dates, or datetimes.")
        coordinate_identifier = _quote_ident(coordinate)
        minimum_coordinate = f"min({coordinate_identifier}) OVER ()"
        numeric_coordinate, coordinate_roundtrip = _duckdb_interpolation_coordinate_projection(
            coordinate_identifier,
            coordinate_type,
            minimum_coordinate,
        )
        coordinate_finite = _finite_predicate(coordinate_identifier, coordinate_type)
        validation_name = _unique_internal(columns, "__ow_interpolation_validation_coordinate")
        validation_exact_name = _unique_internal([*columns, validation_name], "__ow_interpolation_validation_exact")
        validation_identifier = _quote_ident(validation_name)
        validation_exact = _quote_ident(validation_exact_name)
        try:
            validation = self._terminal_rows(
                frame,
                (
                    f"WITH projected AS (SELECT *, {numeric_coordinate} AS {validation_identifier}, "
                    f"{coordinate_roundtrip} AS {validation_exact} FROM ow) "
                    "SELECT count(*), "
                    f"count(*) FILTER (WHERE NOT ({coordinate_finite})), "
                    f"count(DISTINCT {coordinate_identifier}), "
                    f"count(DISTINCT {validation_identifier}), "
                    f"coalesce(bool_and(isfinite({validation_identifier})), TRUE), "
                    f"coalesce(bool_and({validation_exact}), TRUE) FROM projected"
                ),
            )[0]
        except Exception as error:
            raise EngineError(
                "Linear interpolation cannot represent the selected coordinate distances exactly."
            ) from error
        count = int(validation[0])
        if int(validation[1]):
            raise EngineError("Linear interpolation requires every coordinate value to be present and finite.")
        if int(validation[2]) != count:
            raise EngineError("Linear interpolation requires unique coordinate values.")
        if int(validation[3]) != count or not bool(validation[4]) or not bool(validation[5]):
            raise EngineError(
                "Linear interpolation cannot preserve the selected coordinate distances exactly enough; "
                "choose a lower-precision coordinate column."
            )

        target_identifier = _quote_ident(target)
        target_present = _valid_predicate(target_identifier, target_type)
        target_missing = f"NOT ({target_present})"
        present_target = f"CASE WHEN {target_present} THEN {target_identifier} ELSE NULL END"

        reserved = list(columns)
        temporary_names = []
        for base in (
            "__ow_interpolation_original",
            "__ow_interpolation_calculation",
            "__ow_interpolation_coordinate",
            "__ow_interpolation_previous",
            "__ow_interpolation_next",
            "__ow_interpolation_left_value",
            "__ow_interpolation_right_value",
            "__ow_interpolation_left_coordinate",
            "__ow_interpolation_right_coordinate",
            "__ow_interpolation_weight",
        ):
            name = _unique_internal(reserved, base)
            reserved.append(name)
            temporary_names.append(name)
        (
            original_name,
            calculation_name,
            numeric_name,
            previous_name,
            next_name,
            left_value_name,
            right_value_name,
            left_coordinate_name,
            right_coordinate_name,
            weight_name,
        ) = temporary_names
        original = _quote_ident(original_name)
        calculation = _quote_ident(calculation_name)
        numeric = _quote_ident(numeric_name)
        previous = _quote_ident(previous_name)
        following = _quote_ident(next_name)
        left_value = _quote_ident(left_value_name)
        right_value = _quote_ident(right_value_name)
        left_coordinate = _quote_ident(left_coordinate_name)
        right_coordinate = _quote_ident(right_coordinate_name)
        weight = _quote_ident(weight_name)
        calculation_order = f"{coordinate_identifier} ASC, {original}"
        numeric_coordinate, _coordinate_roundtrip = _duckdb_interpolation_coordinate_projection(
            coordinate_identifier,
            coordinate_type,
            f"min({coordinate_identifier}) OVER ()",
        )
        left_value_expression = (
            f"last_value({present_target} IGNORE NULLS) OVER (ORDER BY {calculation} "
            "ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)"
        )
        right_value_expression = (
            f"first_value({present_target} IGNORE NULLS) OVER (ORDER BY {calculation} "
            "ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING)"
        )
        present_coordinate = f"CASE WHEN {target_present} THEN {numeric} ELSE NULL END"
        left_coordinate_expression = (
            f"last_value({present_coordinate} IGNORE NULLS) OVER (ORDER BY {calculation} "
            "ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)"
        )
        right_coordinate_expression = (
            f"first_value({present_coordinate} IGNORE NULLS) OVER (ORDER BY {calculation} "
            "ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING)"
        )
        span = f"({right_coordinate} - {left_coordinate})"
        direct_weight = f"(({numeric} - {left_coordinate}) / {span})"
        scaled_weight = (
            f"(({numeric} / 2.0 - {left_coordinate} / 2.0) / ({right_coordinate} / 2.0 - {left_coordinate} / 2.0))"
        )
        weight_expression = f"CASE WHEN isfinite({span}) THEN {direct_weight} ELSE {scaled_weight} END"
        gap_size = f"{following} - {previous} - 1"
        eligible = (
            f"{target_missing} AND isfinite({left_value}) AND isfinite({right_value}) "
            f"AND isfinite({weight}) AND {weight} BETWEEN 0.0 AND 1.0"
        )
        if max_gap is not None:
            eligible += f" AND {gap_size} <= {int(max_gap)}"
        interpolated = f"((1.0 - {weight}) * {left_value} + {weight} * {right_value})"
        replacement = f"CASE WHEN {eligible} THEN CAST({interpolated} AS {target_type}) ELSE {target_identifier} END"
        query = (
            f"WITH numbered AS (SELECT *, row_number() OVER () AS {original} FROM ow), "
            f"ordered AS (SELECT *, row_number() OVER (ORDER BY {calculation_order}) AS {calculation}, "
            f"{numeric_coordinate} AS {numeric} FROM numbered), "
            f"context AS (SELECT *, max(CASE WHEN {target_present} THEN {calculation} END) OVER "
            f"(ORDER BY {calculation} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS {previous}, "
            f"min(CASE WHEN {target_present} THEN {calculation} END) OVER "
            f"(ORDER BY {calculation} ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS {following}, "
            f"{left_value_expression} AS {left_value}, {right_value_expression} AS {right_value}, "
            f"{left_coordinate_expression} AS {left_coordinate}, "
            f"{right_coordinate_expression} AS {right_coordinate} FROM ordered), "
            f"weighted AS (SELECT *, {weight_expression} AS {weight} FROM context) "
            f"SELECT * EXCLUDE ({_identifier_list(temporary_names)}) REPLACE ("
            f"{replacement} AS {target_identifier}) FROM weighted ORDER BY {original}"
        )
        return self._relation(frame, query)

    def _fill_missing_grouped_statistic(
        self,
        frame: Any,
        target: str,
        keys: list[str],
        statistic: str,
    ) -> Any:
        columns = self._columns(frame)
        types = dict(zip(columns, (str(item) for item in frame.types), strict=True))
        target_type = types[target]
        target_identifier = _quote_ident(target)
        target_valid = _valid_predicate(target_identifier, target_type)
        target_missing = f"NOT ({target_valid})"

        reserved = list(columns)
        original_name = _unique_internal(reserved, "__ow_grouped_original")
        reserved.append(original_name)
        key_names = []
        for index, _key in enumerate(keys):
            name = _unique_internal(reserved, f"__ow_grouped_key_{index}")
            reserved.append(name)
            key_names.append(name)
        fill_name = _unique_internal(reserved, "__ow_grouped_fill")
        reserved.append(fill_name)
        count_name = _unique_internal(reserved, "__ow_grouped_count")
        reserved.append(count_name)
        maximum_name = _unique_internal(reserved, "__ow_grouped_maximum")
        reserved.append(maximum_name)

        original = _quote_ident(original_name)
        normalized_key_expressions = []
        for key, name in zip(keys, key_names, strict=True):
            identifier = _quote_ident(key)
            key_value = _case_sensitive_group_value(identifier, types[key])
            normalized_key_expressions.append(
                f"CASE WHEN {_valid_predicate(identifier, types[key])} THEN {key_value} ELSE NULL END "
                f"AS {_quote_ident(name)}"
            )
        normalized_keys = _identifier_list(key_names)
        partition = normalized_keys
        normalized = (
            f"normalized AS (SELECT *, row_number() OVER () AS {original}, "
            f"{', '.join(normalized_key_expressions)} FROM ow)"
        )

        if statistic == "mostFrequent":
            value_name = _unique_internal(reserved, "__ow_grouped_value")
            reserved.append(value_name)
            token_name = _unique_internal(reserved, "__ow_grouped_token")
            reserved.append(token_name)
            ties_name = _unique_internal(reserved, "__ow_grouped_ties")
            value = _quote_ident(value_name)
            token = _quote_ident(token_name)
            count = _quote_ident(count_name)
            maximum = _quote_ident(maximum_name)
            ties = _quote_ident(ties_name)
            fill = _quote_ident(fill_name)
            grouped_target = _case_sensitive_group_value(target_identifier, target_type)
            summary_ctes = (
                f"counts AS (SELECT {normalized_keys}, {grouped_target} AS {token}, "
                f"any_value({target_identifier}) AS {value}, count(*) AS {count} FROM normalized "
                f"WHERE {target_valid} GROUP BY {normalized_keys}, {grouped_target}), "
                f"ranked AS (SELECT *, max({count}) OVER (PARTITION BY {partition}) AS {maximum} FROM counts), "
                f"summary AS (SELECT {normalized_keys}, count(*) FILTER (WHERE {count} = {maximum}) AS {ties}, "
                f"CASE WHEN {ties} = 1 THEN any_value({value}) FILTER (WHERE {count} = {maximum}) "
                f"ELSE NULL END AS {fill} FROM ranked GROUP BY {normalized_keys})"
            )
        elif statistic == "mean":
            positive_name = _unique_internal(reserved, "__ow_grouped_positive")
            reserved.append(positive_name)
            negative_name = _unique_internal(reserved, "__ow_grouped_negative")
            reserved.append(negative_name)
            scale_name = _unique_internal(reserved, "__ow_grouped_scale")
            reserved.append(scale_name)
            scaled_name = _unique_internal(reserved, "__ow_grouped_scaled")
            positive = _quote_ident(positive_name)
            negative = _quote_ident(negative_name)
            scale = _quote_ident(scale_name)
            scaled = _quote_ident(scaled_name)
            fill = _quote_ident(fill_name)
            summary_ctes = (
                f"annotated AS (SELECT *, count(*) FILTER (WHERE {target_valid} AND {target_identifier} = "
                f"CAST('Infinity' AS DOUBLE)) OVER (PARTITION BY {partition}) AS {positive}, "
                f"count(*) FILTER (WHERE {target_valid} AND {target_identifier} = CAST('-Infinity' AS DOUBLE)) "
                f"OVER (PARTITION BY {partition}) AS {negative}, max(abs({target_identifier})) FILTER "
                f"(WHERE {target_valid} AND isfinite({target_identifier})) OVER (PARTITION BY {partition}) "
                f"AS {scale} FROM normalized), "
                f"scaled_rows AS (SELECT *, avg({target_identifier} / nullif({scale}, 0)) FILTER "
                f"(WHERE {target_valid} AND isfinite({target_identifier})) OVER (PARTITION BY {partition}) "
                f"AS {scaled} FROM annotated), "
                f"summary AS (SELECT DISTINCT {normalized_keys}, CASE WHEN {positive} > 0 AND {negative} > 0 "
                f"THEN NULL WHEN {positive} > 0 THEN CAST('Infinity' AS DOUBLE) WHEN {negative} > 0 THEN "
                f"CAST('-Infinity' AS DOUBLE) WHEN {scale} IS NULL THEN NULL WHEN {scale} = 0 THEN 0.0 "
                f"ELSE greatest(-1.0, least(1.0, {scaled})) * {scale} END AS {fill} FROM scaled_rows)"
            )
        else:
            lower_name = _unique_internal(reserved, "__ow_grouped_lower")
            reserved.append(lower_name)
            upper_name = _unique_internal(reserved, "__ow_grouped_upper")
            reserved.append(upper_name)
            missing_name = _unique_internal(reserved, "__ow_grouped_missing")
            lower = _quote_ident(lower_name)
            upper = _quote_ident(upper_name)
            missing_count = _quote_ident(missing_name)
            fill = _quote_ident(fill_name)
            semantic_type = _semantic_type(target_type)
            lower_aggregate = (
                f"quantile_disc({target_identifier}, 0.5 ORDER BY {target_identifier}) FILTER (WHERE {target_valid})"
            )
            upper_aggregate = (
                f"quantile_disc({target_identifier}, 0.5 ORDER BY {target_identifier} DESC) "
                f"FILTER (WHERE {target_valid})"
            )
            if semantic_type == "integer":
                fill_expression = (
                    f"CAST(({lower} // 2) + ({upper} // 2) + ((({lower} % 2) + ({upper} % 2)) // 2) AS {target_type})"
                )
                invalid = f"{missing_count} > 0 AND ((({lower} % 2) + ({upper} % 2)) % 2) <> 0"
            elif semantic_type == "decimal":
                fill_expression = f"median({target_identifier}) FILTER (WHERE {target_valid})"
                invalid = f"{missing_count} > 0 AND {fill} IS NOT NULL AND ({fill} - {lower}) <> ({upper} - {fill})"
            else:
                raw_median = f"median({target_identifier}) FILTER (WHERE {target_valid})"
                fill_expression = f"CASE WHEN isnan({raw_median}) THEN NULL ELSE {raw_median} END"
                invalid = "FALSE"
            summary_select = (
                f"SELECT {normalized_keys}, count(*) FILTER (WHERE {target_missing}) AS {missing_count}, "
                f"{lower_aggregate} AS {lower}, {upper_aggregate} AS {upper}, {fill_expression} AS {fill} "
                f"FROM normalized GROUP BY {normalized_keys}"
            )
            if invalid == "FALSE":
                summary_ctes = f"summary AS ({summary_select})"
            else:
                label = "integer" if semantic_type == "integer" else "decimal"
                message = (
                    f"A grouped {label} median cannot be represented exactly in the selected column. "
                    "Cast the column to a wider type before filling missing values."
                )
                checked_fill = f"CASE WHEN {invalid} THEN error({_sql_literal(message)}) ELSE {fill} END"
                summary_ctes = (
                    f"raw_summary AS ({summary_select}), summary AS (SELECT {normalized_keys}, "
                    f"{checked_fill} AS {fill} FROM raw_summary)"
                )

        normalized_join = " AND ".join(
            f"n.{_quote_ident(name)} IS NOT DISTINCT FROM s.{_quote_ident(name)}" for name in key_names
        )
        fill = f"s.{_quote_ident(fill_name)}"
        qualified_target = f"n.{target_identifier}"
        qualified_missing = target_missing.replace(target_identifier, qualified_target)
        replacement = (
            f"CASE WHEN {qualified_missing} AND {fill} IS NOT NULL THEN CAST({fill} AS {target_type}) "
            f"ELSE {qualified_target} END"
        )
        query = (
            f"WITH {normalized}, {summary_ctes} SELECT n.* EXCLUDE ({_identifier_list([original_name, *key_names])}) "
            f"REPLACE ({replacement} AS {target_identifier}) FROM normalized n LEFT JOIN summary s ON "
            f"{normalized_join} ORDER BY n.{original}"
        )
        return self._relation(frame, query)

    def _drop_duplicates(self, frame: Any, columns: Any, keep: str) -> Any:
        selected = list(columns) if columns else self._visible_columns(frame)
        if not selected:
            return frame
        order_name = _unique_internal(self._columns(frame), "__ow_dupe_order")
        rank_name = _unique_internal([*self._columns(frame), order_name], "__ow_dupe_rank")
        count_name = _unique_internal([*self._columns(frame), order_name, rank_name], "__ow_dupe_count")
        partition = _identifier_list(selected)
        direction = "DESC" if keep == "last" else "ASC"
        predicate = f"{_quote_ident(count_name)} = 1" if keep == "none" else f"{_quote_ident(rank_name)} = 1"
        query = (
            f"WITH numbered AS (SELECT *, row_number() OVER () AS {_quote_ident(order_name)} FROM ow), "
            f"ranked AS (SELECT *, row_number() OVER (PARTITION BY {partition} "
            f"ORDER BY {_quote_ident(order_name)} {direction}) AS {_quote_ident(rank_name)}, "
            f"count(*) OVER (PARTITION BY {partition}) AS {_quote_ident(count_name)} FROM numbered) "
            f"SELECT * EXCLUDE ({_identifier_list([order_name, rank_name, count_name])}) FROM ranked "
            f"WHERE {predicate} ORDER BY {_quote_ident(order_name)}"
        )
        return self._relation(frame, query)

    def _one_hot(self, frame: Any, params: Mapping[str, Any]) -> Any:
        columns = list(params["columns"])
        separator = params.get("prefixSeparator", "_")
        generated: list[tuple[str, Any, str]] = []
        for column in columns:
            for value in self._distinct_values(frame, column):
                generated.append((column, value, f"{column}{separator}{value}"))
        generated.sort(key=lambda item: item[2])
        base_columns = [
            column for column in self._columns(frame) if not params.get("dropOriginal", True) or column not in columns
        ]
        ensure_output_columns_available(base_columns, (name for _, _, name in generated), "One-hot encoding")
        projections = [_quote_ident(column) for column in base_columns]
        projections.extend(
            "CAST(CASE WHEN "
            f"{_quote_ident(column)} IS NOT DISTINCT FROM {_sql_literal(value)} THEN 1 ELSE 0 END AS TINYINT) "
            f"AS {_quote_ident(name)}"
            for column, value, name in generated
        )
        if not projections:
            raise EngineError("DuckDB cannot represent a dataframe with zero columns.")
        return self._relation(frame, f"SELECT {', '.join(projections)} FROM ow")

    def _multi_label(self, frame: Any, params: Mapping[str, Any]) -> Any:
        column = params["column"]
        delimiter = params["delimiter"]
        prefix = params.get("prefix", f"{column}_")
        identifier = _quote_ident(column)
        labels = [
            str(row[0])
            for row in self._terminal_rows(
                frame,
                "SELECT DISTINCT label FROM ow, "
                f"unnest(string_split(CAST({identifier} AS VARCHAR), {_sql_literal(delimiter)})) AS values(label) "
                "WHERE label IS NOT NULL AND label <> '' ORDER BY label",
            )
        ]
        base_columns = [
            name for name in self._columns(frame) if not params.get("dropOriginal", False) or name != column
        ]
        generated_names = [f"{prefix}{label}" for label in labels]
        ensure_output_columns_available(base_columns, generated_names, "Multi-label binarization")
        projections = [_quote_ident(name) for name in base_columns]
        projections.extend(
            "CAST(list_contains(string_split(coalesce(CAST("
            f"{identifier} AS VARCHAR), ''), {_sql_literal(delimiter)}), {_sql_literal(label)}) AS TINYINT) "
            f"AS {_quote_ident(name)}"
            for label, name in zip(labels, generated_names, strict=True)
        )
        if not projections:
            raise EngineError("DuckDB cannot represent a dataframe with zero columns.")
        return self._relation(frame, f"SELECT {', '.join(projections)} FROM ow")

    def _distinct_values(self, frame: Any, column: str) -> list[Any]:
        identifier = _quote_ident(column)
        types = dict(zip(self._columns(frame), (str(item) for item in frame.types), strict=True))
        valid = _valid_predicate(identifier, types[column])
        rows = self._terminal_rows(
            frame,
            f"SELECT DISTINCT {identifier} FROM ow WHERE {valid} "
            f"AND CAST({identifier} AS VARCHAR) <> '' ORDER BY CAST({identifier} AS VARCHAR)",
        )
        return [row[0] for row in rows]

    def _text_transform(self, frame: Any, kind: str, params: Mapping[str, Any]) -> Any:
        column = params["column"]
        target = params.get("newColumn", column)
        value = f"CAST({_quote_ident(column)} AS VARCHAR)"
        if kind == "findReplace":
            if not params.get("regex", False) and params["find"] == "":
                replacement = _sql_literal(params["replacement"])
                expression = (
                    f"CASE WHEN {value} = '' THEN {replacement} ELSE {replacement} || "
                    f"array_to_string(string_split({value}, ''), {replacement}) || {replacement} END"
                )
            else:
                function = "regexp_replace" if params.get("regex", False) else "replace"
                suffix = ", 'g'" if params.get("regex", False) else ""
                expression = (
                    f"{function}({value}, {_sql_literal(params['find'])}, "
                    f"{_sql_literal(params['replacement'])}{suffix})"
                )
        elif kind == "stripText":
            characters = params.get("characters") or DEFAULT_STRIP_CHARACTERS
            expression = f"trim({value}, {_sql_literal(characters)})"
        elif kind == "splitText":
            expression = f"string_split({value}, {_sql_literal(params['delimiter'])})[{int(params['index']) + 1}]"
        elif kind == "capitalizeText":
            expression = f"upper(substr({value}, 1, 1)) || lower(substr({value}, 2))"
        elif kind == "lowerText":
            expression = f"lower({value})"
        else:
            expression = f"upper({value})"
        return self._assign(frame, target, expression)

    def _split_text_columns(self, frame: Any, params: Mapping[str, Any]) -> Any:
        output_names = list(params["newColumns"])
        _ensure_duckdb_output_columns_available(self._columns(frame), output_names, "Splitting text into columns")
        value = f"CAST({_quote_ident(params['column'])} AS VARCHAR)"
        delimiter = _sql_literal(params["delimiter"])
        result = frame
        for index, name in enumerate(output_names, start=1):
            result = self._assign(result, name, f"string_split({value}, {delimiter})[{index}]")
        return result

    def _min_max(self, frame: Any, column: str, target: str) -> Any:
        value_name = _unique_internal(self._columns(frame), "__ow_scale_value")
        value = _quote_ident(value_name)
        source = _quote_ident(column)
        minimum = f"min({value}) FILTER (WHERE isfinite({value})) OVER ()"
        maximum = f"max({value}) FILTER (WHERE isfinite({value})) OVER ()"
        expression = (
            f"CASE WHEN {value} IS NULL OR NOT isfinite({value}) THEN NULL "
            f"WHEN {minimum} = {maximum} THEN 0.0 "
            f"ELSE ({value} - {minimum}) / ({maximum} - {minimum}) END"
        )
        modifier = (
            f"* EXCLUDE ({value}) REPLACE ({expression} AS {_quote_ident(target)})"
            if target in self._columns(frame)
            else f"* EXCLUDE ({value}), {expression} AS {_quote_ident(target)}"
        )
        return self._relation(
            frame,
            f"SELECT {modifier} FROM (SELECT *, try_cast({source} AS DOUBLE) AS {value} FROM ow)",
        )

    def _group_by(self, frame: Any, params: Mapping[str, Any]) -> Any:
        keys = list(params["keys"])
        order_name = _unique_internal(self._columns(frame), "__ow_group_order")
        types = dict(zip((str(item) for item in frame.columns), (str(item) for item in frame.types), strict=True))
        key_expressions = [
            (
                f"CASE WHEN {_valid_predicate(_quote_ident(key), types[key])} THEN {_quote_ident(key)} ELSE NULL END"
                if _is_float_type(types[key])
                else _quote_ident(key)
            )
            for key in keys
        ]
        projections = [
            f"{expression} AS {_quote_ident(key)}" for key, expression in zip(keys, key_expressions, strict=True)
        ]
        projections.extend(
            _aggregation_expression(frame, aggregation, _quote_ident(order_name))
            + f" AS {_quote_ident(aggregation['alias'])}"
            for aggregation in params["aggregations"]
        )
        query = (
            f"WITH ordered AS (SELECT *, row_number() OVER () AS {_quote_ident(order_name)} FROM ow) "
            f"SELECT {', '.join(projections)} FROM ordered GROUP BY {', '.join(key_expressions)} "
            f"ORDER BY min({_quote_ident(order_name)})"
        )
        return self._relation(frame, query)


def _compose_sql(source_sql: str, query: str) -> str:
    stripped = query.lstrip()
    if stripped.upper().startswith("WITH "):
        return f"WITH ow AS ({source_sql}), {stripped[5:]}"
    return f"WITH ow AS ({source_sql}) {query}"


def _json_reader_is_unavailable(error: Exception) -> bool:
    error_type = type(error)
    if error_type.__module__ not in {"_duckdb", "duckdb"}:
        return False

    headline = str(error).splitlines()[0].strip().casefold()
    if error_type.__name__ == "CatalogException":
        return headline.startswith(
            (
                "catalog error: table function with name read_json does not exist",
                "catalog error: table function with name read_json_auto does not exist",
            )
        )

    if error_type.__name__ not in {"HTTPException", "IOException", "InvalidInputException"}:
        return False

    return headline.startswith(
        (
            "extension autoloading error: an error occurred while trying to automatically install "
            "the required extension 'json'",
            "extension autoloading error: an error occurred while trying to automatically install "
            'the required extension "json"',
            "http error: failed to load extension 'json'",
            'http error: failed to load extension "json"',
            "io error: failed to load extension 'json'",
            'io error: failed to load extension "json"',
            "invalid input error: failed to load extension 'json'",
            'invalid input error: failed to load extension "json"',
        )
    )


def _connect() -> Any:
    import duckdb

    # Open Wrangler never installs or autoloads DuckDB extensions. This keeps a
    # file open deterministic, offline, and confined to dependencies the user
    # explicitly installed in the selected interpreter.
    connection = duckdb.connect(
        config={
            "autoinstall_known_extensions": False,
            "autoload_known_extensions": False,
            # DuckDB's external-file cache can retain a Windows file handle
            # after a Parquet page completes. Live sessions fingerprint and
            # reopen their immutable source for each terminal query, so holding
            # that cache is both unnecessary and incompatible with atomic
            # source replacement detection.
            "enable_external_file_cache": False,
            "preserve_insertion_order": True,
        }
    )
    try:
        # TIMESTAMPTZ values are rendered in the connection's configured zone.
        # Pin every owned and terminal connection so pages, summaries, and
        # exports do not vary with the host's local timezone.
        connection.execute("SET TimeZone = 'UTC'")
    except Exception:
        connection.close()
        raise
    return connection


def _snapshot_native_relation(relation: Any) -> DuckDBSqlPlan:
    return DuckDBSqlPlan(
        sql=str(relation.sql_query()),
        column_names=tuple(str(column) for column in relation.columns),
        type_names=tuple(str(column_type) for column_type in relation.types),
    )


def _snapshot_relation_factory(factory: Callable[[], Any]) -> DuckDBSqlPlan:
    """Snapshot one native relation, then drop it before its owner closes."""

    relation: Any = None
    try:
        relation = factory()
        return _snapshot_native_relation(relation)
    finally:
        relation = None


def _custom_result_sql(connection: Any, source_sql: str, code: str) -> str:
    """Run custom code with a request-local native relation and retain only SQL."""

    import duckdb

    namespace: dict[str, Any] = {"duckdb": duckdb}
    result: Any | None = None
    with capture_custom_code_output() as output:
        try:
            result = execute_custom_code(code, connection.sql(source_sql), namespace)
            if not isinstance(result, duckdb.DuckDBPyRelation):
                raise EngineError(
                    append_custom_code_output("Custom DuckDB code must assign a DuckDBPyRelation to result.", output)
                )
            return str(result.sql_query())
        except EngineError:
            raise
        except Exception as error:
            raise EngineError(custom_code_error_message("DuckDB", error, output)) from None
        finally:
            namespace.clear()
            result = None


def _write_relation_export(
    connection: Any,
    sql: str,
    path: str | ExportWriterPath,
    options: ExportOptions,
) -> None:
    """Write through a temporary relation that dies before connection close."""

    format_name = options["format"]
    relation: Any = None
    try:
        relation = connection.sql(sql)
        if isinstance(path, ExportWriterPath):
            from .duckdb_export_filesystem import registered_duckdb_export_writer

            with (
                path.open_binary_writer() as writer,
                registered_duckdb_export_writer(connection, writer, format_name) as destination,
            ):
                try:
                    if format_name == "csv":
                        relation.write_csv(
                            destination,
                            use_tmp_file=False,
                            sep=options["delimiter"],
                            quotechar=options["quoteChar"],
                            escapechar=options["quoteChar"],
                            encoding=options["encoding"],
                            header=options["header"],
                        )
                    else:
                        relation.write_parquet(destination, use_tmp_file=False)
                finally:
                    relation = None
            return
        # The host has already reserved this exact inode. DuckDB's default
        # temporary-file publication would replace it before the host can
        # revalidate and commit the shared export transaction.
        if format_name == "csv":
            relation.write_csv(
                path,
                use_tmp_file=False,
                sep=options["delimiter"],
                quotechar=options["quoteChar"],
                escapechar=options["quoteChar"],
                encoding=options["encoding"],
                header=options["header"],
            )
        else:
            relation.write_parquet(path, use_tmp_file=False)
    finally:
        relation = None


def _execute_rows(connection: Any, source_sql: str, query: str) -> list[tuple[Any, ...]]:
    return list(connection.execute(_compose_sql(source_sql, query)).fetchall())


def _execute_scalar(connection: Any, source_sql: str, query: str) -> Any:
    row = connection.execute(_compose_sql(source_sql, query)).fetchone()
    return None if row is None else row[0]


def _quote_ident(value: Any) -> str:
    return '"' + str(value).replace('"', '""') + '"'


def _identifier_list(values: Iterable[Any]) -> str:
    return ", ".join(_quote_ident(value) for value in values)


def _sql_literal(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if isnan(value):
            return "CAST('NaN' AS DOUBLE)"
        if isinf(value):
            return "CAST('-Infinity' AS DOUBLE)" if value < 0 else "CAST('Infinity' AS DOUBLE)"
        return repr(value)
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        timestamp_type = "TIMESTAMPTZ" if value.tzinfo is not None and value.utcoffset() is not None else "TIMESTAMP"
        return f"{timestamp_type} {_sql_literal(value.isoformat(sep=' '))}"
    if isinstance(value, date):
        return f"DATE {_sql_literal(value.isoformat())}"
    if isinstance(value, timedelta):
        return f"INTERVAL {_sql_literal(_timedelta_seconds_text(value) + ' seconds')}"
    if isinstance(value, bytes):
        return f"from_hex({_sql_literal(value.hex())})"
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(_sql_literal(item) for item in value) + "]"
    text = str(value).replace("'", "''")
    return f"'{text}'"


def _duckdb_decimal_literal(value: Any) -> str:
    decimal_value = value if isinstance(value, Decimal) else Decimal(value)
    fixed = format(decimal_value, "f")
    exponent = decimal_value.as_tuple().exponent
    if not isinstance(exponent, int):
        raise ValueError("Decimal replacement must be finite")
    scale = max(-exponent, 0)
    return f"CAST({_sql_literal(fixed)} AS DECIMAL(38, {scale}))"


def _duckdb_decimal_spec(raw_type: str) -> tuple[int, int]:
    match = _DUCKDB_DECIMAL_TYPE.fullmatch(raw_type.strip())
    if match is None:
        raise EngineError(f"DuckDB decimal type has no portable precision and scale: {raw_type}")
    return int(match.group(1)), int(match.group(2))


def _duckdb_datetime_is_aware(raw_type: str) -> bool:
    normalized = raw_type.upper().replace("_", " ")
    return "WITH TIME ZONE" in normalized or "TIMESTAMPTZ" in normalized


def _timedelta_seconds_text(value: timedelta) -> str:
    total_microseconds = ((value.days * 86_400) + value.seconds) * 1_000_000 + value.microseconds
    sign = "-" if total_microseconds < 0 else ""
    whole_seconds, microseconds = divmod(abs(total_microseconds), 1_000_000)
    if microseconds == 0:
        return f"{sign}{whole_seconds}"
    fraction = f"{microseconds:06d}".rstrip("0")
    return f"{sign}{whole_seconds}.{fraction}"


def _semantic_type(raw_type: str) -> str:
    lowered = raw_type.lower()
    if lowered.endswith("[]") or lowered.startswith(("list", "array")):
        return "list"
    if lowered.startswith(("struct", "map", "union")):
        return "struct"
    integer_tokens = (
        "tinyint",
        "smallint",
        "integer",
        "bigint",
        "hugeint",
        "utinyint",
        "usmallint",
        "uinteger",
        "ubigint",
    )
    if any(token in lowered for token in integer_tokens):
        return "integer"
    if "decimal" in lowered:
        return "decimal"
    if any(token in lowered for token in ("float", "double", "real")):
        return "float"
    if "bool" in lowered:
        return "boolean"
    if "timestamp" in lowered:
        return "datetime"
    if lowered == "date":
        return "date"
    if "interval" in lowered:
        return "duration"
    if lowered in {"blob", "bit"}:
        return "binary"
    if any(token in lowered for token in ("varchar", "char", "enum", "uuid")):
        return "string"
    return "unknown"


def _duckdb_pivot_wider_identifier_expression(name: str, raw_type: str) -> str:
    semantic_type = _semantic_type(raw_type)
    if semantic_type not in {
        "string",
        "integer",
        "float",
        "decimal",
        "boolean",
        "datetime",
        "date",
        "duration",
        "binary",
    }:
        raise EngineError(
            "Pivot wider identifier columns must use the portable group-key scalar family; "
            f"{name!r} is {semantic_type!r}."
        )
    identifier = _quote_ident(name)
    grouped = _case_sensitive_group_value(identifier, raw_type)
    return f"CASE WHEN {_valid_predicate(identifier, raw_type)} THEN {grouped} ELSE NULL END"


def _is_float_type(raw_type: str) -> bool:
    lowered = raw_type.lower()
    return any(token in lowered for token in ("float", "double", "real"))


def _is_integer_type(raw_type: str) -> bool:
    return _semantic_type(raw_type) == "integer"


def _case_sensitive_group_value(identifier: str, raw_type: str) -> str:
    """Return a collation-free value for public exact grouping semantics."""
    lowered = raw_type.strip().lower()
    if lowered in {"varchar", "char"} or lowered.startswith(("varchar(", "char(")):
        return f"encode({identifier})"
    return identifier


def _nan_predicate(identifier: str, raw_type: str) -> str:
    return f"({identifier} IS NOT NULL AND isnan({identifier}))" if _is_float_type(raw_type) else "FALSE"


def _valid_predicate(identifier: str, raw_type: str) -> str:
    if _is_float_type(raw_type):
        return f"({identifier} IS NOT NULL AND NOT isnan({identifier}))"
    return f"{identifier} IS NOT NULL"


def _finite_predicate(identifier: str, raw_type: str) -> str:
    if _is_float_type(raw_type):
        return f"({identifier} IS NOT NULL AND isfinite({identifier}))"
    return f"{identifier} IS NOT NULL"


def _duckdb_interpolation_coordinate_projection(
    identifier: str,
    raw_type: str,
    minimum: str,
) -> tuple[str, str]:
    semantic_type = _semantic_type(raw_type)
    if semantic_type == "float":
        return f"CAST({identifier} AS DOUBLE)", "TRUE"
    if semantic_type == "integer":
        exact = f"(CAST({identifier} AS HUGEINT) - CAST({minimum} AS HUGEINT))"
        projected = f"CAST({exact} AS DOUBLE)"
        return projected, f"CAST({projected} AS HUGEINT) = {exact}"
    if semantic_type == "decimal":
        exact = f"({identifier} - {minimum})"
        projected = f"CAST({exact} AS DOUBLE)"
        return projected, f"CAST({projected} AS {raw_type}) = {exact}"
    if semantic_type == "date":
        exact = f"date_diff('day', {minimum}, {identifier})"
    elif raw_type.strip().lower().startswith("timestamp_ns"):
        exact = f"(epoch_ns({identifier}) - epoch_ns({minimum}))"
    else:
        exact = f"date_diff('microsecond', {minimum}, {identifier})"
    projected = f"CAST({exact} AS DOUBLE)"
    return projected, f"CAST({projected} AS BIGINT) = {exact}"


def _numeric_histogram_plan(
    identifier: str,
    raw_type: str,
    *,
    minimum: Any,
    maximum: Any,
    finite_count: int,
    distinct_count: int,
) -> tuple[dict[str, Any] | None, float, float, list[str], int | None]:
    finite = _finite_predicate(identifier, raw_type)
    bin_count = numeric_histogram_bin_count(finite_count, distinct_count)
    minimum_float = _finite_float(minimum)
    maximum_float = _finite_float(maximum)
    edges = numeric_histogram_edges(minimum_float, maximum_float, bin_count)
    if minimum_float is None or maximum_float is None or not edges:
        return {"kind": "numeric", "bins": []}, 0.0, 0.0, [], None
    if minimum_float == maximum_float:
        return (
            numeric_visualization_from_bin_counts(
                minimum_float,
                maximum_float,
                [finite_count],
            ),
            minimum_float,
            maximum_float,
            [],
            None,
        )

    numeric_value = f"CAST({identifier} AS DOUBLE)"
    # DuckDB's native histogram uses right-closed upper bounds. Move each
    # internal edge down by one DuckDB DOUBLE so it matches the existing
    # left-closed/right-open bins, then read the bounded counts in map order.
    # Adjacent extreme floats can collapse those boundaries; keep the exact
    # predicate fallback for that case.
    boundaries = tuple([nextafter(edge, -inf) for edge in edges[1:-1]] + [maximum_float])
    if all(left < right for left, right in zip(boundaries, boundaries[1:], strict=False)):
        boundary_sql = ", ".join(
            [f"nextafter(CAST({_sql_literal(edge)} AS DOUBLE), CAST('-Infinity' AS DOUBLE))" for edge in edges[1:-1]]
            + [f"CAST({_sql_literal(maximum_float)} AS DOUBLE)"]
        )
        return (
            None,
            minimum_float,
            maximum_float,
            [f"map_values(histogram({numeric_value}, [{boundary_sql}]) FILTER (WHERE {finite}))"],
            len(boundaries),
        )

    count_expressions = []
    for bin_index in range(bin_count):
        if bin_index == 0:
            interval = f"{numeric_value} < {_sql_literal(edges[1])}"
        elif bin_index == bin_count - 1:
            interval = f"{numeric_value} >= {_sql_literal(edges[bin_index])}"
        else:
            interval = (
                f"{numeric_value} >= {_sql_literal(edges[bin_index])} "
                f"AND {numeric_value} < {_sql_literal(edges[bin_index + 1])}"
            )
        count_expressions.append(f"count(*) FILTER (WHERE {finite} AND ({interval}))")
    return None, minimum_float, maximum_float, count_expressions, None


def _numeric_histogram_counts(values: Sequence[Any], native_bin_count: int | None) -> list[Any]:
    if native_bin_count is None:
        return list(values)
    if len(values) != 1 or not isinstance(values[0], list) or len(values[0]) < native_bin_count:
        raise EngineError("DuckDB returned an invalid numeric histogram.")
    counts = [int(count or 0) for count in values[0][:native_bin_count]]
    counts[-1] += sum(int(count or 0) for count in values[0][native_bin_count:])
    return counts


def _finite_float(value: Any) -> float | None:
    try:
        result = None if value is None else float(value)
        return result if result is None or isfinite(result) else None
    except (TypeError, ValueError, OverflowError):
        return None


def _duckdb_numeric_zero(semantic_type: str, raw_type: str) -> int | float | Decimal:
    if semantic_type == "integer":
        return 0
    if semantic_type == "decimal":
        match = _DUCKDB_DECIMAL_TYPE.fullmatch(raw_type)
        scale = int(match.group(2)) if match is not None else 0
        return Decimal((0, (0,), -scale))
    return 0.0


def _unique_internal(existing: Iterable[str], base: str) -> str:
    names = {str(name).casefold() for name in existing}
    candidate = base
    index = 0
    while candidate.casefold() in names:
        index += 1
        candidate = f"{base}_{index}"
    return candidate


def _ensure_duckdb_output_columns_available(existing: Iterable[Any], generated: Iterable[Any], operation: str) -> None:
    existing_names = [str(name) for name in existing]
    generated_names = [str(name) for name in generated]
    ensure_output_columns_available(existing_names, generated_names, operation)
    existing_folded = {name.casefold() for name in existing_names}
    generated_by_fold: dict[str, str] = {}
    collisions: set[str] = set()
    for name in generated_names:
        folded = name.casefold()
        if folded in existing_folded:
            collisions.add(name)
        previous = generated_by_fold.get(folded)
        if previous is not None:
            collisions.update((previous, name))
        else:
            generated_by_fold[folded] = name
    if collisions:
        raise EngineError(
            f"{operation} would create DuckDB column names that differ only by case: "
            f"{', '.join(sorted(collisions))}. Choose distinct output names."
        )


def _ensure_duckdb_pivot_output_columns_available(existing: Iterable[Any], generated: Iterable[Any]) -> None:
    existing_names = [str(name) for name in existing]
    generated_names = [str(name) for name in generated]
    if any(is_internal_row_id_label(name) for name in generated_names):
        raise EngineError("Pivot longer would create Open Wrangler's reserved private row-identity column.")
    existing_by_key = {portable_pivot_longer_name_key(name): name for name in existing_names}
    generated_by_key: dict[str, str] = {}
    collisions: set[str] = set()
    for name in generated_names:
        key = portable_pivot_longer_name_key(name)
        if key in existing_by_key:
            collisions.update((existing_by_key[key], name))
        previous = generated_by_key.get(key)
        if previous is not None:
            collisions.update((previous, name))
        generated_by_key[key] = name
    if collisions:
        raise EngineError("Pivot longer would create duplicate column names: " + ", ".join(sorted(collisions)))
    _ensure_duckdb_output_columns_available(existing_names, generated_names, "Pivot longer")


def _bound_duckdb_filter_model(model: Mapping[str, Any]) -> dict[str, Any]:
    return {
        **model,
        "filters": [
            {**column_filter, "column": bound_column_name(column_filter["column"], "filterRows")}
            for column_filter in model.get("filters", [])
        ],
        "sort": [{**rule, "column": bound_column_name(rule["column"], "filterRows")} for rule in model.get("sort", [])],
    }


def _filter_query(columns: Iterable[str], model: Mapping[str, Any]) -> str:
    available = set(columns)
    column_conditions: list[str] = []
    for column_filter in model.get("filters", []):
        column = column_filter.get("column")
        if available and column not in available:
            continue
        identifier = _quote_ident(column)
        conditions: list[str] = []
        value_filter = column_filter.get("valueFilter")
        column_type = column_filter.get("type")
        if value_filter and (
            value_filter.get("selectedValues") or value_filter.get("includeNulls") or value_filter.get("includeNaN")
        ):
            alternatives: list[str] = []
            selected = [coerce_typed_view_value(value, column_type) for value in value_filter.get("selectedValues", [])]
            if selected:
                alternatives.append(f"{identifier} IN ({', '.join(_sql_literal(value) for value in selected)})")
            if value_filter.get("includeNulls"):
                alternatives.append(f"{identifier} IS NULL")
            if value_filter.get("includeNaN") and column_filter.get("type") == "float":
                alternatives.append(f"coalesce(isnan({identifier}), FALSE)")
            if not alternatives:
                alternatives.append("FALSE")
            conditions.append("(" + " OR ".join(alternatives) + ")")
        conditions.extend(
            _predicate_expression(identifier, predicate, column_type)
            for predicate in column_filter.get("predicates", [])
        )
        if conditions:
            operator = " OR " if column_filter.get("logic") == "or" else " AND "
            column_conditions.append("(" + operator.join(conditions) + ")")

    where = ""
    if column_conditions:
        operator = " OR " if model.get("logic") == "or" else " AND "
        where = " WHERE " + operator.join(column_conditions)

    rules = [rule for rule in model.get("sort", []) if not available or rule.get("column") in available]
    if not rules:
        return f"SELECT * FROM ow{where}"
    order_name = _unique_internal(available, "__ow_sort_order")
    order = ", ".join(
        f"{_quote_ident(rule['column'])} {str(rule.get('direction', 'asc')).upper()} "
        f"NULLS {str(rule.get('nulls', 'last')).upper()}"
        for rule in rules
    )
    return (
        f"SELECT * EXCLUDE ({_quote_ident(order_name)}) FROM "
        f"(SELECT *, row_number() OVER () AS {_quote_ident(order_name)} FROM ow{where}) AS sorted "
        f"ORDER BY {order}, {_quote_ident(order_name)}"
    )


def _predicate_expression(identifier: str, predicate: Mapping[str, Any], column_type: str | None) -> str:
    operator = validate_view_predicate_operator(column_type, predicate.get("operator"))
    value = (
        coerce_typed_view_value(predicate.get("value"), column_type)
        if operator not in {"contains", "startsWith", "endsWith", "isNull", "isNotNull", "isNaN", "isNotNaN"}
        else predicate.get("value")
    )
    if operator == "isNull":
        return f"{identifier} IS NULL"
    if operator == "isNotNull":
        return f"{identifier} IS NOT NULL"
    if operator == "isNaN":
        return f"coalesce(isnan({identifier}), FALSE)" if column_type == "float" else "FALSE"
    if operator == "isNotNaN":
        return f"coalesce(NOT isnan({identifier}), TRUE)" if column_type == "float" else "TRUE"
    if operator == "equals":
        result = f"{identifier} = {_sql_literal(value)}"
    elif operator == "notEquals":
        result = f"{identifier} <> {_sql_literal(value)}"
    elif operator == "contains":
        result = (
            f"contains(translate(CAST({identifier} AS VARCHAR), {_sql_literal(_ASCII_UPPER)}, "
            f"{_sql_literal(_ASCII_LOWER)}), {_sql_literal(str(value).translate(_ASCII_TO_LOWER))})"
        )
    elif operator == "startsWith":
        result = f"starts_with(CAST({identifier} AS VARCHAR), {_sql_literal(str(value))})"
    elif operator == "endsWith":
        result = f"ends_with(CAST({identifier} AS VARCHAR), {_sql_literal(str(value))})"
    elif operator in {"gt", "gte", "lt", "lte"}:
        symbol = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[operator]
        result = f"{identifier} {symbol} {_sql_literal(value)}"
    else:
        second = _sql_literal(coerce_typed_view_value(predicate.get("secondValue"), column_type))
        result = f"({identifier} >= {_sql_literal(value)} AND {identifier} <= {second})"
    valid = f"{identifier} IS NOT NULL"
    if column_type == "float":
        valid += f" AND coalesce(NOT isnan({identifier}), FALSE)"
    return f"(({result}) AND {valid})"


def _formula_expression(left: str, right: str, operator: str) -> str:
    if operator == "power":
        return f"power({left}, {right})"
    symbol = {"add": "+", "subtract": "-", "multiply": "*", "divide": "/", "modulo": "%"}.get(operator)
    if symbol is None:
        raise EngineError(f"Unsupported formula operator: {operator}")
    return f"({left} {symbol} {right})"


def _bound_duckdb_group_params(params: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "keys": [bound_column_name(reference, "groupBy") for reference in params["keys"]],
        "aggregations": [
            {
                **aggregation,
                "column": bound_column_name(aggregation["column"], "groupBy"),
            }
            for aggregation in params["aggregations"]
        ],
    }


def _aggregation_expression(frame: Any, aggregation: Mapping[str, Any], order: str) -> str:
    column = _quote_ident(aggregation["column"])
    types = dict(zip((str(item) for item in frame.columns), (str(item) for item in frame.types), strict=True))
    raw_type = types[aggregation["column"]]
    value = (
        f"CASE WHEN {_valid_predicate(column, raw_type)} THEN {column} ELSE NULL END"
        if _is_float_type(raw_type)
        else column
    )
    operation = aggregation["operation"]
    if operation == "sum":
        if _is_integer_type(raw_type):
            # BIGNUM keeps accumulation exact even when intermediate partial
            # sums exceed HUGEINT or the portable result envelope.  The final
            # value is checked and narrowed below, so cancellation remains
            # deterministic and independent of input order.
            total = f"coalesce(sum(CAST({value} AS BIGNUM)), 0::BIGNUM)"
            return _checked_duckdb_integer_result(total)
        return f"coalesce(sum({value}), 0)"
    if operation == "mean":
        return f"avg({value})"
    if operation in {"min", "max"}:
        return f"{operation}({value})"
    if operation == "median":
        expression = f"median({value})"
        return f"CAST({expression} AS DOUBLE)" if "decimal" in raw_type.lower() else expression
    if operation == "count":
        return f"count({value})"
    if operation == "nUnique":
        return f"count(DISTINCT {value})"
    if operation in {"first", "last"}:
        direction = "ASC" if operation == "first" else "DESC"
        return f"first({value} ORDER BY {order} {direction}) FILTER (WHERE {value} IS NOT NULL)"
    raise EngineError(f"Unsupported DuckDB aggregation: {operation}")


def _by_example_expression(program: Mapping[str, Any]) -> str:
    kind = program["kind"]
    if kind == "column":
        return _quote_ident(bound_column_name(program["column"], "byExample"))
    if kind == "literal":
        return _sql_literal(program.get("value"))
    if kind == "slice":
        value = f"CAST({_by_example_expression(program['input'])} AS VARCHAR)"
        start = int(program["start"])
        stop = program.get("stop")
        return f"substr({value}, {start + 1})" if stop is None else f"substr({value}, {start + 1}, {int(stop) - start})"
    if kind == "split":
        value = f"CAST({_by_example_expression(program['input'])} AS VARCHAR)"
        return f"string_split({value}, {_sql_literal(program['delimiter'])})[{int(program['index']) + 1}]"
    if kind == "concat":
        return " || ".join(f"CAST({_by_example_expression(part)} AS VARCHAR)" for part in program["parts"])
    if kind == "regexExtract":
        value = f"CAST({_by_example_expression(program['input'])} AS VARCHAR)"
        pattern = _sql_literal(program["pattern"])
        group = int(program["group"])
        return (
            f"CASE WHEN regexp_matches({value}, {pattern}) "
            f"THEN regexp_extract({value}, {pattern}, {group}) ELSE NULL END"
        )
    if kind == "regexReplace":
        value = f"CAST({_by_example_expression(program['input'])} AS VARCHAR)"
        replacement = str(program["replacement"]).replace("\\", "\\\\")
        return f"regexp_replace({value}, {_sql_literal(program['pattern'])}, {_sql_literal(replacement)}, 'g')"
    if kind == "case":
        value = f"CAST({_by_example_expression(program['input'])} AS VARCHAR)"
        if program["style"] == "lower":
            return f"translate({value}, {_sql_literal(_ASCII_UPPER)}, {_sql_literal(_ASCII_LOWER)})"
        if program["style"] == "upper":
            return f"translate({value}, {_sql_literal(_ASCII_LOWER)}, {_sql_literal(_ASCII_UPPER)})"
        return (
            f"translate(substr({value}, 1, 1), {_sql_literal(_ASCII_LOWER)}, {_sql_literal(_ASCII_UPPER)}) || "
            f"translate(substr({value}, 2), {_sql_literal(_ASCII_UPPER)}, {_sql_literal(_ASCII_LOWER)})"
        )
    if kind == "datetimeFormat":
        value = f"CAST({_by_example_expression(program['input'])} AS VARCHAR)"
        return (
            f"strftime(try_strptime({value}, {_sql_literal(program['inputFormat'])}), "
            f"{_sql_literal(program['outputFormat'])})"
        )
    if kind == "arithmetic":
        left = _by_example_expression(program["left"])
        right = _by_example_expression(program["right"])
        widens_integer = program.get("_owResultType") == "integer"
        if widens_integer:
            return _checked_duckdb_integer_formula(left, right, str(program["operator"]))
        return _formula_expression(
            left,
            right,
            program["operator"],
        )
    raise EngineError(f"Unsupported DuckDB by-example expression: {kind}")


def _checked_duckdb_integer_result(expression: str) -> str:
    minimum = f"'{_PORTABLE_INTEGER_MIN}'::BIGNUM"
    maximum = f"'{_PORTABLE_INTEGER_MAX}'::BIGNUM"
    # DuckDB 1.5 cannot cast BIGNUM directly to HUGEINT, even for small
    # values.  Its lossless VARCHAR bridge does support the full HUGEINT
    # domain, and the explicit range check runs before that narrowing cast.
    return (
        f"CAST(CASE WHEN ({expression}) IS NULL THEN NULL "
        f"WHEN ({expression}) BETWEEN {minimum} AND {maximum} "
        f"THEN CAST(({expression}) AS VARCHAR) "
        "ELSE error('Open Wrangler integer result exceeds the portable 38-digit envelope.') END AS HUGEINT)"
    )


def _checked_duckdb_integer_formula(left: str, right: str, operator: str) -> str:
    if operator not in {"add", "subtract", "multiply"}:
        raise EngineError(f"Unsupported checked DuckDB integer operator: {operator}")
    left_bignum = f"CAST({left} AS BIGNUM)"
    right_bignum = f"CAST({right} AS BIGNUM)"
    if operator == "multiply":
        # DuckDB 1.5's BIGNUM multiplication currently rounds large products
        # through scientific notation.  BIGNUM still preserves each operand
        # losslessly, though, and unlike HUGEINT it can hold the full UHUGEINT
        # domain for the exact string conversion below.
        # Normalize only in-envelope operands to DECIMAL(38, 0), then perform
        # the guarded multiplication there.  This also preserves the valid
        # UHUGEINT.max * 0 and UHUGEINT.max * NULL cases without narrowing the
        # wide operand before the zero/null guard can run.
        maximum_integer = f"{_PORTABLE_INTEGER_MAX}::HUGEINT"
        zero = "CAST(0 AS DECIMAL(38, 0))"
        # DuckDB 1.4/1.5 mis-binds some BIGNUM comparisons against column
        # expressions, while abs(BIGNUM) narrows to DOUBLE.  A lossless VARCHAR
        # bridge followed by TRY_CAST is an exact in-envelope test for integer
        # operands and safely rejects the rest of the UHUGEINT/BIGNUM domain.
        left_decimal = f"TRY_CAST(CAST({left_bignum} AS VARCHAR) AS DECIMAL(38, 0))"
        right_decimal = f"TRY_CAST(CAST({right_bignum} AS VARCHAR) AS DECIMAL(38, 0))"
        left_in_range = f"({left_decimal} IS NOT NULL)"
        right_in_range = f"({right_decimal} IS NOT NULL)"
        normalized_left = (
            f"CASE WHEN {left_bignum} IS NULL THEN NULL::DECIMAL(38, 0) ELSE coalesce({left_decimal}, {zero}) END"
        )
        normalized_right = (
            f"CASE WHEN {right_bignum} IS NULL THEN NULL::DECIMAL(38, 0) ELSE coalesce({right_decimal}, {zero}) END"
        )
        left_magnitude = f"abs(CAST({normalized_left} AS HUGEINT))"
        right_magnitude = f"abs(CAST({normalized_right} AS HUGEINT))"
        divisor = f"CASE WHEN {right_magnitude} <> 0 THEN {right_magnitude} ELSE 1::HUGEINT END"
        safe = (
            f"({left_bignum} IS NULL OR {right_bignum} IS NULL OR {left_bignum} = 0 OR {right_bignum} = 0 OR "
            f"({left_in_range} AND {right_in_range} AND "
            f"{left_magnitude} <= {maximum_integer} // ({divisor})))"
        )
        checked_left = f"CASE WHEN {safe} THEN {normalized_left} ELSE {zero} END"
        checked_right = f"CASE WHEN {safe} THEN {normalized_right} ELSE {zero} END"
        result = _formula_expression(checked_left, checked_right, operator)
        return (
            f"CAST(CASE WHEN {safe} THEN {result} "
            "ELSE error('Open Wrangler integer result exceeds the portable 38-digit envelope.') END AS HUGEINT)"
        )
    return _checked_duckdb_integer_result(_formula_expression(left_bignum, right_bignum, operator))


def _regex_extract_expression(column: str, pattern: str, group: int) -> str:
    contract = portable_regex_contract(pattern, group)
    source = f"CAST({_quote_ident(column)} AS VARCHAR)"
    extracted = f"regexp_extract({source}, {_sql_literal(pattern)}, {group})"
    if contract.participation_pattern != pattern:
        extracted = (
            f"CASE WHEN regexp_full_match(regexp_extract({source}, {_sql_literal(pattern)}, 0), "
            f"{_sql_literal(contract.participation_pattern)}) THEN {extracted} ELSE NULL END"
        )
    return (
        f"CASE WHEN {source} IS NULL THEN NULL "
        f"WHEN regexp_matches({source}, {_sql_literal(pattern)}) THEN {extracted} ELSE NULL END"
    )


_GENERATED_HELPERS = r"""import math
import re
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation, localcontext

import duckdb


_OW_ROW_ID_PREFIX = "__open_wrangler_internal_row_id_"


def _ow_ident(value):
    return '"' + str(value).replace('"', '""') + '"'


def _ow_identifiers(values):
    return ", ".join(_ow_ident(value) for value in values)


def _ow_literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if math.isnan(value):
            return "CAST('NaN' AS DOUBLE)"
        if math.isinf(value):
            return "CAST('-Infinity' AS DOUBLE)" if value < 0 else "CAST('Infinity' AS DOUBLE)"
        return repr(value)
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        timestamp_type = "TIMESTAMPTZ" if value.tzinfo is not None and value.utcoffset() is not None else "TIMESTAMP"
        return timestamp_type + " " + _ow_literal(value.isoformat(sep=" "))
    if isinstance(value, date):
        return "DATE " + _ow_literal(value.isoformat())
    if isinstance(value, timedelta):
        total_microseconds = ((value.days * 86400) + value.seconds) * 1000000 + value.microseconds
        sign = "-" if total_microseconds < 0 else ""
        whole_seconds, microseconds = divmod(abs(total_microseconds), 1000000)
        seconds = sign + str(whole_seconds)
        if microseconds:
            seconds += "." + str(microseconds).rjust(6, "0").rstrip("0")
        return "INTERVAL " + _ow_literal(seconds + " seconds")
    if isinstance(value, bytes):
        return "from_hex(" + _ow_literal(value.hex()) + ")"
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(_ow_literal(item) for item in value) + "]"
    return "'" + str(value).replace("'", "''") + "'"


def _ow_decimal_literal(value):
    fixed = format(value, "f")
    scale = max(-value.as_tuple().exponent, 0)
    return "CAST(" + _ow_literal(fixed) + " AS DECIMAL(38, " + str(scale) + "))"


def _ow_decimal_spec(raw_type):
    match = re.fullmatch(r"DECIMAL\((\d+),\s*(\d+)\)", raw_type.strip(), re.IGNORECASE)
    if match is None:
        raise ValueError("DuckDB decimal type has no portable precision and scale: " + raw_type)
    return int(match.group(1)), int(match.group(2))


def _ow_decimal_at_scale(value, precision, scale):
    if not value.is_finite() or precision < 1 or scale < 0 or scale > precision:
        raise ValueError(f"The replacement value does not fit DECIMAL({precision}, {scale}).")
    quantum = Decimal((0, (1,), -scale))
    try:
        with localcontext() as context:
            context.prec = max(80, precision + scale + 4, len(value.as_tuple().digits) + scale + 4)
            normalized = value.quantize(quantum)
    except InvalidOperation as error:
        raise ValueError(f"The replacement value does not fit DECIMAL({precision}, {scale}).") from error
    if normalized != value:
        raise ValueError(f"The replacement value cannot be represented exactly at decimal scale {scale}.")
    if normalized != 0 and normalized.adjusted() >= precision - scale:
        raise ValueError(f"The replacement value does not fit DECIMAL({precision}, {scale}).")
    return normalized


def _ow_datetime_is_aware(raw_type):
    normalized = raw_type.upper().replace("_", " ")
    return "WITH TIME ZONE" in normalized or "TIMESTAMPTZ" in normalized


def _ow_query(df, query):
    stripped = query.lstrip()
    if stripped.upper().startswith("WITH "):
        sql = "WITH ow AS (" + df.sql_query() + "), " + stripped[5:]
    else:
        sql = "WITH ow AS (" + df.sql_query() + ") " + query
    return duckdb.sql(sql)


def _ow_columns(df):
    return [str(column) for column in df.columns]


def _ow_visible(df):
    return [column for column in _ow_columns(df) if not column.startswith(_OW_ROW_ID_PREFIX)]


def _ow_visible_relation(df):
    hidden = next((column for column in _ow_columns(df) if column.startswith(_OW_ROW_ID_PREFIX)), None)
    return df if hidden is None else _ow_query(df, "SELECT * EXCLUDE (" + _ow_ident(hidden) + ") FROM ow")


def _ow_assign(df, target, expression):
    projection = (
        "* REPLACE (" + expression + " AS " + _ow_ident(target) + ")"
        if target in _ow_columns(df)
        else "*, " + expression + " AS " + _ow_ident(target)
    )
    return _ow_query(df, "SELECT " + projection + " FROM ow")


def _ow_select(df, columns):
    hidden = next((column for column in _ow_columns(df) if column.startswith(_OW_ROW_ID_PREFIX)), None)
    selected = ([hidden] if hidden else []) + list(columns)
    return _ow_query(df, "SELECT " + _ow_identifiers(selected) + " FROM ow")


def _ow_unique(existing, base):
    candidate = base
    index = 0
    names = {str(name).casefold() for name in existing}
    while candidate.casefold() in names:
        index += 1
        candidate = base + "_" + str(index)
    return candidate


def _ow_is_float(raw_type):
    lowered = str(raw_type).lower()
    return any(token in lowered for token in ("float", "double", "real"))


def _ow_is_integer(raw_type):
    lowered = str(raw_type).lower()
    return any(
        token in lowered
        for token in (
            "tinyint", "smallint", "integer", "bigint", "hugeint",
            "utinyint", "usmallint", "uinteger", "ubigint",
        )
    )


def _ow_interpolation_coordinate_projection(identifier, raw_type, minimum):
    lowered = str(raw_type).lower()
    if _ow_is_float(raw_type):
        return "CAST(" + identifier + " AS DOUBLE)", "TRUE"
    if _ow_is_integer(raw_type):
        exact = "(CAST(" + identifier + " AS HUGEINT) - CAST(" + minimum + " AS HUGEINT))"
        projected = "CAST(" + exact + " AS DOUBLE)"
        return projected, "CAST(" + projected + " AS HUGEINT) = " + exact
    if "decimal" in lowered:
        exact = "(" + identifier + " - " + minimum + ")"
        projected = "CAST(" + exact + " AS DOUBLE)"
        return projected, "CAST(" + projected + " AS " + str(raw_type) + ") = " + exact
    if lowered == "date":
        exact = "date_diff('day', " + minimum + ", " + identifier + ")"
    elif lowered.startswith("timestamp_ns"):
        exact = "(epoch_ns(" + identifier + ") - epoch_ns(" + minimum + "))"
    else:
        exact = "date_diff('microsecond', " + minimum + ", " + identifier + ")"
    projected = "CAST(" + exact + " AS DOUBLE)"
    return projected, "CAST(" + projected + " AS BIGINT) = " + exact


def _ow_case_sensitive_group_value(identifier, raw_type):
    lowered = str(raw_type).strip().lower()
    if lowered in {"varchar", "char"} or lowered.startswith(("varchar(", "char(")):
        return "encode(" + identifier + ")"
    return identifier


def _ow_checked_integer_result(expression):
    maximum_value = str(10**38 - 1)
    minimum = "'-" + maximum_value + "'::BIGNUM"
    maximum = "'" + maximum_value + "'::BIGNUM"
    return (
        "CAST(CASE WHEN (" + expression + ") IS NULL THEN NULL WHEN ("
        + expression + ") BETWEEN " + minimum + " AND " + maximum
        + " THEN CAST((" + expression + ") AS VARCHAR) ELSE error('Open Wrangler integer result exceeds "
        + "the portable 38-digit envelope.') END AS HUGEINT)"
    )


def _ow_valid(identifier, raw_type):
    if _ow_is_float(raw_type):
        return "(" + identifier + " IS NOT NULL AND NOT isnan(" + identifier + "))"
    return identifier + " IS NOT NULL"


def _ow_filter(df, model):
    available = set(_ow_columns(df))
    column_conditions = []
    for column_filter in model.get("filters", []):
        column = column_filter.get("column")
        if column not in available:
            continue
        identifier = _ow_ident(column)
        conditions = []
        values = column_filter.get("valueFilter")
        column_type = column_filter.get("type")
        if values and (values.get("selectedValues") or values.get("includeNulls") or values.get("includeNaN")):
            alternatives = []
            selected = [_open_wrangler_view_value(value, column_type) for value in values.get("selectedValues", [])]
            if selected:
                alternatives.append(identifier + " IN (" + ", ".join(_ow_literal(v) for v in selected) + ")")
            if values.get("includeNulls"):
                alternatives.append(identifier + " IS NULL")
            if values.get("includeNaN") and column_filter.get("type") == "float":
                alternatives.append("coalesce(isnan(" + identifier + "), FALSE)")
            if not alternatives:
                alternatives.append("FALSE")
            conditions.append("(" + " OR ".join(alternatives) + ")")
        for predicate in column_filter.get("predicates", []):
            conditions.append(_ow_predicate(identifier, predicate, column_type))
        if conditions:
            operator = " OR " if column_filter.get("logic") == "or" else " AND "
            column_conditions.append("(" + operator.join(conditions) + ")")
    where = ""
    if column_conditions:
        where = " WHERE " + (" OR " if model.get("logic") == "or" else " AND ").join(column_conditions)
    rules = [rule for rule in model.get("sort", []) if rule.get("column") in available]
    if not rules:
        return _ow_query(df, "SELECT * FROM ow" + where)
    order_name = _ow_unique(available, "__ow_sort_order")
    order = ", ".join(
        _ow_ident(rule["column"]) + " " + rule.get("direction", "asc").upper()
        + " NULLS " + rule.get("nulls", "last").upper()
        for rule in rules
    )
    return _ow_query(
        df,
        "SELECT * EXCLUDE (" + _ow_ident(order_name) + ") FROM (SELECT *, row_number() OVER () AS "
        + _ow_ident(order_name) + " FROM ow" + where + ") AS sorted ORDER BY " + order + ", " + _ow_ident(order_name),
    )


def _ow_predicate(identifier, predicate, column_type):
    operator = predicate.get("operator")
    value = (
        _open_wrangler_view_value(predicate.get("value"), column_type)
        if operator not in {"contains", "startsWith", "endsWith", "isNull", "isNotNull", "isNaN", "isNotNaN"}
        else predicate.get("value")
    )
    if operator == "isNull":
        return identifier + " IS NULL"
    if operator == "isNotNull":
        return identifier + " IS NOT NULL"
    if operator == "isNaN":
        return "coalesce(isnan(" + identifier + "), FALSE)" if column_type == "float" else "FALSE"
    if operator == "isNotNaN":
        return "coalesce(NOT isnan(" + identifier + "), TRUE)" if column_type == "float" else "TRUE"
    if operator == "equals":
        result = identifier + " = " + _ow_literal(value)
    elif operator == "notEquals":
        result = identifier + " <> " + _ow_literal(value)
    elif operator == "contains":
        folded = str(value).translate(str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"))
        result = (
            "contains(translate(CAST(" + identifier + " AS VARCHAR), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', "
            "'abcdefghijklmnopqrstuvwxyz'), " + _ow_literal(folded) + ")"
        )
    elif operator == "startsWith":
        result = "starts_with(CAST(" + identifier + " AS VARCHAR), " + _ow_literal(str(value)) + ")"
    elif operator == "endsWith":
        result = "ends_with(CAST(" + identifier + " AS VARCHAR), " + _ow_literal(str(value)) + ")"
    elif operator in {"gt", "gte", "lt", "lte"}:
        symbol = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[operator]
        result = identifier + " " + symbol + " " + _ow_literal(value)
    else:
        result = (
            "(" + identifier + " >= " + _ow_literal(value) + " AND " + identifier
            + " <= " + _ow_literal(_open_wrangler_view_value(predicate.get("secondValue"), column_type)) + ")"
        )
    valid = identifier + " IS NOT NULL"
    if column_type == "float":
        valid += " AND coalesce(NOT isnan(" + identifier + "), FALSE)"
    return "((" + result + ") AND " + valid + ")"


def _ow_drop_missing(df, columns, how):
    selected = list(columns) if columns else _ow_visible(df)
    if not selected:
        return df
    types = dict(zip(_ow_columns(df), map(str, df.types)))
    valid = [_ow_valid(_ow_ident(column), types[column]) for column in selected]
    operator = " AND " if how == "any" else " OR "
    return _ow_query(df, "SELECT * FROM ow WHERE " + operator.join("(" + item + ")" for item in valid))


def _ow_fill_missing_from_columns(df, target, fallbacks):
    types = dict(zip(_ow_columns(df), map(str, df.types)))
    target_type = types[target]
    lowered_target = target_type.lower()
    fallback_types = [types[column] for column in fallbacks]
    is_string = any(token in lowered_target for token in ("varchar", "char", "enum", "uuid"))
    output_type = target_type
    if is_string and any(raw_type != target_type for raw_type in fallback_types):
        probe_target = _ow_ident(target)
        probe_remaining = "NOT (" + _ow_valid(probe_target, target_type) + ")"
        widening_predicates = []
        for fallback, raw_type in zip(fallbacks, fallback_types):
            identifier = _ow_ident(fallback)
            valid = _ow_valid(identifier, raw_type)
            if raw_type != target_type:
                widening_predicates.append(
                    "((" + probe_remaining + ") AND (" + valid + ") AND try_cast("
                    + identifier + " AS " + target_type + ") IS NULL)"
                )
            probe_remaining = "(" + probe_remaining + ") AND NOT (" + valid + ")"
        widening = " OR ".join(widening_predicates)
        if widening and bool(
            _ow_query(df, "SELECT coalesce(bool_or(" + widening + "), FALSE) FROM ow").fetchone()[0]
        ):
            output_type = "VARCHAR"
    if lowered_target in {"float", "real"} and any(
        raw_type.lower() == "double" for raw_type in fallback_types
    ):
        raise ValueError(
            "A DOUBLE fallback cannot be represented exactly in a FLOAT target. "
            "Convert the target column to DOUBLE first."
        )
    if (lowered_target.startswith("decimal") or "timestamp" in lowered_target) and any(
        raw_type != target_type for raw_type in fallback_types
    ):
        family = "decimal" if lowered_target.startswith("decimal") else "datetime"
        raise ValueError(
            "DuckDB " + family + " fallback columns must use the exact target type " + target_type
            + ". Convert the columns to one exact type before filling."
        )
    target_identifier = _ow_ident(target)
    target_missing = "NOT (" + _ow_valid(target_identifier, target_type) + ")"
    remaining = target_missing
    fallback_expressions = []
    for fallback, raw_type in zip(fallbacks, fallback_types):
        identifier = _ow_ident(fallback)
        valid = _ow_valid(identifier, raw_type)
        fallback_expressions.append(
            "CASE WHEN (" + remaining + ") AND (" + valid + ") THEN CAST(" + identifier + " AS "
            + output_type + ") ELSE NULL::" + output_type + " END"
        )
        remaining = "(" + remaining + ") AND NOT (" + valid + ")"
    fallback_value = "coalesce(" + ", ".join(fallback_expressions) + ")"
    expression = (
        "CASE WHEN " + target_missing + " AND (" + fallback_value + ") IS NOT NULL THEN "
        + fallback_value + " ELSE CAST(" + target_identifier + " AS " + output_type + ") END"
    )
    return _ow_assign(df, target, expression)


def _ow_fill_missing_directional(df, target, order_rules, direction, max_gap):
    columns = _ow_columns(df)
    types = dict(zip(columns, map(str, df.types)))
    target_identifier = _ow_ident(target)
    valid = _ow_valid(target_identifier, types[target])
    reserved = list(columns)
    original_name = _ow_unique(reserved, "__ow_directional_original")
    reserved.append(original_name)
    calculation_name = _ow_unique(reserved, "__ow_directional_calculation")
    reserved.append(calculation_name)
    previous_name = _ow_unique(reserved, "__ow_directional_previous")
    reserved.append(previous_name)
    next_name = _ow_unique(reserved, "__ow_directional_next")
    reserved.append(next_name)
    total_name = _ow_unique(reserved, "__ow_directional_total")
    reserved.append(total_name)
    candidate_name = _ow_unique(reserved, "__ow_directional_candidate")
    original = _ow_ident(original_name)
    calculation = _ow_ident(calculation_name)
    previous = _ow_ident(previous_name)
    following = _ow_ident(next_name)
    total = _ow_ident(total_name)
    candidate = _ow_ident(candidate_name)
    order_expressions = []
    for rule in order_rules:
        identifier = _ow_ident(rule["column"])
        expression = (
            "CASE WHEN " + _ow_valid(identifier, types[rule["column"]]) + " THEN "
            + identifier + " ELSE NULL END"
            if _ow_is_float(types[rule["column"]])
            else identifier
        )
        order_expressions.append(
            expression + " " + str(rule["direction"]).upper()
            + " NULLS " + str(rule["nulls"]).upper()
        )
    order = ", ".join(order_expressions)
    calculation_order = order + ", " + original
    present_value = "CASE WHEN " + valid + " THEN " + target_identifier + " ELSE NULL END"
    if direction == "forward":
        candidate_expression = (
            "last_value(" + present_value + " IGNORE NULLS) OVER (ORDER BY " + calculation
            + " ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)"
        )
    else:
        candidate_expression = (
            "first_value(" + present_value + " IGNORE NULLS) OVER (ORDER BY " + calculation
            + " ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING)"
        )
    gap_size = "coalesce(" + following + ", " + total + " + 1) - coalesce(" + previous + ", 0) - 1"
    eligible = "NOT (" + valid + ") AND " + candidate + " IS NOT NULL"
    if max_gap is not None:
        eligible += " AND (" + gap_size + ") <= " + str(int(max_gap))
    replacement = "CASE WHEN " + eligible + " THEN " + candidate + " ELSE " + target_identifier + " END"
    temporary_names = [
        original_name,
        calculation_name,
        previous_name,
        next_name,
        total_name,
        candidate_name,
    ]
    query = (
        "WITH numbered AS (SELECT *, row_number() OVER () AS " + original + " FROM ow), "
        "ordered AS (SELECT *, row_number() OVER (ORDER BY " + calculation_order + ") AS "
        + calculation + " FROM numbered), "
        "context AS (SELECT *, max(CASE WHEN " + valid + " THEN " + calculation
        + " END) OVER (ORDER BY " + calculation + " ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS "
        + previous + ", min(CASE WHEN " + valid + " THEN " + calculation
        + " END) OVER (ORDER BY " + calculation + " ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS "
        + following + ", count(*) OVER () AS " + total + ", " + candidate_expression + " AS " + candidate
        + " FROM ordered) SELECT * EXCLUDE (" + _ow_identifiers(temporary_names) + ") REPLACE ("
        + replacement + " AS " + target_identifier + ") FROM context ORDER BY " + original
    )
    return _ow_query(df, query)


def _ow_fill_missing_linear_interpolation(df, target, coordinate, max_gap):
    columns = _ow_columns(df)
    types = dict(zip(columns, map(str, df.types)))
    target_type = types[target]
    coordinate_type = types[coordinate]
    lowered_coordinate = coordinate_type.lower()
    if "hugeint" in lowered_coordinate:
        raise ValueError(
            "Linear interpolation does not support HUGEINT coordinates; "
            "convert the coordinate to a narrower exact type first."
        )
    coordinate_supported = (
        _ow_is_integer(coordinate_type)
        or _ow_is_float(coordinate_type)
        or "decimal" in lowered_coordinate
        or lowered_coordinate == "date"
        or "timestamp" in lowered_coordinate
    )
    if not _ow_is_float(target_type):
        raise ValueError("Linear interpolation requires a floating-point target column.")
    if not coordinate_supported:
        raise ValueError("Linear interpolation coordinates must be numeric, dates, or datetimes.")
    coordinate_identifier = _ow_ident(coordinate)
    minimum_coordinate = "min(" + coordinate_identifier + ") OVER ()"
    numeric_coordinate, coordinate_roundtrip = _ow_interpolation_coordinate_projection(
        coordinate_identifier, coordinate_type, minimum_coordinate
    )
    coordinate_finite = (
        "(" + coordinate_identifier + " IS NOT NULL AND isfinite(" + coordinate_identifier + "))"
        if _ow_is_float(coordinate_type)
        else coordinate_identifier + " IS NOT NULL"
    )
    validation_name = _ow_unique(columns, "__ow_interpolation_validation_coordinate")
    validation_exact_name = _ow_unique(
        columns + [validation_name], "__ow_interpolation_validation_exact"
    )
    validation_identifier = _ow_ident(validation_name)
    validation_exact = _ow_ident(validation_exact_name)
    try:
        validation = _ow_query(
            df,
            "WITH projected AS (SELECT *, " + numeric_coordinate + " AS " + validation_identifier
            + ", " + coordinate_roundtrip + " AS " + validation_exact + " FROM ow) "
            + "SELECT count(*), count(*) FILTER (WHERE NOT (" + coordinate_finite
            + ")), count(DISTINCT " + coordinate_identifier + "), count(DISTINCT "
            + validation_identifier + "), coalesce(bool_and(isfinite(" + validation_identifier
            + ")), TRUE), coalesce(bool_and(" + validation_exact + "), TRUE) FROM projected",
        ).fetchone()
    except Exception as error:
        raise ValueError(
            "Linear interpolation cannot represent the selected coordinate distances exactly."
        ) from error
    count = int(validation[0])
    if int(validation[1]):
        raise ValueError("Linear interpolation requires every coordinate value to be present and finite.")
    if int(validation[2]) != count:
        raise ValueError("Linear interpolation requires unique coordinate values.")
    if int(validation[3]) != count or not bool(validation[4]) or not bool(validation[5]):
        raise ValueError(
            "Linear interpolation cannot preserve the selected coordinate distances exactly enough; "
            "choose a lower-precision coordinate column."
        )
    target_identifier = _ow_ident(target)
    target_present = _ow_valid(target_identifier, target_type)
    target_missing = "NOT (" + target_present + ")"
    present_target = "CASE WHEN " + target_present + " THEN " + target_identifier + " ELSE NULL END"
    reserved = list(columns)
    temporary_names = []
    for base in (
        "__ow_interpolation_original",
        "__ow_interpolation_calculation",
        "__ow_interpolation_coordinate",
        "__ow_interpolation_previous",
        "__ow_interpolation_next",
        "__ow_interpolation_left_value",
        "__ow_interpolation_right_value",
        "__ow_interpolation_left_coordinate",
        "__ow_interpolation_right_coordinate",
        "__ow_interpolation_weight",
    ):
        name = _ow_unique(reserved, base)
        reserved.append(name)
        temporary_names.append(name)
    (
        original_name, calculation_name, numeric_name, previous_name, next_name,
        left_value_name, right_value_name, left_coordinate_name, right_coordinate_name,
        weight_name,
    ) = temporary_names
    original = _ow_ident(original_name)
    calculation = _ow_ident(calculation_name)
    numeric = _ow_ident(numeric_name)
    previous = _ow_ident(previous_name)
    following = _ow_ident(next_name)
    left_value = _ow_ident(left_value_name)
    right_value = _ow_ident(right_value_name)
    left_coordinate = _ow_ident(left_coordinate_name)
    right_coordinate = _ow_ident(right_coordinate_name)
    weight = _ow_ident(weight_name)
    calculation_order = coordinate_identifier + " ASC, " + original
    numeric_coordinate, _coordinate_roundtrip = _ow_interpolation_coordinate_projection(
        coordinate_identifier,
        coordinate_type,
        "min(" + coordinate_identifier + ") OVER ()",
    )
    left_value_expression = (
        "last_value(" + present_target + " IGNORE NULLS) OVER (ORDER BY " + calculation
        + " ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)"
    )
    right_value_expression = (
        "first_value(" + present_target + " IGNORE NULLS) OVER (ORDER BY " + calculation
        + " ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING)"
    )
    present_coordinate = "CASE WHEN " + target_present + " THEN " + numeric + " ELSE NULL END"
    left_coordinate_expression = (
        "last_value(" + present_coordinate + " IGNORE NULLS) OVER (ORDER BY " + calculation
        + " ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)"
    )
    right_coordinate_expression = (
        "first_value(" + present_coordinate + " IGNORE NULLS) OVER (ORDER BY " + calculation
        + " ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING)"
    )
    span = "(" + right_coordinate + " - " + left_coordinate + ")"
    direct_weight = "((" + numeric + " - " + left_coordinate + ") / " + span + ")"
    scaled_weight = (
        "((" + numeric + " / 2.0 - " + left_coordinate + " / 2.0) / ("
        + right_coordinate + " / 2.0 - " + left_coordinate + " / 2.0))"
    )
    weight_expression = "CASE WHEN isfinite(" + span + ") THEN " + direct_weight + " ELSE " + scaled_weight + " END"
    eligible = (
        target_missing + " AND isfinite(" + left_value + ") AND isfinite(" + right_value
        + ") AND isfinite(" + weight + ") AND " + weight + " BETWEEN 0.0 AND 1.0"
    )
    if max_gap is not None:
        eligible += " AND " + following + " - " + previous + " - 1 <= " + str(int(max_gap))
    interpolated = "((1.0 - " + weight + ") * " + left_value + " + " + weight + " * " + right_value + ")"
    replacement = (
        "CASE WHEN " + eligible + " THEN CAST(" + interpolated + " AS " + target_type
        + ") ELSE " + target_identifier + " END"
    )
    query = (
        "WITH numbered AS (SELECT *, row_number() OVER () AS " + original + " FROM ow), "
        "ordered AS (SELECT *, row_number() OVER (ORDER BY " + calculation_order + ") AS "
        + calculation + ", " + numeric_coordinate + " AS " + numeric + " FROM numbered), "
        "context AS (SELECT *, max(CASE WHEN " + target_present + " THEN " + calculation
        + " END) OVER (ORDER BY " + calculation + " ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS "
        + previous + ", min(CASE WHEN " + target_present + " THEN " + calculation
        + " END) OVER (ORDER BY " + calculation + " ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS "
        + following + ", " + left_value_expression + " AS " + left_value + ", "
        + right_value_expression + " AS " + right_value + ", "
        + left_coordinate_expression + " AS " + left_coordinate + ", "
        + right_coordinate_expression + " AS " + right_coordinate + " FROM ordered), "
        "weighted AS (SELECT *, " + weight_expression + " AS " + weight + " FROM context) "
        "SELECT * EXCLUDE (" + _ow_identifiers(temporary_names) + ") REPLACE ("
        + replacement + " AS " + target_identifier + ") FROM weighted ORDER BY " + original
    )
    return _ow_query(df, query)


def _ow_fill_missing_grouped_statistic(df, target, keys, statistic):
    columns = _ow_columns(df)
    types = dict(zip(columns, map(str, df.types)))
    target_type = types[target]
    target_identifier = _ow_ident(target)
    target_valid = _ow_valid(target_identifier, target_type)
    target_missing = "NOT (" + target_valid + ")"
    reserved = list(columns)
    original_name = _ow_unique(reserved, "__ow_grouped_original")
    reserved.append(original_name)
    key_names = []
    for index, key in enumerate(keys):
        name = _ow_unique(reserved, "__ow_grouped_key_" + str(index))
        reserved.append(name)
        key_names.append(name)
    fill_name = _ow_unique(reserved, "__ow_grouped_fill")
    reserved.append(fill_name)
    count_name = _ow_unique(reserved, "__ow_grouped_count")
    reserved.append(count_name)
    maximum_name = _ow_unique(reserved, "__ow_grouped_maximum")
    reserved.append(maximum_name)
    original = _ow_ident(original_name)
    normalized_key_expressions = []
    for key, name in zip(keys, key_names):
        identifier = _ow_ident(key)
        key_value = _ow_case_sensitive_group_value(identifier, types[key])
        normalized_key_expressions.append(
            "CASE WHEN " + _ow_valid(identifier, types[key]) + " THEN " + key_value
            + " ELSE NULL END AS " + _ow_ident(name)
        )
    normalized_keys = _ow_identifiers(key_names)
    partition = normalized_keys
    normalized = (
        "normalized AS (SELECT *, row_number() OVER () AS " + original + ", "
        + ", ".join(normalized_key_expressions) + " FROM ow)"
    )
    if statistic == "mostFrequent":
        value_name = _ow_unique(reserved, "__ow_grouped_value")
        reserved.append(value_name)
        token_name = _ow_unique(reserved, "__ow_grouped_token")
        reserved.append(token_name)
        ties_name = _ow_unique(reserved, "__ow_grouped_ties")
        value = _ow_ident(value_name)
        token = _ow_ident(token_name)
        count = _ow_ident(count_name)
        maximum = _ow_ident(maximum_name)
        ties = _ow_ident(ties_name)
        fill = _ow_ident(fill_name)
        grouped_target = _ow_case_sensitive_group_value(target_identifier, target_type)
        summary_ctes = (
            "counts AS (SELECT " + normalized_keys + ", " + grouped_target + " AS " + token
            + ", any_value(" + target_identifier + ") AS " + value + ", count(*) AS " + count
            + " FROM normalized WHERE " + target_valid + " GROUP BY " + normalized_keys + ", "
            + grouped_target + "), ranked AS (SELECT *, max(" + count
            + ") OVER (PARTITION BY " + partition + ") AS " + maximum + " FROM counts), summary AS (SELECT "
            + normalized_keys + ", count(*) FILTER (WHERE " + count + " = " + maximum + ") AS " + ties
            + ", CASE WHEN " + ties + " = 1 THEN any_value(" + value + ") FILTER (WHERE " + count + " = "
            + maximum + ") ELSE NULL END AS " + fill + " FROM ranked GROUP BY " + normalized_keys + ")"
        )
    elif statistic == "mean":
        positive_name = _ow_unique(reserved, "__ow_grouped_positive")
        reserved.append(positive_name)
        negative_name = _ow_unique(reserved, "__ow_grouped_negative")
        reserved.append(negative_name)
        scale_name = _ow_unique(reserved, "__ow_grouped_scale")
        reserved.append(scale_name)
        scaled_name = _ow_unique(reserved, "__ow_grouped_scaled")
        positive = _ow_ident(positive_name)
        negative = _ow_ident(negative_name)
        scale = _ow_ident(scale_name)
        scaled = _ow_ident(scaled_name)
        fill = _ow_ident(fill_name)
        summary_ctes = (
            "annotated AS (SELECT *, count(*) FILTER (WHERE " + target_valid + " AND " + target_identifier
            + " = CAST('Infinity' AS DOUBLE)) OVER (PARTITION BY " + partition + ") AS " + positive
            + ", count(*) FILTER (WHERE " + target_valid + " AND " + target_identifier
            + " = CAST('-Infinity' AS DOUBLE)) OVER (PARTITION BY " + partition + ") AS " + negative
            + ", max(abs(" + target_identifier + ")) FILTER (WHERE " + target_valid + " AND isfinite("
            + target_identifier + ")) OVER (PARTITION BY " + partition + ") AS " + scale
            + " FROM normalized), scaled_rows AS (SELECT *, avg(" + target_identifier + " / nullif(" + scale
            + ", 0)) FILTER (WHERE " + target_valid + " AND isfinite(" + target_identifier
            + ")) OVER (PARTITION BY " + partition + ") AS " + scaled + " FROM annotated), summary AS (SELECT "
            + "DISTINCT " + normalized_keys + ", CASE WHEN " + positive + " > 0 AND " + negative
            + " > 0 THEN NULL WHEN " + positive + " > 0 THEN CAST('Infinity' AS DOUBLE) WHEN " + negative
            + " > 0 THEN CAST('-Infinity' AS DOUBLE) WHEN " + scale + " IS NULL THEN NULL WHEN " + scale
            + " = 0 THEN 0.0 ELSE greatest(-1.0, least(1.0, " + scaled + ")) * " + scale + " END AS "
            + fill + " FROM scaled_rows)"
        )
    else:
        lower_name = _ow_unique(reserved, "__ow_grouped_lower")
        reserved.append(lower_name)
        upper_name = _ow_unique(reserved, "__ow_grouped_upper")
        reserved.append(upper_name)
        missing_name = _ow_unique(reserved, "__ow_grouped_missing")
        lower = _ow_ident(lower_name)
        upper = _ow_ident(upper_name)
        missing_count = _ow_ident(missing_name)
        fill = _ow_ident(fill_name)
        lower_aggregate = (
            "quantile_disc(" + target_identifier + ", 0.5 ORDER BY " + target_identifier
            + ") FILTER (WHERE " + target_valid + ")"
        )
        upper_aggregate = (
            "quantile_disc(" + target_identifier + ", 0.5 ORDER BY " + target_identifier
            + " DESC) FILTER (WHERE " + target_valid + ")"
        )
        if _ow_is_integer(target_type):
            fill_expression = (
                "CAST((" + lower + " // 2) + (" + upper + " // 2) + ((" + lower + " % 2 + "
                + upper + " % 2) // 2) AS " + target_type + ")"
            )
            invalid = (
                missing_count + " > 0 AND ((" + lower + " % 2 + " + upper + " % 2) % 2) <> 0"
            )
            label = "integer"
        elif "decimal" in target_type.lower():
            fill_expression = "median(" + target_identifier + ") FILTER (WHERE " + target_valid + ")"
            invalid = (
                missing_count + " > 0 AND " + fill + " IS NOT NULL AND (" + fill + " - " + lower
                + ") <> (" + upper + " - " + fill + ")"
            )
            label = "decimal"
        else:
            raw_median = "median(" + target_identifier + ") FILTER (WHERE " + target_valid + ")"
            fill_expression = "CASE WHEN isnan(" + raw_median + ") THEN NULL ELSE " + raw_median + " END"
            invalid = "FALSE"
            label = "numeric"
        summary_select = (
            "SELECT " + normalized_keys + ", count(*) FILTER (WHERE " + target_missing + ") AS "
            + missing_count + ", " + lower_aggregate + " AS " + lower + ", " + upper_aggregate
            + " AS " + upper + ", " + fill_expression + " AS " + fill + " FROM normalized GROUP BY "
            + normalized_keys
        )
        if invalid == "FALSE":
            summary_ctes = "summary AS (" + summary_select + ")"
        else:
            message = (
                "A grouped " + label + " median cannot be represented exactly in the selected column. "
                "Cast the column to a wider type before filling missing values."
            )
            checked_fill = "CASE WHEN " + invalid + " THEN error(" + _ow_literal(message) + ") ELSE " + fill + " END"
            summary_ctes = (
                "raw_summary AS (" + summary_select + "), summary AS (SELECT " + normalized_keys + ", "
                + checked_fill + " AS " + fill + " FROM raw_summary)"
            )
    normalized_join = " AND ".join(
        "n." + _ow_ident(name) + " IS NOT DISTINCT FROM s." + _ow_ident(name) for name in key_names
    )
    fill = "s." + _ow_ident(fill_name)
    qualified_target = "n." + target_identifier
    qualified_missing = target_missing.replace(target_identifier, qualified_target)
    replacement = (
        "CASE WHEN " + qualified_missing + " AND " + fill + " IS NOT NULL THEN CAST(" + fill + " AS "
        + target_type + ") ELSE " + qualified_target + " END"
    )
    query = (
        "WITH " + normalized + ", " + summary_ctes + " SELECT n.* EXCLUDE ("
        + _ow_identifiers([original_name] + key_names) + ") REPLACE (" + replacement + " AS "
        + target_identifier + ") FROM normalized n LEFT JOIN summary s ON " + normalized_join
        + " ORDER BY n." + original
    )
    return _ow_query(df, query)


def _ow_fill_missing(df, column, replacement_kind, value):
    types = dict(zip(_ow_columns(df), map(str, df.types)))
    raw_type = types[column]
    lowered_type = raw_type.lower()
    identifier = _ow_ident(column)
    valid = _ow_valid(identifier, raw_type)
    missing = "NOT (" + valid + ")"
    if replacement_kind == "mean":
        if not _ow_is_float(raw_type):
            raise ValueError("Mean fill requires a floating-point column.")
        missing_count = int(
            _ow_query(df, "SELECT count(*) FILTER (WHERE " + missing + ") FROM ow").fetchone()[0]
        )
        if missing_count == 0:
            return df
        positive_infinity = "CAST('Infinity' AS DOUBLE)"
        negative_infinity = "CAST('-Infinity' AS DOUBLE)"
        stats = _ow_query(
            df,
            "SELECT count(*) FILTER (WHERE " + valid + " AND " + identifier + " = "
            + positive_infinity + "), count(*) FILTER (WHERE " + valid + " AND " + identifier
            + " = " + negative_infinity + "), max(abs(" + identifier + ")) FILTER (WHERE "
            + valid + " AND isfinite(" + identifier + ")) FROM ow",
        ).fetchone()
        has_positive_infinity = int(stats[0]) > 0
        has_negative_infinity = int(stats[1]) > 0
        if has_positive_infinity and has_negative_infinity:
            raise ValueError(
                "Cannot fill with the mean because positive and negative infinity make it undefined."
            )
        if has_positive_infinity:
            mean = float("inf")
        elif has_negative_infinity:
            mean = float("-inf")
        else:
            scale = stats[2]
            if scale is None:
                raise ValueError(
                    "Cannot fill with the mean because the selected column has no present numeric values."
                )
            scale = float(scale)
            if scale == 0:
                mean = 0.0
            else:
                scaled_mean = float(
                    _ow_query(
                        df,
                        "SELECT avg(" + identifier + " / " + _ow_literal(scale) + ") FILTER (WHERE "
                        + valid + " AND isfinite(" + identifier + ")) FROM ow",
                    ).fetchone()[0]
                )
                mean = max(-1.0, min(1.0, scaled_mean)) * scale
        replacement = "CAST(" + _ow_literal(mean) + " AS " + raw_type + ")"
        expression = "CASE WHEN " + missing + " THEN " + replacement + " ELSE " + identifier + " END"
        return _ow_assign(df, column, expression)
    if replacement_kind == "mostFrequent":
        missing_count = int(
            _ow_query(df, "SELECT count(*) FILTER (WHERE " + missing + ") FROM ow").fetchone()[0]
        )
        if missing_count == 0:
            return df
        value_name = _ow_unique(_ow_columns(df), "__ow_fill_value")
        count_name = _ow_unique(_ow_columns(df) + [value_name], "__ow_fill_count")
        winner_name = _ow_unique(_ow_columns(df) + [value_name, count_name], "__ow_fill_winner")
        ties_name = _ow_unique(
            _ow_columns(df) + [value_name, count_name, winner_name], "__ow_fill_ties"
        )
        result = _ow_query(
            df,
            "WITH counts AS (SELECT " + identifier + " AS " + _ow_ident(value_name)
            + ", count(*) AS " + _ow_ident(count_name) + " FROM ow WHERE " + valid
            + " GROUP BY " + identifier + "), winners AS (SELECT " + _ow_ident(value_name)
            + " FROM counts WHERE " + _ow_ident(count_name) + " = (SELECT max("
            + _ow_ident(count_name) + ") FROM counts)) SELECT any_value(" + _ow_ident(value_name)
            + ") AS " + _ow_ident(winner_name) + ", count(*) AS " + _ow_ident(ties_name)
            + " FROM winners",
        ).fetchone()
        fill_value, tie_count = result
        tie_count = int(tie_count)
        if tie_count == 0:
            raise ValueError("This column has no non-missing values. Choose a specific value.")
        if tie_count != 1:
            raise ValueError(
                "This column has no single most common value: " + str(tie_count)
                + " values are tied. Choose a specific value."
            )
        replacement = "CAST(" + _ow_literal(fill_value) + " AS " + raw_type + ")"
        expression = "CASE WHEN " + missing + " THEN " + replacement + " ELSE " + identifier + " END"
        return _ow_assign(df, column, expression)
    if replacement_kind == "median":
        if _ow_is_float(raw_type):
            median = _ow_query(
                df,
                "SELECT median(" + identifier + ") FILTER (WHERE " + valid + ") FROM ow",
            ).fetchone()[0]
            if median is None or (isinstance(median, float) and math.isnan(median)):
                raise ValueError(
                    "Cannot fill with the median because the selected column has no present numeric values."
                )
        else:
            count = int(_ow_query(df, "SELECT count(*) FROM ow WHERE " + valid).fetchone()[0])
            if count == 0:
                raise ValueError(
                    "Cannot fill with the median because the selected column has no present numeric values."
                )
            offset = (count - 1) // 2
            limit = 2 if count % 2 == 0 else 1
            middle = _ow_query(
                df,
                "SELECT " + identifier + " FROM ow WHERE " + valid + " ORDER BY " + identifier
                + " LIMIT " + str(limit) + " OFFSET " + str(offset),
            ).fetchall()
            if len(middle) != limit:
                raise ValueError("DuckDB could not retrieve the exact middle values for the median fill.")
            lower, upper = middle[0][0], middle[-1][0]
            if _ow_is_integer(raw_type):
                total = int(lower) + int(upper)
                if total % 2:
                    raise ValueError(
                        "The integer median is fractional. "
                        "Cast the column to float or decimal before filling missing values."
                    )
                median = total // 2
            elif lowered_type.startswith("decimal"):
                precision, scale = _ow_decimal_spec(raw_type)
                with localcontext() as context:
                    context.prec = max(
                        80,
                        precision + scale + 4,
                        len(lower.as_tuple().digits) + len(upper.as_tuple().digits) + scale + 4,
                    )
                    median = (lower + upper) / Decimal(2)
                median = _ow_decimal_at_scale(median, precision, scale)
            else:
                raise ValueError("Cannot calculate a numeric median for DuckDB type " + raw_type + ".")
        literal = _ow_decimal_literal(median) if isinstance(median, Decimal) else _ow_literal(median)
        replacement = "CAST(" + literal + " AS " + raw_type + ")"
        expression = "CASE WHEN " + missing + " THEN " + replacement + " ELSE " + identifier + " END"
        return _ow_assign(df, column, expression)

    if lowered_type.startswith("decimal"):
        precision, scale = _ow_decimal_spec(raw_type)
        value = _ow_decimal_at_scale(Decimal(value), precision, scale)
    elif replacement_kind == "datetime":
        column_aware = _ow_datetime_is_aware(raw_type)
        value_aware = value.tzinfo is not None and value.utcoffset() is not None
        if value_aware != column_aware:
            expected = "timezone-aware" if column_aware else "timezone-naive"
            raise ValueError("The replacement datetime must be " + expected + " to match the selected column.")
    if replacement_kind == "string":
        missing_count = int(
            _ow_query(df, "SELECT count(*) FILTER (WHERE " + missing + ") FROM ow").fetchone()[0]
        )
        if missing_count == 0:
            return df
    literal = _ow_decimal_literal(value) if isinstance(value, Decimal) else _ow_literal(value)
    if lowered_type == "null":
        expression = "CASE WHEN " + identifier + " IS NULL THEN " + literal + " ELSE " + identifier + " END"
    elif replacement_kind == "string":
        expression = (
            "CASE WHEN " + missing + " THEN CAST(" + literal + " AS VARCHAR)"
            + " ELSE CAST(" + identifier + " AS VARCHAR) END"
        )
    else:
        expression = (
            "CASE WHEN " + missing + " THEN CAST(" + literal + " AS " + raw_type + ")"
            + " ELSE " + identifier + " END"
        )
    return _ow_assign(df, column, expression)


def _ow_drop_duplicates(df, columns, keep):
    selected = list(columns) if columns else _ow_visible(df)
    if not selected:
        return df
    order_name = _ow_unique(_ow_columns(df), "__ow_dupe_order")
    rank_name = _ow_unique(_ow_columns(df) + [order_name], "__ow_dupe_rank")
    count_name = _ow_unique(_ow_columns(df) + [order_name, rank_name], "__ow_dupe_count")
    partition = _ow_identifiers(selected)
    direction = "DESC" if keep == "last" else "ASC"
    predicate = _ow_ident(count_name) + " = 1" if keep == "none" else _ow_ident(rank_name) + " = 1"
    query = (
        "WITH numbered AS (SELECT *, row_number() OVER () AS " + _ow_ident(order_name) + " FROM ow), "
        "ranked AS (SELECT *, row_number() OVER (PARTITION BY " + partition + " ORDER BY "
        + _ow_ident(order_name) + " " + direction + ") AS " + _ow_ident(rank_name)
        + ", count(*) OVER (PARTITION BY " + partition + ") AS " + _ow_ident(count_name)
        + " FROM numbered) SELECT * EXCLUDE (" + _ow_identifiers([order_name, rank_name, count_name])
        + ") FROM ranked WHERE " + predicate + " ORDER BY " + _ow_ident(order_name)
    )
    return _ow_query(df, query)


def _ow_check_outputs(existing, generated, operation):
    generated = [str(name) for name in generated]
    if any(name.casefold().startswith('__open_wrangler_internal_row_id_') for name in generated):
        raise ValueError(operation + " would create Open Wrangler's reserved private row-identity column.")
    duplicates = {name for name in generated if generated.count(name) > 1}
    collisions = sorted(duplicates | (set(map(str, existing)) & set(generated)))
    if collisions:
        raise ValueError(operation + " would create duplicate column names: " + ", ".join(collisions))


def _ow_one_hot(df, params):
    columns = list(params["columns"])
    separator = params.get("prefixSeparator", "_")
    generated = []
    types = dict(zip(_ow_columns(df), map(str, df.types)))
    for column in columns:
        identifier = _ow_ident(column)
        values = _ow_query(
            df,
            "SELECT DISTINCT " + identifier + " FROM ow WHERE "
            + _ow_valid(identifier, types[column]) + " AND CAST(" + identifier
            + " AS VARCHAR) <> '' ORDER BY CAST(" + identifier + " AS VARCHAR)",
        ).fetchall()
        generated.extend((column, row[0], str(column) + separator + str(row[0])) for row in values)
    generated.sort(key=lambda item: item[2])
    base = [name for name in _ow_columns(df) if not params.get("dropOriginal", True) or name not in columns]
    _ow_check_outputs(base, [name for _, _, name in generated], "One-hot encoding")
    projections = [_ow_ident(name) for name in base]
    projections.extend(
        "CAST(CASE WHEN " + _ow_ident(column) + " IS NOT DISTINCT FROM " + _ow_literal(value)
        + " THEN 1 ELSE 0 END AS TINYINT) AS " + _ow_ident(name)
        for column, value, name in generated
    )
    if not projections:
        raise ValueError("DuckDB cannot represent a dataframe with zero columns.")
    return _ow_query(df, "SELECT " + ", ".join(projections) + " FROM ow")


def _ow_multi_label(df, params):
    column = params["column"]
    delimiter = params["delimiter"]
    prefix = params.get("prefix", column + "_")
    identifier = _ow_ident(column)
    rows = _ow_query(
        df,
        "SELECT DISTINCT label FROM ow, unnest(string_split(CAST(" + identifier + " AS VARCHAR), "
        + _ow_literal(delimiter) + ")) AS values(label) WHERE label IS NOT NULL AND label <> '' ORDER BY label",
    ).fetchall()
    labels = [str(row[0]) for row in rows]
    base = [name for name in _ow_columns(df) if not params.get("dropOriginal", False) or name != column]
    names = [prefix + label for label in labels]
    _ow_check_outputs(base, names, "Multi-label binarization")
    projections = [_ow_ident(name) for name in base]
    projections.extend(
        "CAST(list_contains(string_split(coalesce(CAST(" + identifier + " AS VARCHAR), ''), "
        + _ow_literal(delimiter) + "), " + _ow_literal(label) + ") AS TINYINT) AS " + _ow_ident(name)
        for label, name in zip(labels, names)
    )
    if not projections:
        raise ValueError("DuckDB cannot represent a dataframe with zero columns.")
    return _ow_query(df, "SELECT " + ", ".join(projections) + " FROM ow")


def _ow_text(df, kind, params):
    column = params["column"]
    target = params.get("newColumn", column)
    value = "CAST(" + _ow_ident(column) + " AS VARCHAR)"
    if kind == "findReplace":
        if not params.get("regex", False) and params["find"] == "":
            replacement = _ow_literal(params["replacement"])
            expression = (
                "CASE WHEN " + value + " = '' THEN " + replacement
                + " ELSE " + replacement + " || array_to_string(string_split("
                + value + ", ''), " + replacement + ") || " + replacement + " END"
            )
        elif params.get("regex", False):
            expression = (
                "regexp_replace(" + value + ", " + _ow_literal(params["find"])
                + ", " + _ow_literal(params["replacement"]) + ", 'g')"
            )
        else:
            expression = (
                "replace(" + value + ", " + _ow_literal(params["find"])
                + ", " + _ow_literal(params["replacement"]) + ")"
            )
    elif kind == "stripText":
        expression = (
            "trim(" + value + ")"
            if params.get("characters") is None
            else "trim(" + value + ", " + _ow_literal(params["characters"]) + ")"
        )
    elif kind == "splitText":
        expression = (
            "string_split(" + value + ", " + _ow_literal(params["delimiter"])
            + ")[" + str(params["index"] + 1) + "]"
        )
    elif kind == "capitalizeText":
        expression = "upper(substr(" + value + ", 1, 1)) || lower(substr(" + value + ", 2))"
    elif kind == "lowerText":
        expression = "lower(" + value + ")"
    else:
        expression = "upper(" + value + ")"
    return _ow_assign(df, target, expression)


def _ow_split_text_columns(df, params):
    output_names = list(params["newColumns"])
    reserved = [
        name for name in output_names if name.casefold().startswith("__open_wrangler_internal_row_id_")
    ]
    if reserved:
        raise ValueError(
            "Splitting text into columns would create Open Wrangler's reserved private row-identity column."
        )
    collisions = sorted((set(_ow_columns(df)) & set(output_names)) | {
        name for name in output_names if output_names.count(name) > 1
    })
    if collisions:
        raise ValueError("Splitting text into columns would create duplicate column names: " + ", ".join(collisions))
    existing_folded = {str(name).casefold() for name in _ow_columns(df)}
    generated_by_fold = {}
    case_collisions = set()
    for name in output_names:
        folded = name.casefold()
        if folded in existing_folded:
            case_collisions.add(name)
        previous = generated_by_fold.get(folded)
        if previous is not None:
            case_collisions.update((previous, name))
        else:
            generated_by_fold[folded] = name
    if case_collisions:
        raise ValueError(
            "Splitting text into columns would create DuckDB column names that differ only by case: "
            + ", ".join(sorted(case_collisions))
        )
    value = "CAST(" + _ow_ident(params["column"]) + " AS VARCHAR)"
    delimiter = _ow_literal(params["delimiter"])
    for index, name in enumerate(output_names, start=1):
        df = _ow_assign(df, name, "string_split(" + value + ", " + delimiter + ")[" + str(index) + "]")
    return df


def _ow_pivot_longer(df, params):
    selected = list(params["columns"])
    outputs = [params["labelColumn"], params["valueColumn"]]
    columns = _ow_columns(df)
    _ow_check_outputs(columns, outputs, "Pivot longer")
    def output_key(value):
        return "".join(
            chr(ord(char) + 32) if "A" <= char <= "Z" else "ss" if char in {"ß", "ẞ"} else char
            for char in value
        )
    existing = {output_key(str(name)): str(name) for name in columns}
    output_keys = [output_key(name) for name in outputs]
    if len(set(output_keys)) != len(output_keys):
        raise ValueError("Pivot-longer output names must differ case-insensitively.")
    if any(key in existing for key in output_keys):
        raise ValueError("Pivot longer would create a DuckDB column name that differs only by case.")
    addressable_existing = {str(name).casefold(): str(name) for name in columns}
    addressable_output_keys = [name.casefold() for name in outputs]
    if len(set(addressable_output_keys)) != len(addressable_output_keys):
        raise ValueError("Pivot-longer output names must remain distinct under DuckDB identifier matching.")
    if any(key in addressable_existing for key in addressable_output_keys):
        raise ValueError("Pivot longer would create a DuckDB column name that differs only by case.")
    types = dict(zip(columns, map(str, df.types)))
    if any(types[name] != types[selected[0]] for name in selected[1:]):
        raise ValueError("Pivot-longer columns must have one exactly compatible DuckDB type.")
    row_count = int(_ow_query(df, "SELECT count(*) FROM ow").fetchone()[0])
    if row_count and row_count > 2147483647 // len(selected):
        raise ValueError("Pivot longer would exceed the portable 2,147,483,647-row limit.")
    unselected = [name for name in columns if name not in set(selected)]
    source_order = _ow_unique(columns, "__ow_pivot_source_order")
    pivot_order = _ow_unique(columns + [source_order], "__ow_pivot_selected_order")
    branches = []
    for ordinal, selected_name in enumerate(selected):
        projections = [_ow_ident(name) for name in unselected]
        projections.extend([
            _ow_literal(selected_name) + " AS " + _ow_ident(params["labelColumn"]),
            _ow_ident(selected_name) + " AS " + _ow_ident(params["valueColumn"]),
            str(ordinal) + " AS " + _ow_ident(pivot_order),
            _ow_ident(source_order),
        ])
        branches.append("SELECT " + ", ".join(projections) + " FROM pivot_source")
    query = (
        "WITH pivot_source AS (SELECT *, row_number() OVER () - 1 AS " + _ow_ident(source_order)
        + " FROM ow), pivot_rows AS (" + " UNION ALL ".join(branches)
        + ") SELECT * EXCLUDE (" + _ow_identifiers([pivot_order, source_order])
        + ") FROM pivot_rows ORDER BY " + _ow_identifiers([pivot_order, source_order])
    )
    return _ow_query(df, query)


def _ow_pivot_wider(df, params):
    names_from = params["namesFrom"]
    values_from = params["valuesFrom"]
    outputs = list(params["outputs"])
    output_values = []
    output_names = []
    for output in outputs:
        token = output.get("key")
        cell = token.get("cell") if isinstance(token, dict) else None
        if (
            not isinstance(token, dict)
            or set(token) != {"kind", "version", "columnType", "cell"}
            or token.get("kind") != "typedSelection"
            or type(token.get("version")) is not int
            or token["version"] != 1
            or token.get("columnType") != "string"
            or not isinstance(cell, dict)
            or set(cell) != {"kind", "raw", "display", "isNull", "isNaN"}
            or cell.get("kind") != "string"
            or not isinstance(cell.get("raw"), str)
            or cell.get("display") != cell.get("raw")
            or cell.get("isNull") is not False
            or cell.get("isNaN") is not False
        ):
            raise ValueError("Pivot wider keys must be canonical present string selection tokens.")
        output_values.append(cell["raw"])
        output_names.append(output["name"])
    columns = _ow_columns(df)
    identifiers = [name for name in columns if name not in {names_from, values_from}]
    def output_key(value):
        return "".join(
            chr(ord(char) + 32) if "A" <= char <= "Z" else "ss" if char in {"ß", "ẞ"} else char
            for char in value
        )
    output_keys = [output_key(name) for name in output_names]
    existing = {output_key(str(name)): str(name) for name in identifiers}
    addressable = [name.casefold() for name in output_names]
    existing_addressable = {str(name).casefold(): str(name) for name in identifiers}
    if (
        len(set(output_keys)) != len(output_keys)
        or any(key in existing for key in output_keys)
        or len(set(addressable)) != len(addressable)
        or any(key in existing_addressable for key in addressable)
    ):
        raise ValueError("Pivot wider would create a DuckDB column name that is not uniquely addressable.")
    if any(name.casefold().startswith("__open_wrangler_internal_row_id_") for name in output_names):
        raise ValueError("Pivot wider would create Open Wrangler's reserved private row-identity column.")
    types = dict(zip(columns, map(str, df.types)))
    if types[names_from].upper() != "VARCHAR" and not types[names_from].upper().startswith("ENUM("):
        raise ValueError("Pivot-wider namesFrom must be a DuckDB text or enum column.")
    def identifier_expression(name):
        raw_type = types[name]
        lowered = raw_type.lower()
        nested = lowered.endswith("[]") or lowered.startswith(("list", "array", "struct", "map", "union"))
        scalar = any(token in lowered for token in (
            "tinyint", "smallint", "integer", "bigint", "hugeint", "utinyint", "usmallint", "uinteger",
            "ubigint", "decimal", "float", "double", "real", "bool", "timestamp", "date", "interval",
            "blob", "bit", "varchar", "char", "enum", "uuid",
        ))
        if nested or not scalar:
            raise ValueError("Pivot wider identifier columns must use the portable group-key scalar family.")
        column = _ow_ident(name)
        grouped = _ow_case_sensitive_group_value(column, raw_type)
        return "CASE WHEN " + _ow_valid(column, raw_type) + " THEN " + grouped + " ELSE NULL END"
    identifier_expressions = [identifier_expression(name) for name in identifiers]
    names_key = _ow_case_sensitive_group_value("CAST(" + _ow_ident(names_from) + " AS VARCHAR)", "VARCHAR")
    allowed = ", ".join("encode(" + _ow_literal(value) + ")" for value in output_values)
    invalid = _ow_query(
        df,
        "SELECT 1 FROM ow WHERE " + _ow_ident(names_from) + " IS NULL OR "
        + names_key + " NOT IN (" + allowed + ") LIMIT 1",
    ).fetchone()
    if invalid is not None:
        raise ValueError("Pivot wider namesFrom values must be present and match one declared typed key.")
    reserved = list(columns)
    identifier_keys = []
    for index, _identifier in enumerate(identifiers):
        key = _ow_unique(reserved, "__ow_pivot_wider_identifier_" + str(index))
        reserved.append(key)
        identifier_keys.append(key)
    names_key_name = _ow_unique(reserved, "__ow_pivot_wider_names_key")
    normalized_identifiers = [
        expression + " AS " + _ow_ident(key)
        for expression, key in zip(identifier_expressions, identifier_keys, strict=True)
    ]
    normalized_projection = ", ".join([
        *normalized_identifiers,
        names_key + " AS " + _ow_ident(names_key_name),
    ])
    duplicate_columns = [*identifier_keys, names_key_name]
    duplicate = _ow_query(
        df,
        "WITH normalized AS (SELECT " + normalized_projection
        + " FROM ow) SELECT 1 FROM normalized GROUP BY "
        + _ow_identifiers(duplicate_columns)
        + " HAVING count(*) > 1 LIMIT 1",
    ).fetchone()
    if duplicate is not None:
        raise ValueError("Pivot wider found duplicate identifier-and-key rows; aggregation is not supported.")
    source_order = _ow_unique(columns, "__ow_pivot_wider_source_order")
    reserved = [*columns, source_order]
    group_marker = _ow_unique(reserved, "__ow_pivot_wider_group")
    reserved.append(group_marker)
    identifier_keys = []
    for index, _identifier in enumerate(identifiers):
        key = _ow_unique(reserved, "__ow_pivot_wider_identifier_" + str(index))
        reserved.append(key)
        identifier_keys.append(key)
    names_key_name = _ow_unique(reserved, "__ow_pivot_wider_names_key")
    group_columns = identifier_keys or [group_marker]
    source_projection = "*"
    if identifier_expressions:
        source_projection += ", " + ", ".join(
            expression + " AS " + _ow_ident(key)
            for expression, key in zip(identifier_expressions, identifier_keys, strict=True)
        )
    source_projection += ", " + names_key + " AS " + _ow_ident(names_key_name)
    if not identifiers:
        source_projection += ", 0 AS " + _ow_ident(group_marker)
    source_projection += ", row_number() OVER () - 1 AS " + _ow_ident(source_order)
    projections = [
        "first(CASE WHEN " + _ow_valid(_ow_ident(name), types[name]) + " THEN " + _ow_ident(name)
        + " ELSE NULL END ORDER BY " + _ow_ident(source_order) + ") AS " + _ow_ident(name)
        for name in identifiers
    ]
    projections.extend(
        "first(" + _ow_ident(values_from) + ") FILTER (WHERE " + _ow_ident(names_key_name)
        + " = encode(" + _ow_literal(key_value) + ")) AS " + _ow_ident(output_name)
        for key_value, output_name in zip(output_values, output_names, strict=True)
    )
    projections.append("min(" + _ow_ident(source_order) + ") AS " + _ow_ident(source_order))
    query = (
        "WITH pivot_source AS (SELECT " + source_projection + " FROM ow), pivot_rows AS (SELECT "
        + ", ".join(projections) + " FROM pivot_source GROUP BY " + _ow_identifiers(group_columns)
        + ") SELECT * EXCLUDE (" + _ow_ident(source_order) + ") FROM pivot_rows ORDER BY "
        + _ow_ident(source_order)
    )
    return _ow_query(df, query)


def _ow_min_max(df, column, target):
    value_name = _ow_unique(_ow_columns(df), "__ow_scale_value")
    value = _ow_ident(value_name)
    minimum = "min(" + value + ") FILTER (WHERE isfinite(" + value + ")) OVER ()"
    maximum = "max(" + value + ") FILTER (WHERE isfinite(" + value + ")) OVER ()"
    expression = (
        "CASE WHEN " + value + " IS NULL OR NOT isfinite(" + value + ") THEN NULL WHEN "
        + minimum + " = " + maximum + " THEN 0.0 ELSE (" + value + " - " + minimum
        + ") / (" + maximum + " - " + minimum + ") END"
    )
    modifier = (
        "* EXCLUDE (" + value + ") REPLACE (" + expression + " AS " + _ow_ident(target) + ")"
        if target in _ow_columns(df)
        else "* EXCLUDE (" + value + "), " + expression + " AS " + _ow_ident(target)
    )
    return _ow_query(
        df,
        "SELECT " + modifier + " FROM (SELECT *, try_cast(" + _ow_ident(column)
        + " AS DOUBLE) AS " + value + " FROM ow)",
    )


def _ow_formula(left, right, operator):
    if operator == "power":
        return "power(" + left + ", " + right + ")"
    symbol = {"add": "+", "subtract": "-", "multiply": "*", "divide": "/", "modulo": "%"}[operator]
    return "(" + left + " " + symbol + " " + right + ")"


def _ow_group_by(df, params):
    keys = list(params["keys"])
    order_name = _ow_unique(_ow_columns(df), "__ow_group_order")
    order = _ow_ident(order_name)
    types = dict(zip(_ow_columns(df), map(str, df.types)))
    key_expressions = []
    projections = []
    for key in keys:
        column = _ow_ident(key)
        expression = (
            "CASE WHEN " + _ow_valid(column, types[key]) + " THEN " + column + " ELSE NULL END"
            if _ow_is_float(types[key])
            else column
        )
        key_expressions.append(expression)
        projections.append(expression + " AS " + column)
    for aggregation in params["aggregations"]:
        column = _ow_ident(aggregation["column"])
        value = (
            "CASE WHEN " + _ow_valid(column, types[aggregation["column"]])
            + " THEN " + column + " ELSE NULL END"
            if _ow_is_float(types[aggregation["column"]])
            else column
        )
        operation = aggregation["operation"]
        if operation == "sum":
            if _ow_is_integer(types[aggregation["column"]]):
                total = "coalesce(sum(CAST(" + value + " AS BIGNUM)), 0::BIGNUM)"
                expression = _ow_checked_integer_result(total)
            else:
                expression = "coalesce(sum(" + value + "), 0)"
        elif operation == "mean":
            expression = "avg(" + value + ")"
        elif operation in {"min", "max"}:
            expression = operation + "(" + value + ")"
        elif operation == "median":
            expression = "median(" + value + ")"
            if "decimal" in types[aggregation["column"]].lower():
                expression = "CAST(" + expression + " AS DOUBLE)"
        elif operation == "count":
            expression = "count(" + value + ")"
        elif operation == "nUnique":
            expression = "count(DISTINCT " + value + ")"
        else:
            direction = "ASC" if operation == "first" else "DESC"
            expression = (
                "first(" + value + " ORDER BY " + order + " " + direction
                + ") FILTER (WHERE " + value + " IS NOT NULL)"
            )
        projections.append(expression + " AS " + _ow_ident(aggregation["alias"]))
    query = (
        "WITH ordered AS (SELECT *, row_number() OVER () AS " + order + " FROM ow) SELECT "
        + ", ".join(projections) + " FROM ordered GROUP BY " + ", ".join(key_expressions)
        + " ORDER BY min(" + order + ")"
    )
    return _ow_query(df, query)
"""
