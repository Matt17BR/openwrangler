import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ZipFile } from "yazl";
import { inspectReleaseMetadata } from "./release-metadata.mjs";
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

function parity(status = "Done", scope = PRIMARY_PARITY_SCOPE, evidence = "Exact package") {
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
    changelog: "# Changelog\n\n## [1.0.0] - 2026-07-27\n",
    readme: `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION}\n`,
    packagedPackageJson: JSON.stringify(stablePackage),
    packagedPythonVersionFile: '__version__ = "1.0.0"\n',
    packagedReadme: `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION}\n`,
    vsixManifest: manifest(),
    ...overrides
  };
}

function createReleaseVsix(path) {
  const zip = new ZipFile();
  const entries = new Map([
    ["[Content_Types].xml", "<Types />"],
    ["extension.vsixmanifest", manifest()],
    ["extension/package.json", JSON.stringify(stablePackage)],
    ["extension/readme.md", `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION}\n`],
    ["extension/dist/extension/activate.js", "export {};"],
    ["extension/dist/extension/webviewPanel.js", "export {};"],
    ["extension/media/webview.js", "export {};"],
    ["extension/media/webview.css", "body {}"],
    ["extension/media/codicon.ttf", "font"],
    ["extension/media/notebookRenderer.js", "export function activate() {}"],
    ["extension/media/icon.png", "icon"],
    ["extension/python/openwrangler_runtime/dependency_guard.py", "pass\n"],
    ["extension/python/openwrangler_runtime/server.py", "pass\n"],
    ["extension/python/openwrangler_runtime/version.py", '__version__ = "1.0.0"\n']
  ]);
  for (const [name, contents] of entries) {
    zip.addBuffer(Buffer.from(contents), name);
  }

  return new Promise((resolveWrite, rejectWrite) => {
    const output = createWriteStream(path, { flags: "wx", mode: 0o600 });
    output.once("error", rejectWrite);
    output.once("close", resolveWrite);
    zip.outputStream.once("error", rejectWrite);
    zip.outputStream.pipe(output);
    zip.end();
  });
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
  for (const hiddenDoneTable of [`\`\`\`markdown\n${parity()}\`\`\`\n`, `<!--\n${parity()}-->\n`]) {
    const problems = inspectStableReleaseReadiness(
      ready({
        featureParity: `# Feature parity matrix\n\n${hiddenDoneTable}\n${partialTable}`
      })
    );
    assert.ok(problems.includes('Parity row "CSV/TSV/Parquet/Excel/JSONL entry points" is Partial, not Done.'));
  }

  const duplicate = inspectStableReleaseReadiness(
    ready({ featureParity: `# Feature parity matrix\n\n${parity()}\n${parity()}` })
  );
  assert.ok(
    duplicate.includes(
      "docs/feature-parity.md must contain exactly one active canonical Pandas/Polars parity table; found 2."
    )
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
  for (const evidence of ["", "TODO", "Pending", "Add installed-editor timing"]) {
    const problems = inspectStableReleaseReadiness(
      ready({ featureParity: parity("Done", PRIMARY_PARITY_SCOPE, evidence) })
    );
    assert.ok(
      problems.some(
        (problem) =>
          problem.includes("empty required cell") ||
          problem.includes("must record substantive completed acceptance evidence")
      )
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

test("requires one real dated changelog heading for the stable version", () => {
  for (const changelog of [
    "# Changelog\n\n## [1.0.0] - Unreleased\n",
    "# Changelog\n\n## [1.0.0] - 2026-02-30\n",
    "# Changelog\n\n## [1.0.0] - 2026-07-27\n## [1.0.0] - 2026-07-28\n",
    "# Changelog\n\n```\n## [1.0.0] - 2026-07-27\n```\n",
    "# Changelog\n\n<!--\n## [1.0.0] - 2026-07-27\n-->\n"
  ]) {
    const problems = inspectStableReleaseReadiness(ready({ changelog }));
    assert.ok(problems.some((problem) => problem.startsWith("CHANGELOG.md")));
  }
});

test("requires one exact positive stable release and install section in both README copies", () => {
  for (const readme of [
    "# Open Wrangler\n\nOpen Wrangler remains preview software.\n",
    "# Open Wrangler\n\nNo packaged releases are available.\n",
    `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION}\n\n${STABLE_README_RELEASE_SECTION}\n`,
    `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION.replace("checksummed VSIX", "VSIX")}\n`
  ]) {
    const problems = inspectStableReleaseReadiness(ready({ readme }));
    assert.ok(problems.includes("README.md must contain exactly one canonical stable release/install-status section."));
  }

  const packagedProblems = inspectStableReleaseReadiness(
    ready({ packagedReadme: "# Open Wrangler\n\nOpen Wrangler remains preview software.\n" })
  );
  assert.ok(
    packagedProblems.includes(
      "Packaged README must contain exactly one canonical stable release/install-status section."
    )
  );
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
