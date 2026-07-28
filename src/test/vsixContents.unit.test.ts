import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectNotebookRendererBundle,
  inspectReadmeSourceSrcsets,
  inspectVsixEntries,
  inspectVsixPreReleaseMetadata,
  requiredVsixEntries
} from "../../scripts/vsix-contents.mjs";

describe("notebook renderer bundle validation", () => {
  it("accepts one self-contained activation module", () => {
    for (const bundle of [
      "const activate=()=>({});export{activate};",
      "const internal=()=>({});export{internal as activate};",
      "export function activate(){return {};}",
      "export const activate=()=>({});",
      'const note="import(\\"./not-a-chunk.js\\")";/* import "./also-not-a-chunk.js" */export{note as activate};'
    ]) {
      expect(inspectNotebookRendererBundle(bundle)).toEqual([]);
    }
  });

  it.each([
    'import{validate}from"./protocolValidation.js";export{validate as activate};',
    'import"./side-effect.js";const activate=()=>({});export{activate};',
    'const dependency=import("./chunk.js");export{dependency as activate};',
    'const activate=()=>({});export{activate}from"./chunk.js";',
    'export*from"./chunk.js";'
  ])("rejects imported renderer dependencies (%s)", (bundle) => {
    expect(inspectNotebookRendererBundle(bundle)).toContain(
      "The notebook renderer entrypoint must be one self-contained module without imports."
    );
  });

  it("rejects empty and invalid JavaScript", () => {
    expect(inspectNotebookRendererBundle(" \n ")).toEqual([
      "The notebook renderer bundle must be non-empty JavaScript."
    ]);
    expect(inspectNotebookRendererBundle("export {")).toEqual([
      "The notebook renderer bundle must contain valid JavaScript."
    ]);
  });

  it.each(["const render=()=>({});export{render};", "export default function activate(){}"])(
    "requires a named renderer activation export (%s)",
    (bundle) => {
      expect(inspectNotebookRendererBundle(bundle)).toEqual(["The notebook renderer entrypoint must export activate."]);
    }
  );
});

describe("VSIX production entry allowlist", () => {
  it("excludes every root Vite configuration from production packages", () => {
    const rootViteConfigs = readdirSync(process.cwd())
      .filter((entry) => /^vite.*\.config\.ts$/u.test(entry))
      .sort();
    const vscodeIgnore = readFileSync(join(process.cwd(), ".vscodeignore"), "utf8")
      .split(/\r?\n/u)
      .filter((entry) => entry.length > 0 && !entry.startsWith("#"));

    expect(rootViteConfigs).toContain("vite.python-environment-smoke.config.ts");
    expect(vscodeIgnore).toContain("vite*.config.ts");
  });

  it("cleans and excludes Python wheel-build residue from production packages", () => {
    const gitIgnore = readFileSync(join(process.cwd(), ".gitignore"), "utf8")
      .split(/\r?\n/u)
      .filter((entry) => entry.length > 0 && !entry.startsWith("#"));
    const vscodeIgnore = readFileSync(join(process.cwd(), ".vscodeignore"), "utf8")
      .split(/\r?\n/u)
      .filter((entry) => entry.length > 0 && !entry.startsWith("#"));
    const cleanScript = readFileSync(join(process.cwd(), "scripts", "clean.mjs"), "utf8");

    expect(gitIgnore).toContain("python/build/");
    expect(vscodeIgnore).toContain("python/build/**");
    expect(cleanScript).toContain('"python/build"');
  });

  it("requires and narrowly permits the production webview assets", () => {
    const result = inspectVsixEntries(requiredVsixEntries);

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

  it("rejects case-folded and file-versus-directory archive path collisions", () => {
    const result = inspectVsixEntries([
      ...requiredVsixEntries,
      "extension/PACKAGE.JSON",
      "extension/dist/extension/ACTIVATE.js",
      "extension/package.json/"
    ]);

    expect(result.forbidden).toEqual(["extension/package.json/"]);
    expect(result.missing).toEqual([]);
    expect(result.duplicates).toEqual([
      "extension/PACKAGE.JSON",
      "extension/dist/extension/ACTIVATE.js",
      "extension/package.json/"
    ]);
  });

  it("case-folds Unicode archive names before collision checks", () => {
    const result = inspectVsixEntries([
      ...requiredVsixEntries,
      "extension/dist/extension/\u0130.js",
      "extension/dist/extension/i\u0307.js",
      "extension/dist/extension/Stra\u00dfe.js",
      "extension/dist/extension/STRASSE.js"
    ]);

    expect(result.forbidden).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.duplicates).toEqual(["extension/dist/extension/i\u0307.js", "extension/dist/extension/STRASSE.js"]);
  });

  it("rejects entries nested beneath an archive path that is already a file", () => {
    const result = inspectVsixEntries([
      ...requiredVsixEntries,
      "extension/dist/extension/container.js",
      "extension/dist/extension/container.js/child.js"
    ]);

    expect(result.forbidden).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.duplicates).toEqual(["extension/dist/extension/container.js/child.js"]);
  });

  it("rejects files that shadow an already listed descendant path", () => {
    const result = inspectVsixEntries([
      ...requiredVsixEntries,
      "extension/dist/extension/container.js/child.js",
      "extension/dist/extension/container.js"
    ]);

    expect(result.forbidden).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.duplicates).toEqual(["extension/dist/extension/container.js"]);
  });

  it("rejects non-portable archive path spellings before applying the allowlist", () => {
    const invalidEntries = [
      "/extension/package.json",
      "C:/extension/package.json",
      "extension\\package.json",
      "extension//dist/extension/activate.js",
      "extension/dist/extension/nested/../activate.js",
      "extension/dist/extension/./activate.js",
      "extension/dist/extension/trailing./activate.js",
      "extension/dist/extension/NUL.js",
      "extension/dist/extension/bad:name.js",
      "extension/dist/extension/cafe\u0301.js",
      `extension/dist/extension/bad${String.fromCharCode(0xd800)}.js`
    ];
    const result = inspectVsixEntries([...requiredVsixEntries, ...invalidEntries]);

    expect(result.forbidden).toEqual(invalidEntries);
    expect(result.missing).toEqual([]);
    expect(result.duplicates).toEqual([]);
  });

  it("requires the compiled webview host, notebook renderer, and bundled Codicon font", () => {
    const entries = requiredVsixEntries.filter(
      (entry) =>
        entry !== "extension/dist/extension/webviewPanel.js" &&
        entry !== "extension/media/notebookRenderer.js" &&
        entry !== "extension/media/codicon.ttf"
    );

    expect(inspectVsixEntries(entries).missing).toEqual([
      "extension/dist/extension/webviewPanel.js",
      "extension/media/codicon.ttf",
      "extension/media/notebookRenderer.js"
    ]);
  });

  it("requires the dependency mutation guard helper", () => {
    const entries = requiredVsixEntries.filter(
      (entry) => entry !== "extension/python/openwrangler_runtime/dependency_guard.py"
    );

    expect(inspectVsixEntries(entries).missing).toEqual(["extension/python/openwrangler_runtime/dependency_guard.py"]);
  });
});

