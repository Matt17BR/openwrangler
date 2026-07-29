import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PACKAGED_SCREENSHOT_COLUMNS,
  PACKAGED_SCREENSHOT_DATA_PROVENANCE,
  PACKAGED_SCREENSHOT_FEATURED_COLUMNS,
  PACKAGED_SCREENSHOT_HERO_SIDEBAR_WIDTH,
  PACKAGED_SCREENSHOT_MARKETS,
  PACKAGED_SCREENSHOT_MINIMUM_FEATURED_WIDTHS,
  PACKAGED_SCREENSHOT_ROW_COUNT,
  PACKAGED_SCREENSHOT_SCENES,
  PACKAGED_SCREENSHOT_VIEWPORT,
  packagedScreenshotFeaturedColumnWidths,
  packagedScreenshotFileName,
  packagedScreenshotFixtureCsv,
  packagedScreenshotRow
} from "./extensionHost/screenshotEvidence";

describe("packaged editor screenshot evidence", () => {
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
    expect(PACKAGED_SCREENSHOT_ROW_COUNT).toBe(10_000);
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
      expect(markets.filter((value) => value === market).length).toBeGreaterThan(1_000);
    }
    expect(revenues.filter((value) => value === "").length).toBeGreaterThan(50);
    expect(new Set(revenues.filter(Boolean)).size).toBeGreaterThan(8_000);
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
    expect(csv).not.toMatch(
      /(?:celonis|mmazzarelli|dropbox|@(?:gmail|celonis)|\/home\/|\\users\\|(?:sample|fixture|test)[-_ ]?(?:data|value)?)/iu
    );
    expect(createHash("sha256").update(csv).digest("hex")).toBe(
      "4beafb09e558146895114812046a1a9f08cac14f883466195ded700c8506e35d"
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
      "2410000",
      "DACH",
      "83.53",
      "true",
      "2024-03-13",
      "Public sector",
      "Online",
      "Analytics",
      "1",
      "93.18",
      "10.36",
      "30.25",
      "Standard",
      "2025-04-08",
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
    expect(Object.values(widths).reduce((total, width) => total + width, 0) + rowHeaderWidth).toBe(gridClientWidth);
    const wideWidths = packagedScreenshotFeaturedColumnWidths(1_500, rowHeaderWidth);
    expect(Object.values(wideWidths).reduce((total, width) => total + width, 0) + rowHeaderWidth).toBe(1_500);
    expect(Object.values(wideWidths).every((width) => width <= 640)).toBe(true);
    expect(packagedScreenshotFeaturedColumnWidths(893, rowHeaderWidth)).toEqual(
      PACKAGED_SCREENSHOT_MINIMUM_FEATURED_WIDTHS
    );
    expect(Object.values(packagedScreenshotFeaturedColumnWidths(3_248, rowHeaderWidth))).toEqual([
      640, 640, 640, 640, 640
    ]);
    expect(() => packagedScreenshotFeaturedColumnWidths(0, rowHeaderWidth)).toThrow(TypeError);
    expect(() => packagedScreenshotFeaturedColumnWidths(892, rowHeaderWidth)).toThrow(RangeError);
    expect(() => packagedScreenshotFeaturedColumnWidths(3_249, rowHeaderWidth)).toThrow(RangeError);
  });

  it("keeps README scene names explicit across file and notebook workflows", () => {
    expect(PACKAGED_SCREENSHOT_SCENES).toEqual(["hero", "notebook-pandas", "notebook-polars"]);
    expect(PACKAGED_SCREENSHOT_HERO_SIDEBAR_WIDTH).toBe(420);
    expect(packagedScreenshotFileName("vscode", "hero", "dark")).toBe("vscode-hero-dark.png");
    expect(packagedScreenshotFileName("vscode", "hero", "light")).toBe("vscode-hero-light.png");
    expect(packagedScreenshotFileName("vscode", "notebook-pandas", "dark")).toBe("vscode-notebook-pandas-dark.png");
    expect(packagedScreenshotFileName("vscode", "notebook-polars", "dark")).toBe("vscode-notebook-polars-dark.png");
    expect(() => packagedScreenshotFileName("../outside", "hero", "dark")).toThrow(TypeError);
  });

  it("keeps the README to three concise static product views", () => {
    const readme = readFileSync(resolve("README.md"), "utf8");
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const icon = readFileSync(resolve("assets/icon.png"));
    const standardIcon = readFileSync(resolve("assets/icon-256.png"));
    const compactIcon = readFileSync(resolve("assets/icon-128.png"));
    const iconSvg = readFileSync(resolve("assets/icon.svg"), "utf8");
    const activityIconSvg = readFileSync(resolve("assets/activity-icon.svg"), "utf8");
    const images = [
      ["vscode-hero-dark.png", 1_920, 834],
      ["vscode-notebook-pandas-dark.png", 1_920, 450],
      ["vscode-notebook-polars-dark.png", 1_920, 760]
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
    expect(packageJson.scripts?.check).toContain("npm run brand:check");
    expect(readme).not.toMatch(/<(?:picture|source)\b/iu);
    expect(readme).toContain('<img src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/assets/icon.png"');
    expect(readme).toContain('<h1 align="center">Open Wrangler</h1>');
    expect(readme).not.toContain("The image automatically follows your GitHub theme.");
    expect(readme).not.toMatch(/\b10,?000-row\b/iu);
    for (const [name, width, height] of images) {
      expect(readme).toContain(name);
      const png = readFileSync(resolve("docs/images/editor-acceptance", name));
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(png.readUInt32BE(16)).toBe(width);
      expect(png.readUInt32BE(20)).toBe(height);
      expect(png.byteLength).toBeGreaterThan(50_000);
    }
    for (const omitted of [
      "vscode-hero-light.png",
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
    } else if (character === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error("Unterminated quoted CSV fixture field.");
  values.push(value);
  return values;
}
