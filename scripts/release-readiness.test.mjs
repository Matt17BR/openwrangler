import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ZipFile } from "yazl";
import { inspectVsixArchive, MAX_VSIX_ENTRY_BYTES } from "./vsix-archive.mjs";
import { inspectReleaseMetadata } from "./release-metadata.mjs";
import { inspectPreviewReadme, PREVIEW_README_RELEASE_SECTION } from "./release-documents.mjs";
import {
  inspectStableReleaseReadiness,
  PRIMARY_PARITY_SCOPE,
  readOwnedVsixSnapshot,
  readStableVsixPayload,
  STABLE_README_RELEASE_SECTION,
  writeStableReleaseArtifacts
} from "./release-readiness.mjs";

const namespace = "http://schemas.microsoft.com/developer/vsx-schema/2011";
const stablePackage = {
  name: "openwrangler",
  displayName: "Open Wrangler",
  publisher: "Matt17BR",
  version: "1.0.0",
  preview: false
};

function manifest({ id = "openwrangler", publisher = "Matt17BR", version = "1.0.0", properties = "" } = {}) {
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest xmlns="${namespace}">
  <Metadata>
    <Identity Id="${id}" Publisher="${publisher}" Version="${version}" />
    <Properties>${properties}</Properties>
  </Metadata>
</PackageManifest>`;
}

function parity(
  status = "Done",
  scope = PRIMARY_PARITY_SCOPE,
  evidence = "Exact package acceptance; test:scripts/release-readiness.test.mjs"
) {
  const rows = scope
    .map(([surface, pandas, polars]) => `| ${surface} | ${pandas} | ${polars} | ${status} | ${evidence} |`)
    .join("\n");
  return `# Feature parity matrix

| Surface | Pandas | Polars | Status | Required evidence |
| --- | ---: | ---: | --- | --- |
${rows}

## DuckDB file-backed preview matrix

| Surface | Status |
| --- | --- |
| Grid | Partial |
`;
}

function ready(overrides = {}) {
  return {
    releaseTag: "v1.0.0",
    sourcePackageJson: JSON.stringify(stablePackage),
    pythonVersionFile: '__version__ = "1.0.0"\n',
    featureParity: parity(),
    changelog: "# Changelog\n\n## [1.0.0] - 2026-07-27\n\n### Added\n\n- Published the verified stable package.\n",
    readme: `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION}\n`,
    packagedPackageJson: JSON.stringify(stablePackage),
    packagedPythonVersionFile: '__version__ = "1.0.0"\n',
    packagedReadme: `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION}\n`,
    trackedEvidencePaths: new Set([
      ".github/workflows/release.yml",
      "docs/testing.md",
      "scripts/release-readiness.test.mjs"
    ]),
    vsixManifest: manifest(),
    ...overrides
  };
}

function releaseVsixEntries(packageJson = stablePackage) {
  return new Map([
    ["[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'],
    ["extension.vsixmanifest", manifest()],
    ["extension/package.json", JSON.stringify(packageJson)],
    ["extension/LICENSE.txt", "MIT License\n"],
    ["extension/readme.md", `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION}\n`],
    ["extension/changelog.md", "# Changelog\n"],
    ["extension/THIRD_PARTY_NOTICES.md", "# Third-party notices\n"],
    ["extension/dist/extension/activate.js", "export {};"],
    ["extension/dist/extension/webviewPanel.js", "const policy = `font-src ${webview.cspSource};`;"],
    ["extension/media/webview.js", "export {};"],
    ["extension/media/webview.css", "@font-face{src:url('./codicon.ttf')}"],
    ["extension/media/codicon.ttf", "font"],
    ["extension/media/codePreview.js", "export {};"],
    ["extension/media/notebookRenderer.js", "export function activate() {}"],
    ["extension/media/activity-icon.svg", "<svg></svg>"],
    ["extension/media/icon.png", "icon"],
    ["extension/media/icon-128.png", "icon"],
    ["extension/python/openwrangler_runtime/dependency_guard.py", "pass\n"],
    ["extension/python/openwrangler_runtime/server.py", "pass\n"],
    ["extension/python/openwrangler_runtime/version.py", '__version__ = "1.0.0"\n']
  ]);
}

function createReleaseVsixBuffer({ entryModes = new Map(), entries = releaseVsixEntries(), omitted = new Set() } = {}) {
  const zip = new ZipFile();
  for (const [name, contents] of entries) {
    if (!omitted.has(name)) {
      zip.addBuffer(Buffer.isBuffer(contents) ? contents : Buffer.from(contents), name, {
        mode: entryModes.get(name)
      });
    }
  }

  return new Promise((resolveBytes, rejectBytes) => {
    const chunks = [];
    let length = 0;
    zip.outputStream.on("data", (chunk) => {
      chunks.push(chunk);
      length += chunk.length;
    });
    zip.outputStream.once("error", rejectBytes);
    zip.outputStream.once("end", () => resolveBytes(Buffer.concat(chunks, length)));
    zip.end();
  });
}

async function createReleaseVsix(path) {
  writeFileSync(path, await createReleaseVsixBuffer(), { flag: "wx", mode: 0o600 });
}

function patchZipEntry(bytes, entryName, patch) {
  const result = Buffer.from(bytes);
  const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let offset = 0;
  while ((offset = result.indexOf(centralSignature, offset)) >= 0) {
    const nameLength = result.readUInt16LE(offset + 28);
    const extraLength = result.readUInt16LE(offset + 30);
    const commentLength = result.readUInt16LE(offset + 32);
    const name = result.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name === entryName) {
      const localOffset = result.readUInt32LE(offset + 42);
      patch({ centralOffset: offset, localOffset, result });
      return result;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP test entry not found: ${entryName}`);
}

