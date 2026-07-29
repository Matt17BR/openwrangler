from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping
from datetime import timedelta
from importlib import import_module
from math import isfinite
from typing import Any, Literal
from weakref import WeakSet

from .base import (
    INTERNAL_ROW_ID_PREFIX,
    VIEW_COMPARABLE_TYPES,
    DataFrameEngine,
    EngineCapabilities,
    EngineError,
    PageColumnProjection,
    SummaryColumnProjection,
    categorical_visualization,
    coerce_typed_view_value,
    datetime_visualization,
    infer_semantic_type,
    is_internal_row_id_label,
    normalize_cell,
    normalize_page_projection,
    normalize_summary_projection,
    numeric_visualization,
    typed_selection_value,
    validate_view_predicate_operator,
)

_ASCII_LOWER = "abcdefghijklmnopqrstuvwxyz"
_ASCII_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_ASCII_TO_LOWER = str.maketrans(_ASCII_UPPER, _ASCII_LOWER)
_SUPPORTED_PYSPARK_VERSION = re.compile(r"^4\.2(?:\.|$)")
_SUMMARY_VISUALIZATION_SAMPLE_LIMIT = 4096
_UNSUPPORTED_PROFILE_TYPE_ROOTS = frozenset({"variant", "time", "geometry", "geography"})
PYSPARK_PAGE_CELL_LIMIT = 100_000
PYSPARK_PAGE_TRANSPORT_BYTE_LIMIT = 8 * 1024 * 1024
PYSPARK_PAGE_PROTOCOL_BYTE_LIMIT = 16 * 1024 * 1024
PYSPARK_PAGE_COMPLEX_NODE_LIMIT = 100_000
PYSPARK_PAGE_COMPLEX_DEPTH_LIMIT = 64
_JSON_UTF8_VALIDATION_CHUNK_CHARACTERS = 16 * 1024


