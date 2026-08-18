from __future__ import annotations

import os
from collections.abc import Callable, Iterable, Mapping, Sequence
from decimal import Decimal
from importlib import import_module
from importlib.util import find_spec
from inspect import signature
from math import isfinite
from pathlib import Path
from typing import Any, Literal

from ..custom_code_output import append_custom_code_output, capture_custom_code_output, custom_code_error_message
from ..export_target import ExportWriterPath
from ..portable_regex import (
    MAX_PORTABLE_REGEX_TEXT_CODE_POINTS,
    MAX_PORTABLE_REGEX_TEXT_UTF8_BYTES,
    PORTABLE_REGEX_TEXT_LIMIT_MESSAGE,
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
    normalize_cell,
    normalize_page_projection,
    normalize_summary_projection,
    normalized_numeric_sum,
    numeric_histogram_bin_count,
    numeric_histogram_edges,
    numeric_visualization_from_bin_counts,
    require_datetime_fill_awareness,
    resolve_excel_sheet_selector,
    typed_selection_value,
    validate_view_predicate_operator,
)

_ASCII_LOWER = "abcdefghijklmnopqrstuvwxyz"
_ASCII_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_ASCII_TO_LOWER = str.maketrans(_ASCII_UPPER, _ASCII_LOWER)
_ASCII_LOWER_REPLACEMENTS = dict(zip(_ASCII_UPPER, _ASCII_LOWER, strict=True))
_PORTABLE_INTEGER_MAX = 10**38 - 1
_PORTABLE_INTEGER_MIN = -_PORTABLE_INTEGER_MAX
_POLARS_INTEGER_LIMB_BASE = 10**9
_POLARS_INTEGER_LIMB_COUNT = 5


def _literal_file_uri(path: str) -> str:
    """Return an encoded local-file URI for Polars versions without `glob=False`."""

    return Path(path).expanduser().absolute().as_uri()


def _scan_literal_file(scanner: Callable[..., Any], path: str, **options: Any) -> Any:
    """Scan exactly one local file without treating its name as a glob pattern."""

    try:
        supports_glob = "glob" in signature(scanner).parameters
    except (TypeError, ValueError):
        supports_glob = False
    if supports_glob:
        return scanner(path, glob=False, **options)
    # Older scan APIs, including scan_ndjson in current Polars, do not expose `glob`.
    # An encoded file URI preserves lazy native scanning while making wildcard
    # characters part of the literal local path.
    return scanner(_literal_file_uri(path), **options)