test("accepts one internally consistent stable release candidate", () => {
  assert.deepEqual(inspectStableReleaseReadiness(ready()), []);
});

test("binds numeric release versions to their channel before workflow branching", () => {
  for (const accepted of [
    { releaseTag: "v0.3.0", version: "0.3.0", preview: true },
    { releaseTag: "v1.0.0", version: "1.0.0", preview: false }
  ]) {
    assert.deepEqual(
      inspectReleaseMetadata({
        releaseTag: accepted.releaseTag,
        packageJson: JSON.stringify({ version: accepted.version, preview: accepted.preview })
      }).problems,
      []
    );
  }

  const stableNumberMarkedPreview = inspectReleaseMetadata({
    releaseTag: "v1.0.0",
    packageJson: JSON.stringify({ version: "1.0.0", preview: true })
  });
  assert.ok(
    stableNumberMarkedPreview.problems.includes(
      'Version 1.0.0 is not a permitted preview-channel number and requires package.json "preview" to be false.'
    )
  );

  const previewNumberMarkedStable = inspectReleaseMetadata({
    releaseTag: "v0.3.0",
    packageJson: JSON.stringify({ version: "0.3.0", preview: false })
  });
  assert.ok(
    previewNumberMarkedStable.problems.includes(
      'Preview-channel version 0.3.0 requires package.json "preview" to be true.'
    )
  );

  const evenZeroMinorMarkedPreview = inspectReleaseMetadata({
    releaseTag: "v0.4.0",
    packageJson: JSON.stringify({ version: "0.4.0", preview: true })
  });
  assert.ok(
    evenZeroMinorMarkedPreview.problems.includes(
      'Version 0.4.0 is not a permitted preview-channel number and requires package.json "preview" to be false.'
    )
  );
});

test("rejects duplicate release metadata keys before choosing a workflow branch", () => {
  const result = inspectReleaseMetadata({
    releaseTag: "v1.0.0",
    packageJson: '{"version":"0.3.0","version":"1.0.0","preview":false}'
  });
  assert.ok(result.problems.includes("package.json must not contain duplicate object keys."));
  assert.equal(result.prerelease, undefined);
});