class PySparkEngine(DataFrameEngine):
    """Read-only native viewing for live classic and Spark Connect dataframes."""

    name = "pyspark"
    runtime_modules = ("pyspark",)
    capabilities = EngineCapabilities(
        source_kinds=frozenset({"notebookVariable"}),
        supports_editing=False,
        lazy_file_extensions=frozenset(),
        export_formats=frozenset(),
        supports_shutdown_interrupt=False,
        supports_request_cancellation=False,
    )

    def __init__(self) -> None:
        self._owned_frame: Any | None = None
        self._owned_row_count: int | None = None
        self._ordered_frames: WeakSet[Any] = WeakSet()
        self._closed = False

    def detect(self, value: Any) -> bool:
        try:
            dataframe_type = import_module("pyspark.sql").DataFrame
        except (ImportError, AttributeError):
            return False
        return isinstance(value, dataframe_type)

    def read_file(self, path: str, options: Mapping[str, Any] | None = None) -> Any:
        del path, options
        raise EngineError("The experimental PySpark backend supports live notebook variables only.")

    def validate_column_addressability(self, frame: Any) -> None:
        self._require_supported_frame(frame)
        names = list(frame.columns)
        folded: dict[str, str] = {}
        for name in names:
            if not isinstance(name, str):
                raise EngineError("PySpark dataframe columns must have string names.")
            normalized = name.casefold()
            previous = folded.get(normalized)
            if previous is not None:
                raise EngineError(
                    "PySpark dataframe columns must be unique without relying on case: "
                    f"{previous!r} conflicts with {name!r}."
                )
            folded[normalized] = name

    def shape(self, frame: Any) -> dict[str, int]:
        rows = (
            self._owned_row_count
            if frame is self._owned_frame and self._owned_row_count is not None
            else int(frame.count())
        )
        return {"rows": int(rows), "columns": len(self._visible_columns(frame))}

    def ensure_row_ids(self, frame: Any, token: str) -> Any:
        self.validate_internal_row_id_namespace(frame)
        self.validate_column_addressability(frame)
        row_id = self._row_id_column(frame)
        if row_id is not None:
            return frame
        if self._owned_frame is not None:
            raise EngineError("A PySpark engine instance may own only one indexed dataframe.")

        row_id = f"{INTERNAL_ROW_ID_PREFIX}{token}"
        indexed = frame.zipWithIndex(row_id)
        persisted = indexed.persist()
        self._owned_frame = persisted
        try:
            self._owned_row_count = int(persisted.count())
        except Exception:
            # The session open-failure path calls close(), which owns the one
            # corresponding unpersist attempt even when materialization fails.
            raise
        return persisted

    def schema(self, frame: Any) -> list[dict[str, Any]]:
        visible = set(self._visible_columns(frame))
        result: list[dict[str, Any]] = []
        for field in frame.schema.fields:
            if field.name not in visible:
                continue
            raw_type = str(field.dataType.simpleString())
            result.append(
                {
                    "id": f"c:{len(result)}",
                    "name": field.name,
                    "position": len(result),
                    "rawType": raw_type,
                    "type": infer_semantic_type(raw_type),
                    "nullable": bool(field.nullable),
                }
            )
        return result

    def apply_filter_model(self, frame: Any, model: Mapping[str, Any]) -> Any:
        functions = import_module("pyspark.sql.functions")
        type_by_column = self._type_by_column(frame)
        column_expressions: list[Any] = []
        for column_filter in model.get("filters", []):
            column_name = column_filter.get("column")
            if column_name not in type_by_column:
                continue
            raw_type, column_type = type_by_column[column_name]
            declared_type = column_filter.get("type")
            if declared_type != column_type:
                raise EngineError(
                    f"PySpark view filter for {column_name!r} declares {declared_type!r}, "
                    f"but the dataframe column is {column_type!r}."
                )
            column = _spark_column(functions, column_name)
            conditions: list[Any] = []
            value_filter = column_filter.get("valueFilter")
            if value_filter and (
                value_filter.get("selectedValues") or value_filter.get("includeNulls") or value_filter.get("includeNaN")
            ):
                selected = [
                    coerce_typed_view_value(value, column_type) for value in value_filter.get("selectedValues", [])
                ]
                current = column.isin(selected) if selected else functions.lit(False)
                if value_filter.get("includeNulls"):
                    current = current | column.isNull()
                if value_filter.get("includeNaN") and column_type == "float":
                    current = current | functions.isnan(column)
                conditions.append(current)

            for predicate in column_filter.get("predicates", []):
                conditions.append(self._predicate_expression(functions, column, predicate, column_type, raw_type))

            if conditions:
                current = conditions[0]
                for condition in conditions[1:]:
                    current = current | condition if column_filter.get("logic") == "or" else current & condition
                column_expressions.append(current)

        result = frame
        if column_expressions:
            current = column_expressions[0]
            for expression in column_expressions[1:]:
                current = current | expression if model.get("logic") == "or" else current & expression
            result = result.filter(current)

        sort_expressions: list[Any] = []
        for rule in model.get("sort", []):
            column_name = rule.get("column")
            if column_name not in type_by_column:
                continue
            _raw_type, column_type = type_by_column[column_name]
            if column_type not in VIEW_COMPARABLE_TYPES:
                raise EngineError(f"PySpark view sorting is unavailable for {column_type} columns.")
            column = _spark_column(functions, column_name)
            direction = rule.get("direction", "asc")
            nulls = rule.get("nulls", "last")
            method = f"{direction}_nulls_{nulls}"
            sort_expressions.append(getattr(column, method)())

        if sort_expressions:
            row_id = self._row_id_column(result)
            if row_id is not None:
                sort_expressions.append(_spark_column(functions, row_id).asc())
            result = result.orderBy(*sort_expressions)
            self._ordered_frames.add(result)
        return result

    def page(
        self,
        frame: Any,
        offset: int,
        limit: int,
        *,
        total_rows: int | None = None,
        column_projection: PageColumnProjection | None = None,
    ) -> dict[str, Any]:
        if offset < 0 or limit < 0:
            raise EngineError("PySpark page offset and limit must be non-negative.")
        functions = import_module("pyspark.sql.functions")
        visible = self._visible_columns(frame)
        projection = normalize_page_projection(len(visible), column_projection)
        selected_columns = [visible[position] for position, _identifier in projection]
        column_ids = [identifier for _position, identifier in projection]
        maximum_cells = int(limit) * len(selected_columns)
        if maximum_cells > PYSPARK_PAGE_CELL_LIMIT:
            raise EngineError(
                f"PySpark pages may contain at most {PYSPARK_PAGE_CELL_LIMIT:,} cells; "
                f"this window could contain {maximum_cells:,}. Request fewer rows or columns."
            )
        row_id = self._row_id_column(frame)

        if frame is self._owned_frame and row_id is not None:
            row_identity = _spark_column(functions, row_id)
            windowed = (
                frame.where(
                    (row_identity >= functions.lit(int(offset))) & (row_identity < functions.lit(int(offset + limit)))
                )
                .orderBy(row_identity.asc())
                .limit(int(limit))
            )
        else:
            ordered = frame
            if frame not in self._ordered_frames and row_id is not None:
                ordered = frame.orderBy(_spark_column(functions, row_id).asc())
            windowed = ordered.offset(int(offset)).limit(int(limit))
        field_by_column = self._field_by_column(frame)
        transports = [
            _page_transport_expression(functions, _spark_column(functions, name), field_by_column[name].dataType)
            for name in selected_columns
        ]
        self._validate_page_transport_size(functions, windowed, [expression for expression, _kind in transports])

        terminal_expressions = []
        if row_id is not None:
            terminal_expressions.append(_spark_column(functions, row_id).alias("__ow_page_row_id"))
        terminal_expressions.extend(
            expression.alias(f"__ow_page_value_{index}") for index, (expression, _kind) in enumerate(transports)
        )
        terminal = windowed.select(*terminal_expressions)
        records = terminal.collect()

        rows = []
        remaining_complex_nodes = PYSPARK_PAGE_COMPLEX_NODE_LIMIT
        value_offset = 1 if row_id is not None else 0
        for row_number, record in enumerate(records, start=offset):
            identity = record[0] if row_id is not None else row_number
            values = []
            for index, (_expression, transport_kind) in enumerate(transports):
                cell, consumed_nodes = _normalize_page_transport(
                    record[value_offset + index],
                    transport_kind,
                    remaining_complex_nodes,
                )
                remaining_complex_nodes -= consumed_nodes
                values.append(cell)
            rows.append(
                {
                    "id": f"r:{row_id}:{identity}" if row_id is not None else f"r:{row_number}",
                    "rowNumber": row_number,
                    "values": values,
                }
            )
        page = {
            "offset": offset,
            "limit": limit,
            "totalRows": self.shape(frame)["rows"] if total_rows is None else int(total_rows),
            "columnIds": column_ids,
            "rows": rows,
        }
        _validate_page_protocol_size(page)
        return page

    def summaries(
        self,
        frame: Any,
        column_projection: SummaryColumnProjection | None = None,
    ) -> list[dict[str, Any]]:
        functions = import_module("pyspark.sql.functions")
        visible = self._visible_columns(frame)
        projection = normalize_summary_projection(len(visible), column_projection)
        type_by_column = self._type_by_column(frame)
        summaries: list[dict[str, Any]] = []
        for position, column_id in projection:
            column_name = visible[position]
            raw_type, column_type = type_by_column[column_name]
            data_type = self._field_by_column(frame)[column_name].dataType
            column = _spark_column(functions, column_name)
            nan = functions.isnan(column) if column_type == "float" else functions.lit(False)
            valid = column.isNotNull() & ~nan
            grouped_value = self._groupable_value(functions, column, data_type)
            display_value = self._profile_display_value(functions, column, data_type)

            metric_expressions: list[Any] = [
                functions.count(functions.lit(1)).alias("__ow_total"),
                functions.sum(functions.when(column.isNull(), 1).otherwise(0)).alias("__ow_null"),
                functions.sum(functions.when(nan, 1).otherwise(0)).alias("__ow_nan"),
                functions.countDistinct(functions.when(valid, grouped_value)).alias("__ow_distinct"),
            ]
            if column_type in {"integer", "float", "decimal"}:
                valid_column = functions.when(valid, column)
                metric_expressions.extend(
                    [
                        functions.min(valid_column).alias("__ow_min"),
                        functions.max(valid_column).alias("__ow_max"),
                        functions.avg(valid_column).alias("__ow_mean"),
                        functions.median(valid_column).alias("__ow_median"),
                        functions.stddev_samp(valid_column).alias("__ow_std"),
                    ]
                )
            elif column_type == "boolean":
                metric_expressions.extend(
                    [
                        functions.sum(functions.when(column.isNotNull() & column, 1).otherwise(0)).alias("__ow_true"),
                        functions.sum(functions.when(column.isNotNull() & ~column, 1).otherwise(0)).alias("__ow_false"),
                    ]
                )
            elif column_type in {"datetime", "date"}:
                metric_expressions.extend(
                    [
                        functions.min(column).alias("__ow_min"),
                        functions.max(column).alias("__ow_max"),
                    ]
                )

            metrics = frame.agg(*metric_expressions).collect()[0]
            total_count = int(metrics["__ow_total"] or 0)
            null_count = int(metrics["__ow_null"] or 0)
            nan_count = int(metrics["__ow_nan"] or 0)
            top_rows = (
                frame.where(valid)
                .select(
                    grouped_value.alias("__ow_group_key"),
                    display_value.alias("__ow_display_value"),
                )
                .groupBy("__ow_group_key")
                .agg(
                    functions.count(functions.lit(1)).alias("count"),
                    functions.first("__ow_display_value", ignorenulls=False).alias("__ow_value"),
                )
                .orderBy(functions.desc("count"), functions.asc(functions.col("__ow_value").cast("string")))
                .limit(10)
                .collect()
            )
            top_values = [
                {
                    "value": normalize_cell(_spark_python_value(row["__ow_value"]))["display"],
                    "count": int(row["count"]),
                }
                for row in top_rows
            ]
            summary: dict[str, Any] = {
                "columnId": column_id,
                "column": column_name,
                "type": column_type,
                "rawType": raw_type,
                "totalCount": total_count,
                "nullCount": null_count,
                "nanCount": nan_count,
                "distinctCount": int(metrics["__ow_distinct"] or 0),
                "topValues": top_values,
            }
            valid_count = total_count - null_count - nan_count
            if column_type in {"integer", "float", "decimal"}:
                numeric = {
                    "min": _finite_float(metrics["__ow_min"]),
                    "max": _finite_float(metrics["__ow_max"]),
                    "mean": _finite_float(metrics["__ow_mean"]),
                    "median": _finite_float(metrics["__ow_median"]),
                    "std": _finite_float(metrics["__ow_std"]),
                }
                summary["numeric"] = {key: value for key, value in numeric.items() if value is not None}
                sample_rows = (
                    frame.where(valid)
                    .select(column.alias("__ow_value"))
                    .limit(_SUMMARY_VISUALIZATION_SAMPLE_LIMIT)
                    .collect()
                )
                visualization = numeric_visualization(_spark_python_value(row["__ow_value"]) for row in sample_rows)
                if valid_count > _SUMMARY_VISUALIZATION_SAMPLE_LIMIT:
                    visualization["sampled"] = True
                summary["visualization"] = visualization
            elif column_type == "boolean":
                summary["visualization"] = {
                    "kind": "boolean",
                    "trueCount": int(metrics["__ow_true"] or 0),
                    "falseCount": int(metrics["__ow_false"] or 0),
                }
            elif column_type in {"datetime", "date"}:
                summary["visualization"] = datetime_visualization(metrics["__ow_min"], metrics["__ow_max"])
            else:
                summary["visualization"] = categorical_visualization(top_values, valid_count)
            summaries.append(summary)
        return summaries

    def header_stats(self, frame: Any) -> dict[str, Any]:
        functions = import_module("pyspark.sql.functions")
        visible = self._visible_columns(frame)
        if not visible:
            row_count = self.shape(frame)["rows"]
            return {
                "missingCells": 0,
                "missingRows": 0,
                "duplicateRows": max(0, row_count - 1),
                "missingValuesByColumn": [],
            }

        type_by_column = self._type_by_column(frame)
        missing_expressions: list[Any] = []
        metrics: list[Any] = []
        aliases: list[str] = []
        for index, column_name in enumerate(visible):
            _raw_type, column_type = type_by_column[column_name]
            column = _spark_column(functions, column_name)
            missing = column.isNull()
            if column_type == "float":
                missing = missing | functions.isnan(column)
            alias = f"__ow_missing_{index}"
            missing_expressions.append(missing)
            metrics.append(functions.sum(functions.when(missing, 1).otherwise(0)).alias(alias))
            aliases.append(alias)

        missing_row = missing_expressions[0]
        for expression in missing_expressions[1:]:
            missing_row = missing_row | expression
        metrics.append(functions.sum(functions.when(missing_row, 1).otherwise(0)).alias("__ow_missing_rows"))
        counts = frame.agg(*metrics).collect()[0]

        field_by_column = self._field_by_column(frame)
        visible_columns = [
            self._groupable_value(
                functions,
                _spark_column(functions, name),
                field_by_column[name].dataType,
            ).alias(f"__ow_duplicate_{index}")
            for index, name in enumerate(visible)
        ]
        duplicate_result = (
            frame.groupBy(*visible_columns)
            .count()
            .agg(functions.sum(functions.col("count") - 1).alias("__ow_duplicates"))
            .collect()[0]
        )
        missing_by_column = [
            {"column": column_name, "count": int(counts[alias] or 0)}
            for column_name, alias in zip(visible, aliases, strict=True)
        ]
        return {
            "missingCells": sum(item["count"] for item in missing_by_column),
            "missingRows": int(counts["__ow_missing_rows"] or 0),
            "duplicateRows": int(duplicate_result["__ow_duplicates"] or 0),
            "missingValuesByColumn": missing_by_column,
        }

    def column_values(
        self,
        frame: Any,
        column: str,
        search: str | None = None,
        limit: int = 100,
    ) -> tuple[list[dict[str, Any]], bool]:
        if limit < 0:
            raise EngineError("PySpark column-value limit must be non-negative.")
        functions = import_module("pyspark.sql.functions")
        type_by_column = self._type_by_column(frame)
        if column not in type_by_column:
            raise EngineError(f"Unknown PySpark column: {column}")
        _raw_type, column_type = type_by_column[column]
        data_type = self._field_by_column(frame)[column].dataType
        expression = _spark_column(functions, column)
        valid = expression.isNotNull()
        if column_type == "float":
            valid = valid & ~functions.isnan(expression)
        filtered = frame.where(valid)
        if search:
            folded = functions.translate(expression.cast("string"), _ASCII_UPPER, _ASCII_LOWER)
            filtered = filtered.where(folded.contains(str(search).translate(_ASCII_TO_LOWER)))

        grouped_value = self._groupable_value(functions, expression, data_type)
        display_value = self._profile_display_value(functions, expression, data_type)
        rows = (
            filtered.select(
                grouped_value.alias("__ow_group_key"),
                display_value.alias("__ow_display_value"),
            )
            .groupBy("__ow_group_key")
            .agg(
                functions.count(functions.lit(1)).alias("count"),
                functions.first("__ow_display_value", ignorenulls=False).alias("__ow_value"),
            )
            .orderBy(functions.desc("count"), functions.asc(functions.col("__ow_value").cast("string")))
            .limit(int(limit) + 1)
            .collect()
        )
        values = []
        for row in rows[:limit]:
            value = _spark_python_value(row["__ow_value"])
            item: dict[str, Any] = {
                "value": normalize_cell(value)["display"],
                "count": int(row["count"]),
            }
            selection = typed_selection_value(value, column_type)
            if selection is not None:
                item["selectionValue"] = selection
            values.append(item)
        return values, len(rows) > limit

    def apply_transform(self, frame: Any, step: Mapping[str, Any]) -> Any:
        del frame, step
        raise EngineError("The experimental PySpark backend is read-only.")

    def compile_plan(self, steps: Iterable[Mapping[str, Any]]) -> str:
        del steps
        raise EngineError("The experimental PySpark backend does not generate cleaning code.")

    def export_data(self, frame: Any, path: str, format_name: Literal["csv", "parquet"]) -> None:
        del frame, path, format_name
        raise EngineError("The experimental PySpark backend does not export data.")

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        owned = self._owned_frame
        self._owned_frame = None
        self._owned_row_count = None
        self._ordered_frames.clear()
        if owned is not None:
            owned.unpersist(blocking=False)

    def _predicate_expression(
        self,
        functions: Any,
        column: Any,
        predicate: Mapping[str, Any],
        column_type: str,
        raw_type: str,
    ) -> Any:
        del raw_type
        operator = validate_view_predicate_operator(column_type, predicate.get("operator"))
        if operator == "isNull":
            return column.isNull()
        if operator == "isNotNull":
            return column.isNotNull()
        if operator == "isNaN":
            return functions.isnan(column)
        if operator == "isNotNaN":
            return ~functions.isnan(column)

        value = predicate.get("value")
        if operator == "contains":
            folded = functions.translate(column.cast("string"), _ASCII_UPPER, _ASCII_LOWER)
            return folded.contains(str(value).translate(_ASCII_TO_LOWER)) & column.isNotNull()
        if operator == "startsWith":
            return column.startswith(str(value)) & column.isNotNull()
        if operator == "endsWith":
            return column.endswith(str(value)) & column.isNotNull()

        coerced = coerce_typed_view_value(value, column_type)
        if operator == "equals":
            result = column == functions.lit(coerced)
        elif operator == "notEquals":
            result = column != functions.lit(coerced)
        elif operator == "gt":
            result = column > functions.lit(coerced)
        elif operator == "gte":
            result = column >= functions.lit(coerced)
        elif operator == "lt":
            result = column < functions.lit(coerced)
        elif operator == "lte":
            result = column <= functions.lit(coerced)
        else:
            second = coerce_typed_view_value(predicate.get("secondValue"), column_type)
            result = column.between(functions.lit(coerced), functions.lit(second))

        present = column.isNotNull()
        if column_type == "float":
            present = present & ~functions.isnan(column)
        return result & present

    @staticmethod
    def _groupable_value(functions: Any, column: Any, data_type: Any) -> Any:
        type_name = type(data_type).__name__
        if type_name in {"ArrayType", "MapType", "StructType"}:
            return _canonical_spark_value(functions, column, data_type)
        if type_name == "BinaryType":
            return functions.base64(column)
        return column

    @staticmethod
    def _profile_display_value(functions: Any, column: Any, data_type: Any) -> Any:
        type_name = type(data_type).__name__
        if type_name in {"ArrayType", "MapType", "StructType"}:
            return functions.to_json(column, {"ignoreNullFields": "false"})
        if type_name == "BinaryType":
            return functions.base64(column)
        return column

    @staticmethod
    def _validate_page_transport_size(functions: Any, frame: Any, expressions: list[Any]) -> None:
        if not expressions:
            return
        byte_terms = [
            functions.coalesce(
                functions.length(functions.encode(expression.cast("string"), "UTF-8")).cast("long"),
                functions.lit(0).cast("long"),
            )
            for expression in expressions
        ]
        row_bytes = byte_terms[0]
        for term in byte_terms[1:]:
            row_bytes = row_bytes + term
        result = frame.agg(functions.sum(row_bytes).alias("__ow_page_value_bytes")).collect()[0]
        byte_count = int(result["__ow_page_value_bytes"] or 0)
        if byte_count > PYSPARK_PAGE_TRANSPORT_BYTE_LIMIT:
            raise EngineError(
                f"PySpark page values may contain at most {PYSPARK_PAGE_TRANSPORT_BYTE_LIMIT:,} UTF-8 bytes; "
                f"this window contains {byte_count:,}. Request fewer rows or columns, or shorten large values."
            )

    def _type_by_column(self, frame: Any) -> dict[str, tuple[str, str]]:
        visible = set(self._visible_columns(frame))
        result: dict[str, tuple[str, str]] = {}
        for field in frame.schema.fields:
            if field.name in visible:
                raw_type = str(field.dataType.simpleString())
                result[field.name] = (raw_type, infer_semantic_type(raw_type))
        return result

    def _field_by_column(self, frame: Any) -> dict[str, Any]:
        visible = set(self._visible_columns(frame))
        return {field.name: field for field in frame.schema.fields if field.name in visible}

    def _row_id_column(self, frame: Any) -> str | None:
        value = self.internal_row_id_column(frame)
        return str(value) if value is not None else None

    def _visible_columns(self, frame: Any) -> list[str]:
        return [str(name) for name in frame.columns if not is_internal_row_id_label(name)]

    @staticmethod
    def _require_supported_frame(frame: Any) -> None:
        if bool(frame.isStreaming):
            raise EngineError("Streaming PySpark dataframes are not supported.")
        version = str(getattr(import_module("pyspark"), "__version__", ""))
        if _SUPPORTED_PYSPARK_VERSION.match(version) is None:
            raise EngineError(f"The experimental PySpark backend requires PySpark 4.2.x, not {version or 'unknown'}.")
        if not callable(getattr(frame, "zipWithIndex", None)):
            raise EngineError("This PySpark dataframe does not provide the required native zipWithIndex operation.")
        unsupported: list[tuple[str, str]] = []
        for field in frame.schema.fields:
            raw_type = str(field.dataType.simpleString())
            if _contains_unsupported_profile_type(field.dataType):
                unsupported.append((str(field.name), raw_type))
        if unsupported:
            details = ", ".join(f"{name!r} ({raw_type})" for name, raw_type in unsupported)
            raise EngineError(
                "The experimental PySpark backend cannot open this dataframe because required viewing profiles "
                f"are unavailable for {details}. Convert these columns in Spark to strings or another orderable "
                "Spark SQL type before opening them in Open Wrangler."
            )