class PolarsEngine(DataFrameEngine):
    name = "polars"
    runtime_modules = ("polars",)
    capabilities = EngineCapabilities(
        source_kinds=frozenset({"file", "notebookVariable", "notebookOutput"}),
        supports_editing=True,
        lazy_file_extensions=frozenset({".csv", ".tsv", ".parquet", ".jsonl", ".ndjson"}),
        export_formats=frozenset({"csv", "parquet"}),
        supports_shutdown_interrupt=False,
        supports_request_cancellation=False,
    )

    def prepare(self, source: Mapping[str, Any] | None = None) -> None:
        super().prepare(source)
        if source is None or source.get("kind") != "file":
            return
        path = source.get("path")
        if not isinstance(path, str) or Path(path).suffix.lower() not in {".xlsx", ".xls"}:
            return
        # Supported fastexcel releases either import PyArrow directly or use it
        # for eager Calamine output when installed. Initialize that optional
        # native bridge on the owner thread before Excel enters an executor.
        if find_spec("pyarrow") is not None:
            import_module("pyarrow")

    def detect(self, value: Any) -> bool:
        try:
            import polars as pl
        except ImportError:
            return False
        return isinstance(value, (pl.DataFrame, pl.LazyFrame, pl.Series))

    def read_file(self, path: str, options: Mapping[str, Any] | None = None) -> Any:
        import polars as pl

        options = options or {}
        extension = Path(path).suffix.lower()
        if extension in {".csv", ".tsv"}:
            requested_encoding = str(options.get("encoding", "utf8")).lower()
            if requested_encoding not in {"utf-8", "utf8", "utf8-lossy"}:
                raise EngineError(
                    f"Polars supports UTF-8 CSV input, not {requested_encoding}. "
                    "Use the Pandas backend for this encoding."
                )
            encoding: Literal["utf8", "utf8-lossy"] = "utf8-lossy" if requested_encoding == "utf8-lossy" else "utf8"
            if is_blank_delimited_file(
                path,
                encoding="utf-8",
                errors="replace" if encoding == "utf8-lossy" else "strict",
            ):
                return pl.DataFrame().lazy()
            return _scan_literal_file(
                pl.scan_csv,
                path,
                separator=options.get("delimiter", "\t" if extension == ".tsv" else ","),
                encoding=encoding,
                quote_char=options.get("quoteChar", '"'),
                has_header=options.get("hasHeader", True),
            )
        if extension == ".parquet":
            return _scan_literal_file(pl.scan_parquet, path)
        if extension in {".jsonl", ".ndjson"}:
            return _scan_literal_file(pl.scan_ndjson, path)
        if extension in {".xlsx", ".xls"}:
            sheet_selector = resolve_excel_sheet_selector(options)
            if sheet_selector[0] == "sheetIndex":
                # The public import option is zero-based, while fastexcel's
                # sheet_id follows spreadsheet conventions and is one-based.
                return pl.read_excel(path, sheet_id=sheet_selector[1] + 1, engine="calamine")
            return pl.read_excel(path, sheet_name=sheet_selector[1], engine="calamine")
        raise EngineError(f"Unsupported file extension for Polars backend: {extension}")

    def normalize(self, value: Any) -> Any:
        import polars as pl

        if isinstance(value, pl.Series):
            return value.to_frame()
        return value

    def is_lazy(self, frame: Any, source: Mapping[str, Any]) -> bool:
        import polars as pl

        del source
        return isinstance(frame, pl.LazyFrame)

    def export_data(
        self,
        frame: Any,
        path: str | os.PathLike[str],
        options: ExportOptions,
    ) -> None:
        import polars as pl

        normalized = self.validate_export_options(options)
        format_name = normalized["format"]
        row_id = self._row_id_column(frame)
        if row_id is not None:
            frame = frame.drop(row_id)
        if isinstance(frame, pl.LazyFrame):
            if isinstance(path, ExportWriterPath):
                with path.open_binary_writer() as writer:
                    if format_name == "csv":
                        frame.sink_csv(
                            writer,
                            separator=normalized["delimiter"],
                            quote_char=normalized["quoteChar"],
                            include_header=normalized["header"],
                        )
                        return
                    if format_name == "parquet":
                        frame.sink_parquet(writer)
                        return
            else:
                destination = os.fspath(path)
                if format_name == "csv":
                    frame.sink_csv(
                        destination,
                        separator=normalized["delimiter"],
                        quote_char=normalized["quoteChar"],
                        include_header=normalized["header"],
                    )
                    return
                if format_name == "parquet":
                    frame.sink_parquet(destination)
                    return
        else:
            df = self.normalize(frame)
            if format_name == "csv":
                df.write_csv(
                    path,
                    separator=normalized["delimiter"],
                    quote_char=normalized["quoteChar"],
                    include_header=normalized["header"],
                )
                return
            if format_name == "parquet":
                df.write_parquet(path)
                return
        raise EngineError(f"Unsupported Polars export format: {format_name}")

    def validate_export_options(self, options: ExportOptions) -> dict[str, Any]:
        normalized = super().validate_export_options(options)
        if normalized["format"] == "csv":
            encoding = normalized["encoding"].lower().replace("_", "-")
            if encoding not in {"utf-8", "utf8"}:
                raise EngineError("Polars CSV export supports UTF-8 encoding only.")
            for field in ("delimiter", "quoteChar"):
                if len(normalized[field].encode("utf-8")) != 1:
                    raise EngineError(f"Polars CSV export {field} must encode as exactly one UTF-8 byte.")
        return normalized

    def shape(self, frame: Any) -> SessionDataShape:
        import polars as pl

        if isinstance(frame, pl.LazyFrame):
            return {
                "rows": int(frame.select(pl.len()).collect(engine="streaming").item()),
                "columns": len(self._visible_columns(frame)),
            }
        df = self.normalize(frame)
        rows, _ = df.shape
        return {"rows": int(rows), "columns": len(self._visible_columns(df))}

    def ensure_row_ids(self, frame: Any, token: str) -> Any:
        if self._row_id_column(frame) is not None:
            return frame
        return frame.with_row_index(f"{INTERNAL_ROW_ID_PREFIX}{token}")

    def schema(self, frame: Any) -> list[dict[str, Any]]:
        import polars as pl

        if isinstance(frame, pl.LazyFrame):
            schema = frame.collect_schema()
            visible = self._visible_columns(frame)
            return [
                {
                    "id": f"c:{position}",
                    "name": name,
                    "position": position,
                    "rawType": str(dtype),
                    "type": infer_semantic_type(str(dtype)),
                    # A LazyFrame schema has no nullability metadata. Keep
                    # discovery metadata-only and report the conservative
                    # capability instead of profiling every column on open.
                    "nullable": True,
                }
                for position, name in enumerate(visible)
                for dtype in [schema[name]]
            ]
        df = self.normalize(frame)
        visible = self._visible_columns(df)
        if not visible:
            return []
        null_counts = df.select(visible).null_count().to_dicts()[0] if df.height else {column: 0 for column in visible}
        return [
            {
                "id": f"c:{position}",
                "name": name,
                "position": position,
                "rawType": str(dtype),
                "type": infer_semantic_type(str(dtype)),
                "nullable": bool(null_counts.get(name, 0) > 0),
            }
            for position, name in enumerate(visible)
            for dtype in [df.schema[name]]
        ]

    def apply_filter_model(self, frame: Any, model: Mapping[str, Any]) -> Any:
        import polars as pl

        df = frame
        schema = df.collect_schema() if isinstance(df, pl.LazyFrame) else df.schema
        columns = schema.names() if isinstance(df, pl.LazyFrame) else df.columns
        column_expressions = []
        for column_filter in model.get("filters", []):
            column = column_filter.get("column")
            if column not in columns:
                continue

            raw_type = str(schema[column])
            column_type = infer_semantic_type(raw_type)
            declared_type = column_filter.get("type")
            if declared_type != column_type:
                raise EngineError(
                    f"Polars view filter for {column!r} declares {declared_type!r}, "
                    f"but the dataframe column is {column_type!r}."
                )

            conditions = []
            value_filter = column_filter.get("valueFilter")
            if value_filter and (
                value_filter.get("selectedValues") or value_filter.get("includeNulls") or value_filter.get("includeNaN")
            ):
                selected = [
                    coerce_typed_view_value(value, column_type) for value in value_filter.get("selectedValues", [])
                ]
                selected_series = pl.Series(selected).cast(schema[column], strict=True).implode() if selected else None
                current = pl.col(column).is_in(selected_series) if selected_series is not None else pl.lit(False)
                if value_filter.get("includeNulls"):
                    current = current | pl.col(column).is_null()
                if value_filter.get("includeNaN") and column_type == "float":
                    current = current | pl.col(column).is_nan()
                conditions.append(current)

            for predicate in column_filter.get("predicates", []):
                conditions.append(self._predicate_expr(column, predicate, column_type, schema[column]))

            if conditions:
                column_expression = conditions[0]
                for condition in conditions[1:]:
                    column_expression = (
                        column_expression | condition
                        if column_filter.get("logic") == "or"
                        else column_expression & condition
                    )
                column_expressions.append(column_expression)

        if column_expressions:
            combined = column_expressions[0]
            for expression in column_expressions[1:]:
                combined = combined | expression if model.get("logic") == "or" else combined & expression
            df = df.filter(combined)

        sort_rules = [rule for rule in model.get("sort", []) if rule.get("column") in columns]
        if sort_rules:
            for rule in sort_rules:
                column_type = infer_semantic_type(str(schema[rule["column"]]))
                if column_type not in VIEW_COMPARABLE_TYPES:
                    raise EngineError(f"Polars view sorting is unavailable for {column_type} columns.")
            df = df.sort(
                [rule["column"] for rule in sort_rules],
                descending=[rule.get("direction", "asc") == "desc" for rule in sort_rules],
                nulls_last=[rule.get("nulls", "last") == "last" for rule in sort_rules],
                maintain_order=True,
            )
        return df

    def page(
        self,
        frame: Any,
        offset: int,
        limit: int,
        *,
        total_rows: int | None = None,
        column_projection: PageColumnProjection | None = None,
    ) -> dict[str, Any]:
        import polars as pl

        visible = self._visible_columns(frame)
        projection = normalize_page_projection(len(visible), column_projection)
        columns = [visible[position] for position, _identifier in projection]
        column_ids = [identifier for _position, identifier in projection]
        row_id = self._row_id_column(frame)
        selected = [*([row_id] if row_id is not None else []), *columns]
        # A direct engine call may request an empty projection before a private
        # row identity has been attached. Keep one bounded placeholder column
        # in that terminal plan rather than collecting every visible column.
        terminal_columns = selected or visible[:1]
        if isinstance(frame, pl.LazyFrame):
            if total_rows is None:
                total_rows = int(frame.select(pl.len()).collect(engine="streaming").item())
            # Projection must enter the lazy plan before its terminal slice and
            # collect so scan adapters can prune every unneeded output column.
            sliced = (
                frame.select(terminal_columns).slice(offset, limit).collect(engine="streaming")
                if terminal_columns
                else frame.slice(offset, limit).collect(engine="streaming")
            )
        else:
            df = self.normalize(frame)
            sliced = df.select(terminal_columns).slice(offset, limit) if terminal_columns else df.slice(offset, limit)
            if total_rows is None:
                total_rows = int(df.height)
        rows = []
        for row_number, row in enumerate(sliced.iter_rows(named=True), start=offset):
            rows.append(
                {
                    "id": f"r:{row_id}:{row.get(row_id)}" if row_id is not None else f"r:{row_number}",
                    "rowNumber": row_number,
                    "values": [normalize_cell(row.get(column)) for column in columns],
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
        import polars as pl

        visible_columns = self._visible_columns(frame)
        projection = normalize_summary_projection(len(visible_columns), column_projection)
        selected = [(visible_columns[position], column_id) for position, column_id in projection]
        if isinstance(frame, pl.LazyFrame):
            return self._lazy_summaries(frame, selected)

        df = self.normalize(frame)
        if not selected:
            return []
        null_counts = df.select(
            [
                pl.col(column).null_count().alias(f"__open_wrangler_null_{index}")
                for index, (column, _) in enumerate(selected)
            ]
        ).to_dicts()[0]
        summaries = []
        for index, (column, column_id) in enumerate(selected):
            series = df[column]
            raw_type = str(series.dtype)
            semantic_type = infer_semantic_type(raw_type)
            top_values, distinct_count, boolean_counts = self._summary_counts(series, column, semantic_type)
            summary: dict[str, Any] = {
                "columnId": column_id,
                "column": column,
                "type": semantic_type,
                "rawType": raw_type,
                "totalCount": int(df.height),
                "nullCount": int(null_counts.get(f"__open_wrangler_null_{index}", 0)),
                "nanCount": self._nan_count(series),
                "distinctCount": distinct_count,
                "topValues": top_values,
            }
            if semantic_type in {"integer", "float", "decimal"}:
                numeric_series = series.drop_nulls()
                if semantic_type == "float":
                    numeric_series = numeric_series.drop_nans()
                minimum = numeric_series.min()
                maximum = numeric_series.max()
                numeric_sum = (
                    numeric_series.to_frame()
                    .select(
                        _polars_profile_sum_expression(pl.col(column), numeric_series.dtype, semantic_type).alias(
                            "__open_wrangler_sum"
                        )
                    )
                    .item()
                )
                numeric_summary: dict[str, Any] = {
                    "min": _maybe_float(minimum),
                    "max": _maybe_float(maximum),
                    "mean": _maybe_float(numeric_series.mean()),
                    "median": _maybe_float(numeric_series.median()),
                    "std": _maybe_float(numeric_series.std()),
                }
                numeric_summary.update(normalized_numeric_sum(numeric_sum, semantic_type))
                if semantic_type in {"integer", "decimal"} and numeric_series.len() > 0:
                    numeric_summary["exactMin"] = normalize_cell(minimum)
                    numeric_summary["exactMax"] = normalize_cell(maximum)
                summary["numeric"] = {key: value for key, value in numeric_summary.items() if value is not None}
                summary["visualization"] = _polars_numeric_visualization(numeric_series)
            elif semantic_type == "boolean":
                if boolean_counts is None:  # pragma: no cover - guarded by the semantic type
                    raise EngineError(f"The boolean profile distribution for {column} is missing.")
                summary["visualization"] = boolean_counts
            elif semantic_type in {"datetime", "date"}:
                summary["visualization"] = datetime_visualization(series.min(), series.max())
            else:
                if semantic_type == "string":
                    summary["text"] = _polars_text_summary(series)
                summary["visualization"] = categorical_visualization(
                    summary["topValues"],
                    int(df.height) - int(null_counts.get(f"__open_wrangler_null_{index}", 0)) - summary["nanCount"],
                )
            summaries.append(summary)
        return summaries

    def _lazy_summaries(self, frame: Any, selected: list[tuple[str, str]]) -> list[dict[str, Any]]:
        import polars as pl

        if not selected:
            return []

        schema = frame.collect_schema()
        definitions = []
        metric_expressions = [pl.len().alias("__open_wrangler_total")]
        top_queries = []
        for index, (column, column_id) in enumerate(selected):
            raw_type = str(schema[column])
            semantic_type = infer_semantic_type(raw_type)
            prefix = f"__open_wrangler_{index}_"
            expression = pl.col(column)
            valid_expression = expression.drop_nulls()
            if semantic_type == "float":
                valid_expression = valid_expression.drop_nans()
            metric_expressions.extend(
                [
                    expression.null_count().alias(f"{prefix}null"),
                    (expression.is_nan().fill_null(False).sum() if semantic_type == "float" else pl.lit(0)).alias(
                        f"{prefix}nan"
                    ),
                ]
            )
            if semantic_type in {"integer", "float", "decimal"}:
                finite_expression = (
                    expression.filter(expression.is_finite()) if semantic_type == "float" else expression.drop_nulls()
                )
                metric_expressions.extend(
                    [
                        valid_expression.min().alias(f"{prefix}min"),
                        valid_expression.max().alias(f"{prefix}max"),
                        valid_expression.mean().alias(f"{prefix}mean"),
                        valid_expression.median().alias(f"{prefix}median"),
                        valid_expression.std().alias(f"{prefix}std"),
                        _polars_profile_sum_expression(valid_expression, schema[column], semantic_type).alias(
                            f"{prefix}sum"
                        ),
                        finite_expression.min().alias(f"{prefix}hist_min"),
                        finite_expression.max().alias(f"{prefix}hist_max"),
                        finite_expression.len().alias(f"{prefix}hist_count"),
                        finite_expression.cast(pl.Float64).n_unique().alias(f"{prefix}hist_distinct"),
                    ]
                )
            elif semantic_type == "boolean":
                metric_expressions.extend(
                    [
                        (expression == pl.lit(True)).fill_null(False).sum().alias(f"{prefix}true"),
                        (expression == pl.lit(False)).fill_null(False).sum().alias(f"{prefix}false"),
                    ]
                )
            elif semantic_type in {"datetime", "date"}:
                metric_expressions.extend(
                    [
                        expression.min().alias(f"{prefix}min"),
                        expression.max().alias(f"{prefix}max"),
                    ]
                )
            elif semantic_type == "string":
                text_lengths = expression.cast(pl.String, strict=False).str.len_chars()
                metric_expressions.extend(
                    [
                        (text_lengths == 0).fill_null(False).sum().alias(f"{prefix}text_empty"),
                        text_lengths.min().alias(f"{prefix}text_min"),
                        text_lengths.max().alias(f"{prefix}text_max"),
                        text_lengths.mean().alias(f"{prefix}text_mean"),
                    ]
                )

            count_name = f"__open_wrangler_count_{index}"
            top_queries.append(
                frame.select(
                    [
                        valid_expression.n_unique().alias("distinct"),
                        valid_expression.value_counts(sort=True, name=count_name).head(10).implode().alias("top"),
                    ]
                )
            )
            definitions.append((column, column_id, raw_type, semantic_type, prefix, count_name))

        metrics = frame.select(metric_expressions).collect(engine="streaming").row(0, named=True)
        top_results = self._collect_lazy_top_results(definitions, top_queries)
        total_count = int(metrics["__open_wrangler_total"])

        numeric_histogram_queries = []
        numeric_histogram_columns = []
        numeric_histograms: dict[str, dict[str, Any]] = {}
        for column, _, _, semantic_type, prefix, _ in definitions:
            if semantic_type not in {"integer", "float", "decimal"}:
                continue
            finite_count = int(metrics[f"{prefix}hist_count"])
            bin_count = numeric_histogram_bin_count(
                finite_count,
                int(metrics[f"{prefix}hist_distinct"]),
            )
            minimum = _maybe_float(metrics[f"{prefix}hist_min"])
            maximum = _maybe_float(metrics[f"{prefix}hist_max"])
            edges = numeric_histogram_edges(minimum, maximum, bin_count)
            if not edges:
                numeric_histograms[column] = {"kind": "numeric", "bins": []}
                continue
            if minimum == maximum:
                numeric_histograms[column] = numeric_visualization_from_bin_counts(
                    minimum,
                    maximum,
                    [finite_count],
                )
                continue

            numeric_value = pl.col(column).cast(pl.Float64, strict=False)
            finite = (
                pl.col(column).is_finite().fill_null(False)
                if semantic_type == "float"
                else pl.col(column).is_not_null()
            )
            count_expressions = []
            for bin_index in range(bin_count):
                if bin_index == 0:
                    interval = numeric_value < pl.lit(edges[1])
                elif bin_index == bin_count - 1:
                    interval = numeric_value >= pl.lit(edges[bin_index])
                else:
                    interval = (numeric_value >= pl.lit(edges[bin_index])) & (
                        numeric_value < pl.lit(edges[bin_index + 1])
                    )
                count_expressions.append(
                    (finite & interval.fill_null(False)).sum().alias(f"__open_wrangler_hist_{bin_index}")
                )
            numeric_histogram_queries.append(frame.select(count_expressions))
            numeric_histogram_columns.append((column, minimum, maximum))

        numeric_histogram_results = (
            pl.collect_all(numeric_histogram_queries, engine="streaming") if numeric_histogram_queries else []
        )
        for (column, minimum, maximum), histogram in zip(
            numeric_histogram_columns,
            numeric_histogram_results,
            strict=True,
        ):
            numeric_histograms[column] = numeric_visualization_from_bin_counts(
                minimum,
                maximum,
                histogram.row(0),
            )

        summaries = []
        for index, (column, column_id, raw_type, semantic_type, prefix, _) in enumerate(definitions):
            top_values, distinct_count = top_results[index]
            null_count = int(metrics[f"{prefix}null"])
            nan_count = int(metrics[f"{prefix}nan"])
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
            if semantic_type in {"integer", "float", "decimal"}:
                numeric_summary: dict[str, Any] = {
                    "min": _maybe_float(metrics[f"{prefix}min"]),
                    "max": _maybe_float(metrics[f"{prefix}max"]),
                    "mean": _maybe_float(metrics[f"{prefix}mean"]),
                    "median": _maybe_float(metrics[f"{prefix}median"]),
                    "std": _maybe_float(metrics[f"{prefix}std"]),
                }
                numeric_summary.update(normalized_numeric_sum(metrics[f"{prefix}sum"], semantic_type))
                if semantic_type in {"integer", "decimal"} and metrics[f"{prefix}min"] is not None:
                    numeric_summary["exactMin"] = normalize_cell(metrics[f"{prefix}min"])
                    numeric_summary["exactMax"] = normalize_cell(metrics[f"{prefix}max"])
                summary["numeric"] = {key: value for key, value in numeric_summary.items() if value is not None}
                visualization = numeric_histograms.get(column)
                if visualization is None:  # pragma: no cover - guarded by numeric histogram construction
                    raise EngineError(f"The numeric profile distribution for {column} is missing.")
                summary["visualization"] = visualization
            elif semantic_type == "boolean":
                summary["visualization"] = {
                    "kind": "boolean",
                    "trueCount": int(metrics[f"{prefix}true"]),
                    "falseCount": int(metrics[f"{prefix}false"]),
                }
            elif semantic_type in {"datetime", "date"}:
                summary["visualization"] = datetime_visualization(metrics[f"{prefix}min"], metrics[f"{prefix}max"])
            else:
                if semantic_type == "string":
                    text_summary: dict[str, int | float] = {
                        "emptyCount": int(metrics[f"{prefix}text_empty"]),
                    }
                    minimum = metrics[f"{prefix}text_min"]
                    maximum = metrics[f"{prefix}text_max"]
                    mean = metrics[f"{prefix}text_mean"]
                    if minimum is not None and maximum is not None and mean is not None:
                        text_summary.update(
                            {
                                "minLength": int(minimum),
                                "maxLength": int(maximum),
                                "meanLength": float(mean),
                            }
                        )
                    summary["text"] = text_summary
                summary["visualization"] = categorical_visualization(top_values, total_count - null_count - nan_count)
            summaries.append(summary)
        return summaries

    def _collect_lazy_top_results(
        self,
        definitions: list[tuple[str, str, str, str, str, str]],
        queries: list[Any],
    ) -> list[tuple[list[dict[str, Any]], int]]:
        import polars as pl

        try:
            results = pl.collect_all(queries, engine="streaming")
        except Exception:
            results = []
            for definition, query in zip(definitions, queries, strict=True):
                try:
                    results.append(query.collect(engine="streaming"))
                except Exception as error:
                    raise EngineError(
                        f"Polars could not compute exact summary counts for {definition[0]}: {error}"
                    ) from error

        collected = []
        for definition, result in zip(definitions, results, strict=True):
            column, _, _, semantic_type, _, count_name = definition
            row = result.row(0, named=True)
            top_values = [
                {
                    "value": (
                        normalize_cell(item[column])["display"]
                        if semantic_type in {"list", "struct"}
                        else str(item[column])
                    ),
                    "count": int(item[count_name]),
                }
                for item in row["top"]
                if item[column] is not None
            ]
            collected.append((top_values, int(row["distinct"])))
        return collected

    def _summary_counts(
        self,
        series: Any,
        column: str,
        semantic_type: str,
    ) -> tuple[list[dict[str, Any]], int, dict[str, Any] | None]:
        valid = series.drop_nulls()
        if semantic_type == "float":
            valid = valid.drop_nans()

        try:
            counts = valid.value_counts(sort=True)
            rows = list(counts.head(10).iter_rows(named=True))
            top_values = [
                {
                    "value": (
                        normalize_cell(row[column])["display"]
                        if semantic_type in {"list", "struct"}
                        else str(row[column])
                    ),
                    "count": int(row["count"]),
                }
                for row in rows
                if row[column] is not None
            ]
            boolean_counts = None
            if semantic_type == "boolean":
                boolean_counts = {
                    "kind": "boolean",
                    "trueCount": sum(int(row["count"]) for row in rows if row[column] is True),
                    "falseCount": sum(int(row["count"]) for row in rows if row[column] is False),
                }
            return top_values, counts.height, boolean_counts
        except Exception as error:
            raise EngineError(f"Polars could not compute exact summary counts for {column}: {error}") from error

    def missing_count(self, frame: Any, column_position: int) -> int:
        import polars as pl

        columns = self._visible_columns(frame)
        if (
            not isinstance(column_position, int)
            or isinstance(column_position, bool)
            or column_position < 0
            or column_position >= len(columns)
        ):
            raise EngineError("The selected column is unavailable for missing-value counting.")
        column = columns[column_position]
        schema = frame.collect_schema() if isinstance(frame, pl.LazyFrame) else frame.schema
        missing = pl.col(column).is_null()
        if infer_semantic_type(str(schema[column])) == "float":
            missing = missing | pl.col(column).is_nan()
        query = frame.select(missing.sum().alias("__open_wrangler_missing_count"))
        result = query.collect(engine="streaming") if isinstance(query, pl.LazyFrame) else query
        return int(result.item(0, 0) or 0)

    def header_stats(self, frame: Any) -> dict[str, Any]:
        import polars as pl

        if isinstance(frame, pl.LazyFrame):
            return self._lazy_header_stats(frame)

        df = self.normalize(frame)
        row_id = self._row_id_column(df)
        if row_id is not None:
            df = df.drop(row_id)
        if df.width == 0:
            return {"missingCells": 0, "missingRows": 0, "duplicateRows": 0, "missingValuesByColumn": []}

        missing_by_column = []
        missing_row_expression = None
        missing_cells = 0
        for column in df.columns:
            series = df[column]
            null_count = int(series.null_count())
            nan_count = self._nan_count(series)
            count = null_count + nan_count
            missing_cells += count
            missing_by_column.append({"column": column, "count": count})
            current = pl.col(column).is_null()
            if infer_semantic_type(str(series.dtype)) == "float":
                current = current | pl.col(column).is_nan()
            missing_row_expression = current if missing_row_expression is None else missing_row_expression | current

        missing_rows = (
            int(df.select(missing_row_expression.sum().alias("missingRows")).item())
            if missing_row_expression is not None and df.height
            else 0
        )
        return {
            "missingCells": missing_cells,
            "missingRows": missing_rows,
            "duplicateRows": int(df.height - df.unique(maintain_order=False).height) if df.height else 0,
            "missingValuesByColumn": missing_by_column,
        }

    def _lazy_header_stats(self, frame: Any) -> dict[str, Any]:
        import polars as pl

        visible = self._visible_columns(frame)
        if not visible:
            return {"missingCells": 0, "missingRows": 0, "duplicateRows": 0, "missingValuesByColumn": []}

        schema = frame.collect_schema()
        missing_expressions = []
        missing_row_expressions = []
        aliases: list[tuple[str, str]] = []
        for index, column in enumerate(visible):
            alias = f"__open_wrangler_missing_{index}"
            expression = pl.col(column).is_null()
            count = pl.col(column).null_count()
            if infer_semantic_type(str(schema[column])) == "float":
                expression = expression | pl.col(column).is_nan().fill_null(False)
                count = count + pl.col(column).is_nan().fill_null(False).sum()
            missing_expressions.append(count.alias(alias))
            missing_row_expressions.append(expression.fill_null(False))
            aliases.append((column, alias))

        metrics_query = frame.select(
            [
                pl.len().alias("__open_wrangler_rows"),
                pl.any_horizontal(missing_row_expressions).sum().alias("__open_wrangler_missing_rows"),
                *missing_expressions,
            ]
        )
        unique_query = (
            frame.select(visible).unique(maintain_order=False).select(pl.len().alias("__open_wrangler_unique_rows"))
        )
        metrics_frame, unique_frame = pl.collect_all([metrics_query, unique_query], engine="streaming")
        metrics = metrics_frame.row(0, named=True)
        total_rows = int(metrics["__open_wrangler_rows"])
        missing_by_column = [{"column": column, "count": int(metrics[alias])} for column, alias in aliases]
        return {
            "missingCells": sum(item["count"] for item in missing_by_column),
            "missingRows": int(metrics["__open_wrangler_missing_rows"]),
            "duplicateRows": total_rows - int(unique_frame.item()),
            "missingValuesByColumn": missing_by_column,
        }

    def column_values(
        self, frame: Any, column: str, search: str | None = None, limit: int = 100
    ) -> tuple[list[dict[str, Any]], bool]:
        import polars as pl

        if isinstance(frame, pl.LazyFrame):
            schema = frame.collect_schema()
            if column not in schema:
                raise EngineError(f"Unknown Polars column: {column}")
            column_type = infer_semantic_type(str(schema[column]))
            expression = pl.col(column).drop_nulls()
            if column_type == "float":
                expression = expression.drop_nans()
            series_df = frame.select(expression)
        else:
            df = self.normalize(frame)
            if column not in df.schema:
                raise EngineError(f"Unknown Polars column: {column}")
            column_type = infer_semantic_type(str(df.schema[column]))
            expression = pl.col(column).drop_nulls()
            if column_type == "float":
                expression = expression.drop_nans()
            series_df = df.select(expression)
        if search:
            series_df = series_df.filter(
                pl.col(column)
                .cast(pl.Utf8)
                .str.replace_many(_ASCII_LOWER_REPLACEMENTS)
                .str.contains(str(search).translate(_ASCII_TO_LOWER), literal=True)
            )
        counts = (
            series_df.group_by(column)
            .len(name="count")
            .sort([pl.col("count"), pl.col(column).cast(pl.String)], descending=[True, False])
            .head(limit + 1)
        )
        if isinstance(counts, pl.LazyFrame):
            counts = counts.collect(engine="streaming")
        values = []
        for row in counts.head(limit).iter_rows(named=True):
            item: dict[str, Any] = {"value": str(row[column]), "count": int(row["count"])}
            selection = typed_selection_value(row[column], column_type)
            if selection is not None:
                item["selectionValue"] = selection
            values.append(item)
        return values, counts.height > limit

    def _predicate_expr(
        self,
        column: str,
        predicate: Mapping[str, Any],
        column_type: str | None = None,
        raw_type: Any | None = None,
    ) -> Any:
        import polars as pl

        operator = validate_view_predicate_operator(column_type, predicate.get("operator"))
        value = (
            coerce_typed_view_value(predicate.get("value"), column_type)
            if operator not in {"contains", "startsWith", "endsWith", "isNull", "isNotNull", "isNaN", "isNotNaN"}
            else predicate.get("value")
        )
        expr = pl.col(column)
        typed_value = pl.lit(value).cast(raw_type) if raw_type is not None else pl.lit(value)
        if operator == "isNull":
            return expr.is_null()
        if operator == "isNotNull":
            return expr.is_not_null()
        if operator == "isNaN":
            return expr.is_nan().fill_null(False) if column_type == "float" else pl.lit(False)
        if operator == "isNotNaN":
            return expr.is_not_nan().fill_null(True) if column_type == "float" else pl.lit(True)
        if operator == "equals":
            result = expr == typed_value
        elif operator == "notEquals":
            result = expr != typed_value
        elif operator == "contains":
            result = (
                expr.cast(pl.Utf8)
                .str.replace_many(_ASCII_LOWER_REPLACEMENTS)
                .str.contains(str(value).translate(_ASCII_TO_LOWER), literal=True)
            )
        elif operator == "startsWith":
            result = expr.cast(pl.Utf8).str.starts_with(str(value))
        elif operator == "endsWith":
            result = expr.cast(pl.Utf8).str.ends_with(str(value))
        elif operator == "gt":
            result = expr > typed_value
        elif operator == "gte":
            result = expr >= typed_value
        elif operator == "lt":
            result = expr < typed_value
        elif operator == "lte":
            result = expr <= typed_value
        else:
            second_value = coerce_typed_view_value(predicate.get("secondValue"), column_type)
            typed_second = pl.lit(second_value).cast(raw_type) if raw_type is not None else pl.lit(second_value)
            result = (expr >= typed_value) & (expr <= typed_second)
        valid = expr.is_not_null()
        if column_type == "float":
            valid = valid & expr.is_not_nan().fill_null(False)
        return result.fill_null(False) & valid

    def _nan_count(self, series: Any) -> int:
        try:
            return int(series.is_nan().sum())
        except Exception:
            return 0

    def apply_transform(self, frame: Any, step: Mapping[str, Any]) -> Any:
        import polars as pl

        df = frame
        kind = str(step["kind"])
        params = step["params"]
        if kind == "sortRows":
            rules = [{**rule, "column": bound_column_name(rule["column"], kind)} for rule in params["rules"]]
            return self.apply_filter_model(df, {"filters": [], "sort": rules})
        if kind == "filterRows":
            return self.apply_filter_model(df, _bound_polars_filter_model(params["filterModel"]))
        if kind == "dropMissingRows":
            schema = df.collect_schema() if isinstance(df, pl.LazyFrame) else df.schema
            columns = (
                [bound_column_name(column, kind) for column in params["columns"]]
                if params.get("columns")
                else self._visible_columns(df)
            )
            if not columns:
                return df
            valid = [_polars_valid_value(pl.col(column), schema[column]) for column in columns]
            expression = pl.any_horizontal(valid) if params.get("how", "any") == "all" else pl.all_horizontal(valid)
            return df.filter(expression)
        if kind == "fillMissingValues":
            column = bound_column_name(params["column"], kind)
            replacement = params["replacement"]
            if replacement.get("kind") == "fallbackColumns":
                return _polars_fill_missing_from_columns(
                    df,
                    column,
                    [bound_column_name(fallback, kind) for fallback in replacement["columns"]],
                )
            if replacement.get("kind") == "directional":
                order_rules = [
                    {
                        **rule,
                        "column": bound_column_name(rule["column"], kind),
                    }
                    for rule in replacement["orderBy"]
                ]
                return _polars_fill_missing_directional(
                    df,
                    column,
                    order_rules,
                    replacement["direction"],
                    replacement.get("maxGap"),
                )
            if replacement.get("kind") == "groupedStatistic":
                return _polars_fill_missing_grouped_statistic(
                    df,
                    column,
                    [bound_column_name(key, kind) for key in replacement["keys"]],
                    replacement["statistic"],
                )
            if replacement.get("kind") == "linearInterpolation":
                return _polars_fill_missing_linear_interpolation(
                    df,
                    column,
                    bound_column_name(replacement["coordinate"], kind),
                    replacement.get("maxGap"),
                )
            schema = df.collect_schema() if isinstance(df, pl.LazyFrame) else df.schema
            dtype = schema[column]
            expression = pl.col(column)
            if dtype.is_float():
                expression = expression.fill_nan(None)
            if replacement.get("kind") == "mean":
                if not dtype.is_float():
                    raise EngineError("Mean fill requires a floating-point column.")
                if not _polars_has_missing(df, expression):
                    return df
                fill_value = _polars_stable_float_mean(df, expression)
                literal = pl.lit(fill_value).cast(dtype, strict=True)
                return df.with_columns(expression.fill_null(literal).alias(column))
            if replacement.get("kind") == "mostFrequent":
                if not _polars_has_missing(df, expression):
                    return df
                fill_value = _polars_most_frequent_value(df, column, expression)
                literal = pl.lit(fill_value).cast(dtype, strict=True)
                return df.with_columns(expression.fill_null(literal).alias(column))
            if replacement.get("kind") == "median":
                semantic_type = infer_semantic_type(str(dtype))
                if semantic_type == "float":
                    aggregate = df.select(expression.median().alias("__ow_fill_median"))
                    median_frame = (
                        aggregate.collect(engine="streaming") if isinstance(aggregate, pl.LazyFrame) else aggregate
                    )
                    median = median_frame.item()
                    if median is None or (isinstance(median, float) and median != median):
                        raise EngineError(
                            "Cannot fill with the median because the selected column has no present numeric values."
                        )
                else:
                    lower, upper = _polars_middle_values(df, expression)
                    if semantic_type == "integer":
                        median = exact_integer_median(lower, upper)
                    elif semantic_type == "decimal":
                        precision = int(getattr(dtype, "precision", None) or 38)
                        scale = int(getattr(dtype, "scale", None) or 0)
                        median = exact_decimal_median(lower, upper, precision, scale)
                    else:
                        raise EngineError(f"Cannot calculate a numeric median for Polars type {dtype}.")
                literal = pl.lit(median).cast(dtype, strict=True)
                return df.with_columns(expression.fill_null(literal).alias(column))
            fill_value = decode_fill_replacement(replacement)
            if dtype.base_type() == pl.Decimal:
                fill_value = decimal_at_scale(
                    Decimal(fill_value),
                    int(getattr(dtype, "precision", None) or 38),
                    int(getattr(dtype, "scale", None) or 0),
                )
            elif dtype.base_type() == pl.Datetime:
                fill_value = require_datetime_fill_awareness(fill_value, getattr(dtype, "time_zone", None) is not None)
            promotes_string = infer_semantic_type(str(dtype)) == "string" and str(dtype).lower() not in {
                "string",
                "utf8",
            }
            if promotes_string:
                if not _polars_has_missing(df, expression):
                    return df
                expression = expression.cast(pl.String)
                literal = pl.lit(fill_value).cast(pl.String)
            else:
                literal = pl.lit(fill_value) if dtype == pl.Null else pl.lit(fill_value).cast(dtype, strict=True)
            return df.with_columns(expression.fill_null(literal).alias(column))
        if kind == "dropDuplicates":
            columns = (
                [bound_column_name(column, kind) for column in params["columns"]]
                if params.get("columns")
                else self._visible_columns(df)
            )
            if not columns:
                return df
            return df.unique(
                subset=columns,
                keep=params.get("keep", "first"),
                maintain_order=True,
            )
        if kind == "selectColumns":
            row_id = self._row_id_column(df)
            columns = [bound_column_name(column, kind) for column in params["columns"]]
            return df.select([*([row_id] if row_id else []), *columns])
        if kind == "dropColumns":
            return df.drop([bound_column_name(column, kind) for column in params["columns"]])
        if kind == "renameColumn":
            return df.rename({bound_column_name(params["column"], kind): params["newName"]})
        if kind == "cloneColumn":
            return df.with_columns(pl.col(bound_column_name(params["column"], kind)).alias(params["newName"]))
        if kind == "castColumn":
            dtype = {
                "string": pl.String,
                "integer": pl.Int64,
                "float": pl.Float64,
                "boolean": pl.Boolean,
                "date": pl.Date,
                "datetime": pl.Datetime,
            }[params["dtype"]]
            return df.with_columns(pl.col(bound_column_name(params["column"], kind)).cast(dtype, strict=False))
        if kind == "formula":
            right = (
                pl.col(bound_column_name(params["rightColumn"], kind))
                if params.get("rightColumn")
                else pl.lit(params["value"])
            )
            expression = _polars_formula(
                pl.col(bound_column_name(params["leftColumn"], kind)), right, params["operator"]
            )
            return df.with_columns(expression.alias(params["newColumn"]))
        if kind == "textLength":
            column = bound_column_name(params["column"], kind)
            return df.with_columns(pl.col(column).cast(pl.String).str.len_chars().alias(params["newColumn"]))
        if kind == "oneHotEncode":
            # The generated output columns depend on every observed category.
            # Previewing this operation is therefore an explicit user-requested
            # materialization boundary for an otherwise lazy session.
            eager = df.collect(engine="streaming") if isinstance(df, pl.LazyFrame) else df
            columns = [bound_column_name(column, kind) for column in params["columns"]]
            separator = params.get("prefixSeparator", "_")
            generated = [
                (column, value, f"{column}{separator}{value}")
                for column in columns
                for value in sorted(eager.get_column(column).drop_nulls().unique().to_list(), key=str)
                if str(value) and not (isinstance(value, float) and value != value)
            ]
            generated.sort(key=lambda item: item[2])
            base = eager.drop(columns) if params.get("dropOriginal", True) else eager
            ensure_output_columns_available(base.columns, [name for _, _, name in generated], "One-hot encoding")
            if not generated:
                return base
            encoded = eager.select(
                [
                    (pl.col(column) == pl.lit(value)).fill_null(False).cast(pl.Int8).alias(name)
                    for column, value, name in generated
                ]
            )
            return base.hstack(encoded)
        if kind == "multiLabelBinarize":
            # The generated output columns depend on every observed label.
            # Previewing this operation is therefore an explicit user-requested
            # materialization boundary for an otherwise lazy session.
            eager = df.collect(engine="streaming") if isinstance(df, pl.LazyFrame) else df
            column = bound_column_name(params["column"], kind)
            delimiter = params["delimiter"]
            labels = (
                eager.select(
                    pl.col(column)
                    .cast(pl.String)
                    .str.split(delimiter)
                    .explode(empty_as_null=True)
                    .drop_nulls()
                    .unique()
                )
                .get_column(column)
                .to_list()
            )
            expressions = [
                pl.col(column)
                .fill_null("")
                .cast(pl.String)
                .str.split(delimiter)
                .list.contains(label)
                .cast(pl.Int8)
                .alias(f"{params.get('prefix', f'{column}_')}{label}")
                for label in sorted(str(label) for label in labels if str(label))
            ]
            base = eager.drop(column) if params.get("dropOriginal", False) else eager
            generated_names = [
                f"{params.get('prefix', f'{column}_')}{label}"
                for label in sorted(str(label) for label in labels if str(label))
            ]
            ensure_output_columns_available(base.columns, generated_names, "Multi-label binarization")
            if not expressions:
                return base
            return base.hstack(eager.select(expressions))
        if kind == "splitTextColumns":
            column = bound_column_name(params["column"], kind)
            output_names = list(params["newColumns"])
            schema = df.collect_schema() if isinstance(df, pl.LazyFrame) else df.schema
            ensure_output_columns_available(schema.names(), output_names, "Splitting text into columns")
            parts = pl.col(column).cast(pl.String).str.split(params["delimiter"])
            return df.with_columns(
                [parts.list.get(index, null_on_oob=True).alias(name) for index, name in enumerate(output_names)]
            )
        if kind == "extractRegexGroup":
            column = bound_column_name(params["column"], kind)
            schema = df.collect_schema() if isinstance(df, pl.LazyFrame) else df.schema
            ensure_output_columns_available(schema.names(), [params["newColumn"]], "Regex extraction")
            source = pl.col(column).cast(pl.String)
            oversize_query = df.select(
                (
                    (source.str.len_chars() > MAX_PORTABLE_REGEX_TEXT_CODE_POINTS)
                    | (source.str.len_bytes() > MAX_PORTABLE_REGEX_TEXT_UTF8_BYTES)
                )
                .fill_null(False)
                .any()
                .alias("oversized")
            )
            oversized = (
                oversize_query.collect().item() if isinstance(oversize_query, pl.LazyFrame) else oversize_query.item()
            )
            if bool(oversized):
                raise EngineError(PORTABLE_REGEX_TEXT_LIMIT_MESSAGE)
            return df.with_columns(source.str.extract(params["pattern"], params["group"]).alias(params["newColumn"]))
        if kind in {"findReplace", "stripText", "splitText", "capitalizeText", "lowerText", "upperText"}:
            column = bound_column_name(params["column"], kind)
            target = params.get("newColumn", column)
            expression = pl.col(column).cast(pl.String)
            if kind == "findReplace":
                expression = expression.str.replace_all(
                    params["find"], params["replacement"], literal=not params.get("regex", False)
                )
            elif kind == "stripText":
                expression = expression.str.strip_chars(params.get("characters") or DEFAULT_STRIP_CHARACTERS)
            elif kind == "splitText":
                expression = expression.str.split(params["delimiter"]).list.get(params["index"], null_on_oob=True)
            elif kind == "capitalizeText":
                expression = expression.str.slice(0, 1).str.to_uppercase() + expression.str.slice(1).str.to_lowercase()
            elif kind == "lowerText":
                expression = expression.str.to_lowercase()
            else:
                expression = expression.str.to_uppercase()
            return df.with_columns(expression.alias(target))
        if kind == "minMaxScale":
            column = bound_column_name(params["column"], kind)
            expression = pl.col(column).cast(pl.Float64, strict=False)
            valid = pl.when(expression.is_finite()).then(expression).otherwise(None)
            scaled = (
                pl.when(valid.is_null())
                .then(None)
                .when(valid.max() == valid.min())
                .then(pl.lit(0.0))
                .otherwise((valid - valid.min()) / (valid.max() - valid.min()))
            )
            return df.with_columns(scaled.alias(params.get("newColumn", column)))
        if kind in {"roundNumber", "floorNumber", "ceilNumber"}:
            column = bound_column_name(params["column"], kind)
            expression = pl.col(column).cast(pl.Float64, strict=False)
            if kind == "roundNumber":
                expression = expression.round(params.get("decimals", 0))
            elif kind == "floorNumber":
                expression = expression.floor()
            else:
                expression = expression.ceil()
            return df.with_columns(expression.alias(params.get("newColumn", column)))
        if kind == "formatDatetime":
            column = bound_column_name(params["column"], kind)
            schema = df.collect_schema() if isinstance(df, pl.LazyFrame) else df.schema
            expression = pl.col(column)
            if schema[column].base_type() not in {pl.Datetime, pl.Date}:
                expression = expression.cast(pl.String).str.to_datetime(strict=False)
            return df.with_columns(expression.dt.strftime(params["format"]).alias(params.get("newColumn", column)))
        if kind == "groupBy":
            schema = df.collect_schema() if isinstance(df, pl.LazyFrame) else df.schema
            keys = [bound_column_name(reference, kind) for reference in params["keys"]]
            normalized = df.with_columns(
                [pl.col(key).fill_nan(None).alias(key) if schema[key].is_float() else pl.col(key) for key in keys]
            )
            expressions = [
                _polars_aggregation(aggregation, schema[bound_column_name(aggregation["column"], kind)])
                for aggregation in params["aggregations"]
            ]
            return normalized.group_by(keys, maintain_order=True).agg(expressions)
        if kind == "byExample":
            schema = df.collect_schema() if isinstance(df, pl.LazyFrame) else df.schema
            scalar_checked_integers = _polars_program_uses_uint128(params["program"], schema)
            return df.with_columns(
                _polars_by_example_expression(
                    params["program"],
                    scalar_checked_integers=scalar_checked_integers,
                ).alias(params["newColumn"])
            )
        if kind == "customCode":
            row_id = self._row_id_column(df)
            namespace = {"df": df.drop(row_id) if row_id is not None else df, "pl": pl}
            with capture_custom_code_output() as output:
                try:
                    exec(params["code"], namespace, namespace)
                except Exception as error:
                    raise EngineError(custom_code_error_message("Polars", error, output)) from error
                result = namespace.get("result")
                if not self.detect(result):
                    raise EngineError(
                        append_custom_code_output(
                            "Custom Polars code must assign a Polars DataFrame, LazyFrame, or Series to result.", output
                        )
                    )
                return result.to_frame() if isinstance(result, pl.Series) else result
        raise EngineError(f"Polars does not implement transformation: {kind}")

    def _row_id_column(self, frame: Any) -> str | None:
        import polars as pl

        columns = frame.collect_schema().names() if isinstance(frame, pl.LazyFrame) else frame.columns
        return next((name for name in columns if name.startswith(INTERNAL_ROW_ID_PREFIX)), None)

    def _visible_columns(self, frame: Any) -> list[str]:
        import polars as pl

        columns = frame.collect_schema().names() if isinstance(frame, pl.LazyFrame) else frame.columns
        return [name for name in columns if not name.startswith(INTERNAL_ROW_ID_PREFIX)]

    def compile_plan(self, steps: Iterable[Mapping[str, Any]]) -> str:
        plan = list(steps)
        needs_filter_helpers = any(step["kind"] == "filterRows" for step in plan)
        needs_fill_helpers = any(step["kind"] == "fillMissingValues" for step in plan)
        needs_counter = any(step["kind"] in {"oneHotEncode", "multiLabelBinarize", "splitTextColumns"} for step in plan)
        lines = ["from collections import Counter"] if needs_counter else []
        if needs_filter_helpers or needs_fill_helpers:
            decimal_import = (
                "from decimal import Decimal, InvalidOperation, localcontext"
                if needs_fill_helpers
                else "from decimal import Decimal"
            )
            lines.extend(["from datetime import date, datetime, timedelta", decimal_import])
        if lines:
            lines.append("")
        lines.extend(["import polars as pl", ""])
        if needs_filter_helpers:
            lines.extend(generated_view_value_helper_lines())
        if needs_fill_helpers:
            lines.extend(_generated_polars_fill_helpers())
            lines.extend(_generated_polars_linear_interpolation_helpers())
        if any(_polars_step_needs_checked_integer_helpers(step) for step in plan):
            lines.extend(
                [
                    "",
                    f"_OW_INTEGER_MAX = {_PORTABLE_INTEGER_MAX}",
                    "_OW_INTEGER_MIN = -_OW_INTEGER_MAX",
                    f"_OW_INTEGER_LIMB_BASE = {_POLARS_INTEGER_LIMB_BASE}",
                    f"_OW_INTEGER_LIMB_COUNT = {_POLARS_INTEGER_LIMB_COUNT}",
                    "",
                    "",
                    "def _ow_checked_integer_sum_parts(parts):",
                    "    total = sum(",
                    "        int(parts[f'_ow_limb_{index}'] or 0) * (_OW_INTEGER_LIMB_BASE ** index)",
                    "        for index in range(_OW_INTEGER_LIMB_COUNT)",
                    "    )",
                    "    if not _OW_INTEGER_MIN <= total <= _OW_INTEGER_MAX:",
                    "        raise ValueError('Open Wrangler integer result exceeds the portable 38-digit envelope.')",
                    "    return total",
                    "",
                    "",
                    "def _ow_checked_integer_sum_result(parts):",
                    "    # Older supported Polars infers a small Python result as Int64.",
                    "    # Return a native Series so the physical callback type remains Int128.",
                    "    return pl.Series([_ow_checked_integer_sum_parts(parts.item())], dtype=pl.Int128)",
                    "",
                    "",
                    "def _ow_checked_integer_sum(expression, dtype):",
                    "    native_type = pl.UInt128 if dtype == pl.UInt128 else pl.Int128",
                    "    remaining = expression if dtype == pl.UInt128 else expression.cast(pl.Int128)",
                    "    base = pl.lit(_OW_INTEGER_LIMB_BASE, dtype=native_type)",
                    "    limbs = []",
                    "    for index in range(_OW_INTEGER_LIMB_COUNT - 1):",
                    "        limbs.append(",
                    "            (remaining % base).cast(pl.Int128).sum().alias(f'_ow_limb_{index}')",
                    "        )",
                    "        remaining = remaining // base",
                    "    limbs.append(",
                    "        remaining.cast(pl.Int128).sum().alias(f'_ow_limb_{_OW_INTEGER_LIMB_COUNT - 1}')",
                    "    )",
                    "    return pl.struct(limbs).map_batches(",
                    "        _ow_checked_integer_sum_result, return_dtype=pl.Int128, returns_scalar=True",
                    "    )",
                    "",
                    "",
                    "def _ow_checked_integer_value(left, right, operator):",
                    "    if left is None or right is None:",
                    "        return None",
                    "    if operator == 'add':",
                    "        result = int(left) + int(right)",
                    "    elif operator == 'subtract':",
                    "        result = int(left) - int(right)",
                    "    elif operator == 'multiply':",
                    "        result = int(left) * int(right)",
                    "    else:",
                    "        raise ValueError('Unsupported checked integer operator: ' + str(operator))",
                    "    if not _OW_INTEGER_MIN <= result <= _OW_INTEGER_MAX:",
                    "        raise ValueError('Open Wrangler integer result exceeds the portable 38-digit envelope.')",
                    "    return result",
                    "",
                    "",
                    "def _ow_checked_integer_formula_scalar(left, right, operator):",
                    "    return pl.struct(",
                    "        left.alias('_ow_left_operand'), right.alias('_ow_right_operand')",
                    "    ).map_elements(",
                    "        lambda operands: _ow_checked_integer_value(",
                    "            operands['_ow_left_operand'], operands['_ow_right_operand'], operator",
                    "        ),",
                    "        return_dtype=pl.Int128,",
                    "        skip_nulls=False,",
                    "    )",
                    "",
                    "",
                    "def _ow_checked_integer_formula(left, right, operator):",
                    "    integer_type = pl.Int128",
                    "    decimal_type = pl.Decimal(38, 0)",
                    "    left = left.cast(integer_type)",
                    "    right = right.cast(integer_type)",
                    "    zero = pl.lit(0, dtype=integer_type)",
                    "    maximum = pl.lit(_OW_INTEGER_MAX, dtype=integer_type)",
                    "    minimum = pl.lit(_OW_INTEGER_MIN, dtype=integer_type)",
                    "    if operator == 'add':",
                    "        positive = pl.when(right > 0).then(right).otherwise(zero)",
                    "        negative = pl.when(right < 0).then(right).otherwise(zero)",
                    "        safe = ((right <= 0) | (left <= maximum - positive)) & (",
                    "            (right >= 0) | (left >= minimum - negative)",
                    "        )",
                    "    elif operator == 'subtract':",
                    "        positive = pl.when(right > 0).then(right).otherwise(zero)",
                    "        negative = pl.when(right < 0).then(right).otherwise(zero)",
                    "        safe = ((right >= 0) | (left <= maximum + negative)) & (",
                    "            (right <= 0) | (left >= minimum + positive)",
                    "        )",
                    "    elif operator == 'multiply':",
                    "        left_in_range = left.is_between(minimum, maximum)",
                    "        right_in_range = right.is_between(minimum, maximum)",
                    "        left_magnitude = left.clip(_OW_INTEGER_MIN, _OW_INTEGER_MAX).abs()",
                    "        right_magnitude = right.clip(_OW_INTEGER_MIN, _OW_INTEGER_MAX).abs()",
                    "        nonzero = right_magnitude != 0",
                    "        divisor = pl.when(nonzero).then(right_magnitude).otherwise(pl.lit(1, dtype=integer_type))",
                    "        safe = (left == 0) | (right == 0) | (",
                    "            left_in_range & right_in_range & (left_magnitude <= maximum // divisor)",
                    "        )",
                    "    else:",
                    "        raise ValueError('Unsupported checked integer operator: ' + str(operator))",
                    "    safe = safe.fill_null(True)",
                    "    checked_left = pl.when(safe).then(left).otherwise(zero)",
                    "    checked_right = pl.when(safe).then(right).otherwise(zero)",
                    "    result = {",
                    "        'add': checked_left + checked_right,",
                    "        'subtract': checked_left - checked_right,",
                    "        'multiply': checked_left * checked_right,",
                    "    }[operator]",
                    "    return (",
                    "        pl.when(safe)",
                    "        .then(result.cast(pl.String))",
                    "        .otherwise(pl.lit(",
                    "            'Open Wrangler integer result exceeds the portable 38-digit envelope.'))",
                    "        .cast(decimal_type, strict=True)",
                    "        .cast(pl.Int128)",
                    "    )",
                ]
            )
        lines.extend(["", "", "def clean_data(df):"])
        for index, step in enumerate(plan):
            lines.extend(self._compile_step(step, index))
        lines.append("    return df")
        return "\n".join(lines) + "\n"

    def _compile_step(self, step: Mapping[str, Any], index: int) -> list[str]:
        kind = str(step["kind"])
        params = step["params"]
        prefix = "    "
        if kind == "sortRows":
            rules = params["rules"]
            columns = [bound_column_name(rule["column"], kind) for rule in rules]
            return [
                f"{prefix}df = df.sort({columns!r},",
                f"{prefix}    descending={[rule.get('direction', 'asc') == 'desc' for rule in rules]!r},",
                f"{prefix}    nulls_last={[rule.get('nulls', 'last') == 'last' for rule in rules]!r},",
                f"{prefix}    maintain_order=True)",
            ]
        if kind == "filterRows":
            return _compile_polars_filter(_bound_polars_filter_model(params["filterModel"]), index)
        if kind == "dropMissingRows":
            columns = (
                [bound_column_name(column, kind) for column in params["columns"]] if params.get("columns") else None
            )
            name = f"_columns_{index}"
            schema = f"_schema_{index}"
            horizontal = "all_horizontal" if params.get("how", "any") == "any" else "any_horizontal"
            return [
                f"{prefix}{schema} = df.collect_schema() if isinstance(df, pl.LazyFrame) else df.schema",
                f"{prefix}{name} = {columns!r} or {schema}.names()",
                f"{prefix}if {name}:",
                (
                    f"{prefix}    _valid_{index} = [pl.col(column).is_not_null() & "
                    f"(~pl.col(column).is_nan() if {schema}[column].is_float() else pl.lit(True)) "
                    f"for column in {name}]"
                ),
                f"{prefix}    df = df.filter(pl.{horizontal}(_valid_{index}))",
            ]
        if kind == "fillMissingValues":
            column = bound_column_name(params["column"], kind)
            replacement = params["replacement"]
            if replacement.get("kind") == "fallbackColumns":
                fallback_columns = [bound_column_name(fallback, kind) for fallback in replacement["columns"]]
                return [(f"{prefix}df = _ow_polars_fill_missing_from_columns(df, {column!r}, {fallback_columns!r})")]
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
                        f"{prefix}df = _ow_polars_fill_missing_directional("
                        f"df, {column!r}, {order_rules!r}, {replacement['direction']!r}, "
                        f"{replacement.get('maxGap')!r})"
                    )
                ]
            if replacement.get("kind") == "groupedStatistic":
                keys = [bound_column_name(key, kind) for key in replacement["keys"]]
                return [
                    (
                        f"{prefix}df = _ow_polars_fill_missing_grouped_statistic("
                        f"df, {column!r}, {keys!r}, {replacement['statistic']!r})"
                    )
                ]
            if replacement.get("kind") == "linearInterpolation":
                coordinate = bound_column_name(replacement["coordinate"], kind)
                return [
                    (
                        f"{prefix}df = _ow_polars_fill_missing_linear_interpolation("
                        f"df, {column!r}, {coordinate!r}, {replacement.get('maxGap')!r})"
                    )
                ]
            schema = f"_fill_schema_{index}"
            expression = f"_fill_expression_{index}"
            lines = [
                f"{prefix}{schema} = df.collect_schema() if isinstance(df, pl.LazyFrame) else df.schema",
                f"{prefix}{expression} = pl.col({column!r})",
                f"{prefix}if {schema}[{column!r}].is_float():",
                f"{prefix}    {expression} = {expression}.fill_nan(None)",
            ]
            if replacement.get("kind") == "mean":
                lines.extend(
                    [
                        f"{prefix}if not {schema}[{column!r}].is_float():",
                        f"{prefix}    raise ValueError('Mean fill requires a floating-point column.')",
                        f"{prefix}if _ow_polars_has_missing(df, {expression}):",
                        f"{prefix}    _fill_value_{index} = _ow_polars_stable_float_mean(df, {expression})",
                        (
                            f"{prefix}    _fill_literal_{index} = "
                            f"pl.lit(_fill_value_{index}).cast({schema}[{column!r}], strict=True)"
                        ),
                        (
                            f"{prefix}    df = df.with_columns({expression}.fill_null(_fill_literal_{index})"
                            f".alias({column!r}))"
                        ),
                    ]
                )
            elif replacement.get("kind") == "mostFrequent":
                lines.extend(
                    [
                        f"{prefix}if _ow_polars_has_missing(df, {expression}):",
                        (f"{prefix}    _fill_value_{index} = _ow_polars_most_frequent(df, {column!r}, {expression})"),
                        (
                            f"{prefix}    _fill_literal_{index} = "
                            f"pl.lit(_fill_value_{index}).cast({schema}[{column!r}], strict=True)"
                        ),
                        (
                            f"{prefix}    df = df.with_columns({expression}.fill_null(_fill_literal_{index})"
                            f".alias({column!r}))"
                        ),
                    ]
                )
            elif replacement.get("kind") == "median":
                aggregate = f"_fill_aggregate_{index}"
                median = f"_fill_median_{index}"
                lower = f"_fill_lower_{index}"
                upper = f"_fill_upper_{index}"
                lines.extend(
                    [
                        f"{prefix}if {schema}[{column!r}].is_float():",
                        f"{prefix}    {aggregate} = df.select({expression}.median().alias('__ow_fill_median'))",
                        (
                            f"{prefix}    {aggregate} = {aggregate}.collect(engine='streaming') "
                            f"if isinstance({aggregate}, pl.LazyFrame) else {aggregate}"
                        ),
                        f"{prefix}    {median} = {aggregate}.item()",
                        f"{prefix}    if {median} is None or (isinstance({median}, float) and {median} != {median}):",
                        (
                            f"{prefix}        raise ValueError("
                            "'Cannot fill with the median because the selected column has no present numeric values.')"
                        ),
                        f"{prefix}else:",
                        f"{prefix}    {lower}, {upper} = _ow_polars_middle_values(df, {expression})",
                        f"{prefix}    if {schema}[{column!r}].is_integer():",
                        f"{prefix}        _fill_total_{index} = int({lower}) + int({upper})",
                        f"{prefix}        if _fill_total_{index} % 2:",
                        (
                            f"{prefix}            raise ValueError("
                            "'The integer median is fractional. Cast the column to float or decimal before "
                            "filling missing values.')"
                        ),
                        f"{prefix}        {median} = _fill_total_{index} // 2",
                        f"{prefix}    elif {schema}[{column!r}].base_type() == pl.Decimal:",
                        f"{prefix}        _fill_precision_{index} = int({schema}[{column!r}].precision or 38)",
                        f"{prefix}        _fill_scale_{index} = int({schema}[{column!r}].scale or 0)",
                        f"{prefix}        with localcontext() as _fill_context_{index}:",
                        (
                            f"{prefix}            _fill_context_{index}.prec = max(80, "
                            f"_fill_precision_{index} + _fill_scale_{index} + 4, "
                            f"len({lower}.as_tuple().digits) + len({upper}.as_tuple().digits) + "
                            f"_fill_scale_{index} + 4)"
                        ),
                        f"{prefix}            {median} = ({lower} + {upper}) / Decimal(2)",
                        (
                            f"{prefix}        {median} = _ow_decimal_at_scale("
                            f"{median}, _fill_precision_{index}, _fill_scale_{index})"
                        ),
                        f"{prefix}    else:",
                        (
                            f"{prefix}        raise ValueError('Cannot calculate a numeric median for Polars type ' "
                            f"+ str({schema}[{column!r}]) + '.')"
                        ),
                        f"{prefix}_fill_literal_{index} = pl.lit({median}).cast({schema}[{column!r}], strict=True)",
                        (
                            f"{prefix}df = df.with_columns({expression}.fill_null(_fill_literal_{index})"
                            f".alias({column!r}))"
                        ),
                    ]
                )
            else:
                fill_value = generated_fill_replacement_expression(replacement)
                literal = f"_fill_literal_{index}"
                promotes_string = f"_fill_promotes_string_{index}"
                lines.extend(
                    [
                        f"{prefix}_fill_value_{index} = {fill_value}",
                        f"{prefix}if {schema}[{column!r}].base_type() == pl.Decimal:",
                        (
                            f"{prefix}    _fill_value_{index} = _ow_decimal_at_scale(Decimal(_fill_value_{index}), "
                            f"int({schema}[{column!r}].precision or 38), int({schema}[{column!r}].scale or 0))"
                        ),
                        f"{prefix}elif {schema}[{column!r}].base_type() == pl.Datetime:",
                        f"{prefix}    _fill_column_aware_{index} = {schema}[{column!r}].time_zone is not None",
                        (
                            f"{prefix}    _fill_value_aware_{index} = _fill_value_{index}.tzinfo is not None and "
                            f"_fill_value_{index}.utcoffset() is not None"
                        ),
                        f"{prefix}    if _fill_value_aware_{index} != _fill_column_aware_{index}:",
                        (
                            f"{prefix}        _fill_expected_{index} = 'timezone-aware' "
                            f"if _fill_column_aware_{index} else 'timezone-naive'"
                        ),
                        (
                            f"{prefix}        raise ValueError(f'The replacement datetime must be "
                            f"{{_fill_expected_{index}}} to match the selected column.')"
                        ),
                        (
                            f"{prefix}{promotes_string} = "
                            f"str({schema}[{column!r}]).lower() not in {{'string', 'utf8'}} and "
                            f"any(token in str({schema}[{column!r}]).lower() "
                            "for token in ('str', 'utf8', 'object', 'category', 'categorical', "
                            "'varchar', 'char', 'uuid', 'enum'))"
                        ),
                        f"{prefix}if {promotes_string}:",
                        f"{prefix}    if _ow_polars_has_missing(df, {expression}):",
                        f"{prefix}        {expression} = {expression}.cast(pl.String)",
                        (f"{prefix}        {literal} = pl.lit(_fill_value_{index}).cast(pl.String)"),
                        (f"{prefix}        df = df.with_columns({expression}.fill_null({literal}).alias({column!r}))"),
                        f"{prefix}else:",
                        (
                            f"{prefix}    {literal} = pl.lit(_fill_value_{index}) if {schema}[{column!r}] == pl.Null "
                            f"else pl.lit(_fill_value_{index}).cast({schema}[{column!r}], strict=True)"
                        ),
                        (f"{prefix}    df = df.with_columns({expression}.fill_null({literal}).alias({column!r}))"),
                    ]
                )
            return lines
        if kind == "dropDuplicates":
            columns = (
                [bound_column_name(column, kind) for column in params["columns"]] if params.get("columns") else None
            )
            name = f"_duplicate_columns_{index}"
            schema = f"_duplicate_schema_{index}"
            return [
                f"{prefix}{schema} = df.collect_schema() if isinstance(df, pl.LazyFrame) else df.schema",
                f"{prefix}{name} = {columns!r} or {schema}.names()",
                f"{prefix}if {name}:",
                (
                    f"{prefix}    df = df.unique(subset={name}, "
                    f"keep={params.get('keep', 'first')!r}, maintain_order=True)"
                ),
            ]
        if kind == "selectColumns":
            columns = [bound_column_name(column, kind) for column in params["columns"]]
            return [f"{prefix}df = df.select({columns!r})"]
        if kind == "dropColumns":
            columns = [bound_column_name(column, kind) for column in params["columns"]]
            return [f"{prefix}df = df.drop({columns!r})"]
        if kind == "renameColumn":
            column = bound_column_name(params["column"], kind)
            return [f"{prefix}df = df.rename({{{column!r}: {params['newName']!r}}})"]
        if kind == "cloneColumn":
            column = bound_column_name(params["column"], kind)
            return [f"{prefix}df = df.with_columns(pl.col({column!r}).alias({params['newName']!r}))"]
        if kind == "castColumn":
            column = bound_column_name(params["column"], kind)
            dtype = {
                "string": "pl.String",
                "integer": "pl.Int64",
                "float": "pl.Float64",
                "boolean": "pl.Boolean",
                "date": "pl.Date",
                "datetime": "pl.Datetime",
            }[params["dtype"]]
            return [f"{prefix}df = df.with_columns(pl.col({column!r}).cast({dtype}, strict=False))"]
        if kind == "formula":
            left_column = bound_column_name(params["leftColumn"], kind)
            right = (
                f"pl.col({bound_column_name(params['rightColumn'], kind)!r})"
                if params.get("rightColumn")
                else f"pl.lit({params['value']!r})"
            )
            symbol = {"add": "+", "subtract": "-", "multiply": "*", "divide": "/", "modulo": "%", "power": "**"}[
                params["operator"]
            ]
            return [
                (
                    f"{prefix}df = df.with_columns((pl.col({left_column!r}) {symbol} {right})"
                    f".alias({params['newColumn']!r}))"
                )
            ]
        if kind == "textLength":
            column = bound_column_name(params["column"], kind)
            return [
                (
                    f"{prefix}df = df.with_columns(pl.col({column!r}).cast(pl.String)"
                    f".str.len_chars().alias({params['newColumn']!r}))"
                )
            ]
        if kind == "oneHotEncode":
            columns = [bound_column_name(column, kind) for column in params["columns"]]
            eager = f"_eager_{index}"
            generated = f"_generated_{index}"
            encoded = f"_encoded_{index}"
            base = f"_base_{index}"
            names = f"_generated_names_{index}"
            collisions = f"_collisions_{index}"
            reserved = f"_reserved_{index}"
            return [
                f"{prefix}{eager} = df.collect(engine='streaming') if isinstance(df, pl.LazyFrame) else df",
                (
                    f"{prefix}{generated} = [(column, value, str(column) + "
                    f"{params.get('prefixSeparator', '_')!r} + str(value)) for column in {columns!r} "
                    f"for value in sorted({eager}.get_column(column).drop_nulls().unique().to_list(), key=str) "
                    f"if str(value) and not (isinstance(value, float) and value != value)]"
                ),
                f"{prefix}{generated}.sort(key=lambda item: item[2])",
                f"{prefix}{base} = {eager}.drop({columns!r}) if {params.get('dropOriginal', True)!r} else {eager}",
                f"{prefix}{names} = [name for _, _, name in {generated}]",
                (
                    f"{prefix}{reserved} = [name for name in {names} "
                    f"if name.casefold().startswith({INTERNAL_ROW_ID_PREFIX.casefold()!r})]"
                ),
                f"{prefix}if {reserved}:",
                (
                    f"{prefix}    raise ValueError("
                    f'"One-hot encoding would create Open Wrangler\'s reserved private row-identity column.")'
                ),
                (
                    f"{prefix}{collisions} = sorted((set({base}.columns) & set({names})) | "
                    f"{{name for name, count in Counter({names}).items() if count > 1}})"
                ),
                f"{prefix}if {collisions}:",
                (
                    f"{prefix}    raise ValueError('One-hot encoding would create duplicate column names: ' "
                    f"+ ', '.join({collisions}))"
                ),
                f"{prefix}if {generated}:",
                f"{prefix}    {encoded} = {eager}.select([",
                f"{prefix}        (pl.col(column) == pl.lit(value)).fill_null(False).cast(pl.Int8).alias(name)",
                f"{prefix}        for column, value, name in {generated}",
                f"{prefix}    ])",
                f"{prefix}    df = {base}.hstack({encoded})",
                f"{prefix}else:",
                f"{prefix}    df = {base}",
            ]
        if kind == "multiLabelBinarize":
            column = bound_column_name(params["column"], kind)
            delimiter = params["delimiter"]
            eager = f"_eager_{index}"
            labels = f"_labels_{index}"
            encoded = f"_encoded_{index}"
            base = f"_base_{index}"
            names = f"_generated_names_{index}"
            collisions = f"_collisions_{index}"
            reserved = f"_reserved_{index}"
            return [
                f"{prefix}{eager} = df.collect(engine='streaming') if isinstance(df, pl.LazyFrame) else df",
                f"{prefix}{labels} = {eager}.select(",
                f"{prefix}    pl.col({column!r}).cast(pl.String).str.split({delimiter!r})",
                f"{prefix}    .explode(empty_as_null=True).drop_nulls().unique()",
                f"{prefix}).get_column({column!r}).to_list()",
                f"{prefix}{labels} = sorted(str(label) for label in {labels} if str(label))",
                f"{prefix}{base} = {eager}.drop({column!r}) if {params.get('dropOriginal', False)!r} else {eager}",
                f"{prefix}{names} = [{params.get('prefix', f'{column}_')!r} + label for label in {labels}]",
                (
                    f"{prefix}{reserved} = [name for name in {names} "
                    f"if name.casefold().startswith({INTERNAL_ROW_ID_PREFIX.casefold()!r})]"
                ),
                f"{prefix}if {reserved}:",
                (
                    f"{prefix}    raise ValueError("
                    f'"Multi-label binarization would create Open Wrangler\'s reserved private row-identity column.")'
                ),
                (
                    f"{prefix}{collisions} = sorted((set({base}.columns) & set({names})) | "
                    f"{{name for name, count in Counter({names}).items() if count > 1}})"
                ),
                f"{prefix}if {collisions}:",
                (
                    f"{prefix}    raise ValueError('Multi-label binarization would create duplicate column names: ' "
                    f"+ ', '.join({collisions}))"
                ),
                f"{prefix}if {labels}:",
                f"{prefix}    {encoded} = {eager}.select([",
                f"{prefix}        pl.col({column!r}).fill_null('').cast(pl.String)",
                f"{prefix}        .str.split({delimiter!r}).list.contains(label).cast(pl.Int8)",
                f"{prefix}        .alias({params.get('prefix', f'{column}_')!r} + label)",
                f"{prefix}        for label in {labels}",
                f"{prefix}    ])",
                f"{prefix}    df = {base}.hstack({encoded})",
                f"{prefix}else:",
                f"{prefix}    df = {base}",
            ]
        if kind == "splitTextColumns":
            column = bound_column_name(params["column"], kind)
            delimiter = params["delimiter"]
            output_names = list(params["newColumns"])
            schema = f"_split_schema_{index}"
            collisions = f"_split_collisions_{index}"
            reserved = f"_split_reserved_{index}"
            return [
                f"{prefix}{schema} = df.collect_schema() if isinstance(df, pl.LazyFrame) else df.schema",
                (
                    f"{prefix}{reserved} = [name for name in {output_names!r} "
                    f"if name.casefold().startswith({INTERNAL_ROW_ID_PREFIX.casefold()!r})]"
                ),
                f"{prefix}if {reserved}:",
                (
                    f"{prefix}    raise ValueError("
                    "\"Splitting text into columns would create Open Wrangler's reserved "
                    'private row-identity column.")'
                ),
                (
                    f"{prefix}{collisions} = sorted((set({schema}.names()) & set({output_names!r})) | "
                    f"{{name for name, count in Counter({output_names!r}).items() if count > 1}})"
                ),
                f"{prefix}if {collisions}:",
                (
                    f"{prefix}    raise ValueError('Splitting text into columns would create duplicate column names: ' "
                    f"+ ', '.join({collisions}))"
                ),
                f"{prefix}df = df.with_columns([",
                (
                    f"{prefix}    pl.col({column!r}).cast(pl.String).str.split({delimiter!r})"
                    f".list.get(item, null_on_oob=True).alias(name)"
                ),
                f"{prefix}    for item, name in enumerate({output_names!r})",
                f"{prefix}])",
            ]
        if kind == "extractRegexGroup":
            column = bound_column_name(params["column"], kind)
            output = params["newColumn"]
            schema = f"_regex_schema_{index}"
            collisions = f"_regex_collisions_{index}"
            reserved = f"_regex_reserved_{index}"
            return [
                f"{prefix}{schema} = df.collect_schema() if isinstance(df, pl.LazyFrame) else df.schema",
                (
                    f"{prefix}if (not {output!r} or '\\0' in {output!r} or '\\r' in {output!r} or "
                    f"'\\n' in {output!r} or any(0xD800 <= ord(char) <= 0xDFFF for char in {output!r}) or "
                    f"len({output!r}.encode('utf-8')) > 1024):"
                ),
                (
                    f"{prefix}    raise ValueError('Regex extraction output name must be bounded "
                    "single-line Unicode scalar text.')"
                ),
                (f"{prefix}{reserved} = {output!r}.casefold().startswith({INTERNAL_ROW_ID_PREFIX.casefold()!r})"),
                f"{prefix}if {reserved}:",
                (
                    f"{prefix}    raise ValueError(\"Regex extraction would create Open Wrangler's "
                    'reserved private row-identity column.")'
                ),
                f"{prefix}{collisions} = sorted(set({schema}.names()) & {{{output!r}}})",
                f"{prefix}if {collisions}:",
                (
                    f"{prefix}    raise ValueError('Regex extraction would create a duplicate column name: ' "
                    f"+ ', '.join({collisions}))"
                ),
                (
                    f"{prefix}_regex_oversized_{index} = df.select(((pl.col({column!r}).cast(pl.String)"
                    f".str.len_chars() > {MAX_PORTABLE_REGEX_TEXT_CODE_POINTS}) | "
                    f"(pl.col({column!r}).cast(pl.String).str.len_bytes() > {MAX_PORTABLE_REGEX_TEXT_UTF8_BYTES}))"
                    f".fill_null(False).any().alias('oversized'))"
                ),
                (
                    f"{prefix}if bool((_regex_oversized_{index}.collect() if isinstance(_regex_oversized_{index}, "
                    f"pl.LazyFrame) else _regex_oversized_{index}).item()):"
                ),
                f"{prefix}    raise ValueError({PORTABLE_REGEX_TEXT_LIMIT_MESSAGE!r})",
                (
                    f"{prefix}df = df.with_columns(pl.col({column!r}).cast(pl.String)"
                    f".str.extract({params['pattern']!r}, {params['group']}).alias({output!r}))"
                ),
            ]
        if kind in {"findReplace", "stripText", "splitText", "capitalizeText", "lowerText", "upperText"}:
            column = bound_column_name(params["column"], kind)
            target = params.get("newColumn", column)
            base = f"pl.col({column!r}).cast(pl.String)"
            if kind == "findReplace":
                expression = (
                    f"{base}.str.replace_all({params['find']!r}, {params['replacement']!r}, "
                    f"literal={not params.get('regex', False)!r})"
                )
            elif kind == "stripText":
                expression = f"{base}.str.strip_chars({params.get('characters') or DEFAULT_STRIP_CHARACTERS!r})"
            elif kind == "splitText":
                expression = (
                    f"{base}.str.split({params['delimiter']!r}).list.get({params['index']!r}, null_on_oob=True)"
                )
            elif kind == "capitalizeText":
                expression = f"({base}.str.slice(0, 1).str.to_uppercase() + {base}.str.slice(1).str.to_lowercase())"
            elif kind == "lowerText":
                expression = f"{base}.str.to_lowercase()"
            else:
                expression = f"{base}.str.to_uppercase()"
            return [f"{prefix}df = df.with_columns({expression}.alias({target!r}))"]
        if kind == "minMaxScale":
            column = bound_column_name(params["column"], kind)
            target = params.get("newColumn", column)
            name = f"_value_{index}"
            valid = f"_valid_{index}"
            return [
                f"{prefix}{name} = pl.col({column!r}).cast(pl.Float64, strict=False)",
                f"{prefix}{valid} = pl.when({name}.is_finite()).then({name}).otherwise(None)",
                (
                    f"{prefix}df = df.with_columns(pl.when({valid}.is_null()).then(None)"
                    f".when({valid}.max() == {valid}.min()).then(pl.lit(0.0))"
                    f".otherwise(({valid} - {valid}.min()) / "
                    f"({valid}.max() - {valid}.min())).alias({target!r}))"
                ),
            ]
        if kind in {"roundNumber", "floorNumber", "ceilNumber"}:
            column = bound_column_name(params["column"], kind)
            target = params.get("newColumn", column)
            method = (
                f"round({params.get('decimals', 0)!r})"
                if kind == "roundNumber"
                else "floor()"
                if kind == "floorNumber"
                else "ceil()"
            )
            return [
                (
                    f"{prefix}df = df.with_columns(pl.col({column!r}).cast(pl.Float64, strict=False)"
                    f".{method}.alias({target!r}))"
                )
            ]
        if kind == "formatDatetime":
            column = bound_column_name(params["column"], kind)
            target = params.get("newColumn", column)
            return [
                (
                    f"{prefix}df = df.with_columns(pl.col({column!r}).cast(pl.String)"
                    f".str.to_datetime(strict=False).dt.strftime({params['format']!r})"
                    f".alias({target!r}))"
                )
            ]
        if kind == "groupBy":
            keys = [bound_column_name(reference, kind) for reference in params["keys"]]
            schema = f"_group_schema_{index}"
            expressions = f"_group_expressions_{index}"
            lines = [
                f"{prefix}{schema} = df.collect_schema() if isinstance(df, pl.LazyFrame) else df.schema",
                f"{prefix}df = df.with_columns([",
                *[
                    (
                        f"{prefix}    pl.col({key!r}).fill_nan(None).alias({key!r}) "
                        f"if {schema}[{key!r}].is_float() else pl.col({key!r}),"
                    )
                    for key in keys
                ],
                f"{prefix}])",
                f"{prefix}{expressions} = []",
            ]
            for aggregation_index, aggregation in enumerate(params["aggregations"]):
                column = bound_column_name(aggregation["column"], kind)
                value = f"_group_value_{index}_{aggregation_index}"
                lines.extend(
                    [
                        f"{prefix}{value} = pl.col({column!r})",
                        f"{prefix}if {schema}[{column!r}].is_float():",
                        f"{prefix}    {value} = {value}.fill_nan(None)",
                    ]
                )
                if aggregation["operation"] == "sum":
                    lines.extend(
                        [
                            f"{prefix}if {schema}[{column!r}].is_integer():",
                            (
                                f"{prefix}    {expressions}.append(_ow_checked_integer_sum("
                                f"{value}, {schema}[{column!r}])"
                                f".alias({aggregation['alias']!r}))"
                            ),
                            f"{prefix}else:",
                            f"{prefix}    {expressions}.append({_compile_polars_aggregation(aggregation, value)})",
                        ]
                    )
                else:
                    lines.append(f"{prefix}{expressions}.append({_compile_polars_aggregation(aggregation, value)})")
            lines.append(f"{prefix}df = df.group_by({keys!r}, maintain_order=True).agg({expressions})")
            return lines
        if kind == "byExample":
            program = params["program"]
            if not _polars_program_needs_checked_integer_helpers(program):
                expression = _compile_polars_by_example(program)
                return [f"{prefix}df = df.with_columns({expression}.alias({params['newColumn']!r}))"]
            schema = f"_by_example_schema_{index}"
            scalar = f"_by_example_scalar_integer_{index}"
            expression = f"_by_example_expression_{index}"
            column_names = _polars_program_column_names(program)
            native_expression = _compile_polars_by_example(program)
            scalar_expression = _compile_polars_by_example(program, scalar_checked_integers=True)
            return [
                f"{prefix}{schema} = df.collect_schema() if isinstance(df, pl.LazyFrame) else df.schema",
                (f"{prefix}{scalar} = any({schema}[name] == pl.UInt128 for name in {column_names!r})"),
                f"{prefix}{expression} = {scalar_expression} if {scalar} else {native_expression}",
                f"{prefix}df = df.with_columns({expression}.alias({params['newColumn']!r}))",
            ]
        if kind == "customCode":
            function_name = f"_custom_step_{index}"
            code_lines = str(params["code"]).splitlines()
            return [
                f"{prefix}def {function_name}(df):",
                *[f"{prefix}    {line}" if line else f"{prefix}    " for line in code_lines],
                f"{prefix}    return result",
                f"{prefix}df = {function_name}(df)",
            ]
        raise EngineError(f"Polars cannot compile transformation: {kind}")


