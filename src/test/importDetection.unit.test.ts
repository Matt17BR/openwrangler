import { describe, expect, it } from "vitest";
import { detectedImportOptionsFromSample, IMPORT_DETECTION_SAMPLE_BYTES } from "../extension/files/importDetection";

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("automatic delimited import detection", () => {
  it("keeps standard CSV quoting when ordinary values contain apostrophes and mixed quotes", () => {
    const sample = [
      "name,description,count",
      `"Alpha","It's useful",10`,
      `"Beta","The 'quoted' label",20`,
      `"Gamma","A ""double-quoted"" value",30`,
      ""
    ].join("\n");

    expect(detectedImportOptionsFromSample("features.csv", utf8(sample))).toEqual({
      delimiter: ",",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
  });

  it("detects tab-delimited content despite a csv suffix", () => {
    expect(
      detectedImportOptionsFromSample(
        "cost.csv",
        utf8("category\tamount\tactive\nCompute\t12.5\ttrue\nStorage\t8\tfalse\n")
      )
    ).toEqual({
      delimiter: "\t",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
  });

  it("keeps a complete second row when the sample has no trailing newline", () => {
    expect(detectedImportOptionsFromSample("two-rows.csv", utf8("name;value\none;1"))).toEqual({
      delimiter: ";",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
  });

  it("detects a UTF-8 BOM and semicolon delimiter", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("name;value\none;1\ntwo;2\n")]);
    expect(detectedImportOptionsFromSample("export.csv", bytes)).toEqual({
      delimiter: ";",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
  });

  it("falls back to Windows-1252 for a common single-byte Western export", () => {
    const prefix = utf8("label;amount\nCaf");
    const suffix = utf8(";1\nTea;2\n");
    const bytes = new Uint8Array([...prefix, 0xe9, ...suffix]);
    expect(detectedImportOptionsFromSample("legacy.csv", bytes)).toEqual({
      delimiter: ";",
      encoding: "windows-1252",
      quoteChar: '"',
      hasHeader: true
    });
  });

  it("does not invent a header for homogeneous numeric rows", () => {
    expect(detectedImportOptionsFromSample("matrix.csv", utf8("1,2,3\n4,5,6\n7,8,9\n"))).toEqual({
      delimiter: ",",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: false
    });
  });

  it("ignores quoted delimiters and newlines while choosing the dialect", () => {
    const sample = `name|note|value\none|"contains | delimiter"|1\ntwo|"spans\nlines"|2\n`;
    expect(detectedImportOptionsFromSample("records.csv", utf8(sample))).toEqual({
      delimiter: "|",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
  });

  it("recognizes repeated structural single-quoted fields without treating apostrophes as quotes", () => {
    const sample = "name,description\n'one','contains, comma'\n'two','another, comma'\n";
    expect(detectedImportOptionsFromSample("single.csv", utf8(sample))).toEqual({
      delimiter: ",",
      encoding: "utf-8",
      quoteChar: "'",
      hasHeader: true
    });
  });

  it("uses extension defaults for an empty sample and leaves non-configurable formats alone", () => {
    expect(detectedImportOptionsFromSample("empty.tsv", new Uint8Array())).toEqual({
      delimiter: "\t",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
    expect(detectedImportOptionsFromSample("data.parquet", new Uint8Array())).toBeUndefined();
    expect(detectedImportOptionsFromSample("book.xlsx", new Uint8Array())).toEqual({ sheetIndex: 0 });
  });

  it("documents the hard prefix bound used by local detection", () => {
    expect(IMPORT_DETECTION_SAMPLE_BYTES).toBe(64 * 1024);
  });
});
