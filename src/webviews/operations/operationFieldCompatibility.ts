import type { ColumnSchema, ColumnType } from "../../shared/protocol";

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

export function compatibleColumns(columns: ColumnSchema[], allowedTypes: ReadonlySet<ColumnType>): ColumnSchema[] {
  return columns.filter((column) => allowedTypes.has(column.type));
}

export function aggregationColumnTypes(operation: string): ReadonlySet<ColumnType> {
  if (["sum", "mean", "median"].includes(operation)) return numericColumnTypes;
  if (["min", "max"].includes(operation)) return orderedAggregationColumnTypes;
  return portableScalarColumnTypes;
}