def _polars_by_example_expression(
    program: Mapping[str, Any],
    *,
    scalar_checked_integers: bool = False,
) -> Any:
    import polars as pl

    def child(value: Mapping[str, Any]) -> Any:
        return _polars_by_example_expression(value, scalar_checked_integers=scalar_checked_integers)

    kind = program["kind"]
    if kind == "column":
        return pl.col(bound_column_name(program["column"], "byExample"))
    if kind == "literal":
        return pl.lit(program.get("value"))
    if kind == "slice":
        start = program["start"]
        stop = program.get("stop")
        length = None if stop is None else stop - start
        return child(program["input"]).cast(pl.String).str.slice(start, length)
    if kind == "split":
        return (
            child(program["input"])
            .cast(pl.String)
            .str.split(program["delimiter"])
            .list.get(program["index"], null_on_oob=True)
        )
    if kind == "concat":
        return pl.concat_str([child(part) for part in program["parts"]], separator="")
    if kind == "regexExtract":
        return child(program["input"]).cast(pl.String).str.extract(program["pattern"], group_index=program["group"])
    if kind == "regexReplace":
        replacement = str(program["replacement"]).replace("$", "$$")
        return child(program["input"]).cast(pl.String).str.replace_all(program["pattern"], replacement)
    if kind == "case":
        value = child(program["input"]).cast(pl.String)
        if program["style"] == "lower":
            return value.str.replace_many(list(_ASCII_UPPER), list(_ASCII_LOWER))
        if program["style"] == "upper":
            return value.str.replace_many(list(_ASCII_LOWER), list(_ASCII_UPPER))
        return value.str.slice(0, 1).str.replace_many(list(_ASCII_LOWER), list(_ASCII_UPPER)) + value.str.slice(
            1
        ).str.replace_many(list(_ASCII_UPPER), list(_ASCII_LOWER))
    if kind == "datetimeFormat":
        return (
            child(program["input"])
            .cast(pl.String)
            .str.strptime(pl.Datetime, format=program["inputFormat"], strict=False)
            .dt.strftime(program["outputFormat"])
        )
    if kind == "arithmetic":
        left = child(program["left"])
        right = child(program["right"])
        widens_integer = program.get("_owResultType") == "integer"
        if widens_integer:
            if scalar_checked_integers:
                return _polars_checked_integer_formula_scalar(left, right, str(program["operator"]))
            return _polars_checked_integer_formula(left, right, str(program["operator"]))
        return _polars_formula(
            left,
            right,
            program["operator"],
        )
    raise EngineError(f"Unsupported Polars by-example expression: {kind}")


