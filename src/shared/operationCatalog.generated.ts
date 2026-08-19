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

export const operationCatalog = Object.freeze([
  {
    kind: "sortRows",
    title: "Sort rows",
    description: "Create a persistent multi-column ordering step.",
    group: "Rows / order",
    icon: "list-ordered"
  },
  {
    kind: "filterRows",
    title: "Filter rows",
    description: "Commit the current viewing filters as an explicit step.",
    group: "Rows / order",
    icon: "filter"
  },
  {
    kind: "dropMissingRows",
    title: "Drop missing rows",
    description: "Remove rows with missing values in selected columns.",
    group: "Rows / order",
    icon: "clear-all"
  },
  {
    kind: "fillMissingValues",
    title: "Fill missing values",
    description: "Fill missing cells using an option available for the column type.",
    group: "Rows / order",
    icon: "symbol-null"
  },
  {
    kind: "dropDuplicates",
    title: "Drop duplicates",
    description: "Keep one row for each repeated value combination.",
    group: "Rows / order",
    icon: "copy"
  },
  {
    kind: "selectColumns",
    title: "Select columns",
    description: "Keep selected columns in the chosen order.",
    group: "Columns / types",
    icon: "checklist"
  },
  {
    kind: "dropColumns",
    title: "Drop columns",
    description: "Remove selected columns from the result.",
    group: "Columns / types",
    icon: "trash"
  },
  {
    kind: "renameColumn",
    title: "Rename column",
    description: "Change a column name without touching the source.",
    group: "Columns / types",
    icon: "edit"
  },
  {
    kind: "cloneColumn",
    title: "Clone column",
    description: "Create a copy of a column under a new name.",
    group: "Columns / types",
    icon: "files"
  },
  {
    kind: "castColumn",
    title: "Convert type",
    description: "Convert values to a supported deterministic type.",
    group: "Columns / types",
    icon: "symbol-field"
  },
  {
    kind: "formula",
    title: "Formula column",
    description: "Create a numeric column from a column and value or column.",
    group: "Columns / types",
    icon: "symbol-operator"
  },
  {
    kind: "textLength",
    title: "Text length",
    description: "Create a column containing character counts.",
    group: "Columns / types",
    icon: "symbol-numeric"
  },
  {
    kind: "oneHotEncode",
    title: "One-hot encode",
    description: "Expand categorical columns into indicator columns.",
    group: "Categorical / text",
    icon: "symbol-enum"
  },
  {
    kind: "multiLabelBinarize",
    title: "Multi-label binarize",
    description: "Expand delimiter-separated labels into indicators.",
    group: "Categorical / text",
    icon: "list-selection"
  },
  {
    kind: "findReplace",
    title: "Find and replace",
    description: "Replace literal text or regular-expression matches.",
    group: "Categorical / text",
    icon: "replace-all"
  },
  {
    kind: "stripText",
    title: "Strip text",
    description: "Remove surrounding whitespace or selected characters.",
    group: "Categorical / text",
    icon: "whitespace"
  },
  {
    kind: "splitText",
    title: "Split text",
    description: "Take one indexed part of delimiter-separated text.",
    group: "Categorical / text",
    icon: "split-horizontal"
  },
  {
    kind: "splitTextColumns",
    title: "Split text into columns",
    description:
      "Retain the source and atomically create 2–64 ordered columns from a literal delimiter; null and missing parts stay null, empty parts stay empty, and extra parts are ignored.",
    group: "Categorical / text",
    icon: "split-horizontal"
  },
  {
    kind: "extractRegexGroup",
    title: "Extract regex group",
    description:
      "Retain the source and extract one capture group from the first leftmost match using Open Wrangler's portable regular-expression subset.",
    group: "Categorical / text",
    icon: "regex"
  },
  {
    kind: "capitalizeText",
    title: "Capitalize",
    description: "Uppercase the first character and lowercase the rest.",
    group: "Categorical / text",
    icon: "case-sensitive"
  },
  {
    kind: "lowerText",
    title: "Lowercase",
    description: "Convert text to lowercase.",
    group: "Categorical / text",
    icon: "case-sensitive"
  },
  {
    kind: "upperText",
    title: "Uppercase",
    description: "Convert text to uppercase.",
    group: "Categorical / text",
    icon: "case-sensitive"
  },
  {
    kind: "minMaxScale",
    title: "Min-max scale",
    description: "Scale numeric values into the zero-to-one range.",
    group: "Numeric / datetime",
    icon: "graph"
  },
  {
    kind: "roundNumber",
    title: "Round",
    description: "Round numeric values to a selected precision.",
    group: "Numeric / datetime",
    icon: "symbol-numeric"
  },
  {
    kind: "floorNumber",
    title: "Floor",
    description: "Round numeric values downward.",
    group: "Numeric / datetime",
    icon: "arrow-down"
  },
  {
    kind: "ceilNumber",
    title: "Ceiling",
    description: "Round numeric values upward.",
    group: "Numeric / datetime",
    icon: "arrow-up"
  },
  {
    kind: "formatDatetime",
    title: "Format datetime",
    description: "Format parsed dates and datetimes with strftime syntax.",
    group: "Numeric / datetime",
    icon: "calendar"
  },
  {
    kind: "pivotLonger",
    title: "Pivot longer",
    description:
      "Replace 2–64 compatible scalar columns with one label column and one value column in deterministic selected-column-major order.",
    group: "Reshape",
    icon: "table"
  },
  {
    kind: "groupBy",
    title: "Group and aggregate",
    description: "Group by keys and calculate named aggregations.",
    group: "Aggregation",
    icon: "group-by-ref-type"
  },
  {
    kind: "byExample",
    title: "Transform by example",
    description: "Synthesize the simplest deterministic program matching every example.",
    group: "By example",
    icon: "sparkle"
  },
  {
    kind: "customCode",
    title: "Custom code",
    description: "Run an engine-native step that assigns a dataframe to result.",
    group: "Custom",
    icon: "code"
  }
]) satisfies readonly OperationCatalogItem[];

export const operationKinds = Object.freeze(operationCatalog.map(({ kind }) => kind)) as readonly OperationKind[];