def _spark_column(functions: Any, name: str) -> Any:
    escaped = name.replace("`", "``")
    return functions.col(f"`{escaped}`")


def _is_unsupported_profile_type(raw_type: str) -> bool:
    lowered = raw_type.strip().lower()
    root = lowered.split("(", 1)[0]
    if root in _UNSUPPORTED_PROFILE_TYPE_ROOTS:
        return True
    # Calendar intervals and year-month interval values cannot be decoded
    # after the grouping actions required by header statistics. Day-time
    # intervals are natively collectable and remain supported.
    return lowered == "interval" or lowered.startswith(("interval year", "interval month"))


def _contains_unsupported_profile_type(data_type: Any) -> bool:
    """Reject unsupported Spark SQL leaves even when nested in a container."""

    pending = [data_type]
    visited: set[int] = set()
    while pending:
        current = pending.pop()
        identity = id(current)
        if identity in visited:
            continue
        visited.add(identity)

        simple_string = getattr(current, "simpleString", None)
        raw_type = str(simple_string()) if callable(simple_string) else str(current)
        if _is_unsupported_profile_type(raw_type):
            return True

        fields = getattr(current, "fields", None)
        if isinstance(fields, list | tuple):
            pending.extend(
                field_type for field in fields if (field_type := getattr(field, "dataType", None)) is not None
            )
        for attribute in ("elementType", "keyType", "valueType"):
            nested = getattr(current, attribute, None)
            if nested is not None:
                pending.append(nested)
    return False


