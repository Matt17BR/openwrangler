import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PACKAGED_FIRST_USE_ROW_COUNT,
  PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT,
  PACKAGED_PANDAS_NOTEBOOK_OUTPUT,
  PACKAGED_PANDAS_NOTEBOOK_VIEWPORT,
  PACKAGED_PRODUCT_VIEWPORT,
  PACKAGED_SCREENSHOT_COLUMNS,
  PACKAGED_SCREENSHOT_DATA_PROVENANCE,
  PACKAGED_SCREENSHOT_FEATURED_COLUMNS,
  PACKAGED_SCREENSHOT_MARKETS,
  PACKAGED_SCREENSHOT_MINIMUM_FEATURED_WIDTHS,
  PACKAGED_SCREENSHOT_ROW_COUNT,
  PACKAGED_SCREENSHOT_SCENES,
  PACKAGED_SCREENSHOT_VIEWPORT,
  packagedScreenshotFeaturedColumnWidths,
  packagedScreenshotFileName,
  packagedFirstUseAccountNoteKind,
  packagedFirstUseFixtureCsv,
  packagedScreenshotFixtureCsv,
  packagedScreenshotRow
} from "./extensionHost/screenshotEvidence";

describe("packaged editor screenshot evidence", () => {
  it("generates a realistic first-use CSV dialect for the native editor journey", () => {
    const csv = packagedFirstUseFixtureCsv();
    const lines = csv.trimEnd().split("\n");

    expect(PACKAGED_FIRST_USE_ROW_COUNT).toBe(10_000);
    expect(lines).toHaveLength(PACKAGED_FIRST_USE_ROW_COUNT + 1);
    expect(lines[0]).toBe(`\uFEFF${PACKAGED_SCREENSHOT_COLUMNS.join(";")}`);
    expect(parseDelimitedRecord(lines[1] ?? "", ";")).toEqual(packagedScreenshotRow(0));
    expect(parseDelimitedRecord(lines.at(-1) ?? "", ";")).toEqual(
      packagedScreenshotRow(PACKAGED_FIRST_USE_ROW_COUNT - 1)
    );
    expect(lines.slice(1).every((line) => parseDelimitedRecord(line, ";").length === 15)).toBe(true);
    expect(csv).toContain(
      '"Renewal review follows the Q2 pilot, with ""steady adoption"" reported across the regional account"'
    );
    const explicitEmptyIndex = Array.from({ length: PACKAGED_FIRST_USE_ROW_COUNT }, (_, index) => index).find(
      (index) => packagedFirstUseAccountNoteKind(index) === "empty"
    );
    const nullIndex = Array.from({ length: PACKAGED_FIRST_USE_ROW_COUNT }, (_, index) => index).find(
      (index) => packagedFirstUseAccountNoteKind(index) === "null"
    );
    expect(explicitEmptyIndex).toBeTypeOf("number");
    expect(nullIndex).toBeTypeOf("number");
    expect(lines[(explicitEmptyIndex ?? -1) + 1]).toMatch(/;""$/u);
    expect(lines[(nullIndex ?? -1) + 1]).toMatch(/;$/u);
    expect(csv).toContain("Zürich and São Paulo");
  });

  it("generates one deterministic, realistic business fixture without private data", () => {
    const csv = packagedScreenshotFixtureCsv();
    const lines = csv.trimEnd().split("\n");
    const rows = Array.from({ length: PACKAGED_SCREENSHOT_ROW_COUNT }, (_, index) => packagedScreenshotRow(index));
    const orderIds = rows.map((row) => row[0]);
    const markets = rows.map((row) => row[1]);
    const revenues = rows.map((row) => row[2]);
    const fulfillment = rows.map((row) => row[3]);
    const dates = rows.map((row) => row[4]);
    const units = rows.map((row) => row[8]);
    const notes = rows.map((row) => row[14]);

    expect(PACKAGED_SCREENSHOT_DATA_PROVENANCE).toContain("Deterministic synthetic");
    expect(PACKAGED_SCREENSHOT_ROW_COUNT).toBe(100_000);
    expect(PACKAGED_SCREENSHOT_COLUMNS).toHaveLength(15);
    expect(lines).toHaveLength(PACKAGED_SCREENSHOT_ROW_COUNT + 1);
    expect(lines[0]).toBe(PACKAGED_SCREENSHOT_COLUMNS.join(","));
    expect(parseCsvRecord(lines[1] ?? "")).toEqual(rows[0]);
    expect(parseCsvRecord(lines.at(-1) ?? "")).toEqual(rows.at(-1));
    expect(lines.slice(1).every((line) => parseCsvRecord(line).length === PACKAGED_SCREENSHOT_COLUMNS.length)).toBe(
      true
    );
    expect(rows.every((row) => row.length === PACKAGED_SCREENSHOT_COLUMNS.length)).toBe(true);
    expect(new Set(orderIds).size).toBe(PACKAGED_SCREENSHOT_ROW_COUNT);
    expect(new Set(markets)).toEqual(new Set(PACKAGED_SCREENSHOT_MARKETS));
    for (const market of PACKAGED_SCREENSHOT_MARKETS) {
      expect(markets.filter((value) => value === market).length).toBeGreaterThan(10_000);
    }
    expect(revenues.filter((value) => value === "").length).toBeGreaterThan(50);
    expect(new Set(revenues.filter(Boolean)).size).toBeGreaterThan(20_000);
    expect(Math.min(...revenues.filter(Boolean).map(Number))).toBeGreaterThan(50);
    expect(Math.max(...revenues.filter(Boolean).map(Number))).toBeGreaterThan(10_000);
    expect(fulfillment).toContain("true");
    expect(fulfillment).toContain("false");
    expect(fulfillment).toContain("");
    expect(units).toContain("");
    expect(units.filter(Boolean).every((value) => Number.isSafeInteger(Number(value)))).toBe(true);
    expect(dates.filter((value) => value === "").length).toBeGreaterThan(20);
    const populatedDates = dates.filter(Boolean).sort();
    expect(populatedDates[0]).toBe("2024-01-01");
    expect(populatedDates.at(-1)).toBe("2025-12-30");
    expect(notes).toContain("");
    expect(notes.some((value) => value.length > 80 && value.includes(","))).toBe(true);
    expect(notes.some((value) => value.includes('"'))).toBe(true);
    expect(notes.some((value) => value.includes("Zürich") && value.includes("São Paulo"))).toBe(true);
    expect(csv).not.toMatch(
      /(?:celonis|mmazzarelli|dropbox|@(?:gmail|celonis)|\/home\/|\\users\\|(?:sample|fixture|test)[-_ ]?(?:data|value)?)/iu
    );
    expect(createHash("sha256").update(csv).digest("hex")).toBe(
      "68da203d980c6ce56c4be5f2fc8b953ed753a86b1e12848f69f9fbb99cfb61dd"
    );
    expect(packagedScreenshotRow(0)).toEqual([
      "2400001",
      "Benelux",
      "79.00",
      "true",
      "2024-01-01",
      "Enterprise",
      "Direct",
      "Analytics",
      "1",
      "79.00",
      "0.00",
      "18.96",
      "High",
      "2024-12-31",
      'Renewal review follows the Q2 pilot, with "steady adoption" reported across the regional account'
    ]);
    expect(packagedScreenshotRow(PACKAGED_SCREENSHOT_ROW_COUNT - 1)).toEqual([
      "2500000",
      "DACH",
      "782.72",
      "true",
      "2024-05-23",
      "Public sector",
      "Online",
      "Analytics",
      "1",
      "873.18",
      "10.36",
      "377.43",
      "Standard",
      "2025-06-10",
      "Procurement requested a consolidated proposal covering support levels and implementation milestones"
    ]);
    expect(() => packagedScreenshotRow(-1)).toThrow(RangeError);
    expect(() => packagedScreenshotRow(PACKAGED_SCREENSHOT_ROW_COUNT)).toThrow(RangeError);
  });

  it("fits a complete featured prefix while retaining a realistic horizontally scrollable schema", () => {
    const gridClientWidth = 1_050;
    const rowHeaderWidth = 48;
    const widths = packagedScreenshotFeaturedColumnWidths(gridClientWidth, rowHeaderWidth);

    expect(PACKAGED_SCREENSHOT_VIEWPORT).toEqual({ width: 1_920, height: 860 });
    expect(PACKAGED_SCREENSHOT_FEATURED_COLUMNS).toEqual(PACKAGED_SCREENSHOT_COLUMNS.slice(0, 5));
    expect(PACKAGED_SCREENSHOT_COLUMNS.length).toBeGreaterThan(PACKAGED_SCREENSHOT_FEATURED_COLUMNS.length);
    expect(
      PACKAGED_SCREENSHOT_FEATURED_COLUMNS.every(
        (name) => widths[name] >= PACKAGED_SCREENSHOT_MINIMUM_FEATURED_WIDTHS[name] && widths[name] <= 640
      )
    ).toBe(true);
    expect(widths.order_date).toBeGreaterThan(Math.max(widths.order_id, widths.market, widths.fulfilled));
    expect(Object.values(widths).reduce((total, width) => total + width, 0) + rowHeaderWidth).toBe(gridClientWidth);
    const wideWidths = packagedScreenshotFeaturedColumnWidths(1_500, rowHeaderWidth);
    expect(Object.values(wideWidths).reduce((total, width) => total + width, 0) + rowHeaderWidth).toBe(1_500);
    expect(Object.values(wideWidths).every((width) => width <= 640)).toBe(true);
    expect(packagedScreenshotFeaturedColumnWidths(943, rowHeaderWidth)).toEqual(
      PACKAGED_SCREENSHOT_MINIMUM_FEATURED_WIDTHS
    );
    expect(Object.values(packagedScreenshotFeaturedColumnWidths(3_248, rowHeaderWidth))).toEqual([
      640, 640, 640, 640, 640
    ]);
    expect(() => packagedScreenshotFeaturedColumnWidths(0, rowHeaderWidth)).toThrow(TypeError);
    expect(() => packagedScreenshotFeaturedColumnWidths(942, rowHeaderWidth)).toThrow(RangeError);
    expect(() => packagedScreenshotFeaturedColumnWidths(3_249, rowHeaderWidth)).toThrow(RangeError);
  });

  it("uses a readable notebook README viewport without changing the full workbench capture", () => {
    expect(PACKAGED_SCREENSHOT_VIEWPORT).toEqual({ width: 1_920, height: 860 });
    expect(PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT).toEqual({ width: 1_440, height: 900 });
    expect(PACKAGED_PRODUCT_VIEWPORT).toEqual({ width: 1_440, height: 900 });
    expect(PACKAGED_PANDAS_NOTEBOOK_VIEWPORT).toEqual({ width: 1_280, height: 700 });
    expect(PACKAGED_PANDAS_NOTEBOOK_OUTPUT).toEqual({ width: 1_280, height: 600 });
    expect(PACKAGED_PANDAS_NOTEBOOK_OUTPUT.width).toBe(PACKAGED_PANDAS_NOTEBOOK_VIEWPORT.width);
    expect(PACKAGED_PANDAS_NOTEBOOK_OUTPUT.height).toBeLessThan(PACKAGED_PANDAS_NOTEBOOK_VIEWPORT.height);
    expect(PACKAGED_PANDAS_NOTEBOOK_OUTPUT.width / PACKAGED_PANDAS_NOTEBOOK_OUTPUT.height).toBeLessThan(2.2);
  });

  it("keeps README scene names explicit across file and notebook workflows", () => {
    expect(PACKAGED_SCREENSHOT_SCENES).toEqual([
      "hero",
      "explore",
      "workflow",
      "notebook-pandas",
      "notebook-polars",
      "notebook-duckdb",
      "notebook-pyspark"
    ]);
    expect(packagedScreenshotFileName("vscode", "hero", "dark")).toBe("vscode-hero-dark.png");
    expect(packagedScreenshotFileName("vscode", "hero", "light")).toBe("vscode-hero-light.png");
    expect(packagedScreenshotFileName("vscode", "explore", "dark")).toBe("vscode-explore-dark.png");
    expect(packagedScreenshotFileName("vscode", "workflow", "dark")).toBe("vscode-workflow-dark.png");
    expect(packagedScreenshotFileName("vscode", "notebook-pandas", "dark")).toBe("vscode-notebook-pandas-dark.png");
    expect(packagedScreenshotFileName("vscode", "notebook-polars", "dark")).toBe("vscode-notebook-polars-dark.png");
    expect(packagedScreenshotFileName("vscode", "notebook-duckdb", "dark")).toBe("vscode-notebook-duckdb-dark.png");
    expect(packagedScreenshotFileName("vscode", "notebook-pyspark", "dark")).toBe("vscode-notebook-pyspark-dark.png");
    expect(() => packagedScreenshotFileName("../outside", "hero", "dark")).toThrow(TypeError);
  });

  it("keeps public notebook captures free of acceptance-only fixture labels", () => {
    const extensionHost = readFileSync(resolve("src/test/extensionHost/index.ts"), "utf8");
    const jupyterEnvironment = readFileSync(resolve("scripts/jupyter-acceptance-environment.mjs"), "utf8");
    const deprecatedKernelLabel = ["Open Wrangler", "Acceptance"].join(" ");
    const deprecatedVariableName = ["notebook", "showcase"].join("_");

    expect(extensionHost).toContain('const RELEASED_JUPYTER_LOCAL_KERNEL_LABEL = "Python 3.12 (Open Wrangler)"');
    expect(extensionHost).toContain('"orders_df = pd.DataFrame({"');
    expect(extensionHost).toContain('"# Explore recent orders in Open Wrangler\\n"');
    expect(jupyterEnvironment).toContain('display_name: "Python 3.12 (Open Wrangler)"');
    expect(extensionHost).not.toContain(deprecatedKernelLabel);
    expect(extensionHost).not.toContain(deprecatedVariableName);
    expect(jupyterEnvironment).not.toContain(deprecatedKernelLabel);
  });

  it("keeps the README to two concise portable product views", () => {
    const readme = readFileSync(resolve("README.md"), "utf8");
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      icon?: string;
      scripts?: Record<string, string>;
    };
    const buildWebviews = readFileSync(resolve("scripts/build-webviews.mjs"), "utf8");
    const icon = readFileSync(resolve("assets/icon.png"));
    const standardIcon = readFileSync(resolve("assets/icon-256.png"));
    const compactIcon = readFileSync(resolve("assets/icon-128.png"));
    const iconSvg = readFileSync(resolve("assets/icon.svg"), "utf8");
    const actionIconDarkSvg = readFileSync(resolve("assets/action-icon-dark.svg"), "utf8");
    const actionIconLightSvg = readFileSync(resolve("assets/action-icon-light.svg"), "utf8");
    const activityIconSvg = readFileSync(resolve("assets/activity-icon.svg"), "utf8");
    const viteConfig = readFileSync(resolve("vite.config.ts"), "utf8");
    const images = [
      ["workbench.png", 1_920, 830],
      ["notebooks.png", 1_280, 600]
    ] as const;

    expect(icon.readUInt32BE(16)).toBe(512);
    expect(icon.readUInt32BE(20)).toBe(512);
    expect(standardIcon.readUInt32BE(16)).toBe(256);
    expect(standardIcon.readUInt32BE(20)).toBe(256);
    expect(compactIcon.readUInt32BE(16)).toBe(128);
    expect(compactIcon.readUInt32BE(20)).toBe(128);
    expect(iconSvg).toContain('viewBox="0 0 512 512"');
    expect(iconSvg).toContain("Open Wrangler data-cell off-road vehicle");
    expect(iconSvg).not.toMatch(/<(?:script|foreignObject|image|use|filter)\b/iu);
    expect(activityIconSvg).toContain('viewBox="0 0 24 24"');
    expect(activityIconSvg).toContain("currentColor");
    expect(activityIconSvg).not.toMatch(/#[\da-f]{3,8}\b/iu);
    expect(actionIconDarkSvg).toContain('width="16" height="16" viewBox="0 0 16 16"');
    expect(actionIconLightSvg).toContain('width="16" height="16" viewBox="0 0 16 16"');
    expect(actionIconDarkSvg).toContain("#C5C5C5");
    expect(actionIconLightSvg).toContain("#424242");
    expect(actionIconDarkSvg).not.toContain("currentColor");
    expect(actionIconLightSvg).not.toContain("currentColor");
    expect(packageJson.scripts?.check).toContain("npm run brand:check");
    expect(packageJson.scripts?.["brand:render-check"]).toContain("--render-check");
    expect(packageJson.scripts?.["test:webview-acceptance"]).toContain("npm run brand:render-check");
    expect(packageJson.icon).toBe("media/icon.png");
    expect(viteConfig).toContain('publicDir: notebookRendererBuild ? false : "assets"');
    expect(viteConfig).toContain('outDir: "media"');
    for (const asset of [
      "action-icon-dark.svg",
      "action-icon-light.svg",
      "activity-icon.svg",
      "icon.svg",
      "icon-128.png",
      "icon-256.png",
      "icon.png"
    ]) {
      expect(buildWebviews).toContain(`"${asset}"`);
    }
    expect(buildWebviews).toContain('readFileSync(resolve("assets", asset))');
    expect(buildWebviews).toContain('readFileSync(resolve("media", asset))');
    expect(buildWebviews).toContain("packaged.equals(source)");
    expect(readme).not.toMatch(/<(?:picture|source)\b/iu);
    expect(readme).toContain(
      '<img src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/assets/icon.png" width="128" height="128"'
    );
    expect(readme).not.toMatch(/<img[^>]+assets\/icon\.svg[^>]+Open Wrangler logo/iu);
    expect(readme).toContain('<h1 align="center">Open Wrangler</h1>');
    expect(readme).not.toContain("The image automatically follows your GitHub theme.");
    expect(readme).not.toMatch(/\b10,?000-row\b/iu);
    for (const [name, width, height] of images) {
      expect(readme).toContain(name);
      const png = readFileSync(resolve("docs/images/readme/v1.1", name));
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(png.readUInt32BE(16)).toBe(width);
      expect(png.readUInt32BE(20)).toBe(height);
      expect(png.byteLength).toBeGreaterThan(50_000);
    }
    for (const omitted of [
      "vscode-hero-light.png",
      "vscode-hero-dark.png",
      "vscode-notebook-pandas-dark.png",
      "vscode-notebook-polars-dark.png",
      "vscode-columns-dark.png",
      "vscode-columns-light.png",
      "vscode-transform-dark.png",
      "vscode-transform-light.png"
    ]) {
      expect(readme).not.toContain(omitted);
    }
    expect(readme).not.toMatch(/docs\/images\/(?:grid-view|filter-panel|wide-grid|notebook-preview)\.png/u);
    expect(readme).toContain("https://marketplace.visualstudio.com/items?itemName=Matt17BR.openwrangler");
    expect(readme).toContain("https://open-vsx.org/extension/Matt17BR/openwrangler");
    expect(readme).toContain("https://github.com/Matt17BR/openwrangler/releases");
  });
});

function parseCsvRecord(record: string): string[] {
  return parseDelimitedRecord(record, ",");
}

function parseDelimitedRecord(record: string, delimiter: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < record.length; index += 1) {
    const character = record[index];
    if (character === '"') {
      if (quoted && record[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error("Unterminated quoted delimited fixture field.");
  values.push(value);
  return values;
}