def _compile_polars_by_example(
    program: Mapping[str, Any],
    *,
    scalar_checked_integers: bool = False,
) -> str:
    def child(value: Mapping[str, Any]) -> str:
        return _compile_polars_by_example(value, scalar_checked_integers=scalar_checked_integers)

    kind = program["kind"]
    if kind == "column":
        return f"pl.col({bound_column_name(program['column'], 'byExample')!r})"
    if kind == "literal":
        return f"pl.lit({program.get('value')!r})"
    if kind == "slice":
        start = program["start"]
        stop = program.get("stop")
        length = None if stop is None else stop - start
        return f"{child(program['input'])}.cast(pl.String).str.slice({start!r}, {length!r})"
    if kind == "split":
        return (
            f"{child(program['input'])}.cast(pl.String).str.split({program['delimiter']!r})"
            f".list.get({program['index']!r}, null_on_oob=True)"
        )
    if kind == "concat":
        parts = ", ".join(child(part) for part in program["parts"])
        return f"pl.concat_str([{parts}], separator='')"
    if kind == "regexExtract":
        return (
            f"{child(program['input'])}.cast(pl.String)"
            f".str.extract({program['pattern']!r}, group_index={program['group']!r})"
        )
    if kind == "regexReplace":
        replacement = str(program["replacement"]).replace("$", "$$")
        return f"{child(program['input'])}.cast(pl.String).str.replace_all({program['pattern']!r}, {replacement!r})"
    if kind == "case":
        value = f"{child(program['input'])}.cast(pl.String)"
        if program["style"] == "lower":
            return f"{value}.str.replace_many(list({_ASCII_UPPER!r}), list({_ASCII_LOWER!r}))"
        if program["style"] == "upper":
            return f"{value}.str.replace_many(list({_ASCII_LOWER!r}), list({_ASCII_UPPER!r}))"
        return (
            f"({value}.str.slice(0, 1).str.replace_many(list({_ASCII_LOWER!r}), list({_ASCII_UPPER!r})) + "
            f"{value}.str.slice(1).str.replace_many(list({_ASCII_UPPER!r}), list({_ASCII_LOWER!r})))"
        )
    if kind == "datetimeFormat":
        return (
            f"{child(program['input'])}.cast(pl.String)"
            f".str.strptime(pl.Datetime, format={program['inputFormat']!r}, strict=False)"
            f".dt.strftime({program['outputFormat']!r})"
        )
    if kind == "arithmetic":
        symbol = {"add": "+", "subtract": "-", "multiply": "*", "divide": "/"}[program["operator"]]
        left = child(program["left"])
        right = child(program["right"])
        widens_integer = program.get("_owResultType") == "integer"
        if widens_integer:
            if scalar_checked_integers:
                return f"_ow_checked_integer_formula_scalar({left}, {right}, {program['operator']!r})"
            return f"_ow_checked_integer_formula({left}, {right}, {program['operator']!r})"
        return f"({left} {symbol} {right})"
    raise EngineError(f"Unsupported Polars by-example expression: {kind}")


