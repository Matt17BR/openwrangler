import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { dump as dumpYaml, load as parseYaml } from "js-yaml";
import { ZipFile } from "yazl";
import { inspectVsixArchive, MAX_VSIX_ENTRY_BYTES } from "./vsix-archive.mjs";
import { parseStrictJson } from "./strict-json.mjs";
import {
  inspectPreviewReleaseMetadata,
  inspectReleaseMetadata,
  inspectWorkflowReleaseMetadata
} from "./release-metadata.mjs";
import { inspectReleaseWorkflow } from "./release-workflow.mjs";
import {
  inspectPerformanceEvidenceReadme,
  inspectPreviewReadme,
  PREVIEW_README_RELEASE_SECTION
} from "./release-documents.mjs";
import {
  inspectPerformanceEvidenceCandidateReadiness,
  inspectPerformanceEvidenceSourceReadiness,
  inspectStableReleaseReadiness,
  inspectStableSourceReadiness,
  PERFORMANCE_EVIDENCE_README_RELEASE_SECTION,
  PERFORMANCE_EVIDENCE_PARTIAL_ROWS,
  PERFORMANCE_EVIDENCE_VERSION,
  PRIMARY_PARITY_SCOPE,
  readOwnedVsixSnapshot,
  readReleaseSourceSnapshot,
  readStableVsixPayload,
  revalidateStableReleaseArtifacts,
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
    .map(([surface, pandas, polars]) => {
      const rowStatus = typeof status === "function" ? status(surface) : status;
      return `| ${surface} | ${pandas} | ${polars} | ${rowStatus} | ${evidence} |`;
    })
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

function performanceEvidenceReady(overrides = {}) {
  const performanceRows = new Set(PERFORMANCE_EVIDENCE_PARTIAL_ROWS);
  return ready({
    featureParity: parity((surface) => (performanceRows.has(surface) ? "Partial" : "Done")),
    readme: `# Open Wrangler\n\n${PERFORMANCE_EVIDENCE_README_RELEASE_SECTION}\n`,
    packagedReadme: `# Open Wrangler\n\n${PERFORMANCE_EVIDENCE_README_RELEASE_SECTION}\n`,
    ...overrides
  });
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

test("performance-evidence readiness permits only the two exact performance rows to remain Partial", () => {
  const performanceRows = new Set(PERFORMANCE_EVIDENCE_PARTIAL_ROWS);
  const featureParity = parity((surface) => (performanceRows.has(surface) ? "Partial" : "Done"));

  assert.deepEqual(inspectPerformanceEvidenceCandidateReadiness(performanceEvidenceReady({ featureParity })), []);
  assert.deepEqual(
    inspectStableReleaseReadiness(ready({ featureParity })).filter((problem) =>
      /^Parity row ".+" is Partial, not Done\.$/u.test(problem)
    ),
    PERFORMANCE_EVIDENCE_PARTIAL_ROWS.map((surface) => `Parity row "${surface}" is Partial, not Done.`)
  );

  const unrelatedPartial = parity((surface) =>
    surface === "Dataset summary and quick insights" || performanceRows.has(surface) ? "Partial" : "Done"
  );
  assert.ok(
    inspectPerformanceEvidenceCandidateReadiness(
      performanceEvidenceReady({ featureParity: unrelatedPartial })
    ).includes('Parity row "Dataset summary and quick insights" is Partial, not Done.')
  );

  for (const surface of PERFORMANCE_EVIDENCE_PARTIAL_ROWS) {
    const planned = parity((candidate) => (candidate === surface ? "Planned" : "Done"));
    assert.ok(
      inspectPerformanceEvidenceCandidateReadiness(performanceEvidenceReady({ featureParity: planned })).includes(
        `Parity row "${surface}" is Planned, not Done.`
      )
    );
  }

  const missingProgressEvidence = featureParity.replace(
    "| Virtual grid, column sizing, navigation | Yes | Yes | Partial | Exact package acceptance; test:scripts/release-readiness.test.mjs |",
    "| Virtual grid, column sizing, navigation | Yes | Yes | Partial | TODO |"
  );
  assert.ok(
    inspectPerformanceEvidenceCandidateReadiness(
      performanceEvidenceReady({ featureParity: missingProgressEvidence })
    ).includes(
      'Parity row "Virtual grid, column sizing, navigation" must record acceptance progress plus a valid tracked test:, workflow:, or record: reference.'
    )
  );

  const invalidMetadata = inspectPerformanceEvidenceCandidateReadiness(
    performanceEvidenceReady({
      featureParity,
      sourcePackageJson: JSON.stringify({ ...stablePackage, preview: true })
    })
  );
  assert.ok(invalidMetadata.includes("Source package.json preview must be false for a stable release."));
});

test("keeps performance evidence truthful and non-interchangeable with stable readiness", () => {
  assert.deepEqual(inspectPerformanceEvidenceCandidateReadiness(performanceEvidenceReady()), []);

  const stableReadmeInEvidenceMode = inspectPerformanceEvidenceCandidateReadiness(
    performanceEvidenceReady({
      readme: `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION}\n`,
      packagedReadme: `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION}\n`
    })
  );
  assert.ok(
    stableReadmeInEvidenceMode.some((problem) =>
      problem.includes("exact generated performance-evidence candidate release/install region")
    )
  );

  const evidenceReadmeInStableMode = inspectStableReleaseReadiness(
    ready({
      readme: `# Open Wrangler\n\n${PERFORMANCE_EVIDENCE_README_RELEASE_SECTION}\n`,
      packagedReadme: `# Open Wrangler\n\n${PERFORMANCE_EVIDENCE_README_RELEASE_SECTION}\n`
    })
  );
  assert.ok(
    evidenceReadmeInStableMode.some((problem) => problem.includes("exact generated stable release/install region"))
  );

  const completedRows = performanceEvidenceReady({ featureParity: parity() });
  const completedProblems = inspectPerformanceEvidenceCandidateReadiness(completedRows);
  for (const surface of PERFORMANCE_EVIDENCE_PARTIAL_ROWS) {
    assert.ok(
      completedProblems.includes(
        `Parity row "${surface}" must remain Partial while authoring performance evidence; received Done.`
      )
    );
  }

  assert.deepEqual(
    inspectPerformanceEvidenceSourceReadiness({
      featureParity: performanceEvidenceReady().featureParity,
      readme: performanceEvidenceReady().readme,
      trackedEvidencePaths: performanceEvidenceReady().trackedEvidencePaths,
      version: PERFORMANCE_EVIDENCE_VERSION
    }),
    []
  );
  assert.deepEqual(
    inspectStableSourceReadiness({
      featureParity: ready().featureParity,
      readme: ready().readme,
      trackedEvidencePaths: ready().trackedEvidencePaths
    }),
    []
  );
  assert.deepEqual(
    inspectPerformanceEvidenceReadme(`# Open Wrangler\n\n${PERFORMANCE_EVIDENCE_README_RELEASE_SECTION}\n`),
    []
  );
});

test("limits the temporary performance-evidence narrative and workflow to 1.0.0", () => {
  for (const version of ["1.1.0", "2.0.0"]) {
    const candidate = performanceEvidenceReady({
      releaseTag: `v${version}`,
      sourcePackageJson: JSON.stringify({ ...stablePackage, version }),
      pythonVersionFile: `__version__ = "${version}"\n`,
      packagedPackageJson: JSON.stringify({ ...stablePackage, version }),
      packagedPythonVersionFile: `__version__ = "${version}"\n`,
      vsixManifest: manifest({ version })
    });
    assert.ok(
      inspectPerformanceEvidenceCandidateReadiness(candidate).includes(
        `Performance-evidence authoring is limited to version ${PERFORMANCE_EVIDENCE_VERSION}.`
      )
    );
    assert.ok(
      inspectPerformanceEvidenceSourceReadiness({
        featureParity: candidate.featureParity,
        readme: candidate.readme,
        trackedEvidencePaths: candidate.trackedEvidencePaths,
        version
      }).includes(`Performance-evidence authoring is limited to version ${PERFORMANCE_EVIDENCE_VERSION}.`)
    );
  }
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

test("accepts only preview metadata in the tag-release workflow gate", () => {
  assert.deepEqual(
    inspectPreviewReleaseMetadata({
      releaseTag: "v0.3.0",
      packageJson: JSON.stringify({ version: "0.3.0", preview: true })
    }).problems,
    []
  );

  const stable = inspectPreviewReleaseMetadata({
    releaseTag: "v1.0.0",
    packageJson: JSON.stringify({ version: "1.0.0", preview: false })
  });
  assert.ok(
    stable.problems.includes(
      "The tag release workflow is preview-only; stable publication must promote provenance-bound tested artifacts without rebuilding them."
    )
  );
});

test("retains canonical stable-candidate metadata mode beside the exact preview-only mode", () => {
  const stable = {
    releaseTag: "v1.0.0",
    packageJson: JSON.stringify({ version: "1.0.0", preview: false })
  };
  assert.deepEqual(inspectWorkflowReleaseMetadata(stable, undefined).problems, []);
  assert.ok(
    inspectWorkflowReleaseMetadata(stable, "--preview-only").problems.includes(
      "The tag release workflow is preview-only; stable publication must promote provenance-bound tested artifacts without rebuilding them."
    )
  );
  assert.throws(
    () => inspectWorkflowReleaseMetadata(stable, "--stable-only"),
    /accepts only its stable-candidate mode or the exact --preview-only tag mode/u
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
        (problem) => problem.includes("empty or malformed row") || problem.includes("must record acceptance progress")
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
    `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION.replace("checksummed GitHub Release", "GitHub Release")}\n`
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

test("keeps the checked-in README release and install section generated for its current source channel", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const packageJson = parseStrictJson(readFileSync(new URL("../package.json", import.meta.url), "utf8"), {
    maxBytes: 1024 * 1024
  });
  assert.equal(typeof packageJson?.preview, "boolean");
  if (packageJson.preview === true) {
    assert.deepEqual(inspectPreviewReadme(readme), []);
    assert.ok(readme.includes(PREVIEW_README_RELEASE_SECTION));
    return;
  }

  const featureParity = readFileSync(new URL("../docs/feature-parity.md", import.meta.url), "utf8");
  const trackedEvidencePaths = new Set(
    execFileSync("git", ["ls-files", "-z", "--"], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    })
      .split("\0")
      .filter(Boolean)
  );
  const stableProblems = inspectStableSourceReadiness({
    featureParity,
    readme,
    trackedEvidencePaths
  });
  const evidenceProblems = inspectPerformanceEvidenceSourceReadiness({
    featureParity,
    readme,
    trackedEvidencePaths,
    version: packageJson.version
  });
  assert.equal(Number(stableProblems.length === 0) + Number(evidenceProblems.length === 0), 1);
  if (evidenceProblems.length === 0) {
    assert.deepEqual(inspectPerformanceEvidenceReadme(readme), []);
    assert.ok(readme.includes(PERFORMANCE_EVIDENCE_README_RELEASE_SECTION));
  } else {
    assert.ok(readme.includes(STABLE_README_RELEASE_SECTION));
  }
});

test("keeps the same compact editor support tiers in every README channel", () => {
  for (const section of [
    PREVIEW_README_RELEASE_SECTION,
    PERFORMANCE_EVIDENCE_README_RELEASE_SECTION,
    STABLE_README_RELEASE_SECTION
  ]) {
    assert.match(section, /\| VS Code\s+\| First-class\s+\| Complete release suite\s+\|/u);
    assert.match(section, /\| Cursor\s+\| First-class\s+\| Complete release suite\s+\|/u);
    assert.match(section, /\| Other VS Code desktop IDEs\s+\| Experimental\s+\|/u);
    assert.match(section, /\| Browser-hosted `vscode\.dev`\s+\| Unsupported\s+\|/u);
    assert.match(section, /VS Code and Cursor are release-tested/u);
    assert.match(section, /desktop forks that consume Open VSX may work/u);
    assert.match(section, /are not yet part of the release gate/u);
  }
  const stableLinks = new Map(
    [...STABLE_README_RELEASE_SECTION.matchAll(/\[([^\]]+)\]\(([^)]+)\)/gu)].map((match) => [match[1], match[2]])
  );
  assert.equal(
    stableLinks.get("Visual Studio Marketplace"),
    "https://marketplace.visualstudio.com/items?itemName=Matt17BR.openwrangler"
  );
  assert.equal(stableLinks.get("Open VSX"), "https://open-vsx.org/extension/Matt17BR/openwrangler");
  assert.equal(stableLinks.get("GitHub Release"), "https://github.com/Matt17BR/openwrangler/releases");
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

  const receipts = writeStableReleaseArtifacts({
    checksumOutput: checksum,
    snapshot,
    vsixOutput: published
  });
  assert.deepEqual(readFileSync(published), original);
  assert.equal(readFileSync(checksum, "utf8"), `${expectedDigest}  openwrangler.vsix\n`);
  revalidateStableReleaseArtifacts({
    checksumOutput: checksum,
    checksumReceipt: receipts.checksumReceipt,
    snapshot,
    vsixOutput: published,
    vsixReceipt: receipts.vsixReceipt
  });
  if (process.platform !== "win32") {
    assert.equal(statSync(published).mode & 0o222, 0);
    assert.equal(statSync(checksum).mode & 0o222, 0);
  }
});

test("reads release documentation from the exact immutable Git commit", () => {
  const root = resolve(import.meta.dirname, "..");
  const expectedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8"
  }).trim();
  const source = readReleaseSourceSnapshot({ expectedCommit, root });
  assert.equal(source.commit, expectedCommit);
  assert.ok(source.trackedPaths.has("docs/testing.md"));
  assert.match(source.files.get("package.json"), /"name": "openwrangler"/u);

  const repository = mkdtempSync(join(tmpdir(), "ow-release-source-commit-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: repository });
    writeFileSync(join(repository, "marker.txt"), "first\n");
    execFileSync("git", ["add", "marker.txt"], { cwd: repository });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Open Wrangler Tests",
        "-c",
        "user.email=tests@openwrangler.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "first"
      ],
      { cwd: repository }
    );
    const otherCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8"
    }).trim();
    writeFileSync(join(repository, "marker.txt"), "second\n");
    execFileSync("git", ["add", "marker.txt"], { cwd: repository });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Open Wrangler Tests",
        "-c",
        "user.email=tests@openwrangler.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "second"
      ],
      { cwd: repository }
    );
    assert.throws(
      () => readReleaseSourceSnapshot({ expectedCommit: otherCommit, root: repository }),
      /exact checked-out event commit/u
    );
  } finally {
    rmSync(repository, { force: true, recursive: true });
  }
});