describe("VSIX prerelease metadata validation", () => {
  const namespace = "http://schemas.microsoft.com/developer/vsx-schema/2011";
  const previewProperty = '<Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true" />';
  const manifest = (contents: string) =>
    `<PackageManifest xmlns="${namespace}"><Metadata><Properties>${contents}</Properties></Metadata></PackageManifest>`;

  it("requires the canonical prerelease property for preview packages", () => {
    expect(inspectVsixPreReleaseMetadata('{"preview":true}', manifest(""))).toEqual([
      "Preview packages must contain exactly one Microsoft.VisualStudio.Code.PreRelease property."
    ]);
    expect(
      inspectVsixPreReleaseMetadata('{"preview":true}', `<?xml version="1.0"?>${manifest(previewProperty)}`)
    ).toEqual([]);
  });

  it("rejects malformed or duplicated prerelease properties", () => {
    expect(
      inspectVsixPreReleaseMetadata(
        '{"preview":true}',
        manifest('<Property Value="false" Id="Microsoft.VisualStudio.Code.PreRelease" />')
      )
    ).toEqual(['Microsoft.VisualStudio.Code.PreRelease must have Value="true".']);
    expect(
      inspectVsixPreReleaseMetadata(
        '{"preview":true}',
        manifest('<Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="TRUE" />')
      )
    ).toEqual(['Microsoft.VisualStudio.Code.PreRelease must have Value="true".']);
    expect(inspectVsixPreReleaseMetadata('{"preview":true}', manifest(`${previewProperty}${previewProperty}`))).toEqual(
      ["Preview packages must contain exactly one Microsoft.VisualStudio.Code.PreRelease property."]
    );
  });

  it("parses entity-encoded attribute values structurally", () => {
    expect(
      inspectVsixPreReleaseMetadata(
        '{"preview":true}',
        manifest('<Property Id="Microsoft.VisualStudio.Code.Pre&#82;elease" Value="tr&#117;e" />')
      )
    ).toEqual([]);
  });

  it("rejects malformed XML, duplicate attributes, and declarations with a DOCTYPE", () => {
    const invalidManifests = [
      `<PackageManifest xmlns="${namespace}"><Metadata><Properties>${previewProperty}</Properties></Metadata>`,
      manifest(
        '<Property Id="Microsoft.VisualStudio.Code.PreRelease" Id="Microsoft.VisualStudio.Code.PreRelease" Value="true" />'
      ),
      `<!DOCTYPE PackageManifest>${manifest(previewProperty)}`
    ];

    for (const invalidManifest of invalidManifests) {
      expect(inspectVsixPreReleaseMetadata('{"preview":true}', invalidManifest)).toEqual([
        "VSIX manifest must contain well-formed XML without a DOCTYPE declaration."
      ]);
    }
  });

  it("rejects ambiguous or wrong-namespace manifest container chains", () => {
    const invalidStructures = [
      `<PackageManifest xmlns="${namespace}"><Properties>${previewProperty}</Properties></PackageManifest>`,
      `<PackageManifest xmlns="${namespace}"><Metadata><Properties /></Metadata><Metadata><Properties>${previewProperty}</Properties></Metadata></PackageManifest>`,
      `<PackageManifest xmlns="${namespace}"><Metadata><Properties /><Properties>${previewProperty}</Properties></Metadata></PackageManifest>`,
      '<PackageManifest xmlns="urn:lookalike"><Metadata><Properties><Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true" /></Properties></Metadata></PackageManifest>',
      `<PackageManifest xmlns="${namespace}"><Metadata xmlns="urn:lookalike"><Properties>${previewProperty}</Properties></Metadata></PackageManifest>`,
      `<PackageManifest xmlns="${namespace}"><Metadata><Properties xmlns="urn:lookalike">${previewProperty}</Properties></Metadata></PackageManifest>`,
      `<PackageManifest xmlns="${namespace}"><Metadata><Properties><Property xmlns="urn:lookalike" Id="Microsoft.VisualStudio.Code.PreRelease" Value="true" /></Properties></Metadata></PackageManifest>`
    ];

    for (const invalidStructure of invalidStructures) {
      expect(inspectVsixPreReleaseMetadata('{"preview":true}', invalidStructure)).toEqual([
        "VSIX manifest must contain one canonical PackageManifest > Metadata > Properties chain."
      ]);
    }
    expect(inspectVsixPreReleaseMetadata('{"preview":false}', invalidStructures[6] ?? "")).toEqual([
      "VSIX manifest must contain one canonical PackageManifest > Metadata > Properties chain."
    ]);
  });

  it("does not accept property text, namespaced attributes, or noncanonical element names", () => {
    const lookalikeManifests = [
      manifest(`<![CDATA[${previewProperty}]]>`),
      manifest('<property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true" />'),
      `<PackageManifest xmlns="${namespace}" xmlns:x="urn:test"><Metadata><Properties><Property x:Id="Microsoft.VisualStudio.Code.PreRelease" Value="true" /></Properties></Metadata></PackageManifest>`,
      `<PackageManifest xmlns="${namespace}" xmlns:x="urn:test"><Metadata><Properties><Property Id="Microsoft.VisualStudio.Code.PreRelease" x:Value="true" /></Properties></Metadata></PackageManifest>`,
      `<PackageManifest xmlns="${namespace}" xmlns:x="${namespace}"><Metadata><Properties><x:Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true" /></Properties></Metadata></PackageManifest>`
    ];

    for (const lookalikeManifest of [...lookalikeManifests.slice(0, 3), lookalikeManifests[4] ?? ""]) {
      expect(inspectVsixPreReleaseMetadata('{"preview":true}', lookalikeManifest)).toEqual([
        "Preview packages must contain exactly one Microsoft.VisualStudio.Code.PreRelease property."
      ]);
    }
    expect(inspectVsixPreReleaseMetadata('{"preview":true}', lookalikeManifests[3] ?? "")).toEqual([
      'Microsoft.VisualStudio.Code.PreRelease must have Value="true".'
    ]);
  });

  it("forbids prerelease metadata for stable packages", () => {
    expect(inspectVsixPreReleaseMetadata('{"preview":false}', manifest(previewProperty))).toEqual([
      "Stable packages must not contain Microsoft.VisualStudio.Code.PreRelease."
    ]);
    expect(inspectVsixPreReleaseMetadata("{}", manifest(""))).toEqual([]);
  });

  it("rejects malformed packaged preview metadata", () => {
    expect(inspectVsixPreReleaseMetadata("{", "<PackageManifest />")).toEqual([
      "Packaged package.json must contain valid JSON."
    ]);
    expect(inspectVsixPreReleaseMetadata('{"preview":"yes"}', manifest(""))).toEqual([
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
