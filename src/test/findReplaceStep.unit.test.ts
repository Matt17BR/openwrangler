import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findCouldMatch, replaceMatchesIsPortable } from "../shared/find";
import type { ColumnSchema, ColumnType } from "../shared/protocol";
import { findReplaceStep, type FindReplaceStepRequest } from "../webviews/grid/findReplaceStep";

const portability = JSON.parse(readFileSync(resolve("fixtures", "replace-portability-contract.json"), "utf8")) as {
  cases: { type: ColumnType; find: string; matchCase: boolean; wholeCell: boolean; portable: boolean }[];
};

const schema: ColumnSchema[] = [
  column("c:text", "text", "string"),
  column("c:units", "units", "integer"),
  column("c:price", "price", "float"),
  column("c:flag", "flag", "boolean"),
  column("c:day", "day", "date"),
  column("c:seen", "seen", "datetime"),
  column("c:tags", "tags", "list"),
  column("c:spent", "spent", "duration")
];

describe("Replace portability", () => {
  it.each(portability.cases)(
    "$type '$find' is portable: $portable",
    ({ type, find, matchCase, wholeCell, portable }) => {
      expect(replaceMatchesIsPortable(type, { text: find, matchCase, wholeCell })).toBe(portable);
    }
  );
});

describe("findCouldMatch", () => {
  it("skips columns whose displayed values can't contain the text, like the runtimes", () => {
    expect(findCouldMatch("integer", "-12")).toBe(true);
    expect(findCouldMatch("integer", "1.5")).toBe(false);
    expect(findCouldMatch("float", "-Infinity")).toBe(true);
    expect(findCouldMatch("float", "NaN")).toBe(false);
    expect(findCouldMatch("boolean", "TRUE")).toBe(true);
    expect(findCouldMatch("boolean", "yes")).toBe(false);
    expect(findCouldMatch("datetime", "2024-01-31 10:30")).toBe(true);
    expect(findCouldMatch("date", "Jan")).toBe(false);
    expect(findCouldMatch("decimal", "anything")).toBe(true);
    expect(findCouldMatch("list", "a")).toBe(false);
    expect(findCouldMatch("struct", "a")).toBe(false);
  });
});

describe("findReplaceStep", () => {
  const request = (patch: Partial<FindReplaceStepRequest>): FindReplaceStepRequest => ({
    id: "replace-1",
    schema,
    backend: "polars",
    options: { text: "1", matchCase: false, wholeCell: false },
    replacement: "2",
    scope: undefined,
    ...patch
  });

  it("replaces in every column that can contain the text, pinned to the session's language when displays differ", () => {
    expect(findReplaceStep(request({}))).toEqual({
      step: {
        id: "replace-1",
        kind: "replaceMatches",
        params: {
          columns: [
            { id: "c:text", name: "text" },
            { id: "c:units", name: "units" },
            { id: "c:price", name: "price" },
            { id: "c:day", name: "day" },
            { id: "c:seen", name: "seen" }
          ],
          find: "1",
          replacement: "2",
          matchCase: false,
          wholeCell: false,
          spelling: "python"
        }
      }
    });
    expect(findReplaceStep(request({ backend: "r" }))).toMatchObject({ step: { params: { spelling: "r" } } });
    expect(findReplaceStep(request({ options: { text: "x", matchCase: false, wholeCell: false } }))).toMatchObject({
      step: { params: { columns: [{ id: "c:text", name: "text" }], spelling: "portable" } }
    });
  });

  it("keeps a scoped or single-cell Replace to its column", () => {
    expect(findReplaceStep(request({ scope: "c:units" }))).toMatchObject({
      step: { params: { columns: [{ id: "c:units", name: "units" }], spelling: "portable" } }
    });
    const single = findReplaceStep(request({ scope: undefined, cell: { columnId: "c:price", position: 41 } }));
    expect(single).toMatchObject({ step: { params: { columns: [{ id: "c:price", name: "price" }], row: 41 } } });
  });

  it("explains columns Replace can't write to", () => {
    expect(
      findReplaceStep(request({ options: { text: "[", matchCase: false, wholeCell: false }, schema: schema.slice(1) }))
    ).toEqual({
      error: "No column can contain the search text."
    });
    expect(findReplaceStep(request({ scope: "c:gone" }))).toEqual({
      error: "The column to replace in is no longer available."
    });
    expect(findReplaceStep(request({ scope: "c:spent" }))).toEqual({
      error: "Replace can't write text back into duration column 'spent'."
    });
  });
});

function column(id: string, name: string, type: ColumnType): ColumnSchema {
  return { id, name, position: 0, rawType: type, type, nullable: false };
}
