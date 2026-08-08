from __future__ import annotations

from collections.abc import Mapping, Sequence
from copy import deepcopy
from dataclasses import dataclass
from math import isfinite
from typing import Any

from .engines.base import VIEW_COMPARABLE_TYPES, is_internal_row_id_label

_GROUP_KEY_TYPES = {
    "string",
    "integer",
    "float",
    "decimal",
    "boolean",
    "datetime",
    "date",
    "duration",
    "binary",
}
_GROUPED_FILL_KEY_TYPES = _GROUP_KEY_TYPES - {"binary"}
_NUMERIC_AGGREGATION_TYPES = {"integer", "float", "decimal"}
_ORDERED_AGGREGATION_TYPES = {
    "string",
    "integer",
    "float",
    "decimal",
    "boolean",
    "datetime",
    "date",
    "duration",
}
_DISTINCT_AGGREGATION_TYPES = _GROUP_KEY_TYPES
# Each adapter formats floats, booleans, datetimes, decimals, durations, and
# binary values differently when coercing them to text. Strings, base-10
# integers, and ISO dates are the deliberately small portable intersection.
_BY_EXAMPLE_TEXT_INPUT_TYPES = {"string", "integer", "date", "null"}
# Decimal mixed arithmetic is not portable: Pandas object Decimal values reject
# float operands while Polars and DuckDB may promote them. Keep direct Decimal
# copies valid, but admit only native integer/float arithmetic expressions.
_BY_EXAMPLE_ARITHMETIC_INPUT_TYPES = {"integer", "float"}
_FILL_VALUE_KINDS_BY_COLUMN = {
    "string": {"string"},
    "integer": {"integer"},
    "float": {"integer", "float"},
    "decimal": {"integer", "decimal"},
    "boolean": {"boolean"},
    "date": {"date"},
    "datetime": {"datetime"},
    "unknown": {"string", "integer", "float", "decimal", "boolean", "date", "datetime"},
}
_MAX_FILL_FALLBACK_COLUMNS = 64
_MAX_DIRECTIONAL_FILL_GAP = 1_000_000
_BY_EXAMPLE_TEXT_KINDS = {
    "slice",
    "split",
    "regexExtract",
    "regexReplace",
    "case",
    "datetimeFormat",
}


class ColumnBindingError(ValueError):
    """Raised when a public column reference cannot bind to one exact input column."""


@dataclass(frozen=True, slots=True)
class _Column:
    identifier: str
    name: str
    position: int
    semantic_type: str

    def bound_reference(self) -> dict[str, str | int]:
        return {"id": self.identifier, "name": self.name, "position": self.position}


