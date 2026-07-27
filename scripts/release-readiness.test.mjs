import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inspectStableReleaseReadiness, PRIMARY_PARITY_SCOPE } from "./release-readiness.mjs";

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

function parity(status = "Done", scope = PRIMARY_PARITY_SCOPE) {
  const rows = scope
    .map(([surface, pandas, polars]) => `| ${surface} | ${pandas} | ${polars} | ${status} | Exact package |`)
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
    readme: "# Open Wrangler\n\nInstall stable releases from GitHub Releases.\n",
    packagedPackageJson: JSON.stringify(stablePackage),
    packagedPythonVersionFile: '__version__ = "1.0.0"\n',
    packagedReadme: "# Open Wrangler\n\nInstall stable releases from GitHub Releases.\n",
    vsixManifest: manifest(),
    ...overrides
  };
}

test("accepts one internally consistent stable release candidate", () => {
  assert.deepEqual(inspectStableReleaseReadiness(ready()), []);
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
    "## [1.0.0] - Unreleased\n",
    "## [1.0.0] - 2026-02-30\n",
    "## [1.0.0] - 2026-07-27\n## [1.0.0] - 2026-07-28\n"
  ]) {
    const problems = inspectStableReleaseReadiness(ready({ changelog }));
    assert.ok(problems.some((problem) => problem.startsWith("CHANGELOG.md")));
  }
});

test("rejects preview and unavailable-release claims from the stable README", () => {
  for (const readme of [
    "Open Wrangler is an active preview.",
    "Prebuilt releases are not published yet.",
    "Future preview builds will appear on GitHub.",
    "This is a preview, not a stable release."
  ]) {
    const problems = inspectStableReleaseReadiness(ready({ readme }));
    assert.ok(problems.some((problem) => problem.startsWith("README still")));
  }

  const packagedProblems = inspectStableReleaseReadiness(
    ready({ packagedReadme: "Prebuilt releases are not published yet." })
  );
  assert.ok(packagedProblems.includes("Packaged README still says that prebuilt releases are unavailable."));
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

  assert.ok(problems.includes("Source package.json must contain valid JSON."));
  assert.ok(
    problems.includes('python/openwrangler_runtime/version.py must contain exactly one __version__ = "..." assignment.')
  );
  assert.ok(
    problems.includes('Packaged Python runtime version.py must contain exactly one __version__ = "..." assignment.')
  );
  assert.ok(problems.includes("Packaged package.json must contain a JSON object."));
  assert.ok(problems.includes("VSIX manifest must contain one canonical Metadata > Identity element."));
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

test("the tag workflow gates stable artifacts before checksums, upload, and release creation", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const stablePackage = workflow.indexOf("name: Package canonical stable VSIX");
  const readiness = workflow.indexOf("name: Enforce stable release readiness");
  const checksum = workflow.indexOf("name: Create canonical checksum");
  const upload = workflow.indexOf("name: openwrangler-release");
  const release = workflow.indexOf("softprops/action-gh-release@");

  assert.ok(stablePackage >= 0);
  assert.ok(readiness > stablePackage);
  assert.ok(checksum > readiness);
  assert.ok(upload > checksum);
  assert.ok(release > upload);
  assert.equal(workflow.match(/name: Enforce stable release readiness/gu)?.length, 1);
  assert.match(
    workflow.slice(readiness, checksum),
    /if: \$\{\{ steps\.release_metadata\.outputs\.prerelease != 'true' \}\}[\s\S]*RELEASE_TAG: \$\{\{ github\.ref_name \}\}[\s\S]*npm run release:readiness -- openwrangler\.vsix/u
  );
});
