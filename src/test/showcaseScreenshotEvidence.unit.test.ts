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

  it("keeps final product captures full-size, varied, and geometrically complete", () => {
    const extensionHost = readFileSync(resolve("src/test/extensionHost/index.ts"), "utf8");

    expect(extensionHost).toContain("const fixture = ensurePackagedProductSceneFixture(workspace);");
    expect(extensionHost).toContain("rows: PACKAGED_SCREENSHOT_ROW_COUNT");
    expect(extensionHost).toContain('await previewUppercaseMarket(app, testing, "market_upper");');
    expect(extensionHost).toContain('await previewRevenueProjection(app, testing, "projected_revenue");');
    expect(extensionHost).toContain('const scriptPath = path.join(exportDirectory, "orders.clean.py");');
    expect(extensionHost).toContain('const cleanedDataPath = path.join(exportDirectory, "orders.cleaned.csv");');
    expect(extensionHost).toContain("`${editor}-export-code-dark.png`");
    expect(extensionHost).toContain("`${editor}-export-data-dark.png`");
    expect(extensionHost).toContain("active.metadata.steps.length === 2");
    expect(extensionHost).toContain("Cleaned-data export must preserve the source bytes.");
    expect(extensionHost).toContain('packagedScreenshotFileName(editor, "filter-result", "dark")');
    expect(extensionHost).toContain("The filter-result grid must show only complete visible rows.");
    expect(extensionHost).toContain('"notebook-pyspark-picker"');
    expect(extensionHost).toContain("Viewing only · Full-frame open (scan, index, cache) · Requires PySpark 4.2.x");
    expect(extensionHost).toContain("The notebook-variable capture must show only complete rows.");
    expect(extensionHost.indexOf("await captureReleasedJupyterPySparkPicker(")).toBeLessThan(
      extensionHost.indexOf(
        'await vscode.commands.executeCommand("jupyter.openVariableView");',
        extensionHost.indexOf("async function exerciseReleasedPySparkJupyterExtension(")
      )
    );
    expect(extensionHost).not.toContain("`${editor}-copy-code-dark.png`");
    expect(extensionHost).not.toContain("The documentation capture must cancel without writing a script.");
    expect(extensionHost).toContain('operator: "add"');
    expect(extensionHost).toContain("value: 500");
    expect(extensionHost).toContain('title: "Open Wrangler preview: orders_preview_df (pandas) - 100000 x 12"');
    expect(extensionHost).toContain("partialHeaderColumns: []");
    expect(extensionHost).toContain("partialBodyColumns: []");
    expect(extensionHost).toContain("visibleHeaderCount: 12");
    expect(extensionHost).toContain('"enterprise-account-model-417-columns.csv"');
    expect(extensionHost).not.toContain('mkdtempSync(path.join(tmpdir(), "openwrangler-wide-schema-showcase-"))');
    expect(extensionHost).toContain("Public wide-schema evidence must not expose random acceptance paths.");
  });

  it("reserves readable toolbar identity space while inspection controls wrap", () => {
    const stylesheet = readFileSync(resolve("src/webviews/styles.css"), "utf8");
    const extensionHost = readFileSync(resolve("src/test/extensionHost/index.ts"), "utf8");

    expect(stylesheet).toMatch(/\.toolbarIdentity\s*\{[^}]*min-width:\s*15ch;/u);
    expect(stylesheet).toMatch(/\.toolbarActions\s*\{[^}]*flex-wrap:\s*wrap;/u);
    expect(stylesheet).toMatch(
      /\.toolbarIdentity strong,\s*\.toolbarIdentity span\s*\{[^}]*text-overflow:\s*ellipsis;/u
    );
    expect(extensionHost).toContain('assert.equal(measurement.title, "orders.csv")');
    expect(extensionHost).toContain('assert.equal(measurement.shape, "100,000 × 17")');
    expect(extensionHost).toContain(
      'assert.equal(measurement.titleClipped, false, "The public product screenshot must show the complete source title.")'
    );
    expect(extensionHost).toContain(
      'assert.equal(measurement.shapeClipped, false, "The public product screenshot must show the complete dataset shape.")'
    );
  });
});
