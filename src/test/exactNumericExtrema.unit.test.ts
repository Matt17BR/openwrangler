import { describe, expect, it } from "vitest";
import { compareExactNumericExtremumCells, isExactNumericExtremumCell } from "../shared/exactNumericExtrema";
import type { CellValue } from "../shared/protocol.generated";

describe("exact numeric extrema", () => {
  it("orders safe and arbitrary-precision integer cells exactly", () => {
    expect(compareExactNumericExtremumCells(integerCell(5), integerCell(5), "integer")).toBe(0);
    expect(
      compareExactNumericExtremumCells(
        integerCell("-900719925474099312345678901"),
        integerCell("900719925474099312345678902"),
        "integer"
      )
    ).toBeLessThan(0);
  });

  it("orders decimal cells without converting them to floating point", () => {
    expect(compareExactNumericExtremumCells(decimalCell("1.2300e2"), decimalCell("123"), "decimal")).toBe(0);
    expect(compareExactNumericExtremumCells(decimalCell("-1e100"), decimalCell("-9e99"), "decimal")).toBeLessThan(0);
    expect(compareExactNumericExtremumCells(decimalCell("-0e999"), decimalCell("0.000"), "decimal")).toBe(0);
  });

  it("keeps validation separate from exact ordering", () => {
    expect(isExactNumericExtremumCell(integerCell(5), "integer")).toBe(true);
    expect(isExactNumericExtremumCell(integerCell("9007199254740992"), "integer")).toBe(true);
    expect(isExactNumericExtremumCell(decimalCell("1.23e100"), "decimal")).toBe(true);
    expect(isExactNumericExtremumCell(decimalCell("Infinity"), "decimal")).toBe(false);
  });
});

function integerCell(raw: string | number): CellValue {
  return { kind: "integer", raw, display: String(raw), isNull: false, isNaN: false };
}

function decimalCell(raw: string): CellValue {
  return { kind: "decimal", raw, display: raw, isNull: false, isNaN: false };
}
