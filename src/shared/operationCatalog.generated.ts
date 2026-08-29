/* Generated from protocol/openwrangler.v2.schema.json. Do not edit. */
import type { OperationKind } from "./protocol.generated";

export type OperationGroup =
  | "Rows / order"
  | "Columns / types"
  | "Categorical / text"
  | "Numeric / datetime"
  | "Reshape"
  | "Aggregation"
  | "By example"
  | "Custom";

export interface OperationCatalogItem {
  readonly kind: OperationKind;
  readonly title: string;
  readonly description: string;
  readonly group: OperationGroup;
  readonly icon: string;
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

export const operationGroups = Object.freeze([
  "Rows / order",
  "Columns / types",
  "Categorical / text",
  "Numeric / datetime",
  "Reshape",
  "Aggregation",
  "By example",
  "Custom"
]) satisfies readonly OperationGroup[];

export const operationCatalog: readonly OperationCatalogItem[] = Object.freeze([
  Object.freeze({
    kind: "sortRows",
    title: "Sort rows",
    description: "Create a persistent multi-column ordering step.",
    group: "Rows / order",
    icon: "list-ordered",
    required: Object.freeze(["rules"]),
    optional: Object.freeze([])
  }),
  Object.freeze({
    kind: "filterRows",
    title: "Filter rows",
    description: "Commit the current viewing filters as an explicit step.",
    group: "Rows / order",
    icon: "filter",
    required: Object.freeze(["filterModel"]),
    optional: Object.freeze([])
  }),
  Object.freeze({
    kind: "dropMissingRows",
    title: "Drop missing rows",
    description: "Remove rows with missing values in selected columns.",
    group: "Rows / order",
    icon: "clear-all",
    required: Object.freeze([]),
    optional: Object.freeze(["columns", "how"])
  }),
  Object.freeze({
    kind: "fillMissingValues",
    title: "Fill missing values",
    description: "Fill missing cells using an option available for the column type.",
    group: "Rows / order",
    icon: "symbol-null",
    required: Object.freeze(["column", "replacement"]),
    optional: Object.freeze([])
  }),
  Object.freeze({
    kind: "dropDuplicates",
    title: "Drop duplicates",
    description: "Keep one row for each repeated value combination.",
    group: "Rows / order",
    icon: "copy",
    required: Object.freeze([]),
    optional: Object.freeze(["columns", "keep"])
  }),
  Object.freeze({
    kind: "selectColumns",
    title: "Select columns",
    description: "Keep selected columns in the chosen order.",
    group: "Columns / types",
    icon: "checklist",
    required: Object.freeze(["columns"]),
    optional: Object.freeze([])
  }),
  Object.freeze({
    kind: "dropColumns",
    title: "Drop columns",
    description: "Remove selected columns from the result.",
    group: "Columns / types",
    icon: "trash",
    required: Object.freeze(["columns"]),
    optional: Object.freeze([])
  }),
  Object.freeze({
    kind: "renameColumn",
    title: "Rename column",
    description: "Change a column name without touching the source.",
    group: "Columns / types",
    icon: "edit",
    required: Object.freeze(["column", "newName"]),
    optional: Object.freeze([])
  }),
  Object.freeze({
    kind: "cloneColumn",
    title: "Clone column",
    description: "Create a copy of a column under a new name.",
    group: "Columns / types",
    icon: "files",
    required: Object.freeze(["column", "newName"]),
    optional: Object.freeze([])
  }),
  Object.freeze({
    kind: "castColumn",
    title: "Convert type",
    description: "Convert values to a supported deterministic type.",
    group: "Columns / types",
    icon: "symbol-field",
    required: Object.freeze(["column", "dtype"]),
    optional: Object.freeze([])
  }),
  Object.freeze({
    kind: "formula",
    title: "Formula column",
    description: "Create a numeric column from a column and value or column.",
    group: "Columns / types",
    icon: "symbol-operator",
    required: Object.freeze(["leftColumn", "operator", "newColumn"]),
    optional: Object.freeze(["rightColumn", "value"])
  }),
  Object.freeze({
    kind: "textLength",
    title: "Text length",
    description: "Create a column containing character counts.",
    group: "Columns / types",
    icon: "symbol-numeric",
    required: Object.freeze(["column", "newColumn"]),
    optional: Object.freeze([])
  }),
  Object.freeze({
    kind: "oneHotEncode",
    title: "One-hot encode",
    description: "Expand categorical columns into indicator columns.",
    group: "Categorical / text",
    icon: "symbol-enum",
    required: Object.freeze(["columns"]),
    optional: Object.freeze(["prefixSeparator", "dropOriginal"])
  }),
  Object.freeze({
    kind: "multiLabelBinarize",
    title: "Multi-label binarize",
    description: "Expand delimiter-separated labels into indicators.",
    group: "Categorical / text",
    icon: "list-selection",
    required: Object.freeze(["column", "delimiter"]),
    optional: Object.freeze(["prefix", "dropOriginal"])
  }),
  Object.freeze({
    kind: "findReplace",
    title: "Find and replace",
    description: "Replace literal text or regular-expression matches.",
    group: "Categorical / text",
    icon: "replace-all",
    required: Object.freeze(["column", "find", "replacement"]),
    optional: Object.freeze(["regex", "newColumn"])
  }),
  Object.freeze({
    kind: "stripText",
    title: "Strip text",
    description: "Remove surrounding whitespace or selected characters.",
    group: "Categorical / text",
    icon: "whitespace",
    required: Object.freeze(["column"]),
    optional: Object.freeze(["characters", "newColumn"])
  }),
  Object.freeze({
    kind: "splitText",
    title: "Split text",
    description: "Take one indexed part of delimiter-separated text.",
    group: "Categorical / text",
    icon: "split-horizontal",
    required: Object.freeze(["column", "delimiter", "index", "newColumn"]),
    optional: Object.freeze([])
  }),
  Object.freeze({
    kind: "splitTextColumns",
    title: "Split text into columns",
    description:
      "Retain the source and atomically create 2–64 ordered columns from a literal delimiter; null and missing parts stay null, empty parts stay empty, and extra parts are ignored.",
    group: "Categorical / text",
    icon: "split-horizontal",
    required: Object.freeze(["column", "delimiter", "newColumns"]),
    optional: Object.freeze([])
  }),
  Object.freeze({
    kind: "extractRegexGroup",
    title: "Extract regex group",
    description:
      "Retain the source and extract one capture group from the first leftmost match using Open Wrangler's portable regular-expression subset.",
    group: "Categorical / text",
    icon: "regex",
    required: Object.freeze(["column", "pattern", "group", "newColumn"]),
    optional: Object.freeze([])
  }),
  Object.freeze({
    kind: "capitalizeText",
    title: "Capitalize",
    description: "Uppercase the first character and lowercase the rest.",
    group: "Categorical / text",
    icon: "case-sensitive",
    required: Object.freeze(["column"]),
    optional: Object.freeze(["newColumn"])
  }),
  Object.freeze({
    kind: "lowerText",
    title: "Lowercase",
    description: "Convert text to lowercase.",
    group: "Categorical / text",
    icon: "case-sensitive",
    required: Object.freeze(["column"]),
    optional: Object.freeze(["newColumn"])
  }),
  Object.freeze({
    kind: "upperText",
    title: "Uppercase",
    description: "Convert text to uppercase.",
    group: "Categorical / text",
    icon: "case-sensitive",
    required: Object.freeze(["column"]),
    optional: Object.freeze(["newColumn"])
  }),
  Object.freeze({
    kind: "minMaxScale",
    title: "Min-max scale",
    description: "Scale numeric values into the zero-to-one range.",
    group: "Numeric / datetime",
    icon: "graph",
    required: Object.freeze(["column"]),
    optional: Object.freeze(["newColumn"])
  }),
  Object.freeze({
    kind: "roundNumber",
    title: "Round",
    description: "Round numeric values to a selected precision.",
    group: "Numeric / datetime",
    icon: "symbol-numeric",
    required: Object.freeze(["column"]),
    optional: Object.freeze(["decimals", "newColumn"])
  }),
  Object.freeze({
    kind: "floorNumber",
    title: "Floor",
    description: "Round numeric values downward.",
    group: "Numeric / datetime",
    icon: "arrow-down",
    required: Object.freeze(["column"]),
    optional: Object.freeze(["newColumn"])
  }),
  Object.freeze({
    kind: "ceilNumber",
    title: "Ceiling",
    description: "Round numeric values upward.",
    group: "Numeric / datetime",
    icon: "arrow-up",
    required: Object.freeze(["column"]),
    optional: Object.freeze(["newColumn"])
  }),
  Object.freeze({
    kind: "formatDatetime",
    title: "Format datetime",
    description: "Format parsed dates and datetimes with strftime syntax.",
    group: "Numeric / datetime",
    icon: "calendar",
    required: Object.freeze(["column", "format"]),
    optional: Object.freeze(["newColumn"])
  }),
  Object.freeze({
    kind: "pivotLonger",
    title: "Pivot longer",
    description:
      "Replace 2–64 compatible scalar columns with one label column and one value column in deterministic selected-column-major order.",
    group: "Reshape",
    icon: "table",
    required: Object.freeze(["columns", "labelColumn", "valueColumn"]),
    optional: Object.freeze([])
  }),
  Object.freeze({
    kind: "pivotWider",
    title: "Pivot wider",
    description:
      "Turn one typed key column and one scalar value column into 2–64 explicitly declared outputs without aggregation.",
    group: "Reshape",
    icon: "table",
    required: Object.freeze(["namesFrom", "valuesFrom", "outputs"]),
    optional: Object.freeze([])
  }),
  Object.freeze({
    kind: "groupBy",
    title: "Group and aggregate",
    description: "Group by keys and calculate named aggregations.",
    group: "Aggregation",
    icon: "group-by-ref-type",
    required: Object.freeze(["keys", "aggregations"]),
    optional: Object.freeze([])
  }),
  Object.freeze({
    kind: "byExample",
    title: "Transform by example",
    description: "Synthesize the simplest deterministic program matching every example.",
    group: "By example",
    icon: "sparkle",
    required: Object.freeze(["sourceColumns", "newColumn", "examples"]),
    optional: Object.freeze(["program", "warnings", "candidateCount"])
  }),
  Object.freeze({
    kind: "customCode",
    title: "Custom code",
    description: "Run an engine-native step that assigns a dataframe to result.",
    group: "Custom",
    icon: "code",
    required: Object.freeze(["code"]),
    optional: Object.freeze([])
  })
]);

export const operationKinds = Object.freeze(operationCatalog.map(({ kind }) => kind)) as readonly OperationKind[];
