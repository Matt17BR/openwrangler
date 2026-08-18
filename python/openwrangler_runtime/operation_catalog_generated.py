# Generated from protocol/openwrangler.v2.schema.json. Do not edit.
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class OperationDefinition:
    kind: str
    title: str
    group: str
    required: tuple[str, ...]
    optional: tuple[str, ...] = ()


OPERATION_DEFINITIONS: tuple[OperationDefinition, ...] = (
    OperationDefinition(
        kind="sortRows",
        title="Sort rows",
        group="Rows / order",
        required=("rules",),
        optional=(),
    ),
    OperationDefinition(
        kind="filterRows",
        title="Filter rows",
        group="Rows / order",
        required=("filterModel",),
        optional=(),
    ),
    OperationDefinition(
        kind="dropMissingRows",
        title="Drop missing rows",
        group="Rows / order",
        required=(),
        optional=("columns", "how"),
    ),
    OperationDefinition(
        kind="fillMissingValues",
        title="Fill missing values",
        group="Rows / order",
        required=("column", "replacement"),
        optional=(),
    ),
    OperationDefinition(
        kind="dropDuplicates",
        title="Drop duplicates",
        group="Rows / order",
        required=(),
        optional=("columns", "keep"),
    ),
    OperationDefinition(
        kind="selectColumns",
        title="Select columns",
        group="Columns / types",
        required=("columns",),
        optional=(),
    ),
    OperationDefinition(
        kind="dropColumns",
        title="Drop columns",
        group="Columns / types",
        required=("columns",),
        optional=(),
    ),
    OperationDefinition(
        kind="renameColumn",
        title="Rename column",
        group="Columns / types",
        required=("column", "newName"),
        optional=(),
    ),
    OperationDefinition(
        kind="cloneColumn",
        title="Clone column",
        group="Columns / types",
        required=("column", "newName"),
        optional=(),
    ),
    OperationDefinition(
        kind="castColumn",
        title="Convert type",
        group="Columns / types",
        required=("column", "dtype"),
        optional=(),
    ),
    OperationDefinition(
        kind="formula",
        title="Formula column",
        group="Columns / types",
        required=("leftColumn", "operator", "newColumn"),
        optional=("rightColumn", "value"),
    ),
    OperationDefinition(
        kind="textLength",
        title="Text length",
        group="Columns / types",
        required=("column", "newColumn"),
        optional=(),
    ),
    OperationDefinition(
        kind="oneHotEncode",
        title="One-hot encode",
        group="Categorical / text",
        required=("columns",),
        optional=("prefixSeparator", "dropOriginal"),
    ),
    OperationDefinition(
        kind="multiLabelBinarize",
        title="Multi-label binarize",
        group="Categorical / text",
        required=("column", "delimiter"),
        optional=("prefix", "dropOriginal"),
    ),
    OperationDefinition(
        kind="findReplace",
        title="Find and replace",
        group="Categorical / text",
        required=("column", "find", "replacement"),
        optional=("regex", "newColumn"),
    ),
    OperationDefinition(
        kind="stripText",
        title="Strip text",
        group="Categorical / text",
        required=("column",),
        optional=("characters", "newColumn"),
    ),
    OperationDefinition(
        kind="splitText",
        title="Split text",
        group="Categorical / text",
        required=("column", "delimiter", "index", "newColumn"),
        optional=(),
    ),
    OperationDefinition(
        kind="splitTextColumns",
        title="Split text into columns",
        group="Categorical / text",
        required=("column", "delimiter", "newColumns"),
        optional=(),
    ),
    OperationDefinition(
        kind="capitalizeText",
        title="Capitalize",
        group="Categorical / text",
        required=("column",),
        optional=("newColumn",),
    ),
    OperationDefinition(
        kind="lowerText",
        title="Lowercase",
        group="Categorical / text",
        required=("column",),
        optional=("newColumn",),
    ),
    OperationDefinition(
        kind="upperText",
        title="Uppercase",
        group="Categorical / text",
        required=("column",),
        optional=("newColumn",),
    ),
    OperationDefinition(
        kind="minMaxScale",
        title="Min-max scale",
        group="Numeric / datetime",
        required=("column",),
        optional=("newColumn",),
    ),
    OperationDefinition(
        kind="roundNumber",
        title="Round",
        group="Numeric / datetime",
        required=("column",),
        optional=("decimals", "newColumn"),
    ),
    OperationDefinition(
        kind="floorNumber",
        title="Floor",
        group="Numeric / datetime",
        required=("column",),
        optional=("newColumn",),
    ),
    OperationDefinition(
        kind="ceilNumber",
        title="Ceiling",
        group="Numeric / datetime",
        required=("column",),
        optional=("newColumn",),
    ),
    OperationDefinition(
        kind="formatDatetime",
        title="Format datetime",
        group="Numeric / datetime",
        required=("column", "format"),
        optional=("newColumn",),
    ),
    OperationDefinition(
        kind="groupBy",
        title="Group and aggregate",
        group="Aggregation",
        required=("keys", "aggregations"),
        optional=(),
    ),
    OperationDefinition(
        kind="byExample",
        title="Transform by example",
        group="By example",
        required=("sourceColumns", "newColumn", "examples"),
        optional=("program", "warnings", "candidateCount"),
    ),
    OperationDefinition(
        kind="customCode",
        title="Custom code",
        group="Custom",
        required=("code",),
        optional=(),
    ),
)
