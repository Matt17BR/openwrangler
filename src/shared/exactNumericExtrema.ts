import type { CellValue } from "./protocol.generated";
import { hasAtMostViewValueTextCodePoints } from "./viewValueLimits";

type ExactNumericType = "integer" | "decimal";

export function isExactNumericExtremumCell(value: unknown, columnType: ExactNumericType): value is CellValue {
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
    !hasAtMostViewValueTextCodePoints(cell.display)
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

export function compareExactNumericExtremumCells(
  left: CellValue,
  right: CellValue,
  columnType: ExactNumericType
): number {
  if (columnType === "integer") {
    return compareBigInts(exactIntegerValue(left), exactIntegerValue(right));
  }
  return compareExactDecimals(exactDecimalValue(left), exactDecimalValue(right));
}

function exactIntegerValue(cell: CellValue): bigint {
  const value = cell.raw;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("An exact integer extremum must be a safe integer.");
    return BigInt(value);
  }
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)$/u.test(value)) {
    throw new TypeError("An exact integer extremum must contain a canonical integer.");
  }
  return BigInt(value);
}

interface ExactDecimalValue {
  sign: -1 | 0 | 1;
  magnitude: bigint;
  digits: string;
}

function exactDecimalValue(cell: CellValue): ExactDecimalValue {
  if (typeof cell.raw !== "string") {
    throw new TypeError("An exact decimal extremum must contain a decimal string.");
  }
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/u.exec(cell.raw);
  if (!match) throw new TypeError("An exact decimal extremum must contain a canonical decimal.");

  const whole = match[2] ?? "";
  const fraction = match[3] ?? match[4] ?? "";
  const combined = whole + fraction;
  const firstNonZero = combined.search(/[1-9]/u);
  if (firstNonZero < 0) return { sign: 0, magnitude: 0n, digits: "" };

  return {
    sign: match[1] === "-" ? -1 : 1,
    magnitude: BigInt(whole.length - firstNonZero) + BigInt(match[5] ?? "0"),
    digits: combined.slice(firstNonZero).replace(/0+$/u, "")
  };
}

function compareExactDecimals(left: ExactDecimalValue, right: ExactDecimalValue): number {
  if (left.sign !== right.sign) return left.sign < right.sign ? -1 : 1;
  if (left.sign === 0) return 0;

  let comparison = compareBigInts(left.magnitude, right.magnitude);
  if (comparison === 0) {
    const length = Math.max(left.digits.length, right.digits.length);
    for (let index = 0; index < length; index += 1) {
      const leftDigit = left.digits.charCodeAt(index) || 48;
      const rightDigit = right.digits.charCodeAt(index) || 48;
      if (leftDigit !== rightDigit) {
        comparison = leftDigit < rightDigit ? -1 : 1;
        break;
      }
    }
  }
  return left.sign === 1 ? comparison : -comparison;
}

function compareBigInts(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
