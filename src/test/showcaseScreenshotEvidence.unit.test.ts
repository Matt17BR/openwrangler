import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PACKAGED_WIDE_SCHEMA_COLUMN_COUNT,
  PACKAGED_WIDE_SCHEMA_ROW_COUNT,
  packagedWideSchemaColumns,
  packagedWideSchemaFixtureCsv
} from "./extensionHost/screenshotEvidence";

describe("wide-schema showcase evidence", () => {
  it("builds one deterministic, realistic, uncapped 417-column fixture", () => {
    const columns = packagedWideSchemaColumns();
    expect(columns).toHaveLength(PACKAGED_WIDE_SCHEMA_COLUMN_COUNT);
    expect(new Set(columns).size).toBe(PACKAGED_WIDE_SCHEMA_COLUMN_COUNT);
    expect(columns.slice(0, 4)).toEqual(["account_id", "account_name", "billing_country", "contract_start_date"]);
    expect(columns.at(-1)).toBe("usage_flag_417");

    const lines = packagedWideSchemaFixtureCsv().trimEnd().split("\n");
    expect(lines).toHaveLength(PACKAGED_WIDE_SCHEMA_ROW_COUNT + 1);
    expect(lines[0]?.split(",")).toEqual(columns);
    expect(lines[1]?.split(",")).toHaveLength(PACKAGED_WIDE_SCHEMA_COLUMN_COUNT);
    expect(lines.at(-1)?.split(",")).toHaveLength(PACKAGED_WIDE_SCHEMA_COLUMN_COUNT);
    const firstRow = lines[1]!.split(",");
    const valueFor = (pattern: RegExp) => firstRow[columns.findIndex((column) => pattern.test(column))];
    expect(valueFor(/_amount_\d+$/u)).toMatch(/^\d+\.\d{2}$/u);
    expect(valueFor(/_count_\d+$/u)).toMatch(/^\d+$/u);
    expect(valueFor(/_date_\d+$/u)).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(valueFor(/_flag_\d+$/u)).toMatch(/^(?:true|false)$/u);
    expect(valueFor(/_score_\d+$/u)).toMatch(/^\d+\.\d{2}$/u);
    expect(valueFor(/_status_\d+$/u)).toBe("Active");
    expect(valueFor(/_value_\d+$/u)).toMatch(/^segment-\d{2}$/u);
  });

  it("reserves readable toolbar identity space while inspection controls wrap", () => {
    const stylesheet = readFileSync(resolve("src/webviews/styles.css"), "utf8");

    expect(stylesheet).toMatch(/\.toolbarIdentity\s*\{[^}]*min-width:\s*15ch;/u);
    expect(stylesheet).toMatch(/\.toolbarActions\s*\{[^}]*flex-wrap:\s*wrap;/u);
    expect(stylesheet).toMatch(
      /\.toolbarIdentity strong,\s*\.toolbarIdentity span\s*\{[^}]*text-overflow:\s*ellipsis;/u
    );
  });
});