test("pins a canonical output parent while allowing symlinked ancestry", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "ow-release-parent-alias-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const firstParent = join(root, "first");
  const secondParent = join(root, "second");
  const alias = join(root, "alias");
  mkdirSync(firstParent, { mode: 0o700 });
  mkdirSync(secondParent, { mode: 0o700 });
  symlinkSync(firstParent, alias, process.platform === "win32" ? "junction" : "dir");

  const candidate = join(root, "candidate.vsix");
  const published = join(alias, "openwrangler.vsix");
  const checksum = join(alias, "openwrangler.vsix.sha256");
  await createReleaseVsix(candidate);
  const snapshot = readOwnedVsixSnapshot(candidate);
  const receipts = writeStableReleaseArtifacts({
    checksumOutput: checksum,
    snapshot,
    vsixOutput: published
  });
  assert.deepEqual(readFileSync(join(firstParent, "openwrangler.vsix")), snapshot.bytes);

  unlinkSync(alias);
  symlinkSync(secondParent, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () =>
      revalidateStableReleaseArtifacts({
        checksumOutput: checksum,
        checksumReceipt: receipts.checksumReceipt,
        snapshot,
        vsixOutput: published,
        vsixReceipt: receipts.vsixReceipt
      }),
    /identity or parent changed/u
  );
});

