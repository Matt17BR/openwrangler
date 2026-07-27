import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inspectStableReleaseReadiness } from "./release-readiness.mjs";

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

function parity(status = "Done") {
  return `# Feature parity matrix

| Surface | Pandas | Polars | Status | Required evidence |
| --- | ---: | ---: | --- | --- |
| Grid | Yes | Yes | ${status} | Exact package |
| Accessibility | N/A | N/A | Done | Exact package |

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
  assert.ok(problems.includes('Parity row "Grid" is Partial, not Done.'));

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
