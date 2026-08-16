import { describe, expect, it } from "vitest";
import type { ColumnSchema, ColumnType } from "../shared/protocol";
import {
  aggregationColumnTypes,
  compatibleColumns,
  datetimeColumnTypes,
  numericColumnTypes,
  portableScalarColumnTypes,
  textColumnTypes
} from "../webviews/operations/operationFieldCompatibility";

const columnTypes = [
  "string",
  "integer",
  "float",
  "decimal",
  "boolean",
  "datetime",
  "date",
  "duration",
  "binary",
  "list",
  "struct",
  "unknown"
] satisfies ColumnType[];

const columns = columnTypes.map((type, position): ColumnSchema => ({
  id: `c:${type}`,
  name: type,
  position,
  rawType: type,
  type,
  nullable: true
}));

const numeric = ["integer", "float", "decimal"];
const ordered = ["string", "integer", "float", "decimal", "boolean", "datetime", "date", "duration"];
const portable = [...ordered, "binary"];

describe("operation field compatibility", () => {
  it.each([
    ["numeric", numericColumnTypes, numeric],
    ["text", textColumnTypes, ["string"]],
    ["datetime", datetimeColumnTypes, ["datetime", "date"]],
    ["portable scalar", portableScalarColumnTypes, portable]
  ] as const)("keeps the exact ordered %s column group", (_group, allowedTypes, expected) => {
    expect(compatibleColumns(columns, allowedTypes).map((column) => column.id)).toEqual(
      expected.map((type) => `c:${type}`)
    );
  });

  it.each([
    ["sum", numeric],
    ["mean", numeric],
    ["median", numeric],
    ["min", ordered],
    ["max", ordered],
    ["count", portable],
    ["nUnique", portable],
    ["first", portable],
    ["last", portable]
  ] as const)("resolves %s aggregation inputs", (operation, expected) => {
    expect(compatibleColumns(columns, aggregationColumnTypes(operation)).map((column) => column.name)).toEqual(
      expected
    );
  });
});