class _BindingContext:
    def __init__(
        self,
        schema: Sequence[Mapping[str, Any]],
        lineage: Sequence[Mapping[str, str]],
    ) -> None:
        if len(schema) != len(lineage):
            raise ColumnBindingError("Column binding schema and lineage lengths differ.")

        self.columns: list[_Column] = []
        self.by_id: dict[str, _Column] = {}
        for position, (schema_column, identity) in enumerate(zip(schema, lineage, strict=True)):
            if not isinstance(schema_column, Mapping) or "name" not in schema_column:
                raise ColumnBindingError(f"Column schema at position {position} has no name.")
            if not isinstance(identity, Mapping):
                raise ColumnBindingError(f"Column lineage at position {position} must be an object.")
            schema_name = str(schema_column["name"])
            semantic_type = schema_column.get("type")
            identifier = identity.get("id")
            identity_name = identity.get("name")
            if not isinstance(semantic_type, str) or not semantic_type:
                raise ColumnBindingError(f"Column schema at position {position} has an invalid semantic type.")
            if not isinstance(identifier, str) or not identifier:
                raise ColumnBindingError(f"Column lineage at position {position} has an invalid identity.")
            if not isinstance(identity_name, str):
                raise ColumnBindingError(f"Column lineage at position {position} has an invalid name.")
            if schema_name != identity_name:
                raise ColumnBindingError(
                    f"Column lineage name mismatch at position {position}: "
                    f"schema has {schema_name!r}, lineage has {identity_name!r}."
                )
            if identifier in self.by_id:
                raise ColumnBindingError(f"Duplicate column identity in the input schema: {identifier}")
            column = _Column(identifier, schema_name, position, semantic_type)
            self.columns.append(column)
            self.by_id[identifier] = column

    def bind(self, reference: Any, label: str) -> dict[str, str | int]:
        if not isinstance(reference, Mapping):
            raise ColumnBindingError(f"{label} must be a column reference.")
        fields = set(reference)
        if fields != {"id", "name"}:
            missing = {"id", "name"} - fields
            if missing:
                raise ColumnBindingError(f"{label} is missing required fields: {', '.join(sorted(missing))}.")
            unexpected = fields - {"id", "name"}
            raise ColumnBindingError(
                f"{label} contains unknown fields: {', '.join(sorted(str(field) for field in unexpected))}."
            )
        identifier = reference.get("id")
        name = reference.get("name")
        if not isinstance(identifier, str) or not identifier:
            raise ColumnBindingError(f"{label}.id must be a non-empty string.")
        if not isinstance(name, str):
            raise ColumnBindingError(f"{label}.name must be a string.")
        column = self.by_id.get(identifier)
        if column is None:
            raise ColumnBindingError(f"Unknown or stale column identity for {label}: {identifier}")
        if name != column.name:
            raise ColumnBindingError(
                f"Column reference name mismatch for {label}: identity {identifier} is {column.name!r}, not {name!r}."
            )
        return column.bound_reference()

    def bind_many(self, references: Any, label: str) -> list[dict[str, str | int]]:
        if not isinstance(references, list):
            raise ColumnBindingError(f"{label} must be an array of column references.")
        bound: list[dict[str, str | int]] = []
        seen: set[str] = set()
        for index, reference in enumerate(references):
            item = self.bind(reference, f"{label}[{index}]")
            identifier = str(item["id"])
            if identifier in seen:
                raise ColumnBindingError(f"{label} contains duplicate column identity: {identifier}")
            seen.add(identifier)
            bound.append(item)
        return bound

    def require_type(self, reference: Mapping[str, Any], semantic_type: Any, label: str) -> None:
        column = self.by_id.get(str(reference.get("id", "")))
        if column is None:
            raise ColumnBindingError(f"Unknown or stale column identity for {label}.")
        if not isinstance(semantic_type, str) or semantic_type != column.semantic_type:
            raise ColumnBindingError(
                f"Column type mismatch for {label}: identity {column.identifier} is "
                f"{column.semantic_type!r}, not {semantic_type!r}."
            )

    def require_group_key(self, reference: Mapping[str, Any], label: str) -> None:
        column = self._column_for(reference, label)
        if column.semantic_type not in _GROUP_KEY_TYPES:
            raise ColumnBindingError(
                f"{label} has unsupported {column.semantic_type!r} type; group keys must be portable scalar columns."
            )

    def require_by_example_source(self, reference: Mapping[str, Any], label: str) -> None:
        column = self._column_for(reference, label)
        if column.semantic_type not in _GROUP_KEY_TYPES:
            raise ColumnBindingError(
                f"{label} has unsupported {column.semantic_type!r} type; "
                "by-example sources must be portable scalar columns."
            )

    def by_example_type(self, reference: Mapping[str, Any], label: str) -> str:
        return self._column_for(reference, label).semantic_type

    def require_aggregation(self, reference: Mapping[str, Any], operation: Any, label: str) -> None:
        column = self._column_for(reference, label)
        allowed = (
            _NUMERIC_AGGREGATION_TYPES
            if operation in {"sum", "mean", "median"}
            else _ORDERED_AGGREGATION_TYPES
            if operation in {"min", "max"}
            else _DISTINCT_AGGREGATION_TYPES
            if operation == "nUnique"
            else _GROUP_KEY_TYPES
            if operation in {"count", "first", "last"}
            else set()
        )
        if column.semantic_type not in allowed:
            raise ColumnBindingError(
                f"{label} cannot apply {operation!r} to {column.semantic_type!r}; "
                "choose a compatible column or aggregation."
            )

    def require_fill_replacement(self, reference: Mapping[str, Any], replacement: Any, label: str) -> None:
        column = self._column_for(reference, label)
        if not isinstance(replacement, Mapping):
            raise ColumnBindingError("fillMissingValues.replacement must be an object.")
        kind = replacement.get("kind")
        if kind == "median":
            if column.semantic_type not in _NUMERIC_AGGREGATION_TYPES:
                raise ColumnBindingError(
                    f"{label} cannot use a median fill for {column.semantic_type!r}; choose a numeric column."
                )
            return
        if kind == "mean":
            if column.semantic_type != "float":
                raise ColumnBindingError(
                    f"{label} cannot use a mean fill for {column.semantic_type!r}; choose a floating-point column."
                )
            return
        if kind == "mostFrequent":
            if column.semantic_type not in {"string", "boolean"}:
                raise ColumnBindingError(
                    f"{label} cannot use the most common value for {column.semantic_type!r}; "
                    "choose a text, categorical, or boolean column."
                )
            return
        if kind == "fallbackColumns":
            fallback_columns = replacement.get("columns")
            if not isinstance(fallback_columns, list) or not fallback_columns:
                raise ColumnBindingError("fillMissingValues.replacement.columns must be a non-empty array.")
            if len(fallback_columns) > _MAX_FILL_FALLBACK_COLUMNS:
                raise ColumnBindingError(
                    f"fillMissingValues.replacement.columns may contain at most {_MAX_FILL_FALLBACK_COLUMNS} columns."
                )
            if column.semantic_type not in _FILL_VALUE_KINDS_BY_COLUMN or column.semantic_type == "unknown":
                raise ColumnBindingError(
                    f"{label} cannot use fallback columns for {column.semantic_type!r}; choose a scalar column."
                )
            for index, fallback_reference in enumerate(fallback_columns):
                fallback = self._column_for(
                    fallback_reference,
                    f"fillMissingValues.replacement.columns[{index}]",
                )
                if fallback.identifier == column.identifier:
                    raise ColumnBindingError("A fill target cannot also be one of its fallback columns.")
                if fallback.semantic_type != column.semantic_type:
                    raise ColumnBindingError(
                        "Fallback columns must have the same data type as the fill target; "
                        f"{fallback.name!r} is {fallback.semantic_type!r}, not {column.semantic_type!r}."
                    )
            return
        if kind == "directional":
            if column.semantic_type not in _GROUP_KEY_TYPES:
                raise ColumnBindingError(
                    f"{label} cannot use directional fill for {column.semantic_type!r}; choose a scalar column."
                )
            direction = replacement.get("direction")
            if direction not in {"forward", "backward"}:
                raise ColumnBindingError("A directional fill direction must be forward or backward.")
            if "maxGap" in replacement:
                max_gap = replacement.get("maxGap")
                if type(max_gap) is not int or not 1 <= max_gap <= _MAX_DIRECTIONAL_FILL_GAP:
                    raise ColumnBindingError(
                        f"A directional fill maxGap must be an integer from 1 to {_MAX_DIRECTIONAL_FILL_GAP:,}."
                    )
            order_by = replacement.get("orderBy")
            if not isinstance(order_by, list) or not order_by:
                raise ColumnBindingError("fillMissingValues.replacement.orderBy must be a non-empty array.")
            for index, rule in enumerate(order_by):
                if not isinstance(rule, Mapping):
                    raise ColumnBindingError(f"fillMissingValues.replacement.orderBy[{index}] must be an object.")
                fields = set(rule)
                if fields != {"column", "direction", "nulls"}:
                    raise ColumnBindingError(
                        f"fillMissingValues.replacement.orderBy[{index}] must contain exactly "
                        "column, direction, and nulls."
                    )
                if rule.get("direction") not in {"asc", "desc"} or rule.get("nulls") not in {"first", "last"}:
                    raise ColumnBindingError("Directional fill sort directions and null ordering are invalid.")
                order_column = self._column_for(
                    rule["column"],
                    f"fillMissingValues.replacement.orderBy[{index}].column",
                )
                if order_column.identifier == column.identifier:
                    raise ColumnBindingError("A directional fill target cannot also be one of its ordering columns.")
                if order_column.semantic_type not in VIEW_COMPARABLE_TYPES:
                    raise ColumnBindingError(
                        "Directional fill ordering requires portable comparable columns; "
                        f"{order_column.name!r} is {order_column.semantic_type!r}."
                    )
            return
        if kind == "groupedStatistic":
            statistic = replacement.get("statistic")
            allowed_targets = (
                {"float"}
                if statistic == "mean"
                else _NUMERIC_AGGREGATION_TYPES
                if statistic == "median"
                else {"string", "boolean"}
                if statistic == "mostFrequent"
                else set()
            )
            if column.semantic_type not in allowed_targets:
                raise ColumnBindingError(
                    f"{label} cannot use grouped {statistic!r} fill for {column.semantic_type!r}; "
                    "choose a compatible target column."
                )
            keys = replacement.get("keys")
            if not isinstance(keys, list) or not keys:
                raise ColumnBindingError("fillMissingValues.replacement.keys must be a non-empty array.")
            for index, key_reference in enumerate(keys):
                key = self._column_for(key_reference, f"fillMissingValues.replacement.keys[{index}]")
                if key.identifier == column.identifier:
                    raise ColumnBindingError("A grouped fill target cannot also be one of its group keys.")
                if key.semantic_type not in _GROUPED_FILL_KEY_TYPES:
                    raise ColumnBindingError(
                        f"Grouped fill keys require portable scalar columns; {key.name!r} is {key.semantic_type!r}."
                    )
            return
        allowed = _FILL_VALUE_KINDS_BY_COLUMN.get(column.semantic_type, set())
        if kind not in allowed:
            raise ColumnBindingError(
                f"{label} cannot use a {kind!r} replacement for {column.semantic_type!r}; choose a compatible value."
            )

    def _column_for(self, reference: Mapping[str, Any], label: str) -> _Column:
        column = self.by_id.get(str(reference.get("id", "")))
        if column is None:
            raise ColumnBindingError(f"Unknown or stale column identity for {label}.")
        return column

    def reject_output_collision(
        self,
        output_name: Any,
        label: str,
        *,
        replacing: Mapping[str, Any] | None = None,
    ) -> None:
        if not isinstance(output_name, str) or not output_name:
            raise ColumnBindingError(f"{label} must be a non-empty string.")
        if is_internal_row_id_label(output_name):
            raise ColumnBindingError(f"{label} uses Open Wrangler's reserved private row-identity prefix.")
        replacing_id = None if replacing is None else str(replacing["id"])
        if any(column.name == output_name and column.identifier != replacing_id for column in self.columns):
            raise ColumnBindingError(f"{label} collides with an existing column: {output_name}")