def _polars_middle_values(frame: Any, expression: Any) -> tuple[Any, Any]:
    import polars as pl

    ordered = expression.drop_nulls().sort()
    count_query = frame.select(ordered.len().alias("__ow_fill_count"))
    count_frame = count_query.collect(engine="streaming") if isinstance(count_query, pl.LazyFrame) else count_query
    count = int(count_frame.item())
    if count == 0:
        raise EngineError("Cannot fill with the median because the selected column has no present numeric values.")
    offset = (count - 1) // 2
    length = 2 if count % 2 == 0 else 1
    middle_query = frame.select(ordered.slice(offset, length).alias("__ow_fill_middle"))
    middle_frame = middle_query.collect(engine="streaming") if isinstance(middle_query, pl.LazyFrame) else middle_query
    values = middle_frame.to_series().to_list()
    if len(values) != length:
        raise EngineError("Polars could not retrieve the exact middle values for the median fill.")
    return values[0], values[-1]


def _polars_fill_missing_from_columns(frame: Any, target: str, fallbacks: list[str]) -> Any:
    import polars as pl

    schema = frame.collect_schema() if isinstance(frame, pl.LazyFrame) else frame.schema
    target_dtype = schema[target]
    output_dtype = target_dtype
    if target_dtype.base_type() == pl.Enum and any(schema[fallback] != target_dtype for fallback in fallbacks):
        # Enum domains are closed.  Check only values that can actually win the
        # ordered fallback chain; an unused later fallback must not widen an
        # otherwise unchanged Enum column.
        probe_target = pl.col(target)
        probe_remaining = probe_target.is_null()
        probe_widening = pl.lit(False)
        for fallback in fallbacks:
            probe_candidate = pl.col(fallback)
            if schema[fallback].is_float():
                probe_candidate = probe_candidate.fill_nan(None)
            probe_available = probe_candidate.is_not_null()
            probe_selected = probe_remaining & probe_available
            if schema[fallback] != target_dtype:
                probe_widening = probe_widening | (
                    probe_selected & probe_candidate.cast(target_dtype, strict=False).is_null()
                )
            probe_remaining = probe_remaining & ~probe_available
        probe_query = frame.select(probe_widening.any().alias("__ow_fill_enum_widens"))
        probe_result = probe_query.collect(engine="streaming") if isinstance(probe_query, pl.LazyFrame) else probe_query
        if bool(probe_result.item()):
            output_dtype = pl.String
    target_value = pl.col(target)
    target_missing = target_value.is_null()
    if target_dtype.is_float():
        target_missing = target_missing | target_value.is_nan()
    remaining = target_missing
    candidates = []
    for fallback in fallbacks:
        fallback_dtype = schema[fallback]
        if target_dtype == pl.Float32 and fallback_dtype == pl.Float64:
            raise EngineError(
                f"Fallback column {fallback!r} cannot be represented exactly as Float32. "
                "Convert the target column to Float64 first."
            )
        if target_dtype.base_type() in {pl.Decimal, pl.Datetime} and fallback_dtype != target_dtype:
            raise EngineError(
                f"Fallback column {fallback!r} has Polars type {fallback_dtype}, not {target_dtype}. "
                "Convert the columns to one exact type before filling."
            )
        candidate = pl.col(fallback)
        if fallback_dtype.is_float():
            candidate = candidate.fill_nan(None)
        available = candidate.is_not_null()
        # Mask values that cannot win before the strict cast.  A wider value
        # elsewhere in the fallback column must not fail a row whose target or
        # earlier fallback already supplied the result.
        selected = pl.when(remaining & available).then(candidate).otherwise(None)
        candidates.append(selected.cast(output_dtype, strict=True))
        remaining = remaining & ~available

    fallback_value = pl.coalesce(candidates)
    # Keep the original target scalar when no fallback resolves it.  In
    # particular, an unresolved float NaN remains NaN rather than becoming a
    # null merely because NaN participates in missing-value matching.
    output_target = target_value.cast(output_dtype, strict=True) if output_dtype != target_dtype else target_value
    result = pl.when(target_missing & fallback_value.is_not_null()).then(fallback_value).otherwise(output_target)
    return frame.with_columns(result.alias(target))


def _polars_fill_missing_directional(
    frame: Any,
    target: str,
    order_rules: Sequence[Mapping[str, Any]],
    direction: str,
    max_gap: int | None,
) -> Any:
    """Fill complete missing runs in stable calculation order without collecting a lazy frame."""

    import polars as pl

    schema = frame.collect_schema() if isinstance(frame, pl.LazyFrame) else frame.schema
    reserved = set(schema.names())

    def unique(base: str) -> str:
        candidate = base
        while candidate in reserved:
            candidate += "_"
        reserved.add(candidate)
        return candidate

    position_name = unique("__ow_directional_position")
    missing_name = unique("__ow_directional_missing")
    run_name = unique("__ow_directional_run")
    gap_name = unique("__ow_directional_gap")
    candidate_name = unique("__ow_directional_candidate")

    target_value = pl.col(target)
    target_missing = target_value.is_null()
    candidate = target_value
    if schema[target].is_float():
        target_missing = target_missing | target_value.is_nan()
        candidate = candidate.fill_nan(None)

    order_expressions = []
    for rule in order_rules:
        expression = pl.col(rule["column"])
        if schema[rule["column"]].is_float():
            expression = expression.fill_nan(None)
        order_expressions.append(expression)
    ordered = frame.with_row_index(position_name).sort(
        order_expressions,
        descending=[rule["direction"] == "desc" for rule in order_rules],
        nulls_last=[rule["nulls"] == "last" for rule in order_rules],
        maintain_order=True,
    )
    ordered = ordered.with_columns(target_missing.alias(missing_name))
    ordered = ordered.with_columns(
        (pl.col(missing_name) != pl.col(missing_name).shift(1).fill_null(False)).cum_sum().alias(run_name)
    )
    ordered = ordered.with_columns(
        pl.when(pl.col(missing_name)).then(pl.len().over(run_name)).otherwise(0).alias(gap_name),
        (candidate.forward_fill() if direction == "forward" else candidate.backward_fill()).alias(candidate_name),
    )
    eligible = pl.col(missing_name) & pl.col(candidate_name).is_not_null()
    if max_gap is not None:
        eligible = eligible & (pl.col(gap_name) <= max_gap)
    result = pl.when(eligible).then(pl.col(candidate_name)).otherwise(target_value)
    return (
        ordered.with_columns(result.alias(target))
        .sort(position_name)
        .drop(position_name, missing_name, run_name, gap_name, candidate_name)
    )


