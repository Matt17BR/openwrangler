import type { CellValue } from "./protocol.generated";
import { compareExactNumericExtremumCells, isExactNumericExtremumCell } from "./exactNumericExtrema";

export type ExactNumericSummaryType = "integer" | "decimal";

const EXACT_INTEGER_ZERO: CellValue = {
  kind: "integer",
  raw: 0,
  display: "0",
  isNull: false,
  isNaN: false
};

const EXACT_DECIMAL_ZERO: CellValue = {
  kind: "decimal",
  raw: "0",
  display: "0",
  isNull: false,
  isNaN: false
};

export function isExactNumericSummaryCell(value: unknown, columnType: ExactNumericSummaryType): value is CellValue {
  return isExactNumericExtremumCell(value, columnType);
}

export function isExactNumericZeroCell(value: CellValue, columnType: ExactNumericSummaryType): boolean {
  const zero = columnType === "integer" ? EXACT_INTEGER_ZERO : EXACT_DECIMAL_ZERO;
  return compareExactNumericExtremumCells(value, zero, columnType) === 0;
}
