import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PACKAGED_SCREENSHOT_COLUMNS,
  PACKAGED_SCREENSHOT_ROWS,
  packagedScreenshotFileName,
  packagedScreenshotFixtureCsv
} from "./extensionHost/screenshotEvidence";

describe("packaged editor screenshot evidence", () => {
  it("uses one small, readable, deterministic fixture", () => {
    const csv = packagedScreenshotFixtureCsv();
    const lines = csv.trimEnd().split("\n");

    expect(PACKAGED_SCREENSHOT_COLUMNS).toHaveLength(6);
    expect(PACKAGED_SCREENSHOT_ROWS).toHaveLength(12);
    expect(lines).toHaveLength(13);
    expect(lines[0]).toBe("order_id,city,category,revenue,units,order_date");
    expect(lines.every((line) => line.split(",").length === PACKAGED_SCREENSHOT_COLUMNS.length)).toBe(true);
    expect(csv).not.toMatch(/(?:sample|fixture|test)[-_ ]?(?:data|value)?/iu);
  });

  it("keeps README scene names explicit and theme-aware", () => {
    expect(packagedScreenshotFileName("vscode", "hero", "dark")).toBe("vscode-hero-dark.png");
    expect(packagedScreenshotFileName("vscode", "hero", "light")).toBe("vscode-hero-light.png");
    expect(packagedScreenshotFileName("cursor", "transform", "dark")).toBe("cursor-transform-dark.png");
    expect(packagedScreenshotFileName("cursor", "transform", "light")).toBe("cursor-transform-light.png");
    expect(() => packagedScreenshotFileName("../outside", "hero", "dark")).toThrow(TypeError);
  });

  it("keeps the README to two explained, theme-aware product views", () => {
    const readme = readFileSync(resolve("README.md"), "utf8");

    expect(readme.match(/<picture>/gu)).toHaveLength(2);
    for (const name of [
      "vscode-hero-dark.png",
      "vscode-hero-light.png",
      "vscode-transform-dark.png",
      "vscode-transform-light.png"
    ]) {
      expect(readme).toContain(name);
    }
    expect(readme).not.toMatch(/docs\/images\/(?:grid-view|filter-panel|wide-grid|notebook-preview)\.png/u);
  });
});
