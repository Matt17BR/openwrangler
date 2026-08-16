import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isReleasedQuartoPreviewInput, releasedRenderedHtmlSnapshot } from "./extensionHost/quartoPreview";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openwrangler-quarto-preview-"));
  roots.push(root);
  return root;
}

describe("Quarto WebviewPanel identity", () => {
  it("accepts only the exact main-thread Quarto WebviewPanel input", () => {
    const exact = { kind: "webview", viewType: "mainThreadWebview-quarto.previewView" };
    const legacy = { kind: "webview", viewType: "quarto.previewView" };
    const isWebview = (candidate: unknown) => (candidate as { kind?: unknown }).kind === "webview";

    expect(isReleasedQuartoPreviewInput(exact, isWebview)).toBe(true);
    expect(isReleasedQuartoPreviewInput(legacy, isWebview)).toBe(false);
    expect(isReleasedQuartoPreviewInput({ ...exact, kind: "text" }, isWebview)).toBe(false);
  });
});

describe("released Quarto HTML snapshot", () => {
  it("accepts one complete bounded regular file containing every required marker", () => {
    const output = join(fixtureRoot(), "report.html");
    writeFileSync(output, "<html>Regional orders Regional orders preview 2400001</html>\n", "utf8");

    expect(releasedRenderedHtmlSnapshot(output, ["Regional orders preview", "2400001"])?.signature).toMatch(
      /^\d+:\d+:\d+:\d+$/u
    );
  });

  it("keeps missing, empty, incomplete, and marker-free output retryable", () => {
    const root = fixtureRoot();
    const missing = join(root, "missing.html");
    const empty = join(root, "empty.html");
    const incomplete = join(root, "incomplete.html");
    const markerFree = join(root, "marker-free.html");
    writeFileSync(empty, "", "utf8");
    writeFileSync(incomplete, "<html>Regional orders", "utf8");
    writeFileSync(markerFree, "<html>Other report</html>\n", "utf8");

    expect(releasedRenderedHtmlSnapshot(missing, ["Regional orders"])).toBeUndefined();
    expect(releasedRenderedHtmlSnapshot(empty, ["Regional orders"])).toBeUndefined();
    expect(releasedRenderedHtmlSnapshot(incomplete, ["Regional orders"])).toBeUndefined();
    expect(releasedRenderedHtmlSnapshot(markerFree, ["Regional orders"])).toBeUndefined();
  });

  it("rejects linked output before trusting its contents", () => {
    const root = fixtureRoot();
    const original = join(root, "original.html");
    const hardLink = join(root, "hard-link.html");
    const symbolicLink = join(root, "symbolic-link.html");
    writeFileSync(original, "<html>Regional orders</html>\n", "utf8");
    linkSync(original, hardLink);
    symlinkSync(original, symbolicLink);

    expect(() => releasedRenderedHtmlSnapshot(hardLink, ["Regional orders"])).toThrow(/bounded regular HTML file/u);
    expect(() => releasedRenderedHtmlSnapshot(symbolicLink, ["Regional orders"])).toThrow();
  });
});
