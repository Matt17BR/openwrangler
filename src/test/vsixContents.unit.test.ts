import { describe, expect, it } from "vitest";
import { inspectVsixEntries, requiredVsixEntries } from "../../scripts/vsix-contents.mjs";

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
});
