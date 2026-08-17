import { describe, expect, it } from "vitest";
import type { CellValue } from "../shared/protocol";
import { isExactNumericSummaryCell, isExactNumericZeroCell } from "../shared/numericSummary";
import { isOpenWranglerResponse } from "../shared/protocolValidation";
import { summaries } from "./protocolValidation.fixtures";

const integerCell = (value: string | number): CellValue => ({
  kind: "integer",
  raw: value,
  display: String(value),
  isNull: false,
  isNaN: false
});

const decimalCell = (value: string): CellValue => ({
  kind: "decimal",
  raw: value,
  display: value,
  isNull: false,
  isNaN: false
});

function response(summary: unknown) {
  return { kind: "summary", revision: 1, viewRequestId: "summary-1", summaries: [summary] };
}

describe("numeric summary sum contracts", () => {
  it("recognizes lossless integer and scaled decimal zero cells", () => {
    expect(isExactNumericSummaryCell(integerCell("900719925474099312345"), "integer")).toBe(true);
    expect(isExactNumericZeroCell(integerCell(0), "integer")).toBe(true);
    expect(isExactNumericZeroCell(decimalCell("0.0000"), "decimal")).toBe(true);
    expect(isExactNumericZeroCell(decimalCell("0.0100"), "decimal")).toBe(false);
  });

  it("accepts finite approximate sums and matching lossless typed sums", () => {
    const summary = {
      ...summaries[0],
      numeric: {
        ...summaries[0].numeric,
        sum: 9.876543210987654e23,
        exactSum: integerCell("987654321098765432109876")
      }
    };
    expect(isOpenWranglerResponse(response(summary))).toBe(true);
    expect(
      isOpenWranglerResponse(
        response({
          ...summary,
          type: "decimal",
          rawType: "Decimal(38,4)",
          numeric: { sum: 3.5, exactSum: decimalCell("3.5000") }
        })
      )
    ).toBe(true);
  });

  it("requires normalized zero for an empty numeric domain and rejects malformed exact sums", () => {
    const empty = { ...summaries[0], totalCount: 2, nullCount: 2, distinctCount: 0, topValues: [] };
    expect(isOpenWranglerResponse(response({ ...empty, numeric: { sum: 0, exactSum: integerCell(0) } }))).toBe(true);
    expect(isOpenWranglerResponse(response({ ...empty, numeric: {} }))).toBe(false);
    const { numeric: _numeric, ...emptyWithoutNumeric } = empty;
    expect(isOpenWranglerResponse(response(emptyWithoutNumeric))).toBe(false);
    expect(isOpenWranglerResponse(response({ ...empty, numeric: { sum: 1, exactSum: integerCell(1) } }))).toBe(false);
    expect(isOpenWranglerResponse(response({ ...summaries[0], numeric: { exactSum: decimalCell("1.0") } }))).toBe(
      false
    );
    expect(isOpenWranglerResponse(response({ ...summaries[0], numeric: { sum: Number.POSITIVE_INFINITY } }))).toBe(
      false
    );
  });

  it("permits an unavailable sum when the included domain is non-finite", () => {
    expect(isOpenWranglerResponse(response({ ...summaries[0], numeric: {} }))).toBe(true);
  });
});