test("revalidates published output content and parent identities", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "ow-release-output-revalidation-"));
  const movedRoot = `${root}-moved`;
  context.after(() => {
    rmSync(root, { force: true, recursive: true });
    rmSync(movedRoot, { force: true, recursive: true });
  });
  const candidate = join(root, "candidate.vsix");
  const published = join(root, "openwrangler.vsix");
  const checksum = join(root, "openwrangler.vsix.sha256");
  await createReleaseVsix(candidate);
  const snapshot = readOwnedVsixSnapshot(candidate);
  const receipts = writeStableReleaseArtifacts({
    checksumOutput: checksum,
    snapshot,
    vsixOutput: published
  });

  chmodSync(published, 0o600);
  const tampered = Buffer.from(snapshot.bytes);
  tampered[0] ^= 0xff;
  writeFileSync(published, tampered);
  chmodSync(published, 0o444);
  assert.throws(
    () =>
      revalidateStableReleaseArtifacts({
        checksumOutput: checksum,
        checksumReceipt: receipts.checksumReceipt,
        snapshot,
        vsixOutput: published,
        vsixReceipt: receipts.vsixReceipt
      }),
    /identity or parent changed|content changed|does not match/u
  );

  renameSync(root, movedRoot);
  mkdirSync(root, { mode: 0o700 });
  assert.throws(
    () =>
      revalidateStableReleaseArtifacts({
        checksumOutput: checksum,
        checksumReceipt: receipts.checksumReceipt,
        snapshot,
        vsixOutput: published,
        vsixReceipt: receipts.vsixReceipt
      }),
    /identity or parent changed/u
  );
});

