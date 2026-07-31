import type { CellValue } from "./protocol.generated";
import { MAX_VIEW_VALUE_TEXT_CHARACTERS } from "./viewValueLimits";

export function isExactNumericExtremumCell(value: unknown, columnType: "integer" | "decimal"): value is CellValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const cell = value as Record<string, unknown>;
  const keys = Object.keys(cell);
  if (
    !["kind", "raw", "display", "isNull", "isNaN"].every((key) => keys.includes(key)) ||
    !keys.every((key) => ["kind", "raw", "display", "isNull", "isNaN"].includes(key)) ||
    cell.isNull !== false ||
    cell.isNaN !== false ||
    typeof cell.display !== "string" ||
    cell.display.length === 0 ||
    cell.display.length > MAX_VIEW_VALUE_TEXT_CHARACTERS
  ) {
    return false;
  }

  if (columnType === "integer") {
    if (cell.kind !== "integer") return false;
    if (typeof cell.raw === "number") {
      return Number.isSafeInteger(cell.raw) && cell.display === String(cell.raw);
    }
    if (typeof cell.raw !== "string" || !/^-?(?:0|[1-9]\d*)$/u.test(cell.raw) || cell.display !== cell.raw) {
      return false;
    }
    try {
      const integer = BigInt(cell.raw);
      return integer < BigInt(Number.MIN_SAFE_INTEGER) || integer > BigInt(Number.MAX_SAFE_INTEGER);
    } catch {
      return false;
    }
  }

  return (
    cell.kind === "decimal" &&
    typeof cell.raw === "string" &&
    cell.display === cell.raw &&
    /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/u.test(cell.raw)
  );
}