test("requires every primary Pandas/Polars parity row to be Done", () => {
  const problems = inspectStableReleaseReadiness(ready({ featureParity: parity("Partial") }));
  assert.ok(problems.includes('Parity row "CSV/TSV/Parquet/Excel/JSONL entry points" is Partial, not Done.'));

  const malformed = inspectStableReleaseReadiness(
    ready({
      featureParity: `| Surface | Pandas | Polars | Status | Required evidence |
| --- | --- | --- | --- | --- |
broken
`
    })
  );
  assert.ok(malformed.some((problem) => problem.includes("malformed row")));
});

test("reads exactly one active primary parity table from its top-level section", () => {
  const partialTable = parity("Partial");
  for (const hiddenDoneTable of [
    `\`\`\`markdown\n${parity()}\`\`\`\n`,
    `<!--\n${parity()}-->\n`,
    `<div hidden>\n<table><tr><th>Surface</th><th>Pandas</th><th>Polars</th><th>Status</th><th>Required evidence</th></tr><tr><td>decoy</td><td>Yes</td><td>Yes</td><td>Done</td><td>decoy evidence</td></tr></table>\n</div>\n`
  ]) {
    const problems = inspectStableReleaseReadiness(
      ready({
        featureParity: `# Feature parity matrix\n\n${hiddenDoneTable}\n${partialTable}`
      })
    );
    assert.ok(problems.includes('Parity row "CSV/TSV/Parquet/Excel/JSONL entry points" is Partial, not Done.'));
  }

  const tableOnly = parity()
    .split("\n## DuckDB file-backed preview matrix")[0]
    .replace(/^# Feature parity matrix\n\n/u, "");
  const duplicate = inspectStableReleaseReadiness(
    ready({ featureParity: `# Feature parity matrix\n\n${tableOnly}\n${tableOnly}` })
  );
  assert.equal(
    duplicate[0],
    "docs/feature-parity.md must contain exactly one active top-level canonical Pandas/Polars parity table; found 2."
  );

  const wrongSection = inspectStableReleaseReadiness(
    ready({ featureParity: `# Feature parity matrix\n\n## Deferred\n\n${parity()}` })
  );
  assert.ok(
    wrongSection.includes(
      "The canonical Pandas/Polars parity table must remain in the top-level feature-parity section."
    )
  );
});

test("requires substantive completed evidence for every Done parity row", () => {
  for (const evidence of [
    "",
    "TODO",
    "Pending",
    "Add installed-editor timing",
    "Will add tests later; test:scripts/release-readiness.test.mjs",
    "Exact acceptance; test:scripts/missing.test.mjs",
    "Exact acceptance; test:docs/testing.md",
    "Exact acceptance; workflow:docs/testing.md",
    "Exact acceptance; record:scripts/release-readiness.test.mjs",
    "Exact acceptance; test:../scripts/release-readiness.test.mjs",
    "Exact acceptance; test:scripts/release-readiness.test.mjs and test:not tracked",
    "<!-- Exact acceptance passed --> test:scripts/release-readiness.test.mjs",
    "Exact acceptance passed <!-- test:scripts/release-readiness.test.mjs -->"
  ]) {
    const problems = inspectStableReleaseReadiness(
      ready({ featureParity: parity("Done", PRIMARY_PARITY_SCOPE, evidence) })
    );
    assert.ok(
      problems.some(
        (problem) =>
          problem.includes("empty or malformed row") || problem.includes("must record human acceptance evidence")
      )
    );
  }

  for (const evidence of [
    "Exact script acceptance passed; test:scripts/release-readiness.test.mjs",
    "Exact workflow acceptance passed; workflow:.github/workflows/release.yml",
    "Recorded editor acceptance passed; record:docs/testing.md"
  ]) {
    assert.deepEqual(
      inspectStableReleaseReadiness(ready({ featureParity: parity("Done", PRIMARY_PARITY_SCOPE, evidence) })),
      []
    );
  }
});

test("binds the primary parity table to the exact ordered release scope", () => {
  const missing = inspectStableReleaseReadiness(
    ready({ featureParity: parity("Done", PRIMARY_PARITY_SCOPE.slice(1)) })
  );
  assert.ok(missing.some((problem) => problem.includes("must contain exactly 30 release rows; found 29")));
  assert.ok(missing.some((problem) => problem.includes('must be "CSV/TSV/Parquet/Excel/JSONL entry points"')));

  const duplicatedScope = [PRIMARY_PARITY_SCOPE[0], PRIMARY_PARITY_SCOPE[0], ...PRIMARY_PARITY_SCOPE.slice(1)];
  const duplicated = inspectStableReleaseReadiness(ready({ featureParity: parity("Done", duplicatedScope) }));
  assert.ok(duplicated.some((problem) => problem.includes("must contain exactly 30 release rows; found 31")));
  assert.ok(
    duplicated.some((problem) => problem.includes('Parity row 2 must be "Notebook variable viewer and toolbar"'))
  );

  const reorderedScope = [PRIMARY_PARITY_SCOPE[1], PRIMARY_PARITY_SCOPE[0], ...PRIMARY_PARITY_SCOPE.slice(2)];
  const reordered = inspectStableReleaseReadiness(ready({ featureParity: parity("Done", reorderedScope) }));
  assert.ok(
    reordered.some((problem) => problem.includes('Parity row 1 must be "CSV/TSV/Parquet/Excel/JSONL entry points"'))
  );
  assert.ok(
    reordered.some((problem) => problem.includes('Parity row 2 must be "Notebook variable viewer and toolbar"'))
  );

  const extraScope = [...PRIMARY_PARITY_SCOPE, ["Unexpected surface", "Yes", "Yes"]];
  const extra = inspectStableReleaseReadiness(ready({ featureParity: parity("Done", extraScope) }));
  assert.ok(extra.some((problem) => problem.includes("must contain exactly 30 release rows; found 31")));
  assert.ok(extra.includes('Unexpected parity row "Unexpected surface" at position 31.'));

  const wrongScope = PRIMARY_PARITY_SCOPE.map((row) => [...row]);
  wrongScope[26] = [wrongScope[26][0], "Yes", "Yes"];
  const wrongEngines = inspectStableReleaseReadiness(ready({ featureParity: parity("Done", wrongScope) }));
  assert.ok(
    wrongEngines.some((problem) =>
      problem.includes('Parity row 27 must be "Duplicate/non-string Pandas column operations" (Yes/N/A)')
    )
  );
});

test("keeps the checked-in parity table aligned with the canonical scope before every release", () => {
  const featureParity = readFileSync(new URL("../docs/feature-parity.md", import.meta.url), "utf8");
  const problems = inspectStableReleaseReadiness(ready({ featureParity }));
  const expectedIncompleteRows = /^Parity row ".+" is (?:Partial|Planned), not Done\.$/u;

  assert.deepEqual(
    problems.filter((problem) => !expectedIncompleteRows.test(problem)),
    []
  );
});

test("binds the release tag, source package, Python runtime, and packaged versions", () => {
  const problems = inspectStableReleaseReadiness(
    ready({
      releaseTag: "v1.0.1",
      pythonVersionFile: '__version__ = "1.0.1"\n',
      packagedPackageJson: JSON.stringify({ ...stablePackage, version: "1.0.2" }),
      packagedPythonVersionFile: '__version__ = "1.0.4"\n',
      vsixManifest: manifest({ version: "1.0.3" })
    })
  );

  assert.ok(problems.includes("Release tag v1.0.1 does not match source version v1.0.0."));
  assert.ok(problems.includes("Python runtime version 1.0.1 does not match source package version 1.0.0."));
  assert.ok(problems.includes("Packaged Python runtime version 1.0.4 does not match source package version 1.0.0."));
  assert.ok(problems.includes("Packaged package.json version does not match source package.json."));
  assert.ok(problems.includes("VSIX identity version does not match source package.json version."));
});

test("requires explicit stable channel metadata in source, package, and VSIX", () => {
  const previewProperty = '<Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true" />';
  const problems = inspectStableReleaseReadiness(
    ready({
      sourcePackageJson: JSON.stringify({ ...stablePackage, preview: true }),
      packagedPackageJson: JSON.stringify({ ...stablePackage, preview: true }),
      vsixManifest: manifest({ properties: previewProperty })
    })
  );

  assert.ok(problems.includes("Source package.json preview must be false for a stable release."));
  assert.ok(problems.includes("Packaged package.json preview must be false for a stable release."));
  assert.ok(problems.includes("Stable packages must not contain Microsoft.VisualStudio.Code.PreRelease."));
});

test("rejects preview-channel numbers in direct stable readiness calls", () => {
  const previewNumberMarkedStable = { ...stablePackage, version: "0.3.0" };
  const problems = inspectStableReleaseReadiness(
    ready({
      releaseTag: "v0.3.0",
      sourcePackageJson: JSON.stringify(previewNumberMarkedStable),
      pythonVersionFile: '__version__ = "0.3.0"\n',
      packagedPackageJson: JSON.stringify(previewNumberMarkedStable),
      packagedPythonVersionFile: '__version__ = "0.3.0"\n',
      vsixManifest: manifest({ version: "0.3.0" })
    })
  );

  assert.ok(
    problems.includes(
      "Source package.json version 0.3.0 is reserved for preview releases and cannot pass stable readiness."
    )
  );
});

test("requires one real dated changelog heading for the stable version", () => {
  for (const changelog of [
    "# Changelog\n\n## [1.0.0] - Unreleased\n",
    "# Changelog\n\n## [1.0.0] - 2026-02-30\n",
    "# Changelog\n\n## [1.0.0] - 2026-07-27\n",
    "# Changelog\n\n## [1.0.0] - 2026-07-27\n\n### Added\n\n- <!-- Hidden substantive release note. -->\n",
    "# Changelog\n\n## [1.0.0] - 2026-07-27\n\n### Notes\n\n- This decoy is not a release category.\n",
    "# Changelog\n\n## [1.0.0] - 2026-07-27\n## [1.0.0] - 2026-07-28\n",
    "# Changelog\n\n```\n## [1.0.0] - 2026-07-27\n```\n",
    "# Changelog\n\n<!--\n## [1.0.0] - 2026-07-27\n-->\n",
    "# Changelog\n\n<div hidden><h2>[1.0.0] - 2026-07-27</h2><h3>Added</h3><ul><li>Hidden decoy change.</li></ul></div>\n"
  ]) {
    const problems = inspectStableReleaseReadiness(ready({ changelog }));
    assert.ok(problems.some((problem) => problem.startsWith("CHANGELOG.md")));
  }
});

test("requires one exact positive stable release and install section in both README copies", () => {
  for (const readme of [
    "# Open Wrangler\n\nOpen Wrangler remains preview software.\n",
    "# Open Wrangler\n\nNo packaged releases are available.\n",
    `# Open Wrangler\n\n\`\`\`markdown\n${STABLE_README_RELEASE_SECTION}\n\`\`\`\n`,
    `# Open Wrangler\n\n<!--\n${STABLE_README_RELEASE_SECTION}\n-->\n`,
    `# Open Wrangler\n\n<div hidden>\n${STABLE_README_RELEASE_SECTION}\n</div>\n`,
    `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION}\n\n${STABLE_README_RELEASE_SECTION}\n`,
    `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION.replace("checksummed VSIX", "VSIX")}\n`
  ]) {
    const problems = inspectStableReleaseReadiness(ready({ readme }));
    assert.ok(problems.some((problem) => problem.startsWith("README.md must")));
  }

  for (const contradiction of [
    "Prebuilt releases are not published.",
    "Future preview builds will appear here.",
    "Open Wrangler itself remains a preview.",
    "This is a preview release for Open Wrangler.",
    "This is not parity-complete for Open Wrangler."
  ]) {
    const problems = inspectStableReleaseReadiness(
      ready({ readme: `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION}\n\n${contradiction}\n` })
    );
    assert.ok(
      problems.includes("README.md contains release-channel status or install material outside its generated region.")
    );
  }

  assert.deepEqual(
    inspectStableReleaseReadiness(
      ready({
        readme: `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION}\n\nDuckDB notebook support remains a preview experiment.\n`
      })
    ),
    []
  );

  const packagedProblems = inspectStableReleaseReadiness(
    ready({ packagedReadme: "# Open Wrangler\n\nOpen Wrangler remains preview software.\n" })
  );
  assert.ok(packagedProblems.some((problem) => problem.startsWith("Packaged README must")));
});

test("keeps the checked-in preview README release and install section generated", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.deepEqual(inspectPreviewReadme(readme), []);
  assert.ok(readme.includes(PREVIEW_README_RELEASE_SECTION));
});