test("rejects mutation of the first output while jointly verifying the second", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "ow-release-joint-output-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const candidate = join(root, "candidate.vsix");
  const published = join(root, "openwrangler.vsix");
  const checksum = join(root, "openwrangler.vsix.sha256");
  await createReleaseVsix(candidate);
  const snapshot = readOwnedVsixSnapshot(candidate);
  const receipts = writeStableReleaseArtifacts({
    checksumOutput: checksum,
    snapshot,
    vsixOutput: published
  });

  assert.throws(
    () =>
      revalidateStableReleaseArtifacts({
        afterVsixRead: () => {
          chmodSync(published, 0o600);
          const tampered = Buffer.from(snapshot.bytes);
          tampered[tampered.length - 1] ^= 0xff;
          writeFileSync(published, tampered);
          chmodSync(published, 0o444);
        },
        checksumOutput: checksum,
        checksumReceipt: receipts.checksumReceipt,
        snapshot,
        vsixOutput: published,
        vsixReceipt: receipts.vsixReceipt
      }),
    /joint final identity/u
  );
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

test("structurally gates preview-only tag workflow before build, upload, and release", () => {
  const source = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.deepEqual(inspectReleaseWorkflow(source), []);

  const mutate = (change) => {
    const workflow = parseYaml(source);
    change(workflow);
    return inspectReleaseWorkflow(dumpYaml(workflow));
  };
  const buildStep = (workflow, name) => workflow.jobs.build.steps.find((step) => step.name === name);
  const metadataStep = (workflow) =>
    workflow.jobs["preview-metadata"].steps.find(
      (step) => step.name === "Validate preview release tag and manifest channel"
    );

  const missingMetadataGate = mutate((workflow) => {
    delete workflow.jobs["preview-metadata"];
  });
  assert.ok(missingMetadataGate.includes("release.yml must contain one preview-only metadata gate job."));

  const extraWriteCapableReleaseJob = mutate((workflow) => {
    workflow.jobs["publish-decoy"] = {
      "runs-on": "ubuntu-latest",
      permissions: { contents: "write" },
      steps: [
        {
          name: "Package hidden release",
          run: "npm run package -- --out hidden.vsix"
        },
        {
          name: "Publish hidden release",
          uses: "softprops/action-gh-release@v2",
          env: { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" },
          with: { files: "hidden.vsix" }
        }
      ]
    };
  });
  assert.ok(
    extraWriteCapableReleaseJob.includes(
      "release.yml jobs must be exactly preview-metadata, build, validate, release-acceptance, release, and promote-open-vsx."
    )
  );

  const unpinnedMetadataCheckout = mutate((workflow) => {
    workflow.jobs["preview-metadata"].steps[0].uses = "actions/checkout@v6";
  });
  assert.ok(
    unpinnedMetadataCheckout.includes(
      "release.yml preview-metadata job must begin with only canonical checkout and Node setup actions."
    )
  );

  const unpinnedMetadataNode = mutate((workflow) => {
    workflow.jobs["preview-metadata"].steps[1].uses = "actions/setup-node@v6";
  });
  assert.ok(
    unpinnedMetadataNode.includes(
      "release.yml preview-metadata job must begin with only canonical checkout and Node setup actions."
    )
  );

  const unpinnedBuildCheckout = mutate((workflow) => {
    workflow.jobs.build.steps[0].uses = "actions/checkout@v6";
  });
  assert.ok(
    unpinnedBuildCheckout.includes(
      "release.yml build job must retain exactly its canonical controls and ordered preview-only step/action allowlist."
    )
  );

  const buildBeforeMetadata = mutate((workflow) => {
    workflow.jobs["preview-metadata"].steps.splice(2, 0, {
      name: "Build before metadata",
      run: "npm run build"
    });
  });
  assert.ok(
    buildBeforeMetadata.includes(
      "release.yml preview-metadata job must contain exactly checkout, Node setup, and the preview-only metadata gate."
    )
  );

  const genericMetadataMode = mutate((workflow) => {
    metadataStep(workflow).run = "node scripts/release-metadata.mjs";
  });
  assert.ok(genericMetadataMode.some((problem) => problem.includes("must run only its canonical release command")));

  const ignoredMetadataFailure = mutate((workflow) => {
    metadataStep(workflow)["continue-on-error"] = true;
  });
  assert.ok(ignoredMetadataFailure.some((problem) => problem.includes("must not override command execution controls")));

  const detachedBuild = mutate((workflow) => {
    delete workflow.jobs.build.needs;
  });
  assert.ok(
    detachedBuild.includes(
      "release.yml build job must depend only on the successful preview-metadata gate and publish no channel outputs."
    )
  );

  const renamedMutablePublisher = mutate((workflow) => {
    const packageIndex = workflow.jobs.build.steps.findIndex((step) => step.name === "Package canonical preview VSIX");
    workflow.jobs.build.steps.splice(packageIndex, 0, {
      name: "Restore preview cache",
      uses: "softprops/action-gh-release@v2",
      env: { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" },
      with: { files: "hidden.vsix" }
    });
  });
  assert.ok(
    renamedMutablePublisher.includes(
      "release.yml build job must retain exactly its canonical controls and ordered preview-only step/action allowlist."
    )
  );

  const writeCapableValidatePublisher = mutate((workflow) => {
    workflow.jobs.validate.permissions = { contents: "write" };
    workflow.jobs.validate.steps.push({
      name: "Publish validation decoy",
      uses: "softprops/action-gh-release@v2",
      env: { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" },
      with: { files: "release/openwrangler.vsix", prerelease: false }
    });
  });
  assert.ok(
    writeCapableValidatePublisher.includes(
      "release.yml validate job must retain exactly its canonical read-only controls, matrix, and ordered step/action allowlist."
    )
  );

  const writeCapableAcceptancePublisher = mutate((workflow) => {
    workflow.jobs["release-acceptance"].permissions = { contents: "write" };
    workflow.jobs["release-acceptance"].steps.push({
      name: "Publish acceptance decoy",
      uses: "softprops/action-gh-release@v2",
      env: { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" },
      with: { files: "release/openwrangler.vsix", prerelease: false }
    });
  });
  assert.ok(
    writeCapableAcceptancePublisher.includes(
      "release.yml release-acceptance job must retain exactly its canonical read-only controls and ordered step/action allowlist."
    )
  );

  const restoredStableBranch = mutate((workflow) => {
    workflow.jobs.build.steps.splice(5, 0, {
      name: "Package stable VSIX candidate",
      run: "npm run package -- --out openwrangler.candidate.vsix"
    });
  });
  assert.ok(
    restoredStableBranch.includes(
      "release.yml preview build must not contain stable packaging, verification, or readiness steps."
    )
  );

  const conditionalPreviewPackage = mutate((workflow) => {
    buildStep(workflow, "Package canonical preview VSIX").if =
      "${{ steps.release_metadata.outputs.prerelease == 'true' }}";
  });
  assert.ok(conditionalPreviewPackage.some((problem) => problem.includes("wrong release-channel condition")));

  const commentedCommandDecoy = mutate((workflow) => {
    buildStep(workflow, "Verify exact tagged source after packaging").run =
      "# git diff-index --quiet HEAD --\necho skipped";
  });
  assert.ok(commentedCommandDecoy.some((problem) => problem.includes("must run only its canonical release command")));

  const movedUpload = mutate((workflow) => {
    const index = workflow.jobs.build.steps.findIndex((step) =>
      String(step.uses ?? "").startsWith("actions/upload-artifact@")
    );
    const [step] = workflow.jobs.build.steps.splice(index, 1);
    workflow.jobs.decoy = { "runs-on": "ubuntu-latest", steps: [step] };
  });
  assert.ok(movedUpload.includes("release.yml build job must contain exactly one canonical release upload; found 0."));

  const postVerificationMutation = mutate((workflow) => {
    const index = workflow.jobs.build.steps.findIndex((step) => step.name === "Create canonical preview checksum");
    workflow.jobs.build.steps.splice(index, 0, { name: "Rewrite preview output", run: "node mutate.mjs" });
  });
  assert.ok(
    postVerificationMutation.includes(
      "release.yml preview verification, checksum, and canonical upload must be one exact final chain."
    )
  );

  const postUploadMutation = mutate((workflow) => {
    workflow.jobs.build.steps.push({ name: "Rewrite uploaded outputs", run: "node mutate.mjs" });
  });
  assert.ok(postUploadMutation.includes("release.yml canonical upload must be the final build step."));

  const unpinnedReleaseDownload = mutate((workflow) => {
    workflow.jobs.release.steps[0].uses = "actions/download-artifact@v8";
  });
  assert.ok(
    unpinnedReleaseDownload.includes("release.yml release job must begin with the pinned canonical artifact download.")
  );

  const unpinnedReleaseAction = mutate((workflow) => {
    workflow.jobs.release.steps[2].uses = "softprops/action-gh-release@v2";
  });
  assert.ok(
    unpinnedReleaseAction.includes(
      "release.yml final checksum verification must be followed immediately by GitHub Release creation."
    )
  );

  const dynamicReleaseChannel = mutate((workflow) => {
    workflow.jobs.release.steps[2].with.prerelease = "${{ needs.build.outputs.prerelease == 'true' }}";
  });
  assert.ok(
    dynamicReleaseChannel.includes("release.yml GitHub Release action must publish only the validated canonical files.")
  );

  const workflowWorkingDirectory = mutate((workflow) => {
    workflow.defaults = { run: { "working-directory": "decoy" } };
  });
  assert.ok(workflowWorkingDirectory.includes("release.yml must not override workflow environment or run defaults."));

  const buildEnvironment = mutate((workflow) => {
    workflow.jobs.build.env = { NODE_OPTIONS: "--require ./mutate.cjs" };
  });
  assert.ok(buildEnvironment.includes("release.yml build job must not override environment or run defaults."));

  const releaseWorkingDirectory = mutate((workflow) => {
    workflow.jobs.release.defaults = { run: { "working-directory": "decoy" } };
  });
  assert.ok(releaseWorkingDirectory.includes("release.yml release job must not override environment or run defaults."));

  const escalatedBuildPermissions = mutate((workflow) => {
    workflow.jobs.build.permissions = { contents: "write" };
  });
  assert.ok(
    escalatedBuildPermissions.includes("release.yml build job must inherit the read-only workflow permissions.")
  );

  const postChecksumMutation = mutate((workflow) => {
    workflow.jobs.release.steps.splice(2, 0, { name: "Rewrite release files", run: "node mutate.mjs" });
  });
  assert.ok(
    postChecksumMutation.includes("release.yml release job must contain exactly download, checksum, and release steps.")
  );

  const missingDirectPromotion = mutate((workflow) => {
    delete workflow.jobs["promote-open-vsx"];
  });
  assert.ok(
    missingDirectPromotion.includes(
      "release.yml must directly call the protected Open VSX promotion workflow after GitHub preview publication."
    )
  );

  const eventOnlyPromotion = mutate((workflow) => {
    workflow.jobs["promote-open-vsx"].uses = "./.github/workflows/not-the-reviewed-promotion.yml";
  });
  assert.ok(
    eventOnlyPromotion.includes(
      "release.yml must directly call the protected Open VSX promotion workflow after GitHub preview publication."
    )
  );
});
