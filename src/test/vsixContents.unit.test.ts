import { describe, expect, it } from "vitest";
import { inspectReadmeSourceSrcsets, inspectVsixEntries, requiredVsixEntries } from "../../scripts/vsix-contents.mjs";

describe("VSIX production entry allowlist", () => {
  it("requires and narrowly permits the generated protocol-validation module", () => {
    const result = inspectVsixEntries([
      ...requiredVsixEntries,
      "[Content_Types].xml",
      "extension.vsixmanifest",
      "extension/media/notebookRenderer.js",
      "extension/media/codePreview.js"
    ]);

    expect(result).toEqual({ forbidden: [], missing: [] });
  });

  it("still rejects arbitrary media chunks and user scratch files", () => {
    const result = inspectVsixEntries([
      ...requiredVsixEntries,
      "extension/media/unexpected.js",
      "extension/scratch.txt"
    ]);

    expect(result.forbidden).toEqual(["extension/media/unexpected.js", "extension/scratch.txt"]);
    expect(result.missing).toEqual([]);
  });

  it("requires the compiled webview host and bundled Codicon font", () => {
    const entries = requiredVsixEntries.filter(
      (entry) => entry !== "extension/dist/extension/webviewPanel.js" && entry !== "extension/media/codicon.ttf"
    );

    expect(inspectVsixEntries(entries).missing).toEqual([
      "extension/dist/extension/webviewPanel.js",
      "extension/media/codicon.ttf"
    ]);
  });
});

describe("VSIX packaged README source validation", () => {
  it("accepts quoted srcsets only when every candidate is an absolute HTTPS URL", () => {
    expect(
      inspectReadmeSourceSrcsets(`
        <picture>
          <source
            media="(prefers-color-scheme: dark)"
            srcset="https://example.test/dark.png 1x, https://example.test/dark@2x.png 2x"
          >
          <source srcset='https://example.test/light.png'>
        </picture>
      `)
    ).toEqual([]);
  });

  it("rejects source elements with missing or unquoted srcset attributes", () => {
    expect(
      inspectReadmeSourceSrcsets(`
        <source media="(prefers-color-scheme: dark)">
        <source srcset=https://example.test/light.png>
      `)
    ).toEqual(["README source 1 is missing srcset.", "README source 2 srcset must be quoted."]);
  });

  it("rejects relative and mixed srcset candidates", () => {
    expect(
      inspectReadmeSourceSrcsets(`
        <source srcset="./dark.png">
        <source srcset="https://example.test/light.png 1x, ./light@2x.png 2x">
      `)
    ).toEqual([
      "README source 1 srcset candidate 1 must use an absolute HTTPS URL.",
      "README source 2 srcset candidate 2 must use an absolute HTTPS URL."
    ]);
  });
});