test("rejects malformed and ambiguous package, Python, and VSIX metadata", () => {
  const problems = inspectStableReleaseReadiness(
    ready({
      sourcePackageJson: "{",
      pythonVersionFile: '__version__ = "1.0.0"\n__version__ = "1.0.0"\n',
      packagedPackageJson: "[]",
      packagedPythonVersionFile: "",
      vsixManifest: `<PackageManifest xmlns="${namespace}"><Metadata><Properties /></Metadata></PackageManifest>`
    })
  );

  assert.ok(problems.includes("Source package.json must contain valid bounded JSON."));
  assert.ok(
    problems.includes('python/openwrangler_runtime/version.py must contain exactly one __version__ = "..." assignment.')
  );
  assert.ok(
    problems.includes('Packaged Python runtime version.py must contain exactly one __version__ = "..." assignment.')
  );
  assert.ok(problems.includes("Packaged package.json must contain a JSON object."));
  assert.ok(problems.includes("VSIX manifest must contain one canonical Metadata > Identity element."));
});

test("rejects duplicate JSON keys including escaped and nested aliases", () => {
  const duplicateSource = inspectStableReleaseReadiness(
    ready({
      sourcePackageJson:
        '{"name":"wrong","\\u006eame":"openwrangler","displayName":"Open Wrangler","publisher":"Matt17BR","version":"1.0.0","preview":false}'
    })
  );
  assert.ok(duplicateSource.includes("Source package.json must not contain duplicate object keys."));

  const duplicatePackaged = inspectStableReleaseReadiness(
    ready({
      packagedPackageJson:
        '{"name":"openwrangler","displayName":"Open Wrangler","publisher":"Matt17BR","version":"1.0.0","preview":false,"nested":{"value":1,"value":2}}'
    })
  );
  assert.ok(duplicatePackaged.includes("Packaged package.json must not contain duplicate object keys."));
});