def _polars_fill_missing_linear_interpolation(
    frame: Any,
    target: str,
    coordinate: str,
    max_gap: int | None,
) -> Any:
    """Interpolate bracketed float gaps while preserving a lazy input plan."""

    import polars as pl

    schema = frame.collect_schema() if isinstance(frame, pl.LazyFrame) else frame.schema
    target_dtype = schema[target]
    coordinate_dtype = schema[coordinate]
    if not target_dtype.is_float():
        raise EngineError("Linear interpolation requires a floating-point target column.")
    coordinate_kind = _polars_interpolation_coordinate_kind(coordinate_dtype)
    source_coordinate = pl.col(coordinate)
    invalid_coordinate = source_coordinate.is_null()
    if coordinate_dtype.is_float():
        invalid_coordinate = invalid_coordinate | ~source_coordinate.is_finite()
    reserved = set(schema.names())

    def unique(base: str) -> str:
        candidate = base
        while candidate in reserved:
            candidate += "_"
        reserved.add(candidate)
        return candidate

    validation_minimum_name = unique("__ow_interpolation_validation_minimum")
    validation_coordinate_name = unique("__ow_interpolation_validation_coordinate")
    validation_frame = frame.with_columns(source_coordinate.min().alias(validation_minimum_name))
    validation_coordinate = _polars_interpolation_coordinate_expression(
        source_coordinate,
        coordinate_dtype,
        coordinate_kind,
        pl.col(validation_minimum_name),
    )
    validation_roundtrip = _polars_interpolation_coordinate_roundtrip(
        source_coordinate,
        coordinate_dtype,
        coordinate_kind,
        pl.col(validation_minimum_name),
    )
    summary_query = validation_frame.with_columns(validation_coordinate.alias(validation_coordinate_name)).select(
        pl.len().alias("__ow_count"),
        invalid_coordinate.sum().alias("__ow_invalid"),
        source_coordinate.n_unique().alias("__ow_unique"),
        pl.col(validation_coordinate_name).n_unique().alias("__ow_projected_unique"),
        pl.col(validation_coordinate_name).is_finite().all().alias("__ow_projected_finite"),
        validation_roundtrip.all().alias("__ow_projected_exact"),
        pl.col(validation_minimum_name).first().alias("__ow_minimum"),
    )
    try:
        summary = (
            summary_query.collect(engine="streaming") if isinstance(summary_query, pl.LazyFrame) else summary_query
        )
    except Exception as error:
        raise EngineError("Linear interpolation cannot represent the selected coordinate distances exactly.") from error
    count = int(summary["__ow_count"][0])
    if int(summary["__ow_invalid"][0] or 0):
        raise EngineError("Linear interpolation requires every coordinate value to be present and finite.")
    if int(summary["__ow_unique"][0]) != count:
        raise EngineError("Linear interpolation requires unique coordinate values.")
    if count and (
        not bool(summary["__ow_projected_finite"][0])
        or not bool(summary["__ow_projected_exact"][0])
        or int(summary["__ow_projected_unique"][0]) != count
    ):
        raise EngineError(
            "Linear interpolation cannot preserve the selected coordinate distances exactly enough; "
            "choose a lower-precision coordinate column."
        )
    minimum = summary["__ow_minimum"][0] if count else None
    numeric_coordinate = _polars_interpolation_coordinate_expression(
        source_coordinate,
        coordinate_dtype,
        coordinate_kind,
        minimum,
    )
    position_name = unique("__ow_interpolation_position")
    missing_name = unique("__ow_interpolation_missing")
    run_name = unique("__ow_interpolation_run")
    gap_name = unique("__ow_interpolation_gap")
    coordinate_name = unique("__ow_interpolation_coordinate")
    left_value_name = unique("__ow_interpolation_left_value")
    right_value_name = unique("__ow_interpolation_right_value")
    left_coordinate_name = unique("__ow_interpolation_left_coordinate")
    right_coordinate_name = unique("__ow_interpolation_right_coordinate")

    target_value = pl.col(target)
    missing = target_value.is_null() | target_value.is_nan()
    present_target = pl.when(missing).then(None).otherwise(target_value)
    present_coordinate = pl.when(missing).then(None).otherwise(pl.col(coordinate_name))
    ordered = (
        frame.with_row_index(position_name)
        .sort(coordinate, maintain_order=True)
        .with_columns(
            missing.alias(missing_name),
            numeric_coordinate.alias(coordinate_name),
        )
        .with_columns(
            (pl.col(missing_name) != pl.col(missing_name).shift(1).fill_null(False)).cum_sum().alias(run_name),
            present_target.shift(1).forward_fill().alias(left_value_name),
            present_target.shift(-1).backward_fill().alias(right_value_name),
            present_coordinate.shift(1).forward_fill().alias(left_coordinate_name),
            present_coordinate.shift(-1).backward_fill().alias(right_coordinate_name),
        )
        .with_columns(pl.when(pl.col(missing_name)).then(pl.len().over(run_name)).otherwise(0).alias(gap_name))
    )
    left_coordinate = pl.col(left_coordinate_name)
    right_coordinate = pl.col(right_coordinate_name)
    current_coordinate = pl.col(coordinate_name)
    coordinate_span = right_coordinate - left_coordinate
    direct_weight = (current_coordinate - left_coordinate) / coordinate_span
    scaled_weight = ((current_coordinate / 2.0) - (left_coordinate / 2.0)) / (
        (right_coordinate / 2.0) - (left_coordinate / 2.0)
    )
    weight = pl.when(coordinate_span.is_finite()).then(direct_weight).otherwise(scaled_weight)
    left_value = pl.col(left_value_name)
    right_value = pl.col(right_value_name)
    interpolated = ((pl.lit(1.0) - weight) * left_value + weight * right_value).cast(target_dtype)
    eligible = (
        pl.col(missing_name)
        & left_value.is_finite()
        & right_value.is_finite()
        & weight.is_finite()
        & weight.is_between(0.0, 1.0, closed="both")
    )
    if max_gap is not None:
        eligible = eligible & (pl.col(gap_name) <= max_gap)
    temporary_names = [
        position_name,
        missing_name,
        run_name,
        gap_name,
        coordinate_name,
        left_value_name,
        right_value_name,
        left_coordinate_name,
        right_coordinate_name,
    ]
    return (
        ordered.with_columns(pl.when(eligible).then(interpolated).otherwise(target_value).alias(target))
        .sort(position_name)
        .drop(*temporary_names)
    )


def _polars_interpolation_coordinate_kind(dtype: Any) -> str:
    import polars as pl

    if dtype in {pl.Int128, pl.UInt128}:
        raise EngineError(
            "Linear interpolation does not support 128-bit integer coordinates; "
            "convert the coordinate to a narrower exact type first."
        )
    if dtype.is_integer():
        return "integer"
    if dtype.is_float():
        return "float"
    if dtype.base_type() == pl.Decimal:
        return "decimal"
    if dtype == pl.Date:
        return "date"
    if dtype.base_type() == pl.Datetime:
        return "datetime"
    raise EngineError("Linear interpolation coordinates must be numeric, dates, or datetimes.")


def _polars_interpolation_coordinate_expression(
    expression: Any,
    dtype: Any,
    kind: str,
    minimum: Any,
) -> Any:
    import polars as pl

    if kind == "float":
        return expression.cast(pl.Float64)
    minimum_expression = minimum if isinstance(minimum, pl.Expr) else pl.lit(minimum, dtype=dtype)
    if kind in {"integer", "datetime"}:
        raw = expression.cast(pl.Int128)
        minimum_raw = minimum_expression.cast(pl.Int128)
        return (raw - minimum_raw).cast(pl.Float64)
    if kind == "date":
        raw = expression.cast(pl.Int32).cast(pl.Int64)
        minimum_raw = minimum_expression.cast(pl.Date).cast(pl.Int32).cast(pl.Int64)
        return (raw - minimum_raw).cast(pl.Float64)
    exact_dtype = pl.Decimal(38, dtype.scale)
    return (expression.cast(exact_dtype) - minimum_expression.cast(exact_dtype)).cast(pl.Float64)


def _polars_interpolation_coordinate_roundtrip(
    expression: Any,
    dtype: Any,
    kind: str,
    minimum: Any,
) -> Any:
    import polars as pl

    if kind == "float":
        return pl.lit(True)
    minimum_expression = minimum if isinstance(minimum, pl.Expr) else pl.lit(minimum, dtype=dtype)
    if kind in {"integer", "datetime"}:
        exact = expression.cast(pl.Int128) - minimum_expression.cast(pl.Int128)
        return exact.cast(pl.Float64).cast(pl.Int128) == exact
    if kind == "date":
        exact = expression.cast(pl.Int32).cast(pl.Int64) - minimum_expression.cast(pl.Date).cast(pl.Int32).cast(
            pl.Int64
        )
        return exact.cast(pl.Float64).cast(pl.Int64) == exact
    exact_dtype = pl.Decimal(38, dtype.scale)
    exact = expression.cast(exact_dtype) - minimum_expression.cast(exact_dtype)
    return exact.cast(pl.Float64).cast(exact_dtype) == exact