def _canonical_spark_value(functions: Any, column: Any, data_type: Any) -> Any:
    """Return one orderable native key while preserving nested Spark semantics."""

    type_name = type(data_type).__name__
    json_options = {"ignoreNullFields": "false"}
    if type_name == "ArrayType":
        canonical = functions.transform(
            column,
            lambda item: _canonical_spark_value(functions, item, data_type.elementType),
        )
        return functions.when(column.isNull(), functions.lit(None).cast("string")).otherwise(
            functions.to_json(canonical, json_options)
        )
    if type_name == "MapType":
        canonical_entries = functions.transform(
            functions.map_entries(column),
            lambda entry: functions.struct(
                _canonical_spark_value(functions, entry.getField("key"), data_type.keyType).alias("key"),
                _canonical_spark_value(functions, entry.getField("value"), data_type.valueType).alias("value"),
            ),
        )
        return functions.when(column.isNull(), functions.lit(None).cast("string")).otherwise(
            functions.to_json(functions.array_sort(canonical_entries), json_options)
        )
    if type_name == "StructType":
        canonical_fields = [
            _canonical_spark_value(functions, column.getField(field.name), field.dataType).alias(f"field_{index}")
            for index, field in enumerate(data_type.fields)
        ]
        return functions.when(column.isNull(), functions.lit(None).cast("string")).otherwise(
            functions.to_json(functions.struct(*canonical_fields), json_options)
        )
    if type_name == "BinaryType":
        return functions.to_json(functions.array(functions.base64(column)), json_options)
    return functions.to_json(functions.array(column.cast("string")), json_options)