test("requires the complete packaged manifest to equal the source manifest", () => {
  const source = { ...stablePackage, main: "./dist/extension/activate.js", engines: { vscode: "^1.105.0" } };
  const packaged = { ...source, main: "./dist/extension/other.js", engines: { vscode: "*" } };
  const problems = inspectStableReleaseReadiness(
    ready({
      sourcePackageJson: JSON.stringify(source),
      packagedPackageJson: JSON.stringify(packaged)
    })
  );
  assert.ok(
    problems.includes(
      "Packaged package.json must exactly match source package.json; no packaging transformations are permitted."
    )
  );
});

test("binds the VSIX identity to the extension package identity", () => {
  const problems = inspectStableReleaseReadiness(
    ready({
      vsixManifest: manifest({ id: "other", publisher: "OtherPublisher" })
    })
  );
  assert.ok(problems.includes("VSIX identity ID does not match source package.json name."));
  assert.ok(problems.includes("VSIX identity publisher does not match source package.json publisher."));
});

test("pins the stable source identity even when source, package, and VSIX agree on a rename", () => {
  const renamedPackage = {
    ...stablePackage,
    name: "renamed-wrangler",
    displayName: "Renamed Wrangler",
    publisher: "OtherPublisher"
  };
  const problems = inspectStableReleaseReadiness(
    ready({
      sourcePackageJson: JSON.stringify(renamedPackage),
      packagedPackageJson: JSON.stringify(renamedPackage),
      vsixManifest: manifest({ id: renamedPackage.name, publisher: renamedPackage.publisher })
    })
  );

  assert.ok(problems.includes('Source package.json name must be "openwrangler" for a stable release.'));
  assert.ok(problems.includes('Source package.json displayName must be "Open Wrangler" for a stable release.'));
  assert.ok(problems.includes('Source package.json publisher must be "Matt17BR" for a stable release.'));
});

