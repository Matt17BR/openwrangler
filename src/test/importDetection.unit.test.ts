import { describe, expect, it } from "vitest";
import {
  detectedImportOptionsFromSample,
  IMPORT_DETECTION_READ_BYTES,
  IMPORT_DETECTION_SAMPLE_BYTES
} from "../extension/files/importDetection";

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

function utf16(value: string, byteOrder: "le" | "be"): Uint8Array {
  const bytes = [byteOrder === "le" ? 0xff : 0xfe, byteOrder === "le" ? 0xfe : 0xff];
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    const low = codeUnit & 0xff;
    const high = codeUnit >> 8;
    bytes.push(byteOrder === "le" ? low : high, byteOrder === "le" ? high : low);
  }
  return new Uint8Array(bytes);
}

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

  it.each([
    {
      filename: "little-endian.csv",
      sample: utf16("city;label\n'München';'Café;Haus'\n'Zürich';'Crème;Bar'\n", "le"),
      delimiter: ";",
      encoding: "utf-16le",
      quoteChar: "'"
    },
    {
      filename: "big-endian.tsv",
      sample: utf16('city\tlabel\n東京\t"喫茶\t店"\n京都\t"抹茶\t店"\n', "be"),
      delimiter: "\t",
      encoding: "utf-16be",
      quoteChar: '"'
    }
  ])(
    "decodes BOM-marked $encoding before dialect and header inference",
    ({ filename, sample, delimiter, encoding, quoteChar }) => {
      expect(detectedImportOptionsFromSample(filename, sample)).toEqual({
        delimiter,
        encoding,
        quoteChar,
        hasHeader: true
      });
    }
  );

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

  it.each([
    ["é", 1],
    ["€", 1],
    ["€", 2],
    ["😀", 1],
    ["😀", 2],
    ["😀", 3]
  ] as const)("completes %s with %i bytes inside the nominal prefix", (character, prefixBytes) => {
    for (const bom of ["", "\ufeff"]) {
      const heading = utf8(`${bom}name;value\nCafé;1\n`);
      const sample = new Uint8Array([
        ...heading,
        ...utf8("x".repeat(IMPORT_DETECTION_SAMPLE_BYTES - heading.length - prefixBytes)),
        ...utf8(`${character};2\n`)
      ]).subarray(0, IMPORT_DETECTION_SAMPLE_BYTES + 3);

      expect(detectedImportOptionsFromSample("boundary.csv", sample)).toEqual({
        delimiter: ";",
        encoding: "utf-8",
        quoteChar: '"',
        hasHeader: true
      });
    }
  });

  it("stops after completing the cut scalar before another scalar starts in lookahead", () => {
    const heading = "name;value\none;1\n";
    const sample = utf8(`${heading}${"x".repeat(IMPORT_DETECTION_SAMPLE_BYTES - heading.length - 1)}é😀`);
    expect(
      detectedImportOptionsFromSample("boundary.csv", sample.subarray(0, IMPORT_DETECTION_SAMPLE_BYTES + 3))
    ).toEqual({ delimiter: ";", encoding: "utf-8", quoteChar: '"', hasHeader: true });
  });

  it("leaves bytes beyond a valid nominal UTF-8 prefix for the runtime to validate", () => {
    const heading = "name;value\none;1\n";
    const sample = new Uint8Array([
      ...utf8(heading + "x".repeat(IMPORT_DETECTION_SAMPLE_BYTES - heading.length)),
      0xff
    ]);
    expect(detectedImportOptionsFromSample("damaged.csv", sample)).toEqual({
      delimiter: ";",
      encoding: "utf-8",
      quoteChar: '"',
      hasHeader: true
    });
  });

  it.each([[0xc3], [0xe2, 0x82], [0xf0, 0x9f, 0x98]])(
    "keeps legacy fallback for an incomplete final sequence without lookahead: %j",
    (...suffix) => {
      const heading = utf8("name;value\none;1\ntwo;");
      for (const padding of [0, IMPORT_DETECTION_SAMPLE_BYTES - heading.length - suffix.length]) {
        const sample = new Uint8Array([...heading, ...utf8("x".repeat(padding)), ...suffix]);
        expect(detectedImportOptionsFromSample("incomplete.csv", sample)?.encoding).toBe("windows-1252");
      }
    }
  );

  it.each([
    { location: "interior", precedingByte: 0xff, lookahead: [0xa9, 0x20, 0x20] },
    { location: "continuation", precedingByte: 0x78, lookahead: [0x20, 0xa9, 0x20] }
  ])("retains legacy fallback for an invalid $location byte", ({ precedingByte, lookahead }) => {
    const heading = utf8("name;value\none;1\n");
    const sample = new Uint8Array([
      ...heading,
      ...utf8("x".repeat(IMPORT_DETECTION_SAMPLE_BYTES - heading.length - 2)),
      precedingByte,
      0xc3,
      ...lookahead
    ]);
    expect(detectedImportOptionsFromSample("legacy.csv", sample)?.encoding).toBe("windows-1252");
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

  it.each(["\n", "\r\n", "\r"])("recognizes complete %j records without changing LF persistence options", (ending) => {
    for (const finalEnding of ["", ending]) {
      expect(
        detectedImportOptionsFromSample(
          "records.csv",
          utf8(["name;value", "one;1", "two;2"].join(ending) + finalEnding)
        )
      ).toEqual({
        delimiter: ";",
        encoding: "utf-8",
        quoteChar: '"',
        hasHeader: true,
        ...(ending === "\r" ? { lineEnding: "cr" } : {})
      });
      expect(
        detectedImportOptionsFromSample("matrix.csv", utf8(["1;2", "3;4", "5;6"].join(ending) + finalEnding))
      ).toMatchObject({
        delimiter: ";",
        hasHeader: false
      });
    }
  });

  it.each(['"', "'"])("ignores quoted line breaks and escaped %s quotes when inferring CR", (quote) => {
    const sample = `name|note|value\rone|${quote}has\nLF ${quote}${quote}quote${quote}${quote}${quote}|1\rtwo|${quote}has\rCR\r\nCRLF${quote}|2\r`;
    expect(detectedImportOptionsFromSample("quoted.csv", utf8(sample))).toEqual({
      delimiter: "|",
      encoding: "utf-8",
      quoteChar: quote,
      hasHeader: true,
      lineEnding: "cr"
    });
  });

  it.each([
    "name,value",
    "name,value\r",
    'name,value\n"one\r',
    "name,value\rone,1\ntwo,2",
    "name,value\r\none,1\rtwo,2",
    'name,value\none,"quoted\rCR"\ntwo,2'
  ])("leaves absent, mixed or quoted-only CR evidence unspecified: %j", (sample) => {
    expect(detectedImportOptionsFromSample("ambiguous.csv", utf8(sample))).not.toHaveProperty("lineEnding");
  });

  it("retains earlier CR evidence before an unfinished quoted tail", () => {
    expect(detectedImportOptionsFromSample("cut.csv", utf8('name,value\rone,1\rtwo,"unfinished\n'))).toMatchObject({
      delimiter: ",",
      lineEnding: "cr"
    });
  });

  it("does not use an undecided trailing CR or records beyond the existing bounds", () => {
    const heading = "name,value\n";
    const boundary = heading + "x".repeat(IMPORT_DETECTION_SAMPLE_BYTES - heading.length - 1) + "\r\n";
    expect(detectedImportOptionsFromSample("cut.csv", utf8(boundary))).not.toHaveProperty("lineEnding");
    expect(
      detectedImportOptionsFromSample("rows.csv", utf8("name,value\r" + "one,1\r".repeat(100) + "two,2\n"))
    ).toMatchObject({ lineEnding: "cr" });
    expect(
      detectedImportOptionsFromSample("rows.csv", utf8("name,value\n" + "one,1\n".repeat(100) + "two,2\r"))
    ).not.toHaveProperty("lineEnding");
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
    expect(IMPORT_DETECTION_READ_BYTES).toBe(65_539);
  });
});