def _page_transport_expression(functions: Any, column: Any, data_type: Any) -> tuple[Any, str]:
    type_name = type(data_type).__name__
    if type_name in {"ArrayType", "MapType", "StructType"}:
        return functions.to_json(column, {"ignoreNullFields": "false"}), "json"
    if type_name == "BinaryType":
        return functions.base64(column), "binary"
    return column, "raw"


def _normalize_page_transport(value: Any, kind: str, remaining_nodes: int) -> tuple[dict[str, Any], int]:
    if kind == "raw":
        return normalize_cell(_spark_python_value(value)), 0
    if value is None:
        return normalize_cell(None), 0
    if not isinstance(value, str):
        raise EngineError("PySpark paging returned a malformed bounded value.")
    if kind == "binary":
        return {
            "kind": "binary",
            "raw": value,
            "display": value,
            "isNull": False,
            "isNaN": False,
        }, 0
    if kind != "json":
        raise EngineError("PySpark paging returned an unknown bounded-value encoding.")

    nodes, depth = _json_graph_metrics(value, remaining_nodes)
    if depth > PYSPARK_PAGE_COMPLEX_DEPTH_LIMIT:
        raise EngineError(
            "PySpark page complex values may contain at most "
            f"{PYSPARK_PAGE_COMPLEX_DEPTH_LIMIT} nested levels; encountered depth {depth}. "
            "Request a simpler projection before opening this value."
        )
    try:
        decoded = json.loads(value)
    except (TypeError, ValueError, RecursionError) as error:
        raise EngineError(f"PySpark paging returned malformed strict JSON: {error}") from error
    return normalize_cell(decoded), nodes