def bind_step(
    step: Mapping[str, Any],
    schema: Sequence[Mapping[str, Any]],
    lineage: Sequence[Mapping[str, str]],
) -> dict[str, Any]:
    """Bind public stable references to one exact dataframe schema.

    Only operations whose public contract uses ``ColumnReference`` are bound.
    Other operations are copied unchanged so a session can keep one parallel
    executable plan without leaking private positions into persisted metadata.
    """

    bound = deepcopy(dict(step))
    kind = str(bound.get("kind", ""))
    if kind not in {
        "selectColumns",
        "dropColumns",
        "renameColumn",
        "cloneColumn",
        "castColumn",
        "formula",
        "textLength",
        "sortRows",
        "filterRows",
        "dropMissingRows",
        "fillMissingValues",
        "dropDuplicates",
        "oneHotEncode",
        "multiLabelBinarize",
        "findReplace",
        "stripText",
        "splitText",
        "capitalizeText",
        "lowerText",
        "upperText",
        "minMaxScale",
        "roundNumber",
        "floorNumber",
        "ceilNumber",
        "formatDatetime",
        "groupBy",
        "byExample",
    }:
        return bound

    params = bound.get("params")
    if not isinstance(params, dict):
        raise ColumnBindingError(f"{kind}.params must be an object.")
    context = _BindingContext(schema, lineage)

    if kind == "sortRows":
        rules = params.get("rules")
        if not isinstance(rules, list):
            raise ColumnBindingError("sortRows.rules must be an array.")
        references = context.bind_many(_member_references(rules, "sortRows.rules"), "sortRows.rules")
        params["rules"] = [{**rule, "column": reference} for rule, reference in zip(rules, references, strict=True)]
        return bound

    if kind == "filterRows":
        model = params.get("filterModel")
        if not isinstance(model, dict):
            raise ColumnBindingError("filterRows.filterModel must be an object.")
        filters = model.get("filters")
        sort = model.get("sort")
        if not isinstance(filters, list) or not isinstance(sort, list):
            raise ColumnBindingError("filterRows.filterModel must contain filters and sort arrays.")
        filter_references = context.bind_many(
            _member_references(filters, "filterRows.filterModel.filters"),
            "filterRows.filterModel.filters",
        )
        sort_references = context.bind_many(
            _member_references(sort, "filterRows.filterModel.sort"),
            "filterRows.filterModel.sort",
        )
        for index, (column_filter, reference) in enumerate(zip(filters, filter_references, strict=True)):
            context.require_type(
                reference,
                column_filter.get("type"),
                f"filterRows.filterModel.filters[{index}].type",
            )
        model["filters"] = [
            {**column_filter, "column": reference}
            for column_filter, reference in zip(filters, filter_references, strict=True)
        ]
        model["sort"] = [{**rule, "column": reference} for rule, reference in zip(sort, sort_references, strict=True)]
        return bound

    if kind in {"dropMissingRows", "dropDuplicates"}:
        if "columns" in params:
            params["columns"] = context.bind_many(params["columns"], f"{kind}.columns")
        return bound

    if kind in {"selectColumns", "dropColumns", "oneHotEncode"}:
        params["columns"] = context.bind_many(params.get("columns"), f"{kind}.columns")
        if kind == "dropColumns" and len(params["columns"]) == len(context.columns):
            raise ColumnBindingError("dropColumns must leave at least one visible column.")
        return bound

    if kind == "groupBy":
        params["keys"] = context.bind_many(params.get("keys"), "groupBy.keys")
        for index, reference in enumerate(params["keys"]):
            context.require_group_key(reference, f"groupBy.keys[{index}]")
        aggregations = params.get("aggregations")
        if not isinstance(aggregations, list):
            raise ColumnBindingError("groupBy.aggregations must be an array.")
        bound_aggregations: list[dict[str, Any]] = []
        for index, aggregation in enumerate(aggregations):
            if not isinstance(aggregation, Mapping):
                raise ColumnBindingError(f"groupBy.aggregations[{index}] must be an object.")
            reference = context.bind(aggregation.get("column"), f"groupBy.aggregations[{index}].column")
            context.require_aggregation(
                reference,
                aggregation.get("operation"),
                f"groupBy.aggregations[{index}].column",
            )
            bound_aggregations.append({**aggregation, "column": reference})
        params["aggregations"] = bound_aggregations
        return bound

    if kind == "byExample":
        params["sourceColumns"] = context.bind_many(params.get("sourceColumns"), "byExample.sourceColumns")
        for index, reference in enumerate(params["sourceColumns"]):
            context.require_by_example_source(reference, f"byExample.sourceColumns[{index}]")
        source_ids = {str(reference["id"]) for reference in params["sourceColumns"]}
        program = params.get("program")
        if not isinstance(program, Mapping):
            raise ColumnBindingError("byExample.program must be an object after synthesis.")
        params["program"] = _bind_by_example_program(program, context, source_ids)
        context.reject_output_collision(params.get("newColumn"), "byExample.newColumn")
        return bound

    if kind in {
        "renameColumn",
        "cloneColumn",
        "castColumn",
        "fillMissingValues",
        "textLength",
        "multiLabelBinarize",
        "findReplace",
        "stripText",
        "splitText",
        "capitalizeText",
        "lowerText",
        "upperText",
        "minMaxScale",
        "roundNumber",
        "floorNumber",
        "ceilNumber",
        "formatDatetime",
    }:
        params["column"] = context.bind(params.get("column"), f"{kind}.column")

    if kind == "fillMissingValues":
        replacement = params.get("replacement")
        if isinstance(replacement, Mapping) and replacement.get("kind") == "fallbackColumns":
            replacement = dict(replacement)
            replacement["columns"] = context.bind_many(
                replacement.get("columns"),
                "fillMissingValues.replacement.columns",
            )
            params["replacement"] = replacement
        elif isinstance(replacement, Mapping) and replacement.get("kind") == "directional":
            replacement_fields = set(replacement)
            required = {"kind", "direction", "orderBy"}
            if not required.issubset(replacement_fields) or replacement_fields - {*required, "maxGap"}:
                raise ColumnBindingError(
                    "A directional fill replacement must contain kind, direction, orderBy, and optional maxGap."
                )
            order_by = replacement.get("orderBy")
            if not isinstance(order_by, list) or not order_by:
                raise ColumnBindingError("fillMissingValues.replacement.orderBy must be a non-empty array.")
            bound_order_columns = context.bind_many(
                _member_references(order_by, "fillMissingValues.replacement.orderBy"),
                "fillMissingValues.replacement.orderBy",
            )
            replacement = dict(replacement)
            replacement["orderBy"] = [
                {**rule, "column": reference} for rule, reference in zip(order_by, bound_order_columns, strict=True)
            ]
            params["replacement"] = replacement
        elif isinstance(replacement, Mapping) and replacement.get("kind") == "groupedStatistic":
            if set(replacement) != {"kind", "statistic", "keys"}:
                raise ColumnBindingError(
                    "A grouped-statistic replacement must contain exactly kind, statistic, and keys."
                )
            replacement = dict(replacement)
            replacement["keys"] = context.bind_many(
                replacement.get("keys"),
                "fillMissingValues.replacement.keys",
            )
            params["replacement"] = replacement
        context.require_fill_replacement(
            params["column"],
            params.get("replacement"),
            "fillMissingValues.column",
        )
        return bound

    if kind == "renameColumn":
        context.reject_output_collision(params.get("newName"), "renameColumn.newName", replacing=params["column"])
    elif kind == "cloneColumn":
        context.reject_output_collision(params.get("newName"), "cloneColumn.newName")
    elif kind == "formula":
        params["leftColumn"] = context.bind(params.get("leftColumn"), "formula.leftColumn")
        if "rightColumn" in params:
            params["rightColumn"] = context.bind(params.get("rightColumn"), "formula.rightColumn")
        context.reject_output_collision(params.get("newColumn"), "formula.newColumn")
    elif kind == "textLength":
        context.reject_output_collision(params.get("newColumn"), "textLength.newColumn")
    elif (
        kind
        in {
            "multiLabelBinarize",
            "findReplace",
            "stripText",
            "splitText",
            "capitalizeText",
            "lowerText",
            "upperText",
            "minMaxScale",
            "roundNumber",
            "floorNumber",
            "ceilNumber",
            "formatDatetime",
        }
        and "newColumn" in params
    ):
        context.reject_output_collision(
            params["newColumn"],
            f"{kind}.newColumn",
            replacing=params["column"],
        )

    return bound


