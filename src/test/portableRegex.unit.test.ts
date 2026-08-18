import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_PORTABLE_REGEX_OUTPUT_NAME_UTF8_BYTES,
  portableRegexContract,
  validatePortableRegexOutputName
} from "../shared/portableRegex";

interface ContractFixture {
  readonly valid: readonly {
    readonly pattern: string;
    readonly group: number;
    readonly captures: number;
    readonly participationPattern: string;
  }[];
  readonly invalid: readonly { readonly pattern: string; readonly group: number }[];
}

const fixture = JSON.parse(
  readFileSync(resolve("fixtures", "portable-regex-contract.json"), "utf8")
) as ContractFixture;

describe("portable regex contract", () => {
  it.each(fixture.valid)("accepts $pattern for group $group", ({ pattern, group, captures, participationPattern }) => {
    expect(portableRegexContract(pattern, group)).toEqual({ captureCount: captures, participationPattern });
  });

  it.each(fixture.invalid)("rejects nonportable pattern %#", ({ pattern, group }) => {
    expect(() => portableRegexContract(pattern, group)).toThrow();
  });

  it("permits one variable-width quantifier and exact repeats, but rejects a second variable width", () => {
    expect(portableRegexContract("a{4}b{4}(c+)", 1)).toEqual({
      captureCount: 1,
      participationPattern: "a{4}b{4}(c+)"
    });
    expect(() => portableRegexContract("a{0,20}b{0,20}", 0)).toThrow(/variable-width/u);
  });

  it("bounds minimum match width including exact repeats inside captures", () => {
    expect(() => portableRegexContract(`(a{1000})${"a{1000}".repeat(7)}`, 1)).not.toThrow();
    expect(() => portableRegexContract(`(a{1000})${"a{1000}".repeat(8)}`, 1)).toThrow(/minimum match width/u);
    expect(() => portableRegexContract("😀{1000}😀{1000}😀{49}", 0)).toThrow(/UTF-8 bytes/u);
    expect(() => portableRegexContract("[😀]{1000}[😀]{1000}[😀]{49}", 0)).toThrow(/UTF-8 bytes/u);
  });

  it("enforces portable output names by UTF-8 bytes and Unicode scalar value", () => {
    expect(MAX_PORTABLE_REGEX_OUTPUT_NAME_UTF8_BYTES).toBe(1_024);
    expect(() => validatePortableRegexOutputName("é".repeat(512))).not.toThrow();
    expect(() => validatePortableRegexOutputName("é".repeat(513))).toThrow();
    expect(() => validatePortableRegexOutputName("\ud800")).toThrow();
    expect(() => validatePortableRegexOutputName("\0")).toThrow();
  });
});