def _json_graph_metrics(value: str, remaining_nodes: int) -> tuple[int, int]:
    """Count a conservative JSON graph before allocating its Python containers."""

    nodes = 0
    depth = 0
    maximum_depth = 0
    index = 0
    length = len(value)

    def add_node() -> None:
        nonlocal nodes
        nodes += 1
        if nodes > remaining_nodes:
            consumed = PYSPARK_PAGE_COMPLEX_NODE_LIMIT - remaining_nodes + nodes
            raise EngineError(
                "PySpark page complex values may contain at most "
                f"{PYSPARK_PAGE_COMPLEX_NODE_LIMIT:,} JSON nodes; encountered at least {consumed:,}. "
                "Request fewer rows or columns, or simplify nested values."
            )

    while index < length:
        character = value[index]
        if character.isspace() or character in ",:":
            index += 1
            continue
        if character == '"':
            add_node()
            index += 1
            while index < length:
                current = value[index]
                if current == "\\":
                    index += 2
                    continue
                index += 1
                if current == '"':
                    break
            continue
        if character in "[{":
            add_node()
            depth += 1
            maximum_depth = max(maximum_depth, depth)
            index += 1
            continue
        if character in "]}":
            depth = max(0, depth - 1)
            index += 1
            continue

        add_node()
        index += 1
        while index < length and not value[index].isspace() and value[index] not in ",:]}":
            index += 1
    return nodes, maximum_depth


