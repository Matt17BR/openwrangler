import type { Aggregation, ColumnSchema, ColumnType, OperationKind } from "../../shared/protocol";

export const numericColumnTypes: ReadonlySet<ColumnType> = new Set(["integer", "float", "decimal"]);
export const textColumnTypes: ReadonlySet<ColumnType> = new Set(["string"]);
export const datetimeColumnTypes: ReadonlySet<ColumnType> = new Set(["date", "datetime"]);
export const portableScalarColumnTypes: ReadonlySet<ColumnType> = new Set([
  "string",
  "integer",
  "float",
  "decimal",
  "boolean",
  "datetime",
  "date",
  "duration",
  "binary"
]);
export const pivotLongerColumnTypes: ReadonlySet<ColumnType> = new Set([
  "string",
  "integer",
  "float",
  "decimal",
  "boolean",
  "datetime",
  "date",
  "duration"
]);

const orderedAggregationColumnTypes: ReadonlySet<ColumnType> = new Set([
  "string",
  "integer",
  "float",
  "decimal",
  "boolean",
  "datetime",
  "date",
  "duration"
]);

export type TypeRestrictedOperationKind = Extract<
  OperationKind,
  | "formula"
  | "textLength"
  | "oneHotEncode"
  | "multiLabelBinarize"
  | "findReplace"
  | "stripText"
  | "splitText"
  | "splitTextColumns"
  | "pivotLonger"
  | "extractRegexGroup"
  | "capitalizeText"
  | "lowerText"
  | "upperText"
  | "minMaxScale"
  | "roundNumber"
  | "floorNumber"
  | "ceilNumber"
  | "formatDatetime"
  | "groupBy"
  | "byExample"
>;

export type AggregationOperation = Aggregation["operation"];

const aggregationOperationOwnership = {
  sum: "sum",
  mean: "mean",
  min: "min",
  max: "max",
  median: "median",
  count: "count",
  nUnique: "nUnique",
  first: "first",
  last: "last"
} as const satisfies { [Operation in AggregationOperation]: Operation };

export const aggregationOperations: readonly AggregationOperation[] = Object.values(aggregationOperationOwnership);

export function compatibleColumns(
  columns: readonly ColumnSchema[],
  allowedTypes: ReadonlySet<ColumnType>
): ColumnSchema[] {
  return columns.filter((column) => allowedTypes.has(column.type));
}

export function operationColumnTypes(kind: TypeRestrictedOperationKind): ReadonlySet<ColumnType> {
  switch (kind) {
    case "formula":
    case "minMaxScale":
    case "roundNumber":
    case "floorNumber":
    case "ceilNumber":
      return numericColumnTypes;
    case "textLength":
    case "multiLabelBinarize":
    case "findReplace":
    case "stripText":
    case "splitText":
    case "splitTextColumns":
    case "extractRegexGroup":
    case "capitalizeText":
    case "lowerText":
    case "upperText":
      return textColumnTypes;
    case "formatDatetime":
      return datetimeColumnTypes;
    case "pivotLonger":
      return pivotLongerColumnTypes;
    case "oneHotEncode":
    case "groupBy":
    case "byExample":
      return portableScalarColumnTypes;
    default:
      return unsupportedTypeRestrictedOperation(kind);
  }
}

export function isAggregationOperation(value: string): value is AggregationOperation {
  return (aggregationOperations as readonly string[]).includes(value);
}

export function aggregationColumnTypes(operation: AggregationOperation): ReadonlySet<ColumnType> {
  switch (operation) {
    case "sum":
    case "mean":
    case "median":
      return numericColumnTypes;
    case "min":
    case "max":
      return orderedAggregationColumnTypes;
    case "count":
    case "nUnique":
    case "first":
    case "last":
      return portableScalarColumnTypes;
    default:
      return unsupportedAggregationOperation(operation);
  }
}

function unsupportedTypeRestrictedOperation(kind: never): never {
  throw new Error(`Unsupported type-restricted operation: ${String(kind)}`);
}

function unsupportedAggregationOperation(operation: never): never {
  throw new Error(`Unsupported aggregation operation: ${String(operation)}`);
}