test("inspects and checksums one owned immutable VSIX snapshot", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "ow-release-readiness-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const candidate = join(root, "candidate.vsix");
  const published = join(root, "openwrangler.vsix");
  const checksum = join(root, "openwrangler.vsix.sha256");
  await createReleaseVsix(candidate);

  const snapshot = readOwnedVsixSnapshot(candidate);
  const original = Buffer.from(snapshot.bytes);
  const expectedDigest = createHash("sha256").update(original).digest("hex");
  assert.equal(snapshot.sha256, expectedDigest);

  writeFileSync(candidate, "replacement bytes that must never be published");
  const payload = await readStableVsixPayload(snapshot.bytes);
  assert.deepEqual(JSON.parse(payload.packagedPackageJson), stablePackage);
  assert.equal(payload.packagedPythonVersionFile, '__version__ = "1.0.0"\n');

  writeStableReleaseArtifacts({ checksumOutput: checksum, snapshot, vsixOutput: published });
  assert.deepEqual(readFileSync(published), original);
  assert.equal(readFileSync(checksum, "utf8"), `${expectedDigest}  openwrangler.vsix\n`);
  if (process.platform !== "win32") {
    assert.equal(statSync(published).mode & 0o222, 0);
    assert.equal(statSync(checksum).mode & 0o222, 0);
  }
});