def _member_references(items: Sequence[Any], label: str) -> list[Any]:
    references: list[Any] = []
    for index, item in enumerate(items):
        if not isinstance(item, Mapping):
            raise ColumnBindingError(f"{label}[{index}] must be an object.")
        references.append(item.get("column"))
    return references


def _bind_by_example_program(
    program: Mapping[str, Any],
    context: _BindingContext,
    source_ids: set[str],
) -> dict[str, Any]:
    result, _semantic_type = _bind_by_example_expression(program, context, source_ids, "byExample.program")
    return result


def _bind_by_example_expression(
    program: Mapping[str, Any],
    context: _BindingContext,
    source_ids: set[str],
    label: str,
) -> tuple[dict[str, Any], str]:
    result = deepcopy(dict(program))
    kind = result.get("kind")
    if kind == "column":
        reference = context.bind(result.get("column"), f"{label}.column")
        if str(reference["id"]) not in source_ids:
            raise ColumnBindingError("byExample.program references a column outside sourceColumns.")
        result["column"] = reference
        return result, context.by_example_type(reference, f"{label}.column")

    if kind == "literal":
        return result, _by_example_literal_type(result.get("value"), f"{label}.value")

    if kind in _BY_EXAMPLE_TEXT_KINDS:
        child, child_type = _bind_by_example_child(result, "input", context, source_ids, label)
        _require_by_example_type(child_type, _BY_EXAMPLE_TEXT_INPUT_TYPES, f"{label}.input", str(kind))
        result["input"] = child
        return result, "string"

    if kind == "concat":
        parts = result.get("parts")
        if not isinstance(parts, list) or not parts:
            raise ColumnBindingError(f"{label}.parts must be a non-empty array.")
        if not all(isinstance(part, Mapping) for part in parts):
            raise ColumnBindingError(f"{label}.parts must contain objects.")
        bound_parts: list[dict[str, Any]] = []
        for index, part in enumerate(parts):
            bound_part, part_type = _bind_by_example_expression(
                part,
                context,
                source_ids,
                f"{label}.parts[{index}]",
            )
            _require_by_example_type(
                part_type,
                _BY_EXAMPLE_TEXT_INPUT_TYPES - {"null"},
                f"{label}.parts[{index}]",
                "concat",
            )
            bound_parts.append(bound_part)
        result["parts"] = bound_parts
        return result, "string"

    if kind == "arithmetic":
        left, left_type = _bind_by_example_child(result, "left", context, source_ids, label)
        right, right_type = _bind_by_example_child(result, "right", context, source_ids, label)
        _require_by_example_type(
            left_type,
            _BY_EXAMPLE_ARITHMETIC_INPUT_TYPES,
            f"{label}.left",
            "arithmetic",
        )
        _require_by_example_type(
            right_type,
            _BY_EXAMPLE_ARITHMETIC_INPUT_TYPES,
            f"{label}.right",
            "arithmetic",
        )
        result["left"] = left
        result["right"] = right
        result_type = "float" if "float" in {left_type, right_type} or result.get("operator") == "divide" else "integer"
        # Execution-only metadata lets each native adapter widen integer
        # arithmetic without putting engine details or private positions in the
        # persisted public step. Public programs cannot inject these fields:
        # normalization requires an exact operation-specific shape first.
        result["_owLeftType"] = left_type
        result["_owRightType"] = right_type
        result["_owResultType"] = result_type
        return result, result_type

    raise ColumnBindingError(f"Unsupported byExample program kind at {label}: {kind!r}.")


def _bind_by_example_child(
    program: Mapping[str, Any],
    key: str,
    context: _BindingContext,
    source_ids: set[str],
    label: str,
) -> tuple[dict[str, Any], str]:
    child = program.get(key)
    if not isinstance(child, Mapping):
        raise ColumnBindingError(f"{label}.{key} must be an object.")
    return _bind_by_example_expression(child, context, source_ids, f"{label}.{key}")


def _by_example_literal_type(value: Any, label: str) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float) and isfinite(value):
        return "float"
    if isinstance(value, str):
        return "string"
    raise ColumnBindingError(f"{label} must be a finite JSON scalar value.")


def _require_by_example_type(actual: str, allowed: set[str], label: str, operation: str) -> None:
    if actual not in allowed:
        expected = ", ".join(sorted(allowed))
        raise ColumnBindingError(
            f"{label} cannot apply {operation!r} to {actual!r}; portable input types are: {expected}."
        )
