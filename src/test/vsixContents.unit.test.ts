import { describe, expect, it } from "vitest";
import {
  inspectReadmeSourceSrcsets,
  inspectVsixEntries,
  inspectVsixPreReleaseMetadata,
  requiredVsixEntries
} from "../../scripts/vsix-contents.mjs";

describe("VSIX production entry allowlist", () => {
  it("requires and narrowly permits the generated protocol-validation module", () => {
    const result = inspectVsixEntries([
      ...requiredVsixEntries,
      "[Content_Types].xml",
      "extension.vsixmanifest",
      "extension/media/notebookRenderer.js",
      "extension/media/codePreview.js"
    ]);

    expect(result).toEqual({ forbidden: [], missing: [], duplicates: [] });
  });

  it("still rejects arbitrary media chunks and user scratch files", () => {
    const result = inspectVsixEntries([
      ...requiredVsixEntries,
      "extension/media/unexpected.js",
      "extension/scratch.txt"
    ]);

    expect(result.forbidden).toEqual(["extension/media/unexpected.js", "extension/scratch.txt"]);
    expect(result.missing).toEqual([]);
    expect(result.duplicates).toEqual([]);
  });

  it("rejects duplicate archive paths even when every path is otherwise allowed", () => {
    const result = inspectVsixEntries([...requiredVsixEntries, "extension/package.json"]);

    expect(result.forbidden).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.duplicates).toEqual(["extension/package.json"]);
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

describe("VSIX prerelease metadata validation", () => {
  const previewProperty = '<Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true" />';

  it("requires the canonical prerelease property for preview packages", () => {
    expect(inspectVsixPreReleaseMetadata('{"preview":true}', "<PackageManifest />")).toEqual([
      "Preview packages must contain exactly one Microsoft.VisualStudio.Code.PreRelease property."
    ]);
    expect(
      inspectVsixPreReleaseMetadata(
        '{"preview":true}',
        `<PackageManifest><Metadata><Properties>${previewProperty}</Properties></Metadata></PackageManifest>`
      )
    ).toEqual([]);
  });

  it("rejects malformed or duplicated prerelease properties", () => {
    expect(
      inspectVsixPreReleaseMetadata(
        '{"preview":true}',
        '<Properties><Property Value="false" Id="Microsoft.VisualStudio.Code.PreRelease" /></Properties>'
      )
    ).toEqual(['Microsoft.VisualStudio.Code.PreRelease must have Value="true".']);
    expect(
      inspectVsixPreReleaseMetadata(
        '{"preview":true}',
        '<Properties><Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="TRUE" /></Properties>'
      )
    ).toEqual(['Microsoft.VisualStudio.Code.PreRelease must have Value="true".']);
    expect(
      inspectVsixPreReleaseMetadata('{"preview":true}', `<Properties>${previewProperty}${previewProperty}</Properties>`)
    ).toEqual(["Preview packages must contain exactly one Microsoft.VisualStudio.Code.PreRelease property."]);
  });

  it("forbids prerelease metadata for stable packages", () => {
    expect(
      inspectVsixPreReleaseMetadata(
        '{"preview":false}',
        `<PackageManifest><Properties>${previewProperty}</Properties></PackageManifest>`
      )
    ).toEqual(["Stable packages must not contain Microsoft.VisualStudio.Code.PreRelease."]);
    expect(inspectVsixPreReleaseMetadata("{}", "<PackageManifest />")).toEqual([]);
  });

  it("rejects malformed packaged preview metadata", () => {
    expect(inspectVsixPreReleaseMetadata("{", "<PackageManifest />")).toEqual([
      "Packaged package.json must contain valid JSON."
    ]);
    expect(inspectVsixPreReleaseMetadata('{"preview":"yes"}', "<PackageManifest />")).toEqual([
      "Packaged package.json preview must be a boolean when present."
    ]);
    expect(inspectVsixPreReleaseMetadata("null", "<PackageManifest />")).toEqual([
      "Packaged package.json must contain a JSON object."
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