def _validate_page_protocol_size(page: dict[str, Any]) -> None:
    encoder = json.JSONEncoder(ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    serialized_bytes = 0
    try:
        for serialized_chunk in encoder.iterencode(page):
            for offset in range(0, len(serialized_chunk), _JSON_UTF8_VALIDATION_CHUNK_CHARACTERS):
                serialized_bytes += len(
                    serialized_chunk[offset : offset + _JSON_UTF8_VALIDATION_CHUNK_CHARACTERS].encode("utf-8")
                )
                if serialized_bytes > PYSPARK_PAGE_PROTOCOL_BYTE_LIMIT:
                    raise EngineError(
                        f"PySpark pages may contain at most {PYSPARK_PAGE_PROTOCOL_BYTE_LIMIT:,} serialized bytes. "
                        "Request fewer rows or columns, or shorten large values."
                    )
    except (TypeError, ValueError, RecursionError) as error:
        raise EngineError(f"PySpark paging could not produce strict JSON: {error}") from error


def _spark_python_value(value: Any) -> Any:
    if isinstance(value, bytearray):
        return bytes(value)
    if isinstance(value, timedelta):
        return value
    as_dict = getattr(value, "asDict", None)
    if callable(as_dict):
        result = as_dict(recursive=False)
        if isinstance(result, Mapping):
            return {str(key): _spark_python_value(item) for key, item in result.items()}
    if isinstance(value, Mapping):
        return {str(key): _spark_python_value(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [_spark_python_value(item) for item in value]
    return value


def _finite_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return result if isfinite(result) else None