test("strictly streams and validates the complete shared VSIX inventory", async () => {
  const valid = await createReleaseVsixBuffer();
  const payload = await inspectVsixArchive(valid);
  assert.equal(payload.archiveEntries.length, releaseVsixEntries().size);
  assert.deepEqual(JSON.parse(payload.packagedPackageJson), stablePackage);

  await assert.rejects(
    inspectVsixArchive(
      await createReleaseVsixBuffer({
        omitted: new Set(["extension/LICENSE.txt"])
      })
    ),
    /Missing: extension\/LICENSE\.txt/u
  );

  await assert.rejects(
    inspectVsixArchive(
      await createReleaseVsixBuffer({
        entryModes: new Map([["extension/media/icon.png", 0o120777]])
      })
    ),
    /must be a regular file or matching directory entry/u
  );

  await assert.rejects(
    inspectVsixArchive(
      await createReleaseVsixBuffer({
        entries: releaseVsixEntries({
          ...stablePackage,
          icon: "media/missing.png"
        })
      })
    ),
    /references missing regular asset extension\/media\/missing\.png/u
  );

  const oversizedEntries = releaseVsixEntries();
  oversizedEntries.set("extension/media/webview.js", Buffer.alloc(MAX_VSIX_ENTRY_BYTES + 1));
  await assert.rejects(
    inspectVsixArchive(await createReleaseVsixBuffer({ entries: oversizedEntries })),
    /exceeds its per-entry size limit/u
  );

  const encrypted = patchZipEntry(valid, "extension/media/icon.png", ({ centralOffset, localOffset, result }) => {
    result.writeUInt16LE(result.readUInt16LE(centralOffset + 8) | 0x0001, centralOffset + 8);
    result.writeUInt16LE(result.readUInt16LE(localOffset + 6) | 0x0001, localOffset + 6);
  });
  await assert.rejects(inspectVsixArchive(encrypted), /uses unsupported or encrypted ZIP flags/u);

  const wrongCrc = patchZipEntry(valid, "extension/media/icon.png", ({ centralOffset, result }) => {
    result.writeUInt32LE((result.readUInt32LE(centralOffset + 16) ^ 0xffffffff) >>> 0, centralOffset + 16);
  });
  await assert.rejects(inspectVsixArchive(wrongCrc), /failed CRC-32 validation/u);
});

