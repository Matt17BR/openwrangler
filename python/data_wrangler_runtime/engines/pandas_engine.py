from __future__ import annotations

from collections.abc import Iterable, Mapping
from math import isfinite
from pathlib import Path
from typing import Any

from .base import (
    DataFrameEngine,
    EngineError,
    boolean_visualization,
    categorical_visualization,
    datetime_visualization,
    infer_semantic_type,
    normalize_cell,
    numeric_visualization,
)


class PandasEngine(DataFrameEngine):
    name = "pandas"

    def detect(self, value: Any) -> bool:
        try:
            import pandas as pd
        except ImportError:
            return False
        return isinstance(value, (pd.DataFrame, pd.Series))

    def read_file(self, path: str, options: Mapping[str, Any] | None = None) -> Any:
        import pandas as pd

        options = options or {}
        extension = Path(path).suffix.lower()
        if extension in {".csv", ".tsv"}:
            return pd.read_csv(
                path,
                sep=options.get("delimiter", "\t" if extension == ".tsv" else ","),
                encoding=options.get("encoding", "utf-8"),
                quotechar=options.get("quoteChar", '"'),
                header=0 if options.get("hasHeader", True) else None,
            )
        if extension == ".parquet":
            return pd.read_parquet(path)
        if extension == ".jsonl":
            return pd.read_json(path, lines=True)
        if extension in {".xlsx", ".xls"}:
            return pd.read_excel(path, sheet_name=options.get("sheet", 0))
        raise EngineError(f"Unsupported file extension for Pandas backend: {extension}")

    def normalize(self, value: Any) -> Any:
        import pandas as pd

        if isinstance(value, pd.Series):
            return value.to_frame()
        return value

    def shape(self, frame: Any) -> dict[str, int]:
        df = self.normalize(frame)
        return {"rows": int(df.shape[0]), "columns": int(df.shape[1])}

    def schema(self, frame: Any) -> list[dict[str, Any]]:
        df = self.normalize(frame)
        return [
            {
                "id": f"c:{position}",
                "name": str(column),
                "position": position,
                "rawType": str(dtype),
                "type": infer_semantic_type(str(dtype)),
                "nullable": bool(df.iloc[:, position].isna().any()),
            }
            for position, (column, dtype) in enumerate(df.dtypes.items())
        ]

    def apply_filter_model(self, frame: Any, model: Mapping[str, Any]) -> Any:
        df = self.normalize(frame)
        column_masks = []
        for column_filter in model.get("filters", []):
            column = column_filter.get("column")
            if column not in df.columns:
                continue
            conditions = []
            value_filter = column_filter.get("valueFilter")
            if value_filter and (
                value_filter.get("selectedValues") or value_filter.get("includeNulls") or value_filter.get("includeNaN")
            ):
                selected = [str(value) for value in value_filter.get("selectedValues", [])]
                current = df[column].astype(str).isin(selected)
                if value_filter.get("includeNulls") or value_filter.get("includeNaN"):
                    current = current | df[column].isna()
                conditions.append(current)

            for predicate in column_filter.get("predicates", []):
                conditions.append(self._predicate_mask(df[column], predicate))

            if conditions:
                mask = conditions[0]
                for condition in conditions[1:]:
                    mask = mask | condition if column_filter.get("logic") == "or" else mask & condition
                column_masks.append(mask)

        filtered = df
        if column_masks:
            mask = column_masks[0]
            for column_mask in column_masks[1:]:
                mask = mask | column_mask if model.get("logic") == "or" else mask & column_mask
            filtered = df[mask]

        sort_rules = model.get("sort", [])
        if sort_rules:
            filtered = filtered.sort_values(
                by=[rule["column"] for rule in sort_rules],
                ascending=[rule.get("direction", "asc") == "asc" for rule in sort_rules],
                na_position="first" if sort_rules[0].get("nulls") == "first" else "last",
            )
        return filtered

    def page(self, frame: Any, offset: int, limit: int) -> dict[str, Any]:
        df = self.normalize(frame)
        sliced = df.iloc[offset : offset + limit]
        columns = list(df.columns)
        rows = []
        for row_number, (_, row) in enumerate(sliced.iterrows(), start=offset):
            rows.append(
                {
                    "id": f"r:{row_number}",
                    "rowNumber": row_number,
                    "values": [normalize_cell(row.iloc[position]) for position, _ in enumerate(columns)],
                }
            )
        return {
            "offset": offset,
            "limit": limit,
            "totalRows": int(df.shape[0]),
            "rows": rows,
        }

    def summaries(self, frame: Any, columns: Iterable[str] | None = None) -> list[dict[str, Any]]:
        df = self.normalize(frame)
        selected = list(columns) if columns is not None else list(df.columns)
        summaries = []
        for column in selected:
            series = df[column]
            raw_type = str(series.dtype)
            semantic_type = infer_semantic_type(raw_type)
            top_values = [
                {"value": str(index), "count": int(value)}
                for index, value in series.value_counts(dropna=True).head(10).items()
            ]
            summary: dict[str, Any] = {
                "column": str(column),
                "type": semantic_type,
                "rawType": raw_type,
                "totalCount": int(len(series)),
                "nullCount": int(series.isna().sum()),
                "nanCount": int(series.isna().sum()) if raw_type.startswith("float") else 0,
                "distinctCount": int(series.nunique(dropna=True)),
                "topValues": top_values,
            }
            if semantic_type in {"integer", "float"}:
                numeric = series.dropna()
                summary["numeric"] = {
                    "min": _maybe_float(numeric.min()),
                    "max": _maybe_float(numeric.max()),
                    "mean": _maybe_float(numeric.mean()),
                    "median": _maybe_float(numeric.median()),
                    "std": _maybe_float(numeric.std()),
                }
                summary["visualization"] = numeric_visualization(numeric.tolist())
            elif semantic_type == "boolean":
                summary["visualization"] = boolean_visualization(series.dropna().tolist())
            elif semantic_type in {"datetime", "date"}:
                values = series.dropna()
                summary["visualization"] = datetime_visualization(
                    values.min() if not values.empty else None,
                    values.max() if not values.empty else None,
                )
            else:
                summary["visualization"] = categorical_visualization(top_values, int(series.notna().sum()))
            summaries.append(summary)
        return summaries

    def header_stats(self, frame: Any) -> dict[str, Any]:
        df = self.normalize(frame)
        missing_by_column = []
        for column in df.columns:
            missing_by_column.append({"column": str(column), "count": int(df[column].isna().sum())})
        return {
            "missingCells": int(df.isna().sum().sum()),
            "missingRows": int(df.isna().any(axis=1).sum()),
            "duplicateRows": int(df.duplicated().sum()),
            "missingValuesByColumn": missing_by_column,
        }

    def column_values(
        self, frame: Any, column: str, search: str | None = None, limit: int = 100
    ) -> tuple[list[dict[str, Any]], bool]:
        df = self.normalize(frame)
        series = df[column].dropna()
        if search:
            series = series[series.astype(str).str.contains(search, case=False, na=False)]
        counts = series.value_counts().head(limit + 1)
        values = [{"value": str(index), "count": int(value)} for index, value in counts.head(limit).items()]
        return values, len(counts) > limit

    def _predicate_mask(self, series: Any, predicate: Mapping[str, Any]) -> Any:
        operator = predicate.get("operator")
        value = predicate.get("value")
        if operator == "equals":
            return series == value
        if operator == "notEquals":
            return series != value
        if operator == "contains":
            return series.astype(str).str.contains(str(value), case=False, na=False)
        if operator == "startsWith":
            return series.astype(str).str.startswith(str(value), na=False)
        if operator == "endsWith":
            return series.astype(str).str.endswith(str(value), na=False)
        if operator == "gt":
            return series > value
        if operator == "gte":
            return series >= value
        if operator == "lt":
            return series < value
        if operator == "lte":
            return series <= value
        if operator == "between":
            return (series >= value) & (series <= predicate.get("secondValue"))
        if operator == "isNull":
            return series.isna()
        if operator == "isNotNull":
            return series.notna()
        if operator == "isNaN":
            return series.isna()
        if operator == "isNotNaN":
            return series.notna()
        return series.notna()


def _maybe_float(value: Any) -> float | None:
    try:
        result = None if value is None else float(value)
        return result if result is None or isfinite(result) else None
    except (TypeError, ValueError):
        return None