def _polars_fill_missing_grouped_statistic(
    frame: Any,
    target: str,
    keys: list[str],
    statistic: str,
) -> Any:
    import polars as pl

    schema = frame.collect_schema() if isinstance(frame, pl.LazyFrame) else frame.schema
    target_dtype = schema[target]
    object_columns = [column for column in [target, *keys] if schema[column] == pl.Object]
    if object_columns:
        raise EngineError(
            "Grouped fills require native scalar Polars columns; Object columns are not supported: "
            + ", ".join(object_columns)
        )
    target_value = pl.col(target)
    if target_dtype.is_float():
        target_value = target_value.fill_nan(None)

    reserved = set(schema.names())

    def unique(base: str) -> str:
        candidate = base
        while candidate in reserved:
            candidate += "_"
        reserved.add(candidate)
        return candidate

    normalized_keys: list[str] = []
    key_expressions = []
    for index, key in enumerate(keys):
        name = unique(f"__ow_grouped_key_{index}")
        expression = pl.col(key)
        if schema[key].is_float():
            expression = expression.fill_nan(None)
        normalized_keys.append(name)
        key_expressions.append(expression.alias(name))
    fill_name = unique("__ow_grouped_fill")

    normalized = frame.with_columns(key_expressions)
    if statistic == "mean":
        positive_name = unique("__ow_grouped_positive")
        negative_name = unique("__ow_grouped_negative")
        scale_name = unique("__ow_grouped_scale")
        scaled_name = unique("__ow_grouped_scaled")
        stats = normalized.group_by(normalized_keys, maintain_order=True).agg(
            (target_value == float("inf")).any().alias(positive_name),
            (target_value == float("-inf")).any().alias(negative_name),
            target_value.filter(target_value.is_finite()).abs().max().alias(scale_name),
        )
        annotated = normalized.join(
            stats,
            on=normalized_keys,
            how="left",
            nulls_equal=True,
            maintain_order="left",
        )
        summary = annotated.group_by(normalized_keys, maintain_order=True).agg(
            pl.col(positive_name).first(),
            pl.col(negative_name).first(),
            pl.col(scale_name).first(),
            (target_value / pl.col(scale_name)).filter(target_value.is_finite()).mean().alias(scaled_name),
        )
        fill = (
            pl.when(pl.col(positive_name) & pl.col(negative_name))
            .then(None)
            .when(pl.col(positive_name))
            .then(float("inf"))
            .when(pl.col(negative_name))
            .then(float("-inf"))
            .when(pl.col(scale_name).is_null())
            .then(None)
            .when(pl.col(scale_name) == 0)
            .then(0.0)
            .otherwise(pl.col(scaled_name).clip(-1.0, 1.0) * pl.col(scale_name))
            .cast(target_dtype, strict=True)
            .alias(fill_name)
        )
        summary = summary.select(*normalized_keys, fill)
    elif statistic == "mostFrequent":
        count_name = unique("__ow_grouped_count")
        maximum_name = unique("__ow_grouped_maximum")
        ties_name = unique("__ow_grouped_ties")
        counts = (
            normalized.filter(target_value.is_not_null())
            .group_by([*normalized_keys, target], maintain_order=True)
            .len(name=count_name)
        )
        winners = counts.with_columns(pl.col(count_name).max().over(normalized_keys).alias(maximum_name)).filter(
            pl.col(count_name) == pl.col(maximum_name)
        )
        summary = winners.group_by(normalized_keys, maintain_order=True).agg(
            pl.col(target).first().alias(fill_name),
            pl.len().alias(ties_name),
        )
        summary = summary.with_columns(
            pl.when(pl.col(ties_name) == 1)
            .then(pl.col(fill_name))
            .otherwise(None)
            .cast(target_dtype, strict=True)
            .alias(fill_name)
        ).drop(ties_name)
    elif target_dtype.is_float():
        lower_name = unique("__ow_grouped_lower")
        upper_name = unique("__ow_grouped_upper")
        summary = normalized.group_by(normalized_keys, maintain_order=True).agg(
            target_value.quantile(0.5, interpolation="lower").alias(lower_name),
            target_value.quantile(0.5, interpolation="higher").alias(upper_name),
        )
        lower = pl.col(lower_name)
        upper = pl.col(upper_name)
        finite = lower.is_finite() & upper.is_finite()
        same_sign = (lower < 0) == (upper < 0)
        midpoint = (
            pl.when(lower == upper)
            .then(lower)
            .when(finite & same_sign)
            .then(lower + ((upper - lower) / 2.0))
            .otherwise((lower / 2.0) + (upper / 2.0))
            .fill_nan(None)
            .cast(target_dtype, strict=True)
            .alias(fill_name)
        )
        summary = summary.select(*normalized_keys, midpoint)
    else:
        lower_name = unique("__ow_grouped_lower")
        upper_name = unique("__ow_grouped_upper")
        missing_name = unique("__ow_grouped_missing")
        present = target_value.drop_nulls()
        summary = normalized.group_by(normalized_keys, maintain_order=True).agg(
            present.sort().get((present.len() - 1) // 2, null_on_oob=True).alias(lower_name),
            present.sort().get(present.len() // 2, null_on_oob=True).alias(upper_name),
            target_value.is_null().any().alias(missing_name),
        )

        def calculate(item: dict[str, Any]) -> Any:
            if not item[missing_name] or item[lower_name] is None or item[upper_name] is None:
                return None
            lower = item[lower_name]
            upper = item[upper_name]
            if target_dtype.is_integer():
                return exact_integer_median(lower, upper)
            if isinstance(target_dtype, pl.Decimal):
                return exact_decimal_median(lower, upper, target_dtype.precision, target_dtype.scale)
            raise EngineError("Grouped median requires an integer or decimal Polars column.")

        fill = (
            pl.struct(lower_name, upper_name, missing_name)
            .map_elements(
                calculate,
                return_dtype=target_dtype,
                skip_nulls=False,
            )
            .alias(fill_name)
        )
        summary = summary.select(*normalized_keys, fill)

    if isinstance(frame, pl.LazyFrame):
        assert isinstance(normalized, pl.LazyFrame)
        mapping = summary if isinstance(summary, pl.LazyFrame) else summary.lazy()
        joined = normalized.join(
            mapping,
            on=normalized_keys,
            how="left",
            nulls_equal=True,
            maintain_order="left",
        )
    else:
        assert isinstance(normalized, pl.DataFrame)
        mapping = summary.collect(engine="streaming") if isinstance(summary, pl.LazyFrame) else summary
        joined = normalized.join(
            mapping,
            on=normalized_keys,
            how="left",
            nulls_equal=True,
            maintain_order="left",
        )
    eligible = target_value.is_null() & pl.col(fill_name).is_not_null()
    result = pl.when(eligible).then(pl.col(fill_name)).otherwise(pl.col(target)).alias(target)
    return joined.with_columns(result).drop(*normalized_keys, fill_name)


def _polars_has_missing(frame: Any, expression: Any) -> bool:
    import polars as pl

    query = frame.select(expression.is_null().any().alias("__ow_fill_has_missing"))
    result = query.collect(engine="streaming") if isinstance(query, pl.LazyFrame) else query
    return bool(result.item())


def _polars_stable_float_mean(frame: Any, expression: Any) -> float:
    import polars as pl

    stats_query = frame.select(
        (expression == float("inf")).any().alias("__ow_fill_positive_infinity"),
        (expression == float("-inf")).any().alias("__ow_fill_negative_infinity"),
        expression.filter(expression.is_finite()).abs().max().alias("__ow_fill_scale"),
    )
    stats = stats_query.collect(engine="streaming") if isinstance(stats_query, pl.LazyFrame) else stats_query
    has_positive_infinity = bool(stats["__ow_fill_positive_infinity"][0])
    has_negative_infinity = bool(stats["__ow_fill_negative_infinity"][0])
    if has_positive_infinity and has_negative_infinity:
        raise EngineError("Cannot fill with the mean because positive and negative infinity make it undefined.")
    if has_positive_infinity:
        return float("inf")
    if has_negative_infinity:
        return float("-inf")
    scale = stats["__ow_fill_scale"][0]
    if scale is None:
        raise EngineError("Cannot fill with the mean because the selected column has no present numeric values.")
    scale = float(scale)
    if scale == 0:
        return 0.0
    mean_query = frame.select((expression / pl.lit(scale)).mean().alias("__ow_fill_scaled_mean"))
    mean_frame = mean_query.collect(engine="streaming") if isinstance(mean_query, pl.LazyFrame) else mean_query
    scaled_mean = float(mean_frame.item())
    return max(-1.0, min(1.0, scaled_mean)) * scale


def _polars_most_frequent_value(frame: Any, column: str, expression: Any) -> Any:
    import polars as pl

    reserved = {column}
    count_name = "__ow_fill_count"
    while count_name in reserved:
        count_name += "_"
    reserved.add(count_name)
    maximum_name = "__ow_fill_maximum"
    while maximum_name in reserved:
        maximum_name += "_"
    reserved.add(maximum_name)
    ties_name = "__ow_fill_ties"
    while ties_name in reserved:
        ties_name += "_"

    counts = (
        frame.select(expression.alias(column))
        .filter(pl.col(column).is_not_null())
        .group_by(column)
        .len(name=count_name)
    )
    winners = counts.with_columns(pl.col(count_name).max().alias(maximum_name)).filter(
        pl.col(count_name) == pl.col(maximum_name)
    )
    query = winners.select(pl.col(column).first().alias(column), pl.len().alias(ties_name))
    result = query.collect(engine="streaming") if isinstance(query, pl.LazyFrame) else query
    tie_count = int(result[ties_name][0])
    if tie_count == 0:
        raise EngineError("This column has no non-missing values. Choose a specific value.")
    if tie_count != 1:
        raise EngineError(
            f"This column has no single most common value: {tie_count} values are tied. Choose a specific value."
        )
    return result[column][0]


def _generated_polars_linear_interpolation_helpers() -> list[str]:
    source: str = r"""

def _ow_polars_interpolation_coordinate_kind(dtype):
    if dtype in {pl.Int128, pl.UInt128}:
        raise ValueError(
            'Linear interpolation does not support 128-bit integer coordinates; '
            'convert the coordinate to a narrower exact type first.'
        )
    if dtype.is_integer():
        return 'integer'
    if dtype.is_float():
        return 'float'
    if dtype.base_type() == pl.Decimal:
        return 'decimal'
    if dtype == pl.Date:
        return 'date'
    if dtype.base_type() == pl.Datetime:
        return 'datetime'
    raise ValueError('Linear interpolation coordinates must be numeric, dates, or datetimes.')


def _ow_polars_interpolation_coordinate_expression(expression, dtype, kind, minimum):
    if kind == 'float':
        return expression.cast(pl.Float64)
    minimum_expression = minimum if isinstance(minimum, pl.Expr) else pl.lit(minimum, dtype=dtype)
    if kind in {'integer', 'datetime'}:
        raw = expression.cast(pl.Int128)
        minimum_raw = minimum_expression.cast(pl.Int128)
        return (raw - minimum_raw).cast(pl.Float64)
    if kind == 'date':
        raw = expression.cast(pl.Int32).cast(pl.Int64)
        minimum_raw = minimum_expression.cast(pl.Date).cast(pl.Int32).cast(pl.Int64)
        return (raw - minimum_raw).cast(pl.Float64)
    exact_dtype = pl.Decimal(38, dtype.scale)
    return (expression.cast(exact_dtype) - minimum_expression.cast(exact_dtype)).cast(pl.Float64)


def _ow_polars_interpolation_coordinate_roundtrip(expression, dtype, kind, minimum):
    if kind == 'float':
        return pl.lit(True)
    minimum_expression = minimum if isinstance(minimum, pl.Expr) else pl.lit(minimum, dtype=dtype)
    if kind in {'integer', 'datetime'}:
        exact = expression.cast(pl.Int128) - minimum_expression.cast(pl.Int128)
        return exact.cast(pl.Float64).cast(pl.Int128) == exact
    if kind == 'date':
        exact = (
            expression.cast(pl.Int32).cast(pl.Int64)
            - minimum_expression.cast(pl.Date).cast(pl.Int32).cast(pl.Int64)
        )
        return exact.cast(pl.Float64).cast(pl.Int64) == exact
    exact_dtype = pl.Decimal(38, dtype.scale)
    exact = expression.cast(exact_dtype) - minimum_expression.cast(exact_dtype)
    return exact.cast(pl.Float64).cast(exact_dtype) == exact


def _ow_polars_fill_missing_linear_interpolation(frame, target, coordinate, max_gap):
    schema = frame.collect_schema() if isinstance(frame, pl.LazyFrame) else frame.schema
    target_dtype = schema[target]
    coordinate_dtype = schema[coordinate]
    if not target_dtype.is_float():
        raise ValueError('Linear interpolation requires a floating-point target column.')
    coordinate_kind = _ow_polars_interpolation_coordinate_kind(coordinate_dtype)
    source_coordinate = pl.col(coordinate)
    invalid_coordinate = source_coordinate.is_null()
    if coordinate_dtype.is_float():
        invalid_coordinate = invalid_coordinate | ~source_coordinate.is_finite()
    reserved = set(schema.names())
    def unique(base):
        candidate = base
        while candidate in reserved:
            candidate += '_'
        reserved.add(candidate)
        return candidate
    validation_minimum_name = unique('__ow_interpolation_validation_minimum')
    validation_coordinate_name = unique('__ow_interpolation_validation_coordinate')
    validation_frame = frame.with_columns(source_coordinate.min().alias(validation_minimum_name))
    validation_coordinate = _ow_polars_interpolation_coordinate_expression(
        source_coordinate, coordinate_dtype, coordinate_kind, pl.col(validation_minimum_name)
    )
    validation_roundtrip = _ow_polars_interpolation_coordinate_roundtrip(
        source_coordinate, coordinate_dtype, coordinate_kind, pl.col(validation_minimum_name)
    )
    summary_query = validation_frame.with_columns(validation_coordinate.alias(validation_coordinate_name)).select(
        pl.len().alias('__ow_count'),
        invalid_coordinate.sum().alias('__ow_invalid'),
        source_coordinate.n_unique().alias('__ow_unique'),
        pl.col(validation_coordinate_name).n_unique().alias('__ow_projected_unique'),
        pl.col(validation_coordinate_name).is_finite().all().alias('__ow_projected_finite'),
        validation_roundtrip.all().alias('__ow_projected_exact'),
        pl.col(validation_minimum_name).first().alias('__ow_minimum'),
    )
    try:
        summary = (
            summary_query.collect(engine='streaming')
            if isinstance(summary_query, pl.LazyFrame)
            else summary_query
        )
    except Exception as error:
        raise ValueError(
            'Linear interpolation cannot represent the selected coordinate distances exactly.'
        ) from error
    count = int(summary['__ow_count'][0])
    if int(summary['__ow_invalid'][0] or 0):
        raise ValueError('Linear interpolation requires every coordinate value to be present and finite.')
    if int(summary['__ow_unique'][0]) != count:
        raise ValueError('Linear interpolation requires unique coordinate values.')
    if count and (
        not bool(summary['__ow_projected_finite'][0])
        or not bool(summary['__ow_projected_exact'][0])
        or int(summary['__ow_projected_unique'][0]) != count
    ):
        raise ValueError(
            'Linear interpolation cannot preserve the selected coordinate distances exactly enough; '
            'choose a lower-precision coordinate column.'
        )
    minimum = summary['__ow_minimum'][0] if count else None
    numeric_coordinate = _ow_polars_interpolation_coordinate_expression(
        source_coordinate, coordinate_dtype, coordinate_kind, minimum
    )
    position_name = unique('__ow_interpolation_position')
    missing_name = unique('__ow_interpolation_missing')
    run_name = unique('__ow_interpolation_run')
    gap_name = unique('__ow_interpolation_gap')
    coordinate_name = unique('__ow_interpolation_coordinate')
    left_value_name = unique('__ow_interpolation_left_value')
    right_value_name = unique('__ow_interpolation_right_value')
    left_coordinate_name = unique('__ow_interpolation_left_coordinate')
    right_coordinate_name = unique('__ow_interpolation_right_coordinate')
    target_value = pl.col(target)
    missing = target_value.is_null() | target_value.is_nan()
    present_target = pl.when(missing).then(None).otherwise(target_value)
    present_coordinate = pl.when(missing).then(None).otherwise(pl.col(coordinate_name))
    ordered = (
        frame.with_row_index(position_name)
        .sort(coordinate, maintain_order=True)
        .with_columns(missing.alias(missing_name), numeric_coordinate.alias(coordinate_name))
        .with_columns(
            (pl.col(missing_name) != pl.col(missing_name).shift(1).fill_null(False)).cum_sum().alias(run_name),
            present_target.shift(1).forward_fill().alias(left_value_name),
            present_target.shift(-1).backward_fill().alias(right_value_name),
            present_coordinate.shift(1).forward_fill().alias(left_coordinate_name),
            present_coordinate.shift(-1).backward_fill().alias(right_coordinate_name),
        )
        .with_columns(pl.when(pl.col(missing_name)).then(pl.len().over(run_name)).otherwise(0).alias(gap_name))
    )
    left_coordinate = pl.col(left_coordinate_name)
    right_coordinate = pl.col(right_coordinate_name)
    current_coordinate = pl.col(coordinate_name)
    coordinate_span = right_coordinate - left_coordinate
    direct_weight = (current_coordinate - left_coordinate) / coordinate_span
    scaled_weight = ((current_coordinate / 2.0) - (left_coordinate / 2.0)) / (
        (right_coordinate / 2.0) - (left_coordinate / 2.0)
    )
    weight = pl.when(coordinate_span.is_finite()).then(direct_weight).otherwise(scaled_weight)
    left_value = pl.col(left_value_name)
    right_value = pl.col(right_value_name)
    interpolated = ((pl.lit(1.0) - weight) * left_value + weight * right_value).cast(target_dtype)
    eligible = (
        pl.col(missing_name)
        & left_value.is_finite()
        & right_value.is_finite()
        & weight.is_finite()
        & weight.is_between(0.0, 1.0, closed='both')
    )
    if max_gap is not None:
        eligible = eligible & (pl.col(gap_name) <= max_gap)
    temporary_names = [
        position_name, missing_name, run_name, gap_name, coordinate_name,
        left_value_name, right_value_name, left_coordinate_name, right_coordinate_name,
    ]
    return (
        ordered.with_columns(pl.when(eligible).then(interpolated).otherwise(target_value).alias(target))
        .sort(position_name)
        .drop(*temporary_names)
    )
"""
    lines: list[str] = []
    lines.extend(source.strip("\n").splitlines())
    return lines


def _generated_polars_fill_helpers() -> list[str]:
    return [
        "",
        "def _ow_decimal_at_scale(value, precision, scale):",
        "    if not value.is_finite() or precision < 1 or scale < 0 or scale > precision:",
        "        raise ValueError(f'The replacement value does not fit DECIMAL({precision}, {scale}).')",
        "    quantum = Decimal((0, (1,), -scale))",
        "    try:",
        "        with localcontext() as context:",
        "            context.prec = max(80, precision + scale + 4, len(value.as_tuple().digits) + scale + 4)",
        "            normalized = value.quantize(quantum)",
        "    except InvalidOperation as error:",
        "        raise ValueError(f'The replacement value does not fit DECIMAL({precision}, {scale}).') from error",
        "    if normalized != value:",
        "        raise ValueError(f'The replacement value cannot be represented exactly at decimal scale {scale}.')",
        "    if normalized != 0 and normalized.adjusted() >= precision - scale:",
        "        raise ValueError(f'The replacement value does not fit DECIMAL({precision}, {scale}).')",
        "    return normalized",
        "",
        "",
        "def _ow_polars_middle_values(frame, expression):",
        "    ordered = expression.drop_nulls().sort()",
        "    count_query = frame.select(ordered.len().alias('__ow_fill_count'))",
        (
            "    count_frame = count_query.collect(engine='streaming') "
            "if isinstance(count_query, pl.LazyFrame) else count_query"
        ),
        "    count = int(count_frame.item())",
        "    if count == 0:",
        (
            "        raise ValueError('Cannot fill with the median because the selected column has no "
            "present numeric values.')"
        ),
        "    offset = (count - 1) // 2",
        "    length = 2 if count % 2 == 0 else 1",
        "    middle_query = frame.select(ordered.slice(offset, length).alias('__ow_fill_middle'))",
        (
            "    middle_frame = middle_query.collect(engine='streaming') "
            "if isinstance(middle_query, pl.LazyFrame) else middle_query"
        ),
        "    values = middle_frame.to_series().to_list()",
        "    if len(values) != length:",
        "        raise ValueError('Polars could not retrieve the exact middle values for the median fill.')",
        "    return values[0], values[-1]",
        "",
        "",
        "def _ow_polars_fill_missing_from_columns(frame, target, fallbacks):",
        "    schema = frame.collect_schema() if isinstance(frame, pl.LazyFrame) else frame.schema",
        "    target_dtype = schema[target]",
        "    output_dtype = target_dtype",
        (
            "    if target_dtype.base_type() == pl.Enum and "
            "any(schema[fallback] != target_dtype for fallback in fallbacks):"
        ),
        "        probe_target = pl.col(target)",
        "        probe_remaining = probe_target.is_null()",
        "        probe_widening = pl.lit(False)",
        "        for fallback in fallbacks:",
        "            probe_candidate = pl.col(fallback)",
        "            if schema[fallback].is_float():",
        "                probe_candidate = probe_candidate.fill_nan(None)",
        "            probe_available = probe_candidate.is_not_null()",
        "            probe_selected = probe_remaining & probe_available",
        "            if schema[fallback] != target_dtype:",
        "                probe_widening = probe_widening | (",
        ("                    probe_selected & probe_candidate.cast(target_dtype, strict=False).is_null()"),
        "                )",
        "            probe_remaining = probe_remaining & ~probe_available",
        "        probe_query = frame.select(probe_widening.any().alias('__ow_fill_enum_widens'))",
        "        probe_result = (",
        "            probe_query.collect(engine='streaming') if isinstance(probe_query, pl.LazyFrame) else probe_query",
        "        )",
        "        if probe_result.item():",
        "            output_dtype = pl.String",
        "    target_value = pl.col(target)",
        "    target_missing = target_value.is_null()",
        "    if target_dtype.is_float():",
        "        target_missing = target_missing | target_value.is_nan()",
        "    remaining = target_missing",
        "    candidates = []",
        "    for fallback in fallbacks:",
        "        fallback_dtype = schema[fallback]",
        "        if target_dtype == pl.Float32 and fallback_dtype == pl.Float64:",
        (
            "            raise ValueError(f'Fallback column {fallback!r} cannot be represented exactly as "
            "Float32. Convert the target column to Float64 first.')"
        ),
        "        if target_dtype.base_type() in {pl.Decimal, pl.Datetime} and fallback_dtype != target_dtype:",
        (
            "            raise ValueError(f'Fallback column {fallback!r} has Polars type {fallback_dtype}, "
            "not {target_dtype}. Convert the columns to one exact type before filling.')"
        ),
        "        candidate = pl.col(fallback)",
        "        if fallback_dtype.is_float():",
        "            candidate = candidate.fill_nan(None)",
        "        available = candidate.is_not_null()",
        "        selected = pl.when(remaining & available).then(candidate).otherwise(None)",
        "        candidates.append(selected.cast(output_dtype, strict=True))",
        "        remaining = remaining & ~available",
        "    fallback_value = pl.coalesce(candidates)",
        "    output_target = (",
        "        target_value.cast(output_dtype, strict=True) if output_dtype != target_dtype else target_value",
        "    )",
        (
            "    result = pl.when(target_missing & fallback_value.is_not_null()).then(fallback_value)"
            ".otherwise(output_target)"
        ),
        "    return frame.with_columns(result.alias(target))",
        "",
        "",
        "def _ow_polars_fill_missing_directional(frame, target, order_rules, direction, max_gap):",
        "    schema = frame.collect_schema() if isinstance(frame, pl.LazyFrame) else frame.schema",
        "    reserved = set(schema.names())",
        "    def unique(base):",
        "        candidate_name = base",
        "        while candidate_name in reserved:",
        "            candidate_name += '_'",
        "        reserved.add(candidate_name)",
        "        return candidate_name",
        "    position_name = unique('__ow_directional_position')",
        "    missing_name = unique('__ow_directional_missing')",
        "    run_name = unique('__ow_directional_run')",
        "    gap_name = unique('__ow_directional_gap')",
        "    candidate_name = unique('__ow_directional_candidate')",
        "    target_value = pl.col(target)",
        "    target_missing = target_value.is_null()",
        "    candidate = target_value",
        "    if schema[target].is_float():",
        "        target_missing = target_missing | target_value.is_nan()",
        "        candidate = candidate.fill_nan(None)",
        "    order_expressions = []",
        "    for rule in order_rules:",
        "        expression = pl.col(rule['column'])",
        "        if schema[rule['column']].is_float():",
        "            expression = expression.fill_nan(None)",
        "        order_expressions.append(expression)",
        "    ordered = frame.with_row_index(position_name).sort(",
        "        order_expressions,",
        "        descending=[rule['direction'] == 'desc' for rule in order_rules],",
        "        nulls_last=[rule['nulls'] == 'last' for rule in order_rules],",
        "        maintain_order=True,",
        "    )",
        "    ordered = ordered.with_columns(target_missing.alias(missing_name))",
        "    ordered = ordered.with_columns(",
        ("        (pl.col(missing_name) != pl.col(missing_name).shift(1).fill_null(False)).cum_sum().alias(run_name)"),
        "    )",
        "    ordered = ordered.with_columns(",
        "        pl.when(pl.col(missing_name)).then(pl.len().over(run_name)).otherwise(0).alias(gap_name),",
        "        (candidate.forward_fill() if direction == 'forward' else candidate.backward_fill()).alias(",
        "            candidate_name",
        "        ),",
        "    )",
        "    eligible = pl.col(missing_name) & pl.col(candidate_name).is_not_null()",
        "    if max_gap is not None:",
        "        eligible = eligible & (pl.col(gap_name) <= max_gap)",
        "    result = pl.when(eligible).then(pl.col(candidate_name)).otherwise(target_value)",
        "    return (",
        "        ordered.with_columns(result.alias(target))",
        "        .sort(position_name)",
        "        .drop(position_name, missing_name, run_name, gap_name, candidate_name)",
        "    )",
        "",
        "",
        "def _ow_polars_fill_missing_grouped_statistic(frame, target, keys, statistic):",
        "    schema = frame.collect_schema() if isinstance(frame, pl.LazyFrame) else frame.schema",
        "    target_dtype = schema[target]",
        "    object_columns = [column for column in [target, *keys] if schema[column] == pl.Object]",
        "    if object_columns:",
        (
            "        raise ValueError('Grouped fills require native scalar Polars columns; Object columns are "
            "not supported: ' + ', '.join(object_columns))"
        ),
        "    target_value = pl.col(target)",
        "    if target_dtype.is_float():",
        "        target_value = target_value.fill_nan(None)",
        "    reserved = set(schema.names())",
        "    def unique(base):",
        "        candidate = base",
        "        while candidate in reserved:",
        "            candidate += '_'",
        "        reserved.add(candidate)",
        "        return candidate",
        "    normalized_keys = []",
        "    key_expressions = []",
        "    for index, key in enumerate(keys):",
        "        name = unique(f'__ow_grouped_key_{index}')",
        "        expression = pl.col(key)",
        "        if schema[key].is_float():",
        "            expression = expression.fill_nan(None)",
        "        normalized_keys.append(name)",
        "        key_expressions.append(expression.alias(name))",
        "    fill_name = unique('__ow_grouped_fill')",
        "    normalized = frame.with_columns(key_expressions)",
        "    if statistic == 'mean':",
        "        positive_name = unique('__ow_grouped_positive')",
        "        negative_name = unique('__ow_grouped_negative')",
        "        scale_name = unique('__ow_grouped_scale')",
        "        scaled_name = unique('__ow_grouped_scaled')",
        "        stats = normalized.group_by(normalized_keys, maintain_order=True).agg(",
        "            (target_value == float('inf')).any().alias(positive_name),",
        "            (target_value == float('-inf')).any().alias(negative_name),",
        "            target_value.filter(target_value.is_finite()).abs().max().alias(scale_name),",
        "        )",
        (
            "        annotated = normalized.join(stats, on=normalized_keys, how='left', "
            "nulls_equal=True, maintain_order='left')"
        ),
        "        summary = annotated.group_by(normalized_keys, maintain_order=True).agg(",
        "            pl.col(positive_name).first(),",
        "            pl.col(negative_name).first(),",
        "            pl.col(scale_name).first(),",
        "            (target_value / pl.col(scale_name))",
        "            .filter(target_value.is_finite())",
        "            .mean()",
        "            .alias(scaled_name),",
        "        )",
        "        fill = (",
        "            pl.when(pl.col(positive_name) & pl.col(negative_name))",
        "            .then(None)",
        "            .when(pl.col(positive_name))",
        "            .then(float('inf'))",
        "            .when(pl.col(negative_name))",
        "            .then(float('-inf'))",
        "            .when(pl.col(scale_name).is_null())",
        "            .then(None)",
        "            .when(pl.col(scale_name) == 0)",
        "            .then(0.0)",
        "            .otherwise(pl.col(scaled_name).clip(-1.0, 1.0) * pl.col(scale_name))",
        "            .cast(target_dtype, strict=True)",
        "            .alias(fill_name)",
        "        )",
        "        summary = summary.select(*normalized_keys, fill)",
        "    elif statistic == 'mostFrequent':",
        "        count_name = unique('__ow_grouped_count')",
        "        maximum_name = unique('__ow_grouped_maximum')",
        "        ties_name = unique('__ow_grouped_ties')",
        "        counts = (",
        "            normalized.filter(target_value.is_not_null())",
        "            .group_by([*normalized_keys, target], maintain_order=True)",
        "            .len(name=count_name)",
        "        )",
        "        winners = counts.with_columns(",
        "            pl.col(count_name).max().over(normalized_keys).alias(maximum_name)",
        "        ).filter(pl.col(count_name) == pl.col(maximum_name))",
        "        summary = winners.group_by(normalized_keys, maintain_order=True).agg(",
        "            pl.col(target).first().alias(fill_name),",
        "            pl.len().alias(ties_name),",
        "        )",
        "        summary = summary.with_columns(",
        "            pl.when(pl.col(ties_name) == 1)",
        "            .then(pl.col(fill_name))",
        "            .otherwise(None)",
        "            .cast(target_dtype, strict=True)",
        "            .alias(fill_name)",
        "        ).drop(ties_name)",
        "    elif target_dtype.is_float():",
        "        lower_name = unique('__ow_grouped_lower')",
        "        upper_name = unique('__ow_grouped_upper')",
        "        summary = normalized.group_by(normalized_keys, maintain_order=True).agg(",
        "            target_value.quantile(0.5, interpolation='lower').alias(lower_name),",
        "            target_value.quantile(0.5, interpolation='higher').alias(upper_name),",
        "        )",
        "        lower = pl.col(lower_name)",
        "        upper = pl.col(upper_name)",
        "        finite = lower.is_finite() & upper.is_finite()",
        "        same_sign = (lower < 0) == (upper < 0)",
        "        midpoint = (",
        "            pl.when(lower == upper)",
        "            .then(lower)",
        "            .when(finite & same_sign)",
        "            .then(lower + ((upper - lower) / 2.0))",
        "            .otherwise((lower / 2.0) + (upper / 2.0))",
        "            .fill_nan(None)",
        "            .cast(target_dtype, strict=True)",
        "            .alias(fill_name)",
        "        )",
        "        summary = summary.select(*normalized_keys, midpoint)",
        "    else:",
        "        lower_name = unique('__ow_grouped_lower')",
        "        upper_name = unique('__ow_grouped_upper')",
        "        missing_name = unique('__ow_grouped_missing')",
        "        present = target_value.drop_nulls()",
        "        summary = normalized.group_by(normalized_keys, maintain_order=True).agg(",
        ("            present.sort().get((present.len() - 1) // 2, null_on_oob=True).alias(lower_name),"),
        "            present.sort().get(present.len() // 2, null_on_oob=True).alias(upper_name),",
        "            target_value.is_null().any().alias(missing_name),",
        "        )",
        "        def calculate(item):",
        "            if not item[missing_name] or item[lower_name] is None or item[upper_name] is None:",
        "                return None",
        "            lower = item[lower_name]",
        "            upper = item[upper_name]",
        "            if target_dtype.is_integer():",
        "                total = int(lower) + int(upper)",
        "                if total % 2:",
        (
            "                    raise ValueError('The integer median is fractional. Cast the column to float "
            "or decimal before filling missing values.')"
        ),
        "                return total // 2",
        "            if isinstance(target_dtype, pl.Decimal):",
        "                left, right = Decimal(lower), Decimal(upper)",
        "                with localcontext() as context:",
        (
            "                    context.prec = max(80, target_dtype.precision + target_dtype.scale + 4, "
            "len(left.as_tuple().digits) + len(right.as_tuple().digits) + target_dtype.scale + 4)"
        ),
        "                    value = (left + right) / Decimal(2)",
        "                return _ow_decimal_at_scale(value, target_dtype.precision, target_dtype.scale)",
        "            raise ValueError('Grouped median requires an integer or decimal Polars column.')",
        "        fill = pl.struct(lower_name, upper_name, missing_name).map_elements(",
        "            calculate, return_dtype=target_dtype, skip_nulls=False",
        "        ).alias(fill_name)",
        "        summary = summary.select(*normalized_keys, fill)",
        "    mapping = summary.lazy() if isinstance(frame, pl.LazyFrame) else summary",
        (
            "    joined = normalized.join(mapping, on=normalized_keys, how='left', "
            "nulls_equal=True, maintain_order='left')"
        ),
        "    eligible = target_value.is_null() & pl.col(fill_name).is_not_null()",
        "    result = pl.when(eligible).then(pl.col(fill_name)).otherwise(pl.col(target)).alias(target)",
        "    return joined.with_columns(result).drop(*normalized_keys, fill_name)",
        "",
        "",
        "def _ow_polars_has_missing(frame, expression):",
        "    query = frame.select(expression.is_null().any().alias('__ow_fill_has_missing'))",
        ("    result = query.collect(engine='streaming') if isinstance(query, pl.LazyFrame) else query"),
        "    return bool(result.item())",
        "",
        "",
        "def _ow_polars_stable_float_mean(frame, expression):",
        "    stats_query = frame.select(",
        "        (expression == float('inf')).any().alias('__ow_fill_positive_infinity'),",
        "        (expression == float('-inf')).any().alias('__ow_fill_negative_infinity'),",
        "        expression.filter(expression.is_finite()).abs().max().alias('__ow_fill_scale'),",
        "    )",
        (
            "    stats = stats_query.collect(engine='streaming') "
            "if isinstance(stats_query, pl.LazyFrame) else stats_query"
        ),
        "    has_positive_infinity = bool(stats['__ow_fill_positive_infinity'][0])",
        "    has_negative_infinity = bool(stats['__ow_fill_negative_infinity'][0])",
        "    if has_positive_infinity and has_negative_infinity:",
        (
            "        raise ValueError('Cannot fill with the mean because positive and negative infinity "
            "make it undefined.')"
        ),
        "    if has_positive_infinity:",
        "        return float('inf')",
        "    if has_negative_infinity:",
        "        return float('-inf')",
        "    scale = stats['__ow_fill_scale'][0]",
        "    if scale is None:",
        (
            "        raise ValueError('Cannot fill with the mean because the selected column has no "
            "present numeric values.')"
        ),
        "    scale = float(scale)",
        "    if scale == 0:",
        "        return 0.0",
        "    mean_query = frame.select((expression / pl.lit(scale)).mean().alias('__ow_fill_scaled_mean'))",
        (
            "    mean_frame = mean_query.collect(engine='streaming') "
            "if isinstance(mean_query, pl.LazyFrame) else mean_query"
        ),
        "    scaled_mean = float(mean_frame.item())",
        "    return max(-1.0, min(1.0, scaled_mean)) * scale",
        "",
        "",
        "def _ow_polars_most_frequent(frame, column, expression):",
        "    reserved = {column}",
        "    count_name = '__ow_fill_count'",
        "    while count_name in reserved:",
        "        count_name += '_'",
        "    reserved.add(count_name)",
        "    maximum_name = '__ow_fill_maximum'",
        "    while maximum_name in reserved:",
        "        maximum_name += '_'",
        "    reserved.add(maximum_name)",
        "    ties_name = '__ow_fill_ties'",
        "    while ties_name in reserved:",
        "        ties_name += '_'",
        "    counts = (",
        "        frame.select(expression.alias(column))",
        "        .filter(pl.col(column).is_not_null())",
        "        .group_by(column)",
        "        .len(name=count_name)",
        "    )",
        "    winners = counts.with_columns(pl.col(count_name).max().alias(maximum_name)).filter(",
        "        pl.col(count_name) == pl.col(maximum_name)",
        "    )",
        "    query = winners.select(pl.col(column).first().alias(column), pl.len().alias(ties_name))",
        ("    result = query.collect(engine='streaming') if isinstance(query, pl.LazyFrame) else query"),
        "    tie_count = int(result[ties_name][0])",
        "    if tie_count == 0:",
        "        raise ValueError('This column has no non-missing values. Choose a specific value.')",
        "    if tie_count != 1:",
        (
            "        raise ValueError(f'This column has no single most common value: {tie_count} values are tied. "
            "Choose a specific value.')"
        ),
        "    return result[column][0]",
        "",
        "",
    ]


def _polars_valid_value(expression: Any, dtype: Any) -> Any:

    valid = expression.is_not_null()
    return valid & ~expression.is_nan() if dtype.is_float() else valid


def _polars_formula(left: Any, right: Any, operator: str) -> Any:
    if operator == "add":
        return left + right
    if operator == "subtract":
        return left - right
    if operator == "multiply":
        return left * right
    if operator == "divide":
        return left / right
    if operator == "modulo":
        return left % right
    if operator == "power":
        return left**right
    raise EngineError(f"Unsupported formula operator: {operator}")


def _polars_step_needs_checked_integer_helpers(step: Mapping[str, Any]) -> bool:
    if step.get("kind") == "groupBy":
        params = step.get("params")
        return isinstance(params, Mapping) and any(
            isinstance(aggregation, Mapping) and aggregation.get("operation") == "sum"
            for aggregation in params.get("aggregations", [])
        )
    if step.get("kind") != "byExample":
        return False
    params = step.get("params")
    return isinstance(params, Mapping) and _polars_program_needs_checked_integer_helpers(params.get("program"))


def _polars_program_column_names(value: Any) -> list[str]:
    names: list[str] = []

    def visit(node: Any) -> None:
        if isinstance(node, Mapping):
            if node.get("kind") == "column" and isinstance(node.get("column"), Mapping):
                name = node["column"].get("name")
                if isinstance(name, str) and name not in names:
                    names.append(name)
                return
            for item in node.values():
                visit(item)
        elif isinstance(node, list):
            for item in node:
                visit(item)

    visit(value)
    return names


def _polars_program_uses_uint128(program: Any, schema: Mapping[str, Any]) -> bool:
    import polars as pl

    return any(schema.get(name) == pl.UInt128 for name in _polars_program_column_names(program))


def _polars_program_needs_checked_integer_helpers(value: Any) -> bool:
    if isinstance(value, Mapping):
        if value.get("kind") == "arithmetic" and value.get("_owResultType") == "integer":
            return True
        return any(_polars_program_needs_checked_integer_helpers(item) for item in value.values())
    if isinstance(value, list):
        return any(_polars_program_needs_checked_integer_helpers(item) for item in value)
    return False


def _polars_checked_integer_sum_parts(parts: Mapping[str, Any]) -> int:
    total = sum(
        int(parts[f"_ow_limb_{index}"] or 0) * (_POLARS_INTEGER_LIMB_BASE**index)
        for index in range(_POLARS_INTEGER_LIMB_COUNT)
    )
    if not _PORTABLE_INTEGER_MIN <= total <= _PORTABLE_INTEGER_MAX:
        raise ValueError("Open Wrangler integer result exceeds the portable 38-digit envelope.")
    return total


def _polars_checked_integer_sum_result(parts: Any) -> Any:
    import polars as pl

    # Older supported Polars infers a small Python result as Int64.
    # Return a native Series so the physical callback type remains Int128.
    return pl.Series([_polars_checked_integer_sum_parts(parts.item())], dtype=pl.Int128)


def _polars_checked_integer_sum(expression: Any, dtype: Any) -> Any:
    """Build an exact, bounded-memory Polars integer sum expression.

    Polars' native Int128 accumulator wraps modulo 2**128, while Decimal(38,
    0) rejects native-wide values before opposite signs can cancel. Splitting
    each value into five base-1e9 limbs lets Polars aggregate a fixed amount of
    native state per group. A single Python finalizer combines those five
    scalars exactly; it never receives or materializes the group's rows.
    """

    import polars as pl

    native_type = pl.UInt128 if dtype == pl.UInt128 else pl.Int128
    remaining = expression if dtype == pl.UInt128 else expression.cast(pl.Int128)
    base = pl.lit(_POLARS_INTEGER_LIMB_BASE, dtype=native_type)
    limbs: list[Any] = []
    for index in range(_POLARS_INTEGER_LIMB_COUNT - 1):
        limbs.append((remaining % base).cast(pl.Int128).sum().alias(f"_ow_limb_{index}"))
        remaining = remaining // base
    limbs.append(remaining.cast(pl.Int128).sum().alias(f"_ow_limb_{_POLARS_INTEGER_LIMB_COUNT - 1}"))
    return pl.struct(limbs).map_batches(
        _polars_checked_integer_sum_result,
        return_dtype=pl.Int128,
        returns_scalar=True,
    )


def _polars_profile_sum_expression(expression: Any, dtype: Any, semantic_type: str) -> Any:
    if semantic_type == "integer":
        return _polars_checked_integer_sum(expression, dtype)
    return expression.sum()


def _polars_checked_integer_value(left: Any, right: Any, operator: str) -> int | None:
    if left is None or right is None:
        return None
    if operator == "add":
        result = int(left) + int(right)
    elif operator == "subtract":
        result = int(left) - int(right)
    elif operator == "multiply":
        result = int(left) * int(right)
    else:
        raise EngineError(f"Unsupported checked Polars integer operator: {operator}")
    if not _PORTABLE_INTEGER_MIN <= result <= _PORTABLE_INTEGER_MAX:
        raise ValueError("Open Wrangler integer result exceeds the portable 38-digit envelope.")
    return result


def _polars_checked_integer_formula_scalar(left: Any, right: Any, operator: str) -> Any:
    """Use Python integers only when a UInt128 operand cannot narrow to Int128."""

    import polars as pl

    return pl.struct(
        left.alias("_ow_left_operand"),
        right.alias("_ow_right_operand"),
    ).map_elements(
        lambda operands: _polars_checked_integer_value(
            operands["_ow_left_operand"], operands["_ow_right_operand"], operator
        ),
        return_dtype=pl.Int128,
        skip_nulls=False,
    )


def _polars_checked_integer_formula(left: Any, right: Any, operator: str) -> Any:
    import polars as pl

    integer_type = pl.Int128
    decimal_type = pl.Decimal(38, 0)
    left = left.cast(integer_type)
    right = right.cast(integer_type)
    zero = pl.lit(0, dtype=integer_type)
    maximum = pl.lit(_PORTABLE_INTEGER_MAX, dtype=integer_type)
    minimum = pl.lit(_PORTABLE_INTEGER_MIN, dtype=integer_type)
    if operator == "add":
        positive = pl.when(right > 0).then(right).otherwise(zero)
        negative = pl.when(right < 0).then(right).otherwise(zero)
        safe = ((right <= 0) | (left <= maximum - positive)) & ((right >= 0) | (left >= minimum - negative))
    elif operator == "subtract":
        positive = pl.when(right > 0).then(right).otherwise(zero)
        negative = pl.when(right < 0).then(right).otherwise(zero)
        safe = ((right >= 0) | (left <= maximum + negative)) & ((right <= 0) | (left >= minimum + positive))
    elif operator == "multiply":
        left_in_range = left.is_between(minimum, maximum)
        right_in_range = right.is_between(minimum, maximum)
        left_magnitude = left.clip(_PORTABLE_INTEGER_MIN, _PORTABLE_INTEGER_MAX).abs()
        right_magnitude = right.clip(_PORTABLE_INTEGER_MIN, _PORTABLE_INTEGER_MAX).abs()
        nonzero = right_magnitude != 0
        divisor = pl.when(nonzero).then(right_magnitude).otherwise(pl.lit(1, dtype=integer_type))
        safe = (left == 0) | (right == 0) | (left_in_range & right_in_range & (left_magnitude <= maximum // divisor))
    else:
        raise EngineError(f"Unsupported checked Polars integer operator: {operator}")
    safe = safe.fill_null(True)
    checked_left = pl.when(safe).then(left).otherwise(zero)
    checked_right = pl.when(safe).then(right).otherwise(zero)
    result = {
        "add": checked_left + checked_right,
        "subtract": checked_left - checked_right,
        "multiply": checked_left * checked_right,
    }[operator]
    return (
        pl.when(safe)
        .then(result.cast(pl.String))
        .otherwise(pl.lit("Open Wrangler integer result exceeds the portable 38-digit envelope."))
        .cast(decimal_type, strict=True)
        .cast(pl.Int128)
    )


def _polars_aggregation(aggregation: Mapping[str, Any], dtype: Any) -> Any:
    import polars as pl

    expression = pl.col(bound_column_name(aggregation["column"], "groupBy"))
    if dtype.is_float():
        expression = expression.fill_nan(None)
    operation = aggregation["operation"]
    if operation == "sum" and dtype.is_integer():
        return _polars_checked_integer_sum(expression, dtype).alias(aggregation["alias"])
    if operation == "nUnique":
        result = expression.drop_nulls().n_unique()
    elif operation == "count":
        result = expression.count()
    elif operation in {"first", "last"}:
        result = getattr(expression.drop_nulls(), operation)()
    else:
        result = getattr(expression, operation)()
    return result.alias(aggregation["alias"])


def _compile_polars_aggregation(aggregation: Mapping[str, Any], expression: str | None = None) -> str:
    operation = aggregation["operation"]
    expression = expression or f"pl.col({bound_column_name(aggregation['column'], 'groupBy')!r})"
    if operation in {"nUnique", "first", "last"}:
        expression += ".drop_nulls()"
    method = "n_unique" if operation == "nUnique" else operation
    return f"{expression}.{method}().alias({aggregation['alias']!r})"


def _bound_polars_filter_model(model: Mapping[str, Any]) -> dict[str, Any]:
    return {
        **model,
        "filters": [
            {**column_filter, "column": bound_column_name(column_filter["column"], "filterRows")}
            for column_filter in model.get("filters", [])
        ],
        "sort": [{**rule, "column": bound_column_name(rule["column"], "filterRows")} for rule in model.get("sort", [])],
    }


def _compile_polars_filter(model: Mapping[str, Any], index: int) -> list[str]:
    column_masks: list[str] = []
    prelude: list[str] = []
    for filter_index, column_filter in enumerate(model.get("filters", [])):
        column = column_filter["column"]
        expression = f"pl.col({column!r})"
        column_type = column_filter.get("type")
        dtype_variable = f"_filter_dtype_{index}_{filter_index}"
        prelude.append(
            f"    {dtype_variable} = (df.collect_schema()[{column!r}] "
            f"if isinstance(df, pl.LazyFrame) else df.schema[{column!r}])"
        )
        conditions: list[str] = []
        value_filter = column_filter.get("valueFilter")
        if value_filter and (
            value_filter.get("selectedValues") or value_filter.get("includeNulls") or value_filter.get("includeNaN")
        ):
            parts = []
            if value_filter.get("selectedValues"):
                selected = ", ".join(
                    f"_open_wrangler_view_value({value!r}, {column_type!r})" for value in value_filter["selectedValues"]
                )
                selected_variable = f"_filter_values_{index}_{filter_index}"
                prelude.append(
                    f"    {selected_variable} = pl.Series([{selected}]).cast({dtype_variable}, strict=True).implode()"
                )
                parts.append(f"{expression}.is_in({selected_variable})")
            if value_filter.get("includeNulls"):
                parts.append(f"{expression}.is_null()")
            if value_filter.get("includeNaN") and column_filter.get("type") == "float":
                parts.append(f"{expression}.is_nan()")
            if not parts:
                parts.append("pl.lit(False)")
            conditions.append("(" + " | ".join(parts) + ")")
        for predicate in column_filter.get("predicates", []):
            conditions.append(_polars_predicate_expression(expression, predicate, column_type, dtype_variable))
        if conditions:
            operator = " | " if column_filter.get("logic") == "or" else " & "
            column_masks.append("(" + operator.join(conditions) + ")")

    lines: list[str] = prelude
    if column_masks:
        operator = " | " if model.get("logic") == "or" else " & "
        lines.append(f"    _filter_expression_{index} = " + operator.join(column_masks))
        lines.append(f"    df = df.filter(_filter_expression_{index})")
    rules = model.get("sort", [])
    if rules:
        lines.extend(
            [
                f"    df = df.sort({[rule['column'] for rule in rules]!r},",
                f"        descending={[rule.get('direction', 'asc') == 'desc' for rule in rules]!r},",
                f"        nulls_last={[rule.get('nulls', 'last') == 'last' for rule in rules]!r},",
                "        maintain_order=True)",
            ]
        )
    return lines


def _polars_predicate_expression(
    expression: str,
    predicate: Mapping[str, Any],
    column_type: str | None,
    dtype_expression: str,
) -> str:
    operator = validate_view_predicate_operator(column_type, predicate.get("operator"))
    value = predicate.get("value")
    typed_value = f"_open_wrangler_view_value({value!r}, {column_type!r})"
    if operator == "isNull":
        return f"{expression}.is_null()"
    if operator == "isNotNull":
        return f"{expression}.is_not_null()"
    if operator == "isNaN":
        return f"{expression}.is_nan().fill_null(False)" if column_type == "float" else "pl.lit(False)"
    if operator == "isNotNaN":
        return f"{expression}.is_not_nan().fill_null(True)" if column_type == "float" else "pl.lit(True)"
    typed_literal = f"pl.lit({typed_value}).cast({dtype_expression}, strict=True)"
    if operator == "equals":
        result = f"({expression} == {typed_literal})"
    elif operator == "notEquals":
        result = f"({expression} != {typed_literal})"
    elif operator == "contains":
        result = (
            f"{expression}.cast(pl.String).str.replace_many(dict(zip({_ASCII_UPPER!r}, {_ASCII_LOWER!r})))"
            f".str.contains({str(value).translate(_ASCII_TO_LOWER)!r}, literal=True)"
        )
    elif operator == "startsWith":
        result = f"{expression}.cast(pl.String).str.starts_with({str(value)!r})"
    elif operator == "endsWith":
        result = f"{expression}.cast(pl.String).str.ends_with({str(value)!r})"
    elif operator in {"gt", "gte", "lt", "lte"}:
        symbol = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[operator]
        result = f"({expression} {symbol} {typed_literal})"
    else:
        second = f"_open_wrangler_view_value({predicate.get('secondValue')!r}, {column_type!r})"
        second_literal = f"pl.lit({second}).cast({dtype_expression}, strict=True)"
        result = f"(({expression} >= {typed_literal}) & ({expression} <= {second_literal}))"
    valid = f"{expression}.is_not_null()"
    if column_type == "float":
        valid = f"({valid} & {expression}.is_not_nan().fill_null(False))"
    return f"(({result}).fill_null(False) & {valid})"


def _polars_text_summary(series: Any) -> dict[str, int | float]:
    import polars as pl

    lengths = series.cast(pl.String, strict=False).str.len_chars().drop_nulls()
    if lengths.is_empty():
        return {"emptyCount": 0}
    return {
        "emptyCount": int((lengths == 0).sum()),
        "minLength": int(lengths.min()),
        "maxLength": int(lengths.max()),
        "meanLength": float(lengths.mean()),
    }


def _polars_numeric_visualization(series: Any, max_bins: int = 20) -> dict[str, Any]:
    from math import nextafter

    import polars as pl

    numeric_values = series.cast(pl.Float64, strict=False)
    finite_mask = numeric_values.is_finite().fill_null(False)
    finite_count = int(finite_mask.sum())
    if finite_count == 0:
        return {"kind": "numeric", "bins": []}
    finite_values = numeric_values if finite_count == len(numeric_values) else numeric_values.filter(finite_mask)
    bin_count = numeric_histogram_bin_count(finite_count, int(finite_values.n_unique()), max_bins)
    minimum = _maybe_float(finite_values.min())
    maximum = _maybe_float(finite_values.max())
    edges = numeric_histogram_edges(minimum, maximum, bin_count)
    if not edges:
        return {"kind": "numeric", "bins": []}
    if minimum == maximum:
        return numeric_visualization_from_bin_counts(minimum, maximum, [finite_count])

    histogram_edges = [edges[0], *[nextafter(edge, float("-inf")) for edge in edges[1:-1]], edges[-1]]
    if all(left < right for left, right in zip(histogram_edges, histogram_edges[1:], strict=False)):
        histogram = finite_values.hist(
            bins=histogram_edges,
            include_breakpoint=False,
            include_category=False,
        )
        counts = (row[0] for row in histogram.iter_rows())
    else:
        value_name = "__open_wrangler_numeric_value"
        numeric_value = pl.col(value_name)
        bucket = pl.when(numeric_value < pl.lit(edges[1])).then(pl.lit(0, dtype=pl.UInt8))
        for bin_index in range(1, bin_count - 1):
            bucket = bucket.when(numeric_value < pl.lit(edges[bin_index + 1])).then(pl.lit(bin_index, dtype=pl.UInt8))
        bucket = bucket.otherwise(pl.lit(bin_count - 1, dtype=pl.UInt8)).alias("bucket")
        grouped_counts = (
            finite_values.to_frame(value_name)
            .lazy()
            .group_by(bucket)
            .agg(pl.len().alias("count"))
            .collect(engine="streaming")
        )
        normalized_counts = [0] * bin_count
        for bin_index, count in grouped_counts.iter_rows():
            normalized_counts[int(bin_index)] = int(count)
        counts = normalized_counts
    return numeric_visualization_from_bin_counts(minimum, maximum, counts)


def _maybe_float(value: Any) -> float | None:
    try:
        result = None if value is None else float(value)
        return result if result is None or isfinite(result) else None
    except (TypeError, ValueError):
        return None