test("rejects symlinked and hard-linked stable VSIX candidates", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "ow-release-alias-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const candidate = join(root, "candidate.vsix");
  await createReleaseVsix(candidate);

  const hardLink = join(root, "candidate-hardlink.vsix");
  linkSync(candidate, hardLink);
  assert.throws(() => readOwnedVsixSnapshot(candidate), /one regular, unlinked file/u);

  if (process.platform !== "win32") {
    const symlink = join(root, "candidate-symlink.vsix");
    symlinkSync(candidate, symlink);
    assert.throws(() => readOwnedVsixSnapshot(symlink), /one regular, unlinked file/u);
  }
});

test("the tag workflow gates stable artifacts before checksums, upload, and release creation", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const metadata = workflow.indexOf("run: node scripts/release-metadata.mjs");
  const previewPackage = workflow.indexOf("name: Package canonical preview VSIX");
  const stablePackage = workflow.indexOf("name: Package stable VSIX candidate");
  const sourceCheck = workflow.indexOf("name: Verify exact tagged source after packaging");
  const stableVerification = workflow.indexOf("name: Verify stable VSIX candidate");
  const readiness = workflow.indexOf("name: Enforce stable release readiness and publish immutable snapshot");
  const previewChecksum = workflow.indexOf("name: Create canonical preview checksum");
  const upload = workflow.indexOf("name: openwrangler-release");
  const release = workflow.indexOf("softprops/action-gh-release@");

  assert.ok(metadata >= 0);
  assert.ok(previewPackage > metadata);
  assert.ok(stablePackage >= 0);
  assert.ok(stablePackage > metadata);
  assert.ok(sourceCheck > stablePackage);
  assert.ok(stableVerification > sourceCheck);
  assert.ok(readiness > stableVerification);
  assert.ok(previewChecksum > readiness);
  assert.ok(upload > previewChecksum);
  assert.ok(release > upload);
  assert.equal(workflow.match(/name: Enforce stable release readiness and publish immutable snapshot/gu)?.length, 1);
  assert.match(
    workflow.slice(stablePackage, sourceCheck),
    /if: \$\{\{ steps\.release_metadata\.outputs\.prerelease != 'true' \}\}[\s\S]*--out openwrangler\.candidate\.vsix/u
  );
  assert.match(
    workflow.slice(sourceCheck, stableVerification),
    /EXPECTED_SHA: \$\{\{ github\.sha \}\}[\s\S]*git diff-index --quiet HEAD --/u
  );
  assert.match(
    workflow.slice(readiness, previewChecksum),
    /if: \$\{\{ steps\.release_metadata\.outputs\.prerelease != 'true' \}\}[\s\S]*RELEASE_TAG: \$\{\{ github\.ref_name \}\}[\s\S]*openwrangler\.candidate\.vsix[\s\S]*--out openwrangler\.vsix[\s\S]*--checksum-out openwrangler\.vsix\.sha256/u
  );
});
