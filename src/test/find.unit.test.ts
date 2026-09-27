import { describe, expect, it } from "vitest";
import { cellMatchesFind, isFindQuery } from "../shared/find";
import type { CellValue } from "../shared/protocol";
import { isOpenWranglerRequest, isOpenWranglerResponse } from "../shared/protocolValidation";
import { capabilities, requests, responses, validateTransportSchema } from "./protocolValidation.fixtures";

const request = requests.find((candidate) => candidate.kind === "findCells")!;
const response = responses.find((candidate) => candidate.kind === "cellsFound")!;

describe("Find protocol", () => {
  it("bounds the query by code points and rejects unpaired surrogates", () => {
    expect(isFindQuery("x".repeat(1_024))).toBe(true);
    expect(isFindQuery("𐐀".repeat(1_024))).toBe(true);
    expect(isFindQuery("x".repeat(1_025))).toBe(false);
    expect(isFindQuery("")).toBe(false);
    expect(isFindQuery("\ud800")).toBe(false);
  });

  it("accepts a whole-view search and rejects malformed options, scopes, and origins", () => {
    const { columnIds: _columnIds, from: _from, includeFrom: _includeFrom, ...wholeView } = request;
    expect(isOpenWranglerRequest(wholeView)).toBe(true);
    for (const invalid of [
      { query: "" },
      { query: "x".repeat(1_025) },
      { matchCase: "yes" },
      { direction: "down" },
      { columnIds: [] },
      { columnIds: ["column:0", "column:0"] },
      { columnIds: [""] },
      { from: { row: -1, columnId: "column:0" } },
      { from: { row: 0.5, columnId: "column:0" } },
      { from: { row: 0, columnId: "column:0", ordinal: 1 } },
      { includeFrom: 1 }
    ]) {
      expect(isOpenWranglerRequest({ ...request, ...invalid }), JSON.stringify(invalid)).toBe(false);
    }
  });

  it("requires a match exactly when the count is positive and bounds its ordinal", () => {
    const { match: _match, ...noMatch } = response;
    expect(isOpenWranglerResponse({ ...noMatch, matchCount: 0 })).toBe(true);
    expect(
      validateTransportSchema({ protocolVersion: 4, requestId: "find", response: { ...noMatch, matchCount: 0 } })
    ).toBe(true);
    for (const invalid of [
      { ...noMatch, matchCount: 1 },
      { ...response, matchCount: 0 },
      { ...response, match: { row: 0, columnId: "column:0", ordinal: 0 } },
      { ...response, match: { row: 0, columnId: "column:0", ordinal: 3 } },
      { ...response, match: { row: -1, columnId: "column:0", ordinal: 1 } },
      { ...response, match: { row: 0, columnId: "column:0", ordinal: 1, extra: true } }
    ]) {
      expect(isOpenWranglerResponse(invalid), JSON.stringify(invalid)).toBe(false);
    }
  });

  it("treats a missing find capability as supported and validates an explicit one", () => {
    const initialized = responses.find((candidate) => candidate.kind === "initialized")!;
    expect(isOpenWranglerResponse({ ...initialized, capabilities: { ...capabilities, find: false } })).toBe(true);
    expect(isOpenWranglerResponse({ ...initialized, capabilities: { ...capabilities, find: "no" } })).toBe(false);
  });
});

describe("cellMatchesFind", () => {
  const options = { text: "ber", matchCase: false, wholeCell: false };

  it("folds ASCII case only and matches whole cells exactly", () => {
    expect(cellMatchesFind(text("BERLIN"), "string", options)).toBe(true);
    expect(cellMatchesFind(text("BERLIN"), "string", { ...options, matchCase: true })).toBe(false);
    expect(cellMatchesFind(text("Ébène"), "string", { ...options, text: "éb" })).toBe(false);
    expect(cellMatchesFind(text("Ébène"), "string", { ...options, text: "Éb" })).toBe(true);
    expect(cellMatchesFind(text("Bern"), "string", { ...options, text: "bern", wholeCell: true })).toBe(true);
    expect(cellMatchesFind(text("Berne"), "string", { ...options, text: "bern", wholeCell: true })).toBe(false);
  });

  it("lets a standalone T match the datetime separator without folding it into words", () => {
    const stamp = text("2024-01-02T03:04:05");
    expect(cellMatchesFind(stamp, "datetime", { ...options, text: "01-02 03" })).toBe(true);
    expect(cellMatchesFind(stamp, "datetime", { ...options, text: "01-02t03" })).toBe(true);
    expect(cellMatchesFind(stamp, "datetime", { ...options, text: "01-02t03", matchCase: true })).toBe(false);
    expect(cellMatchesFind(stamp, "string", { ...options, text: "01-02 03" })).toBe(false);
  });

  it("never matches nulls, NaN, or nested values", () => {
    expect(cellMatchesFind({ ...text("ber"), isNull: true }, "string", options)).toBe(false);
    expect(
      cellMatchesFind({ kind: "number", raw: null, display: "NaN", isNull: false, isNaN: true }, "float", {
        ...options,
        text: "nan"
      })
    ).toBe(false);
    expect(cellMatchesFind(text('["ber"]'), "list", options)).toBe(false);
    expect(cellMatchesFind(text('{"a":"ber"}'), "struct", options)).toBe(false);
  });
});

function text(value: string): CellValue {
  return { kind: "string", raw: value, display: value, isNull: false, isNaN: false };
}
